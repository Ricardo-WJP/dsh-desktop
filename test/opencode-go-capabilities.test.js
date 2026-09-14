import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchOpenCodeGoCapabilities,
  OPEN_CODE_GO_CAPABILITIES_MAX_BYTES,
  OPEN_CODE_GO_CAPABILITIES_URL,
} from '../src/compatibility/opencode-go-capabilities.js'

function streamResponse(body, { status = 200, headers = {} } = {}) {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function validPayload(overrides = {}) {
  return {
    'other-provider': {
      id: 'other-provider',
      models: { 'other-model': { id: 'other-model', name: 'Should not leak' } },
    },
    'opencode-go': {
      id: 'opencode-go',
      api: 'https://evil.example/api',
      headers: { authorization: 'Bearer should-never-be-read' },
      url: 'https://evil.example/models',
      models: {
        'exact-model-1': {
          id: 'exact-model-1',
          name: 'Exact Model',
          reasoning: true,
          reasoning_options: [
            { type: 'toggle', enabled: 'malicious' },
            { type: 'effort', values: ['low', 'HIGH', 'max', 'javascript:bad'] },
            { type: 'budget_tokens', max: 262144, endpoint: 'https://evil.example' },
            { type: 'budget_tokens', max: Number.MAX_SAFE_INTEGER },
          ],
          interleaved: { field: 'reasoning_content', endpoint: 'https://evil.example' },
          modalities: { input: ['text', 'image'], output: ['text'], endpoint: 'evil' },
          limit: { context: 1000000, output: 131072, endpoint: 1 },
          last_updated: '2026-08-21',
          family: 'should-not-leak',
          provider: 'evil-provider',
          cost: { input: 0 },
          endpoint: 'https://evil.example',
        },
        'malformed-row': 'ignore this row',
        'mismatched-id': { id: 'another-model', name: 'ignore this row' },
      },
      ...overrides,
    },
  }
}

test('fetches only opencode-go models anonymously and strips malicious fields', async () => {
  let requestedUrl
  let requestedOptions
  const result = await fetchOpenCodeGoCapabilities({
    fetchImpl: async (url, options) => {
      requestedUrl = url
      requestedOptions = options
      return streamResponse(validPayload())
    },
  })

  assert.equal(requestedUrl, OPEN_CODE_GO_CAPABILITIES_URL)
  assert.equal(requestedOptions.redirect, 'error')
  assert.equal(requestedOptions.credentials, 'omit')
  assert.deepEqual(Object.keys(requestedOptions.headers), ['accept'])
  assert.equal(Object.hasOwn(requestedOptions.headers, 'authorization'), false)
  assert.equal(requestedOptions.signal instanceof AbortSignal, true)
  assert.deepEqual(result, [{
    id: 'exact-model-1',
    name: 'Exact Model',
    reasoning: true,
    reasoning_options: [
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'max'] },
      { type: 'budget_tokens', max: 262144 },
    ],
    interleaved: { field: 'reasoning_content' },
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 131072 },
    last_updated: '2026-08-21',
  }])
  assert.equal(Object.hasOwn(result[0], 'endpoint'), false)
  assert.equal(Object.hasOwn(result[0], 'family'), false)
  assert.equal(Object.hasOwn(result[0], 'provider'), false)
})

test('counts streamed bytes even when content-length is small', async () => {
  let cancelled = false
  let reads = 0
  const stream = new ReadableStream({
    pull(controller) {
      reads += 1
      controller.enqueue(new Uint8Array(reads === 1 ? OPEN_CODE_GO_CAPABILITIES_MAX_BYTES : 1))
    },
    cancel() {
      cancelled = true
    },
  })

  await assert.rejects(
    fetchOpenCodeGoCapabilities({
      fetchImpl: async () => new Response(stream, { status: 200, headers: { 'content-length': '1' } }),
    }),
    error => error.status === 'too-large' && error.code === 'OPENCODE_GO_CAPABILITIES_TOO_LARGE',
  )
  assert.ok(reads >= 2)
  assert.equal(cancelled, true)
})

test('requests redirect:error and reports a redirect response without using its location', async () => {
  let requestedOptions
  await assert.rejects(
    fetchOpenCodeGoCapabilities({
      fetchImpl: async (_url, options) => {
        requestedOptions = options
        return new Response('', { status: 302, headers: { location: 'https://evil.example/redirect' } })
      },
    }),
    error => error.status === 'http-error' && error.httpStatus === 302,
  )
  assert.equal(requestedOptions.redirect, 'error')
})

test('normalizes caller aborts and forwards the combined abort signal', async () => {
  const abortController = new AbortController()
  let observedSignal
  const pending = fetchOpenCodeGoCapabilities({
    signal: abortController.signal,
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    },
  })
  abortController.abort(new Error('caller stopped'))

  await assert.rejects(pending, error => error.status === 'aborted' && error.code === 'OPENCODE_GO_CAPABILITIES_ABORTED')
  assert.equal(observedSignal.aborted, true)
})

test('rejects a wrong or misplaced provider instead of merging another provider', async () => {
  await assert.rejects(
    fetchOpenCodeGoCapabilities({
      fetchImpl: async () => streamResponse({
        'opencode-go': { id: 'not-opencode-go', models: { 'evil-model': { id: 'evil-model' } } },
        nested: { id: 'opencode-go', models: { 'should-not-be-read': { id: 'should-not-be-read' } } },
      }),
    }),
    error => error.status === 'invalid-provider',
  )
})
