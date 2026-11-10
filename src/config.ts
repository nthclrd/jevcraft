import { parseArgs } from 'node:util'
import { parseAddress } from './address.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    goal: { type: 'string', short: 'g' },
    host: { type: 'string' },
    port: { type: 'string' },
    user: { type: 'string', short: 'u' },
    version: { type: 'string' },
    xray: { type: 'boolean', default: false },
  },
})

const env = process.env
const number = (value: string | undefined, fallback: number) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

// MC_HOST may be `host`, `host:port` or `[ipv6]:port`; an explicit --port / MC_PORT wins over the address's port.
const address = parseAddress(values.host ?? env.MC_HOST ?? 'localhost')
const rawPort = values.port ?? env.MC_PORT ?? (address.port === undefined ? undefined : String(address.port))
const port = Number(rawPort ?? 25565)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid server port "${rawPort}"`)

export const config = {
  goal: values.goal ?? (positionals.join(' ') || env.GOAL || ''),
  host: address.host,
  port,
  username: values.user ?? env.MC_USER ?? 'Laya',
  auth: (env.MC_AUTH ?? 'offline') as 'offline' | 'microsoft',
  version: values.version ?? env.MC_VERSION ?? undefined,
  // Servers behind AuthMe and similar plugins: one chat command right after spawn fills the login.
  password: env.MC_PASSWORD ?? '',
  authCommand: env.MC_AUTH_COMMAND ?? '',
  register: ['1', 'true'].includes(env.MC_REGISTER ?? ''),
  // A remote server restarts and drops idle connections: keep trying unless explicitly disabled.
  reconnect: !['0', 'false'].includes(env.MC_RECONNECT ?? ''),
  reconnectDelayMs: Math.max(500, number(env.MC_RECONNECT_DELAY, 3) * 1000),

  // Fair perception only reports blocks the bot could plausibly see. --xray reads the raw chunk data.
  perception: (values.xray || env.PERCEPTION === 'xray' ? 'xray' : 'fair') as 'fair' | 'xray',

  // Laya is local and free: laya-serve exposes the Jev-compatible /v1/systemone protocol.
  laya: {
    url: env.LAYA_URL ?? 'http://127.0.0.1:8000',
    // 'auto' lets the server's router choose a checkpoint per request (english, multilingual, typed-decisions...).
    model: env.LAYA_MODEL ?? 'auto',
    // Only needed when laya-serve was started with LAYA_API_KEY, e.g. it serves another machine on the LAN.
    apiKey: env.LAYA_API_KEY ?? '',
    // Below this the decision still runs, but the strategist is asked for advice in the background.
    adviseBelow: number(env.LAYA_ADVISE_BELOW, 0.45),
    timeoutMs: number(env.LAYA_TIMEOUT_MS, 30_000),
  },

  llm: {
    // claude-cli | anthropic | openai. Auto: anthropic if ANTHROPIC_API_KEY, openai if OPENAI-compatible key, else claude-cli.
    provider: env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : env.LLM_API_KEY ? 'openai' : 'claude-cli'),
    model: env.LLM_MODEL ?? '',
    apiKey: env.LLM_API_KEY ?? env.ANTHROPIC_API_KEY ?? '',
    baseUrl: env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1',
  },

  limits: {
    failuresBeforeRecover: 3,
    stepsPerSubgoal: 30,
    lowConfidenceStreak: 3,
  },
}

export type Config = typeof config
