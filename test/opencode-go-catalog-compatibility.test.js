import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility,
} from '../src/desktop-runtime-controller.js'
import {
  OPEN_CODE_GO_DOCUMENTATION_ENDPOINT,
  OPEN_CODE_GO_MODEL_ENDPOINT,
  buildDshOpenCodeGoCatalog,
  catalogModelIds,
  isDshOpenCodeGoCatalog,
  parseOpenCodeGoDocumentation,
  patchDshOpenCodeGoModelCatalog,
} from '../src/compatibility/opencode-go-catalog.js'

const documentationFixture = `
  <table>
    <tr><th>Model</th><th>ID</th><th>Endpoint</th><th>SDK</th></tr>
    <tr><td>DeepSeek V4 Flash</td><td>deepseek-v4-flash</td><td><code>https://opencode.ai/zen/go/v1/chat/completions</code></td><td>@ai-sdk/anthropic</td></tr>
    <tr><td>Qwen3.8 Max</td><td>qwen3.8-max</td><td><code>https://opencode.ai/zen/go/v1/messages</code></td><td>openai-compatible</td></tr>
    <tr><td>Dynamic Responses</td><td>dynamic-responses</td><td><code>https://opencode.ai/zen/go/v1/responses</code></td><td>@ai-sdk/anthropic</td></tr>
    <tr><td>Wrong Host</td><td>wrong-host</td><td><code>https://evil.example/zen/go/v1/chat/completions</code></td><td>@ai-sdk/openai</td></tr>
    <tr><td>Wrong Path</td><td>wrong-path</td><td><code>https://opencode.ai/zen/go/v1/chat/completions/</code></td><td>@ai-sdk/openai</td></tr>
    <tr><td>Query Path</td><td>query-path</td><td><code>https://opencode.ai/zen/go/v1/responses?source=docs</code></td><td>@ai-sdk/openai</td></tr>
  </table>
`

function validModel(id, api, baseUrl) {
  return {
    id,
    name: id,
    api,
    provider: 'opencode-go',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  }
}

function makeCatalogSource() {
  return JSON.stringify({
    'anthropic-messages': {
      'deepseek-v4-flash': validModel('deepseek-v4-flash', 'anthropic-messages', 'https://opencode.ai/zen/go'),
    },
    'openai-completions': {},
    'openai-responses': {
      'retired-model': validModel('retired-model', 'openai-responses', 'https://opencode.ai/zen/go/v1'),
    },
  })
}

function responseJson(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
  }
}

test('live documentation parsing provides protocol metadata without a static roster', () => {
  const descriptors = parseOpenCodeGoDocumentation(documentationFixture)
  assert.deepEqual(descriptors, [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      api: 'openai-completions',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
    {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max',
      api: 'anthropic-messages',
      baseUrl: 'https://opencode.ai/zen/go',
    },
    {
      id: 'dynamic-responses',
      name: 'Dynamic Responses',
      api: 'openai-responses',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
  ])
  assert.equal(OPEN_CODE_GO_MODEL_ENDPOINT, 'https://opencode.ai/zen/go/v1/models')
  assert.equal(OPEN_CODE_GO_DOCUMENTATION_ENDPOINT, 'https://opencode.ai/docs/go/')
})

test('catalog builder follows live IDs and excludes unrouteable or guessed IDs', () => {
  const descriptors = parseOpenCodeGoDocumentation(documentationFixture)
  const built = buildDshOpenCodeGoCatalog({
    source: makeCatalogSource(),
    availableIds: ['deepseek-v4-flash', 'qwen3.8-max', 'dynamic-responses', 'deepseek-v4-pro'],
    descriptors,
  })

  assert.deepEqual(catalogModelIds(built.catalog).sort(), ['deepseek-v4-flash', 'dynamic-responses', 'qwen3.8-max'])
  assert.deepEqual(built.availableModelIds, ['deepseek-v4-flash', 'deepseek-v4-pro', 'dynamic-responses', 'qwen3.8-max'])
  assert.deepEqual(built.unknownModelIds, ['deepseek-v4-pro'])
  assert.equal(built.catalog['openai-completions']['deepseek-v4-flash'].baseUrl, 'https://opencode.ai/zen/go/v1')
  assert.equal(built.catalog['openai-completions']['deepseek-v4-flash'].api, 'openai-completions')
  assert.equal(built.catalog['anthropic-messages']['qwen3.8-max'].baseUrl, 'https://opencode.ai/zen/go')
  assert.equal(built.catalog['openai-responses']['dynamic-responses'].api, 'openai-responses')
  assert.equal(isDshOpenCodeGoCatalog(built.catalog), true)

  const unknown = buildDshOpenCodeGoCatalog({ availableIds: ['provider-x-model', 'deepseek-v4-pro'] })
  assert.deepEqual(catalogModelIds(unknown.catalog), [])
  assert.deepEqual(unknown.unknownModelIds, ['deepseek-v4-pro', 'provider-x-model'])
})

test('known metadata is retained while the current documented route wins', () => {
  const source = JSON.stringify({
    'anthropic-messages': {},
    'openai-completions': {
      'dynamic-responses': {
        id: 'dynamic-responses',
        name: 'old name',
        api: 'openai-completions',
        provider: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        reasoning: { efforts: ['low', 'high'] },
        input: ['text', 'image'],
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        contextWindow: 987654,
        maxTokens: 123456,
        compat: { supportsStore: false },
      },
    },
    'openai-responses': {},
  })
  const built = buildDshOpenCodeGoCatalog({
    source,
    availableIds: ['dynamic-responses'],
    descriptors: parseOpenCodeGoDocumentation(documentationFixture),
  })
  const model = built.catalog['openai-responses']['dynamic-responses']

  assert.equal(model.api, 'openai-responses')
  assert.equal(model.baseUrl, 'https://opencode.ai/zen/go/v1')
  assert.equal(model.name, 'Dynamic Responses')
  assert.deepEqual(model.reasoning, { efforts: ['low', 'high'] })
  assert.deepEqual(model.input, ['text', 'image'])
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  assert.equal(model.contextWindow, 987654)
  assert.equal(model.maxTokens, 123456)
  assert.deepEqual(model.compat, { sessionAffinityFormat: 'openai-nosession' })
})

test('empty documentation produces an empty catalog and unknown live IDs', () => {
  const built = buildDshOpenCodeGoCatalog({
    source: makeCatalogSource(),
    availableIds: ['deepseek-v4-flash', 'new-model'],
    descriptors: [],
  })

  assert.deepEqual(catalogModelIds(built.catalog), [])
  assert.deepEqual(built.unknownModelIds, ['deepseek-v4-flash', 'new-model'])
  assert.equal(isDshOpenCodeGoCatalog(built.catalog), false)
})

test('candidate compatibility writes the live catalog and is idempotent', async () => {
  const temporary = await mkdtemp('dsh-opencode-go-live-test-')
  try {
    const candidate = join(temporary, 'candidate')
    const profile = join(candidate, 'profile')
    const packageRoot = join(profile, 'node_modules', '@earendil-works', 'pi-ai')
    const dataRoot = join(packageRoot, 'dist', 'providers', 'data')
    const target = join(dataRoot, 'opencode-go.json')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(candidate, '.credentials.yaml'), 'refs:\n  OPENCODE_GO_API_KEY: test-key\n', 'utf8')
    await writeFile(join(packageRoot, 'package.json'), '{"version":"test"}\n', 'utf8')
    await writeFile(target, makeCatalogSource(), 'utf8')

    const fetchImpl = async url => {
      if (url === OPEN_CODE_GO_MODEL_ENDPOINT) {
        return responseJson(200, { data: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.8-max' }] })
      }
      if (url === OPEN_CODE_GO_DOCUMENTATION_ENDPOINT) return responseJson(200, documentationFixture)
      throw new Error(`unexpected URL: ${url}`)
    }

    const first = await ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility(candidate, profile, { fetchImpl })
    const written = JSON.parse(await readFile(target, 'utf8'))
    const second = await ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility(candidate, profile, { fetchImpl, write: false })

    assert.equal(first.state, 'patched')
    assert.equal(first.liveSync.status, 'live')
    assert.equal(first.liveSync.liveModelCount, 2)
    assert.equal(first.liveSync.appliedModelCount, 2)
    assert.equal(first.targets[0].state, 'patched')
    assert.deepEqual(catalogModelIds(written).sort(), ['deepseek-v4-flash', 'qwen3.8-max'])
    assert.equal(second.state, 'compatible')
    assert.equal(second.targets[0].state, 'compatible')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('live API failure keeps the existing last-known-good catalog', async () => {
  const temporary = await mkdtemp('dsh-opencode-go-stale-test-')
  try {
    const candidate = join(temporary, 'candidate')
    const profile = join(candidate, 'profile')
    const packageRoot = join(profile, 'node_modules', '@earendil-works', 'pi-ai')
    const dataRoot = join(packageRoot, 'dist', 'providers', 'data')
    const target = join(dataRoot, 'opencode-go.json')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(candidate, '.credentials.yaml'), 'refs:\n  OPENCODE_GO_API_KEY: test-key\n', 'utf8')
    await writeFile(join(packageRoot, 'package.json'), '{"version":"test"}\n', 'utf8')
    const source = `${makeCatalogSource()}\n`
    await writeFile(target, source, 'utf8')

    const result = await ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility(candidate, profile, {
      fetchImpl: async () => responseJson(503, { error: 'temporarily unavailable' }),
    })

    assert.equal(result.state, 'compatible')
    assert.equal(result.liveSync.status, 'http-error')
    assert.equal(result.targets[0].state, 'stale-cache')
    assert.equal(await readFile(target, 'utf8'), source)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('missing documentation keeps the existing catalog as stale cache', async () => {
  const temporary = await mkdtemp('dsh-opencode-go-missing-docs-test-')
  try {
    const candidate = join(temporary, 'candidate')
    const profile = join(candidate, 'profile')
    const packageRoot = join(profile, 'node_modules', '@earendil-works', 'pi-ai')
    const dataRoot = join(packageRoot, 'dist', 'providers', 'data')
    const target = join(dataRoot, 'opencode-go.json')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(candidate, '.credentials.yaml'), 'refs:\n  OPENCODE_GO_API_KEY: test-key\n', 'utf8')
    await writeFile(join(packageRoot, 'package.json'), '{"version":"test"}\n', 'utf8')
    const source = `${makeCatalogSource()}\n`
    await writeFile(target, source, 'utf8')

    const result = await ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility(candidate, profile, {
      fetchImpl: async url => url === OPEN_CODE_GO_MODEL_ENDPOINT
        ? responseJson(200, { data: [{ id: 'deepseek-v4-flash' }, { id: 'new-model' }] })
        : responseJson(503, { error: 'documentation unavailable' }),
    })

    assert.equal(result.state, 'compatible')
    assert.equal(result.liveSync.status, 'live-empty')
    assert.equal(result.liveSync.liveModelCount, 2)
    assert.equal(result.liveSync.appliedModelCount, 0)
    assert.equal(result.liveSync.documentationStatus, 'http-503')
    assert.deepEqual(result.liveSync.unknownModelIds, ['deepseek-v4-flash', 'new-model'])
    assert.equal(result.targets[0].state, 'stale-cache')
    assert.equal(await readFile(target, 'utf8'), source)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('catalog patch requires a validated generated catalog', () => {
  const result = patchDshOpenCodeGoModelCatalog('{not-json', undefined)
  assert.equal(result.state, 'unrecognized')
})
