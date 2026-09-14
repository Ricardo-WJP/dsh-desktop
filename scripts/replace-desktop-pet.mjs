import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createDesktopRuntimeController } from '../src/desktop-runtime-controller.js'
import { prepareHarnessToolchain } from '../src/desktop-integration.js'
import { readActiveDshRuntime, resolveManagedDshRuntimeRoot } from '../src/dsh-runtime.js'
import { SnapshotStore } from '../src/release/snapshot-store.js'

const OLD_PET = 'dsh-pet'
const NEW_PET = 'better-dsh-pet'
const NEW_PET_VERSION = '0.2.6'
const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const userData = join(process.env.APPDATA ?? '', 'dsh-desktop')
const dshHome = join(process.env.USERPROFILE ?? '', '.dsh')
const runtimeRoot = resolveManagedDshRuntimeRoot({
  userProfile: process.env.USERPROFILE,
  userData,
})
const snapshotRoot = join(process.env.USERPROFILE ?? '', '.dsh-desktop-snapshots')

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

function activeState() {
  return JSON.parse(readFileSync(join(runtimeRoot, 'release-state', 'active.json'), 'utf8'))
}

function activeProfile() {
  const state = activeState()
  const manifestPath = join(runtimeRoot, 'candidates', state.releaseId, 'profile', 'package.json')
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function activePluginState() {
  const profile = activeProfile()
  return {
    dependencies: profile.dependencies ?? {},
    bundles: profile.dsh?.profile?.bundles ?? [],
  }
}

function stagedCandidate() {
  const path = join(runtimeRoot, 'release-state', 'plugin-candidate.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function candidatePluginState(candidateId) {
  const manifestPath = join(runtimeRoot, 'candidates', candidateId, 'profile', 'package.json')
  const profile = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return {
    dependencies: profile.dependencies ?? {},
    bundles: profile.dsh?.profile?.bundles ?? [],
  }
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
  createSnapshotStore: (options, root) => new SnapshotStore(options, root),
})

async function activate(label, expectedCandidateId) {
  const switched = await controller.restartPluginChanges(label)
  if (switched?.status !== 'switched' || switched?.pointer?.releaseId !== expectedCandidateId) {
    throw new Error(`${label} did not activate ${expectedCandidateId}: ${JSON.stringify(switched)}`)
  }
  process.stdout.write(`[activated] ${label}: ${expectedCandidateId}\n`)
}

async function stageAndActivate(label, operation) {
  const staged = await operation()
  if (staged?.ok !== true) throw new Error(`${label} failed: ${staged?.error ?? 'unknown error'}`)
  const candidateId = staged.report?.candidateId ?? staged.report?.candidate?.id
  if (typeof candidateId !== 'string') throw new Error(`${label} returned no candidate id`)
  await activate(label, candidateId)
}

async function installNewPetDisabled() {
  const current = activePluginState()
  if (current.dependencies[NEW_PET] === NEW_PET_VERSION && !current.bundles.includes(NEW_PET)) return
  const source = { type: 'npm', package: NEW_PET, versionOrTag: NEW_PET_VERSION }
  if (typeof current.dependencies[NEW_PET] === 'string') {
    await stageAndActivate('update-new-pet-disabled', () => controller.pluginTransaction({
      action: 'replaceSource',
      name: NEW_PET,
      source,
      enabled: false,
    }))
    return
  }
  await stageAndActivate('install-new-pet-disabled', () => controller.pluginInstallMany({
    sources: [{ name: NEW_PET, source, enabled: false }],
  }, {
    onProgress: value => process.stdout.write(`[progress] ${JSON.stringify(value)}\n`),
  }))
}

async function resumeStagedPetInstall() {
  const staged = stagedCandidate()
  if (staged === undefined) return
  const candidate = candidatePluginState(staged.candidateId)
  const expected = candidate.dependencies[NEW_PET] === NEW_PET_VERSION
    && !candidate.bundles.includes(NEW_PET)
    && typeof candidate.dependencies[OLD_PET] === 'string'
    && candidate.bundles.includes(OLD_PET)
  if (!expected) {
    throw new Error(`An unrelated plugin candidate is already staged: ${JSON.stringify({ staged, candidate })}`)
  }
  await activate('resume-new-pet-disabled', staged.candidateId)
}

async function removeOldPet() {
  const current = activePluginState()
  if (typeof current.dependencies[OLD_PET] !== 'string') return
  const preview = await controller.pluginRemovePreview({ name: OLD_PET })
  if (preview?.ok !== true) throw new Error(`Could not preview ${OLD_PET} removal: ${preview?.error ?? 'unknown error'}`)
  if ((preview.preview?.dependentPackages?.length ?? 0) > 0 || (preview.preview?.dependentBundles?.length ?? 0) > 0) {
    throw new Error(`${OLD_PET} still has dependants: ${JSON.stringify({
      packages: preview.preview.dependentPackages,
      bundles: preview.preview.dependentBundles,
    })}`)
  }
  await stageAndActivate('remove-old-pet', () => controller.pluginConfirmRemove({
    name: OLD_PET,
    previewDigest: preview.preview.previewDigest,
    confirmationToken: preview.preview.confirmationToken,
    candidateId: preview.preview.candidateId,
    candidatePath: preview.preview.candidatePath,
  }))
}

async function enableNewPet() {
  const current = activePluginState()
  if (current.bundles.includes(NEW_PET)) return
  await stageAndActivate('enable-new-pet', () => controller.pluginTransaction({
    action: 'setEnabled',
    name: NEW_PET,
    enabled: true,
  }))
}

try {
  let recoveryOnly = false
  const recovery = await controller.recoverPendingRelease()
  if (recovery?.status !== 'idle') {
    process.stdout.write(`[recovery] ${JSON.stringify(recovery)}\n`)
    const settled = await controller.recoverPendingRelease()
    if (settled?.status !== 'idle') throw new Error(`Release recovery must settle before pet replacement: ${JSON.stringify(settled)}`)
    recoveryOnly = true
  }

  if (recoveryOnly) {
    process.stdout.write('[recovery] Release state is settled. Run this script once more to perform the pet replacement.\n')
  } else {
    await resumeStagedPetInstall()
    process.stdout.write(`[before] ${JSON.stringify({ releaseId: activeState().releaseId, ...activePluginState() })}\n`)
    await installNewPetDisabled()
    await removeOldPet()
    await enableNewPet()

    const final = activePluginState()
    if (final.dependencies[NEW_PET] !== NEW_PET_VERSION
      || !final.bundles.includes(NEW_PET)
      || typeof final.dependencies[OLD_PET] === 'string'
      || final.bundles.includes(OLD_PET)) {
      throw new Error(`Pet replacement did not converge: ${JSON.stringify(final)}`)
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      releaseId: activeState().releaseId,
      installed: { [NEW_PET]: final.dependencies[NEW_PET] },
      removed: [OLD_PET],
      enabled: final.bundles.includes(NEW_PET),
    }, undefined, 2)}\n`)
  }
} finally {
  await controller.shutdown(new Error('Desktop pet replacement complete'))
}
