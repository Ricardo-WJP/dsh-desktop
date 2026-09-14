/*
 * OpenCode Go model discovery.
 *
 * The Go roster is deliberately not embedded here. OpenCode publishes the
 * live availability list at /zen/go/v1/models and publishes the wire endpoint
 * for each model in the official Go documentation. The API is authoritative
 * for availability; the documentation is authoritative for protocol routing.
 * Unknown combinations are left out instead of being guessed into a model
 * request that would fail or send data to the wrong endpoint. The last
 * successfully written catalog in a candidate is the only offline cache; it
 * is never used to invent a new model after the live endpoint has changed.
 */

const PROVIDER = 'opencode-go'
const GO_BASE_URL = 'https://opencode.ai/zen/go'
const GO_V1_URL = `${GO_BASE_URL}/v1`
const API_NAMES = Object.freeze(['anthropic-messages', 'openai-completions', 'openai-responses'])
const OFFICIAL_GO_ENDPOINTS = Object.freeze({
  [`${GO_V1_URL}/messages`]: Object.freeze({ api: 'anthropic-messages', baseUrl: GO_BASE_URL }),
  [`${GO_V1_URL}/chat/completions`]: Object.freeze({ api: 'openai-completions', baseUrl: GO_V1_URL }),
  [`${GO_V1_URL}/responses`]: Object.freeze({ api: 'openai-responses', baseUrl: GO_V1_URL }),
})

export const OPEN_CODE_GO_MODEL_ENDPOINT = `${GO_V1_URL}/models`
export const OPEN_CODE_GO_DOCUMENTATION_ENDPOINT = 'https://opencode.ai/docs/go/'

const COMPLETIONS_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
})

const DEEPSEEK_COMPAT = Object.freeze({
  ...COMPLETIONS_COMPAT,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
})

const RESPONSES_COMPAT = Object.freeze({
  sessionAffinityFormat: 'openai-nosession',
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&#x2F;|&#47;/giu, '/')
    .replace(/\s+/gu, ' ')
    .trim()
}

function modelNameFromId(id) {
  return id
    .split('-')
    .filter(Boolean)
    .map(part => /^[0-9.]+$/u.test(part) ? part : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

/**
 * Parse the official endpoint table without embedding a model roster. The
 * page is a small static table today; a changed table simply causes the live
 * probe to keep the last known catalog rather than guessing a route.
 */
export function parseOpenCodeGoDocumentation(html) {
  if (typeof html !== 'string' || html.length === 0) return []
  const descriptors = new Map()
  const tables = html.match(/<table[\s\S]*?<\/table>/giu) ?? []
  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/giu) ?? []
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/giu)].map(match => decodeHtml(match[1]))
      if (cells.length < 4 || !cells[1] || !cells[2]) continue
      const endpoint = cells[2].replace(/^`|`$/gu, '').trim()
      const route = OFFICIAL_GO_ENDPOINTS[endpoint]
      const id = cells[1].trim()
      if (route === undefined || !/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) continue
      descriptors.set(id, {
        id,
        name: cells[0] || modelNameFromId(id),
        ...route,
      })
    }
  }
  return [...descriptors.values()]
}

function isValidGoDescriptor(entry) {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/iu.test(entry.id)) return false
  const expectedBaseUrl = entry.api === 'anthropic-messages'
    ? GO_BASE_URL
    : API_NAMES.includes(entry.api) ? GO_V1_URL : undefined
  return expectedBaseUrl !== undefined && entry.baseUrl === expectedBaseUrl
}

function existingModels(source) {
  let parsed
  try { parsed = JSON.parse(source) } catch { return new Map() }
  const models = new Map()
  if (!isRecord(parsed)) return models
  for (const group of Object.values(parsed)) {
    if (!isRecord(group)) continue
    for (const [id, model] of Object.entries(group)) if (isRecord(model)) models.set(id, model)
  }
  return models
}

function genericModel(id, api, name, baseUrl) {
  const completions = api === 'openai-completions'
  const responses = api === 'openai-responses'
  return {
    id,
    name: name || modelNameFromId(id),
    api,
    provider: PROVIDER,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: responses && /^grok-/iu.test(id) ? 500_000 : 262_144,
    maxTokens: responses && /^grok-/iu.test(id) ? 500_000 : 65_536,
    ...(completions ? { compat: COMPLETIONS_COMPAT } : {}),
    ...(responses ? { compat: RESPONSES_COMPAT } : {}),
  }
}

const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Apply provider-specific capabilities, never a roster or route from models.dev. */
export function applyOpenCodeGoCapabilities(model, capability) {
  if (!isRecord(capability) || capability.id !== model.id) return model
  const next = { ...model }
  const options = Array.isArray(capability.reasoning_options) ? capability.reasoning_options : []
  const efforts = options.filter(option => option?.type === 'effort' && Array.isArray(option.values))
    .flatMap(option => option.values)
    .filter(value => typeof value === 'string' && (THINKING_LEVELS.includes(value) || value === 'none'))
  if (capability.reasoning === false) {
    next.reasoning = false
    delete next.thinkingLevelMap
  } else if (capability.reasoning === true && efforts.some(value => !['off', 'none'].includes(value))) {
    // Absent pi-ai map keys enable its default levels. Explicit nulls are
    // essential: e.g. Kimi max-only must not acquire low/medium/high.
    const map = Object.fromEntries(THINKING_LEVELS.map(level => [level, null]))
    for (const value of efforts) map[value === 'none' ? 'off' : value] = value
    if (options.some(option => option?.type === 'toggle') && map.off === null) delete map.off
    next.reasoning = true
    next.thinkingLevelMap = map
    if (next.api === 'openai-completions') {
      next.compat = { ...next.compat, supportsReasoningEffort: true }
      if (capability.interleaved?.field === 'reasoning_content') {
        next.compat.requiresReasoningContentOnAssistantMessages = true
      }
      if (/^deepseek-/u.test(next.id)) next.compat = { ...next.compat, ...DEEPSEEK_COMPAT }
    } else if (next.api === 'anthropic-messages') {
      // Messages effort controls use output_config.effort, not an invented
      // numeric budget. The native pi-ai adaptive path preserves wire values.
      next.compat = { ...next.compat, forceAdaptiveThinking: true }
    }
  }
  // Toggle-only/budget-only models keep their native dispatch until that
  // control can be represented without inventing named effort levels.
  const inputs = capability.modalities?.input
  if (Array.isArray(inputs) && inputs.includes('text')) {
    next.input = inputs.filter(value => value === 'text' || value === 'image')
  }
  const context = capability.limit?.context
  const output = capability.limit?.output
  if (Number.isSafeInteger(context) && context > 0 && context <= 100_000_000) next.contextWindow = context
  if (Number.isSafeInteger(output) && output > 0 && output <= next.contextWindow) next.maxTokens = output
  return next
}

/**
 * Build a model catalog from the current official IDs and endpoint metadata.
 * Existing pi-ai metadata is retained where available, while endpoint data
 * always wins for API/base URL so a protocol move is applied immediately.
 */
export function buildDshOpenCodeGoCatalog({ source = '', availableIds = [], descriptors = [], capabilities = {} } = {}) {
  const existing = existingModels(source)
  const byId = new Map((Array.isArray(descriptors) ? descriptors : []).filter(isValidGoDescriptor).map(entry => [entry.id, entry]))
  const ids = [...new Set((Array.isArray(availableIds) ? availableIds : [...availableIds])
    .filter(id => typeof id === 'string' && id.trim() !== '')
    .map(id => id.trim()))]
    .sort((left, right) => left.localeCompare(right))
  const catalog = Object.fromEntries(API_NAMES.map(api => [api, {}]))
  const unknownModelIds = []
  for (const id of ids) {
    const descriptor = byId.get(id)
    if (descriptor === undefined) {
      unknownModelIds.push(id)
      continue
    }
    const { api } = descriptor
    const prior = existing.get(id)
    const priorApi = prior?.api
    const next = prior === undefined
      ? genericModel(id, api, descriptor.name, descriptor.baseUrl)
      : { ...prior }
    next.id = id
    next.name = descriptor?.name || prior?.name || modelNameFromId(id)
    next.api = api
    next.provider = PROVIDER
    next.baseUrl = descriptor.baseUrl
    if (priorApi !== undefined && priorApi !== api) delete next.compat
    if (!Number.isInteger(next.contextWindow) || next.contextWindow <= 0) next.contextWindow = 262_144
    if (!Number.isInteger(next.maxTokens) || next.maxTokens <= 0) next.maxTokens = 65_536
    if (!Array.isArray(next.input) || next.input.length === 0) next.input = ['text']
    if (next.cost === null || typeof next.cost !== 'object' || Array.isArray(next.cost)) next.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    if (api === 'openai-completions' && next.compat === undefined) next.compat = COMPLETIONS_COMPAT
    if (api === 'openai-responses' && next.compat === undefined) next.compat = RESPONSES_COMPAT
    catalog[api][id] = applyOpenCodeGoCapabilities(next, capabilities?.[id])
  }
  return {
    catalog,
    availableModelIds: ids,
    appliedModelIds: Object.values(catalog).flatMap(group => Object.keys(group)),
    unknownModelIds,
  }
}

export function catalogModelIds(catalog) {
  return Object.values(catalog ?? {}).flatMap(group => isRecord(group) ? Object.keys(group) : [])
}

/** Validate the generated catalog before it is written into a candidate. */
export function isDshOpenCodeGoCatalog(value) {
  if (!isRecord(value)) return false
  const groups = Object.entries(value)
  if (groups.length !== API_NAMES.length || groups.some(([api, group]) => !API_NAMES.includes(api) || !isRecord(group))) return false
  const ids = []
  for (const [api, group] of groups) {
    for (const [id, model] of Object.entries(group)) {
      if (!isRecord(model) || model.id !== id || model.provider !== PROVIDER || model.api !== api || typeof model.name !== 'string' || model.name.length === 0) return false
      if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isInteger(model.maxTokens) || model.maxTokens <= 0) return false
      const validBaseUrl = model.api === 'anthropic-messages'
        ? model.baseUrl === GO_BASE_URL
        : model.baseUrl === GO_V1_URL
      if (!validBaseUrl) return false
      ids.push(id)
    }
  }
  return ids.length > 0
}

function catalogJson(catalog) {
  return JSON.stringify(catalog)
}

export function patchDshOpenCodeGoModelCatalog(source, catalog) {
  if (typeof source !== 'string' || !isDshOpenCodeGoCatalog(catalog)) return { state: 'unrecognized', source }
  let current
  try { current = JSON.parse(source) } catch { return { state: 'unrecognized', source } }
  if (!isRecord(current) || catalogModelIds(current).length === 0) return { state: 'unrecognized', source }
  const expected = catalogJson(catalog)
  if (JSON.stringify(current) === expected) return { state: 'compatible', source }
  return { state: 'patched', source: `${expected}\n` }
}
