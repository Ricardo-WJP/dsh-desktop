import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createDesktopRuntimeController } from '../src/desktop-runtime-controller.js'
import { prepareHarnessToolchain } from '../src/desktop-integration.js'
import { readActiveDshRuntime, resolveManagedDshRuntimeRoot } from '../src/dsh-runtime.js'
import { SnapshotStore } from '../src/release/snapshot-store.js'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopPackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
const userData = join(process.env.APPDATA ?? '', 'dsh-desktop')
const runtimeRoot = resolveManagedDshRuntimeRoot({
  userProfile: process.env.USERPROFILE,
  userData,
})
const snapshotRoot = join(process.env.USERPROFILE ?? '', '.dsh-desktop-snapshots')
const dryRun = process.argv.includes('--dry-run')
const refreshIntegration = process.argv.includes('--refresh-integration')
const deferred = Object.freeze([
  Object.freeze({ name: '@linxin666/dsh-client-ui-task-board', offered: '0.3.11', kept: '0.3.6', reason: 'requires DSH >=0.1.2-alpha.1' }),
  Object.freeze({ name: '@linxin666/dsh-liangshen', offered: '0.3.11', kept: '0.3.6', reason: 'requires DSH >=0.1.2-alpha.1' }),
])

const requested = Object.freeze([
  Object.freeze({ name: 'dsh-free-search', source: Object.freeze({ type: 'npm', package: 'dsh-free-search', versionOrTag: '0.4.22' }) }),
  Object.freeze({ name: '@michengai/dsh-skills-manager', source: Object.freeze({ type: 'npm', package: '@michengai/dsh-skills-manager', versionOrTag: '0.1.33' }) }),
  Object.freeze({ name: '@linxin666/dsh-doctor', source: Object.freeze({ type: 'npm', package: '@linxin666/dsh-doctor', versionOrTag: '0.3.10' }) }),
  Object.freeze({ name: '@michengai/dsh-agency-agents', source: Object.freeze({ type: 'npm', package: '@michengai/dsh-agency-agents', versionOrTag: '0.1.25' }) }),
  Object.freeze({ name: 'dsh-client-auto-continue', source: Object.freeze({ type: 'npm', package: 'dsh-client-auto-continue', versionOrTag: '0.11.0' }) }),
  Object.freeze({ name: '@michengai/dsh-codex-ui', source: Object.freeze({ type: 'npm', package: '@michengai/dsh-codex-ui', versionOrTag: '0.2.101' }) }),
  Object.freeze({ name: '@michengai/dsh-archive-manager', source: Object.freeze({ type: 'npm', package: '@michengai/dsh-archive-manager', versionOrTag: '0.1.23' }) }),
  Object.freeze({ name: '@michengai/dsh-im-connect', source: Object.freeze({ type: 'npm', package: '@michengai/dsh-im-connect', versionOrTag: '0.1.30' }) }),
  Object.freeze({ name: 'dsh-mnemon', source: Object.freeze({ type: 'npm', package: 'dsh-mnemon', versionOrTag: '0.4.4' }) }),
  Object.freeze({ name: 'dsh-prompt-polish', source: Object.freeze({ type: 'github', repository: '1321928757/dsh-prompt-polish', ref: '6738824af10e145a471dd6620a884f5e3ab9fd77' }) }),
  Object.freeze({ name: 'dsh-stt-input', source: Object.freeze({ type: 'github', repository: 'baisama-cloud/dsh-stt-input', ref: '2f751d5ea14a6bfa9513d4439a45880f4b7a97de' }) }),
  Object.freeze({ name: 'dsh-signal', source: Object.freeze({ type: 'npm', package: 'dsh-signal', versionOrTag: '0.6.12' }) }),
])

function resolvePnpmEntry() {
  const manifest = require.resolve('pnpm')
  const entry = join(dirname(manifest), 'bin', 'pnpm.mjs')
  if (!existsSync(entry)) throw new Error(`Bundled pnpm entry point is missing: ${entry}`)
  return entry
}

function resolveBundledDshManifest() {
  return require.resolve('@deepseek-ai/dsh/package.json')
}

function resolveDshEntry(activeRuntime) {
  if (activeRuntime?.entry !== undefined) return activeRuntime.entry
  const entry = join(dirname(resolveBundledDshManifest()), 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`DeepSeek Harness entry point is missing: ${entry}`)
  return entry
}

function activeProfileManifestPath() {
  const state = JSON.parse(readFileSync(join(runtimeRoot, 'release-state', 'active.json'), 'utf8'))
  return join(runtimeRoot, 'candidates', state.releaseId, 'profile', 'package.json')
}

function activeProfileManifest() {
  return JSON.parse(readFileSync(activeProfileManifestPath(), 'utf8'))
}

function activeDependencies() {
  return activeProfileManifest().dependencies ?? {}
}

function activeBundleOrder() {
  const profile = activeProfileManifest()
  const bundles = profile?.dsh?.profile?.bundles ?? profile?.profile?.bundles ?? profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('Active plugin profile has no bundle order')
  return bundles.map((entry, index) => {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`Active bundle ${index} has no package name`)
    return name
  })
}

function expectedSpecifier(entry) {
  if (entry.source.type === 'npm') return entry.source.versionOrTag
  if (entry.source.type === 'local-dev') return 'file:./packages/dsh-signal-0.6.3.tgz'
  const suffix = entry.source.path === undefined ? '' : `&path:${entry.source.path}`
  return `github:${entry.source.repository}#${entry.source.ref}${suffix}`
}

function pendingEntries() {
  const dependencies = activeDependencies()
  return requested.filter(entry => dependencies[entry.name] !== expectedSpecifier(entry))
}

const pending = pendingEntries()
process.stdout.write(`${JSON.stringify({ dryRun, refreshIntegration, runtimeRoot, snapshotRoot, deferred, pending: pending.map(entry => ({ name: entry.name, target: expectedSpecifier(entry) })) }, undefined, 2)}\n`)
if (dryRun || (pending.length === 0 && !refreshIntegration)) process.exit(0)

const pnpmEntry = resolvePnpmEntry()
const initialRuntime = readActiveDshRuntime({
  runtimeRoot,
  bundledManifestPath: resolveBundledDshManifest(),
})
const runtimeEnvironment = prepareHarnessToolchain({
  directory: join(userData, 'toolchain'),
  execPath: process.execPath,
  pnpmEntry,
  env: process.env,
})
const app = {
  getAppPath: () => repositoryRoot,
  getPath: name => name === 'downloads' ? join(process.env.USERPROFILE ?? '', 'Downloads') : (process.env.USERPROFILE ?? ''),
  getVersion: () => desktopPackage.version,
  isPackaged: true,
}
const maintenanceWindow = Symbol('maintenance-workspace')
const headlessWindow = {
  getWindow: name => name === 'workspace' ? maintenanceWindow : undefined,
  currentLoadingWindow: () => maintenanceWindow,
  isOpen: value => value === 'workspace' || value === maintenanceWindow,
  isVisible: () => true,
  show: () => true,
  create: () => maintenanceWindow,
  loadFallbackPage: async () => true,
  executeLoadingScript: async () => true,
  loadWorkspace: async () => true,
  reveal: () => true,
  managementRendererAvailable: () => false,
}
const controller = createDesktopRuntimeController({
  window: headlessWindow,
  app,
  process,
  effects: {
    writeLog: (source, value) => process.stdout.write(`[${source}] ${value}`),
  },
  runtime: {
    app,
    process,
    env: runtimeEnvironment,
    dshHome: userData,
    runtimeRoot,
    repositoryRoot,
    initialRuntime,
    resolvePnpmEntry: () => pnpmEntry,
    resolveDshEntry,
  },
  snapshotRoot,
  createSnapshotStore: (options, root) => new SnapshotStore(options, root),
})

try {
  const recovery = await controller.recoverPendingRelease()
  if (recovery?.status !== 'idle') throw new Error(`Release recovery is not idle: ${JSON.stringify(recovery)}`)

  let candidateId = controller.statusSnapshot()?.plugins?.pendingCandidateId
  if (typeof candidateId === 'string') {
    process.stdout.write(`[resume] activating verified candidate ${candidateId}\n`)
  } else {
    const staged = pending.length > 0
      ? await controller.pluginInstallMany({
          sources: pending.map(entry => ({ ...entry, enabled: true })),
          buildPermissions: {
            ...Object.fromEntries(pending.map(entry => [entry.name, true])),
            'node-pty': true,
            protobufjs: true,
          },
        }, {
          onProgress: value => process.stdout.write(`[progress] ${JSON.stringify(value)}\n`),
        })
      : await controller.pluginTransaction({ action: 'reorder', order: activeBundleOrder() })
    if (staged?.ok !== true) throw new Error(`Plugin suite transaction failed: ${staged?.error ?? 'unknown error'}`)
    candidateId = staged.report?.candidateId ?? staged.report?.candidate?.id
    if (typeof candidateId !== 'string') throw new Error('Plugin suite transaction returned no candidate ID')
  }

  const switched = await controller.restartPluginChanges('apply-desktop-plugin-suite')
  if (switched?.status !== 'switched' || switched?.pointer?.releaseId !== candidateId) {
    throw new Error(`Plugin suite candidate did not activate: ${JSON.stringify(switched)}`)
  }

  const dependencies = activeDependencies()
  const mismatches = requested
    .map(entry => ({ name: entry.name, expected: expectedSpecifier(entry), actual: dependencies[entry.name] }))
    .filter(entry => entry.actual !== entry.expected)
  if (mismatches.length > 0) throw new Error(`Plugin suite verification failed: ${JSON.stringify(mismatches)}`)
  const integrationSource = readFileSync(join(repositoryRoot, 'src', 'plugins', 'dsh-desktop-integration', 'lib', 'client.js'))
  const integrationCandidate = readFileSync(join(runtimeRoot, 'candidates', candidateId, 'profiles', 'node_modules', '@dsh-desktop', 'integration', 'lib', 'client.js'))
  if (!integrationSource.equals(integrationCandidate)) throw new Error('Activated candidate does not contain the current desktop integration')
  process.stdout.write(`${JSON.stringify({ ok: true, candidateId, refreshedIntegration: refreshIntegration, installed: requested.map(entry => ({ name: entry.name, specifier: expectedSpecifier(entry) })) }, undefined, 2)}\n`)
} finally {
  await controller.shutdown(new Error('Desktop plugin suite maintenance complete'))
}
