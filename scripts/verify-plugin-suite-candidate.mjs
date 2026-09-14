import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesktopRuntimeController } from '../src/desktop-runtime-controller.js'
import { prepareHarnessToolchain } from '../src/desktop-integration.js'
import { readActiveDshRuntime } from '../src/dsh-runtime.js'
import { DESKTOP_PLUGIN_SUITE, DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS, pluginSuiteInstallSources } from '../src/plugin-suite.js'
import { SnapshotStore } from '../src/release/snapshot-store.js'
import { createStableSupervisor } from '../src/runtime/stable-supervisor.js'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
const reusedRoot = process.env.DSH_SUITE_SMOKE_REUSE_ROOT
if (reusedRoot && !safeTemporaryRoot(reusedRoot)) throw new Error('Invalid isolated smoke reuse directory')
const temporaryRoot = reusedRoot ? resolve(reusedRoot) : await mkdtemp(join(tmpdir(), 'dsh-plugin-suite-smoke-'))
const userData = join(temporaryRoot, 'userdata')
const runtimeRoot = join(temporaryRoot, 'runtime')
const snapshotRoot = join(temporaryRoot, 'snapshots')
const keep = Boolean(reusedRoot) || process.argv.includes('--keep')

// This real smoke runs alongside the installed app; never compete for 3080.
async function isolatedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

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
  return join(dirname(resolveBundledDshManifest()), 'lib', 'bin.js')
}

function safeTemporaryRoot(path) {
  const root = resolve(tmpdir())
  const target = resolve(path)
  const remainder = relative(root, target)
  return isAbsolute(target) && remainder !== '' && !remainder.startsWith('..') && target.includes('dsh-plugin-suite-smoke-')
}

const pnpmEntry = resolvePnpmEntry()
const initialRuntime = readActiveDshRuntime({ runtimeRoot, bundledManifestPath: resolveBundledDshManifest() })
const runtimeEnvironment = prepareHarnessToolchain({
  directory: join(userData, 'toolchain'),
  execPath: process.execPath,
  pnpmEntry,
  env: process.env,
})
const app = {
  getAppPath: () => repositoryRoot,
  getPath: name => name === 'downloads' ? join(temporaryRoot, 'downloads') : temporaryRoot,
  getVersion: () => packageJson.version,
  isPackaged: true,
}
const maintenanceWindow = Symbol('suite-smoke-workspace')
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
  observeDuration: 3_000,
  observePollInterval: 100,
  effects: { writeLog: (source, value) => process.stdout.write(`[${source}] ${value}`) },
  runtime: {
    createStableSupervisor: options => createStableSupervisor({ ...options, portAllocator: isolatedPort }),
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
  const reusedBaseId = process.env.DSH_SUITE_SMOKE_BASE_ID
  if (reusedBaseId && !/^stable-[a-f0-9-]+$/.test(reusedBaseId)) throw new Error('Invalid isolated base candidate')
  const prepared = reusedBaseId ? { releaseId: reusedBaseId } : await controller.prepareCandidate('stable', {
    onProgress: value => process.stdout.write(`[base-progress] ${JSON.stringify(value)}\n`),
  })
  const baseCandidateId = prepared?.releaseId ?? prepared?.manifest?.releaseId
  if (typeof baseCandidateId !== 'string') throw new Error('Base suite smoke candidate was not prepared')
  const baseSwitch = await controller.switchCandidate(baseCandidateId)
  if (baseSwitch?.status !== 'switched') throw new Error(`Base suite smoke candidate did not activate: ${JSON.stringify(baseSwitch)}`)

  const recommendations = DESKTOP_PLUGIN_SUITE.map(entry => entry.id)
  const selected = pluginSuiteInstallSources(recommendations, { repositoryRoot })
  const staged = await controller.pluginInstallMany({
    sources: selected.map(entry => ({ name: entry.packageName, source: entry.source, enabled: true })),
    buildPermissions: { ...DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS },
  }, {
    onProgress: value => process.stdout.write(`[suite-progress] ${JSON.stringify(value)}\n`),
  })
  if (staged?.ok !== true) throw new Error(`Plugin suite smoke transaction failed: ${staged?.error ?? 'unknown error'}`)
  const candidateId = staged.report?.candidateId
  if (typeof candidateId !== 'string') throw new Error('Plugin suite smoke transaction returned no candidate')
  const switched = await controller.restartPluginChanges('plugin-suite-smoke')
  if (switched?.status !== 'switched' || switched?.pointer?.releaseId !== candidateId) {
    throw new Error(`Plugin suite smoke candidate did not activate: ${JSON.stringify(switched)}`)
  }

  const profilePath = join(runtimeRoot, 'candidates', candidateId, 'profile', 'package.json')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  const missing = DESKTOP_PLUGIN_SUITE.map(entry => entry.packageName).filter(name => typeof profile.dependencies?.[name] !== 'string')
  if (missing.length > 0) throw new Error(`Plugin suite smoke profile is missing: ${missing.join(', ')}`)
  if (profile.dependencies['dsh-signal'] !== '0.6.12') {
    throw new Error('Plugin suite smoke did not pin the published Signal npm version')
  }
  process.stdout.write(`${JSON.stringify({ ok: true, temporaryRoot, baseCandidateId, candidateId, pluginCount: DESKTOP_PLUGIN_SUITE.length }, null, 2)}\n`)
} finally {
  await controller.shutdown(new Error('Plugin suite smoke complete'))
  if (!keep) {
    if (!safeTemporaryRoot(temporaryRoot)) throw new Error(`Refusing to remove unsafe suite smoke directory: ${temporaryRoot}`)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
