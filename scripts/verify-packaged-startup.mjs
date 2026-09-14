import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, parse, posix, resolve, win32 } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnOwnedProcess } from '../src/process-tree.js'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_TIMEOUT_MS = 90_000
const MAX_TIMEOUT_MS = 10 * 60_000
const CDP_CALL_TIMEOUT_MS = 4_000
const ISOLATION_MARKER = '.dsh-packaged-startup-isolation.json'
const EPHEMERAL_CI_ISOLATION_MODE = 'ephemeral GitHub runner; app userData path not independently verified'

class ProbeError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new ProbeError(code)
}

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-packaged-startup.mjs --executable <absolute-path> --output-dir <new-absolute-dir> --isolated-home <absolute-dir> --ephemeral-ci [--reuse-isolated-home] [--timeout-ms <1000..600000>] [--debug-port <1..65535>] [--allow-onboarding | --complete-onboarding] [--no-screenshot]',
    '',
    'The executable, output, and isolated-home arguments are mandatory. Output must be new; an existing isolated home is accepted only with --reuse-isolated-home and this helper\'s ownership marker. The helper only launches the supplied unpacked executable and only terminates the exact process tree it created.',
  ].join('\n')
}

export function parseArguments(argv) {
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--allow-onboarding' || argument === '--complete-onboarding' || argument === '--no-screenshot' || argument === '--reuse-isolated-home' || argument === '--ephemeral-ci') {
      flags.add(argument)
      continue
    }
    if (!['--executable', '--output-dir', '--isolated-home', '--timeout-ms', '--debug-port'].includes(argument)) fail('INVALID_ARGUMENTS')
    const value = argv[index + 1]
    if (typeof value !== 'string' || value.startsWith('--') || values.has(argument)) fail('INVALID_ARGUMENTS')
    values.set(argument, value)
    index += 1
  }

  for (const key of ['--executable', '--output-dir', '--isolated-home']) {
    if (!values.has(key)) fail('MISSING_REQUIRED_ARGUMENT')
  }
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) fail('INVALID_TIMEOUT')
  const debugPort = values.has('--debug-port') ? Number(values.get('--debug-port')) : undefined
  if (debugPort !== undefined && (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65_535)) fail('INVALID_DEBUG_PORT')
  return Object.freeze({
    executable: values.get('--executable'),
    outputDir: values.get('--output-dir'),
    isolatedHome: values.get('--isolated-home'),
    timeoutMs,
    debugPort,
    allowOnboarding: flags.has('--allow-onboarding'),
    screenshot: !flags.has('--no-screenshot'),
    reuseIsolatedHome: flags.has('--reuse-isolated-home'),
    ephemeralCi: flags.has('--ephemeral-ci'),
    completeOnboarding: flags.has('--complete-onboarding'),
  })
}

function absolutePath(value, code) {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) fail(code)
  return resolve(value)
}

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix
}

export function isPathWithin(parent, target, platform = process.platform) {
  const paths = pathApi(platform)
  if (!paths.isAbsolute(parent) || !paths.isAbsolute(target)) return false
  const relation = paths.relative(parent, target)
  return relation === '' || (!relation.startsWith(`..${paths.sep}`) && relation !== '..' && !paths.isAbsolute(relation))
}

export function validatePathBoundaries({ executable, outputDirectory, isolatedHome, platform = process.platform }) {
  const paths = pathApi(platform)
  if (![executable, outputDirectory, isolatedHome].every(path => typeof path === 'string' && paths.isAbsolute(path))) fail('PATH_NOT_ABSOLUTE')
  if (isPathWithin(outputDirectory, isolatedHome, platform) || isPathWithin(isolatedHome, outputDirectory, platform)) fail('OUTPUT_AND_HOME_OVERLAP')
  const executableDirectory = paths.dirname(executable)
  if (isPathWithin(executableDirectory, outputDirectory, platform) || isPathWithin(executableDirectory, isolatedHome, platform)
    || isPathWithin(outputDirectory, executableDirectory, platform) || isPathWithin(isolatedHome, executableDirectory, platform)) {
    fail('EXECUTABLE_DIRECTORY_OVERLAP')
  }
}

export function validateEphemeralCi({ enabled, platform = process.platform, env = process.env, executable, outputDirectory, isolatedHome }) {
  if (!enabled) fail('LOCAL_USER_DATA_ROOT_UNVERIFIED')
  const expectedRunnerOs = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : undefined
  if (expectedRunnerOs === undefined) fail('EPHEMERAL_CI_PLATFORM_UNSUPPORTED')
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.RUNNER_OS !== expectedRunnerOs) fail('EPHEMERAL_CI_ENVIRONMENT_UNVERIFIED')
  const runnerTemp = env.RUNNER_TEMP
  const workspace = env.GITHUB_WORKSPACE
  const paths = pathApi(platform)
  if (typeof runnerTemp !== 'string' || typeof workspace !== 'string' || !paths.isAbsolute(runnerTemp) || !paths.isAbsolute(workspace)) {
    fail('EPHEMERAL_CI_PATHS_UNVERIFIED')
  }
  if (!isPathWithin(workspace, executable, platform) || !isPathWithin(runnerTemp, outputDirectory, platform) || !isPathWithin(runnerTemp, isolatedHome, platform)) {
    fail('EPHEMERAL_CI_PATHS_UNVERIFIED')
  }
  return Object.freeze({ isolationMode: EPHEMERAL_CI_ISOLATION_MODE, runnerTemp, workspace })
}

async function canonicalDirectory(path, code) {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory()) fail(code)
    return await realpath(path)
  } catch (error) {
    if (error instanceof ProbeError) throw error
    fail(code)
  }
}

async function canonicalExistingAncestor(path, code) {
  let candidate = path
  while (true) {
    try {
      await lstat(candidate)
      return await realpath(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(code)
      const parent = dirname(candidate)
      if (parent === candidate) fail(code)
      candidate = parent
    }
  }
}

async function assertCanonicalContained(root, target, code) {
  const canonicalRoot = await canonicalDirectory(root, code)
  const canonicalAncestor = await canonicalExistingAncestor(target, code)
  if (!isPathWithin(canonicalRoot, canonicalAncestor)) fail(code)
}

async function assertEphemeralCiCanonicalPaths({ runnerTemp, workspace, executable, outputDirectory, isolatedHome }) {
  await assertCanonicalContained(workspace, executable, 'EPHEMERAL_CI_PATHS_UNVERIFIED')
  await assertCanonicalContained(runnerTemp, outputDirectory, 'EPHEMERAL_CI_PATHS_UNVERIFIED')
  await assertCanonicalContained(runnerTemp, isolatedHome, 'EPHEMERAL_CI_PATHS_UNVERIFIED')
}

async function directoryDoesNotExist(path, code) {
  try {
    await lstat(path)
    fail(code)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
}

async function createNewDirectory(path, code) {
  const parent = dirname(path)
  let parentStats
  try {
    parentStats = await lstat(parent)
  } catch {
    fail('PARENT_DIRECTORY_MISSING')
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) fail('UNSAFE_PARENT_DIRECTORY')
  await directoryDoesNotExist(path, code)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') fail(code)
    throw error
  }
}

async function prepareIsolatedHome(path, allowReuse) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (stats !== undefined) {
    if (!allowReuse || !stats.isDirectory() || stats.isSymbolicLink()) fail('ISOLATED_HOME_EXISTS')
    let marker
    try {
      marker = JSON.parse(await readFile(join(path, ISOLATION_MARKER), 'utf8'))
    } catch {
      fail('ISOLATED_HOME_UNOWNED')
    }
    if (marker?.schema !== 1 || marker?.owner !== 'verify-packaged-startup') fail('ISOLATED_HOME_UNOWNED')
    return { reused: true }
  }
  await createNewDirectory(path, 'ISOLATED_HOME_EXISTS')
  await writeFile(join(path, ISOLATION_MARKER), `${JSON.stringify({ schema: 1, owner: 'verify-packaged-startup' })}\n`, { flag: 'wx', mode: 0o600 })
  return { reused: false }
}

async function assertExecutable(path) {
  let stats
  try {
    stats = await lstat(path)
    await access(path, fsConstants.X_OK)
  } catch {
    fail('EXECUTABLE_UNAVAILABLE')
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail('EXECUTABLE_UNAVAILABLE')
  if (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe')) fail('WINDOWS_EXECUTABLE_REQUIRED')
  if (process.platform === 'darwin' && !path.includes('.app/Contents/MacOS/')) fail('MACOS_APP_EXECUTABLE_REQUIRED')
}

function packageManifestPath(executable) {
  if (process.platform === 'win32') return join(dirname(executable), 'resources', 'app', 'package.json')
  if (process.platform === 'darwin') return join(dirname(dirname(executable)), 'Resources', 'app', 'package.json')
  fail('UNSUPPORTED_PLATFORM')
}

async function readPackagedVersion(executable) {
  try {
    const manifest = JSON.parse(await readFile(packageManifestPath(executable), 'utf8'))
    if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string' || manifest.version.trim() === '') fail('PACKAGED_MANIFEST_INVALID')
    return manifest.version
  } catch (error) {
    if (error instanceof ProbeError) throw error
    fail('PACKAGED_MANIFEST_UNAVAILABLE')
  }
}

function windowsProfileEnvironment(home) {
  const parsed = parse(home)
  if (parsed.root === '') fail('ISOLATED_HOME_INVALID')
  const homePath = home.slice(parsed.root.length)
  return {
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: parsed.root.replace(/[\\/]+$/, ''),
    HOMEPATH: `\\${homePath.replaceAll('/', '\\')}`,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(home, 'Temp'),
    TMP: join(home, 'Temp'),
  }
}

function inheritedPlatformEnvironment() {
  // Start from a narrow allowlist. In particular this avoids carrying cloud,
  // registry, proxy, package-manager, SSH, or model-provider credentials into
  // the application or its DSH child process.
  const names = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'CommonProgramFiles(x86)']
    : ['PATH', 'LANG', 'LC_ALL', 'TERM']
  return Object.fromEntries(names.flatMap(name => typeof process.env[name] === 'string' && process.env[name] !== '' ? [[name, process.env[name]]] : []))
}

export function isolatedEnvironment({ home, userData }) {
  const shared = {
    ...inheritedPlatformEnvironment(),
    DSH_HOME: join(home, '.dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '',
  }
  if (process.platform === 'win32') return { ...shared, ...windowsProfileEnvironment(home) }
  return {
    ...shared,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(home, 'tmp'),
    // Electron's documented switch is still passed below. This environment is
    // not treated as proof that macOS app.getPath('userData') is isolated.
    USERPROFILE: home,
    ...userData === undefined ? {} : { USER_DATA_DIR: userData },
  }
}

async function createIsolationLayout(home) {
  const directories = process.platform === 'win32'
    ? [join(home, 'AppData'), join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local'), join(home, 'Temp'), join(home, '.dsh')]
    : [join(home, '.config'), join(home, '.cache'), join(home, 'tmp'), join(home, '.dsh')]
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 })
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise)
  })
  const address = server.address()
  await new Promise(resolvePromise => server.close(resolvePromise))
  if (typeof address !== 'object' || address === null || !Number.isInteger(address.port)) fail('DEBUG_PORT_ALLOCATION_FAILED')
  return address.port
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CDP_CALL_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error('CDP_ENDPOINT_UNAVAILABLE')
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function cdpConnection(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let sequence = 0
    let opened = false
    let closed = false
    const stopSocket = () => {
      if (closed) return
      closed = true
      try { socket.terminate() } catch { try { socket.close() } catch {} }
    }
    const rejectAll = error => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }
    const handshakeTimer = setTimeout(() => {
      if (opened) return
      stopSocket()
      reject(new Error('CDP_HANDSHAKE_TIMEOUT'))
    }, CDP_CALL_TIMEOUT_MS)
    socket.once('open', () => {
      opened = true
      clearTimeout(handshakeTimer)
      resolvePromise({
      call(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++sequence
          const timer = setTimeout(() => {
            pending.delete(id)
            rejectCall(new Error('CDP_CALL_TIMEOUT'))
          }, CDP_CALL_TIMEOUT_MS)
          pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
          socket.send(JSON.stringify({ id, method, params }))
        })
      },
      close() {
        rejectAll(new Error('CDP_CLOSED'))
        stopSocket()
      },
      })
    })
    socket.on('message', raw => {
      let message
      try { message = JSON.parse(String(raw)) } catch { return }
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) entry.reject(new Error('CDP_PROTOCOL_ERROR'))
      else entry.resolve(message.result)
    })
    socket.on('error', () => {
      clearTimeout(handshakeTimer)
      const error = new Error('CDP_SOCKET_ERROR')
      if (!opened) reject(error)
      rejectAll(error)
      stopSocket()
    })
    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      const error = new Error('CDP_CLOSED')
      if (!opened) reject(error)
      rejectAll(error)
    })
  })
}

const PAGE_STATE_EXPRESSION = `(() => {
  const desktop = globalThis.dshDesktop
  const onboarding = globalThis.dshOnboarding
  const workspaceBridge = Boolean(desktop
    && typeof desktop.restart === 'function'
    && typeof desktop.openLogs === 'function'
    && typeof desktop.publishWorkspaceContext === 'function')
  const onboardingBridge = Boolean(onboarding
    && typeof onboarding.recommendations === 'function'
    && typeof onboarding.install === 'function'
    && typeof onboarding.skip === 'function')
  const loopbackRuntimePage = location.protocol === 'http:'
    && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  return {
    documentReady: document.readyState === 'interactive' || document.readyState === 'complete',
    desktopBridge: typeof desktop === 'object' && desktop !== null,
    onboardingBridge,
    workspaceBridge,
    loopbackRuntimePage,
    harnessRoot: Boolean(document.querySelector('.dcu-root')),
  }
})()`

export function classifyPageState(value) {
  const state = value !== null && typeof value === 'object' ? value : {}
  const packagedStartupReady = state.documentReady === true && (state.desktopBridge === true || state.onboardingBridge === true)
  const runtimeReady = packagedStartupReady
    && state.workspaceBridge === true
    && state.loopbackRuntimePage === true
    && state.harnessRoot === true
  const onboardingReady = packagedStartupReady && state.onboardingBridge === true
  return Object.freeze({
    packagedStartupReady,
    runtimeReady,
    onboardingReady,
    desktopBridge: state.desktopBridge === true,
    onboardingBridge: state.onboardingBridge === true,
    workspaceBridge: state.workspaceBridge === true,
  })
}

async function inspectTarget(target) {
  if (target?.type !== 'page' || typeof target.webSocketDebuggerUrl !== 'string') return undefined
  let cdp
  try {
    cdp = await cdpConnection(target.webSocketDebuggerUrl)
    const evaluation = await cdp.call('Runtime.evaluate', { expression: PAGE_STATE_EXPRESSION, returnByValue: true, awaitPromise: true })
    if (evaluation?.exceptionDetails !== undefined) {
      cdp.close()
      return undefined
    }
    const state = classifyPageState(evaluation?.result?.value)
    return { ...state, cdp }
  } catch {
    cdp?.close()
    return undefined
  }
}

async function waitForReadiness({ port, timeoutMs, child, completeOnboarding }) {
  const started = Date.now()
  let observedDesktopBridge = false
  let observedOnboarding = false
  let onboardingSkipRequested = false
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) fail('PACKAGED_APP_EXITED')
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      if (!Array.isArray(targets)) fail('CDP_TARGET_LIST_INVALID')
      for (const target of targets) {
        const probe = await inspectTarget(target)
        if (probe === undefined) continue
        observedDesktopBridge ||= probe.desktopBridge
        observedOnboarding ||= probe.onboardingReady
        if (probe.runtimeReady) return { ...probe, onboardingSkipRequested }
        if (probe.onboardingReady && completeOnboarding) {
          // Explicit test action in a disposable CI account, using the existing
          // Later/Skip path. Do not install recommended plugins or bypass checks.
          if (!onboardingSkipRequested) {
            onboardingSkipRequested = true
            try {
              await probe.cdp.call('Runtime.evaluate', {
                expression: 'Promise.resolve(window.dshOnboarding.skip()).then(() => true)',
                awaitPromise: true, returnByValue: true,
              })
            } catch {
              // Skip normally destroys this window. The subsequent runtime
              // readiness check, not this request, determines success.
            }
          }
          probe.cdp.close()
          continue
        }
        if (probe.onboardingReady) return { ...probe, onboardingSkipRequested }
        probe.cdp.close()
      }
    } catch (error) {
      if (error instanceof ProbeError) throw error
      // CDP is expected to be unavailable while Chromium initializes. The
      // bounded loop below remains the authoritative timeout.
    }
    await delay(250)
  }
  if (observedOnboarding) fail('ONBOARDING_NOT_READY')
  if (!observedDesktopBridge) fail('DESKTOP_BRIDGE_MISSING')
  fail('RUNTIME_READINESS_TIMEOUT')
}

async function captureScreenshot(cdp, destination) {
  try {
    const result = await cdp.call('Page.captureScreenshot', { format: 'png' })
    if (typeof result?.data !== 'string' || result.data === '') return false
    await writeFile(destination, Buffer.from(result.data, 'base64'), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function failureCode(error) {
  return error instanceof ProbeError ? error.code : 'PROBE_FAILED'
}

async function writeReport(outputDirectory, report) {
  await writeFile(join(outputDirectory, 'packaged-startup-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

export async function verifyPackagedStartup(options) {
  if (!['win32', 'darwin'].includes(process.platform)) fail('UNSUPPORTED_PLATFORM')
  const executable = absolutePath(options.executable, 'EXECUTABLE_PATH_NOT_ABSOLUTE')
  const outputDirectory = absolutePath(options.outputDir, 'OUTPUT_PATH_NOT_ABSOLUTE')
  const isolatedHome = absolutePath(options.isolatedHome, 'ISOLATED_HOME_NOT_ABSOLUTE')
  validatePathBoundaries({ executable, outputDirectory, isolatedHome })
  const ciBoundary = validateEphemeralCi({
    enabled: options.ephemeralCi === true,
    executable,
    outputDirectory,
    isolatedHome,
  })
  await assertEphemeralCiCanonicalPaths({
    runnerTemp: ciBoundary.runnerTemp,
    workspace: ciBoundary.workspace,
    executable,
    outputDirectory,
    isolatedHome,
  })
  await assertExecutable(executable)
  const desktopVersion = await readPackagedVersion(executable)
  const isolationMode = ciBoundary.isolationMode

  await createNewDirectory(outputDirectory, 'OUTPUT_DIRECTORY_EXISTS')
  await prepareIsolatedHome(isolatedHome, options.reuseIsolatedHome === true)
  await createIsolationLayout(isolatedHome)
  const userData = join(isolatedHome, 'electron-user-data')
  try {
    const userDataStats = await lstat(userData)
    if (!userDataStats.isDirectory() || userDataStats.isSymbolicLink()) fail('ISOLATED_USER_DATA_UNSAFE')
  } catch (error) {
    if (error?.code === 'ENOENT') await mkdir(userData, { mode: 0o700 })
    else throw error
  }
  const debugPort = options.debugPort ?? await reserveLoopbackPort()
  const environment = isolatedEnvironment({ home: isolatedHome, userData })
  const result = {
    ok: false,
    stage: 'failed',
    platform: process.platform,
    isolationMode,
    desktopVersion,
    packagedStartup: false,
    runtimeReady: false,
    onboardingOnly: false,
    desktopBridge: false,
    onboardingBridge: false,
    workspaceBridge: false,
    screenshotCaptured: false,
    cleanupComplete: false,
    failure: undefined,
  }
  let owner
  let cdp
  const started = Date.now()
  try {
    const startedProcess = spawnOwnedProcess(executable, [
      `--user-data-dir=${userData}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`,
    ], {
      cwd: dirname(executable),
      env: environment,
      stdio: 'ignore',
      windowsHide: true,
      terminationTimeoutMs: 10_000,
      forceWindowsTreeTermination: false,
    })
    owner = startedProcess.owner
    const ready = await waitForReadiness({ port: debugPort, timeoutMs: options.timeoutMs, child: startedProcess.child, completeOnboarding: options.completeOnboarding === true })
    cdp = ready.cdp
    result.packagedStartup = ready.packagedStartupReady
    result.runtimeReady = ready.runtimeReady
    result.onboardingOnly = ready.onboardingReady && !ready.runtimeReady
    result.onboardingSkipRequested = ready.onboardingSkipRequested
    result.desktopBridge = ready.desktopBridge
    result.onboardingBridge = ready.onboardingBridge
    result.workspaceBridge = ready.workspaceBridge
    if (options.screenshot) result.screenshotCaptured = await captureScreenshot(cdp, join(outputDirectory, 'packaged-startup.png'))
    if (ready.runtimeReady) {
      result.ok = true
      result.stage = 'runtime-ready'
    } else if (ready.onboardingReady && options.allowOnboarding) {
      result.ok = true
      result.stage = 'onboarding-only'
    } else if (ready.onboardingReady) {
      fail('ONBOARDING_ONLY')
    } else {
      fail('RUNTIME_NOT_READY')
    }
  } catch (error) {
    result.failure = failureCode(error)
  } finally {
    cdp?.close()
    if (owner !== undefined) {
      try {
        await owner.stop()
        result.cleanupComplete = true
      } catch {
        result.cleanupComplete = false
        result.ok = false
        result.stage = 'failed'
        result.failure ??= 'OWNED_PROCESS_CLEANUP_INCOMPLETE'
      }
    }
    result.elapsedMs = Date.now() - started
    await writeReport(outputDirectory, result)
  }
  return result
}

async function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof ProbeError ? error.code : 'INVALID_ARGUMENTS'}\n${usage()}\n`)
    process.exitCode = 2
    return
  }
  try {
    const result = await verifyPackagedStartup(parsed)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    // Validation failures occur before an output directory is safely owned, so
    // only print a stable code and never serialize paths or environment data.
    process.stderr.write(`${failureCode(error)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) await main()
