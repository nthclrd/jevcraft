/**
 * One unattended trial on a fresh world: `npx tsx scripts/trial.ts <seed> [minutes] [goal]`.
 * Switches the local test server to world_<seed>, runs the bot with no help (no items, no time changes), and prints a
 * summary. Knowledge in memory/knowledge.json carries over between trials on purpose: that is the learning under test.
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [seed, minutesArg, ...goalWords] = process.argv.slice(2).filter((a) => a !== '--')
if (!seed) throw new Error('usage: trial.ts <seed> [minutes] [goal]')
const minutes = Number(minutesArg ?? 30)
const goal = goalWords.join(' ') || 'Find diamond'
const root = path.resolve(import.meta.dirname, '..')
const server = path.join(root, 'server')
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function serverPids(): number[] {
  return execSync('ps -axo pid=,command=').toString().split('\n')
    .filter((l) => l.includes('paper.jar') && l.includes('java'))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
}

/** Stop every local Paper process and wait until none is left (so the next world gets port 25565). */
async function stopServer() {
  for (const pid of serverPids()) try { process.kill(pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 30 && serverPids().length; i++) await wait(1000)
  for (const pid of serverPids()) try { process.kill(pid, 'SIGKILL') } catch {}
}

async function main() {
  await stopServer()
  const propsFile = path.join(server, 'server.properties')
  let props = fs.readFileSync(propsFile, 'utf8')
  props = props.replace(/^level-seed=.*$/m, `level-seed=${seed}`)
  props = /^level-name=/m.test(props) ? props.replace(/^level-name=.*$/m, `level-name=world_${seed}`) : props + `level-name=world_${seed}\n`
  fs.writeFileSync(propsFile, props)
  const serverLog = path.join(server, `server-${seed}.log`)
  const java = spawn('java', ['-Xms1G', '-Xmx3G', '-jar', 'paper.jar', '--nogui'], { cwd: server, stdio: ['ignore', fs.openSync(serverLog, 'w'), 'ignore'], detached: true })
  java.unref()
  while (!fs.existsSync(serverLog) || !fs.readFileSync(serverLog, 'utf8').includes('Done (')) await wait(1000)
  execSync(`npx tsx scripts/rcon.ts "difficulty easy"`, { cwd: root, stdio: 'ignore' })

  fs.mkdirSync(path.join(root, 'runs'), { recursive: true })
  const botLog = path.join(root, 'runs', `trial-${seed}.log`)
  const out = fs.openSync(botLog, 'w')
  const started = Date.now()
  const bot = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--goal', goal], { cwd: root, stdio: ['ignore', out, out] })
  let done = false
  bot.on('exit', () => (done = true))
  while (!done && Date.now() - started < minutes * 60_000) {
    await wait(5000)
    if (strip(fs.readFileSync(botLog, 'utf8')).includes('GOAL COMPLETE')) break
  }
  bot.kill('SIGTERM')
  await wait(3000)
  if (!done) bot.kill('SIGKILL')
  await stopServer()

  const log = strip(fs.readFileSync(botLog, 'utf8'))
  const lines = log.split('\n')
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length
  const elapsed = ((Date.now() - started) / 60_000).toFixed(1)
  console.log(`=== seed ${seed}: ${log.includes('GOAL COMPLETE') ? 'GOAL COMPLETE' : 'not completed'} in ${elapsed} min`)
  for (const l of lines) if (/GOAL COMPLETE|subgoal done|death cause|final:|timed out/.test(l)) console.log('  ' + l)
  console.log(`  decisions ${count(/\[laya\]/)}, skills ok ${count(/\[skill\] ok/)}, failed ${count(/\[skill\] FAIL/)}, deaths ${count(/DIED at/)}, llm calls ${count(/plan in|recovery in|facts in/)}`)
}

main().catch((e) => {
  console.error(e)
  stopServer().finally(() => process.exit(1))
})
