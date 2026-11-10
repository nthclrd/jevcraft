/**
 * The orchestrator. Three layers, each at its own speed:
 *   reflexes (4 Hz, code)  >  Laya tactician (~33 ms-0.5 s per decision)  >  LLM strategist (seconds, rare)
 * Code owns verification: subgoals complete when a predicate says so, not when a model claims it.
 */
import type { Bot } from 'mineflayer'
import { config } from '../config.ts'
import { log } from '../log.ts'
import { usageSummary } from '../usage.ts'
import { Aborted, stopEverything, type SkillContext } from '../skills/context.ts'
import { canHarvest, SKILLS, tidyInventory, type SkillName } from '../skills/index.ts'
import type { Crafting } from '../world/crafting.ts'
import { expand } from '../world/blueprint.ts'
import { creativeGive, isCreative } from '../world/creative.ts'
import { countItem, inventoryMap, pickaxeHealth } from '../world/items.ts'
import type { Memory } from '../world/memory.ts'
import type { Acquirer } from '../world/acquire.ts'
import { chunkKey } from '../world/directions.ts'
import type { Knowledge } from '../world/knowledge.ts'
import { depthBand, distanceBucket, findVisible, perceive, type Perception } from '../world/perception.ts'
import { check, describe, type Plan, type Subgoal } from './plan.ts'
import { bestFood, type Preemptor } from './reflex.ts'
import type { Strategist } from './strategist.ts'
import { buildActionSpace, computeNeeds, decide, type ActionSpace, type HistoryEntry } from './tactician.ts'

export class Agent implements Preemptor {
  goal = ''
  plan: Plan | null = null
  history: HistoryEntry[] = []
  advice: string | null = null
  reflexActive = false
  private controller: AbortController | null = null
  private running = false
  private generation = 0
  private tabu = new Map<string, number>()
  private lowConfidence = 0
  private advising = false
  private decisions = 0

  private factsAsked = new Set<string>()
  private instruction: { text: string; until: number } | null = null
  private spottedPositions = new Set<string>()

  constructor(
    private bot: Bot, private strategist: Strategist, private crafting: Crafting, private memory: Memory,
    private knowledge: Knowledge, private acquirer: Acquirer,
  ) {
    bot.on('death', () => this.onDeath())
    // The server's death message ("<name> tried to swim in lava") is the ground truth the strategist learns from.
    bot.on('messagestr', (message) => {
      if (!message.startsWith(bot.username + ' ') || !/(slain|lava|fell|drown|burn|blew|shot|skewer|suffocat|starv|died|killed|squash|withered|froze|pricked|impaled|poked)/.test(message)) return
      const death = this.memory.data.deaths.at(-1)
      if (death && Date.now() - death.t < 5_000) {
        death.cause = message
        this.memory.save()
      }
      this.history.push({ skill: 'DEATH', target: null, ok: false, result: message })
      log('reflex', `death cause: ${message}`)
    })
  }

  async preempt(reason: string, routine: () => Promise<void>) {
    if (this.reflexActive) return
    this.reflexActive = true
    log('reflex', reason)
    this.controller?.abort()
    stopEverything(this.bot)
    try {
      await routine()
    } catch {}
    stopEverything(this.bot)
    this.history.push({ skill: 'REFLEX', target: null, ok: true, result: reason })
    this.reflexActive = false
  }

  stop() {
    this.generation++
    this.running = false
    this.controller?.abort()
    stopEverything(this.bot)
  }

  /** True while a goal is being worked on; a reconnect resumes only what was actually running. */
  get active() {
    return this.running
  }

  async start(goal: string) {
    this.stop()
    const generation = ++this.generation
    this.goal = goal
    this.running = true
    this.history = []
    this.advice = null
    log('plan', `goal: ${goal}`)
    try {
      this.plan = await this.strategist.plan(goal, this.snapshot(), this.memory.data.lessons)
      this.printPlan()
      await this.gatherFacts()
      await this.loop(generation)
    } catch (e) {
      log('error', `agent stopped: ${(e as Error).stack ?? e}`)
    } finally {
      if (generation === this.generation) this.running = false
    }
  }

  private async loop(generation: number) {
    while (this.running && generation === this.generation) {
      if (this.reflexActive) {
        await pause(200)
        continue
      }
      const plan = this.plan!
      if (check(this.bot, plan.goal_done_when)) {
        log('plan', `GOAL COMPLETE: ${this.goal} (${describe(plan.goal_done_when)}) after ${this.decisions} decisions`)
        log('info', `usage: ${usageSummary()}`)
        this.bot.chat(`Goal complete: ${this.goal}`)
        this.running = false
        return
      }

      const subgoal = plan.subgoals.find((s) => !s.done)
      if (!subgoal) {
        log('plan', 'all subgoals done but goal not verified; asking strategist to extend the plan')
        await this.recover('all subgoals done but the goal predicate is still false')
        continue
      }
      if (check(this.bot, subgoal.done_when)) {
        this.completeSubgoal(subgoal)
        continue
      }
      // Creative: items are a command away, gathering is pointless.
      if (isCreative(this.bot) && subgoal.done_when.kind === 'have' && subgoal.done_when.item) {
        if (await creativeGive(this.bot, subgoal.done_when.item, subgoal.done_when.count ?? 1)) {
          log('skill', `creative: took ${subgoal.done_when.count ?? 1} ${subgoal.done_when.item}`)
          await pause(300)
          continue
        }
      }

      this.ensureFoodSubgoal()
      await this.snack()
      if (subgoal.done_when.kind === 'built' && subgoal.done_when.item && !this.memory.data.sites[subgoal.done_when.item]) {
        await this.designStructure(subgoal)
        continue
      }
      const tracked = Object.keys(this.knowledge.data.priors)
      let perception = perceive(this.bot, [], tracked)
      const needs = computeNeeds(this.bot, this.acquirer, this.knowledge, this.memory, subgoal, perception)
      needs.later = this.laterBlocks(subgoal).filter((b) => !needs.seek.includes(b))
      if ([...needs.seek, ...needs.later].some((b) => !tracked.includes(b))) perception = perceive(this.bot, [...needs.seek, ...needs.later], tracked)
      this.learnFrom(perception, needs.seek)
      await tidyInventory(this.bot, new Set([...needs.chainItems, ...needs.seek]))
      const space = buildActionSpace(this.bot, perception, this.crafting, this.memory, this.knowledge, needs, new Set(this.tabu.keys()))

      let decision
      try {
        decision = await decide({
          goal: this.goal, subgoal, planView: this.planView(), needs, perception, bot: this.bot,
          history: this.history, advice: this.advice, playerInstruction: this.activeInstruction(), lessons: this.memory.data.lessons, space,
        })
      } catch (e) {
        log('error', `laya decision failed: ${(e as Error).message}`)
        await pause(1500)
        continue
      }
      this.decisions++
      subgoal.steps = (subgoal.steps ?? 0) + 1
      const p = (n: number | null) => (n === null ? '-' : n.toFixed(2))
      log('laya', `${decision.latencyMs}ms ${decision.skill}${decision.target ? ' ' + decision.target : ''} (skill ${p(decision.confidence)}, target ${p(decision.targetConfidence)}, danger ${decision.danger.toFixed(1)}) | ${subgoal.description}`)

      // Laya judged the situation dangerous: enforce a safety action over the chosen one.
      const dangerLimit = this.activeInstruction() ? 2.5 : 2 // a player's explicit request accepts more risk
      if (decision.danger >= dangerLimit && !['SHELTER', 'CRAFT'].includes(decision.skill) && space.skills.SHELTER) {
        log('laya', `danger ${decision.danger.toFixed(2)}: overriding ${decision.skill} with SHELTER`)
        decision.skill = 'SHELTER'
        decision.target = null
      }
      if (decision.judgedDone !== null && decision.judgedDone > 0.85) {
        this.completeSubgoal(subgoal)
        continue
      }
      if (decision.skill === 'STUCK') {
        // Rate-limit System Two: if it was just consulted, fall back to Laya's best non-STUCK option instead of looping.
        const fallback = Object.entries(decision.skillProbabilities).filter(([k]) => k !== 'STUCK').sort((a, b) => b[1] - a[1])[0]
        if (Date.now() - this.lastRecovery < 30_000 && fallback) {
          const skill = fallback[0] as SkillName
          const target = space.targets[skill] ? Object.keys(space.targets[skill]!)[0] : null
          log('laya', `STUCK again right after advice; falling back to ${skill}${target ? ' ' + target : ''}`)
          await this.execute(skill, target, needs, subgoal)
          continue
        }
        await this.recover(`tactical model chose STUCK on "${subgoal.description}"`, space)
        continue
      }
      if ((subgoal.failures ?? 0) >= config.limits.failuresBeforeRecover) {
        await this.recover(`${subgoal.failures} failed actions on "${subgoal.description}"`, space)
        subgoal.failures = 0
        continue
      }
      if ((subgoal.steps ?? 0) > config.limits.stepsPerSubgoal) {
        await this.recover(`no progress after ${subgoal.steps} actions on "${subgoal.description}"`, space)
        subgoal.steps = 0
        continue
      }

      // Confidence gating: act anyway (speed), but ask System Two for advice in the background when unsure.
      this.lowConfidence = decision.confidence < config.laya.adviseBelow ? this.lowConfidence + 1 : 0
      if (this.lowConfidence >= config.limits.lowConfidenceStreak) this.adviseInBackground(`laya uncertain ${this.lowConfidence} times in a row`)

      await this.execute(decision.skill as SkillName, decision.target, needs, subgoal)
      this.decayTabu()
    }
  }

  private async execute(skill: SkillName, target: string | null, needs: ReturnType<typeof computeNeeds>, subgoal: Subgoal) {
    this.controller = new AbortController()
    const watched = [...new Set([...needs.seek, ...needs.later])]
    const ctx: SkillContext = {
      bot: this.bot, signal: this.controller.signal, crafting: this.crafting, memory: this.memory, knowledge: this.knowledge, need: needs.need, seek: watched, seekEntities: needs.seekEntities,
    }
    // Opportunity watcher: while travelling or digging, stop as soon as a block the goal needs comes into view.
    let spotted: string | null = null
    const lookout = ['EXPLORE', 'DIG_DOWN', 'STRIP_MINE', 'SURFACE', 'GOTO', 'HUNT'].includes(skill) && watched.length
      ? setInterval(() => {
        if (spotted) return
        const hit = findVisible(this.bot, watched, 12, 4).find((b) => canHarvest(this.bot, b.name) && !this.spottedPositions.has(b.position.toString()))
        if (!hit) return
        spotted = hit.name
        this.spottedPositions.add(hit.position.toString())
        this.memory.remember(hit.name, hit.position)
        this.knowledge.observe(hit, hit.biome?.name)
        log('skill', `spotted ${hit.name} while running ${skill}: stopping to take it`)
        this.controller?.abort()
      }, 1000)
      : undefined
    const started = Date.now()
    let result
    // Watchdog: a mineflayer call that never settles (dig, place, window) must not freeze the agent.
    const controller = this.controller
    let watchdog: NodeJS.Timeout | undefined
    const timedOut = new Promise<{ ok: boolean; message: string }>((resolve) => {
      watchdog = setTimeout(() => {
        controller.abort()
        stopEverything(this.bot)
        resolve({ ok: false, message: `timed out after ${SKILL_TIMEOUT_S[skill] ?? 150}s` })
      }, (SKILL_TIMEOUT_S[skill] ?? 150) * 1000)
    })
    try {
      result = await Promise.race([SKILLS[skill](ctx, target ?? ''), timedOut])
    } catch (e) {
      result = e instanceof Aborted ? { ok: false, message: 'interrupted by reflex' } : { ok: false, message: (e as Error).message.slice(0, 160) }
    } finally {
      clearTimeout(watchdog)
      clearInterval(lookout)
    }
    if (spotted) result = { ok: true, message: `stopped: spotted ${spotted} nearby` }
    if (!spotted && controller.signal.aborted && result.message !== 'interrupted by reflex' && !result.message.startsWith('timed out')) {
      result = { ok: false, message: 'interrupted by reflex' }
    }
    stopEverything(this.bot)
    const interrupted = result.message === 'interrupted by reflex'
    if (!interrupted) this.knowledge.recordSkill(skill, result.ok, Date.now() - started)
    log('skill', `${result.ok ? 'ok' : 'FAIL'} ${skill}${target ? ' ' + target : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.message}`)
    this.history.push({ skill, target, ok: result.ok, result: result.message })
    this.history = this.history.slice(-40)
    // "Nothing found" is progress-free: count it toward recovery, but keep the action available.
    if (result.ok && /nothing sought|nothing sought revealed/.test(result.message)) subgoal.failures = (subgoal.failures ?? 0) + 0.5
    if (result.ok) subgoal.recoveries = 0 // progress: the step is doable after all
    if (!result.ok && !interrupted) {
      subgoal.failures = (subgoal.failures ?? 0) + 1
      this.tabu.set(`${skill}:${target ?? 'tunnel'}`, 4) // adaptive: do not offer the same failing action for 4 decisions
    }
    if (result.ok && this.advice && this.history.filter((h) => h.ok).length % 3 === 0) this.advice = null
  }

  private async snack() {
    // Health only regenerates on a nearly full food bar, so top up whenever hurt.
    const food = this.bot.food <= 14 || (this.bot.food < 18 && this.bot.health < 20) ? bestFood(this.bot) : undefined
    if (!food) return
    try {
      await this.bot.equip(food, 'hand')
      await this.bot.consume()
      log('reflex', `ate ${food.name} (food ${this.bot.food})`)
    } catch {}
  }

  /** Ask the strategist for a blueprint, then remember it as a construction site for this world. */
  private async designStructure(subgoal: Subgoal) {
    const name = subgoal.done_when.item!
    try {
      const inv = inventoryMap(this.bot)
      const blueprint = await this.strategist.design(name, `${this.goal} — ${subgoal.description}`, { game_mode: isCreative(this.bot) ? 'creative' : 'survival', inventory: inv, nearby_blocks: this.snapshot().nearby_blocks })
      this.memory.data.sites[name] = { blueprint, origin: null, cells: expand(blueprint) }
      this.memory.save()
      log('plan', `designed "${name}": ${blueprint.description} (${expand(blueprint).filter((c) => c[3] !== 'air').length} blocks)`)
      this.bot.chat(`Plan de ${name} prêt : ${blueprint.description}`.slice(0, 250))
    } catch (e) {
      log('error', `design failed: ${(e as Error).message}`)
      subgoal.failures = (subgoal.failures ?? 0) + 1
      await pause(3000)
    }
  }

  /** Source blocks of the goal item and of every remaining item subgoal (opportunistic targets). */
  private laterBlocks(current: Subgoal): string[] {
    const plan = this.plan!
    const out = new Set<string>()
    for (const p of [plan.goal_done_when, ...plan.subgoals.filter((g) => !g.done && g !== current).map((g) => g.done_when)]) {
      if (p.kind === 'have' && p.item) this.acquirer.sourceBlocksOf(p.item).forEach((b) => out.add(b))
      if (p.kind === 'near_block' && p.block) out.add(p.block)
    }
    return [...out]
  }

  private activeInstruction(): string | null {
    if (this.instruction && Date.now() > this.instruction.until) this.instruction = null
    return this.instruction?.text ?? null
  }

  /** A player spoke in chat. Idle: it becomes the goal. Busy: the strategist turns it into plan changes and a reply. */
  async instruct(player: string, message: string) {
    log('plan', `${player} says: ${message}`)
    if (!this.running || !this.plan) return void this.start(message)
    this.instruction = { text: message, until: Date.now() + 5 * 60_000 }
    try {
      const r = await this.strategist.instruct(this.goal, this.plan, player, message, this.snapshot(), this.history)
      if (r.reply) this.bot.chat(r.reply.slice(0, 250))
      if (r.new_goal) return void this.start(r.new_goal)
      this.advice = r.hint || this.advice
      if (r.replace_remaining && r.subgoals.length) {
        this.plan.subgoals = [...this.plan.subgoals.filter((g) => g.done), ...r.subgoals]
        this.printPlan()
      }
      this.tabu.clear()
      this.controller?.abort() // act on the request now, not after the current skill
    } catch (e) {
      log('error', `instruction failed: ${(e as Error).message}`)
      this.bot.chat("Désolé, je n'ai pas compris.")
    }
  }

  /** Hunger is handled in code: starving bots cannot mine, and the LLM tends to forget food. */
  private ensureFoodSubgoal() {
    if (isCreative(this.bot)) return
    const plan = this.plan!
    const hasFood = countItem(this.bot, 'food') > 0
    const pending = plan.subgoals.find((s) => !s.done && s.done_when.item === 'food')
    if (pending && this.bot.food >= 18) {
      pending.done = true // respawned or ate enough: the detour is no longer needed
      return
    }
    if (this.bot.food <= 8 && !hasFood && !pending) {
      plan.subgoals.splice(plan.subgoals.findIndex((s) => !s.done), 0, {
        description: 'Get food before starving',
        done_when: { kind: 'have', item: 'food', count: 3, y: null, block: null },
        hint: 'HUNT animals on the surface and SMELT the meat',
      })
      log('plan', 'hunger: inserted food subgoal')
    }
  }

  private decayTabu() {
    for (const [k, v] of this.tabu) v <= 1 ? this.tabu.delete(k) : this.tabu.set(k, v - 1)
  }

  private completeSubgoal(subgoal: Subgoal) {
    subgoal.done = true
    this.advice = null
    this.tabu.clear()
    log('plan', `subgoal done: ${subgoal.description}`)
    this.printPlan()
  }

  private lastRecovery = 0

  private async recover(reason: string, space?: ActionSpace) {
    log('llm', `recovering: ${reason}`)
    this.lastRecovery = Date.now()
    // Do not loop forever on a step no skill can do: after several recoveries, report it and move on.
    const current = this.plan?.subgoals.find((g) => !g.done)
    if (current && reason.includes('STUCK')) {
      current.recoveries = (current.recoveries ?? 0) + 1
      if (current.recoveries > 4) {
        current.done = true
        log('plan', `giving up on "${current.description}": no skill could act on it after ${current.recoveries - 1} strategist attempts`)
        this.bot.chat(`Je n'arrive pas à : ${current.description}. Je passe à la suite.`.slice(0, 250))
        return
      }
    }
    try {
      const r = await this.strategist.recover(this.goal, this.plan!, reason, this.snapshot(space), this.history, this.memory.data.lessons)
      this.applyRecovery(r)
    } catch (e) {
      log('error', `strategist failed: ${(e as Error).message}`)
      await pause(3000)
    }
  }

  private adviseInBackground(reason: string) {
    if (this.advising) return
    this.advising = true
    this.lowConfidence = 0
    const generation = this.generation
    this.strategist.recover(this.goal, this.plan!, reason, this.snapshot(), this.history, this.memory.data.lessons)
      .then((r) => generation === this.generation && this.applyRecovery(r))
      .catch((e) => log('error', `advice failed: ${e.message}`))
      .finally(() => (this.advising = false))
  }

  private applyRecovery(r: { hint: string; lesson: string; replace_remaining: boolean; subgoals: Subgoal[] }) {
    this.advice = r.hint || null
    if (r.lesson) this.memory.addLesson(r.lesson)
    if (r.replace_remaining && r.subgoals.length) {
      this.plan!.subgoals = [...this.plan!.subgoals.filter((s) => s.done), ...r.subgoals]
      this.printPlan()
    }
    this.tabu.clear()
  }

  private onDeath() {
    const cause = this.history.slice(-3).map((h) => `${h.skill} ${h.target ?? ''} ${h.result}`).join(' | ')
    log('reflex', `DIED at y ${Math.floor(this.bot.entity?.position.y ?? 0)}; last actions: ${cause}`)
    this.memory.data.deaths.push({ cause, y: Math.floor(this.bot.entity?.position.y ?? 0), t: Date.now() })
    if (this.bot.entity) this.memory.remember('death_site', this.bot.entity.position.floored()) // items stay there ~5 minutes
    this.memory.save()
    this.controller?.abort()
    // Inventory is gone: completed item subgoals must be re-verified.
    for (const s of this.plan?.subgoals ?? []) if (s.done_when.kind !== 'judge') s.done = false
    this.history.push({ skill: 'DEATH', target: null, ok: false, result: `died; inventory lost. Recent: ${cause}` })
    if (this.running) this.adviseInBackground('the bot died and lost its inventory; propose a safer approach')
  }

  /** Update learned whereabouts, explored chunks and remembered places from what was just perceived. */
  private learnFrom(p: Perception, seek: string[]) {
    const pos = this.bot.entity.position
    this.memory.visit(chunkKey(pos.x, pos.z))
    for (const e of p.entities) if (e.kind !== 'item' && e.kind !== 'player') this.knowledge.observeMob(e.name, e.id)
    const nearest = new Map<string, Perception['instances'][number]>()
    for (const inst of p.instances) {
      this.knowledge.observe(inst, inst.biome)
      const prev = nearest.get(inst.name)
      if (!prev || inst.position.distanceTo(pos) < prev.position.distanceTo(pos)) nearest.set(inst.name, inst)
    }
    for (const [name, inst] of nearest) {
      // Remember only what is worth walking back to: sought blocks, stations, and resources that are not everywhere.
      const abundance = this.knowledge.data.priors[name]?.abundance
      const scarce = abundance !== undefined && abundance !== 'very_common' && abundance !== 'common'
      if (seek.includes(name) || name === 'crafting_table' || name === 'furnace' || scarce) this.memory.remember(name, inst.position)
    }
    // Facts for sought blocks nobody has described yet (e.g. a new goal branch): ask in the background.
    const unknown = seek.filter((b) => this.knowledge.where(b).source === 'none' && !this.factsAsked.has(b))
    if (unknown.length) void this.gatherFacts(unknown, [])
  }

  /** Ask the strategist once for facts the registry lacks about everything the plan could involve; cached forever. */
  private async gatherFacts(extraBlocks?: string[], extraItems?: string[]) {
    let blocks = extraBlocks ?? []
    let items = extraItems ?? []
    if (!extraBlocks) {
      const seeds = ['food', 'pickaxe']
      for (const s of [this.plan!.goal_done_when, ...this.plan!.subgoals.map((g) => g.done_when)]) {
        if (s.item) seeds.push(s.item)
        if (s.block) blocks.push(s.block)
      }
      const closure = this.acquirer.closure(seeds)
      blocks = [...new Set([...blocks, ...closure.blocks])]
      items = closure.items
    }
    const missing = this.knowledge.needsFacts(blocks, items)
    missing.blocks = missing.blocks.filter((b) => !this.factsAsked.has(b))
    missing.items = missing.items.filter((i) => !this.factsAsked.has(i))
    if (!missing.blocks.length && !missing.items.length) return
    ;[...missing.blocks, ...missing.items].forEach((n) => this.factsAsked.add(n))
    try {
      const facts = await this.strategist.facts(missing.blocks, missing.items)
      this.knowledge.learnFacts(facts, missing.items)
    } catch (e) {
      log('error', `fact gathering failed: ${(e as Error).message}`)
      ;[...missing.blocks, ...missing.items].forEach((n) => this.factsAsked.delete(n))
    }
  }

  planView(): string[] {
    return (this.plan?.subgoals ?? []).map((s) => `${s.done ? 'done' : 'todo'}: ${s.description}`)
  }

  private printPlan() {
    for (const [i, s] of (this.plan?.subgoals ?? []).entries()) log('plan', `  ${s.done ? '[x]' : '[ ]'} ${i + 1}. ${s.description}  <${describe(s.done_when)}>`)
  }

  /** Compact state for the strategist. */
  snapshot(space?: ActionSpace) {
    const p = perceive(this.bot)
    return {
      game_mode: isCreative(this.bot) ? 'creative (all blocks available instantly, no gathering, no danger)' : 'survival',
      // Hints must name options that exist; otherwise the tactical model cannot follow them.
      available_skills: space ? Object.fromEntries(Object.keys(space.skills).map((k) => [k, Object.keys(space.targets[k as SkillName] ?? {})])) : undefined,
      position: { y: Math.floor(this.bot.entity.position.y), layer: depthBand(Math.floor(this.bot.entity.position.y)) },
      health: this.bot.health, food: this.bot.food, time: this.bot.time.isDay ? 'day' : 'night',
      inventory: inventoryMap(this.bot),
      best_pickaxe: pickaxeHealth(this.bot),
      nearby_blocks: [...p.blocks.values()].sort((a, b) => a.distance - b.distance).slice(0, 25).map((b) => `${b.name} x${b.count} ${distanceBucket(b.distance)}`),
      nearby_creatures: p.entities.slice(0, 10).map((e) => `${e.name} ${e.kind}`),
      remembered_places: Object.keys(this.memory.data.places),
      deaths_so_far: this.memory.data.deaths.length,
    }
  }
}

/** Upper bound per skill; long skills (tunnels, shelter, travel) get more. */
const SKILL_TIMEOUT_S: Partial<Record<SkillName, number>> = { SHELTER: 130, STRIP_MINE: 240, DIG_DOWN: 240, SURFACE: 240, SMELT: 180, GOTO: 120 }

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
