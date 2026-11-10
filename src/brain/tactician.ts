/**
 * System One. Every decision is ONE Laya request: a `skill` head plus speculative target heads for every offered skill
 * (fan-out). The action space is derived each step from the acquisition plan, perception, learned knowledge and memory,
 * so Laya only ever picks among valid, executable options, each annotated with the evidence behind it.
 */
import type { Bot } from 'mineflayer'
import { canHarvest, surfaceY, type SkillName } from '../skills/index.ts'
import type { Acquirer, Step } from '../world/acquire.ts'
import type { Crafting } from '../world/crafting.ts'
import { describeHeadings } from '../world/directions.ts'
import { bestTool, countItem, fuelValue, inventoryMap, matchesItem, pickaxeHealth } from '../world/items.ts'
import type { Knowledge } from '../world/knowledge.ts'
import { itemFor, progress } from '../world/blueprint.ts'
import { isCreative } from '../world/creative.ts'
import type { Memory } from '../world/memory.ts'
import { depthBand, distanceBucket, type Perception } from '../world/perception.ts'
import { readChoice, systemOne, type Question } from './laya.ts'
import { describe, type Subgoal } from './plan.ts'

export type Option = SkillName | 'STUCK'

export interface ActionSpace {
  skills: Partial<Record<Option, string>>
  targets: Partial<Record<SkillName, Record<string, string>>>
}

export interface Decision {
  skill: Option
  target: string | null
  confidence: number
  targetConfidence: number | null
  judgedDone: number | null
  /** Laya's calibrated danger score, 0 (safe) .. 3 (critical). */
  danger: number
  latencyMs: number
  skillProbabilities: Record<string, number>
}

export interface HistoryEntry { skill: string; target: string | null; ok: boolean; result: string }

const RULES = `You control a Minecraft survival bot. Choose the single skill that most directly advances current_subgoal.
acquisition_plan is the cheapest known chain to obtain what the subgoal needs, computed from game rules and what the bot
has seen; doable_now lists steps that can run right now. Prefer a doable_now step. When the next step needs a block or
creature that is not visible, travel toward it: use GOTO if it is remembered, DIG_DOWN toward the depth where it is found,
EXPLORE toward the heading whose description best matches it, or STRIP_MINE / cave EXPLORE when already at that depth.
Every option lists evidence (past success rates, what lies in each heading); use it. Do not repeat an action that just
failed in recent_actions. A player_instruction comes from a human player and has priority; follow it together with strategist_advice when present. At night with hostiles near and weak gear, SHELTER.
Choose STUCK only when no offered option can make progress.`

export interface Needs {
  lines: string[]
  doable: string[]
  need: { item: string; count: number } | null
  seek: string[]
  seekEntities: string[]
  frontier: Step[]
  /** Depths worth digging to, from learned or prior whereabouts of sought blocks. */
  depths: { y: number; why: string }[]
  /** Items that appear anywhere in the acquisition chain (craft candidates). */
  chainItems: string[]
  /** Blocks the overall goal or later subgoals will need: worth taking whenever they show up. */
  later: string[]
  /** Structure the current subgoal builds, if any. */
  build?: string
}

/** What the current subgoal still lacks and the cheapest way to get it, derived by the acquisition planner. */
export function computeNeeds(bot: Bot, acquirer: Acquirer, knowledge: Knowledge, memory: Memory, subgoal: Subgoal | undefined, perception: Perception): Needs {
  const empty: Needs = { lines: [], doable: [], need: null, seek: [], seekEntities: [], frontier: [], depths: [], chainItems: [], later: [] }
  const p = subgoal?.done_when
  if (!p) return empty
  let target: { item: string; count: number } | null = null
  const lines: string[] = []
  const depths: Needs['depths'] = []
  const seek = new Set<string>()

  if (p.kind === 'have' && p.item) {
    const have = countItem(bot, p.item)
    if (have >= (p.count ?? 1)) return empty
    target = { item: p.item, count: p.count ?? 1 }
  } else if (p.kind === 'near_block' && p.block) {
    seek.add(p.block)
    lines.push(`reach a ${p.block}; ${knowledge.describeWhere(p.block)}`)
    const tools = (bot.registry.blocksByName[p.block] as any)?.harvestTools
    if (tools && !canHarvest(bot, p.block)) target = { item: bot.registry.items[Number(Object.keys(tools)[0])].name, count: 1 }
  } else if (p.kind === 'built' && p.item) {
    const site = memory.data.sites[p.item]
    if (!site) return { ...empty, lines: [`the structure "${p.item}" has no design yet`] }
    const prog = progress(bot, site)
    const missing = isCreative(bot) ? [] : Object.entries(prog.missing).sort((a, b) => b[1] - a[1])
    lines.push(`structure "${p.item}": ${prog.done} of ${prog.total} blocks in place${site.origin ? '' : ' (site not chosen yet)'}`)
    const keep = [...new Set(prog.remaining.map((c) => itemFor(bot, c[3])).filter((i): i is string => !!i))]
    if (missing.length) {
      lines.push(`materials still missing: ${missing.map(([i, n]) => `${n} ${i}`).join(', ')}`)
      target = { item: missing[0][0], count: countItem(bot, missing[0][0]) + missing[0][1] }
    }
    const holdsSome = isCreative(bot) || keep.some((i) => countItem(bot, i) > 0)
    if (holdsSome) lines.push(`BUILD ${p.item} can place blocks now${missing.length ? ' (gathering the rest can come later)' : ' (all materials in hand)'}`)
    if (!target) return { ...empty, lines, doable: holdsSome ? [`BUILD ${p.item}`] : [], chainItems: keep, build: p.item }
    const needs = computeNeedsFor(bot, acquirer, knowledge, memory, perception, target, lines, [], new Set())
    return { ...needs, doable: holdsSome ? [`BUILD ${p.item}`, ...needs.doable] : needs.doable, chainItems: [...needs.chainItems, ...keep], build: p.item }
  } else if (p.kind === 'at_or_below_y' && p.y !== null) {
    depths.push({ y: p.y, why: `the subgoal requires y ${p.y} or lower` })
    lines.push(`go down to y ${p.y} (now y ${Math.floor(bot.entity.position.y)})`)
    if (!bestTool(bot, 'pickaxe')) target = { item: 'pickaxe', count: 1 }
  }

  return computeNeedsFor(bot, acquirer, knowledge, memory, perception, target, lines, depths, seek)
}

function computeNeedsFor(
  bot: Bot, acquirer: Acquirer, knowledge: Knowledge, memory: Memory, perception: Perception,
  target: { item: string; count: number } | null, lines: string[], depths: Needs['depths'], seek: Set<string>,
): Needs {
  let frontier: Step[] = []
  const chainItems = new Set<string>()
  if (target) {
    const acq = acquirer.plan(target.item, target.count, perception)
    lines.push(...acq.lines)
    if (!acq.feasible) lines.push(`no known way to obtain ${target.item} yet; explore to discover sources`)
    frontier = acq.frontier
    acq.seekBlocks.forEach((b) => seek.add(b))
    const collect = (n: typeof acq.root) => {
      const label = n.item.match(/\((.*)\)$/)?.[1] ?? n.item
      chainItems.add(label)
      n.children.forEach(collect)
    }
    collect(acq.root)
  }

  // Depth targets for sought blocks that are not on the surface, from what the bot learned (or was told) about them.
  const y = Math.floor(bot.entity.position.y)
  for (const block of seek) {
    const w = knowledge.where(block)
    if (w.source === 'none' || w.surface || w.yBest === null) continue
    if (y > (w.yMax ?? w.yBest) || y < (w.yMin ?? w.yBest) - 8) depths.push({ y: w.yBest, why: knowledge.describeWhere(block) })
  }
  for (const block of seek) {
    const place = memory.nearest(block, bot.entity.position)
    if (place && bot.entity.position.distanceTo(place as any) > 6) lines.push(`a ${block} is remembered ${distanceBucket(bot.entity.position.distanceTo(place as any))}: GOTO ${block}`)
  }
  const pick = pickaxeHealth(bot)
  if (pick && pick.remaining < 0.2 && countItem(bot, pick.name) < 2) {
    lines.push(`${pick.name} is almost broken (${Math.round(pick.remaining * 100)}% left): craft a spare`)
    chainItems.add(pick.name)
  }

  const doable = frontier.filter((s) => ['MINE', 'CRAFT', 'SMELT', 'HUNT'].includes(s.action)).map((s) => `${s.action} ${s.target} (for ${s.for})`)
  const seekEntities = frontier.filter((s) => s.action === 'FIND_MOB' || s.action === 'HUNT').map((s) => s.target)
  return { lines, doable, need: target, seek: [...seek], seekEntities, frontier, depths, chainItems: [...chainItems], later: [] }
}

export function buildActionSpace(
  bot: Bot, perception: Perception, crafting: Crafting, memory: Memory, knowledge: Knowledge, needs: Needs, tabu: Set<string>,
): ActionSpace {
  const skills: ActionSpace['skills'] = {}
  const targets: ActionSpace['targets'] = {}
  const allowed = (skill: string, target: string) => !tabu.has(`${skill}:${target}`)
  const note = (skill: string) => knowledge.skillNote(skill)
  const y = perception.y
  const underground = surfaceY(bot) - y > 6
  const plannedMine = new Set(needs.frontier.filter((s) => s.action === 'MINE').map((s) => s.target))

  // MINE: sought blocks when the plan names them; otherwise any useful visible solid block.
  const mine: Record<string, string> = {}
  const focus = needs.seek.length > 0
  const candidates = [...perception.blocks.values()]
    .filter((b) => canHarvest(bot, b.name) && allowed('MINE', b.name))
    .filter((b) => needs.later.includes(b.name) || (focus ? needs.seek.includes(b.name) : (bot.registry.blocksByName[b.name] as any)?.boundingBox === 'block' && !b.name.endsWith('_leaves')))
    .sort((a, b) => Number(plannedMine.has(b.name)) - Number(plannedMine.has(a.name)) || a.distance - b.distance)
    .slice(0, 25)
  for (const b of candidates) {
    const why = plannedMine.has(b.name) ? ' (next step of the plan)' : needs.later.includes(b.name) ? ' (needed later for the goal: take it now while it is here)' : ''
    mine[b.name] = `${b.name}: ${b.count} seen, nearest ${distanceBucket(b.distance)}${why}`
  }
  if (Object.keys(mine).length) {
    skills.MINE = 'Collect a visible block type (walks there, best tool, picks up drops).' + note('MINE')
    targets.MINE = mine
  }

  // CRAFT: anything in the acquisition chain (or a spare tool) that is craftable right now.
  const craft: Record<string, string> = {}
  const table = !!bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 24 })
  const inv = inventoryMap(bot)
  const plannedCraft = new Set(needs.frontier.filter((s) => s.action === 'CRAFT').map((s) => s.target))
  for (const item of new Set([...plannedCraft, ...needs.chainItems])) {
    if (!allowed('CRAFT', item)) continue
    const name = crafting.resolveName(item, inv)
    if (!bot.registry.itemsByName[name]) continue
    if (craftsSomething(crafting, name, table, inv)) {
      const isNeed = needs.need && matchesItem(needs.need.item, name)
      craft[item] = `${item}: craftable now, have ${countItem(bot, item)}${plannedCraft.has(item) ? ' (next step of the plan)' : ''}${isNeed ? ' (the subgoal item)' : ''}`
    }
  }
  if (Object.keys(craft).length) {
    skills.CRAFT = 'Craft an item; intermediates and the crafting table are handled automatically.' + note('CRAFT')
    targets.CRAFT = craft
  }

  // SMELT: inventory items with a known smelting result, only with fuel.
  const smelt: Record<string, string> = {}
  const hasFuel = bot.inventory.items().some((i) => fuelValue(i.name) > 0)
  const plannedSmelt = new Set(needs.frontier.filter((s) => s.action === 'SMELT').map((s) => s.target))
  for (const [input, count] of Object.entries(inv)) {
    const output = knowledge.smeltOutput(input)
    if (!output || !hasFuel || !allowed('SMELT', input)) continue
    if (!plannedSmelt.has(input) && !(bot.food < 16 && (bot.registry as any).foodsByName?.[output])) continue
    smelt[input] = `${input} into ${output} (have ${count})${plannedSmelt.has(input) ? ' (next step of the plan)' : ''}`
  }
  if (Object.keys(smelt).length) {
    skills.SMELT = 'Smelt or cook an item in a furnace (furnace crafted/placed automatically).' + note('SMELT')
    targets.SMELT = smelt
  }

  // EXPLORE: eight headings, each described from observable evidence.
  const headings = describeHeadings(bot, perception, memory, needs.seek, needs.seekEntities, underground)
  const explore: Record<string, string> = {}
  for (const [dir, text] of Object.entries(headings)) if (allowed('EXPLORE', dir)) explore[dir] = text
  if (Object.keys(explore).length) {
    skills.EXPLORE = (underground
      ? 'Walk through open caves toward a heading without digging (saves pickaxe durability); stops when a sought block appears.'
      : 'Travel about 40 blocks toward a heading; stops early when a sought block or creature appears.') + note('EXPLORE')
    targets.EXPLORE = explore
  }

  const pickaxe = bestTool(bot, 'pickaxe')
  if (pickaxe) {
    const dig: Record<string, string> = {}
    for (const d of needs.depths) {
      const key = `y${d.y}`
      if (d.y < y - 3 && allowed('DIG_DOWN', key)) dig[key] = `down to y ${d.y}: ${d.why}`
    }
    const deeper = Math.max(-58, y - 16)
    if (deeper < y - 3 && !dig[`y${deeper}`] && allowed('DIG_DOWN', `y${deeper}`)) dig[`y${deeper}`] = `16 blocks deeper, to y ${deeper}, to reach new layers`
    if (Object.keys(dig).length) {
      skills.DIG_DOWN = `Staircase down (needs a pickaxe). Now in the ${depthBand(y)}, y ${y}.` + note('DIG_DOWN')
      targets.DIG_DOWN = dig
    }
    if (underground && allowed('STRIP_MINE', 'tunnel')) skills.STRIP_MINE = 'Tunnel 32 blocks at the current depth; tunnel walls reveal blocks. Wears the pickaxe.' + note('STRIP_MINE')
  }

  const hunt: Record<string, string> = {}
  const plannedHunt = new Set(needs.frontier.filter((s) => s.action === 'HUNT').map((s) => s.target))
  for (const e of perception.entities) {
    if (e.kind !== 'animal' && !plannedHunt.has(e.name)) continue
    if (hunt[e.name] || !allowed('HUNT', e.name)) continue
    hunt[e.name] = `${e.name}, ${distanceBucket(e.distance)}${plannedHunt.has(e.name) ? ' (next step of the plan)' : ''}`
  }
  if (Object.keys(hunt).length) {
    skills.HUNT = 'Kill a creature for its drops (food, leather...).' + note('HUNT')
    targets.HUNT = hunt
  }

  const go: Record<string, string> = {}
  for (const label of Object.keys(memory.data.places)) {
    const nearest = memory.nearest(label, bot.entity.position)
    if (!nearest || !allowed('GOTO', label)) continue
    const d = bot.entity.position.distanceTo(nearest as any)
    if (d > 8 && d < 500) go[label] = `remembered ${label}, ${distanceBucket(d)}, y ${nearest.y}${needs.seek.includes(label) ? ' (sought by the plan)' : ''}`
  }
  if (Object.keys(go).length) {
    skills.GOTO = 'Walk back to a remembered place.' + note('GOTO')
    targets.GOTO = go
  }

  if (needs.build && allowed('BUILD', needs.build) && memory.data.sites[needs.build]) {
    skills.BUILD = 'Place blocks of the designed structure (clears terrain in the way, builds bottom-up, resumes where it stopped).' + note('BUILD')
    targets.BUILD = { [needs.build]: `${needs.build}: ${needs.lines.find((l) => l.startsWith('structure')) ?? ''}` }
  }

  if (underground && allowed('SURFACE', 'tunnel')) skills.SURFACE = 'Climb back up to the surface (animals, trees, daylight).' + note('SURFACE')

  const hostileNear = perception.entities.some((e) => e.kind === 'hostile' && e.distance < 16)
  // Night only matters under open sky; underground, darkness spawns mobs at any hour and a hole does not help.
  if (!isCreative(bot) && ((!bot.time.isDay && !underground) || (bot.health < 10 && hostileNear)) && allowed('SHELTER', 'tunnel')) {
    skills.SHELTER = 'Dig into the ground and seal the hole to wait out the night, avoid hostiles, or heal safely.'
  }

  // Protection: weapons and armor the bot does not hold yet but can craft right now (any tier the registry offers).
  if (!isCreative(bot) && (!bot.time.isDay || hostileNear || bot.health < 14)) {
    const held = new Set([...bot.inventory.items(), ...bot.inventory.slots.slice(5, 9).filter((i) => !!i)].map((i) => i!.name))
    const slots = ['_sword', '_helmet', '_chestplate', '_leggings', '_boots']
    for (const slot of slots) {
      if ([...held].some((n) => n.endsWith(slot))) continue
      const options = Object.keys(bot.registry.itemsByName).filter((n) => n.endsWith(slot) && !n.startsWith('netherite'))
      const craftable = options.filter((n) => craftsSomething(crafting, n, table, inv))
      if (!craftable.length || !allowed('CRAFT', craftable[0])) continue
      const best = craftable.sort((a, b) => crafting.plan([{ item: b, count: 1 }], table, inv).steps.length - crafting.plan([{ item: a, count: 1 }], table, inv).steps.length)[0]
      ;(targets.CRAFT ??= {})[best] = `${best}: craftable now, protection (none held)`
      skills.CRAFT ??= 'Craft an item; intermediates and the crafting table are handled automatically.' + note('CRAFT')
    }
  }

  skills.STUCK = 'No offered option can make progress on current_subgoal; ask the strategist for help.'
  return { skills, targets }
}

function timePhase(bot: Bot) {
  const t = bot.time.timeOfDay
  if (t < 11500) return 'day'
  if (t < 13000) return 'evening (night soon: hostile mobs will spawn in the dark)'
  if (t < 23000) return 'night (hostile mobs spawn in the dark)'
  return 'dawn'
}

function lightWord(bot: Bot) {
  const block = bot.blockAt(bot.entity.position.floored()) as any
  const light = Math.max(block?.light ?? 0, bot.time.isDay ? block?.skyLight ?? 0 : 0)
  return light <= 3 ? 'dark (hostile mobs can spawn here)' : light <= 8 ? 'dim' : 'bright'
}

/** True when crafting `name` now would actually produce a new one (copies already held do not count). */
function craftsSomething(crafting: Crafting, name: string, table: boolean, inv: Record<string, number>) {
  const without = { ...inv }
  delete without[name]
  const plan = crafting.plan([{ item: name, count: 1 }], table, without)
  return plan.ok && plan.steps.length > 0
}

const MAX_TARGET_OPTIONS = 32

export async function decide(args: {
  goal: string
  subgoal: Subgoal
  planView: string[]
  needs: Needs
  perception: Perception
  bot: Bot
  history: HistoryEntry[]
  advice: string | null
  playerInstruction: string | null
  lessons: string[]
  space: ActionSpace
}): Promise<Decision> {
  const { bot, perception, space } = args
  const pick = pickaxeHealth(bot)
  const state = {
    goal: args.goal,
    current_subgoal: args.subgoal.description,
    subgoal_complete_when: describe(args.subgoal.done_when),
    acquisition_plan: args.needs.lines,
    doable_now: args.needs.doable,
    plan: args.planView,
    bot: {
      health: `${Math.round(bot.health)} of 20`,
      food: `${Math.round(bot.food)} of 20`,
      depth: `${depthBand(perception.y)}, y ${perception.y}`,
      game_mode: isCreative(bot) ? 'CREATIVE: every block/item is available instantly, no damage, no hunger' : 'survival',
      time: timePhase(bot),
      location: surfaceY(bot) - perception.y > 6 ? 'underground' : 'surface (open sky)',
      light: lightWord(bot),
      hazards: perception.hazards,
      weapon: bot.inventory.items().find((i) => /_sword$|_axe$/.test(i.name))?.name ?? 'none',
      armor: bot.inventory.slots.slice(5, 9).filter(Boolean).map((i) => i!.name).join(', ') || 'none',
      best_pickaxe: pick ? `${pick.name}, ${Math.round(pick.remaining * 100)}% durability, ${countItem(bot, pick.name)} held` : 'none',
    },
    inventory: inventoryMap(bot),
    nearby_blocks: [...perception.blocks.values()].sort((a, b) => a.distance - b.distance).slice(0, 20)
      .map((b) => `${b.name} (${b.count}, ${distanceBucket(b.distance)})`),
    nearby_creatures: perception.entities.filter((e) => e.kind !== 'item').slice(0, 8).map((e) => `${e.name} (${e.kind}, ${distanceBucket(e.distance)})`),
    recent_actions: args.history.slice(-8).map((h) => `${h.skill}${h.target ? ' ' + h.target : ''}: ${h.ok ? 'ok' : 'FAILED'} - ${h.result}`),
    player_instruction: args.playerInstruction,
    strategist_advice: args.advice,
    lessons: args.lessons.slice(-6),
  }

  const skillOptions = Object.keys(space.skills) as Option[]
  const questions: Record<string, Question> = {
    skill: { type: 'choice', instructions: { goal: args.goal, rules: RULES, question: 'Which skill should the bot run next?' }, criteria: space.skills },
  }
  for (const [skill, options] of Object.entries(space.targets)) {
    // laya accepts 100 options per choice, but every option also needs a token span in the head budget.
    // Targets are built in priority order (plan steps first, then evidence), so a cap keeps the useful ones.
    questions[`target_${skill}`] = {
      type: 'choice',
      instructions: `If the bot runs ${skill} next, which target best advances current_subgoal? Use acquisition_plan, doable_now, the evidence in each option, and recent_actions.`,
      criteria: Object.fromEntries(Object.entries(options).slice(0, MAX_TARGET_OPTIONS)),
    }
  }
  // Safety is judged by Laya in the same request; code enforces it (confidence-routing pattern).
  questions.danger = {
    type: 'score',
    instructions: 'How dangerous is the bot situation right now, given threats, time, health, gear and hazards in the state?',
    criteria: [
      'safe: no hostile creature close, healthy, no hazard',
      'caution: risk could appear soon (evening, hostiles far away, hunger, weak gear)',
      'danger: hostiles close, or night in the open with weak gear, or low health',
      'critical: about to die (very low health with hostiles close, lava, drowning)',
    ],
  }
  if (args.subgoal.done_when.kind === 'judge') {
    questions.subgoal_done = { type: 'noul', instructions: 'Is current_subgoal already fully accomplished according to the state?' }
  }

  const result = await systemOne(state, questions)
  const skill = readChoice(result.answers.skill, skillOptions)
  const option = skill.choice as Option
  let target: string | null = null
  let targetConfidence: number | null = null
  const targetOptions = option !== 'STUCK' ? space.targets[option] : undefined
  if (targetOptions) {
    const t = readChoice(result.answers[`target_${option}`], Object.keys(targetOptions))
    target = t.choice
    targetConfidence = t.confidence
  }
  const judged = result.answers.subgoal_done
  const danger = result.answers.danger
  return {
    danger: danger?.type === 'score' ? danger.score : 0,
    skill: option,
    target,
    confidence: skill.confidence,
    targetConfidence,
    judgedDone: judged?.type === 'noul' ? judged.noul : null,
    latencyMs: result.latencyMs,
    skillProbabilities: skill.probabilities,
  }
}
