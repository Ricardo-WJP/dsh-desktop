import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyOpenCodeGoCapabilities } from '../src/compatibility/opencode-go-catalog.js'
import { fetchOpenCodeGoCapabilities } from '../src/compatibility/opencode-go-capabilities.js'

const root = resolve(process.argv[2] ?? 'C:/Users/1/.dsh-desktop-runtime')
const output = resolve(process.argv[3] ?? 'output/go-reasoning-wire')
const activeText = await readFile(join(root, 'release-state', 'active.json'), 'utf8')
const active = JSON.parse(activeText)
assert.match(active.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const candidate = join(root, 'candidates', active.releaseId)
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'))
assert.match(manifest.dsh.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const piRoot = join(candidate, 'runtime', 'versions', manifest.dsh.version, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
const { getSupportedThinkingLevels } = await import(pathToFileURL(join(piRoot, 'models.js')).href)
const { streamSimple } = await import(pathToFileURL(join(piRoot, 'api', 'openai-completions.js')).href)
const capabilities = await fetchOpenCodeGoCapabilities()
const metadata = capabilities.find(model => model.id === 'deepseek-v4-flash-vision-exp')
assert.ok(metadata, 'Current Go capability feed must contain the model being verified')
const catalog = JSON.parse(await readFile(join(piRoot, 'providers', 'data', 'opencode-go.json'), 'utf8'))
const current = catalog['openai-completions'][metadata.id]
assert.ok(current)
const model = applyOpenCodeGoCapabilities(current, metadata)
assert.deepEqual(getSupportedThinkingLevels(model), ['off', 'low', 'high', 'max'])
const requests = []
for (const level of ['off', 'low', 'high', 'max']) {
  let captured
  const stream = streamSimple(model, {
    messages: [
      { role: 'user', content: 'Synthetic request serialization check.', timestamp: 0 },
      { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'thinking', thinking: 'Synthetic saved reasoning.', thinkingSignature: 'reasoning_content' }, { type: 'text', text: 'Synthetic answer.' }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 1 },
      { role: 'user', content: 'Synthetic follow-up.', timestamp: 2 },
    ],
  }, {
    apiKey: 'synthetic-local-verification-key',
    reasoning: level,
    maxTokens: 128,
    fetch: async (_url, init) => {
      captured = JSON.parse(init.body)
      // No network call is made. A deliberate error ends the native stream
      // after serialization; this is wire verification, not model inference.
      return new Response(JSON.stringify({ error: { message: 'synthetic-request-captured' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    },
  })
  await stream.result()
  assert.ok(captured, `Native transport did not serialize ${level}`)
  assert.equal(captured.thinking?.type, level === 'off' ? 'disabled' : 'enabled')
  assert.equal(captured.reasoning_effort, level === 'off' ? undefined : level)
  assert.equal(captured.messages.find(message => message.role === 'assistant')?.reasoning_content, 'Synthetic saved reasoning.')
  requests.push({ level, thinking: captured.thinking, reasoningEffort: captured.reasoning_effort ?? null, reasoningReplayPreserved: true })
}
assert.equal(await readFile(join(root, 'release-state', 'active.json'), 'utf8'), activeText)
const lunaMetadata = capabilities.find(entry => entry.id === 'gpt-5.6-luna')
assert.ok(lunaMetadata)
const luna = applyOpenCodeGoCapabilities(catalog['openai-responses'][lunaMetadata.id], lunaMetadata)
const { streamSimple: streamResponses } = await import(pathToFileURL(join(piRoot, 'api', 'openai-responses.js')).href)
const lunaRequests = []
for (const level of getSupportedThinkingLevels(luna)) {
  let body
  await streamResponses(luna, { messages: [{ role: 'user', content: 'Synthetic request only.', timestamp: 0 }] }, {
    apiKey: 'synthetic-local-verification-key', reasoning: level, maxTokens: 128,
    fetch: async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ error: { message: 'synthetic-request-captured' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    },
  }).result()
  assert.equal(body?.reasoning?.effort, level === 'off' ? 'none' : level)
  lunaRequests.push({ level, wireEffort: body.reasoning.effort })
}
const report = {
  checkedAt: new Date().toISOString(), activeRelease: active.releaseId,
  model: model.id, nativeLevels: getSupportedThinkingLevels(model),
  publicCapabilityRead: true, inferenceRequests: 0, modelExecutionVerified: false,
  transport: 'installed native pi-ai with injected local fetch', requests,
  luna: { model: luna.id, levels: getSupportedThinkingLevels(luna), requests: lunaRequests },
}
await mkdir(output, { recursive: true })
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
