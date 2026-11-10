import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

test('the client speaks laya /v1/systemone and reads its answers', async () => {
  const requests: { url?: string; auth?: string; body: any }[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', loaded: ['english'] }))
        return
      }
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'laya-rl-agent',
        answers: {
          // No `confidence` on purpose: older/strict checkpoints omit it and the client must still decide.
          skill: { type: 'choice', choice: 'MINE', probabilities: { MINE: 0.8, SHELTER: 0.2 } },
          danger: { type: 'score', score: 1.7, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.4 },
        },
        usage: { input_tokens: 123, output_tokens: 0 },
      }))
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  try {
    const port = (server.address() as { port: number }).port
    process.env.LAYA_URL = `http://127.0.0.1:${port}`
    process.env.LAYA_MODEL = 'auto'
    const { layaHealth, readChoice, systemOne } = await import('../src/brain/laya.ts')

    assert.deepEqual(await layaHealth(), { ok: true, models: ['english'] })

    const result = await systemOne({ goal: 'Find diamond' }, {
      skill: { type: 'choice', instructions: 'Which skill next?', criteria: { MINE: 'collect a visible block', SHELTER: 'dig in' } },
    })
    assert.equal(result.model, 'laya-rl-agent')
    assert.equal(result.inputTokens, 123)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/v1/systemone')
    assert.equal(requests[0].auth, undefined) // no LAYA_API_KEY, no bearer
    assert.equal(requests[0].body.model, undefined) // 'auto' is omitted so the router chooses
    assert.deepEqual(requests[0].body.state, { goal: 'Find diamond' })

    const choice = readChoice(result.answers.skill, ['MINE', 'SHELTER'])
    assert.equal(choice.choice, 'MINE')
    assert.equal(choice.confidence, 0.8)
    assert.equal(result.answers.danger.type, 'score')
    assert.equal(result.answers.danger.type === 'score' && result.answers.danger.score, 1.7)

    assert.throws(() => readChoice(result.answers.skill, ['SHELTER']), /invalid choice/)
  } finally {
    server.close()
  }
})
