/** System Two. Slow, generative, called rarely: initial plan, recovery when Laya is stuck, lessons after deaths. */
import type { Bot } from 'mineflayer'
import { log } from '../log.ts'
import type { LLM } from './llm.ts'
import { BLUEPRINT_SCHEMA, LIMITS, validate as validateBlueprint, type Blueprint } from '../world/blueprint.ts'
import { PLAN_SCHEMA, SUBGOALS_SCHEMA, validatePlan, type Plan, type Subgoal } from './plan.ts'

const WORLD_RULES = `You are the strategist of an autonomous Minecraft Java 1.21 survival bot.
A fast tactical model executes one skill at a time. Code already derives, from game data and what the bot has seen,
the cheapest chain to obtain any item (recipes, tools each block needs, smelting, mob drops) and where blocks occur.
Skills: MINE <visible block>, CRAFT <item> (intermediates and crafting table automatic), SMELT <input> (furnace automatic),
EXPLORE <heading> (surface travel, or cave walking when underground), DIG_DOWN <depth>, STRIP_MINE (tunnel at this depth),
HUNT <creature>, GOTO <remembered place>, SHELTER (dig in for the night), SURFACE (climb up),
BUILD <structure> (places blocks from a blueprint that is designed separately; materials are gathered automatically).
Survival reflexes (fighting, fleeing, eating, lava, drowning) and hunger detours are automatic; do not plan them.
Your job: turn goals into milestones, and give strategy when the tactical layer is stuck.
If current_state.game_mode is creative: every item is available instantly and nothing can hurt the bot, so never plan
gathering, crafting materials, food or safety; plan only what to build or place (kind "built") or items to hold.
Use exact Minecraft ids. Generic items accepted: "log", "planks", "food", "pickaxe", "coal_any".
Each done_when must be machine-checkable: kind "have" (item + count), "at_or_below_y" (y), "near_block" (block),
"built" (item = short structure name like "house"; one subgoal per structure, materials are derived from its design),
or "judge" only when nothing else fits. Do not add separate subgoals to gather materials for a structure. Unused predicate fields must be null.`

export interface Facts {
  resources: { block: string; y_min: number; y_max: number; y_best: number; surface: boolean; biomes: string[]; abundance: string }[]
  smelting: { input: string; output: string }[]
}

const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resources', 'smelting'],
  properties: {
    resources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['block', 'y_min', 'y_max', 'y_best', 'surface', 'biomes', 'abundance'],
        properties: {
          block: { type: 'string' }, y_min: { type: 'integer' }, y_max: { type: 'integer' }, y_best: { type: 'integer' },
          surface: { type: 'boolean' }, biomes: { type: 'array', items: { type: 'string' } },
          abundance: { type: 'string', enum: ['very_common', 'common', 'uncommon', 'rare', 'very_rare'] },
        },
      },
    },
    smelting: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['input', 'output'], properties: { input: { type: 'string' }, output: { type: 'string' } } },
    },
  },
}

export interface Recovery { hint: string; lesson: string; replace_remaining: boolean; subgoals: Subgoal[] }

const RECOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hint', 'lesson', 'replace_remaining', 'subgoals'],
  properties: {
    hint: { type: 'string' },
    lesson: { type: 'string' },
    replace_remaining: { type: 'boolean' },
    subgoals: SUBGOALS_SCHEMA,
  },
}

export interface InstructionResult { reply: string; hint: string; new_goal: string; replace_remaining: boolean; subgoals: Subgoal[] }

const INSTRUCTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'hint', 'new_goal', 'replace_remaining', 'subgoals'],
  properties: {
    reply: { type: 'string' },
    hint: { type: 'string' },
    new_goal: { type: 'string' },
    replace_remaining: { type: 'boolean' },
    subgoals: SUBGOALS_SCHEMA,
  },
}

export class Strategist {
  constructor(private llm: LLM, private bot: Bot) {}

  /** One-off world facts the game registry lacks: where blocks generate, what smelting produces. Cached by Knowledge. */
  async facts(blocks: string[], items: string[]): Promise<Facts> {
    const system = `You provide Minecraft Java 1.21 world-generation and smelting facts as data. Be accurate; omit what you do not know.`
    const user = JSON.stringify({
      task: 'For each block: the y range where it naturally generates or is found, the best y to look, whether it is found on the surface (trees, sand, animals...), biomes where it is common (exact biome ids, empty if any), and how abundant it is in naturally generated worlds (a placed-only block like iron_block is very_rare). For each item: every furnace smelting recipe that PRODUCES it (input item id -> output item id). Also include smelting recipes that turn any of these items into something else if useful for survival (e.g. cooking food, fuel).',
      blocks,
      items,
    })
    const started = Date.now()
    const facts = await this.llm.json<Facts>(system, user, FACTS_SCHEMA)
    log('llm', `facts in ${Date.now() - started}ms: ${facts.resources.length} resources, ${facts.smelting.length} smelting recipes`)
    return facts
  }

  /** Design a structure as box primitives; validated against the registry and size limits, retried on errors. */
  async design(name: string, request: string, context: object): Promise<Blueprint> {
    const system = `You design Minecraft structures for a bot to build block by block. Output box primitives in relative
coordinates: x and z from 0 to ${LIMITS.size - 1}, y from 0 to ${LIMITS.height - 1}; y = 0 is the first layer above the ground.
Shapes: "fill" (solid box), "walls" (vertical perimeter of the box), "hollow" (all faces). Later parts override earlier
ones: use block "air" to cut doorways, windows and the interior. A door is one "<wood>_door" cell at floor level with air
above it removed by the game. Use common, easy-to-get blocks (planks, logs, cobblestone, glass only if asked, torches,
flowers on grass); if the context says creative mode, any block is available, so use whatever fits the style best
(glass panes, wool, terracotta, lanterns, stairs...). Keep it under ${LIMITS.blocks} blocks and buildable bottom-up: every block must rest on the ground
or touch a block placed before it. Make it match the request's style.`
    let user = JSON.stringify({ name, request, context })
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now()
      const bp = await this.llm.json<Blueprint>(system, user, BLUEPRINT_SCHEMA)
      bp.name = name
      const errors = validateBlueprint(this.bot, bp)
      log('llm', `design "${name}" in ${Date.now() - started}ms: ${bp.parts.length} parts${errors.length ? ', invalid: ' + errors.join('; ') : ''}`)
      if (!errors.length) return bp
      user = JSON.stringify({ name, request, context, previous_errors: errors })
    }
    throw new Error(`could not design ${name}`)
  }

  async plan(goal: string, snapshot: object, lessons: string[]): Promise<Plan> {
    const system = `${WORLD_RULES}\nBreak the goal into 2-8 ordered milestones (the code expands each into concrete steps). Start from the current state; skip what is already satisfied. Keep each hint short.`
    let user = JSON.stringify({ goal, current_state: snapshot, lessons_from_previous_runs: lessons })
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now()
      const plan = await this.llm.json<Plan>(system, user, PLAN_SCHEMA)
      const errors = validatePlan(this.bot, plan)
      log('llm', `plan in ${Date.now() - started}ms (${plan.subgoals.length} subgoals)${errors.length ? ' invalid: ' + errors.join('; ') : ''}`)
      if (!errors.length) return plan
      user = JSON.stringify({ goal, current_state: snapshot, lessons_from_previous_runs: lessons, previous_plan_errors: errors })
    }
    throw new Error('strategist could not produce a valid plan')
  }

  /** A player talked to the bot in chat: answer, and turn the request into plan changes. */
  async instruct(goal: string, plan: Plan, player: string, message: string, snapshot: object, history: object[]): Promise<InstructionResult> {
    const system = `${WORLD_RULES}
A player is talking to the bot in the game chat. Their requests take priority over the current plan (unless suicidal).
Return: reply = a short in-game chat answer in the player's language (under 200 chars);
hint = one concrete instruction for the tactical model naming a skill and target from current_state.available_skills, or "";
new_goal = a replacement overall goal only if the player asks for a different objective, else "";
replace_remaining = true to replace the remaining subgoals with subgoals (e.g. insert "recover items at death_site" first), else false and [].
Use GOTO death_site to recover dropped items (they vanish about 5 minutes after death).`
    const user = JSON.stringify({ goal, player, message, plan: plan.subgoals.map((g) => ({ description: g.description, done: !!g.done })), current_state: snapshot, recent_actions: history.slice(-10) })
    const started = Date.now()
    const result = await this.llm.json<InstructionResult>(system, user, INSTRUCTION_SCHEMA)
    if (result.replace_remaining) {
      const errors = validatePlan(this.bot, { goal_done_when: plan.goal_done_when, subgoals: result.subgoals })
      if (errors.length) {
        log('llm', `instruction plan rejected: ${errors.join('; ')}`)
        result.replace_remaining = false
      }
    }
    log('llm', `instruction handled in ${Date.now() - started}ms: ${result.reply}`)
    return result
  }

  async recover(goal: string, plan: Plan, reason: string, snapshot: object, history: object[], lessons: string[]): Promise<Recovery> {
    const system = `${WORLD_RULES}\nThe tactical model is failing. Diagnose from the failure log and state.
Return: hint = one concrete instruction for the tactical model (under 200 chars) that names a skill and target present in current_state.available_skills;
lesson = a NEW reusable rule for future runs that is not already in lessons, or "" (prefer ""; never restate an existing lesson);
replace_remaining = true only if the remaining subgoals are wrong, then give the full replacement list in subgoals (else []).`
    const user = JSON.stringify({
      goal,
      reason,
      plan: plan.subgoals.map((s) => ({ description: s.description, done: !!s.done, failures: s.failures ?? 0 })),
      current_state: snapshot,
      recent_actions: history.slice(-15),
      lessons,
    })
    const started = Date.now()
    const recovery = await this.llm.json<Recovery>(system, user, RECOVERY_SCHEMA)
    if (recovery.replace_remaining) {
      const errors = validatePlan(this.bot, { goal_done_when: plan.goal_done_when, subgoals: recovery.subgoals })
      if (errors.length) {
        log('llm', `recovery plan rejected: ${errors.join('; ')}`)
        recovery.replace_remaining = false
      }
    }
    log('llm', `recovery in ${Date.now() - started}ms: ${recovery.hint}${recovery.replace_remaining ? ` (+${recovery.subgoals.length} new subgoals)` : ''}`)
    return recovery
  }
}
