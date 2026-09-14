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
const userData = join(process.env.APPDATA ?? '', 'dsh-desktop')
const dshHome = join(process.env.USERPROFILE ?? '', '.dsh')
const runtimeRoot = resolveManagedDshRuntimeRoot({
  userProfile: process.env.USERPROFILE,
  userData,
})
// Codex runs maintenance scripts from an MSIX host that virtualizes AppData\Roaming.
// Keep maintenance snapshots outside that virtualized tree so the release safety
// check can still distinguish real junctions from ordinary directories.
const snapshotRoot = join(process.env.USERPROFILE ?? '', '.dsh-desktop-snapshots')
const suiteOnly = process.argv.includes('--suite-only')
const removals = [
  '@linxin666/dsh-client-ui-skill-explorer',
  '@xmanrui/dsh-im',
]
const taskBoard = { name: '@linxin666/dsh-client-ui-task-board', version: '0.3.5' }
const suiteInstalls = [
  ['@michengai/dsh-codex-ui', '0.2.88'],
  ['@michengai/dsh-agency-agents', '0.1.21'],
  ['@michengai/dsh-skills-manager', '0.1.24'],
  ['@michengai/dsh-archive-manager', '0.1.13'],
  ['@michengai/dsh-im-connect', '0.1.24'],
  ['@michengai/dsh-automation', '0.1.15'],
]
const additionalInstalls = [
  ['dsh-better-sidebar', '0.16.1'],
  ['dsh-cost-meter', '1.6.2'],
  ['dsh-client-auto-continue', '0.8.1'],
  ['dsh-easyrewrite', '2.3.0'],
  ['dsh-free-search', '0.4.12'],
  ['dsh-meme', '0.1.39'],
]
const installs = suiteOnly ? suiteInstalls : [...suiteInstalls, ...additionalInstalls]

process.stdout.write(`[paths] ${JSON.stringify({ dshHome, runtimeRoot, snapshotRoot })}\n`)

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

function activeDependencies() {
  const state = JSON.parse(readFileSync(join(runtimeRoot, 'release-state', 'active.json'), 'utf8'))
  const manifest = join(runtimeRoot, 'candidates', state.releaseId, 'profile', 'package.json')
  return JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}
}

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
  getVersion: () => 'maintenance',
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
    dshHome,
    runtimeRoot,
    repositoryRoot,
    initialRuntime,
    resolvePnpmEntry: () => pnpmEntry,
    resolveDshEntry,
  },
  snapshotRoot,
  createSnapshotStore: (options, root) => {
    process.stdout.write(`[snapshot] ${JSON.stringify({ root, excludedRelativePaths: options.excludedRelativePaths })}\n`)
    return new SnapshotStore(options, root)
  },
})

async function activate(label, expectedCandidateId) {
  const switched = await controller.restartPluginChanges(label)
  if (switched?.status !== 'switched' || switched?.pointer?.releaseId !== expectedCandidateId) {
    throw new Error(`${label} did not activate ${expectedCandidateId}: ${JSON.stringify(switched)}`)
  }
  process.stdout.write(`[activated] ${label}: ${expectedCandidateId}\n`)
}

async function removeInstalled(name) {
  if (typeof activeDependencies()[name] !== 'string') {
    process.stdout.write(`[skip] ${name} is not installed\n`)
    return
  }
  const preview = await controller.pluginRemovePreview({ name })
  if (preview?.ok !== true) throw new Error(`Could not preview removal for ${name}: ${preview?.error ?? 'unknown error'}`)
  const value = preview.preview
  process.stdout.write(`[remove-preview] ${name}: ${JSON.stringify({ dependentPackages: value.dependentPackages, dependentBundles: value.dependentBundles })}\n`)
  const staged = await controller.pluginConfirmRemove({
    name,
    previewDigest: value.previewDigest,
    confirmationToken: value.confirmationToken,
    candidateId: value.candidateId,
    candidatePath: value.candidatePath,
  })
  if (staged?.ok !== true) throw new Error(`Could not stage removal for ${name}: ${staged?.error ?? 'unknown error'}`)
  const candidateId = staged.report?.candidateId ?? staged.report?.candidate?.id
  await activate(`remove-${name.replaceAll('/', '-')}`, candidateId)
}

try {
  const recovery = await controller.recoverPendingRelease()
  if (recovery?.status !== 'idle') {
    process.stdout.write(`[recovery] ${JSON.stringify(recovery)}\n`)
    process.stdout.write('[recovery] Start this script again to continue from the recovered active release.\n')
  } else {
    for (const name of removals) await removeInstalled(name)

    if (activeDependencies()[taskBoard.name] !== taskBoard.version) {
    const staged = await controller.pluginTransaction({
      action: 'replaceSource',
      name: taskBoard.name,
      source: { type: 'npm', package: taskBoard.name, versionOrTag: taskBoard.version },
      buildPermissions: { [taskBoard.name]: true },
    })
    if (staged?.ok !== true) throw new Error(`Could not update ${taskBoard.name}: ${staged?.error ?? 'unknown error'}`)
    const candidateId = staged.report?.candidateId ?? staged.report?.candidate?.id
    await activate('update-task-board', candidateId)
    }

    const dependencies = activeDependencies()
    const pendingInstalls = installs.filter(([name, version]) => dependencies[name] !== version)
    if (pendingInstalls.length > 0) {
    // @michengai/dsh-im-connect depends on @larksuiteoapi/node-sdk, which in
    // turn installs protobufjs@7.6.5. Its audited postinstall script is
    // read-only (it only checks the parent package's version range and may
    // print a warning), so grant this exact transitive package explicitly.
    const buildPermissions = {
      ...Object.fromEntries(pendingInstalls.map(([name]) => [name, true])),
      protobufjs: true,
      // dsh-better-sidebar pulls node-pty for terminal panes. The audited
      // package only selects a matching prebuild and validates the install,
      // falling back to node-gyp when no compatible binary exists.
      'node-pty': true,
    }
    const staged = await controller.pluginInstallMany({
      sources: pendingInstalls.map(([name, versionOrTag]) => ({
        name,
        source: { type: 'npm', package: name, versionOrTag },
        enabled: true,
      })),
      buildPermissions,
    }, {
      onProgress: value => process.stdout.write(`[progress] ${JSON.stringify(value)}\n`),
    })
    if (staged?.ok !== true) throw new Error(`Could not install requested plugins: ${staged?.error ?? 'unknown error'}`)
    const candidateId = staged.report?.candidateId ?? staged.report?.candidate?.id
    await activate(suiteOnly ? 'install-codex-suite' : 'install-requested-plugins', candidateId)
    }

    const finalDependencies = activeDependencies()
    const expected = Object.fromEntries([
      [taskBoard.name, taskBoard.version],
      ...installs,
    ])
    const mismatches = Object.entries(expected).filter(([name, version]) => finalDependencies[name] !== version)
    const leftovers = removals.filter(name => typeof finalDependencies[name] === 'string')
    if (mismatches.length > 0 || leftovers.length > 0) {
      throw new Error(`Final plugin set mismatch: ${JSON.stringify({ mismatches, leftovers })}`)
    }
    process.stdout.write(`${JSON.stringify({ ok: true, installed: expected, removed: removals }, undefined, 2)}\n`)
  }
} finally {
  await controller.shutdown(new Error('Requested plugin reconciliation complete'))
}
