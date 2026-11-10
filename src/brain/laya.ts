/**
 * System One: Laya (https://github.com/NandhaKishorM/laya), a local, open-source, non-autoregressive decision engine.
 * `laya-serve` speaks the Jev-compatible POST /v1/systemone protocol, so one request evaluates every question against
 * one state in a single forward pass. It runs on your own hardware, needs no API key unless the server sets one, and
 * returns choice / score / noul answers with calibrated confidence.
 */
import { config } from '../config.ts'
import { usage } from '../usage.ts'

export type Criteria = Record<string, unknown>
export type Question =
  | { type: 'choice'; instructions: unknown; criteria: Criteria }
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'score'; instructions: unknown; criteria: unknown[] }

export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | NoulAnswer | { type: 'score'; score: number; confidence: number; probabilities?: Record<string, number> }

export interface SystemOneResult { model: string; answers: Record<string, Answer>; latencyMs: number; inputTokens: number }

function endpoint(path: string) {
  return `${config.laya.url.replace(/\/+$/, '')}${path}`
}

function headers() {
  const out: Record<string, string> = { 'content-type': 'application/json' }
  if (config.laya.apiKey) out.authorization = `Bearer ${config.laya.apiKey}`
  return out
}

export async function systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResult> {
  // Omit `model` entirely (the default) so the server's router picks a checkpoint for each request.
  const request: Record<string, unknown> = { state, questions }
  if (config.laya.model && config.laya.model !== 'auto') request.model = config.laya.model
  const started = performance.now()
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(endpoint('/v1/systemone'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(config.laya.timeoutMs),
      })
    } catch (e) {
      // The usual cause is a local server that is not running; say that instead of a bare fetch error.
      throw new Error(`cannot reach laya at ${config.laya.url} (${(e as Error).message}); start it with \`npm run laya\``)
    }
    // laya answers 503 while its single inference worker is saturated; back off and retry like the old Jev client.
    if ([429, 500, 502, 503, 529].includes(response.status) && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000
      await new Promise((r) => setTimeout(r, retryAfter || 400 * 2 ** attempt))
      continue
    }
    if (!response.ok) throw new Error(`laya HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const payload = (await response.json()) as { model: string; answers: Record<string, Answer>; usage?: { input_tokens: number } }
    usage.decisions++
    usage.decisionInputTokens += payload.usage?.input_tokens ?? 0
    return {
      model: payload.model,
      answers: payload.answers,
      latencyMs: Math.round(performance.now() - started),
      inputTokens: payload.usage?.input_tokens ?? 0,
    }
  }
}

export interface Health { ok: boolean; models: string[]; error?: string }

/** Liveness probe: report a missing local server before the bot joins, not on the first decision. */
export async function layaHealth(): Promise<Health> {
  try {
    const response = await fetch(endpoint('/health'), { headers: headers(), signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return { ok: false, models: [], error: `laya /health answered HTTP ${response.status}` }
    const payload = (await response.json()) as { loaded?: string[] }
    return { ok: true, models: payload.loaded ?? [] }
  } catch (e) {
    return { ok: false, models: [], error: `cannot reach laya at ${config.laya.url}: ${(e as Error).message}` }
  }
}

/** Reject answers that do not name one of the offered options; the executor never acts on an invented option. */
export function readChoice(answer: Answer | undefined, options: string[]): ChoiceAnswer {
  if (!answer || answer.type !== 'choice' || !options.includes(answer.choice)) {
    throw new Error(`laya returned an invalid choice: ${JSON.stringify(answer)?.slice(0, 200)}`)
  }
  const probabilities = answer.probabilities ?? {}
  // Some checkpoints omit `confidence`; fall back to the chosen label's probability rather than treating it as 0.
  return {
    ...answer,
    probabilities,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : probabilities[answer.choice] ?? 0,
  }
}
