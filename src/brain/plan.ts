/** Plans are data with machine-checkable completion. Code verifies progress; models never grade themselves when code can. */
import type { Bot } from 'mineflayer'
import { countItem, knownName } from '../world/items.ts'
import { findVisible } from '../world/perception.ts'

export interface Predicate {
  kind: 'have' | 'at_or_below_y' | 'near_block' | 'built' | 'judge'
  item: string | null
  count: number | null
  y: number | null
  block: string | null
}

export interface Subgoal {
  description: string
  done_when: Predicate
  hint: string
  done?: boolean
  failures?: number
  steps?: number
  recoveries?: number
}

export interface Plan { goal_done_when: Predicate; subgoals: Subgoal[] }

const PREDICATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'item', 'count', 'y', 'block'],
  properties: {
    kind: { type: 'string', enum: ['have', 'at_or_below_y', 'near_block', 'built', 'judge'] },
    item: { type: ['string', 'null'] },
    count: { type: ['integer', 'null'] },
    y: { type: ['integer', 'null'] },
    block: { type: ['string', 'null'] },
  },
}

export const SUBGOALS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'done_when', 'hint'],
    properties: { description: { type: 'string' }, done_when: PREDICATE_SCHEMA, hint: { type: 'string' } },
  },
}

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal_done_when', 'subgoals'],
  properties: { goal_done_when: PREDICATE_SCHEMA, subgoals: SUBGOALS_SCHEMA },
}

/** Resolves "built" predicates against stored construction sites (set by the agent). */
export let builtCheck: (name: string) => boolean | null = () => null
export function setBuiltCheck(fn: typeof builtCheck) {
  builtCheck = fn
}

/** true/false when code can decide; null when only a judgment (laya noul) can. */
export function check(bot: Bot, p: Predicate): boolean | null {
  switch (p.kind) {
    case 'built':
      return builtCheck(p.item ?? '') ?? false
    case 'have':
      return countItem(bot, p.item!) >= (p.count ?? 1)
    case 'at_or_below_y':
      return bot.entity.position.y <= (p.y ?? 0) + 0.5
    case 'near_block':
      return findVisible(bot, [p.block!], 6, 1).length > 0
    default:
      return null
  }
}

export function describe(p: Predicate): string {
  switch (p.kind) {
    case 'have': return `inventory has at least ${p.count ?? 1} ${p.item}`
    case 'at_or_below_y': return `bot is at or below y ${p.y}`
    case 'near_block': return `standing next to ${p.block}`
    case 'built': return `every block of the structure "${p.item}" is in place`
    default: return 'judged complete from the situation'
  }
}

export function validatePredicate(bot: Bot, p: Predicate): string | null {
  if (p.kind === 'have' && (!p.item || !knownName(bot, p.item))) return `unknown item "${p.item}"`
  if (p.kind === 'near_block' && (!p.block || !bot.registry.blocksByName[p.block])) return `unknown block "${p.block}"`
  if (p.kind === 'built' && !p.item) return 'built needs item = a short structure name'
  if (p.kind === 'at_or_below_y' && (p.y === null || p.y < -64 || p.y > 320)) return `bad y ${p.y}`
  return null
}

export function validatePlan(bot: Bot, plan: Plan): string[] {
  const errors: string[] = []
  const g = validatePredicate(bot, plan.goal_done_when)
  if (g) errors.push(`goal_done_when: ${g}`)
  plan.subgoals.forEach((s, i) => {
    const e = validatePredicate(bot, s.done_when)
    if (e) errors.push(`subgoal ${i + 1} (${s.description}): ${e}`)
  })
  if (!plan.subgoals.length) errors.push('plan has no subgoals')
  return errors
}
