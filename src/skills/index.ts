/**
 * Skill library: deterministic, interruptible macro-actions. Laya chooses WHICH skill and WHICH target;
 * code decides HOW (pathing, tools, batch sizes, safety). Model output never becomes coordinates or code.
 */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { HEADINGS } from '../world/directions.ts'
import { countItem, FOOD, fuelValue, inventoryMap, matchesItem } from '../world/items.ts'
import { bestWeapon } from '../brain/reflex.ts'
import { log } from '../log.ts'
import { creativeGive, isCreative } from '../world/creative.ts'
import { chooseOrigin, footprint, itemFor, progress, sameBlock, type Site } from '../world/blueprint.ts'
import { craftReliably } from './craft-window.ts'
import { findVisible } from '../world/perception.ts'
import { Aborted, checkAbort, fail, go, goals, Movements, ok, placeNear, sleep, type SkillContext, type SkillResult } from './context.ts'

const CARDINAL = ['north', 'east', 'south', 'west'].map((h) => HEADINGS[h])

function dropsOf(bot: Bot, blockName: string): string[] {
  const block = bot.registry.blocksByName[blockName] as any
  return (block?.drops ?? []).map((d: any) => bot.registry.items[typeof d === 'number' ? d : d?.drop?.id ?? d?.id]?.name).filter(Boolean)
}

export function canHarvest(bot: Bot, blockName: string): boolean {
  const block = bot.registry.blocksByName[blockName] as any
  if (!block?.harvestTools) return true
  return Object.keys(block.harvestTools).some((id) => bot.inventory.count(Number(id), null) > 0)
}

function defaultBatch(blockName: string) {
  if (blockName.includes('ore')) return 6
  if (blockName.endsWith('_log')) return 5
  if (blockName === 'stone' || blockName === 'cobblestone' || blockName === 'deepslate') return 10
  return 4
}

async function mine(ctx: SkillContext, blockName: string): Promise<SkillResult> {
  const { bot } = ctx
  if (!canHarvest(bot, blockName)) return fail(`cannot harvest ${blockName} with current tools (needs a better pickaxe)`)
  const drops = dropsOf(bot, blockName)
  const needed = ctx.need && drops.some((d) => matchesItem(ctx.need!.item, d))
    ? Math.max(1, ctx.need.count - countItem(bot, ctx.need.item)) : defaultBatch(blockName)
  const before = inventoryMap(bot)
  let collected = 0
  let failures = 0
  let lastError = ''
  while (collected < needed && failures < 3) {
    checkAbort(ctx)
    const target = pickReachable(bot, findVisible(bot, [blockName], 48, 24))
    if (!target) break
    try {
      const beforeOne = inventoryMap(bot)
      await withTimeout(ctx, digOne(ctx, target), 30_000)
      collected = gained(before, inventoryMap(bot), drops)
      if (bot.blockAt(target.position)?.name !== blockName) {
        const after = inventoryMap(bot)
        ctx.knowledge.recordDrop(blockName, Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (beforeOne[k] ?? 0)])))
      }
    } catch (e) {
      if (e instanceof Aborted) throw e
      lastError = (e as Error).message.slice(0, 100)
      log('info', `mine ${blockName} at ${target.position} failed: ${lastError}`)
      failures++
    }
    // A block that stays put after an attempt is unreachable; never pick it again this session.
    if (bot.blockAt(target.position)?.name === blockName) {
      failures++
      unreachable.add(target.position.toString())
      ctx.memory.forget(blockName, target.position)
    }
  }
  collected = gained(before, inventoryMap(bot), drops)
  if (!collected) return fail(`no ${blockName} collected (${failures ? `unreachable: ${lastError || 'block stayed in place'}` : 'none reachable in sight'})`)
  return ok(`collected ${collected} ${drops[0] ?? blockName}`)
}

const unreachable = new Set<string>()

/** Walk into reach with line of sight, dig with the best tool, then sweep up nearby drops. */
async function digOne(ctx: SkillContext, target: any) {
  const { bot } = ctx
  const p = target.position
  // Line-of-sight reach first; if that search fails (tight tunnels), dig a way next to the block.
  if (!(await go(ctx, new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), 10_000))) {
    await go(ctx, new goals.GoalNear(p.x, p.y, p.z, 1), 8_000)
  }
  const block = bot.blockAt(p)
  if (!block || block.name !== target.name) return // someone (or gravity) already removed it
  if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 5) throw new Error('no path into reach')
  await (bot as any).tool.equipForBlock(block, { requireHarvest: true })
  await bot.dig(block, true)
  await collectDrops(ctx, 6, 4_000)
}

/** Prefer blocks within arm's reach vertically: without scaffolding blocks the bot cannot tower up to tree tops. */
function pickReachable(bot: Bot, blocks: any[]) {
  const me = bot.entity.position
  const hasScaffold = bot.inventory.items().some((i) => ['dirt', 'cobblestone', 'cobbled_deepslate'].includes(i.name))
  const cost = (b: any) => b.position.distanceTo(me) + (hasScaffold ? 1 : 6) * Math.max(0, b.position.y - me.y - 2)
  // Without scaffolding, anything more than a few blocks above the feet is out of reach.
  return blocks
    .filter((b) => !unreachable.has(b.position.toString()) && (hasScaffold || b.position.y - me.y <= 5))
    .sort((a, b) => cost(a) - cost(b))[0]
}

function gained(before: Record<string, number>, after: Record<string, number>, names: string[]) {
  return names.reduce((s, n) => s + Math.max(0, (after[n] ?? 0) - (before[n] ?? 0)), 0)
}

async function withTimeout<T>(ctx: SkillContext, promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const abort = new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Aborted('interrupted')), { once: true }))
  try {
    return await Promise.race([promise, abort, new Promise<never>((_, r) => (timer = setTimeout(() => r(new Error('timeout')), ms)))])
  } catch (e) {
    ;(ctx.bot as any).pathfinder?.stop()
    throw e
  } finally {
    clearTimeout(timer)
  }
}

class StationError extends Error {}

async function ensureStation(ctx: SkillContext, name: 'crafting_table' | 'furnace'): Promise<any | null> {
  const { bot } = ctx
  let station = bot.findBlock({ matching: bot.registry.blocksByName[name].id, maxDistance: 24 })
  if (!station && !countItem(bot, name)) {
    const result = await craft(ctx, name, 1)
    if (!result.ok) return null
  }
  if (!station) station = await placeNear(ctx, name)
  if (!station) throw new StationError(`could not place ${name}: no free spot even after digging a nook`)
  ctx.memory.remember(name, station.position)
  if (!(await go(ctx, new goals.GoalNear(station.position.x, station.position.y, station.position.z, 2), 30_000))) return null
  return bot.blockAt(station.position)
}

async function craft(ctx: SkillContext, itemName: string, requested?: number): Promise<SkillResult> {
  const { bot } = ctx
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 24 })
  const count = requested ?? (ctx.need && matchesItem(ctx.need.item, itemName) ? Math.max(1, ctx.need.count - countItem(bot, ctx.need.item)) : 1)
  const inv = inventoryMap(bot)
  const name = ctx.crafting.resolveName(itemName, inv)
  const have = inv[name] ?? 0
  delete inv[name] // plan to make new ones, not to "use" the copies already held
  const plan = ctx.crafting.plan([{ item: name, count }], !!table, inv)
  if (!plan.ok) return fail(`cannot craft ${name}: missing ${Object.entries(plan.missing).map(([k, v]) => `${v} ${k}`).join(', ')}`)
  for (const step of plan.steps) {
    checkAbort(ctx)
    let station = null
    if (step.recipe.requiresTable) {
      try {
        station = await ensureStation(ctx, 'crafting_table')
      } catch (e) {
        if (e instanceof StationError) return fail(e.message)
        throw e
      }
      if (!station) return fail('no crafting table reachable or placeable')
    }
    try {
      await craftReliably(bot, step.recipe, step.times, station).catch(async (e) => {
        if (!/grid did not form/.test(e.message)) throw e
        await craftReliably(bot, step.recipe, step.times, station) // one retry from a clean grid
      })
    } catch (e) {
      return fail(`crafting ${step.item} failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }
  const now = countItem(bot, name)
  const slot = ({ _helmet: 'head', _chestplate: 'torso', _leggings: 'legs', _boots: 'feet' } as const)[name.match(/_(helmet|chestplate|leggings|boots)$/)?.[0] as '_helmet' ?? '_helmet']
  if (now > have && /_(helmet|chestplate|leggings|boots)$/.test(name)) {
    const piece = bot.inventory.items().find((i) => i.name === name)
    if (piece) await bot.equip(piece, slot).catch(() => {})
  }
  return now > have ? ok(`crafted ${name} (now have ${now})`) : fail(`crafting ${name} produced nothing`)
}

async function smelt(ctx: SkillContext, input: string): Promise<SkillResult> {
  const { bot } = ctx
  const output = ctx.knowledge.smeltOutput(input)
  const have = countItem(bot, input)
  if (!output || !have) return fail(`nothing to smelt: ${input}`)
  const amount = ctx.need && ctx.need.item === output ? Math.min(have, Math.max(1, ctx.need.count - countItem(bot, output))) : Math.min(have, 8)
  const fuel = bot.inventory.items().filter((i) => i.name !== input && fuelValue(i.name) > 0).sort((a, b) => fuelValue(b.name) - fuelValue(a.name))[0]
  if (!fuel) return fail('no fuel (coal, charcoal, planks or logs) in inventory')
  const fuelCount = Math.min(fuel.count, Math.ceil(amount / fuelValue(fuel.name)))
  let station
  try {
    station = await ensureStation(ctx, 'furnace')
  } catch (e) {
    if (e instanceof StationError) return fail(e.message)
    throw e
  }
  if (!station) return fail(countItem(bot, 'furnace') ? 'furnace in inventory but not reachable after placing' : 'no furnace and cannot craft one (needs 8 cobblestone)')
  const furnace = await bot.openFurnace(station)
  const before = countItem(bot, output)
  try {
    await furnace.putFuel(fuel.type, null, fuelCount)
    await furnace.putInput(bot.registry.itemsByName[input].id, null, amount)
    const deadline = Date.now() + amount * 10_500 + 5_000
    while (Date.now() < deadline) {
      await sleep(ctx, 1_000)
      if (furnace.outputItem()) await furnace.takeOutput()
      if (countItem(bot, output) - before >= amount) break
    }
    if (furnace.outputItem()) await furnace.takeOutput()
  } finally {
    furnace.close()
  }
  const made = countItem(bot, output) - before
  return made > 0 ? ok(`smelted ${made} ${output}`) : fail(`smelting ${input} produced nothing`)
}

async function explore(ctx: SkillContext, direction: string): Promise<SkillResult> {
  const { bot } = ctx
  const [dx, dz] = HEADINGS[direction]
  const start = bot.entity.position.clone()
  ctx.memory.markExplored(direction, cell(start))
  const underground = surfaceY(bot) - start.y > 6
  if (underground) return exploreCaves(ctx, direction)
  const land = landTarget(bot, dx, dz)
  const goal = land ? new goals.GoalNear(land.x, land.y + 1, land.z, 2) : new goals.GoalXZ(Math.round(start.x + dx * 40), Math.round(start.z + dz * 40))
  const done = go(ctx, goal, 45_000)
  let found: any = null
  const watcher = setInterval(() => {
    if (found) return
    const animal = ctx.seekEntities?.length
      ? bot.nearestEntity((e) => ctx.seekEntities!.includes(e.name ?? '') && e.position.distanceTo(bot.entity.position) < 24)
      : null
    if (animal) {
      found = { name: animal.name }
      ;(bot as any).pathfinder.stop()
      return
    }
    if (!ctx.seek.length) return
    const hit = pickReachable(bot, findVisible(bot, ctx.seek, 32, 16))
    if (hit) {
      found = hit
      ;(bot as any).pathfinder.stop()
    }
  }, 700)
  try {
    await done
  } finally {
    clearInterval(watcher)
  }
  const moved = Math.round(bot.entity.position.distanceTo(start))
  if (found) return ok(`found ${found.name} after walking ${moved} blocks ${direction}`)
  return moved > 8 ? ok(`walked ${moved} blocks ${direction}, nothing sought found`) : fail(`could not travel ${direction}`)
}

/** Farthest dry, standable surface block in a heading (loaded chunks only). Pathfinding across open water is slow and fragile. */
function landTarget(bot: Bot, dx: number, dz: number): Vec3 | null {
  const start = bot.entity.position.floored()
  for (let dist = 40; dist >= 12; dist -= 4) {
    const x = Math.round(start.x + dx * dist)
    const z = Math.round(start.z + dz * dist)
    for (let y = Math.min(start.y + 24, 318); y >= start.y - 24; y--) {
      const block = bot.blockAt(new Vec3(x, y, z))
      if (!block) break // chunk not loaded
      if (block.name === 'air' || block.name === 'cave_air' || block.boundingBox === 'empty' && block.name !== 'water' && block.name !== 'lava') continue
      if (block.name === 'water' || block.name === 'lava' || block.name.endsWith('_leaves')) break // top is liquid or canopy
      const above = bot.blockAt(new Vec3(x, y + 1, z))
      const sky = bot.blockAt(new Vec3(x, y + 2, z))
      if (above?.boundingBox === 'empty' && sky?.boundingBox === 'empty' && above.name !== 'water') return new Vec3(x, y, z)
      break
    }
  }
  return null
}

/** Walk open caves in a heading without digging: saves pickaxe durability and exposes many ores. */
async function exploreCaves(ctx: SkillContext, direction: string): Promise<SkillResult> {
  const { bot } = ctx
  const b = bot as any
  const [dx, dz] = HEADINGS[direction]
  const start = bot.entity.position.clone()
  const walkOnly = new Movements(bot)
  walkOnly.canDig = false
  walkOnly.allow1by1towers = false
  walkOnly.liquidCost = 100
  b.pathfinder.setMovements(walkOnly)
  const goal = new goals.GoalNearXZ(Math.round(start.x + dx * 32), Math.round(start.z + dz * 32), 6)
  let found: any = null
  const watcher = setInterval(() => {
    const hit = ctx.seek.length ? pickReachable(bot, findVisible(bot, ctx.seek, 32, 16)) : null
    if (hit && !found) {
      found = hit
      b.pathfinder.stop()
    }
  }, 700)
  try {
    b.pathfinder.setGoal(goal)
    const started = Date.now()
    while (Date.now() - started < 30_000 && !found) {
      await sleep(ctx, 300)
      if (Date.now() - started > 1_500 && !b.pathfinder.isMoving()) break // arrived or no cave path
    }
  } finally {
    clearInterval(watcher)
    b.pathfinder.setGoal(null)
    b.pathfinder.setMovements(b.safeMovements)
  }
  const moved = Math.round(bot.entity.position.distanceTo(start))
  if (found) return ok(`found ${found.name} in caves after ${moved} blocks`)
  return moved > 6 ? ok(`walked ${moved} blocks of cave ${direction}, nothing sought found`) : fail(`no open cave passage ${direction}`)
}

export function cell(pos: Vec3) {
  return `${Math.floor(pos.x / 64)},${Math.floor(pos.z / 64)}`
}

/** Target is "y<number>", chosen from learned/prior whereabouts of what the plan seeks. */
async function digDown(ctx: SkillContext, target: string): Promise<SkillResult> {
  const { bot } = ctx
  const targetY = Math.max(-59, Number(target.replace(/^y/, '')))
  if (!Number.isFinite(targetY)) return fail(`bad depth target ${target}`)
  if (!bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) return fail('need a pickaxe to dig down')
  let stalls = 0
  while (bot.entity.position.y > targetY + 1 && stalls < 3) {
    checkAbort(ctx)
    const y = Math.floor(bot.entity.position.y)
    const reached = await go(ctx, new goals.GoalY(Math.max(targetY, y - 8)), 45_000)
    if (!reached || Math.floor(bot.entity.position.y) >= y) stalls++
    const hit = ctx.seek.length ? findVisible(bot, ctx.seek, 16, 1)[0] : null
    if (hit) return ok(`found ${hit.name} on the way down at depth y ${Math.floor(bot.entity.position.y)}`)
  }
  const y = Math.floor(bot.entity.position.y)
  return y <= targetY + 2 ? ok(`reached y ${y}`) : fail(`stuck digging down at y ${y}`)
}

/** Highest solid block in this column (chunk data covers the whole height). */
export function surfaceY(bot: Bot): number {
  const p = bot.entity.position.floored()
  for (let y = 319; y > p.y; y--) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z))
    if (b && b.boundingBox === 'block' && !b.name.endsWith('_leaves')) return y
  }
  return p.y
}

async function surface(ctx: SkillContext): Promise<SkillResult> {
  const { bot } = ctx
  const top = surfaceY(bot) + 1
  let stalls = 0
  while (bot.entity.position.y < top - 1 && stalls < 3) {
    checkAbort(ctx)
    const y = Math.floor(bot.entity.position.y)
    const reached = await go(ctx, new goals.GoalY(Math.min(top, y + 8)), 45_000)
    if (!reached || Math.floor(bot.entity.position.y) <= y) stalls++
  }
  const y = Math.floor(bot.entity.position.y)
  return y >= top - 2 ? ok(`reached the surface at y ${y}`) : fail(`stuck climbing at y ${y} (surface is y ${top})`)
}

let stripHeading = 0
async function stripMine(ctx: SkillContext): Promise<SkillResult> {
  const { bot } = ctx
  if (!bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) return fail('need a pickaxe to tunnel')
  const dirs = CARDINAL
  const y = Math.floor(bot.entity.position.y)
  let tunnelled = 0
  let blocked = 0
  while (tunnelled < 32 && blocked < 4) {
    checkAbort(ctx)
    const [dx, dz] = dirs[stripHeading % 4]
    const p = bot.entity.position.floored()
    const ahead = p.offset(dx * 4, 0, dz * 4)
    const lavaAhead = [1, 2, 3, 4, 5].some((k) => [0, 1, -1].some((h) => bot.blockAt(p.offset(dx * k, h, dz * k))?.name === 'lava'))
    if (lavaAhead || !(await go(ctx, new goals.GoalBlock(ahead.x, y, ahead.z), 30_000))) {
      stripHeading++
      blocked++
      continue
    }
    tunnelled += 4
    const hit = ctx.seek.length ? findVisible(bot, ctx.seek, 12, 1)[0] : null
    if (hit) return ok(`tunnel revealed ${hit.name}`)
  }
  if (!tunnelled) return fail('tunnel blocked in every direction')
  return ok(`tunnelled ${tunnelled} blocks at y ${y}, nothing sought revealed`)
}

async function hunt(ctx: SkillContext, name: string): Promise<SkillResult> {
  const { bot } = ctx
  const target = bot.nearestEntity((e) => e.name === name && e.position.distanceTo(bot.entity.position) < 32)
  if (!target) return fail(`no ${name} nearby`)
  const weapon = bestWeapon(bot)
  if (weapon) await bot.equip(weapon, 'hand')
  ;(bot as any).pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true)
  const deadline = Date.now() + 30_000
  try {
    while (target.isValid && Date.now() < deadline) {
      checkAbort(ctx)
      if (target.position.distanceTo(bot.entity.position) < 3.2) bot.attack(target)
      await sleep(ctx, 550)
    }
  } finally {
    ;(bot as any).pathfinder.setGoal(null)
  }
  if (target.isValid) return fail(`could not catch ${name}`)
  await collectDrops(ctx)
  return ok(`killed ${name}`)
}

async function collectDrops(ctx: SkillContext, radius = 8, budgetMs = 10_000) {
  const { bot } = ctx
  const deadline = Date.now() + budgetMs
  await sleep(ctx, 250) // let the item entity spawn
  while (Date.now() < deadline) {
    const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < radius)
    if (!drop) return
    const left = deadline - Date.now()
    if (!(await go(ctx, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), Math.max(500, left)))) return
    await sleep(ctx, 150)
  }
}

async function gotoPlace(ctx: SkillContext, label: string): Promise<SkillResult> {
  const place = ctx.memory.nearest(label, ctx.bot.entity.position)
  if (!place) return fail(`no remembered ${label}`)
  const reached = await go(ctx, new goals.GoalNear(place.x, place.y, place.z, 2), 60_000)
  if (!reached) {
    ctx.memory.forget(label, new Vec3(place.x, place.y, place.z))
    return fail(`could not reach ${label}; forgot that place`)
  }
  const block = blockNameAt(ctx, place)
  if (ctx.bot.registry.blocksByName[label] && block !== label) {
    ctx.memory.forget(label, new Vec3(place.x, place.y, place.z))
    return fail(`arrived but the ${label} is gone (now ${block}); forgot it`)
  }
  if (label === 'death_site') {
    await collectDrops(ctx, 10, 15_000)
    ctx.memory.forget(label, new Vec3(place.x, place.y, place.z))
  }
  return ok(`arrived at ${label}`)
}

function blockNameAt(ctx: SkillContext, place: { x: number; y: number; z: number }) {
  return ctx.bot.blockAt(new Vec3(place.x, place.y, place.z))?.name ?? 'unknown'
}

/**
 * Keep free slots for loot. Tosses the largest stacks of plain blocks the current plan does not need, keeping one stack
 * of a cheap full block for scaffolding. Runs between decisions, not as a model choice.
 */
export async function tidyInventory(bot: Bot, keep: Set<string>) {
  if (bot.inventory.emptySlotCount() > 3) return
  const reg = bot.registry as any
  let scaffoldKept = false
  const candidates = bot.inventory.items()
    .filter((i) => reg.blocksByName[i.name]?.boundingBox === 'block' && !keep.has(i.name) && !FOOD.has(i.name) && !['crafting_table', 'furnace'].includes(i.name))
    .sort((a, b) => b.count - a.count)
  for (const item of candidates) {
    if (!scaffoldKept && item.count >= 16) {
      scaffoldKept = true
      continue
    }
    try {
      await bot.tossStack(item)
    } catch {}
    if (bot.inventory.emptySlotCount() > 5) return
  }
}

/** Pathfinding must never break or build inside a structure the bot is making (or made). */
export function protectSites(movements: any, sites: Record<string, Site>) {
  const boxes = Object.values(sites).filter((s) => s.origin).map((s) => ({ o: s.origin!, ...footprint(s.cells) }))
  const inside = (p: Vec3) => boxes.some((b) => p.x >= b.o.x && p.x < b.o.x + b.w && p.z >= b.o.z && p.z < b.o.z + b.d && p.y >= b.o.y - 1 && p.y < b.o.y + b.h)
  movements.exclusionAreasBreak = [(block: any) => (inside(block.position) ? 100_000 : 0)]
  movements.exclusionAreasPlace = [(block: any) => (inside(block.position) ? 100_000 : 0)]
}

/** Place one block at `pos`, against any solid neighbour, from a spot the pathfinder finds for placing. */
async function placeAt(ctx: SkillContext, pos: Vec3, blockName: string): Promise<boolean> {
  const { bot } = ctx
  const item = itemFor(bot, blockName)
  if (item && isCreative(bot) && !countItem(bot, item)) await creativeGive(bot, item, 64)
  const stack = bot.inventory.items().find((i) => i.name === item)
  if (!stack) return false
  for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = bot.blockAt(pos.offset(d[0], d[1], d[2]))
    if (!ref || ref.boundingBox !== 'block') continue
    if (bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3 || bot.entity.position.floored().equals(pos) || bot.entity.position.floored().offset(0, 1, 0).equals(pos)) {
      if (!(await go(ctx, new goals.GoalPlaceBlock(pos, bot.world, { range: 4 }), 15_000))) continue
    }
    try {
      await bot.equip(stack, 'hand')
      await bot.placeBlock(ref, new Vec3(-d[0], -d[1], -d[2]))
    } catch {}
    if (sameBlock(bot.blockAt(pos)?.name ?? '', blockName)) return true
  }
  return false
}

/** Build (or continue building) a designed structure: clear what is in the way, then place bottom-up. */
async function build(ctx: SkillContext, name: string): Promise<SkillResult> {
  const { bot } = ctx
  const site = ctx.memory.data.sites[name]
  if (!site) return fail(`no design for ${name}`)
  if (!site.origin) {
    const origin = chooseOrigin(bot, site.cells)
    if (!origin) return fail('no flat enough building site nearby')
    site.origin = { x: origin.x, y: origin.y, z: origin.z }
    ctx.memory.remember(`build_site_${name}`, origin)
    ctx.memory.save()
    protectSites((bot as any).safeMovements, ctx.memory.data.sites)
  }
  const origin = new Vec3(site.origin.x, site.origin.y, site.origin.z)
  const b = bot as any
  const moves = new Movements(bot)
  moves.canDig = true
  moves.allow1by1towers = true
  moves.canOpenDoors = true
  moves.scafoldingBlocks = b.safeMovements?.scafoldingBlocks ?? []
  protectSites(moves, ctx.memory.data.sites)
  b.pathfinder.setMovements(moves)
  const started = Date.now()
  let placed = 0
  let failures = 0
  const skipped = new Set<string>()
  try {
    while (Date.now() - started < 110_000 && failures < 8) {
      checkAbort(ctx)
      const prog = progress(bot, site)
      if (!prog.remaining.length) return ok(`${name} is complete (${prog.total} blocks)`)
      const me = bot.entity.position
      const candidates = prog.remaining
        .filter((c) => !skipped.has(c.join()))
        .sort((a, bb) => a[1] - bb[1] || Number(bb[3] === 'air') - Number(a[3] === 'air') || origin.offset(a[0], a[1], a[2]).distanceTo(me) - origin.offset(bb[0], bb[1], bb[2]).distanceTo(me))
      // Next cell: something to clear, or a block we hold that has something to rest against.
      const next = candidates.find((c) => {
        const pos = origin.offset(c[0], c[1], c[2])
        const here = bot.blockAt(pos)
        if (c[3] === 'air' || (here && here.boundingBox === 'block')) return true
        if (!isCreative(bot) && !bot.inventory.items().some((i) => i.name === itemFor(bot, c[3]))) return false
        return [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some((d) => bot.blockAt(pos.offset(d[0], d[1], d[2]))?.boundingBox === 'block')
      })
      if (!next) break
      const pos = origin.offset(next[0], next[1], next[2])
      const here = bot.blockAt(pos)
      if (here && here.boundingBox === 'block' && !sameBlock(here.name, next[3])) {
        // Terrain (or a wrong block) in the way: clear it; the structure's own cells are protected from pathing only.
        if (!(await go(ctx, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), 12_000))) {
          skipped.add(next.join())
          failures++
          continue
        }
        await (bot as any).tool.equipForBlock(here).catch(() => {})
        await bot.dig(here, true).catch(() => {})
        if (next[3] === 'air') continue
      }
      if (next[3] === 'air') {
        skipped.add(next.join())
        continue
      }
      if (await placeAt(ctx, pos, next[3])) placed++
      else {
        skipped.add(next.join())
        failures++
      }
    }
  } finally {
    b.pathfinder.setMovements(b.safeMovements)
  }
  const prog = progress(bot, site)
  if (!prog.remaining.length) return ok(`${name} is complete (${prog.total} blocks)`)
  const missing = Object.entries(prog.missing).map(([i, n]) => `${n} ${i}`).join(', ')
  return placed
    ? ok(`placed ${placed} blocks of ${name}; ${prog.done}/${prog.total} done${missing ? `; still missing ${missing}` : ''}`)
    : fail(`could not place anything on ${name}${missing ? `; missing ${missing}` : ' (unreachable or unsupported cells)'}`)
}

/** Dig two blocks down, seal the hole, and wait for day or for hostiles to leave. */
async function shelter(ctx: SkillContext): Promise<SkillResult> {
  const { bot } = ctx
  // Stand on diggable solid ground first (not leaves, water or a ledge).
  const diggable = (p: Vec3) => {
    const b = bot.blockAt(p)
    return !!b && b.boundingBox === 'block' && b.name !== 'bedrock' && !b.name.endsWith('_leaves') && bot.canDigBlock(b)
  }
  let top = bot.entity.position.floored()
  if (!diggable(top.offset(0, -1, 0)) || !diggable(top.offset(0, -2, 0))) {
    const spot = bot.findBlock({
      maxDistance: 10,
      matching: (b) => b.boundingBox === 'block' && !b.name.endsWith('_leaves'),
      useExtraInfo: (b) => diggable(b.position.offset(0, -1, 0)) && bot.blockAt(b.position.offset(0, 1, 0))?.boundingBox === 'empty' && bot.blockAt(b.position.offset(0, 2, 0))?.boundingBox === 'empty',
    })
    if (!spot || !(await go(ctx, new goals.GoalBlock(spot.position.x, spot.position.y + 1, spot.position.z), 12_000))) return fail('no diggable ground nearby for a shelter')
    top = bot.entity.position.floored()
  }
  for (const depth of [1, 2]) {
    checkAbort(ctx)
    const block = bot.blockAt(top.offset(0, -depth, 0))
    if (!block || block.boundingBox !== 'block' || block.name === 'bedrock') return fail(`cannot dig into ${block?.name ?? 'unknown'}`)
    const nearLiquid = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => ['water', 'lava'].includes(bot.blockAt(block.position.offset(dx, 0, dz))?.name ?? ''))
    if (nearLiquid) return fail('liquid next to the shelter spot')
    await bot.dig(block, true)
    await sleep(ctx, 400)
  }
  // Seal every opening around the two cells the bot occupies (caves can breach the sides), then the roof.
  const bottom = top.offset(0, -2, 0)
  const fillerItem = () => bot.inventory.items().find((i) => (bot.registry.blocksByName[i.name] as any)?.boundingBox === 'block' && !['crafting_table', 'furnace'].includes(i.name) && !i.name.endsWith('_log'))
  const seal = async (target: Vec3) => {
    if (bot.blockAt(target)?.boundingBox !== 'empty') return true
    const item = fillerItem()
    if (!item) return false
    for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const ref = bot.blockAt(target.offset(d[0], d[1], d[2]))
      if (!ref || ref.boundingBox !== 'block') continue
      try {
        await bot.equip(item, 'hand')
        await bot.placeBlock(ref, new Vec3(-d[0], -d[1], -d[2]))
        return true
      } catch {}
    }
    return false
  }
  for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) await seal(bottom.offset(dx, dy, dz))
  const roofed = await seal(top)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const hostile = bot.nearestEntity((e) => (e as any).type === 'hostile' && e.position.distanceTo(bot.entity.position) < 16)
    if (bot.time.isDay && !hostile) break
    await sleep(ctx, 2_000)
  }
  return ok(`${roofed ? 'sealed shelter' : 'open hole (no blocks to seal it)'}; ${bot.time.isDay ? 'day now' : 'still night'}`)
}

export type SkillName = 'MINE' | 'CRAFT' | 'SMELT' | 'EXPLORE' | 'DIG_DOWN' | 'STRIP_MINE' | 'HUNT' | 'GOTO' | 'SHELTER' | 'SURFACE' | 'BUILD'

export const SKILLS: Record<SkillName, (ctx: SkillContext, target: string) => Promise<SkillResult>> = {
  MINE: mine,
  CRAFT: (ctx, t) => craft(ctx, t),
  SMELT: smelt,
  EXPLORE: explore,
  DIG_DOWN: digDown,
  STRIP_MINE: stripMine,
  HUNT: hunt,
  GOTO: gotoPlace,
  SHELTER: shelter,
  SURFACE: surface,
  BUILD: build,
}
