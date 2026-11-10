import mineflayer, { type Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import toolPkg from 'mineflayer-tool'
import { Agent } from './brain/agent.ts'
import { layaHealth } from './brain/laya.ts'
import { setBuiltCheck } from './brain/plan.ts'
import { protectSites } from './skills/index.ts'
import { progress } from './world/blueprint.ts'
import { createLLM } from './brain/llm.ts'
import { startReflexes } from './brain/reflex.ts'
import { Strategist } from './brain/strategist.ts'
import { config } from './config.ts'
import { log } from './log.ts'
import { usageSummary } from './usage.ts'
import { Acquirer } from './world/acquire.ts'
import { Crafting } from './world/crafting.ts'
import { initGameData } from './world/items.ts'
import { Knowledge } from './world/knowledge.ts'
import { Memory } from './world/memory.ts'
import { installStateIdFix } from './world/protocol-fixes.ts'

const { pathfinder, Movements } = pathfinderPkg as any
const { plugin: tool } = toolPkg as any

// The decision engine is local (or on the machine LAYA_URL names); fail early with an actionable message.
const health = await layaHealth()
if (!health.ok) {
  console.error(`${health.error}\nStart it in another terminal with \`npm run laya\` (needs Python 3.10+), or point LAYA_URL at a running laya-serve.`)
  process.exit(1)
}
log('laya', `decision engine at ${config.laya.url} (model ${config.laya.model}; loaded: ${health.models.join(', ') || 'none yet'})`)

let bot: Bot | null = null
let agent: Agent | null = null
let resumeGoal = config.goal
let shuttingDown = false
let attempts = 0
let retry: NodeJS.Timeout | undefined

function connect() {
  if (shuttingDown) return
  // Places are per world: the hashed seed from the login packet separates worlds that share a host and port.
  let worldId = 'unknown'
  const b = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    // We log 'error' ourselves; the default duplicates every failed reconnect with a full stack trace.
    logErrors: false,
    ...(config.version ? { version: config.version } : {}),
  })
  bot = b
  installStateIdFix(b)
  ;(b as any)._client.once('login', (packet: any) => {
    const seed = packet.worldState?.hashedSeed ?? packet.hashedSeed
    if (seed !== undefined) worldId = String(seed)
  })
  b.loadPlugin(pathfinder)
  b.loadPlugin(tool)

  b.once('spawn', () => void onSpawn(b, worldId).catch((e) => log('error', `spawn setup failed: ${(e as Error).message}`)))
  b.on('kicked', (reason) => log('error', `kicked: ${JSON.stringify(reason)}`))
  b.on('error', (err) => log('error', err.message))
  b.on('end', (reason) => {
    log('info', `disconnected from ${config.host}:${config.port}: ${reason}`)
    // Resume only work that was still running: a finished goal must not restart on reconnect.
    if (agent) resumeGoal = agent.active ? agent.goal : ''
    agent?.stop()
    agent = null
    bot = null
    if (shuttingDown || !config.reconnect) {
      process.exit(0)
    }
    const delay = Math.min(60_000, config.reconnectDelayMs * 2 ** attempts)
    attempts = Math.min(attempts + 1, 5)
    log('info', `reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts})`)
    retry = setTimeout(connect, delay)
  })
}

async function onSpawn(b: Bot, worldId: string) {
  attempts = 0
  const movements = new Movements(b)
  movements.canDig = true
  movements.allow1by1towers = true
  movements.allowParkour = true
  movements.allowSprinting = true
  movements.liquidCost = 6 // swim only when there is no dry route
  movements.maxDropDown = 3 // falls of 4+ blocks hurt
  movements.scafoldingBlocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']
    .map((n) => b.registry.itemsByName[n]?.id).filter((id) => id !== undefined)
  ;(b as any).safeMovements = movements
  ;(b as any).pathfinder.setMovements(movements)
  ;(b as any).pathfinder.thinkTimeout = 8000

  initGameData(b)
  const memory = new Memory(`${config.host}_${config.port}_${config.username}_${worldId}`)
  movements.canOpenDoors = true
  protectSites(movements, memory.data.sites)
  setBuiltCheck((name) => {
    const site = memory.data.sites[name]
    return site?.origin ? progress(b, site).remaining.length === 0 : false
  })
  const knowledge = new Knowledge(b)
  const crafting = new Crafting(b)
  const a = new Agent(b, new Strategist(createLLM(), b), crafting, memory, knowledge, new Acquirer(b, crafting, knowledge, memory))
  agent = a
  startReflexes(b, a)
  log('info', `spawned at ${b.entity.position.floored()} on ${b.version} at ${config.host}:${config.port}; perception=${config.perception}; auth=${config.auth}`)

  b.on('chat', (username, message) => {
    if (username === b.username) return
    // Free text from a player is an instruction; "!" commands stay as direct controls.
    if (!message.startsWith('!')) return void a.instruct(username, message)
    const [command, ...rest] = message.slice(1).split(' ')
    if (command === 'goal' && rest.length) void a.start(rest.join(' '))
    else if (command === 'stop') (a.stop(), b.chat('stopped'))
    else if (command === 'plan') a.planView().forEach((l) => b.chat(l))
    else if (command === 'status') b.chat(`${a.goal || 'idle'} | hp ${Math.round(b.health)} food ${b.food} y ${Math.floor(b.entity.position.y)}`)
    else if (command === 'usage') b.chat(usageSummary().slice(0, 250))
  })

  await authenticate(b)
  await b.waitForChunksToLoad()
  if (resumeGoal) void a.start(resumeGoal)
  else b.chat('Prêt. Dis-moi quoi faire dans le chat.')
}

/**
 * Servers with a login plugin (AuthMe and friends) freeze the player until `/login` or `/register` runs.
 * MC_PASSWORD covers the common case; MC_AUTH_COMMAND is the escape hatch and may use {username} and {password}.
 */
async function authenticate(b: Bot) {
  const template = config.authCommand || (config.password ? (config.register ? '/register {password} {password}' : '/login {password}') : '')
  if (!template) return
  if (template.includes('{password}') && !config.password) {
    log('error', 'MC_AUTH_COMMAND uses {password} but MC_PASSWORD is empty; not sending it')
    return
  }
  const command = template.replaceAll('{username}', config.username).replaceAll('{password}', config.password)
  await b.waitForTicks(20)
  b.chat(command)
  log('info', `sent server login command: ${config.password ? command.replaceAll(config.password, '***') : command}`)
  await b.waitForTicks(40)
}

const shutdown = () => {
  shuttingDown = true
  clearTimeout(retry)
  log('info', `usage: ${usageSummary()}`)
  if (bot?.entity) log('info', `final: y ${Math.floor(bot.entity.position.y)}, inventory ${JSON.stringify(Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count])))}`)
  bot?.quit()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

connect()
