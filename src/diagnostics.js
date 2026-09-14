import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { appendFile, mkdir, rename, stat, truncate, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DIAGNOSTIC_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DIAGNOSTIC_LOG_TAIL_MAX_BYTES = 512 * 1024
export const DIAGNOSTIC_LOG_TAIL_MAX_LINES = 2000

// These are deliberately separate boundaries. Renderer status is compact and
// frequent, native dialogs may show a little more context, and persisted/log
// output needs enough room for a useful command prefix and a short stack.
export const DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS = 2_000
export const DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS = 4_000
export const DIAGNOSTIC_PERSISTED_LOG_MAX_CHARS = 64 * 1024
export const DIAGNOSTIC_TRUNCATION_MARKER = '… [truncated]'

// Descriptive aliases keep call sites readable while retaining one canonical
// value for each boundary.
export const DIAGNOSTIC_STATUS_MAX_CHARS = DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS
export const DIAGNOSTIC_DIALOG_DETAIL_MAX_CHARS = DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS
export const DIAGNOSTIC_LOG_ENTRY_MAX_CHARS = DIAGNOSTIC_PERSISTED_LOG_MAX_CHARS

const QUOTED_VALUE = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`
const AUTH_LINE_VALUE = `[^\\r\\n}\\]]+`
// Include common X-API-Key spellings explicitly; JSON often preserves the
// header name while upstream clients use x_api_key instead.
const SENSITIVE_KEY = '(?:authorization|proxy-authorization|x[-_]?api[-_]?key|api[_-]?key|apiKey|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)'
const SENSITIVE_KEY_TOKEN = `(?:\\"${SENSITIVE_KEY}\\"|'${SENSITIVE_KEY}'|${SENSITIVE_KEY})`

// A quoted JSON value stops at its closing quote; an unquoted header value
// consumes the full logical line, including Basic/Digest credentials that
// contain spaces or suffixes.
const ASSIGNMENT_VALUE = `(?:${QUOTED_VALUE}|${AUTH_LINE_VALUE})`
const QUERY_VALUE = `(?:${QUOTED_VALUE}|[^&#\\s]+)`
const AUTHORIZATION_HEADER_ASSIGNMENT = new RegExp(`(^\\s*(?:authorization|proxy-authorization)\\s*[:=]\\s*).*`, 'gim')
const NOT_REDACTED = '(?!\\s*\\[REDACTED\\])'
const AUTHORIZATION_SCHEME_ASSIGNMENT = new RegExp(`(\\b(?:authorization|proxy-authorization)\\s*[:=]?\\s*(?:Bearer|Basic)\\s+)${NOT_REDACTED}${AUTH_LINE_VALUE}`, 'gi')
const SENSITIVE_ASSIGNMENT = new RegExp(`(?<![?&#])(${SENSITIVE_KEY_TOKEN}\\s*[:=]\\s*)${NOT_REDACTED}${ASSIGNMENT_VALUE}`, 'gi')
const QUERY_ASSIGNMENT = new RegExp(`([?&#]${SENSITIVE_KEY}\\s*=\\s*)${NOT_REDACTED}${QUERY_VALUE}`, 'gi')
const SENSITIVE_OBJECT_KEY = new RegExp(`^${SENSITIVE_KEY}$`, 'i')
const QUERY_PARAMETER = /([?&#])([^?&#=\s]+)(=)([^&#\s]*)/g
const SENSITIVE_QUERY_KEY = new RegExp(`^${SENSITIVE_KEY}$`, 'i')
const BEARER_VALUE = new RegExp(`\\bBearer\\s+${NOT_REDACTED}${AUTH_LINE_VALUE}`, 'gi')
const OPENAI_STYLE_TOKEN = /\b(?:sk|rk|sess|key)-[A-Za-z0-9][A-Za-z0-9._~-]{7,}\b/g

function asDiagnosticText(value) {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function normalizeDiagnosticCap(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid diagnostic text limit')
  return maximum
}

/** Preserve the useful prefix while making the truncation explicit. */
export function capDiagnosticText(value, maximum = DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS) {
  const text = asDiagnosticText(value)
  maximum = normalizeDiagnosticCap(maximum)
  if (text.length <= maximum) return text
  if (maximum <= DIAGNOSTIC_TRUNCATION_MARKER.length) return DIAGNOSTIC_TRUNCATION_MARKER.slice(0, maximum)
  return `${text.slice(0, maximum - DIAGNOSTIC_TRUNCATION_MARKER.length)}${DIAGNOSTIC_TRUNCATION_MARKER}`
}

export function sanitizeAndCapDiagnosticText(value, maximum = DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS) {
  return capDiagnosticText(sanitizeDiagnosticText(value), maximum)
}

export function diagnosticStatusText(value) {
  return sanitizeAndCapDiagnosticText(value, DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS)
}

export function diagnosticDialogDetail(value) {
  return sanitizeAndCapDiagnosticText(value, DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS)
}

export function diagnosticLogText(value) {
  return sanitizeAndCapDiagnosticText(value, DIAGNOSTIC_PERSISTED_LOG_MAX_CHARS)
}

export function diagnosticErrorDetail(error, maximum = DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS) {
  return sanitizeAndCapDiagnosticText(error, maximum)
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Sanitize diagnostics before they are persisted or projected to a renderer.
 * The whole value after an authorization/API-secret key is replaced; keeping a
 * token suffix is not safe because suffixes are often sufficient to replay a
 * credential or identify it in support logs.
 */
export function sanitizeDiagnosticText(value) {
  let text = asDiagnosticText(value)
  if (text === '') return text

  // Query strings may percent-encode either the key or value. Inspect the
  // decoded key while preserving the original URL spelling.
  text = text.replace(QUERY_PARAMETER, (match, prefix, key, equals) =>
    SENSITIVE_QUERY_KEY.test(safeDecode(key)) ? `${prefix}${key}${equals}[REDACTED]` : match,
  )
  text = text.replace(QUERY_ASSIGNMENT, '$1[REDACTED]')
  text = text.replace(AUTHORIZATION_HEADER_ASSIGNMENT, '$1[REDACTED]')
  text = text.replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
  text = text.replace(AUTHORIZATION_SCHEME_ASSIGNMENT, '$1[REDACTED]')
  text = text.replace(BEARER_VALUE, 'Bearer [REDACTED]')
  text = text.replace(OPENAI_STYLE_TOKEN, '[REDACTED]')

  // A small second pass over decoded query material closes the case where a
  // producer encoded the key name itself but left the secret value readable.
  const decoded = safeDecode(text)
  if (decoded !== text) {
    const sanitizedDecoded = decoded
      .replace(QUERY_ASSIGNMENT, '$1[REDACTED]')
      .replace(AUTHORIZATION_HEADER_ASSIGNMENT, '$1[REDACTED]')
      .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
      .replace(AUTHORIZATION_SCHEME_ASSIGNMENT, '$1[REDACTED]')
      .replace(BEARER_VALUE, 'Bearer [REDACTED]')
      .replace(OPENAI_STYLE_TOKEN, '[REDACTED]')
    if (sanitizedDecoded !== decoded) {
      // Do not replace the complete string with decoded text: paths, URLs and
      // non-secret diagnostics must retain their original representation.
      text = text.replace(decoded, sanitizedDecoded)
    }
  }
  return text
}

export const sanitizeDiagnostic = sanitizeDiagnosticText

export function sanitizeDiagnosticValue(value, {
  maxStringLength = DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS,
  maxEntries = 1_000,
  maxDepth = 8,
} = {}) {
  maxStringLength = normalizeDiagnosticCap(maxStringLength)
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid diagnostic entry limit')
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new TypeError('Invalid diagnostic depth limit')
  const seen = new WeakSet()
  const visit = (candidate, depth) => {
    if (candidate instanceof Error) return sanitizeAndCapDiagnosticText(candidate, maxStringLength)
    if (typeof candidate === 'string') return sanitizeAndCapDiagnosticText(candidate, maxStringLength)
    if (candidate === null || typeof candidate !== 'object') return candidate
    if (depth >= maxDepth || seen.has(candidate)) return DIAGNOSTIC_TRUNCATION_MARKER
    seen.add(candidate)
    try {
      if (Array.isArray(candidate)) return candidate.slice(0, maxEntries).map(child => visit(child, depth + 1))
      return Object.fromEntries(Object.entries(candidate).slice(0, maxEntries).map(([key, child]) => [
        key,
        SENSITIVE_OBJECT_KEY.test(key) ? '[REDACTED]' : visit(child, depth + 1),
      ]))
    } catch {
      return '[unavailable]'
    } finally {
      seen.delete(candidate)
    }
  }
  return visit(value, 0)
}

export function sanitizeAndCapDiagnosticValue(value, options) {
  return sanitizeDiagnosticValue(value, options)
}

function normalizeLineLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DIAGNOSTIC_LOG_TAIL_MAX_LINES) {
    throw new TypeError('Invalid diagnostic line limit')
  }
  return value
}

function normalizeByteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DIAGNOSTIC_LOG_TAIL_MAX_BYTES) {
    throw new TypeError('Invalid diagnostic byte limit')
  }
  return value
}

/**
 * Read only a fixed-size tail from a diagnostic file. The file is never loaded
 * in full: at most maxBytes are read from its end, then the result is bounded
 * again by lineLimit.
 */
export function readBoundedLogTail(filePath, { lineLimit = 200, maxBytes = DIAGNOSTIC_LOG_TAIL_MAX_BYTES } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('Invalid diagnostic log path')
  lineLimit = normalizeLineLimit(lineLimit)
  maxBytes = normalizeByteLimit(maxBytes)

  const descriptor = openSync(filePath, 'r')
  try {
    const size = Number(fstatSync(descriptor).size)
    const offset = Math.max(0, size - maxBytes)
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const count = readSync(descriptor, buffer, read, length - read, offset + read)
      if (count === 0) break
      read += count
    }

    let text = buffer.subarray(0, read).toString('utf8')
    const byteTruncated = offset > 0
    if (byteTruncated) {
      // The first line may begin before the bounded window. Discard that
      // partial line so callers never mistake a clipped prefix for a complete
      // diagnostic record. If the file contains one enormous line, retaining
      // the bounded fragment is more useful than returning nothing.
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) text = text.slice(firstNewline + 1)
    }

    const rawLines = sanitizeDiagnosticText(text).split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line).filter(Boolean)
    const lineTruncated = rawLines.length > lineLimit
    const visibleRawLines = rawLines.slice(-lineLimit)
    const lines = visibleRawLines.map(line => diagnosticLogText(line))
    const lineCapped = lines.some((line, index) => line !== visibleRawLines[index])
    return { lines, truncated: byteTruncated || lineTruncated || lineCapped }
  } finally {
    closeSync(descriptor)
  }
}

async function fileSize(filePath) {
  try {
    return Number((await stat(filePath)).size)
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function appendCapped(filePath, payload, maxBytes, rotatedPath) {
  await mkdir(dirname(filePath), { recursive: true })
  let bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (bytes.length > maxBytes) bytes = bytes.subarray(bytes.length - maxBytes)

  const currentSize = await fileSize(filePath)
  if (currentSize > 0 && currentSize + bytes.length > maxBytes) {
    await removeIfPresent(rotatedPath)
    await rename(filePath, rotatedPath)
    // External/manual writes should not be able to leave an unbounded rotated
    // artifact behind. Normal writes are already capped, so this is cheap in
    // the common path and bounded in the recovery path.
    if ((await fileSize(rotatedPath)) > maxBytes) await truncate(rotatedPath, maxBytes)
  } else if (currentSize > maxBytes) {
    await truncate(filePath, maxBytes)
  }
  if (bytes.length > 0) await appendFile(filePath, bytes)
}

/**
 * Serialized, rotating diagnostic log owner. Writes are queued so rotation
 * cannot race with append and close() can await every accepted write.
 */
export function createDiagnosticLog({ path, maxBytes = DIAGNOSTIC_LOG_MAX_BYTES, onError = () => {} } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('Invalid diagnostic log path')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid diagnostic log size')
  if (typeof onError !== 'function') throw new TypeError('Invalid diagnostic log error handler')

  const rotatedPath = `${path}.1`
  let queue = Promise.resolve()
  let closed = false

  function write(value) {
    if (closed) return queue
    const payload = Buffer.from(diagnosticLogText(value), 'utf8')
    queue = queue.then(() => appendCapped(path, payload, maxBytes, rotatedPath)).catch(error => {
      try { onError(error) } catch { /* logging must not create a second failure */ }
    })
    return queue
  }

  async function close() {
    closed = true
    await queue
  }

  return Object.freeze({ path, rotatedPath, write, close })
}
