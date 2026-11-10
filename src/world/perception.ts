/** Turns raw world state into a small, bucketed, English observation. No coordinates or arithmetic reach Laya. */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { config } from '../config.ts'
import { HOSTILE, PASSIVE } from './items.ts'

const IGNORE = new Set([
  'air', 'cave_air', 'void_air', 'bedrock', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
  'snow', 'water', 'lava', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'torch', 'wall_torch',
])
export interface BlockSeen { name: string; count: number; distance: number; position: Vec3 }
export interface EntitySeen { name: string; kind: 'hostile' | 'animal' | 'player' | 'item'; distance: number; id: number }

export interface Perception {
  blocks: Map<string, BlockSeen>
  /** Individual sightings of tracked resource blocks (for learning where things occur). */
  instances: { name: string; position: Vec3; biome?: string }[]
  entities: EntitySeen[]
  hazards: string[]
  y: number
}

export function distanceBucket(d: number) {
  return d < 3 ? 'adjacent' : d < 8 ? 'near' : d < 20 ? 'medium distance' : 'far'
}

export function depthBand(y: number) {
  if (y >= 50) return 'surface'
  if (y >= 0) return 'stone layer (iron is common around y 16)'
  if (y > -50) return 'deepslate layer'
  return 'diamond layer (y -64 to -50)'
}

function exposed(bot: Bot, pos: Vec3) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(pos.offset(d[0], d[1], d[2]))
    if (b && b.boundingBox === 'empty') return true
  }
  return false
}

/** Fair mode: a block counts as seen only if it touches open space and is close or in line of sight. */
export function perceivable(bot: Bot, block: any): boolean {
  if (config.perception === 'xray') return true
  if (!exposed(bot, block.position)) return false
  const d = block.position.distanceTo(bot.entity.position)
  if (d <= 6) return true
  try {
    return d <= 48 && bot.canSeeBlock(block)
  } catch {
    return false
  }
}

export function findVisible(bot: Bot, names: string[], maxDistance = 48, count = 64): any[] {
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined)
  if (!ids.length) return []
  // Fair mode discards hidden blocks, so over-fetch candidates before filtering.
  const found = bot.findBlocks({ matching: ids, maxDistance, count: Math.max(count * 4, 256) })
  const out = []
  for (const p of found) {
    const b = bot.blockAt(p)
    if (b && perceivable(bot, b)) out.push(b)
    if (out.length >= count) break
  }
  const me = bot.entity.position
  return out.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

/** `tracked`: resource blocks worth scanning for at long range (sought blocks, known resources, stations). */
export function perceive(bot: Bot, seek: string[] = [], tracked: string[] = []): Perception {
  const me = bot.entity.position
  const origin = me.floored()
  const blocks = new Map<string, BlockSeen>()
  const seen = new Set<string>()
  const add = (b: any) => {
    const key = `${b.position.x},${b.position.y},${b.position.z}`
    if (seen.has(key)) return
    seen.add(key)
    const d = b.position.distanceTo(me)
    const entry = blocks.get(b.name)
    if (!entry) blocks.set(b.name, { name: b.name, count: 1, distance: d, position: b.position })
    else {
      entry.count++
      if (d < entry.distance) (entry.distance = d), (entry.position = b.position)
    }
  }

  const hazards: string[] = []
  for (let dx = -8; dx <= 8; dx++)
    for (let dy = -5; dy <= 5; dy++)
      for (let dz = -8; dz <= 8; dz++) {
        const b = bot.blockAt(origin.offset(dx, dy, dz))
        if (!b) continue
        if (b.name === 'lava' && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= 4 && !hazards.includes('lava nearby')) hazards.push('lava nearby')
        if (IGNORE.has(b.name)) continue
        if (config.perception === 'fair' && !exposed(bot, b.position)) continue
        add(b)
      }

  const instances: Perception['instances'] = []
  const longRange = [...new Set(['crafting_table', 'furnace', ...seek, ...tracked])]
  for (const b of findVisible(bot, longRange, 48, 300)) {
    add(b)
    instances.push({ name: b.name, position: b.position, biome: b.biome?.name })
  }

  const entities: EntitySeen[] = []
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(me)
    if (d > 24) continue
    const name = e.name ?? 'unknown'
    if (name === 'item') {
      const item = (e as any).getDroppedItem?.()
      if (item) entities.push({ name: item.name, kind: 'item', distance: d, id: e.id })
    } else if (e.type === 'player') entities.push({ name: e.username ?? 'player', kind: 'player', distance: d, id: e.id })
    else if (HOSTILE.has(name) || e.type === 'hostile') entities.push({ name, kind: 'hostile', distance: d, id: e.id })
    else if (PASSIVE.has(name)) entities.push({ name, kind: 'animal', distance: d, id: e.id })
  }
  entities.sort((a, b) => a.distance - b.distance)
  if ((bot.entity as any).isInWater) hazards.push('in water')
  if (((bot.entity.metadata?.[0] as unknown as number) & 1) === 1) hazards.push('on fire')

  return { blocks, instances, entities, hazards, y: Math.floor(me.y) }
}
