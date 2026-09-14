import { posix, win32 } from 'node:path'

const WINDOWS_PLATFORM = 'win32'
const PROXY_KEYS = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])
const WINDOWS_OS_KEYS = Object.freeze([
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
])

function pathApiFor(platform) {
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new TypeError('Preflight platform must be a non-empty string')
  }
  return platform === WINDOWS_PLATFORM ? win32 : posix
}

function assertEnvironment(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('Preflight environment must be an object')
  }
  return env
}

function resolveHome(home, pathApi) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0')) {
    throw new TypeError('Preflight home must be a NUL-free absolute path')
  }
  if (!pathApi.isAbsolute(home)) {
    throw new TypeError('Preflight home must be an absolute path')
  }
  return pathApi.resolve(home)
}

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function environmentValue(env, name, caseInsensitive) {
  const matchingKeys = Object.keys(env)
    .filter(key => caseInsensitive
      ? key.toLowerCase() === name.toLowerCase()
      : key === name)
    .sort((left, right) => {
      // Prefer the canonical spelling, then use code-point order so a
      // PATH/Path collision never depends on caller insertion order.
      const leftCanonical = left === name ? 0 : 1
      const rightCanonical = right === name ? 0 : 1
      return leftCanonical - rightCanonical || compareKeys(left, right)
    })

  for (const key of matchingKeys) {
    const value = env[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return undefined
}

function copyCanonical(output, env, name, caseInsensitive = false) {
  const value = environmentValue(env, name, caseInsensitive)
  if (value !== undefined) output[name] = value
}

function buildDirectories(root, pathApi) {
  const paths = {
    userHome: pathApi.join(root, 'home'),
    appData: pathApi.join(root, 'appdata', 'roaming'),
    localAppData: pathApi.join(root, 'appdata', 'local'),
    xdgConfigHome: pathApi.join(root, 'xdg', 'config'),
    xdgDataHome: pathApi.join(root, 'xdg', 'data'),
    xdgCacheHome: pathApi.join(root, 'xdg', 'cache'),
    temp: pathApi.join(root, 'tmp'),
    dshHome: pathApi.join(root, 'dsh'),
    dshDoctorHome: pathApi.join(root, 'dsh-doctor'),
    mnemonDataDir: pathApi.join(root, 'mnemon'),
  }

  const directories = [...new Set(Object.values(paths))]
  for (const directory of directories) {
    const relative = pathApi.relative(root, directory)
    if (relative === '' || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) {
      throw new Error('Preflight directory escaped its temporary home')
    }
  }
  return { paths, directories }
}

/**
 * Build the environment for a candidate preflight.
 *
 * This is environment-level isolation, not an OS sandbox: a plugin that uses
 * a hard-coded absolute path or opens a remote connection is outside this
 * function's enforcement boundary. The caller owns directory creation.
 */
export function createPreflightEnvironment({ env = {}, home, platform = process.platform } = {}) {
  const source = assertEnvironment(env)
  const pathApi = pathApiFor(platform)
  const root = resolveHome(home, pathApi)
  const { paths, directories } = buildDirectories(root, pathApi)
  const isolated = {}

  // Keep only the small OS/tool-launch surface needed by a child process.
  // npm/corepack flags, credentials, NODE_OPTIONS, plugin homes, and settings
  // paths are intentionally absent; they must be configured explicitly later.
  copyCanonical(isolated, source, 'PATH', platform === WINDOWS_PLATFORM)
  if (platform === WINDOWS_PLATFORM) {
    for (const name of WINDOWS_OS_KEYS) copyCanonical(isolated, source, name, true)
  }
  for (const name of PROXY_KEYS) copyCanonical(isolated, source, name, true)

  Object.assign(isolated, {
    HOME: paths.userHome,
    USERPROFILE: paths.userHome,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    DSH_HOME: paths.dshHome,
    DSH_DOCTOR_HOME: paths.dshDoctorHome,
    MNEMON_DATA_DIR: paths.mnemonDataDir,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  })

  return {
    env: Object.freeze(isolated),
    directories: Object.freeze(directories),
  }
}
