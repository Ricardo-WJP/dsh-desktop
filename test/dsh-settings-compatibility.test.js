import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ensureCandidateDshSettingsRuntimeCompatibility,
} from '../src/desktop-runtime-controller.js'
import { patchDshSettingsLegacyExports } from '../src/compatibility/dsh-settings-legacy-exports.js'

const UPSTREAM = [
  'import { deepEqualJson, deepFreeze } from "@deepseek-ai/dsh-util-values";',
  'const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;',
  'function parseSettingsNamespace(value) {',
  '  if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(value);',
  '  return value;',
  '}',
  'function installSection(owner, ns, schema, entry, hooks) {}',
  'function isUnloading(ctx) { return ctx?.fiber?.state === 5; }',
  'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets };',
].join('\n')

const LEGACY = [
  'function settingsNamespace(value) { return value; }',
  'function installSettingsSection(ctx, ns, schema, entry, hooks) {}',
  'function deepEqualJson(a, b) { return a === b; }',
  'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, deepEqualJson, installSettingsSection, redactSecrets, settingsNamespace };',
].join('\n')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function createCandidateFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-settings-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime', 'versions', '0.1.2-rc.1')
  const profile = join(root, 'profile')
  const packageRoot = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-settings')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ dsh: { version: '0.1.2-rc.1' } }))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.2-rc.1' }))
  writeFileSync(join(packageRoot, 'lib', 'index.js'), UPSTREAM)
  return { root, profile, target: join(packageRoot, 'lib', 'index.js') }
}

test('dsh-settings shim adds only the audited legacy helper exports', () => {
  const patched = patchDshSettingsLegacyExports(UPSTREAM)
  assert.equal(patched.state, 'patched')
  assert.match(patched.source, /DSH_DESKTOP_SETTINGS_LEGACY_EXPORTS/)
  assert.match(patched.source, /function settingsNamespace\(/)
  assert.match(patched.source, /function installSettingsSection\(/)
  assert.match(patched.source, /deepEqualJson, settingsNamespace, installSettingsSection/)
  assert.equal(patchDshSettingsLegacyExports(patched.source).state, 'compatible')
})

test('dsh-settings compatibility accepts an upstream legacy export block without a Desktop marker', () => {
  const result = patchDshSettingsLegacyExports(LEGACY)
  assert.equal(result.state, 'compatible')
  assert.equal(result.source, LEGACY)
})

test('candidate dsh-settings compatibility is atomic, idempotent, and fail-closed on drift', async t => {
  const fixture = createCandidateFixture(t)
  const patched = patchDshSettingsLegacyExports(UPSTREAM)
  const target = { upstreamSha256: sha256(UPSTREAM), patchedSha256: sha256(patched.source) }

  const first = await ensureCandidateDshSettingsRuntimeCompatibility(fixture.root, fixture.profile, {
    target,
  })
  assert.equal(first.state, 'patched')
  assert.match(readFileSync(fixture.target, 'utf8'), /DSH_DESKTOP_SETTINGS_LEGACY_EXPORTS/)

  const second = await ensureCandidateDshSettingsRuntimeCompatibility(fixture.root, fixture.profile, {
    target,
  })
  assert.equal(second.state, 'compatible')

  const malformed = patched.source.replace('deepEqualJson, settingsNamespace, installSettingsSection', 'deepEqualJson')
  writeFileSync(fixture.target, malformed)
  const drifted = await ensureCandidateDshSettingsRuntimeCompatibility(fixture.root, fixture.profile, {
    target,
  })
  assert.equal(drifted.state, 'unrecognized')
})
