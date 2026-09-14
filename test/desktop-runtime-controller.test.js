import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS } from '../src/diagnostics.js'
import {
  assertPluginCandidateProfile,
  buildWindowsDoctorSupervisorCleanupCommand,
  createDesktopRuntimeController,
  defaultDesktopSnapshotExclusions,
  defaultDesktopSnapshotRoot,
  ensureCandidateDesktopIntegration,
  ensureCandidateDshAgyLinkRuntimeCompatibility,
  ensureCandidateDshDoctorRuntimeCompatibility,
  ensureCandidateDshFreeSearchRuntimeCompatibility,
  ensureCandidateDshSignalRuntimeCompatibility,
  ensureCandidateDshSttInputRuntimeCompatibility,
  ensureCandidatePluginRuntimeCompatibility,
  patchDshAgyLinkWindowsCredential,
  patchDshFreeSearchDesktopUpdate,
  patchDshDoctorFutureServiceInstall,
  patchDshSignalDesktopBrandObserver,
  patchDshSttInputBrowserSession,
  upgradeLegacyDshAgyLinkWindowsCredential,
} from '../src/desktop-runtime-controller.js'
import { createManagedReleaseManifest, releaseManifestSha256, serializeReleaseManifest } from '../src/release/manifest.js'
import { ReleaseStateStore } from '../src/release/state-store.js'
import { SnapshotStore } from '../src/release/snapshot-store.js'

const fixtureUserProfile = process.platform === 'win32' ? 'C:\\Users\\tester' : '/Users/tester'

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

test('default desktop snapshots are a sibling of user data, never nested inside it', () => {
  const dataRoot = join(fixtureUserProfile, 'AppData', 'Roaming', 'dsh-desktop')
  assert.equal(
    defaultDesktopSnapshotRoot(dataRoot),
    join(fixtureUserProfile, 'AppData', 'Roaming', '.dsh-desktop-snapshots'),
  )
  const dshHome = join(fixtureUserProfile, '.dsh')
  assert.equal(
    defaultDesktopSnapshotRoot(dshHome),
    join(fixtureUserProfile, '.dsh-snapshots'),
  )
})

test('default desktop snapshots exclude derived runtime and Electron cache trees', () => {
  const dataRoot = join(fixtureUserProfile, 'AppData', 'Roaming', 'dsh-desktop')
  const runtimeRoot = join(dataRoot, 'dsh-runtime')
  const exclusions = defaultDesktopSnapshotExclusions(dataRoot, runtimeRoot)
  assert.equal(exclusions.includes('dsh-runtime'), true)
  assert.equal(exclusions.includes('toolchain'), true)
  assert.equal(exclusions.includes('electron'), true)
  assert.equal(exclusions.includes('Cache'), true)
  assert.equal(exclusions.includes('profiles/node_modules'), true)
  assert.equal(exclusions.includes('desktop-settings.json'), false)

  const migratedRuntimeExclusions = defaultDesktopSnapshotExclusions(
    dataRoot,
    'C:\\Users\\tester\\.dsh-desktop-runtime',
  )
  assert.equal(migratedRuntimeExclusions.includes('dsh-runtime'), true)
  const parentRuntime = resolve('snapshot-runtime-fixture')
  const independentData = join(parentRuntime, 'user-data')
  assert.equal(defaultDesktopSnapshotExclusions(independentData, parentRuntime).includes('..'), false)
  assert.equal(defaultDesktopSnapshotExclusions(independentData, independentData).includes(''), false)
  assert.equal(defaultDesktopSnapshotExclusions(independentData, join(independentData, 'nested-runtime')).includes('nested-runtime'), true)
})

test('independent user-data snapshots accept runtime parent and restore only user files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-parent-runtime-snapshot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'user-data')
  mkdirSync(sourceRoot)
  writeFileSync(join(root, 'runtime-marker.txt'), 'keep runtime')
  writeFileSync(join(sourceRoot, 'session.txt'), 'original session')
  const store = new SnapshotStore({ sourceRoot, snapshotRoot: join(root, 'snapshots'), excludedRelativePaths: defaultDesktopSnapshotExclusions(sourceRoot, root) })
  await store.create({ snapshotId: 'pre-plugin-update' })
  writeFileSync(join(sourceRoot, 'session.txt'), 'changed session')
  await store.restore({ snapshotId: 'pre-plugin-update' })
  assert.equal(readFileSync(join(sourceRoot, 'session.txt'), 'utf8'), 'original session')
  assert.equal(readFileSync(join(root, 'runtime-marker.txt'), 'utf8'), 'keep runtime')
})

test('plugin candidate profile consistency requires the exact completed transaction on disk', () => {
  const expectedProfile = {
    name: 'stable-profile',
    dependencies: {
      dshmarket: '1.26.0',
      'dsh-at-file': 'github:omdsh-dev/dsh-at-file#c37b0ed9e8bf3585bf9f272462dcf01886efe2a3',
    },
    dsh: { profile: { bundles: ['dshmarket', 'dsh-at-file'] } },
  }
  const actualProfile = {
    dsh: { profile: { bundles: ['dshmarket', 'dsh-at-file'] } },
    dependencies: {
      'dsh-at-file': 'github:omdsh-dev/dsh-at-file#c37b0ed9e8bf3585bf9f272462dcf01886efe2a3',
      dshmarket: '1.26.0',
    },
    name: 'stable-profile',
  }

  assert.doesNotThrow(() => assertPluginCandidateProfile({
    actualProfile,
    expectedProfile,
    action: 'installMany',
    additions: [
      { packageName: 'dshmarket', source: { type: 'npm', version: '1.26.0', specifier: 'dshmarket@1.26.0' } },
      { packageName: 'dsh-at-file', source: { type: 'github', specifier: 'github:omdsh-dev/dsh-at-file#c37b0ed9e8bf3585bf9f272462dcf01886efe2a3' } },
    ],
  }))

  assert.throws(
    () => assertPluginCandidateProfile({
      actualProfile: { ...actualProfile, dependencies: { ...actualProfile.dependencies, dshmarket: 'dshmarket@1.26.0' } },
      expectedProfile,
      action: 'installMany',
      additions: [{ packageName: 'dshmarket', source: { type: 'npm', version: '1.26.0', specifier: 'dshmarket@1.26.0' } }],
    }),
    error => error?.code === 'PLUGIN_CANDIDATE_PROFILE_MISMATCH',
  )

  assert.throws(
    () => assertPluginCandidateProfile({
      actualProfile,
      action: 'remove',
      packageName: 'dshmarket',
      additions: [],
    }),
    error => error?.code === 'PLUGIN_CANDIDATE_PROFILE_MISMATCH',
  )
})

const COPY = {
  preparing: 'Preparing',
  preparingPlugins: 'Preparing plugins',
  loading: 'Loading',
  loadingServices: 'Loading services',
  openingWorkspace: 'Opening workspace',
  ready: 'Ready',
  restarting: 'Restarting',
  startupFailed: 'Startup failed',
  stopped: 'Stopped',
  dshRollback: 'Rollback',
  dshRollbackTitle: 'Rollback complete',
  dshRollbackMessage: version => `Rolled back ${version}`,
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createWindowFake() {
  const windows = {
    workspace: { destroyed: false, visible: false },
    management: { destroyed: false, visible: true },
  }
  const routes = []
  const loaded = []
  const fallbackPages = []
  const loadingScripts = []
  return {
    windows,
    routes,
    loaded,
    fallbackPages,
    loadingScripts,
    getWindow: role => windows[role],
    isOpen: value => {
      const window = typeof value === 'string' ? windows[value] : value
      return window?.destroyed === false
    },
    isVisible: value => {
      const window = typeof value === 'string' ? windows[value] : value
      return window?.visible === true
    },
    show: value => {
      const window = typeof value === 'string' ? windows[value] : value
      if (window) window.visible = true
      return true
    },
    create: role => {
      windows[role] ??= { destroyed: false, visible: false }
      return windows[role]
    },
    managementRendererAvailable: () => true,
    loadManagementRoute: async (route, data) => {
      routes.push({ route, data })
      return true
    },
    loadWorkspace: async url => { loaded.push(url) },
    reveal: () => true,
    currentLoadingWindow: () => windows.management,
    loadFallbackPage: async (...args) => { fallbackPages.push(args); return true },
    executeLoadingScript: async (...args) => { loadingScripts.push(args); return true },
  }
}

function createRuntime(overrides = {}) {
  const window = overrides.window ?? createWindowFake()
  const logs = []
  const statusChanges = []
  const app = {
    isPackaged: false,
    getVersion: () => '1.0.0',
    getPath: name => name === 'home' ? '/home' : '/downloads',
  }
  const processAdapter = overrides.process ?? {
    execPath: 'node',
    platform: 'linux',
    arch: 'x64',
    env: {},
  }
  const servers = overrides.servers ?? []
  let serverIndex = 0
  const controller = createDesktopRuntimeController({
    window,
    copy: COPY,
    app,
    process: processAdapter,
    modeSupervisor: overrides.modeSupervisor,
    runtime: {
      app,
      process: processAdapter,
      env: {},
      dshHome: overrides.dshHome,
      runtimeRoot: overrides.runtimeRoot,
      initialRuntime: overrides.initialRuntime,
      resolveDshEntry: overrides.resolveDshEntry ?? (() => '/bundled/lib/bin.js'),
      resolvePnpmEntry: () => '/bundled/pnpm.mjs',
      getDownloadsDirectory: () => '/downloads',
      stableConfig: overrides.stableConfig,
      devConfig: overrides.devConfig,
      ...overrides.runtime,
    },
    createServer: options => {
      const server = servers[serverIndex++] ?? new FakeServer(options)
      server.options = options
      return server
    },
    createInstallerUpdate: overrides.createInstallerUpdate,
    createDshUpdate: overrides.createDshUpdate,
    createCandidateBuilder: overrides.createCandidateBuilder,
    releaseStateStore: overrides.releaseStateStore,
    releaseOwnership: overrides.releaseOwnership,
    snapshotStore: overrides.snapshotStore,
    releaseSwitcher: overrides.releaseSwitcher,
    dialog: overrides.dialog,
    createReleaseStateStore: overrides.createReleaseStateStore,
    createSnapshotStore: overrides.createSnapshotStore,
    createReleaseSwitcher: overrides.createReleaseSwitcher,
    observeRelease: overrides.observeRelease,
    observeDuration: overrides.observeDuration,
    observePollInterval: overrides.observePollInterval,
    releaseNow: overrides.releaseNow,
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
    effects: {
      notify: () => statusChanges.push(controller?.statusSnapshot?.()),
      writeLog: (source, text) => logs.push({ source, text }),
      clearWorkspaceContext: () => {},
      getLanguage: () => 'en',
      ...overrides.effects,
    },
    plugins: overrides.plugins,
    owners: overrides.owners,
  })
  return { controller, window, logs, statusChanges }
}

class FakeServer extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.stops = 0
    this.started = deferred()
  }

  start() {
    return this.started.promise
  }

  async stop() {
    this.stops += 1
  }
}

function ready(server, port) {
  server.started.resolve(`http://127.0.0.1:${String(port)}/`)
}

function initializeWithUpdates(overrides = {}) {
  const timers = []
  const cleared = []
  const update = {
    state: 'idle',
    initialize: () => true,
    check: async () => {},
    menuItem: () => ({ label: 'Check', enabled: true }),
    abort: () => {},
    busy: false,
    checkAvailable: true,
    supported: true,
    externalReleaseAvailable: false,
    progress: 0,
    downloadedPath: undefined,
    targetVersion: undefined,
  }
  const dsh = {
    state: 'idle',
    runtime: overrides.initialRuntime ?? { version: '1.0.0', source: 'bundled', entry: '/bundled/lib/bin.js', bundled: { version: '1.0.0' } },
    check: async () => {},
    restoreBundled: async () => {},
    useBundledFallback: () => false,
    menuItem: () => ({ label: 'Check DSH', enabled: true }),
    restoreItem: () => undefined,
    abort: () => {},
    busy: false,
    checkAvailable: true,
    probe: async () => overrides.dshProbeResult ?? ({ available: false, currentVersion: '1.0.0', latestVersion: '1.0.0' }),
    managedRestoreAvailable: false,
    restoreAvailable: false,
  }
  const setup = createRuntime({
    ...overrides,
    initialRuntime: dsh.runtime,
    createInstallerUpdate: overrides.createInstallerUpdate ?? (() => update),
    createDshUpdate: () => dsh,
    setTimeoutImpl: callback => {
      const timer = { callback, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeoutImpl: timer => cleared.push(timer),
  })
  setup.controller.initializeUpdates()
  return { ...setup, update, dsh, timers, cleared }
}

test('manual DSH update check reports an explicit up-to-date result in Chinese', async t => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'dsh-controller-update-check-'))
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }))
  const messages = []
  const setup = initializeWithUpdates({
    runtimeRoot,
    dshProbeResult: { available: false, currentVersion: '0.1.1-rc.2', latestVersion: '0.1.1-rc.2' },
    effects: { getLanguage: () => 'zh-CN' },
    dialog: {
      showMessageBox: async (_window, options) => {
        messages.push(options)
        return { response: 0 }
      },
    },
  })

  const result = await setup.controller.checkDshUpdate(true)
  assert.deepEqual(result, { available: false, currentVersion: '0.1.1-rc.2', latestVersion: '0.1.1-rc.2' })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].title, 'DSH 已是最新版本')
  assert.match(messages[0].message, /0\.1\.1-rc\.2/)
})

function releasePointer(releaseId, manifestSha256) {
  return {
    schemaVersion: 1,
    releaseId,
    manifestSha256,
    activatedAt: '2026-08-22T00:00:00.000Z',
  }
}

function materializeCandidate(root, releaseId, version = '2.0.0', manifestReleaseId = releaseId, bundles = [], dependencies = {}) {
  const candidate = join(root, 'candidates', releaseId)
  const profile = join(candidate, 'profile')
  const entry = join(candidate, 'runtime', 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(profile, { recursive: true })
  const packageText = JSON.stringify({
    name: `ricardo-stable-${releaseId}`,
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies: { ...dependencies } }),
    ...(bundles.length === 0 ? {} : { dsh: { profile: { bundles: [...bundles] } } }),
  })
  const lockText = 'lockfileVersion: "9.0"\nimporters:\n  .: {}\n'
  const patchText = '- id: web\n'
  writeFileSync(join(profile, 'package.json'), packageText)
  writeFileSync(join(profile, 'pnpm-lock.yaml'), lockText)
  writeFileSync(join(profile, 'cordis.patch.yml'), patchText)
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'bin.js'), 'candidate')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const manifest = createManagedReleaseManifest({
    releaseId: manifestReleaseId,
    channel: 'stable',
    desktopVersion: '1.0.0',
    dshVersion: version,
    dshIntegrity: 'sha512-dGVzdA==',
    profile: {
      logicalName: 'web',
      physicalName: `ricardo-stable-${releaseId}`,
      manifestSha256: sha256(packageText),
      lockSha256: sha256(lockText),
      patchSha256: sha256(patchText),
    },
    bundles: [],
    clientArtifacts: [],
    compatibility: {
      suiteVersion: 'test-suite',
      reportSha256: 'c'.repeat(64),
      passed: true,
    },
    createdAt: '2026-08-22T00:00:00.000Z',
  })
  writeFileSync(join(candidate, 'manifest.json'), serializeReleaseManifest(manifest))
  return { candidate, manifest, manifestSha256: releaseManifestSha256(manifest) }
}

test('candidate desktop integration is idempotent across concurrent desktop owners', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-integration-race-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  const sourceRoot = join(repository, 'src', 'plugins', 'dsh-desktop-integration')
  const candidate = join(root, 'candidates', 'stable-concurrent')
  mkdirSync(join(sourceRoot, 'lib'), { recursive: true })
  mkdirSync(candidate, { recursive: true })
  const expected = new Map([
    ['package.json', '{"name":"@dsh-desktop/integration"}\n'],
    ['lib/index.js', 'export function apply() {}\n'],
    ['lib/client.js', 'export default {}\n'],
  ])
  for (const [file, content] of expected) {
    mkdirSync(join(sourceRoot, file, '..'), { recursive: true })
    writeFileSync(join(sourceRoot, file), content)
  }

  await Promise.all(Array.from({ length: 12 }, () => ensureCandidateDesktopIntegration(candidate, repository)))
  const targetRoot = join(candidate, 'profiles', 'node_modules', '@dsh-desktop', 'integration')
  for (const [file, content] of expected) assert.equal(readFileSync(join(targetRoot, file), 'utf8'), content)

  writeFileSync(join(targetRoot, 'package.json'), 'stale')
  rmSync(join(targetRoot, 'lib', 'client.js'))
  await Promise.all(Array.from({ length: 12 }, () => ensureCandidateDesktopIntegration(candidate, repository)))
  for (const [file, content] of expected) assert.equal(readFileSync(join(targetRoot, file), 'utf8'), content)
  const leftovers = readdirSync(targetRoot, { recursive: true }).filter(entry => String(entry).includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('candidate plugin compatibility repairs better-dsh-pet launch and topmost behavior idempotently', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-pet-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-pet')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'better-dsh-pet')
  const launcher = join(packageRoot, 'lib', 'pet-helper-process.js')
  const windowMain = join(packageRoot, 'runtime', 'electron-helper', 'main.js')
  mkdirSync(join(launcher, '..'), { recursive: true })
  mkdirSync(join(windowMain, '..'), { recursive: true })
  writeFileSync(launcher, [
    "import { spawn } from 'node:child_process'",
    'function start() {',
    '  const child = spawn(command, args, {',
    '    cwd: packageRoot,',
    '    env: { ...process.env, ...this.options.env },',
    "    stdio: ['ignore', 'pipe', 'pipe'],",
    '  })',
    '  return child',
    '}',
    '',
  ].join('\n'))
  writeFileSync(windowMain, [
    'function createWindow() {',
    "  mainWindow.once('ready-to-show', () => {",
    '    mainWindow.show()',
    '  })',
    '}',
    'function checkFullscreenAndHide() {',
    '  const fullscreen = isFullscreenRect(rect)',
    '  const shouldHide = fullscreen && shouldAutoHideForProcess(rect?.processName)',
    '}',
    '',
  ].join('\n'))

  const audit = await ensureCandidatePluginRuntimeCompatibility(candidate, profile, undefined, { write: false })
  assert.equal(audit.state, 'patched')
  assert.deepEqual(audit.targets.map(target => target.state), ['patched', 'patched'])
  assert.doesNotMatch(readFileSync(launcher, 'utf8'), /delete childEnv\.ELECTRON_RUN_AS_NODE/)
  assert.doesNotMatch(readFileSync(windowMain, 'utf8'), /DSH_DESKTOP_KEEP_PET_VISIBLE/)

  const first = await ensureCandidatePluginRuntimeCompatibility(candidate, profile)
  const second = await ensureCandidatePluginRuntimeCompatibility(candidate, profile)
  const patchedLauncher = readFileSync(launcher, 'utf8')
  const patchedWindow = readFileSync(windowMain, 'utf8')
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.deepEqual(first.targets.map(target => target.state), ['patched', 'patched'])
  assert.match(patchedLauncher, /const childEnv = \{ \.\.\.process\.env, \.\.\.this\.options\.env \}/)
  assert.match(patchedLauncher, /delete childEnv\.ELECTRON_RUN_AS_NODE/)
  assert.match(patchedLauncher, /env: childEnv/)
  assert.doesNotMatch(patchedLauncher, /env:\s*\{\s*\.\.\.process\.env/)
  assert.match(patchedWindow, /mainWindow\.showInactive\(\)/)
  assert.match(patchedWindow, /mainWindow\.setAlwaysOnTop\(true, 'screen-saver'\)/)
  assert.match(patchedWindow, /mainWindow\.moveTop\(\)/)
  assert.match(patchedWindow, /const shouldHide = false \/\/ DSH_DESKTOP_KEEP_PET_VISIBLE/)
  assert.doesNotMatch(patchedWindow, /const shouldHide = fullscreen && shouldAutoHideForProcess/)
})

test('candidate plugin compatibility is a no-op when better-dsh-pet is absent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-no-pet-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-no-pet')
  const profile = join(candidate, 'profiles', 'physical-stable')
  mkdirSync(profile, { recursive: true })
  const result = await ensureCandidatePluginRuntimeCompatibility(candidate, profile)
  assert.equal(result.state, 'absent')
  assert.deepEqual(result.targets, [])
})

test('candidate Signal compatibility bounds brand self-healing to animation frames and relevant mutations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-signal-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-signal')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'dsh-signal')
  const targetPath = join(packageRoot, 'lib', 'client.js')
  const upstream = [
    'function SignalMark() {',
    '  let disposed = false',
    '  let reconcileQueued = false',
    '  let mount = null',
    '  const reconcileBrandFx = () => {',
    '    reconcileFrame = 0',
    '  }',
    '  const scheduleReconcile = () => {',
    '    if (disposed || reconcileQueued) return',
    '    reconcileQueued = true',
    '    queueMicrotask(() => {',
    '      reconcileQueued = false',
    '      reconcileBrandFx()',
    '    })',
    '  }',
    '  reconcileBrandFx()',
    '  const integrityObserver = new MutationObserver(scheduleReconcile)',
    '  integrityObserver.observe(document.body, { childList: true, subtree: true, characterData: true })',
    '  return () => {',
    '    disposed = true',
    '    integrityObserver.disconnect()',
    '    mount?.stop()',
    '    mount = null',
    '  }',
    '}',
    '',
  ].join('\n')
  const patched = patchDshSignalDesktopBrandObserver(upstream)
  assert.equal(patched.state, 'patched')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const options = {
    targets: {
      '0.5.10': {
        upstreamSha256: sha256(upstream),
        patchedSha256: sha256(patched.source),
      },
    },
  }
  mkdirSync(join(targetPath, '..'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-signal', version: '0.5.10' }))
  writeFileSync(targetPath, upstream)

  const first = await ensureCandidateDshSignalRuntimeCompatibility(candidate, profile, options)
  const second = await ensureCandidateDshSignalRuntimeCompatibility(candidate, profile, options)
  const compatibleSource = readFileSync(targetPath, 'utf8')
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.match(compatibleSource, /DSH_DESKTOP_BOUNDED_BRAND_RECONCILE/)
  assert.match(compatibleSource, /records\.some\(mutationAffectsBrand\)/)
  assert.match(compatibleSource, /window\.requestAnimationFrame\(reconcileBrandFx\)/)
  assert.match(compatibleSource, /window\.cancelAnimationFrame\(reconcileFrame\)/)
  assert.doesNotMatch(compatibleSource, /let reconcileQueued = false/)
  assert.doesNotMatch(compatibleSource, /new MutationObserver\(scheduleReconcile\)/)

  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-signal', version: '0.5.12' }))
  writeFileSync(targetPath, upstream)
  const unsafeFuture = await ensureCandidateDshSignalRuntimeCompatibility(candidate, profile, { targets: {} })
  assert.equal(unsafeFuture.state, 'unrecognized')
  assert.equal(readFileSync(targetPath, 'utf8'), upstream)

  const safeFuture = 'const integrityObserver = new MutationObserver(records => records.length)\n'
  writeFileSync(targetPath, safeFuture)
  const compatibleFuture = await ensureCandidateDshSignalRuntimeCompatibility(candidate, profile, { targets: {} })
  assert.equal(compatibleFuture.state, 'compatible')
  assert.equal(readFileSync(targetPath, 'utf8'), safeFuture)
})

test('candidate STT compatibility keeps browser recognition alive until an explicit stop', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-stt-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-stt')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'dsh-stt-input')
  const targetPath = join(packageRoot, 'lib', 'client.js')
  const upstream = [
    '    var activeRec = null;',
    '    function startRecording(inputActions, base, cfg) {',
    '      recStartedAt = Date.now();',
    "      if (cfg.engine === 'browser') {",
    '        var SR = browserSR();',
    '        if (!SR) {',
    "          setStatus({ kind: 'error', msg: T('err.browserUnsupported') });",
    '          return;',
    '        }',
    '        var rec = new SR();',
    '        rec.start();',
    '        activeRec = rec;',
    '      } else {',
    '        startApi();',
    '      }',
    '    }',
    '',
    '    function stopRecording(inputActions, base, cfg) {',
    '      var rec = activeRec;',
    '      activeRec = null;',
    '      if (!rec) return;',
    '      try { rec.stop(); } catch (e) {',
    "        if (cfg.engine === 'api') finalizeApi(inputActions, base, cfg);",
    "        else setStatus({ kind: 'error', msg: T('err.stopFailed') });",
    '      }',
    '    }',
  ].join('\n')
  const patched = patchDshSttInputBrowserSession(upstream)
  assert.equal(patched.state, 'patched')
  assert.match(patched.source, /DSH_DESKTOP_STT_RESILIENT_BROWSER_SESSION/)
  assert.match(patched.source, /activeBrowserStop = session\.stop/)
  assert.match(patched.source, /scheduleRestart\(\)/)
  assert.doesNotThrow(() => new vm.Script(patched.source))
  const recognizers = []
  let draft = ''
  let speechStatus
  class Recognition {
    constructor() { recognizers.push(this) }
    start() {}
    stop() { this.onend?.() }
  }
  const speech = vm.createContext({
    browserSR: () => Recognition, navigator: { language: 'zh-CN' },
    setTimeout: () => 1, clearTimeout: () => {},
    setStatus: status => { speechStatus = status }, T: (key, values) => values?.err || key,
    applyText: (_actions, base, text) => { draft = text ? `${base} ${text}`.trim() : base },
  })
  new vm.Script(patched.source).runInContext(speech)
  speech.startRecording({}, '保留草稿', { engine: 'browser', language: 'auto' })
  const interim = [{ transcript: '语音文字' }]
  interim.isFinal = false
  recognizers.at(-1).onresult({ results: [interim] })
  speech.stopRecording({}, '保留草稿', { engine: 'browser' })
  assert.equal(draft, '保留草稿 语音文字', 'stopping must preserve interim text')
  speech.startRecording({}, draft, { engine: 'browser', language: 'auto' })
  recognizers.at(-1).onerror({ error: 'network' })
  assert.equal(speechStatus.kind, 'error', 'network errors must not silently restart forever')
  speech.startRecording({}, draft, { engine: 'browser', language: 'auto' })
  speech.stopRecording({}, draft, { engine: 'browser' })
  assert.equal(speechStatus.kind, 'error', 'empty recognition must report no result')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const options = {
    targets: {
      '0.1.0': {
        upstreamSha256: sha256(upstream),
        patchedSha256: sha256(patched.source),
      },
    },
  }
  mkdirSync(join(targetPath, '..'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-stt-input', version: '0.1.0' }))
  writeFileSync(targetPath, upstream)

  const first = await ensureCandidateDshSttInputRuntimeCompatibility(candidate, profile, options)
  const second = await ensureCandidateDshSttInputRuntimeCompatibility(candidate, profile, options)
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.match(readFileSync(targetPath, 'utf8'), /DSH_DESKTOP_STT_RESILIENT_BROWSER_SESSION/)
  assert.match(readFileSync(targetPath, 'utf8'), /not-allowed.*service-not-allowed.*audio-capture/)

  writeFileSync(targetPath, 'future STT layout\n')
  const unknown = await ensureCandidateDshSttInputRuntimeCompatibility(candidate, profile, options)
  assert.equal(unknown.state, 'unrecognized')
  assert.equal(readFileSync(targetPath, 'utf8'), 'future STT layout\n')
})

test('candidate free-search compatibility blocks unsafe in-place self-update only for audited bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-free-search-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-free-search')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'dsh-free-search')
  const targetPath = join(packageRoot, 'lib', 'index.js')
  const upstream = [
    'var Service = class {',
    '    async updatePlugin() {',
    '      const mode = detectInstallMode();',
    '      return mode;',
    '    }',
    '};',
    '',
  ].join('\n')
  const patched = patchDshFreeSearchDesktopUpdate(upstream)
  assert.equal(patched.state, 'patched')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const options = {
    targets: {
      '0.4.16': {
        upstreamSha256: sha256(upstream),
        patchedSha256: sha256(patched.source),
      },
    },
  }
  mkdirSync(join(targetPath, '..'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-free-search', version: '0.4.16' }))
  writeFileSync(targetPath, upstream)

  const first = await ensureCandidateDshFreeSearchRuntimeCompatibility(candidate, profile, options)
  const second = await ensureCandidateDshFreeSearchRuntimeCompatibility(candidate, profile, options)
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.match(readFileSync(targetPath, 'utf8'), /desktop-managed-update/)
  assert.match(readFileSync(targetPath, 'utf8'), /插件市场/)

  writeFileSync(targetPath, 'future layout\n')
  const unknown = await ensureCandidateDshFreeSearchRuntimeCompatibility(candidate, profile, options)
  assert.equal(unknown.state, 'unrecognized')
  assert.equal(readFileSync(targetPath, 'utf8'), 'future layout\n')
})

test('future free-search releases use the capability gate instead of a version allowlist', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-free-search-future-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-free-search-future')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'dsh-free-search')
  const targetPath = join(packageRoot, 'lib', 'index.js')
  const upstream = [
    'var Service = class {',
    '    async updatePlugin() {',
    '      const mode = detectInstallMode();',
    '      return mode;',
    '    }',
    '};',
    '',
  ].join('\n')

  mkdirSync(join(targetPath, '..'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-free-search', version: '0.4.24' }))
  writeFileSync(targetPath, upstream)

  const first = await ensureCandidateDshFreeSearchRuntimeCompatibility(candidate, profile)
  const second = await ensureCandidateDshFreeSearchRuntimeCompatibility(candidate, profile)
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.match(readFileSync(targetPath, 'utf8'), /DSH_DESKTOP_MANAGED_PLUGIN_UPDATE/)
})

test('candidate Antigravity compatibility reads Windows Credential Manager only for audited bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-agy-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-agy')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'dsh-agy-link')
  const targetPath = join(packageRoot, 'dist', 'index.js')
  const assetRoot = join(root, 'assets', 'dsh-agy-link-desktop-compat')
  const assetPath = join(assetRoot, 'windows-credential.js.txt')
  const upstream = [
    'var Connector = class {',
    '  readSystemKeychainToken() { return readMacKeychainToken(); }',
    '};',
    'var QuotaService = class {',
    '};',
    '',
  ].join('\n')
  const asset = [
    '// DSH_DESKTOP_WINDOWS_CREDENTIAL_COMPAT',
    'function readWindowsCredentialToken() { return undefined; }',
    '',
  ].join('\n')
  const patched = patchDshAgyLinkWindowsCredential(upstream, asset)
  assert.equal(patched.state, 'patched')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const options = {
    assetPath,
    assetRoot,
    assetSha256: sha256(asset),
    targets: {
      '0.4.24': {
        upstreamSha256: sha256(upstream),
        patchedSha256: sha256(patched.source),
      },
    },
  }

  mkdirSync(join(targetPath, '..'), { recursive: true })
  mkdirSync(assetRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-agy-link', version: '0.4.24' }))
  writeFileSync(targetPath, upstream)
  writeFileSync(assetPath, asset)

  const first = await ensureCandidateDshAgyLinkRuntimeCompatibility(candidate, profile, undefined, options)
  const second = await ensureCandidateDshAgyLinkRuntimeCompatibility(candidate, profile, undefined, options)
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.match(readFileSync(targetPath, 'utf8'), /process\.platform === "win32" \? readWindowsCredentialToken\(\)/)

  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-agy-link', version: '0.4.25' }))
  writeFileSync(targetPath, upstream)
  const unknown = await ensureCandidateDshAgyLinkRuntimeCompatibility(candidate, profile, undefined, options)
  assert.equal(unknown.state, 'unrecognized')
  assert.equal(readFileSync(targetPath, 'utf8'), upstream)
})

test('candidate Antigravity compatibility migrates the exact legacy Windows credential patch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-agy-legacy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-agy')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', 'dsh-agy-link')
  const targetPath = join(packageRoot, 'dist', 'index.js')
  const assetRoot = join(root, 'assets', 'dsh-agy-link-desktop-compat')
  const assetPath = join(assetRoot, 'windows-credential.js.txt')
  const legacy = [
    'const DSH_DESKTOP_WINDOWS_CREDENTIAL_COMPAT = String.raw`',
    'using System.Runtime.InteropServices.ComTypes;',
    'public FILETIME LastWritten;',
    '"-Command"',
    '`;',
    'function readWindowsCredentialToken() { return undefined; }',
    '',
  ].join('\n')
  const current = [
    'var Connector = class {',
    '  readSystemKeychainToken() {',
    '\t\treturn process.platform === "win32" ? readWindowsCredentialToken() : readMacKeychainToken();',
    '\t}',
    '};',
    legacy,
    'var QuotaService = class {',
    '};',
    '',
  ].join('\n')
  const asset = [
    '// DSH_DESKTOP_WINDOWS_CREDENTIAL_COMPAT',
    'public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
    '"-EncodedCommand"',
    'function readWindowsCredentialToken() { return undefined; }',
    '',
  ].join('\n')
  const upgraded = upgradeLegacyDshAgyLinkWindowsCredential(current, asset)
  assert.equal(upgraded.state, 'patched')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const options = {
    assetPath,
    assetRoot,
    assetSha256: sha256(asset),
    targets: {
      '0.4.24': {
        upstreamSha256: sha256('unused upstream'),
        legacyPatchedSha256: sha256(current),
        patchedSha256: sha256(upgraded.source),
      },
    },
  }

  mkdirSync(join(targetPath, '..'), { recursive: true })
  mkdirSync(assetRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-agy-link', version: '0.4.24' }))
  writeFileSync(targetPath, current)
  writeFileSync(assetPath, asset)

  const first = await ensureCandidateDshAgyLinkRuntimeCompatibility(candidate, profile, undefined, options)
  const second = await ensureCandidateDshAgyLinkRuntimeCompatibility(candidate, profile, undefined, options)
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.doesNotMatch(readFileSync(targetPath, 'utf8'), /using System\.Runtime\.InteropServices\.ComTypes;/)
  assert.match(readFileSync(targetPath, 'utf8'), /"-EncodedCommand"/)
})

test('candidate DSH Doctor compatibility patches only audited bytes and is atomic', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-doctor-compatibility-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'stable-doctor')
  const profile = join(candidate, 'profiles', 'physical-stable')
  const packageRoot = join(profile, 'node_modules', '@linxin666', 'dsh-doctor')
  const assetRoot = join(root, 'assets', 'dsh-doctor-desktop-compat')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const fixtures = [
    {
      id: 'cli-launcher',
      path: ['lib', 'cli.mjs'],
      upstream: 'original cli\n',
      legacyPatched: 'legacy patched cli\n',
      patched: 'patched cli\n',
    },
    { id: 'service-supervisor', path: ['lib', 'index.js'], upstream: 'original service\n', patched: 'patched service\n' },
  ]
  const targets = fixtures.map(fixture => ({
    id: fixture.id,
    path: fixture.path,
    upstreamSha256: sha256(fixture.upstream),
    ...(fixture.legacyPatched === undefined ? {} : { legacyPatchedSha256: sha256(fixture.legacyPatched) }),
    patchedSha256: sha256(fixture.patched),
  }))

  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-doctor', version: '0.3.6' }))
  for (const fixture of fixtures) {
    const targetPath = join(packageRoot, ...fixture.path)
    const assetPath = join(assetRoot, ...fixture.path)
    mkdirSync(join(targetPath, '..'), { recursive: true })
    mkdirSync(join(assetPath, '..'), { recursive: true })
    writeFileSync(targetPath, fixture.upstream)
    writeFileSync(assetPath, fixture.patched)
  }

  const options = { assetRoot, targets, upstreamVersion: '0.3.6', patchedVersion: '0.3.6-dshdesktop.1' }
  const first = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, undefined, options)
  const second = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, undefined, options)
  assert.equal(first.state, 'patched')
  assert.equal(second.state, 'compatible')
  assert.deepEqual(first.targets.map(target => target.state), ['patched', 'patched'])
  for (const fixture of fixtures) assert.equal(readFileSync(join(packageRoot, ...fixture.path), 'utf8'), fixture.patched)

  // A candidate that already carries the previous audited desktop patch must
  // migrate atomically to the current patch instead of failing closed as an
  // unknown upstream layout.
  writeFileSync(join(packageRoot, ...fixtures[0].path), fixtures[0].legacyPatched)
  const migrated = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, undefined, options)
  assert.equal(migrated.state, 'patched')
  assert.deepEqual(migrated.targets.map(target => target.state), ['patched', 'compatible'])
  assert.equal(readFileSync(join(packageRoot, ...fixtures[0].path), 'utf8'), fixtures[0].patched)

  // One unknown target must prevent every planned write, including another
  // target that still matches the audited upstream bytes.
  writeFileSync(join(packageRoot, ...fixtures[0].path), fixtures[0].upstream)
  writeFileSync(join(packageRoot, ...fixtures[1].path), 'unexpected future layout\n')
  const unknown = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, undefined, options)
  assert.equal(unknown.state, 'unrecognized')
  assert.equal(readFileSync(join(packageRoot, ...fixtures[0].path), 'utf8'), fixtures[0].upstream)
  assert.equal(readFileSync(join(packageRoot, ...fixtures[1].path), 'utf8'), 'unexpected future layout\n')
})

test('bundled DSH Doctor Windows redeploy cleanup is hidden and process-scoped', () => {
  const sources = [
    join(process.cwd(), 'src', 'plugins', 'dsh-doctor-desktop-compat', 'lib', 'cli.mjs'),
    join(process.cwd(), 'src', 'plugins', 'dsh-doctor-desktop-compat', 'v0.3.9', 'lib', 'cli.mjs'),
  ].map(path => readFileSync(path, 'utf8'))
  for (const source of sources) {
    assert.match(source, /Get-CimInstance Win32_Process/)
    assert.match(source, /sameExecutable/)
    assert.match(source, /quotedExecutable/)
    assert.match(source, /StartsWith\(\$quotedExecutable \+ ' ', \$comparison\)/)
    assert.match(source, /relativeCliPath/)
    assert.match(source, /DSH_DESKTOP_DOCTOR_CANDIDATE_ROOT/)
    assert.match(source, /DSH_DESKTOP_DOCTOR_CLI_PATH/)
    assert.match(source, /DSH_DESKTOP_DOCTOR_OWNER_PID/)
    assert.match(source, /DSH_DESKTOP_DOCTOR_OWNER_STARTED_AT/)
    assert.match(source, /--dsh-desktop-candidate-root/)
    assert.match(source, /--parent-pid/)
    assert.match(source, /--parent-started-at/)
    assert.match(source, /\$cliPattern/)
    assert.match(source, /\$rootPattern/)
    assert.match(source, /\$ownerPidPattern/)
    assert.match(source, /\$ownerStartedAtPattern/)
    assert.match(source, /\$creationValue -is \[DateTime\]/)
    assert.match(source, /Stop-Process -Id \$item\.ProcessId -Force/)
    assert.match(source, /windowsHide: true/)
    assert.doesNotMatch(source, /taskkill\s+\/IM/i)
  }
})

function decodeDoctorCleanupScript(command) {
  const encodedCommandIndex = command.args.indexOf('-EncodedCommand')
  assert.notEqual(encodedCommandIndex, -1)
  return Buffer.from(command.args[encodedCommandIndex + 1], 'base64').toString('utf16le')
}

function doctorCleanupScopeFixture(name, {
  ownerPid = 1234,
  ownerStartedAt = 1704067200000,
} = {}) {
  const candidateRoot = join(process.cwd(), `.doctor-cleanup-${name}`)
  const cliPath = join(
    candidateRoot,
    'profiles',
    `physical-${name}`,
    'node_modules',
    '@linxin666',
    'dsh-doctor',
    'lib',
    'cli.mjs',
  )
  return { candidateRoot, cliPath, ownerPid, ownerStartedAt }
}

test('Doctor cleanup construction skips an incomplete scope instead of producing a kill command', () => {
  const scope = doctorCleanupScopeFixture('missing')
  const executable = join(process.cwd(), 'node.exe')
  const powershellPath = join(process.cwd(), 'powershell.exe')
  assert.equal(buildWindowsDoctorSupervisorCleanupCommand(executable, powershellPath, {
    ...scope,
    ownerStartedAt: undefined,
  }), undefined)
  assert.equal(buildWindowsDoctorSupervisorCleanupCommand(executable, powershellPath, {
    ...scope,
    cliPath: undefined,
  }), undefined)
})

test('Doctor cleanup stops only a matching scope and accepts a DateTime CreationDate', t => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell process-filter regression is Windows-specific')
    return
  }

  const scope = doctorCleanupScopeFixture('a')
  const otherScope = doctorCleanupScopeFixture('b')
  const executable = process.execPath
  const powershellPath = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const command = buildWindowsDoctorSupervisorCleanupCommand(executable, powershellPath, scope)
  assert.ok(command)
  const lineFor = (candidateRoot, cliPath, ownerPid = scope.ownerPid, ownerStartedAt = scope.ownerStartedAt) => (
    `"${executable}" "${cliPath}" supervisor --dsh-desktop-candidate-root "${candidateRoot}" --parent-pid ${ownerPid} --parent-started-at ${ownerStartedAt}`
  )
  const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`
  const fixtures = [
    {
      pid: 7101,
      line: lineFor(scope.candidateRoot, scope.cliPath),
      creation: "[DateTime]::Parse('2024-01-02T00:00:00Z')",
    },
    {
      pid: 7102,
      line: lineFor(otherScope.candidateRoot, otherScope.cliPath),
      creation: "[DateTime]::Parse('2024-01-02T00:00:00Z')",
    },
    {
      pid: 7103,
      line: lineFor(scope.candidateRoot, otherScope.cliPath),
      creation: "[DateTime]::Parse('2024-01-02T00:00:00Z')",
    },
    {
      pid: 7104,
      line: lineFor(scope.candidateRoot, scope.cliPath, 9999),
      creation: "[DateTime]::Parse('2024-01-02T00:00:00Z')",
    },
    {
      pid: 7105,
      line: lineFor(scope.candidateRoot, scope.cliPath),
      creation: "[DateTime]::Parse('2023-12-31T00:00:00Z')",
    },
  ]
  const powershell = [
    '$script:fixtures = @(',
    ...fixtures.map(fixture => (
      `  [pscustomobject]@{ ProcessId = ${fixture.pid}; CommandLine = ${quotePowerShell(fixture.line)}; ExecutablePath = ${quotePowerShell(executable)}; CreationDate = ${fixture.creation} }`
    )),
    ')',
    '$script:stopped = [System.Collections.Generic.List[int]]::new()',
    'function Get-CimInstance { param([string]$ClassName); return $script:fixtures }',
    'function Stop-Process { param([int]$Id, [switch]$Force, [object]$ErrorAction); [void]$script:stopped.Add($Id) }',
    'function Get-Process { param([int]$Id, [object]$ErrorAction); return $null }',
    decodeDoctorCleanupScript(command),
    'Write-Output ("STOPPED=" + ($script:stopped -join ","))',
  ].join('\r\n')
  const encodedCommandIndex = command.args.indexOf('-EncodedCommand')
  const result = spawnSync(command.command, [
    ...command.args.slice(0, encodedCommandIndex + 1),
    Buffer.from(powershell, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DSH_DOCTOR_CLEANUP_STATUS=stopped;count=1/)
  assert.match(result.stdout, /STOPPED=7101/)
})

test('bundled DSH Doctor 0.3.9/0.3.10 byte-identical compatibility assets are version-scoped and fail closed on drift', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-doctor-039-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidates', 'doctor-039')
  const profile = join(candidate, 'profiles', 'physical-doctor-039')
  const packageRoot = join(profile, 'node_modules', '@linxin666', 'dsh-doctor')
  const sourceRoot = join(process.cwd(), 'src', 'plugins', 'dsh-doctor-desktop-compat', 'v0.3.9')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-doctor', version: '0.3.9' }))
  for (const file of ['cli.mjs', 'index.js']) {
    writeFileSync(join(packageRoot, 'lib', file), readFileSync(join(sourceRoot, 'lib', file)))
  }

  const compatible = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, process.cwd())
  assert.equal(compatible.state, 'compatible')
  assert.deepEqual(compatible.targets.map(target => target.state), ['compatible', 'compatible'])

  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-doctor', version: '0.3.10' }))
  const compatible0310 = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, process.cwd())
  assert.equal(compatible0310.state, 'compatible')
  assert.deepEqual(compatible0310.targets.map(target => target.state), ['compatible', 'compatible'])

  writeFileSync(join(packageRoot, 'lib', 'cli.mjs'), 'unrecognized future cli\n')
  const drifted = await ensureCandidateDshDoctorRuntimeCompatibility(candidate, profile, process.cwd())
  assert.equal(drifted.state, 'unrecognized')
  assert.equal(drifted.targets[0].state, 'unrecognized')
})

test('future Doctor CLI receives an idempotent desktop service-install capability bridge', () => {
  const source = [
    'async function main(argv = process.argv.slice(2)) {',
    '  const command = argv[0] ?? "help"',
    '  if (command === "supervisor") {',
    '    await runSupervisor()',
    '    return 0',
    '  }',
    '}',
  ].join('\n')

  const patched = patchDshDoctorFutureServiceInstall(source)
  assert.equal(patched.state, 'patched')
  assert.match(patched.source, /DSH_DESKTOP_GENERIC_SERVICE_INSTALL/u)
  assert.match(patched.source, /"supervisor", "--parent-pid"/u)
  assert.equal(patchDshDoctorFutureServiceInstall(patched.source).state, 'compatible')
  assert.equal(patchDshDoctorFutureServiceInstall('async function main() {}').state, 'unrecognized')
})

function createDoctorManagedStartupFixture(t, {
  statusVersion = '0.3.9',
  immediateTimers = false,
  doctorVersion = '0.3.9',
  dshVersion = '0.1.1-rc.2',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-doctor-service-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const releaseId = 'doctor-service-test'
  const candidate = join(root, 'candidates', releaseId)
  const profile = join(candidate, 'profiles', 'ricardo-stable-doctor-service-test')
  const entry = join(candidate, 'runtime', 'versions', '0.1.1-rc.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const packageRoot = join(profile, 'node_modules', '@linxin666', 'dsh-doctor')
  const sourceRoot = join(process.cwd(), 'src', 'plugins', 'dsh-doctor-desktop-compat', 'v0.3.9', 'lib')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, 'doctor service test runtime\n')
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@linxin666/dsh-doctor',
    version: doctorVersion,
    dsh: { engines: { dsh: '>=0.1.2-rc.1' } },
  }))
  writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ dsh: { version: dshVersion } }))
  for (const file of ['cli.mjs', 'index.js']) {
    writeFileSync(join(packageRoot, 'lib', file), readFileSync(join(sourceRoot, file)))
  }

  let started = false
  let stops = 0
  const mode = new EventEmitter()
  mode.status = () => ({
    active: started ? 'stable' : 'legacy',
    state: started ? 'ready' : 'stopped',
    unsafe: false,
    stable: { status: { releaseId } },
  })
  mode.start = async () => {
    started = true
    mode.emit('status', mode.status())
    return { url: 'http://127.0.0.1:4199/' }
  }
  mode.stop = async () => {
    stops += 1
    started = false
    mode.emit('status', mode.status())
    return true
  }

  const calls = []
  const setup = createRuntime({
    process: { execPath: process.execPath, platform: 'win32', arch: process.arch, env: {} },
    modeSupervisor: mode,
    ...(immediateTimers
      ? {
          setTimeoutImpl: callback => {
            const handle = setImmediate(callback)
            return handle
          },
          clearTimeoutImpl: handle => clearImmediate(handle),
        }
      : {}),
    runtime: {
      repositoryRoot: process.cwd(),
      resolveHarnessPatch: () => join(root, 'dsh-desktop.patch.yml'),
      runDoctorServiceCommand: async request => {
        calls.push(request)
        if (request.args?.[1] === 'status') {
          return { stdout: JSON.stringify({ ok: true, snapshot: { version: statusVersion, phase: 'armed' } }), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
      stopDoctorSupervisors: async () => {},
    },
  })
  const recipe = Object.freeze({
    mode: 'stable',
    releaseId,
    physicalProfileName: 'ricardo-stable-doctor-service-test',
    profileHome: candidate,
    profilePath: profile,
    cwd: profile,
    entry,
  })
  t.after(() => setup.controller.shutdown(new Error('doctor service test shutdown')))
  return { ...setup, calls, recipe, getStops: () => stops }
}

test('managed Windows startup reconciles DSH Doctor to the exact active release without a shell window', async t => {
  const setup = createDoctorManagedStartupFixture(t)

  const started = await setup.controller.start('Starting managed Doctor', {
    mode: 'stable',
    modeRecipe: setup.recipe,
    provisional: true,
    allowLegacyFallback: false,
  })

  assert.equal(started, true)
  assert.deepEqual(setup.calls.map(call => call.args?.[1]), ['service-install', 'status'])
  for (const call of setup.calls) {
    assert.equal(call.command, process.execPath)
    assert.equal(call.args[0], join(setup.recipe.profilePath, 'node_modules', '@linxin666', 'dsh-doctor', 'lib', 'cli.mjs'))
    assert.equal(call.cwd, setup.recipe.profilePath)
    assert.equal(call.env.DSH_DOCTOR_DSH_SCRIPT, setup.recipe.entry)
    assert.equal(call.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(call.windowsHide, true)
    assert.equal(call.shell, false)
  }
  assert.equal(setup.controller.statusSnapshot().workspace.ready, true)
})

test('ordinary managed Windows startup keeps an already healthy DSH Doctor supervisor running', async t => {
  const setup = createDoctorManagedStartupFixture(t)
  const doctorCliPath = join(setup.recipe.profilePath, 'node_modules', '@linxin666', 'dsh-doctor', 'lib', 'cli.mjs')
  const doctorCliBefore = readFileSync(doctorCliPath)

  const started = await setup.controller.start('Starting healthy managed Doctor', {
    mode: 'stable',
    modeRecipe: setup.recipe,
    allowLegacyFallback: false,
  })

  assert.equal(started, true)
  assert.deepEqual(setup.calls.map(call => call.args?.[1]), ['status'])
  assert.equal(setup.calls[0].env.DSH_DESKTOP_DOCTOR_CANDIDATE_ROOT, setup.recipe.profileHome)
  assert.equal(setup.calls[0].env.DSH_DESKTOP_DOCTOR_CLI_PATH, doctorCliPath)
  assert.match(setup.calls[0].env.DSH_DESKTOP_DOCTOR_OWNER_PID, /^\d+$/)
  assert.match(setup.calls[0].env.DSH_DESKTOP_DOCTOR_OWNER_STARTED_AT, /^\d+$/)
  assert.deepEqual(readFileSync(doctorCliPath), doctorCliBefore)
  assert.equal(setup.controller.statusSnapshot().workspace.ready, true)
})

test('managed Windows startup accepts a future Doctor through capability validation', async t => {
  const setup = createDoctorManagedStartupFixture(t, {
    statusVersion: '0.3.14',
    doctorVersion: '0.3.14',
    dshVersion: '0.1.2-rc.1',
  })

  const started = await setup.controller.start('Starting future managed Doctor', {
    mode: 'stable',
    modeRecipe: setup.recipe,
    provisional: true,
    allowLegacyFallback: false,
  })

  assert.equal(started, true)
  assert.deepEqual(setup.calls.map(call => call.args?.[1]), ['service-install', 'status'])
  assert.equal(setup.controller.statusSnapshot().workspace.ready, true)
})

test('managed Windows startup stays unready when the DSH Doctor service handshake cannot match the candidate', async t => {
  const setup = createDoctorManagedStartupFixture(t, { statusVersion: '0.3.8', immediateTimers: true })

  const started = await setup.controller.start('Starting mismatched Doctor', {
    mode: 'stable',
    modeRecipe: setup.recipe,
    provisional: true,
    allowLegacyFallback: false,
  })

  assert.equal(started, false)
  assert.equal(setup.calls.filter(call => call.args?.[1] === 'service-install').length, 1)
  assert.equal(setup.calls.filter(call => call.args?.[1] === 'status').length, 8)
  assert.equal(setup.controller.statusSnapshot().workspace.ready, false)
  assert.ok(setup.getStops() >= 1)
})

function createReleaseFixture(t, {
  failingReleaseId,
  observeRelease,
  restoreSnapshot,
  pluginTransactionService,
  pluginCandidateManifestReleaseId,
  readPluginCatalog,
  loadPluginCatalog,
  resolveMarketSource,
  inspectMarketPluginMetadata = async ({ target }) => ({ pluginVersion: target, requiredRange: undefined }),
  activeVersion = '2.0.0',
  activeBundles = [],
  activeDependencies = {},
  managedData = false,
  owners,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-release-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'data')
  const repository = join(root, 'repository')
  const state = new ReleaseStateStore(join(root, 'state'))
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(join(repository, 'src', 'plugins', 'dsh-desktop-integration', 'lib'), { recursive: true })
  writeFileSync(join(repository, 'src', 'plugins', 'dsh-desktop-integration', 'package.json'), '{"name":"@dsh-desktop/integration"}\n')
  writeFileSync(join(repository, 'src', 'plugins', 'dsh-desktop-integration', 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(repository, 'src', 'plugins', 'dsh-desktop-integration', 'lib', 'client.js'), 'export default {}\n')
  writeFileSync(join(dshHome, 'marker.txt'), 'data')
  const oldId = 'stable-old'
  const oldMaterialized = materializeCandidate(root, oldId, activeVersion, oldId, activeBundles, activeDependencies)
  const oldHash = oldMaterialized.manifestSha256
  state.writeActive(releasePointer(oldId, oldHash))
  state.writeLastKnownGood(releasePointer(oldId, oldHash))

  const verifyCalls = []
  let preparedReleaseId
  const candidateBuilder = {
    prepare: async ({ releaseId, channel }) => {
      preparedReleaseId = releaseId
      materializeCandidate(root, releaseId)
      return { candidateDir: join(root, 'candidates', releaseId), releaseId, channel }
    },
    verify: async ({ candidateDir, expectedReleaseId, expectedChannel, signal, verifyRuntime }) => {
      verifyCalls.push({ candidateDir, expectedReleaseId, expectedChannel, signal, verifyRuntime })
      const manifest = JSON.parse(readFileSync(join(candidateDir, 'manifest.json'), 'utf8'))
      const hash = releaseManifestSha256(manifest)
      return {
        status: 'ready',
        candidateDir,
        manifestSha256: hash,
        manifest,
        descriptor: { version: manifest.dsh.version },
      }
    },
  }
  const snapshotCalls = []
  let releaseController
  const snapshotStore = {
    create: async options => {
      snapshotCalls.push({ type: 'create', options, coordinatorLabel: releaseController?.operationCoordinator.active?.label })
      return { snapshotId: options.snapshotId, kind: options.kind }
    },
    list: async options => {
      snapshotCalls.push({ type: 'list', options, coordinatorLabel: releaseController?.operationCoordinator.active?.label })
      return [{ snapshotId: 'snapshot-1', kind: 'pre-switch' }]
    },
    restore: async options => {
      snapshotCalls.push({ type: 'restore', options, coordinatorLabel: releaseController?.operationCoordinator.active?.label })
      if (typeof restoreSnapshot === 'function') return restoreSnapshot(options)
      return { snapshotId: options.snapshotId }
    },
  }
  const mode = new EventEmitter()
  const modeCalls = []
  let modeState = 'stopped'
  let activeRelease = 'legacy'
  mode.status = () => ({
    active: activeRelease === 'legacy' ? 'legacy' : 'stable',
    state: modeState,
    unsafe: false,
    stable: { status: { releaseId: activeRelease } },
  })
  mode.start = async (name, recipe) => {
    modeCalls.push({ name, recipe })
    activeRelease = recipe?.releaseId ?? 'legacy'
    modeState = activeRelease === failingReleaseId || (failingReleaseId === '__prepared__' && activeRelease === preparedReleaseId)
      ? 'failed'
      : 'ready'
    mode.emit('status', mode.status())
    return { url: `http://127.0.0.1/${activeRelease}` }
  }
  mode.stop = async () => {
    modeState = 'stopped'
    mode.emit('status', mode.status())
    return true
  }

  const materializedPluginTransactionService = pluginTransactionService === undefined
    ? undefined
    : Object.fromEntries(Object.entries(pluginTransactionService).map(([name, value]) => {
      if (typeof value !== 'function' || !['transaction', 'installMany', 'confirmRemove'].includes(name)) {
        return [name, typeof value === 'function' ? value.bind(pluginTransactionService) : value]
      }
      return [name, async (...args) => {
        const report = await value.apply(pluginTransactionService, args)
        const candidateId = report?.candidateId ?? report?.candidate?.id
        if (typeof candidateId !== 'string') return report
        const manifestReleaseId = typeof pluginCandidateManifestReleaseId === 'function'
          ? pluginCandidateManifestReleaseId({ candidateId, report })
          : (pluginCandidateManifestReleaseId ?? candidateId)
        const materialized = materializeCandidate(root, candidateId, activeVersion, manifestReleaseId, activeBundles)
        return {
          ...report,
          candidatePath: materialized.candidate,
          candidate: {
            ...(report?.candidate ?? {}),
            id: candidateId,
            path: materialized.candidate,
          },
        }
      }]
    }))

  const pluginAdapters = {
    ...(readPluginCatalog === undefined ? {} : { readPluginCatalog }),
    ...(loadPluginCatalog === undefined ? {} : { loadPluginCatalog }),
    ...(resolveMarketSource === undefined ? {} : { resolveMarketSource }),
    inspectMarketPluginMetadata,
    ...(materializedPluginTransactionService === undefined ? {} : { pluginTransactionService: materializedPluginTransactionService }),
  }

  const controllerOptions = {
    runtimeRoot: root,
    dshHome,
    runtime: {
      repositoryRoot: repository,
      ...(materializedPluginTransactionService === undefined ? {} : { pluginTransactionGateAvailable: true }),
    },
    ...(Object.keys(pluginAdapters).length === 0 ? {} : { plugins: pluginAdapters }),
    modeSupervisor: mode,
    initialRuntime: { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' },
    createCandidateBuilder: () => candidateBuilder,
    releaseStateStore: state,
    ...(managedData ? {} : { snapshotStore }),
    observeRelease,
    observeDuration: 0,
    observePollInterval: 10,
    owners,
  }
  const setup = createRuntime(controllerOptions)
  releaseController = setup.controller
  return { ...setup, root, dshHome, state, candidateBuilder, verifyCalls, snapshotCalls, mode, modeCalls, oldId,
    recreate: () => createRuntime(controllerOptions),
  }
}

test('cold startup adopts candidate data once and a new controller keeps later writes', async t => {
  const setup = createReleaseFixture(t, { managedData: true })
  const source = join(setup.root, 'candidates', setup.oldId, 'user-marker.txt')
  writeFileSync(source, 'original')
  assert.equal(await setup.controller.restart('startup'), true)
  const home = join(setup.root, 'user-data')
  assert.equal(setup.modeCalls.at(-1).recipe.dataHome, home)
  assert.equal(setup.controller.statusSnapshot().data.state, 'independent')
  assert.equal(readFileSync(source, 'utf8'), 'original')
  writeFileSync(join(home, 'user-marker.txt'), 'later-user-change')
  await setup.controller.shutdown()
  const next = setup.recreate()
  assert.equal(await next.controller.restart('startup'), true)
  assert.equal(readFileSync(join(home, 'user-marker.txt'), 'utf8'), 'later-user-change')
  await next.controller.shutdown()
})

test('cold controller keeps recovery reachable after data rename but before pointer publication', async t => {
  const setup = createReleaseFixture(t, { managedData: true })
  writeFileSync(join(setup.root, 'candidates', setup.oldId, 'user-marker.txt'), 'original')
  assert.equal(await setup.controller.restart('startup'), true)
  await setup.controller.shutdown()
  const pointerPath = join(setup.root, 'data-home.json')
  const ready = JSON.parse(readFileSync(pointerPath, 'utf8'))
  rmSync(pointerPath)
  const timestamp = new Date().toISOString()
  writeFileSync(join(setup.root, 'data-home.journal.json'), JSON.stringify({
    schemaVersion: 1, kind: 'managed-data-migration', phase: 'renamed',
    sourceReleaseId: setup.oldId, sourceHome: `candidates/${setup.oldId}`,
    staging: '.user-data-staging-12345678-1234-4234-8234-123456789abc',
    manifest: ready.manifest,
    sourceManifest: { ...ready.manifest, directories: ready.manifest.directories.filter(name => name !== 'profiles') },
    startedAt: timestamp, updatedAt: timestamp,
  }))
  const next = setup.recreate()
  assert.equal(next.controller.statusSnapshot().data.state, 'unavailable')
  await assert.rejects(next.controller.getActiveSettingsPath(), /用户数据正在恢复/)
  assert.equal((await next.controller.recoverPendingRelease()).status, 'idle')
  assert.equal(next.controller.statusSnapshot().data.state, 'independent')
  assert.equal(existsSync(join(setup.root, 'data-home.journal.json')), false)
  assert.equal(await next.controller.restart('startup'), true)
  await next.controller.shutdown()
})

test('a fresh missing runtime root does not prevent controller construction', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-first-run-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'not-created-yet')
  const setup = createRuntime({ runtimeRoot, dshHome: join(root, 'home') })
  assert.equal(setup.controller.statusSnapshot().data.state, 'candidate')
})

test('direct start cannot migrate data concurrently with an unrelated queued writer', async t => {
  const setup = createReleaseFixture(t, { managedData: true })
  const writer = deferred()
  const busy = setup.controller.operationCoordinator.enqueue('fixture-data-writer', () => writer.promise)
  await nextTurn()
  try {
    assert.equal(await setup.controller.start('direct concurrent startup'), false)
    assert.equal(existsSync(join(setup.root, 'data-home.json')), false)
    assert.equal(existsSync(join(setup.root, 'user-data')), false)
    assert.equal(setup.modeCalls.length, 0)
  } finally {
    writer.resolve()
    await busy
    await setup.controller.shutdown()
  }
})

test('controller status sanitizes secrets and caps every projected string', () => {
  const secret = 'controller-status-secret-123456789'
  const huge = 'x'.repeat(100_000)
  const setup = createRuntime({
    initialRuntime: {
      version: `Authorization: Bearer ${secret}`,
      source: huge,
      entry: huge,
      token: secret,
      bundled: { version: huge },
    },
  })
  const status = setup.controller.statusSnapshot()
  const strings = []
  const collect = value => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(status)
  assert.ok(strings.every(value => value.length <= DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS))
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret))
})

test('plugin status resolves the release owner before reporting an active immutable candidate', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-active-candidate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const releaseId = 'stable-11111111-1111-4111-8111-111111111111'
  const state = new ReleaseStateStore(join(root, 'release-state'))
  const pointer = releasePointer(releaseId, 'a'.repeat(64))
  state.writeActive(pointer)
  state.writeLastKnownGood(pointer)

  const setup = createRuntime({
    dshHome: join(root, 'dsh-home'),
    runtimeRoot: root,
    releaseStateStore: state,
    runtime: { repositoryRoot: join(root, 'repository') },
  })

  const plugins = setup.controller.statusSnapshot().plugins
  assert.equal(plugins.activeCandidate, true)
  assert.equal(plugins.transactionAvailable, true)
  assert.equal(plugins.transactionState, 'candidate-only')
})

test('manual plugin safe mode uses a temporary overlay and can return to normal startup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-plugin-safe-mode-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'data')
  mkdirSync(dshHome, { recursive: true })
  const servers = [new FakeServer(), new FakeServer()]
  const setup = createRuntime({
    dshHome,
    runtimeRoot: root,
    servers,
    plugins: {
      readPluginCatalog: () => ({ profile: 'web', profileDir: join(dshHome, 'profiles', 'web'), plugins: [{ name: 'dshmarket' }], system: [], initialized: true }),
      runCommand: async () => ({ output: '# == dshmarket\n- id: dsh-market\n' }),
    },
  })

  const safeStart = setup.controller.startPluginSafeMode()
  ready(servers[0], 43110)
  const safeResult = await safeStart
  assert.equal(safeResult.recoveryMode, true)
  assert.equal(safeResult.restarted, true)
  assert.ok(safeResult.rowCount >= 1)
  const patchIndex = servers[0].options.args.lastIndexOf('--patch')
  assert.ok(patchIndex >= 0)
  const recoveryPatch = servers[0].options.args[patchIndex + 1]
  assert.equal(existsSync(recoveryPatch), true)
  assert.match(readFileSync(recoveryPatch, 'utf8'), /id: dsh-market[\s\S]*disabled: true/)
  assert.equal(setup.controller.statusSnapshot().plugins.recoveryMode, true)

  const safeExit = setup.controller.exitPluginSafeMode()
  ready(servers[1], 43111)
  const exitResult = await safeExit
  assert.deepEqual(exitResult, { recoveryMode: false, restarted: true })
  assert.equal(setup.controller.statusSnapshot().plugins.recoveryMode, false)
  assert.equal(servers[1].options.args.includes(recoveryPatch), false)
})

test('controller restores a staged plugin journal and retires it after an already-completed activation', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-staged-plugin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = new ReleaseStateStore(join(root, 'release-state'))
  const parent = releasePointer('stable-parent', 'a'.repeat(64))
  const staged = {
    schemaVersion: 1,
    candidateId: 'plugin-resume-after-restart',
    parentReleaseId: parent.releaseId,
    manifestSha256: 'b'.repeat(64),
    stagedAt: '2026-08-25T00:00:00.000Z',
  }
  state.writeActive(parent)
  state.writeLastKnownGood(parent)
  state.writeStagedPluginCandidate(staged)

  const resumed = createRuntime({
    dshHome: join(root, 'dsh-home'),
    runtimeRoot: root,
    releaseStateStore: state,
    runtime: { repositoryRoot: join(root, 'repository') },
  })
  assert.equal(resumed.controller.statusSnapshot().plugins.pendingCandidateId, staged.candidateId)
  assert.equal(resumed.controller.statusSnapshot().plugins.restartRequired, true)
  assert.deepEqual(state.readStagedPluginCandidate(), staged)

  state.writeActive(releasePointer(staged.candidateId, staged.manifestSha256))
  const completed = createRuntime({
    dshHome: join(root, 'dsh-home'),
    runtimeRoot: root,
    releaseStateStore: state,
    runtime: { repositoryRoot: join(root, 'repository') },
  })
  assert.equal(completed.controller.statusSnapshot().plugins.pendingCandidateId, null)
  assert.equal(state.readStagedPluginCandidate(), undefined)
})

test('controller starts in order and publishes ready only after workspace and overview', async () => {
  const server = new FakeServer({})
  const setup = createRuntime({ servers: [server] })
  const start = setup.controller.start('Starting')
  await new Promise(resolve => setImmediate(resolve))
  ready(server, 4101)
  assert.equal(await start, true)
  assert.deepEqual(setup.window.routes.map(entry => entry.route), ['loading', 'overview'])
  assert.deepEqual(setup.window.loaded, ['http://127.0.0.1:4101/'])
  assert.equal(setup.controller.statusSnapshot().workspace.ready, true)
  assert.equal(setup.controller.getHarnessOrigin(), 'http://127.0.0.1:4101')
})

test('startup preserves a first-run onboarding surface instead of replacing it with loading.html', async () => {
  const server = new FakeServer({})
  const setup = createRuntime({
    servers: [server],
    effects: { preserveLoadingSurface: () => true },
  })
  const start = setup.controller.start('Starting behind onboarding')
  await nextTurn()
  ready(server, 4102)

  assert.equal(await start, true)
  assert.deepEqual(setup.window.routes.map(entry => entry.route), ['overview'])
  assert.deepEqual(setup.window.fallbackPages, [])
  assert.deepEqual(setup.window.loadingScripts, [])
  assert.deepEqual(setup.window.loaded, ['http://127.0.0.1:4102/'])
})

test('controller production path delegates configured stable start, restart, and shutdown to ModeSupervisor', async () => {
  const calls = []
  const mode = new EventEmitter()
  mode.status = () => ({
    active: calls.some(call => call.type === 'start' || call.type === 'restart') ? 'stable' : 'legacy',
    state: 'ready',
    stable: { configured: true },
    dev: { configured: false },
  })
  mode.start = async (name, recipe, options) => {
    calls.push({ type: 'start', name, recipe, signal: options.signal })
    return { url: 'http://127.0.0.1:4191/' }
  }
  mode.restart = async (name, recipe, options) => {
    calls.push({ type: 'restart', name, recipe, signal: options.signal })
    return { url: 'http://127.0.0.1:4192/' }
  }
  mode.stop = async reason => { calls.push({ type: 'stop', reason }) }

  const recipe = Object.freeze({
    releaseId: 'release-test',
    physicalProfileName: 'ricardo-stable-release-test',
    profileHome: '/managed-release',
  })
  const desktopPatch = '/desktop/dsh-desktop.patch.yml'
  const trustedBaseEnv = { PATH: '/desktop/toolchain:/system/bin' }
  const setup = createRuntime({
    modeSupervisor: mode,
    stableConfig: recipe,
    runtime: { resolveHarnessPatch: () => desktopPatch, env: trustedBaseEnv },
  })

  assert.equal(await setup.controller.start('Starting stable'), true)
  assert.equal(calls[0].type, 'start')
  assert.equal(calls[0].name, 'stable')
  assert.equal(calls[0].recipe.releaseId, recipe.releaseId)
  assert.deepEqual(calls[0].recipe.patches, [desktopPatch])
  assert.equal(calls[0].recipe.trustedBaseEnv, trustedBaseEnv)
  assert.deepEqual(setup.window.loaded, ['http://127.0.0.1:4191/'])
  assert.equal(setup.controller.getHarnessOrigin(), 'http://127.0.0.1:4191')

  assert.equal(await setup.controller.restart('stable-restart'), true)
  assert.equal(calls.some(call => call.type === 'restart' && call.name === 'stable'), true)
  assert.deepEqual(setup.window.loaded, ['http://127.0.0.1:4191/', 'http://127.0.0.1:4192/'])

  await setup.controller.shutdown(new Error('test shutdown'))
  assert.equal(calls.some(call => call.type === 'stop'), true)
})

test('fresh controller startup restores the verified active candidate instead of the legacy bootstrap', async t => {
  const catalogReads = []
  const setup = createReleaseFixture(t, {
    readPluginCatalog: location => {
      catalogReads.push({ ...location })
      return {
        profile: location.profile,
        profileDir: join(location.dshHome, 'profiles', location.profile),
        plugins: location.profile === 'web' ? [] : [{ name: 'dshmarket', version: '1.26.0', enabled: true }],
        system: [],
        initialized: true,
      }
    },
  })

  assert.equal(await setup.controller.restart('startup'), true)
  assert.equal(setup.modeCalls.length, 1)
  assert.equal(setup.modeCalls[0].name, 'stable')
  assert.equal(setup.modeCalls[0].recipe.releaseId, setup.oldId)
  assert.equal(setup.modeCalls[0].recipe.expectedReleaseId, setup.oldId)
  assert.equal(setup.modeCalls[0].recipe.patches.at(-1).endsWith('dsh-desktop.patch.yml'), true)
  assert.equal(setup.verifyCalls.some(call => call.expectedReleaseId === setup.oldId && call.verifyRuntime === false), true)
  assert.deepEqual(setup.window.loaded, [`http://127.0.0.1/${setup.oldId}`])
  assert.equal(setup.logs.some(entry => entry.text.includes(`[release/startup] Restoring active release ${setup.oldId}`)), true)
  assert.deepEqual(setup.controller.pluginList().plugins.map(plugin => plugin.name), ['dshmarket'])
  assert.deepEqual(catalogReads.at(-1), {
    dshHome: join(setup.root, 'candidates', setup.oldId),
    profile: `ricardo-stable-${setup.oldId}`,
  })
})

test('fresh controller startup fails closed when the active pointer does not match the verified manifest', async t => {
  const setup = createReleaseFixture(t)
  setup.state.writeActive(releasePointer(setup.oldId, 'f'.repeat(64)))

  assert.equal(await setup.controller.restart('startup'), false)
  assert.equal(setup.modeCalls.length, 0)
  assert.equal(setup.controller.statusSnapshot().startup.phase, 'error')
  assert.match(setup.controller.statusSnapshot().startup.error, /does not match its verified manifest/u)
})

test('cold startup accepts future native plugin layouts without mutating their source or the active pointer', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    owners: { ensureCandidatePluginRuntimeCompatibility: async (...args) => {
      calls.push(args)
      return { checks: [{ packageName: 'dsh-free-search', version: '9.0.0', state: 'unrecognized', required: true }] }
    } },
  })
  const before = setup.state.readActive()
  assert.equal(await setup.controller.restart('startup'), true)
  assert.deepEqual(setup.state.readActive(), before)
  assert.equal(calls.length > 0, true)
  assert.equal(calls.every(args => args[3]?.write === false), true)
  assert.equal(setup.controller.statusSnapshot().plugins.compatibilityWarnings[0].packageName, 'dsh-free-search')
  assert.equal(setup.controller.statusSnapshot().workspace.ready, true)
})

test('DSH runtime changes start provisionally and commit only after readiness', async () => {
  const server = new FakeServer({})
  const update = {
    state: 'idle',
    initialize: () => true,
    check: async () => {},
    menuItem: () => ({ label: 'Check', enabled: true }),
    abort: () => {},
    busy: false,
    checkAvailable: true,
    supported: true,
    externalReleaseAvailable: false,
    progress: 0,
    downloadedPath: undefined,
    targetVersion: undefined,
  }
  let dshOptions
  const setup = createRuntime({
    runtimeRoot: '/runtime',
    initialRuntime: { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' },
    resolveDshEntry: runtime => runtime.entry,
    servers: [server],
    createInstallerUpdate: () => update,
    createDshUpdate: options => {
      dshOptions = options
      return {
        ...update,
        runtime: options.initialRuntime,
        managedRestoreAvailable: false,
        restoreAvailable: false,
        restoreItem: () => undefined,
        useBundledFallback: () => false,
      }
    },
  })
  setup.controller.initializeUpdates()
  const previous = setup.controller.statusSnapshot().runtime
  const candidate = { source: 'managed', version: '2.0.0', entry: '/managed/bin.js', bundled: previous }
  const changed = dshOptions.onRuntimeChanged(candidate, { signal: new AbortController().signal })
  await nextTurn()
  assert.equal(setup.controller.statusSnapshot().runtime.version, previous.version)
  assert.equal(server.options.args.includes('/managed/bin.js'), true)
  ready(server, 4106)
  assert.equal(await changed, true)
  assert.equal(setup.controller.statusSnapshot().runtime.version, previous.version)

  await dshOptions.onRuntimeCommitted(candidate)
  assert.equal(setup.controller.statusSnapshot().runtime.version, '2.0.0')
})

test('candidate prepare is serialized, verified offline, and never activates or restarts DSH', async () => {
  const calls = []
  const setup = createRuntime({
    runtimeRoot: '/runtime',
    initialRuntime: { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' },
    runtime: { repositoryRoot: '/repository' },
    createCandidateBuilder: defaults => ({
      prepare: async ({ channel, releaseId, signal }) => {
        calls.push({ type: 'prepare', defaults, channel, releaseId, signal })
        return { candidateDir: `/runtime/candidates/${releaseId}`, releaseId, channel }
      },
      verify: async ({ candidateDir, expectedReleaseId, expectedChannel, signal }) => {
        calls.push({ type: 'verify', candidateDir, expectedReleaseId, expectedChannel, signal })
        return {
          candidateDir,
          manifestSha256: 'a'.repeat(64),
          manifest: {
            releaseId: expectedReleaseId,
            channel: expectedChannel,
            dsh: { version: '2.0.0' },
            profile: { physicalName: `ricardo-stable-${expectedReleaseId}` },
          },
        }
      },
    }),
  })
  const activeBefore = setup.controller.statusSnapshot().runtime

  const result = await setup.controller.prepareCandidate('next')

  assert.equal(result.channel, 'next')
  assert.deepEqual(calls.map(call => call.type), ['prepare', 'verify'])
  assert.equal(calls[0].defaults.candidateRoot, join('/runtime', 'candidates'))
  assert.equal(calls[0].defaults.recipePath, join('/repository', 'profiles', 'ricardo-stable.json'))
  assert.deepEqual(setup.controller.statusSnapshot().runtime, activeBefore)
  assert.deepEqual(setup.window.loaded, [])
  const candidate = setup.controller.getCandidateStatus()
  assert.equal(candidate.state, 'ready')
  assert.equal(candidate.version, '2.0.0')
  assert.equal(candidate.switchAvailable, false)
})

test('aborted provisional DSH start restores the previous in-memory runtime', async () => {
  const server = new FakeServer({})
  const update = {
    state: 'idle', initialize: () => true, check: async () => {},
    menuItem: () => ({ label: 'Check', enabled: true }), abort: () => {},
    busy: false, checkAvailable: true, supported: true,
    externalReleaseAvailable: false, progress: 0, downloadedPath: undefined,
    targetVersion: undefined,
  }
  let dshOptions
  const setup = createRuntime({
    runtimeRoot: '/runtime',
    initialRuntime: { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' },
    resolveDshEntry: runtime => runtime.entry,
    servers: [server],
    createInstallerUpdate: () => update,
    createDshUpdate: options => {
      dshOptions = options
      return {
        ...update, runtime: options.initialRuntime,
        managedRestoreAvailable: false, restoreAvailable: false,
        restoreItem: () => undefined, useBundledFallback: () => false,
      }
    },
  })
  setup.controller.initializeUpdates()
  const action = new AbortController()
  const previous = setup.controller.statusSnapshot().runtime
  const changed = dshOptions.onRuntimeChanged({ source: 'managed', version: '2.0.0', entry: '/managed/bin.js' }, { signal: action.signal })
  await nextTurn()
  action.abort(new Error('shutdown'))
  ready(server, 4107)
  assert.equal(await changed, false)
  assert.equal(setup.controller.statusSnapshot().runtime.version, previous.version)
})

test('overlapping starts use generation CAS and stale startup stops only its own server', async () => {
  const first = new FakeServer({})
  const second = new FakeServer({})
  const setup = createRuntime({ servers: [first, second] })
  const oldStart = setup.controller.start('Old')
  await new Promise(resolve => setImmediate(resolve))
  const newStart = setup.controller.start('New')
  await new Promise(resolve => setImmediate(resolve))
  ready(second, 4102)
  assert.equal(await newStart, true)
  ready(first, 4103)
  assert.equal(await oldStart, false)
  assert.equal(first.stops, 1)
  assert.equal(second.stops, 0)
  assert.equal(setup.controller.getHarnessOrigin(), 'http://127.0.0.1:4102')
  assert.deepEqual(setup.window.loaded, ['http://127.0.0.1:4102/'])
})

test('shutdown drains queued operations and clears the installer timer', async () => {
  let operationAborted = false
  const setup = initializeWithUpdates({
    dshHome: '/profile',
    runtimeRoot: '/runtime',
    plugins: {
      pluginTransactionService: {
        transaction: ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            operationAborted = true
            reject(signal.reason)
          }, { once: true })
        }),
        removePreview: async () => ({}),
        confirmRemove: async () => ({}),
      },
      installPlugin: async () => { writerCalled = true },
    },
  })
  const plugin = setup.controller.pluginTransaction({ action: 'reorder', order: ['example-plugin'] })
  await new Promise(resolve => setImmediate(resolve))
  const shutdown = setup.controller.shutdown(new Error('quit'))
  await shutdown
  assert.ok(plugin instanceof Promise)
  assert.equal(operationAborted, true)
  assert.equal(setup.controller.isQuitting(), true)
  assert.equal(setup.cleared.length, 2)
  assert.equal(setup.controller.operationCoordinator.closed, true)
})

test('shutdown releases the supplied cross-process release ownership after draining', async () => {
  let releases = 0
  const setup = createRuntime({
    releaseOwnership: {
      release: async () => { releases += 1 },
    },
  })

  const first = setup.controller.shutdown(new Error('test shutdown'))
  const second = setup.controller.shutdown(new Error('duplicate shutdown'))
  assert.equal(first, second)
  await first
  assert.equal(releases, 1)
})

test('shutdown aborts an installer operation through the coordinator and drains its dialog', async () => {
  let seenSignal
  let resolveStarted
  const started = new Promise(resolve => { resolveStarted = resolve })
  let dialogAborted = false
  const update = {
    state: 'idle',
    initialize: () => true,
    check: (_manual, { signal } = {}) => {
      seenSignal = signal
      resolveStarted()
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          dialogAborted = true
          resolve()
        }, { once: true })
      })
    },
    menuItem: () => ({ label: 'Check', enabled: true }),
    abort: () => {},
    busy: true,
    checkAvailable: false,
    supported: true,
    externalReleaseAvailable: false,
    progress: 0,
    downloadedPath: undefined,
    targetVersion: undefined,
  }
  const setup = initializeWithUpdates({ createInstallerUpdate: () => update })
  const checking = setup.controller.checkDesktopUpdate(false)
  await started
  assert.ok(seenSignal)
  assert.equal(seenSignal.aborted, false)
  const shutdown = setup.controller.shutdown(new Error('Desktop shutdown'))
  await Promise.all([checking, shutdown])
  assert.equal(dialogAborted, true)
  assert.equal(seenSignal.aborted, true)
  assert.equal(setup.controller.operationCoordinator.busy, false)
})

test('background installer checks do not occupy the shared Harness operation coordinator', async () => {
  let seenSignal
  const update = {
    state: 'idle',
    initialize: () => true,
    check: (_manual, { signal } = {}) => {
      seenSignal = signal
      return new Promise(resolve => signal?.addEventListener?.('abort', resolve, { once: true }))
    },
    menuItem: () => ({ label: 'Check', enabled: true }),
    abort: () => {},
    busy: true,
    checkAvailable: false,
    supported: true,
    externalReleaseAvailable: false,
    progress: 0,
    downloadedPath: undefined,
    targetVersion: undefined,
  }
  const setup = initializeWithUpdates({ createInstallerUpdate: () => update })
  setup.timers[0].callback()
  await nextTurn()
  assert.ok(seenSignal)
  assert.equal(setup.controller.operationCoordinator.busy, false)
  const shutdown = setup.controller.shutdown(new Error('test shutdown'))
  await shutdown
  assert.equal(seenSignal.aborted, true)
  assert.equal(setup.controller.operationCoordinator.busy, false)
})

test('fallback performs one bundled rollback and reports the failed managed startup', async () => {
  const first = new FakeServer({})
  const second = new FakeServer({})
  const managed = {
    version: '2.0.0',
    source: 'managed',
    entry: resolve('managed', 'bin.js'),
    bundled: { version: '1.0.0', source: 'bundled', entry: resolve('bundled', 'lib', 'bin.js') },
  }
  let fallbackCalls = 0
  const dsh = {
    state: 'idle', runtime: managed, busy: false, checkAvailable: true,
    managedRestoreAvailable: true, restoreAvailable: true,
    menuItem: () => ({ label: 'DSH', enabled: true }),
    restoreItem: () => undefined, abort() {}, check: async () => {}, restoreBundled: async () => {},
    useBundledFallback: () => {
      fallbackCalls += 1
      if (fallbackCalls !== 1) return false
      dsh.runtime = managed.bundled
      return true
    },
  }
  const setup = createRuntime({
    servers: [first, second],
    initialRuntime: managed,
    runtimeRoot: resolve('runtime'),
    createDshUpdate: () => dsh,
  })
  setup.controller.initializeUpdates()
  // HarnessServer-like fakes reject their start promise; the controller catches
  // it and then creates the one rollback generation.
  const startup = setup.controller.start('Initial')
  first.started.reject(new Error('managed runtime failed'))
  await new Promise(resolve => setImmediate(resolve))
  ready(second, 4104)
  assert.equal(await startup, false)
  assert.equal(fallbackCalls, 1)
  assert.equal(second.stops, 0)
  assert.equal(setup.controller.statusSnapshot().runtime.source, 'bundled')
})

test('default live-profile plugin work is fail-closed after startup', async () => {
  const server = new FakeServer({})
  const order = []
  const setup = initializeWithUpdates({
    dshHome: '/profile',
    runtimeRoot: '/runtime',
    servers: [server],
    plugins: {
      ensureDefaultPlugins: async () => { order.push('default') ; return { installed: [] } },
    },
  })
  assert.equal(await setup.controller.installDefaultPlugins(), false)
  assert.deepEqual(order, [])
})

test('a Harness cleanup-error event latches lifecycle unsafe and blocks restart replacement', async () => {
  const server = new FakeServer({})
  const setup = createRuntime({ servers: [server] })
  const started = setup.controller.start('Initial')
  await nextTurn()
  ready(server, 4110)
  assert.equal(await started, true)

  const cleanupError = new Error('unresolved Harness tree')
  server.emit('cleanup-error', { type: 'cleanup-error', error: cleanupError, cleanupError, unsafe: true })
  assert.equal(setup.controller.statusSnapshot().lifecycle.unsafe, true)
  assert.equal(setup.controller.lifecycleOwner.cleanupError, cleanupError)
  assert.match(setup.controller.statusSnapshot().lifecycle.cleanupError, /unresolved Harness tree/)
  await assert.rejects(setup.controller.restart('blocked restart'), error => error === cleanupError)
  assert.equal(setup.controller.statusSnapshot().lifecycle.unsafe, true)
})

test('legacy plugin mutation is fail-closed while the catalog reader remains read-only', async () => {
  const initial = { profile: 'web', profileDir: '/profile/profiles/web', plugins: [{ name: 'old' }], system: [], initialized: true }
  const reads = []
  let writerCalled = false
  const setup = createRuntime({
    dshHome: '/profile',
    plugins: {
      readPluginCatalog: () => { reads.push('read'); return initial },
      installPlugin: async () => { writerCalled = true },
    },
  })

  assert.equal(reads.length, 1, 'controller initializes its catalog cache before mutation attempts')
  const result = await setup.controller.pluginInstall('example-plugin')
  assert.equal(result.ok, false)
  assert.match(result.error, /structured candidate transaction/i)
  assert.equal(writerCalled, false)
  assert.equal(reads.length, 1, 'legacy mutation must not re-read or write the live profile')
  assert.deepEqual(setup.controller.pluginList().plugins, initial.plugins)
  assert.equal(setup.controller.statusSnapshot().plugins.installed, 1)
})

test('release controller re-verifies a prepared candidate from disk and gates activation', async t => {
  const setup = createReleaseFixture(t)
  const prepared = await setup.controller.prepareCandidate('stable')
  assert.equal(setup.controller.getCandidateStatus().switchAvailable, true)
  assert.equal(setup.verifyCalls.length, 1)

  const entry = join(prepared.candidateDir, 'runtime', 'versions', '2.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  rmSync(entry)
  await assert.rejects(() => setup.controller.switchCandidate(prepared.releaseId), /entry|regular file|ENOENT/i)
  assert.equal(setup.verifyCalls.length, 2)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
  assert.equal(setup.controller.getCandidateStatus().switchAvailable, false)
})

test('release controller materializes the physical DSH profile path before activation', async t => {
  const setup = createReleaseFixture(t)
  const prepared = await setup.controller.prepareCandidate('stable')
  await setup.controller.switchCandidate(prepared.releaseId)
  const physicalName = `ricardo-stable-${prepared.releaseId}`
  assert.equal(existsSync(join(prepared.candidateDir, 'profiles', physicalName, 'package.json')), true)
  assert.equal(existsSync(join(prepared.candidateDir, 'profiles', 'node_modules', '@dsh-desktop', 'integration', 'package.json')), true)
})

test('release controller exposes real snapshot and pending-recovery results through the shared coordinator', async t => {
  const setup = createReleaseFixture(t)
  const created = await setup.controller.createSnapshot({ kind: 'pre-switch', snapshotId: 'manual-1' })
  assert.equal(created.snapshotId, 'manual-1')
  const listed = await setup.controller.listSnapshots()
  assert.deepEqual(listed, [{ snapshotId: 'snapshot-1', kind: 'pre-switch' }])
  const restored = await setup.controller.restoreSnapshot('manual-1', { candidateId: setup.oldId })
  assert.equal(restored.status, 'rolled-back')
  assert.ok(setup.snapshotCalls.some(call => call.type === 'restore' && call.options.snapshotId === 'manual-1'))
  const recovered = await setup.controller.recoverPendingRelease()
  assert.equal(recovered.status, 'idle')
  assert.ok(setup.snapshotCalls.every(call => call.coordinatorLabel?.startsWith('release-') === true))
  assert.equal(setup.controller.operationCoordinator.active, undefined)
})

test('release recovery retires a failed staged plugin candidate after a missing-snapshot fallback', async t => {
  const candidateId = 'plugin-missing-recovery-snapshot'
  const discarded = []
  const missing = Object.assign(new Error('snapshot directory is missing'), { code: 'ENOENT' })
  const setup = createReleaseFixture(t, {
    restoreSnapshot: async () => {
      throw new Error('Unable to inspect Snapshot root', { cause: missing })
    },
    pluginTransactionService: {
      transaction: async () => ({ candidateId, parentReleaseId: 'stable-old' }),
      discardCandidateRelease: async request => {
        discarded.push(request)
        rmSync(request.candidatePath, { recursive: true, force: true })
        return { ok: true }
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })
  const staged = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  assert.equal(staged.ok, true)
  const previousActive = setup.state.readActive()
  setup.state.writePending({
    operation: 'switch',
    phase: 'restoring',
    previousActive,
    targetActive: null,
    snapshotId: 'missing-snapshot',
    rescueSnapshotId: null,
    startedAt: '2026-08-28T00:00:00.000Z',
  })

  const recovered = await setup.controller.recoverPendingRelease()

  assert.equal(recovered.status, 'recovered')
  assert.equal(recovered.snapshotMissing, true)
  assert.equal(setup.state.readPending(), undefined)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, null)
  assert.equal(discarded.length, 1)
  assert.equal(existsSync(join(setup.root, 'candidates', candidateId)), false)
})

test('observation failure reaches the controller switcher and restores the old release', async t => {
  const setup = createReleaseFixture(t, { failingReleaseId: '__prepared__' })
  const prepared = await setup.controller.prepareCandidate('stable')
  await assert.rejects(() => setup.controller.switchCandidate(prepared.releaseId), /healthy|observation|ready/i)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
  assert.equal(setup.state.readPending(), undefined)
  assert.ok(setup.snapshotCalls.some(call => call.type === 'restore'))
})

test('release observation forwards AbortSignal and cancels without touching live DSH', async t => {
  const action = new AbortController()
  const observed = deferred()
  const setup = createReleaseFixture(t, {
    observeRelease: (_release, { signal }) => new Promise((resolve, reject) => {
      observed.resolve()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const prepared = await setup.controller.prepareCandidate('stable')
  const switching = setup.controller.switchCandidate(prepared.releaseId, { signal: action.signal })
  await observed.promise
  action.abort(new Error('test abort'))
  await assert.rejects(switching, /test abort|abort/i)
  assert.equal(action.signal.aborted, true)
})

test('active compatibility audit leaves an already-compatible immutable release untouched', async t => {
  let transactionCalls = 0
  const compatibilityCalls = []
  const setup = createReleaseFixture(t, {
    activeVersion: '0.1.1-rc.2',
    activeBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    owners: {
      applyCompatibilityRecipe: async request => {
        compatibilityCalls.push(request)
        return { targets: [{ id: 'windows-directory-picker-host', state: 'already-applied' }] }
      },
    },
    pluginTransactionService: {
      transaction: async () => { transactionCalls += 1 },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.repairActiveCompatibility()

  assert.deepEqual(result, { ok: true, repaired: false, releaseId: setup.oldId, reason: 'already-compatible' })
  assert.equal(compatibilityCalls.length, 1)
  assert.equal(compatibilityCalls[0].write, false)
  assert.equal(setup.verifyCalls.length, 1)
  assert.equal(setup.verifyCalls[0].verifyRuntime, false)
  assert.equal(transactionCalls, 0)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
})

test('active plugin compatibility repair migrates a patched runtime through an immutable child', async t => {
  const transactionCalls = []
  const compatibilityCalls = []
  const activeBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@linxin666/dsh-doctor']
  const setup = createReleaseFixture(t, {
    activeVersion: '2.0.0',
    activeBundles,
    owners: {
      applyCompatibilityRecipe: async () => {
        throw new Error('The DSH compatibility recipe must not run for an unrelated runtime version')
      },
      ensureCandidatePluginRuntimeCompatibility: async (candidateDir, _profilePath, _repositoryRoot, options) => {
        const releaseId = basename(candidateDir)
        compatibilityCalls.push({ releaseId, options })
        const state = releaseId === 'stable-old' ? 'patched' : 'compatible'
        return {
          checks: [{
            packageName: '@linxin666/dsh-doctor',
            required: true,
            state,
            targets: [{ id: 'cli-launcher', state }],
          }],
        }
      },
    },
    pluginTransactionService: {
      transaction: async request => {
        transactionCalls.push(request)
        return { candidateId: 'plugin-compatibility-child', parentReleaseId: 'stable-old' }
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.repairActiveCompatibility()

  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  assert.equal(result.releaseId, 'plugin-compatibility-child')
  assert.deepEqual(result.targets, ['plugin:@linxin666/dsh-doctor:cli-launcher'])
  assert.equal(transactionCalls.length, 1)
  assert.equal(transactionCalls[0].action, 'reorder')
  assert.deepEqual(transactionCalls[0].order, activeBundles)
  assert.ok(compatibilityCalls.some(call => call.releaseId === 'stable-old' && call.options?.write === false))
  assert.ok(compatibilityCalls.some(call => call.releaseId === 'plugin-compatibility-child'))
  assert.equal(setup.state.readActive().releaseId, 'plugin-compatibility-child')
  assert.equal(setup.state.readLastKnownGood().releaseId, 'plugin-compatibility-child')
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
})

test('active compatibility repair migrates through one immutable child and preserves bundle order', async t => {
  const transactionCalls = []
  const activeBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket']
  const setup = createReleaseFixture(t, {
    activeVersion: '0.1.1-rc.2',
    activeBundles,
    owners: {
      applyCompatibilityRecipe: async request => ({
        targets: [{ id: 'windows-directory-picker-host', state: request.write === false ? 'patched' : 'already-applied' }],
      }),
    },
    pluginTransactionService: {
      transaction: async request => {
        transactionCalls.push(request)
        return { candidateId: 'plugin-compatibility-child', parentReleaseId: 'stable-old' }
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const [first, second] = await Promise.all([
    setup.controller.repairActiveCompatibility(),
    setup.controller.repairActiveCompatibility(),
  ])

  assert.equal(first.ok, true)
  assert.equal(first.repaired, true)
  assert.equal(first.releaseId, 'plugin-compatibility-child')
  assert.deepEqual(second, first)
  assert.equal(transactionCalls.length, 1)
  assert.equal(transactionCalls[0].action, 'reorder')
  assert.deepEqual(transactionCalls[0].order, activeBundles)
  assert.equal(setup.state.readActive().releaseId, 'plugin-compatibility-child')
  assert.equal(setup.state.readLastKnownGood().releaseId, 'plugin-compatibility-child')
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
})

test('active compatibility repair failure preserves the active and last-known-good release', async t => {
  const setup = createReleaseFixture(t, {
    activeVersion: '0.1.1-rc.2',
    activeBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    owners: {
      applyCompatibilityRecipe: async () => ({
        targets: [{ id: 'windows-directory-picker-worker', state: 'patched' }],
      }),
    },
    pluginTransactionService: {
      transaction: async () => { throw new Error('candidate clone failed') },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.repairActiveCompatibility()

  assert.equal(result.ok, false)
  assert.match(result.error, /candidate clone failed/i)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
  assert.equal(setup.state.readLastKnownGood().releaseId, setup.oldId)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
})

test('a pending plugin candidate cannot be overwritten by another transaction', async t => {
  let transactionCalls = 0
  const pluginTransactionService = {
    transaction: async () => {
      transactionCalls += 1
      return {
        candidateId: `plugin-pending-${String(transactionCalls)}`,
        parentReleaseId: 'stable-old',
      }
    },
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })

  const first = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  const second = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.error, /already waiting for activation/i)
  assert.equal(transactionCalls, 1)
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, 'plugin-pending-1')
  assert.equal(setup.state.readStagedPluginCandidate().candidateId, 'plugin-pending-1')
})

test('managed market update derives the immutable npm source and authorizes its own candidate build', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    activeDependencies: { dshmarket: '1.29.2' },
    pluginTransactionService: {
      transaction: async request => {
        calls.push(request)
        throw new Error('stop after source derivation')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })
  writeFileSync(
    join(setup.root, 'candidates', setup.oldId, 'profile', 'pnpm-workspace.yaml'),
    'allowBuilds:\n  dshmarket@git+https://github.com/dsh-market/dsh-market.git: true\n',
  )

  const result = await setup.controller.pluginMarketUpdate({ name: 'dshmarket', kind: 'npm', target: '1.31.1' })

  assert.equal(result.ok, false)
  assert.match(result.error, /stop after source derivation/i)
  assert.equal(setup.verifyCalls[0].verifyRuntime, false)
  assert.equal(calls.length, 1)
  assert.deepEqual({
    action: calls[0].action,
    name: calls[0].name,
    source: calls[0].source,
    buildPermissions: calls[0].buildPermissions,
  }, {
    action: 'update',
    name: 'dshmarket',
    source: { type: 'npm', package: 'dshmarket', versionOrTag: '1.31.1' },
    buildPermissions: { dshmarket: true },
  })
})

test('managed market update upgrades the bundled Doctor through its latest audited desktop adapter', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    activeDependencies: {
      '@linxin666/dsh-doctor': 'file:./packages/linxin666-dsh-doctor-0.3.6-dshdesktop.1.tgz',
    },
    pluginTransactionService: {
      transaction: async request => {
        calls.push(request)
        throw new Error('stop after Doctor source derivation')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketUpdate({
    name: '@linxin666/dsh-doctor',
    kind: 'npm',
    target: '0.3.10',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /stop after Doctor source derivation/i)
  assert.equal(calls.length, 1)
  assert.deepEqual({
    action: calls[0].action,
    name: calls[0].name,
    source: calls[0].source,
    buildPermissions: calls[0].buildPermissions,
  }, {
    action: 'update',
    name: '@linxin666/dsh-doctor',
    source: { type: 'npm', package: '@linxin666/dsh-doctor', versionOrTag: '0.3.10' },
    buildPermissions: {
      '@linxin666/dsh-doctor': true,
      'node-pty': true,
      protobufjs: true,
    },
  })
})

test('managed market update lets the generic candidate gates assess a future Doctor', async t => {
  let transactionCalls = 0
  const setup = createReleaseFixture(t, {
    activeDependencies: {
      '@linxin666/dsh-doctor': 'file:./packages/linxin666-dsh-doctor-0.3.6-dshdesktop.1.tgz',
    },
    pluginTransactionService: {
      transaction: async () => {
        transactionCalls += 1
        throw new Error('stop after generic Doctor source derivation')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketUpdate({
    name: '@linxin666/dsh-doctor',
    kind: 'npm',
    target: '0.3.11',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /stop after generic Doctor source derivation/i)
  assert.equal(transactionCalls, 1)
})

test('managed market update never grants an unrelated plugin build script', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    activeDependencies: { dshmarket: '1.29.2' },
    pluginTransactionService: {
      transaction: async request => {
        calls.push(request)
        throw new Error('stop after source derivation')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })
  writeFileSync(
    join(setup.root, 'candidates', setup.oldId, 'profile', 'pnpm-workspace.yaml'),
    'allowBuilds:\n  unrelated-plugin: true\n',
  )

  const result = await setup.controller.pluginMarketUpdate({ name: 'dshmarket', kind: 'npm', target: '1.31.1' })

  assert.equal(result.ok, false)
  assert.match(result.error, /stop after source derivation/i)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].buildPermissions, { dshmarket: true })
})

test('managed market update stages every requested plugin in one candidate and preserves enabled order', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    activeBundles: ['plugin-a'],
    activeDependencies: { 'plugin-a': '1.0.0', 'plugin-b': '2.0.0' },
    pluginTransactionService: {
      transaction: async () => assert.fail('batch update must not create one candidate per plugin'),
      installMany: async request => {
        calls.push(request)
        throw new Error('stop after batch source derivation')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketUpdate({
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.1.0' },
      { name: 'plugin-b', kind: 'npm', target: '2.1.0' },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /stop after batch source derivation/i)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, [
    { name: 'plugin-a', source: { type: 'npm', package: 'plugin-a', versionOrTag: '1.1.0' }, enabled: true },
    { name: 'plugin-b', source: { type: 'npm', package: 'plugin-b', versionOrTag: '2.1.0' }, enabled: false },
  ])
  assert.deepEqual(calls[0].buildPermissions, { 'plugin-a': true, 'plugin-b': true })
})

test('managed update-all skips incompatible npm engines without blocking compatible rows', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    activeVersion: '0.1.1-rc.2',
    activeBundles: ['plugin-a', 'plugin-c'],
    activeDependencies: { 'plugin-a': '1.0.0', 'plugin-b': '2.0.0', 'plugin-c': '3.0.0' },
    inspectMarketPluginMetadata: async ({ name, target }) => ({
      pluginVersion: target,
      requiredRange: name === 'plugin-c' ? '>=0.1.2-alpha.1' : '>=0.1.1-rc.1',
    }),
    pluginTransactionService: {
      transaction: async () => assert.fail('two compatible rows must remain one batch'),
      installMany: async request => {
        calls.push(request)
        throw new Error('stop after compatible batch filtering')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketUpdate({
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.1.0' },
      { name: 'plugin-b', kind: 'npm', target: '2.1.0' },
      { name: 'plugin-c', kind: 'npm', target: '3.1.0' },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /stop after compatible batch filtering/i)
  assert.deepEqual(calls[0].sources, [
    { name: 'plugin-a', source: { type: 'npm', package: 'plugin-a', versionOrTag: '1.1.0' }, enabled: true },
    { name: 'plugin-b', source: { type: 'npm', package: 'plugin-b', versionOrTag: '2.1.0' }, enabled: false },
  ])
  assert.equal(calls[0].buildPermissions['plugin-c'], undefined)
  assert.equal(setup.logs.some(entry => entry.text.includes('Skipped market update plugin-c@3.1.0')), true)
})

test('managed market update fails before mutation when every requested engine is incompatible', async t => {
  let transactionCalls = 0
  const setup = createReleaseFixture(t, {
    activeVersion: '0.1.1-rc.2',
    activeDependencies: { 'plugin-a': '1.0.0' },
    inspectMarketPluginMetadata: async ({ target }) => ({
      pluginVersion: target,
      requiredRange: '>=0.1.2-alpha.1',
    }),
    pluginTransactionService: {
      transaction: async () => { transactionCalls += 1 },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketUpdate({ name: 'plugin-a', kind: 'npm', target: '1.1.0' })
  assert.equal(result.ok, false)
  assert.match(result.error, /No compatible plugin update can run on DSH 0\.1\.1-rc\.2/i)
  assert.match(result.error, /requires DSH >=0\.1\.2-alpha\.1/i)
  assert.equal(transactionCalls, 0)
})

test('active settings document resolves inside the verified managed profile', async t => {
  const setup = createReleaseFixture(t, {
    activeBundles: ['dshmarket'],
    activeDependencies: { dshmarket: '1.34.0' },
  })
  const settingsPath = await setup.controller.getActiveSettingsPath()
  assert.equal(settingsPath, join(setup.root, 'candidates', setup.oldId, 'settings.yaml'))
})

test('managed market install resolves one trusted catalog entry into a candidate batch', async t => {
  const calls = []
  const setup = createReleaseFixture(t, {
    resolveMarketSource: async () => ({ packageName: 'dsh-reasoning-effort', source: { type: 'github', repository: 'HanaAyane/dsh-reasoning-effort', ref: 'a'.repeat(40) } }),
    loadPluginCatalog: async () => ({
      catalog: {
        plugins: [{
          name: 'dsh-reasoning-effort',
          repository: 'HanaAyane/dsh-reasoning-effort',
          url: 'https://github.com/HanaAyane/dsh-reasoning-effort',
          source: 'github',
        }],
      },
    }),
    pluginTransactionService: {
      transaction: async () => ({}),
      installMany: async request => {
        calls.push(request)
        throw new Error('stop after trusted source resolution')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketInstall({ url: 'https://github.com/HanaAyane/dsh-reasoning-effort/' })

  assert.equal(result.ok, false)
  assert.match(result.error, /stop after trusted source resolution/i)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, [{
    name: 'dsh-reasoning-effort',
    source: { type: 'github', repository: 'HanaAyane/dsh-reasoning-effort', ref: 'a'.repeat(40) },
  }])
  assert.deepEqual(calls[0].buildPermissions, { 'dsh-reasoning-effort': true })
})

test('managed market install grants only the audited Doctor build dependencies', async t => {
  const calls = []
  const url = 'https://github.com/linxin666/dsh-doctor'
  const setup = createReleaseFixture(t, {
    loadPluginCatalog: async () => ({
      catalog: {
        plugins: [{
          name: 'DSH Doctor',
          npm: '@linxin666/dsh-doctor',
          url,
          source: 'npm',
        }],
      },
    }),
    pluginTransactionService: {
      transaction: async () => ({}),
      installMany: async request => {
        calls.push(request)
        throw new Error('stop after Doctor install source resolution')
      },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketInstall({ url })
  assert.equal(result.ok, false)
  assert.match(result.error, /stop after Doctor install source resolution/i)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, [{
    name: '@linxin666/dsh-doctor',
    source: { type: 'npm', package: '@linxin666/dsh-doctor' },
  }])
  assert.deepEqual(calls[0].buildPermissions, {
    '@linxin666/dsh-doctor': true,
    'node-pty': true,
    protobufjs: true,
  })
})

test('managed market install resolves uncatalogued sources by manifest identity and stages them through the transaction', async t => {
  const calls = []
  const resolved = { packageName: '@author/scoped-plugin', source: { type: 'github', repository: 'example/not-in-catalog', ref: 'a'.repeat(40) } }
  const setup = createReleaseFixture(t, {
    loadPluginCatalog: async () => ({ catalog: { plugins: [] } }),
    resolveMarketSource: async () => resolved,
    pluginTransactionService: {
      transaction: async () => ({}),
      installMany: async request => { calls.push(request); throw new Error('verified transaction reached') },
      removePreview: async () => ({}),
      confirmRemove: async () => ({}),
    },
  })

  const result = await setup.controller.pluginMarketInstall({ url: 'https://github.com/example/not-in-catalog' })
  assert.equal(result.ok, false)
  assert.match(result.error, /verified transaction reached/i)
  assert.deepEqual(calls[0].sources, [{ name: resolved.packageName, source: resolved.source }])
})

test('a transaction without parent provenance fails closed and retires its unstaged candidate', async t => {
  const discarded = []
  const candidateId = 'plugin-missing-parent'
  const pluginTransactionService = {
    transaction: async () => ({ candidateId }),
    discardCandidateRelease: async request => {
      discarded.push(request)
      rmSync(request.candidatePath, { recursive: true, force: true })
      return { ok: true }
    },
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })

  const result = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })

  assert.equal(result.ok, false)
  assert.match(result.error, /parent release id/i)
  assert.equal(discarded.length, 1)
  assert.equal(discarded[0].candidateId, candidateId)
  assert.equal(existsSync(join(setup.root, 'candidates', candidateId)), false)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
})

test('staging reconciles an inherited active-parent manifest identity before journaling', async t => {
  const candidateId = 'plugin-stale-parent-manifest'
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId,
      parentReleaseId: 'stable-old',
    }),
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, {
    pluginTransactionService,
    pluginCandidateManifestReleaseId: 'stable-old',
  })

  const result = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })

  assert.equal(result.ok, true)
  const manifest = JSON.parse(readFileSync(join(setup.root, 'candidates', candidateId, 'manifest.json'), 'utf8'))
  assert.equal(manifest.releaseId, candidateId)
  assert.equal(setup.state.readStagedPluginCandidate().candidateId, candidateId)
  assert.match(setup.logs.map(entry => entry.text).join('\n'), /Recovered stale parent manifest identity stable-old as plugin-stale-parent-manifest during staging/)
})

test('staging rejects and retires a candidate with an unrelated manifest identity', async t => {
  const discarded = []
  const candidateId = 'plugin-unrelated-manifest'
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId,
      parentReleaseId: 'stable-old',
    }),
    discardCandidateRelease: async request => {
      discarded.push(request)
      rmSync(request.candidatePath, { recursive: true, force: true })
      return { ok: true }
    },
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, {
    pluginTransactionService,
    pluginCandidateManifestReleaseId: 'stable-unrelated',
  })

  const result = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })

  assert.equal(result.ok, false)
  assert.match(result.error, /identity mismatch/)
  assert.equal(discarded.length, 1)
  assert.equal(discarded[0].candidateId, candidateId)
  assert.equal(existsSync(join(setup.root, 'candidates', candidateId)), false)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
})

test('a verified plugin candidate is journaled and clears only after confirmed activation', async t => {
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId: 'plugin-persistent-restart',
      parentReleaseId: 'stable-old',
    }),
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })
  const staged = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  assert.equal(staged.ok, true)
  assert.equal(setup.state.readStagedPluginCandidate().candidateId, 'plugin-persistent-restart')

  const result = await setup.controller.restartPluginChanges()
  assert.equal(result.status, 'switched')
  assert.equal(result.pointer.releaseId, 'plugin-persistent-restart')
  assert.equal(setup.state.readActive().releaseId, 'plugin-persistent-restart')
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, null)
})

test('fresh startup preserves a staged candidate while its published switch is still restoring', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-controller-staged-restoring-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = new ReleaseStateStore(join(root, 'release-state'))
  const parent = releasePointer('stable-parent', 'a'.repeat(64))
  const candidate = releasePointer('plugin-unsettled-child', 'b'.repeat(64))
  state.writeActive(candidate)
  state.writeLastKnownGood(parent)
  state.writeStagedPluginCandidate({
    schemaVersion: 1,
    candidateId: candidate.releaseId,
    parentReleaseId: parent.releaseId,
    manifestSha256: candidate.manifestSha256,
    stagedAt: '2026-08-30T00:00:00.000Z',
  })
  state.writePending({
    operation: 'switch',
    phase: 'restoring',
    previousActive: parent,
    targetActive: null,
    snapshotId: 'missing-snapshot',
    rescueSnapshotId: null,
    startedAt: '2026-08-30T00:00:00.000Z',
  })

  const setup = createRuntime({
    runtimeRoot: root,
    dshHome: join(root, 'dsh-home'),
    runtime: { repositoryRoot: join(root, 'repository') },
    releaseStateStore: state,
    snapshotStore: {
      create: async () => ({}),
      list: async () => [],
      restore: async () => ({}),
    },
    releaseSwitcher: {
      switch: async () => ({}),
      recoverPending: async () => ({ status: 'idle' }),
    },
  })

  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, candidate.releaseId)
  assert.equal(state.readStagedPluginCandidate().candidateId, candidate.releaseId)
})

test('failed plugin restart preserves the exact pending candidate for retry', async t => {
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId: 'plugin-missing-on-disk',
      parentReleaseId: 'stable-old',
    }),
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })
  const staged = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  assert.equal(staged.ok, true)
  rmSync(join(setup.root, 'candidates', 'plugin-missing-on-disk'), { recursive: true, force: true })

  await assert.rejects(setup.controller.restartPluginChanges(), /ENOENT|candidate|manifest/i)
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, 'plugin-missing-on-disk')
  assert.equal(setup.controller.statusSnapshot().plugins.restartRequired, true)
  assert.equal(setup.state.readStagedPluginCandidate().candidateId, 'plugin-missing-on-disk')
})

test('failed startup candidate can be retired once so it is not retried forever', async t => {
  const discarded = []
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId: 'plugin-startup-failed',
      parentReleaseId: 'stable-old',
    }),
    discardCandidateRelease: async request => {
      discarded.push(request)
      rmSync(request.candidatePath, { recursive: true, force: true })
      return { ok: true }
    },
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })
  const staged = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  assert.equal(staged.ok, true)

  const retired = await setup.controller.abandonPendingPluginCandidate('startup resume failure')

  assert.equal(retired.ok, true)
  assert.equal(retired.abandoned, true)
  assert.equal(discarded.length, 1)
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, null)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
})

test('failed startup cleanup still retires the durable journal so it is not retried forever', async t => {
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId: 'plugin-startup-cleanup-failed',
      parentReleaseId: 'stable-old',
    }),
    discardCandidateRelease: async () => { throw new Error('candidate directory is locked') },
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })
  const staged = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  assert.equal(staged.ok, true)

  await assert.rejects(
    setup.controller.abandonPendingPluginCandidate('startup resume failure'),
    /candidate directory is locked/i,
  )
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, null)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
  assert.equal(setup.state.readActive().releaseId, setup.oldId)
})

test('cancellation after a transaction report discards the candidate before journaling', async t => {
  const operation = new AbortController()
  const discarded = []
  const pluginTransactionService = {
    transaction: async () => {
      operation.abort(new Error('caller cancelled after install'))
      return {
        candidateId: 'plugin-cancelled-before-stage',
        parentReleaseId: 'stable-old',
      }
    },
    discardCandidateRelease: async request => {
      discarded.push(request)
      rmSync(request.candidatePath, { recursive: true, force: true })
      return { ok: true }
    },
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })

  const result = await setup.controller.pluginTransaction(
    { action: 'reorder', order: [] },
    { signal: operation.signal },
  )

  assert.equal(result.ok, false)
  assert.match(result.error, /abort|cancel/i)
  assert.equal(discarded.length, 1)
  assert.equal(discarded[0].candidateId, 'plugin-cancelled-before-stage')
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, null)
  assert.equal(setup.state.readStagedPluginCandidate(), undefined)
})

test('plugin restart rejects a candidate whose active parent changed and keeps it pending', async t => {
  const pluginTransactionService = {
    transaction: async () => ({
      candidateId: 'plugin-parent-bound',
      parentReleaseId: 'stable-old',
    }),
    removePreview: async () => ({}),
    confirmRemove: async () => ({}),
  }
  const setup = createReleaseFixture(t, { pluginTransactionService })
  const staged = await setup.controller.pluginTransaction({ action: 'reorder', order: [] })
  assert.equal(staged.ok, true)
  setup.state.writeActive(releasePointer('stable-new-parent', 'c'.repeat(64)))

  await assert.rejects(
    setup.controller.restartPluginChanges(),
    error => error?.code === 'PLUGIN_CANDIDATE_PARENT_CHANGED',
  )
  assert.equal(setup.controller.statusSnapshot().plugins.pendingCandidateId, 'plugin-parent-bound')
  assert.equal(setup.state.readActive().releaseId, 'stable-new-parent')
  assert.equal(setup.state.readStagedPluginCandidate().candidateId, 'plugin-parent-bound')
})
