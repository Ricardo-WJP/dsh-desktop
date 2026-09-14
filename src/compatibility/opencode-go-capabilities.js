export const OPEN_CODE_GO_CAPABILITIES_URL = 'https://models.dev/api.json'
export const OPEN_CODE_GO_PROVIDER_ID = 'opencode-go'
export const OPEN_CODE_GO_CAPABILITIES_TIMEOUT_MS = 8_000
export const OPEN_CODE_GO_CAPABILITIES_MAX_BYTES = 16 * 1024 * 1024

const MAX_TEXT_LENGTH = 512
const MAX_MODEL_ID_LENGTH = 256
const MAX_REASONING_OPTIONS = 8
const MAX_EFFORT_VALUES = 16
const MAX_BUDGET_TOKENS = 10_000_000
const MAX_LIST_VALUES = 16
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u
const SAFE_EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export class OpenCodeGoCapabilitiesError extends Error {
  constructor(status, message, { httpStatus, cause } = {}) {
    super(message)
    this.name = 'OpenCodeGoCapabilitiesError'
    this.status = status
    this.code = `OPENCODE_GO_CAPABILITIES_${status.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}`
    if (Number.isInteger(httpStatus)) this.httpStatus = httpStatus
    if (cause !== undefined) this.cause = cause
  }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value, key) {
  return Object.hasOwn(value, key)
}

function isSafeText(value, maximum = MAX_TEXT_LENGTH) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isSafeModelId(value) {
  return isSafeText(value, MAX_MODEL_ID_LENGTH)
}

function normalizeReasoningOptions(value) {
  if (!Array.isArray(value)) return undefined
  if (value.length === 0) return []
  const options = []
  let sawToggle = false
  let sawEffort = false
  let sawBudget = false

  for (const option of value.slice(0, MAX_REASONING_OPTIONS)) {
    if (!isRecord(option) || !hasOwn(option, 'type') || typeof option.type !== 'string') continue
    if (option.type === 'toggle') {
      if (sawToggle) continue
      sawToggle = true
      options.push({ type: 'toggle' })
      continue
    }
    if (option.type === 'effort') {
      if (sawEffort || !hasOwn(option, 'values') || !Array.isArray(option.values)) continue
      const efforts = []
      const seen = new Set()
      for (const effort of option.values.slice(0, MAX_EFFORT_VALUES)) {
        if (!SAFE_EFFORT_VALUES.has(effort) || seen.has(effort)) continue
        seen.add(effort)
        efforts.push(effort)
      }
      if (efforts.length === 0) continue
      sawEffort = true
      options.push({ type: 'effort', values: efforts })
      continue
    }
    if (option.type === 'budget_tokens') {
      if (sawBudget) continue
      sawBudget = true
      const normalized = { type: 'budget_tokens' }
      if (hasOwn(option, 'max') && Number.isSafeInteger(option.max) && option.max > 0 && option.max <= MAX_BUDGET_TOKENS) {
        normalized.max = option.max
      }
      options.push(normalized)
    }
  }

  return options.length > 0 ? options : undefined
}

function normalizeInterleaved(value) {
  if (!isRecord(value) || !hasOwn(value, 'field') || !SAFE_TOKEN.test(value.field ?? '')) return undefined
  return { field: value.field }
}

function normalizeModalities(value) {
  if (!isRecord(value)) return undefined
  const modalities = {}
  for (const key of ['input', 'output']) {
    if (!hasOwn(value, key) || !Array.isArray(value[key])) continue
    const values = []
    const seen = new Set()
    for (const modality of value[key].slice(0, MAX_LIST_VALUES)) {
      if (!SAFE_TOKEN.test(modality) || seen.has(modality)) continue
      seen.add(modality)
      values.push(modality)
    }
    if (values.length > 0 || value[key].length === 0) modalities[key] = values
  }
  return Object.keys(modalities).length > 0 ? modalities : undefined
}

function normalizeLimit(value) {
  if (!isRecord(value)) return undefined
  const limit = {}
  for (const key of ['context', 'input', 'output']) {
    if (hasOwn(value, key) && Number.isSafeInteger(value[key]) && value[key] >= 0) limit[key] = value[key]
  }
  return Object.keys(limit).length > 0 ? limit : undefined
}

function normalizeModel(modelKey, value) {
  if (!isSafeModelId(modelKey) || !isRecord(value) || !hasOwn(value, 'id') || value.id !== modelKey) return undefined

  const model = { id: modelKey }
  if (hasOwn(value, 'name') && isSafeText(value.name)) model.name = value.name
  if (hasOwn(value, 'reasoning') && typeof value.reasoning === 'boolean') model.reasoning = value.reasoning

  const reasoningOptions = normalizeReasoningOptions(hasOwn(value, 'reasoning_options') ? value.reasoning_options : undefined)
  if (reasoningOptions !== undefined) model.reasoning_options = reasoningOptions

  const interleaved = normalizeInterleaved(hasOwn(value, 'interleaved') ? value.interleaved : undefined)
  if (interleaved !== undefined) model.interleaved = interleaved

  const modalities = normalizeModalities(hasOwn(value, 'modalities') ? value.modalities : undefined)
  if (modalities !== undefined) model.modalities = modalities

  const limit = normalizeLimit(hasOwn(value, 'limit') ? value.limit : undefined)
  if (limit !== undefined) model.limit = limit

  if (hasOwn(value, 'last_updated') && typeof value.last_updated === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.last_updated)) {
    model.last_updated = value.last_updated
  }

  return model
}

function normalizeChunk(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return new TextEncoder().encode(value)
  throw new OpenCodeGoCapabilitiesError('invalid-response', 'OpenCode Go capabilities response returned an invalid stream chunk')
}

async function readBoundedText(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > OPEN_CODE_GO_CAPABILITIES_MAX_BYTES) {
    throw new OpenCodeGoCapabilitiesError('too-large', 'OpenCode Go capabilities response is too large')
  }

  if (typeof response.body?.getReader !== 'function') {
    throw new OpenCodeGoCapabilitiesError('invalid-response', 'OpenCode Go capabilities response has no readable body')
  }

  const reader = response.body.getReader()
  const chunks = []
  let byteCount = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = normalizeChunk(value)
      byteCount += chunk.byteLength
      if (byteCount > OPEN_CODE_GO_CAPABILITIES_MAX_BYTES) {
        throw new OpenCodeGoCapabilitiesError('too-large', 'OpenCode Go capabilities response is too large')
      }
      chunks.push(chunk)
    }
  } finally {
    void Promise.resolve(reader.cancel?.()).catch(() => {})
  }

  const bytes = new Uint8Array(byteCount)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parsePayload(payload) {
  if (!isRecord(payload)) {
    throw new OpenCodeGoCapabilitiesError('invalid-provider', 'models.dev returned no opencode-go provider record')
  }

  const provider = hasOwn(payload, OPEN_CODE_GO_PROVIDER_ID) ? payload[OPEN_CODE_GO_PROVIDER_ID] : undefined
  if (!isRecord(provider) || !hasOwn(provider, 'id') || provider.id !== OPEN_CODE_GO_PROVIDER_ID) {
    throw new OpenCodeGoCapabilitiesError('invalid-provider', 'models.dev returned an invalid opencode-go provider')
  }
  if (!hasOwn(provider, 'models') || !isRecord(provider.models)) {
    throw new OpenCodeGoCapabilitiesError('invalid-models', 'models.dev returned an invalid opencode-go models record')
  }

  const capabilities = []
  for (const [modelKey, value] of Object.entries(provider.models)) {
    const model = normalizeModel(modelKey, value)
    if (model !== undefined) capabilities.push(model)
  }
  return capabilities
}

function httpStatusOf(response) {
  const status = Number(response?.status)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

function isSuccessful(response, status) {
  return response?.ok === true || (status !== undefined && status >= 200 && status < 300)
}

function makeAbortError(status, cause) {
  return new OpenCodeGoCapabilitiesError(
    status,
    status === 'timeout'
      ? 'OpenCode Go capabilities request timed out after 8 seconds'
      : 'OpenCode Go capabilities request was aborted',
    { cause },
  )
}

/**
 * Fetch anonymous, provider-scoped models.dev capabilities for OpenCode Go.
 * The function has no cache or filesystem side effects. Network failures throw
 * OpenCodeGoCapabilitiesError with a stable status; callers can retain prior
 * catalog data when the request does not resolve with a successful array.
 */
export async function fetchOpenCodeGoCapabilities({ fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchOpenCodeGoCapabilities requires a fetch implementation')
  if (signal !== undefined && signal !== null && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError('fetchOpenCodeGoCapabilities requires an AbortSignal')
  }
  if (signal?.aborted) throw makeAbortError('aborted', signal.reason)

  const controller = new AbortController()
  let timedOut = false
  let externallyAborted = false
  let rejectExternalAbort
  const externalAbort = signal
    ? new Promise((_, reject) => { rejectExternalAbort = reject })
    : undefined
  const onExternalAbort = () => {
    if (externallyAborted) return
    externallyAborted = true
    controller.abort(signal.reason)
    rejectExternalAbort(makeAbortError('aborted', signal.reason))
  }
  signal?.addEventListener('abort', onExternalAbort, { once: true })

  let timeoutHandle
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      const error = makeAbortError('timeout')
      controller.abort(error)
      reject(error)
    }, OPEN_CODE_GO_CAPABILITIES_TIMEOUT_MS)
  })

  const operation = (async () => {
    let response
    try {
      response = await fetchImpl(OPEN_CODE_GO_CAPABILITIES_URL, {
        credentials: 'omit',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      throw error
    }

    const status = httpStatusOf(response)
    if (!isSuccessful(response, status)) {
      throw new OpenCodeGoCapabilitiesError(
        'http-error',
        `OpenCode Go capabilities request failed with HTTP ${status ?? 'unknown'}`,
        { httpStatus: status },
      )
    }

    let payload
    try {
      payload = JSON.parse(await readBoundedText(response))
    } catch (error) {
      if (error instanceof OpenCodeGoCapabilitiesError) throw error
      throw new OpenCodeGoCapabilitiesError('invalid-json', 'models.dev returned invalid JSON', { cause: error })
    }
    return parsePayload(payload)
  })()

  try {
    const pending = [operation, timeout]
    if (externalAbort !== undefined) pending.push(externalAbort)
    return await Promise.race(pending)
  } catch (error) {
    if (error instanceof OpenCodeGoCapabilitiesError) throw error
    if (timedOut) throw makeAbortError('timeout', error)
    if (externallyAborted || signal?.aborted) throw makeAbortError('aborted', error)
    throw new OpenCodeGoCapabilitiesError('network-error', 'OpenCode Go capabilities request failed', { cause: error })
  } finally {
    clearTimeout(timeoutHandle)
    signal?.removeEventListener?.('abort', onExternalAbort)
  }
}
