/**
 * Directional perception: what lies in each heading, summarised from loaded chunks the bot can observe.
 * EXPLORE options carry these summaries so Laya chooses a heading from evidence (trees, water, animals, open caves,
 * unexplored ground, sought blocks) instead of a fixed rule.
 */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Memory } from './memory.ts'
import type { Perception } from './perception.ts'

export const HEADINGS: Record<string, [number, number]> = {
  north: [0, -1], northeast: [0.71, -0.71], east: [1, 0], southeast: [0.71, 0.71],
  south: [0, 1], southwest: [-0.71, 0.71], west: [-1, 0], northwest: [-0.71, -0.71],
}

const OPEN = new Set(['air', 'cave_air'])

export function chunkKey(x: number, z: number) {
  return `${Math.floor(x / 16)},${Math.floor(z / 16)}`
}

function headingOf(dx: number, dz: number): string {
  const angle = Math.atan2(dz, dx) // east = 0, south = +90
  const names = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast']
  return names[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8]
}

export function describeHeadings(bot: Bot, perception: Perception, memory: Memory, seekBlocks: string[], seekMobs: string[], underground: boolean): Record<string, string> {
  const me = bot.entity.position.floored()
  const out: Record<string, string> = {}
  const seen: Record<string, string[]> = {}
  for (const b of perception.blocks.values()) {
    if (!seekBlocks.includes(b.name) || b.distance < 4) continue
    ;(seen[headingOf(b.position.x - me.x, b.position.z - me.z)] ??= []).push(b.name)
  }
  const creatures: Record<string, string[]> = {}
  for (const e of perception.entities) {
    if (e.kind === 'item' || e.kind === 'player') continue
    const ent = bot.entities[e.id]
    if (!ent) continue
    ;(creatures[headingOf(ent.position.x - me.x, ent.position.z - me.z)] ??= []).push(e.kind === 'hostile' ? `hostile ${e.name}` : e.name)
  }

  for (const [name, [dx, dz]] of Object.entries(HEADINGS)) {
    const parts: string[] = []
    let samples = 0
    let fresh = 0
    if (underground) {
      let open = 0
      let solid = 0
      let lava = 0
      for (let d = 4; d <= 28; d += 4) {
        for (const side of [-4, 0, 4]) {
          for (const h of [0, 1, 3]) {
            const p = me.offset(Math.round(dx * d - dz * side), h, Math.round(dz * d + dx * side))
            const b = bot.blockAt(p)
            if (!b) continue
            samples++
            if (OPEN.has(b.name)) open++
            else if (b.name === 'lava') lava++
            else solid++
          }
        }
      }
      if (!samples) out[name] = `${name}: unknown (not loaded)`
      else {
        const ratio = open / samples
        parts.push(ratio > 0.35 ? 'large open cave' : ratio > 0.12 ? 'some cave passages' : 'solid rock')
        if (lava) parts.push('LAVA present')
        void solid
      }
    } else {
      let water = 0
      let trees = 0
      let rise = 0
      const biomes: Record<string, number> = {}
      for (let d = 16; d <= 64; d += 12) {
        for (const side of [-12, 0, 12]) {
          const x = me.x + Math.round(dx * d - dz * side)
          const z = me.z + Math.round(dz * d + dx * side)
          const top = surfaceAt(bot, x, z, me.y)
          if (!top) continue
          samples++
          if (!memory.data.visited?.[chunkKey(x, z)]) fresh++
          if (top.name === 'water' || top.name === 'ice') water++
          if (top.name.endsWith('_leaves') || top.name.endsWith('_log')) trees++
          rise += top.position.y - me.y
          const biome = (top as any).biome?.name
          if (biome) biomes[biome] = (biomes[biome] ?? 0) + 1
        }
      }
      if (!samples) {
        out[name] = `${name}: beyond loaded terrain (unknown, unexplored)`
        continue
      }
      const topBiomes = Object.entries(biomes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([b]) => b.replace(/_/g, ' '))
      if (topBiomes.length) parts.push(topBiomes.join(' and '))
      parts.push(water / samples > 0.6 ? 'mostly water' : water / samples > 0.2 ? 'some water' : 'dry land')
      if (trees / samples > 0.3) parts.push('many trees')
      else if (trees > 0) parts.push('a few trees')
      else parts.push('no trees')
      const slope = rise / samples
      if (slope > 12) parts.push('steep climb')
      else if (slope < -12) parts.push('steep drop')
      parts.push(fresh / samples > 0.6 ? 'mostly unexplored' : fresh / samples > 0.2 ? 'partly explored' : 'already explored')
    }
    if (seen[name]?.length) parts.push(`sought blocks seen: ${summarize(seen[name])}`)
    if (creatures[name]?.length) parts.push(summarize(creatures[name]))
    out[name] = `${name}: ${parts.join(', ')}`
  }
  return out
}

function surfaceAt(bot: Bot, x: number, z: number, fromY: number) {
  for (let y = Math.min(fromY + 40, 319); y >= fromY - 40; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    if (OPEN.has(b.name) || (b.boundingBox === 'empty' && b.name !== 'water')) continue
    return b
  }
  return null
}

function summarize(names: string[]) {
  const counts: Record<string, number> = {}
  for (const n of names) counts[n] = (counts[n] ?? 0) + 1
  return Object.entries(counts).map(([n, c]) => (c > 1 ? `${c} ${n}` : n)).join(', ')
}
