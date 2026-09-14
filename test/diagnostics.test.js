import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  capDiagnosticText,
  createDiagnosticLog,
  diagnosticDialogDetail,
  diagnosticLogText,
  diagnosticStatusText,
  DIAGNOSTIC_LOG_ENTRY_MAX_CHARS,
  DIAGNOSTIC_LOG_TAIL_MAX_BYTES,
  DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS,
  DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS,
  DIAGNOSTIC_TRUNCATION_MARKER,
  readBoundedLogTail,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} from '../src/diagnostics.js'

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('diagnostic sanitizer consumes full authorization, API-key and query values', () => {
  const secrets = [
    'sk-bearer-secret-123456789',
    'api-key-secret-987654321',
    'apiKey-secret-456789123',
    'quoted-api-secret-246813579',
    'query-secret-135792468',
    'json-secret-112233445',
    'encoded-query-secret-864209753',
  ]
  const input = [
    `Authorization: Bearer ${secrets[0]}`,
    `api_key=${secrets[1]}`,
    `apiKey: '${secrets[2]}'`,
    `Authorization: "Bearer ${secrets[3]}"`,
    `https://example.test/health?api_key=${secrets[4]}&ok=1`,
    `https://example.test/health?%61piKey=encoded-query-secret-864209753`,
    `{"Authorization":"Bearer ${secrets[5]}","apiKey":"${secrets[2]}"}`,
  ].join('\n')

  const sanitized = sanitizeDiagnosticText(input)
  for (const secret of secrets) assert.doesNotMatch(sanitized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(sanitized, /Authorization: \[REDACTED\]/)
  assert.match(sanitized, /api_key=\[REDACTED\]/)
  assert.match(sanitized, /[?&]api_key=\[REDACTED\]&ok=1/)

  const projected = sanitizeDiagnosticValue({ startup: { error: input }, lines: [input] })
  assert.deepEqual(projected.startup.error, sanitized)
  assert.deepEqual(projected.lines, [sanitized])
})

test('diagnostic boundary helpers sanitize secrets and preserve bounded prefixes', () => {
  const bearer = 'bearer-boundary-secret-123456789'
  const basic = 'basic-boundary-secret-987654321'
  const huge = `prefix: keep this useful context\nAuthorization: Bearer ${bearer}\nAuthorization: Basic ${basic}\n${'x'.repeat(100_000)}`

  const status = diagnosticStatusText(huge)
  const dialog = diagnosticDialogDetail(huge)
  const log = diagnosticLogText(huge)
  assert.ok(status.length <= DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS)
  assert.ok(dialog.length <= DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS)
  assert.ok(log.length <= DIAGNOSTIC_LOG_ENTRY_MAX_CHARS)
  assert.match(status, /^prefix: keep this useful context/)
  assert.equal(status.includes(DIAGNOSTIC_TRUNCATION_MARKER), true)
  assert.doesNotMatch(`${status}\\n${dialog}\\n${log}`, new RegExp(bearer))
  assert.doesNotMatch(`${status}\\n${dialog}\\n${log}`, new RegExp(basic))
  assert.equal(capDiagnosticText('prefix' + 'x'.repeat(100), 24).startsWith('prefix'), true)

  const value = sanitizeDiagnosticValue({ error: huge, nested: { apiKey: basic } })
  assert.ok(value.error.length <= DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS)
  assert.doesNotMatch(JSON.stringify(value), new RegExp(basic))
})

test('diagnostic sanitizer removes quoted X-API-Key variants and complete non-Bearer authorization credentials', () => {
  const secrets = [
    'x-api-secret with spaces suffix',
    'x_api-secret-987 suffix',
    'basic-user secret with spaces and suffix',
    'digest-user secret=with spaces; suffix',
    'negotiate-credential trailing suffix',
    'trailing-secret-with-spaces',
  ]
  const input = [
    `{"X-API-Key":"${secrets[0]}","ok":true}`,
    `{"x_api_key":"${secrets[1]}","other":"kept"}`,
    `Authorization: Basic ${secrets[2]}`,
    `authorization: Digest ${secrets[3]}`,
    `Authorization: Negotiate ${secrets[4]}`,
    'Authorization: "Basic quoted credential" trailing-secret-with-spaces',
  ].join('\\n')
  const sanitized = sanitizeDiagnosticText(input)
  for (const secret of secrets) assert.equal(sanitized.includes(secret), false, `secret leaked: ${secret}`)
  assert.match(sanitized, /X-API-Key/)
  assert.match(sanitized, /x_api_key/)
})

test('bounded reverse-tail reading handles huge files, truncation, and line limits', t => {
  const directory = temporaryDirectory(t)
  const path = join(directory, 'desktop.log')
  const content = Array.from({ length: 100_000 }, (_, index) => `line-${index}`).join('\n') + '\n'
  writeFileSync(path, content)

  const result = readBoundedLogTail(path, { maxBytes: 512, lineLimit: 4 })
  assert.equal(result.truncated, true)
  assert.ok(result.lines.length <= 4)
  assert.equal(result.lines.at(-1), 'line-99999')
  assert.ok(statSync(path).size > 512)
  assert.ok(result.lines.every(line => line.startsWith('line-')))
})

test('bounded tail keeps ordinary tail ordering and reports line truncation', t => {
  const directory = temporaryDirectory(t)
  const path = join(directory, 'desktop.log')
  writeFileSync(path, 'one\ntwo\nthree\nfour\n')

  const result = readBoundedLogTail(path, { maxBytes: 1024, lineLimit: 2 })
  assert.deepEqual(result.lines, ['three', 'four'])
  assert.equal(result.truncated, true)
})

test('diagnostic log owner rotates and caps append-only writes', async t => {
  const directory = temporaryDirectory(t)
  const path = join(directory, 'desktop.log')
  const log = createDiagnosticLog({ path, maxBytes: 32 })
  await log.write('first line\n')
  await log.write('Authorization: Bearer sk-rotated-secret-123456789\n')
  await log.write('last line\n')
  await log.close()

  assert.equal(existsSync(path), true)
  assert.equal(existsSync(log.rotatedPath), true)
  assert.ok(statSync(path).size <= 32)
  assert.ok(statSync(log.rotatedPath).size <= 32)
  const visible = `${readFileSync(path, 'utf8')}\n${readFileSync(log.rotatedPath, 'utf8')}`
  assert.doesNotMatch(visible, /sk-rotated-secret-123456789/)
  assert.match(visible, /first line|last line/)
})

test('diagnostic log close awaits queued writes and rejects writes after close', async t => {
  const directory = temporaryDirectory(t)
  const path = join(directory, 'desktop.log')
  const log = createDiagnosticLog({ path, maxBytes: 128 })
  const pending = log.write('queued\n')
  await log.close()
  await pending
  await log.write('ignored-after-close\n')
  assert.equal(readFileSync(path, 'utf8'), 'queued\n')
  assert.ok(DIAGNOSTIC_LOG_TAIL_MAX_BYTES > 0)
})
