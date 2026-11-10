import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve('runs')
fs.mkdirSync(dir, { recursive: true })
const trace = fs.createWriteStream(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`))

const colors: Record<string, string> = {
  laya: '\x1b[35m', llm: '\x1b[36m', skill: '\x1b[33m', reflex: '\x1b[31m', plan: '\x1b[32m', info: '\x1b[90m', error: '\x1b[91m',
}

export function log(channel: keyof typeof colors | string, message: string, data?: unknown) {
  const time = new Date().toISOString().slice(11, 19)
  console.log(`${colors[channel] ?? ''}${time} [${channel}]\x1b[0m ${message}`)
  trace.write(JSON.stringify({ t: Date.now(), channel, message, data }) + '\n')
}
