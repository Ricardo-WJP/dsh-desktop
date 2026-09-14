import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = 'C:/Users/1/.dsh-desktop-runtime'
const active = JSON.parse(await readFile(join(root, 'release-state/active.json'), 'utf8'))
const candidate = join(root, 'candidates', active.releaseId)
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'))
const modules = join(candidate, 'runtime/versions', manifest.dsh.version, 'node_modules')
const { PiAiAdapter } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js')))
const catalog = JSON.parse(await readFile(join(modules, '@earendil-works/pi-ai/dist/providers/data/opencode-go.json'), 'utf8'))
const results = []
for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
  const model = Object.values(catalog[api])[0]
  assert.ok(model)
  const { streamSimple } = await import(pathToFileURL(join(modules, '@earendil-works/pi-ai/dist/api', `${api}.js`)))
  for (const sessionId of ['verification-parent', 'verification-parent', 'verification-child', undefined]) {
    let captured
    const adapter = new PiAiAdapter({ resolveApiKey: async () => 'synthetic-only' })
    const snapshot = {
      profiles: new Map([['opencode-go', { headers: { 'X-DeepSeek-Harness-Session-ID': 'stale-config' }, streamIdleTimeoutMs: 10000 }]]),
      models: { getModel: () => model, streamSimple: (m, c, o) => streamSimple(m, c, { ...o, fetch: async (_url, init) => {
        captured = new Headers(init.headers)
        return new Response(JSON.stringify({ error: { message: 'synthetic-capture' } }), { status: 400 })
      } }) },
    }
    try { for await (const _ of adapter.streamWithSnapshot({ provider: 'opencode-go', model: model.id, sessionId, messages: [], maxTokens: 16 }, snapshot)) {} } catch {}
    assert.ok(captured, `No wire capture for ${api}`)
    assert.equal(captured.get('x-deepseek-harness-session-id'), sessionId ?? 'stale-config')
    assert.match(captured.get('user-agent'), /harness/i)
    results.push({ api, sessionId: sessionId ?? null, passed: true })
  }
}
console.log(JSON.stringify({ installedAdapterWireVerified: true, inferenceRequests: 0, results }))
if (process.argv.includes('--live')) {
  const { default: YAML } = await import('yaml')
  const key = YAML.parse(await readFile(join(root, 'user-data/.credentials.yaml'), 'utf8')).refs.OPENCODE_GO_API_KEY
  assert.equal(typeof key, 'string')
  const model = catalog['openai-completions']['glm-5.3-flash']
  assert.ok(model)
  const { streamSimple } = await import(pathToFileURL(join(modules, '@earendil-works/pi-ai/dist/api/openai-completions.js')))
  let status, hasSession = false, chunks = 0
  const adapter = new PiAiAdapter({ resolveApiKey: async () => key })
  const snapshot = {
    profiles: new Map([['opencode-go', { streamIdleTimeoutMs: 45000 }]]),
    models: { getModel: () => model, streamSimple: (m, c, o) => streamSimple(m, { ...c, messages: [{ role: 'user', content: 'Validate the DSH Desktop coding-agent provider connection. Reply only OK. No tools needed.', timestamp: Date.now() }] }, { ...o, fetch: async (url, init) => {
      assert.equal(new URL(url).hostname, 'opencode.ai')
      hasSession = new Headers(init.headers).has('x-deepseek-harness-session-id')
      const response = await fetch(url, init)
      status = response.status
      return response
    } }) },
  }
  try {
    for await (const _ of adapter.streamWithSnapshot({ provider: 'opencode-go', model: model.id, sessionId: 'dsh-desktop-connection-check-20260908', messages: [], maxTokens: 128, signal: AbortSignal.timeout(60000) }, snapshot)) chunks++
    assert.equal(status, 200)
    assert.ok(hasSession && chunks > 0)
    console.log(JSON.stringify({ liveInferencePassed: true, status, hasSession, chunks, model: model.id }))
  } catch (error) {
    console.log(JSON.stringify({ liveInferencePassed: false, status, hasSession, code: error.code ?? error.name }))
    process.exitCode = 1
  }
}
