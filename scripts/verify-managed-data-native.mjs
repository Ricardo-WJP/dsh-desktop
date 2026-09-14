import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateManagedDataHome, projectManagedProfile } from '../src/storage/managed-data-home.js'
import { createPreflightEnvironment } from '../src/profile/preflight-environment.js'
import { HarnessServer } from '../src/harness-server.js'
import { sanitizeDiagnosticText } from '../src/diagnostics.js'
import { SnapshotStore } from '../src/release/snapshot-store.js'
import { realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'

// Default acceptance never reads the user's active release or configuration.
const repo = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: {
  'runtime-entry': { type: 'string' },
  'installed-root': { type: 'string' },
  report: { type: 'string' },
} })
assert.ok(!(values['runtime-entry'] && values['installed-root']), 'Choose runtime-entry or installed-root, not both')
const reportPath = resolve(values.report ?? join(repo, 'output/managed-data-native-proof/report.json'))
let activePath
let originalActive
let entry = resolve(values['runtime-entry'] ?? join(repo, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
if (values['installed-root']) {
  const installedRoot = resolve(values['installed-root'])
  activePath = join(installedRoot, 'release-state', 'active.json')
  originalActive = await readFile(activePath, 'utf8')
  const active = JSON.parse(originalActive)
  assert.match(active.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  const originalCandidate = join(installedRoot, 'candidates', active.releaseId)
  const manifest = JSON.parse(await readFile(join(originalCandidate, 'manifest.json'), 'utf8'))
  assert.match(manifest.dsh.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
  entry = join(originalCandidate, 'runtime', 'versions', manifest.dsh.version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}
const scratch = await mkdtemp(join(tmpdir(), 'dsh-data-home-native-proof-'))
const profileName = 'data-home-proof'
const roots = {}
for (const id of ['release-a', 'release-b']) {
  const candidate = roots[id] = join(scratch, 'candidates', id)
  const profile = join(candidate, 'profiles', profileName)
  const plugin = join(profile, 'node_modules', 'data-home-proof-plugin')
  await mkdir(plugin, { recursive: true })
  await mkdir(join(candidate, 'profiles', 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: profileName, private: true, type: 'module', dependencies: { 'data-home-proof-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'data-home-proof-plugin'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'data-home-proof-plugin', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: data-home-proof-plugin\n      name: data-home-proof-plugin\n')
  await writeFile(join(plugin, 'index.js'), `import {appendFileSync} from 'node:fs'; import {join} from 'node:path'; export function apply(){appendFileSync(join(process.env.DSH_HOME,'proof-events.txt'),${JSON.stringify(id+'\n')});console.log('DATA_HOME_PROOF_READY');}\n`)
  await writeFile(join(candidate, 'settings.yaml'), 'synthetic-marker: before-migration\n')
  await writeFile(join(candidate, '.credentials.yaml'), 'version: 1\nrefs: {}\n')
}
const adopted = await migrateManagedDataHome({ runtimeRoot: scratch, sourceHome: roots['release-a'], sourceReleaseId: 'release-a', assertStopped: () => true })
const isolation = createPreflightEnvironment({ env: process.env, home: join(scratch, 'isolation') })
for (const path of isolation.directories) await mkdir(path, { recursive: true })
const checks = []
const snapshots = new SnapshotStore({ sourceRoot: adopted.dataHome, dataRoot: adopted.dataHome, snapshotRoot: join(scratch, 'snapshots'), excludedRelativePaths: ['profiles'] })
for (const id of ['release-a', 'release-b', 'release-a']) {
  projectManagedProfile({ runtimeRoot: scratch, candidateHome: roots[id], physicalName: profileName })
  let seen = false
  let outputTail = ''
  const server = new HarnessServer({
    command: process.execPath,
    args: ['--expose-internals', '--require', join(repo, 'src', 'runtime', 'windows-hidden-child-process.cjs'), entry, '--profile', profileName, '--port', '0', '--no-open'],
    env: { ...isolation.env, DSH_HOME: adopted.dataHome }, cwd: isolation.env.HOME,
    startupTimeoutMs: 60000, forceWindowsTreeTermination: true,
    onOutput: (_source, text) => { if (text.includes('DATA_HOME_PROOF_READY')) seen = true; outputTail = (outputTail + text).slice(-12000) },
  })
  let failure
  try {
    const url = await server.start()
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    assert.ok([200, 303].includes(response.status))
    assert.equal(seen, true)
    if (checks.length > 0) assert.equal(await readFile(join(adopted.dataHome, 'settings.yaml'), 'utf8'), 'synthetic-marker: changed-after-migration\n')
    checks.push({ release: id, httpStatus: response.status, pluginExecuted: seen, sharedDataPreserved: true })
  } catch (error) { failure = error }
  try { await server.stop() } catch (error) { if (!failure) failure = error; else failure.cleanupError = error }
  if (failure) {
    console.error(sanitizeDiagnosticText(outputTail))
    throw failure
  }
  if (checks.length === 1) await snapshots.create({ snapshotId: 'data-before-change', kind: 'pre-switch' })
  await writeFile(join(adopted.dataHome, 'settings.yaml'), 'synthetic-marker: changed-after-migration\n')
}
assert.equal(await readFile(join(adopted.dataHome, 'proof-events.txt'), 'utf8'), 'release-a\nrelease-b\nrelease-a\n')
assert.equal(await readFile(join(roots['release-a'], 'settings.yaml'), 'utf8'), 'synthetic-marker: before-migration\n')
if (activePath) assert.equal(await readFile(activePath, 'utf8'), originalActive)
await snapshots.create({ snapshotId: 'data-rescue-current', kind: 'rescue' })
const codeProjection = await realpath(join(adopted.dataHome, 'profiles', profileName))
await snapshots.restore({ snapshotId: 'data-before-change' })
assert.equal(await realpath(join(adopted.dataHome, 'profiles', profileName)), codeProjection)
assert.equal(await readFile(join(adopted.dataHome, 'settings.yaml'), 'utf8'), 'synthetic-marker: before-migration\n')
await snapshots.restore({ snapshotId: 'data-rescue-current' })
assert.equal(await readFile(join(adopted.dataHome, 'settings.yaml'), 'utf8'), 'synthetic-marker: changed-after-migration\n')
await mkdir(resolve(reportPath, '..'), { recursive: true })
const report = { ok: true, scope: 'real DSH startup with synthetic data and program projection changes', userStateRead: Boolean(activePath), activeUserReleaseUnchanged: activePath ? true : null, dataRestorePreservesProgram: true, rescueRestorePassed: true, checks, scratch, retainedForInspection: true }
await writeFile(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
