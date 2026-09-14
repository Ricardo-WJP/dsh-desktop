import { fileURLToPath } from 'node:url'
import channelNames from './channels.cjs'
import { parseMarketSource } from '../profile/market-source.js'

/**
 * Canonical desktop IPC names and argument validators.
 *
 * This main-process contract shares the pure source parser with installation;
 * preload exposes only the methods backed by these
 * channels, and the main process validates every invocation again.
 */
export const IPC_CHANNELS = channelNames

function collectIpcChannels(value, result = []) {
  for (const child of Object.values(value)) {
    if (typeof child === 'string') result.push(child)
    else if (child !== null && typeof child === 'object') collectIpcChannels(child, result)
  }
  return result
}

export const IPC_CHANNEL_VALUES = Object.freeze(collectIpcChannels(IPC_CHANNELS))

// `status.changed` is emitted by the main process; every other channel is an
// inbound registration that must be wired exactly once during startup.
export const IPC_EVENT_CHANNEL_VALUES = Object.freeze([IPC_CHANNELS.status.changed, IPC_CHANNELS.updates.changed])
export const IPC_REGISTRATION_CHANNEL_VALUES = Object.freeze(
  IPC_CHANNEL_VALUES.filter(channel => !IPC_EVENT_CHANNEL_VALUES.includes(channel)),
)
const IPC_CHANNEL_SET = new Set(IPC_CHANNEL_VALUES)

export function assertIpcChannel(channel) {
  if (typeof channel !== 'string' || !IPC_CHANNEL_SET.has(channel)) throw new TypeError(`Unknown IPC channel: ${String(channel)}`)
  return channel
}

export const MANAGEMENT_ROUTES = Object.freeze([
  'loading',
  'overview',
  'mode',
  'plugins',
  'update',
  'recovery',
  'diagnostics',
  'error',
])

// The bootstrap/legacy owner remains the only active mode until a stable or
// dev mode has a paired immutable runtime and profile slot. Requests can only
// target the future switchable modes; `legacy` is status-only.
export const ACTIVE_MODES = Object.freeze(['legacy', 'stable', 'dev'])
export const SWITCHABLE_MODES = Object.freeze(['stable', 'dev'])

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const SAFE_SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const SHELL_META_PATTERN = /[;&|<>`$\r\n]/u
const PLUGIN_TRANSACTION_ACTION_PATTERN = /^(?:install|update|setEnabled|replaceSource|reorder|configure|promoteLocal|remove)$/
const NPM_SELECTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9][a-z0-9._-]{0,99}$/i
const GITHUB_REF_PATTERN = /^(?:[a-f0-9]{40}|[a-z0-9][a-z0-9._\/-]{0,127})$/i
const GITHUB_PATH_PATTERN = /^\/[a-z0-9][a-z0-9._\/-]{0,255}$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const CONFIRMATION_TOKEN_PATTERN = /^remove:[a-f0-9]{64}$/i

function boundedString(value, name, { min = 1, max = 300, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${name}`)
  }
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new TypeError(`Invalid ${name}`)
  if (pattern !== undefined && !pattern.test(normalized)) throw new TypeError(`Invalid ${name}`)
  return normalized
}

export function validatePluginSpec(value) {
  const spec = boundedString(value, 'plugin spec', { max: 300 })
  if (spec.startsWith('-') || spec.includes('&&') || spec.includes(';') || spec.includes('|') || spec.includes('`')) {
    throw new TypeError('Invalid plugin spec')
  }
  return spec
}

export function validatePluginName(value) {
  return boundedString(value, 'plugin name', { max: 214, pattern: PACKAGE_NAME_PATTERN })
}

export function validateBuildScripts(value) {
  if (typeof value !== 'boolean') throw new TypeError('Invalid build-script permission')
  return value
}

function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${name}`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Invalid ${name}`)
  return value
}

function validateSafeText(value, name, max = 4096) {
  const normalized = boundedString(value, name, { max })
  if (SHELL_META_PATTERN.test(normalized)) throw new TypeError(`Invalid ${name}`)
  return normalized
}

export function validatePluginSource(value) {
  assertPlainObject(value, 'plugin source')
  const type = boundedString(value.type, 'plugin source type', { max: 16, pattern: /^(?:npm|github|local-dev)$/ })
  const fields = {
    npm: new Set(['type', 'package', 'versionOrTag']),
    github: new Set(['type', 'repository', 'ref', 'path']),
    'local-dev': new Set(['type', 'path']),
  }[type]
  for (const field of Object.keys(value)) if (!fields.has(field)) throw new TypeError(`Unknown ${type} source field: ${field}`)
  if (type === 'npm') {
    const packageName = validatePluginName(value.package)
    const versionOrTag = value.versionOrTag === undefined ? undefined : boundedString(value.versionOrTag, 'npm version or tag', { max: 128, pattern: NPM_SELECTOR_PATTERN })
    return { type, package: packageName, ...(versionOrTag === undefined ? {} : { versionOrTag }) }
  }
  if (type === 'github') {
    const repository = boundedString(value.repository, 'GitHub repository', { max: 160, pattern: GITHUB_REPOSITORY_PATTERN })
    const ref = value.ref === undefined ? undefined : boundedString(value.ref, 'GitHub ref', { max: 128, pattern: GITHUB_REF_PATTERN })
    const path = value.path === undefined ? undefined : boundedString(value.path, 'GitHub package path', { max: 256, pattern: GITHUB_PATH_PATTERN })
    if (ref?.includes('..') || ref?.includes('//') || path?.includes('..') || path?.includes('//')) throw new TypeError('Invalid GitHub source path')
    return { type, repository, ...(ref === undefined ? {} : { ref }), ...(path === undefined ? {} : { path }) }
  }
  return { type, path: validateSafeText(value.path, 'local-dev path', 4096) }
}

function validateStructuredConfig(value, depth = 0) {
  if (depth > 8) throw new TypeError('Plugin config is too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 4096) throw new TypeError('Plugin config string is too long')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Plugin config contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new TypeError('Plugin config array is too large')
    return value.map(entry => validateStructuredConfig(entry, depth + 1))
  }
  assertPlainObject(value, 'plugin config')
  const entries = Object.entries(value)
  if (entries.length > 128) throw new TypeError('Plugin config object is too large')
  return Object.fromEntries(entries.map(([key, entry]) => {
    if (key.length === 0 || key.length > 256 || CONTROL_CHARACTER_PATTERN.test(key)) throw new TypeError('Invalid plugin config key')
    return [key, validateStructuredConfig(entry, depth + 1)]
  }))
}

function validatePluginNameList(value, label) {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError(`Invalid ${label}`)
  const names = value.map(name => validatePluginName(name))
  if (new Set(names).size !== names.length) throw new TypeError(`${label} must not contain duplicates`)
  return names
}

function validateBuildPermissionsMap(value) {
  assertPlainObject(value, 'buildPermissions')
  const result = {}
  for (const [name, allowed] of Object.entries(value)) {
    result[validatePluginName(name)] = validateBuildScripts(allowed)
  }
  return result
}

export function validatePluginTransactionRequest(value) {
  assertPlainObject(value, 'plugin transaction request')
  const allowed = new Set(['action', 'name', 'packageName', 'source', 'buildPermissions', 'enabled', 'order', 'bundles', 'config', 'previewDigest', 'confirmationToken'])
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new TypeError(`Unknown plugin transaction field: ${field}`)
  const action = boundedString(value.action, 'plugin transaction action', { max: 32, pattern: PLUGIN_TRANSACTION_ACTION_PATTERN })
  const request = { action }
  if (value.name !== undefined) request.name = validatePluginName(value.name)
  if (value.packageName !== undefined) request.packageName = validatePluginName(value.packageName)
  if (value.source !== undefined) request.source = validatePluginSource(value.source)
  if (value.buildPermissions !== undefined) request.buildPermissions = validateBuildPermissionsMap(value.buildPermissions)
  if (value.enabled !== undefined) request.enabled = validateEnabled(value.enabled)
  if (value.order !== undefined) request.order = validatePluginNameList(value.order, 'plugin order')
  if (value.bundles !== undefined) request.bundles = validatePluginNameList(value.bundles, 'plugin bundles')
  if (value.config !== undefined) request.config = validateStructuredConfig(value.config)
  if (value.previewDigest !== undefined) request.previewDigest = boundedString(value.previewDigest, 'removal preview digest', { max: 64, pattern: SHA256_PATTERN })
  if (value.confirmationToken !== undefined) request.confirmationToken = boundedString(value.confirmationToken, 'removal confirmation token', { max: 72, pattern: CONFIRMATION_TOKEN_PATTERN })
  return request
}

export const validatePluginTransaction = validatePluginTransactionRequest

function validateMarketPluginUpdate(value) {
  assertPlainObject(value, 'market plugin update')
  const allowed = new Set(['name', 'kind', 'target'])
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new TypeError(`Unknown market plugin update field: ${field}`)
  const kind = boundedString(value.kind, 'market plugin update kind', { max: 8, pattern: /^(?:npm|github)$/ })
  const target = kind === 'github'
    ? boundedString(value.target, 'market GitHub commit', { max: 40, pattern: /^[a-f0-9]{40}$/i })
    : boundedString(value.target, 'market npm version', { max: 128, pattern: NPM_SELECTOR_PATTERN })
  return { name: validatePluginName(value.name), kind, target }
}

export function validateMarketPluginUpdateRequest(value) {
  assertPlainObject(value, 'market plugin update request')
  if (Object.hasOwn(value, 'updates')) {
    if (Object.keys(value).some(field => field !== 'updates')) throw new TypeError('Unknown market plugin batch update field')
    if (!Array.isArray(value.updates) || value.updates.length < 2 || value.updates.length > 256) {
      throw new TypeError('Market plugin batch update requires two to 256 entries')
    }
    const updates = value.updates.map(validateMarketPluginUpdate)
    const names = updates.map(update => update.name)
    if (new Set(names).size !== names.length) throw new TypeError('Market plugin batch update must not contain duplicates')
    return { updates }
  }
  return validateMarketPluginUpdate(value)
}

export function validateMarketPluginInstallRequest(value) {
  assertPlainObject(value, 'market plugin install request')
  if (Object.keys(value).some(field => field !== 'url')) throw new TypeError('Unknown market plugin install field')
  const raw = boundedString(value.url, 'market plugin source address', { max: 500 })
  parseMarketSource(raw)
  return { url: raw.trim().replace(/\/$/u, '') }
}

export function validatePluginRemovePreview(value) {
  assertPlainObject(value, 'plugin removal preview request')
  if (Object.keys(value).some(field => field !== 'name')) throw new TypeError('Unknown plugin removal preview field')
  return { name: validatePluginName(value.name) }
}

export function validatePluginRemoveConfirmation(value) {
  assertPlainObject(value, 'plugin removal confirmation request')
  const allowed = new Set(['name', 'previewDigest', 'confirmationToken'])
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new TypeError(`Unknown plugin removal confirmation field: ${field}`)
  return {
    name: validatePluginName(value.name),
    previewDigest: boundedString(value.previewDigest, 'removal preview digest', { max: 64, pattern: SHA256_PATTERN }),
    confirmationToken: boundedString(value.confirmationToken, 'removal confirmation token', { max: 72, pattern: CONFIRMATION_TOKEN_PATTERN }),
  }
}

export function validateEnabled(value) {
  if (typeof value !== 'boolean') throw new TypeError('Invalid enabled flag')
  return value
}

export function validateActiveMode(value) {
  return boundedString(value, 'active mode', { max: 16, pattern: /^(?:legacy|stable|dev)$/ })
}

export function validateMode(value) {
  return boundedString(value, 'mode', { max: 16, pattern: /^(?:stable|dev)$/ })
}

export function validateCandidateChannel(value) {
  return boundedString(value, 'candidate channel', { max: 16, pattern: /^(?:stable|next)$/ })
}

export function validateCandidateId(value) {
  return boundedString(value, 'candidate id', { max: 128, pattern: SAFE_SNAPSHOT_PATTERN })
}

export function validateSnapshotId(value) {
  return boundedString(value, 'snapshot id', { max: 128, pattern: SAFE_SNAPSHOT_PATTERN })
}

export function validateLogLimit(value = 200) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2000) throw new TypeError('Invalid log limit')
  return value
}

export function validatePathIntent(value = 'auto') {
  return boundedString(value, 'path-open intent', { max: 16, pattern: /^(?:auto|editor|default)$/ })
}

export function validateLocalPath(value) {
  return boundedString(value, 'local path', { max: 4096 })
}

export function validateManagementRoute(value) {
  return boundedString(value, 'management route', { max: 32, pattern: new RegExp(`^(?:${MANAGEMENT_ROUTES.join('|')})$`) })
}

export function validateWorkspaceContext(value) {
  if (value === undefined || value === null) return { active: undefined, roots: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid workspace context')
  const active = value.active === undefined ? undefined : boundedString(value.active, 'workspace path', { max: 4096 })
  if (!Array.isArray(value.roots) || value.roots.length > 32) throw new TypeError('Invalid workspace roots')
  const roots = value.roots.map(root => boundedString(root, 'workspace root', { max: 4096 }))
  return { active, roots }
}

export function validateWorkspaceTheme(value) {
  // Accept the legacy resolved-only payload during rolling upgrades, but keep
  // the user's preference separate from the color scheme currently rendered.
  if (typeof value === 'string') {
    const resolved = boundedString(value, 'workspace theme', { max: 5, pattern: /^(?:light|dark)$/ })
    return { preference: resolved, resolved }
  }
  assertPlainObject(value, 'workspace theme')
  for (const field of Object.keys(value)) {
    if (field !== 'preference' && field !== 'resolved') throw new TypeError(`Unknown workspace theme field: ${field}`)
  }
  return {
    preference: boundedString(value.preference, 'workspace theme preference', { max: 6, pattern: /^(?:light|dark|system)$/ }),
    resolved: boundedString(value.resolved, 'resolved workspace theme', { max: 5, pattern: /^(?:light|dark)$/ }),
  }
}

export function validateTitlebarMenuRequest(value) {
  assertPlainObject(value, 'title-bar menu request')
  const allowed = new Set(['menu', 'x', 'y'])
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`Unknown title-bar menu field: ${field}`)
  }
  const coordinate = (entry, name) => {
    if (!Number.isSafeInteger(entry) || entry < 0 || entry > 32768) throw new TypeError(`Invalid title-bar menu ${name}`)
    return entry
  }
  return {
    menu: boundedString(value.menu, 'title-bar menu', { max: 8, pattern: /^(?:file|edit|view|help)$/ }),
    x: coordinate(value.x, 'x'),
    y: coordinate(value.y, 'y'),
  }
}

export function validateTitlebarNavigation(value) {
  return boundedString(value, 'title-bar navigation direction', { max: 7, pattern: /^(?:back|forward)$/ })
}

export function validateSourceUrl(value) {
  const source = boundedString(value, 'plugin source URL', { max: 2048 })
  let parsed
  try {
    parsed = new URL(source)
  } catch {
    throw new TypeError('Invalid plugin source URL')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') throw new TypeError('Plugin source must be a GitHub HTTPS URL')
  return parsed.href
}

/** Validate that an invocation came from the exact expected BrowserWindow. */
export function isTrustedSender(event, expectedWindow, { allowedPaths = [], allowedOrigins = [] } = {}) {
  if (event === undefined || expectedWindow === undefined || expectedWindow === null) return false
  if (typeof expectedWindow.isDestroyed === 'function' && expectedWindow.isDestroyed()) return false
  if (event.sender !== expectedWindow.webContents) return false
  const target = event.senderFrame?.url ?? event.sender?.getURL?.()
  if (typeof target !== 'string' || target === '') return false
  try {
    const parsed = new URL(target)
    if (allowedOrigins.includes(parsed.origin)) return true
    if (parsed.protocol === 'file:' && allowedPaths.some(path => fileURLToPath(parsed) === path)) return true
  } catch {
    return false
  }
  return false
}

export function assertTrustedSender(event, expectedWindow, options) {
  if (!isTrustedSender(event, expectedWindow, options)) throw new Error('Untrusted IPC sender')
}

export function unavailable(feature) {
  return { ok: false, error: `${feature} is not available in this frontend shell yet; no operation was performed.` }
}
