import { nodeCliInvocation, packageCliPath, PROJECT_ROOT } from './desktop-launcher.js'

const TARGET_FLAGS = Object.freeze({
  all: Object.freeze([]),
  windows: Object.freeze(['--win']),
  mac: Object.freeze(['--mac', 'dmg']),
  linux: Object.freeze(['--linux', 'AppImage']),
})

export const BUILD_TARGETS = Object.freeze(Object.keys(TARGET_FLAGS))

export const DESKTOP_DEV_HOST = '127.0.0.1'
export const DESKTOP_DEV_PORT = 5173
export const DESKTOP_DEV_PROTOCOL = 'http:'
export const DESKTOP_DEV_STRICT_PORT = true
export const DESKTOP_DEV_RENDERER_MARKERS = Object.freeze([
  '<div id="root">',
  'name="dsh-desktop-renderer"',
  'type="module"',
])

const DEFAULT_ENDPOINT = Object.freeze({
  protocol: DESKTOP_DEV_PROTOCOL,
  host: DESKTOP_DEV_HOST,
  port: DESKTOP_DEV_PORT,
})

function assertPort(port) {
  const numericPort = typeof port === 'string' && port.trim() !== '' ? Number(port) : port
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new TypeError('Invalid loopback endpoint port')
  }
  return numericPort
}

function endpointUrl(protocol, host, port) {
  return `${protocol}//${host}:${String(port)}`
}

function parseEndpointUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new TypeError('Invalid loopback endpoint URL', { cause: error })
  }
  if (parsed.protocol !== DESKTOP_DEV_PROTOCOL) throw new TypeError('Desktop renderer endpoint must use http')
  // main.js intentionally accepts only this origin, and Vite's allowedHosts
  // is kept equally narrow. Do not widen either trust boundary here.
  if (parsed.hostname !== DESKTOP_DEV_HOST) throw new TypeError('Desktop renderer endpoint must use 127.0.0.1')
  if (parsed.username !== '' || parsed.password !== '') throw new TypeError('Desktop renderer endpoint cannot contain credentials')
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('Desktop renderer endpoint must be an origin')
  }
  const port = assertPort(parsed.port === '' ? 80 : parsed.port)
  return { protocol: parsed.protocol, host: parsed.hostname, port }
}

/**
 * Normalize and validate the one loopback endpoint owned by desktop dev mode.
 * Strings and `{ host, port }` objects are accepted so callers cannot
 * independently configure Vite and Electron with divergent values.
 */
export function validateDesktopDevEndpoint(value = DEFAULT_ENDPOINT) {
  let endpoint
  if (typeof value === 'string' || value instanceof URL) {
    endpoint = parseEndpointUrl(String(value))
  } else if (value !== null && typeof value === 'object') {
    if (value.url !== undefined) {
      endpoint = parseEndpointUrl(String(value.url))
      if (value.host !== undefined && value.host !== endpoint.host) {
        throw new TypeError('Loopback endpoint host does not match its URL')
      }
      if (value.port !== undefined && assertPort(value.port) !== endpoint.port) {
        throw new TypeError('Loopback endpoint port does not match its URL')
      }
    } else {
      const host = value.host ?? value.hostname
      if (host !== DESKTOP_DEV_HOST) throw new TypeError('Desktop renderer endpoint must use 127.0.0.1')
      endpoint = { protocol: value.protocol ?? DESKTOP_DEV_PROTOCOL, host, port: assertPort(value.port) }
      if (endpoint.protocol !== DESKTOP_DEV_PROTOCOL) throw new TypeError('Desktop renderer endpoint must use http')
    }
    if (value.strictPort !== undefined && value.strictPort !== DESKTOP_DEV_STRICT_PORT) {
      throw new TypeError('Desktop renderer endpoint requires strictPort')
    }
  } else {
    throw new TypeError('Invalid loopback endpoint')
  }

  const url = endpointUrl(endpoint.protocol, endpoint.host, endpoint.port)
  return Object.freeze({
    protocol: endpoint.protocol,
    host: endpoint.host,
    port: endpoint.port,
    strictPort: DESKTOP_DEV_STRICT_PORT,
    url,
    readinessUrl: url,
    rendererUrl: url,
  })
}

export const DEFAULT_DESKTOP_DEV_ENDPOINT = validateDesktopDevEndpoint(DEFAULT_ENDPOINT)

function assertMatchingRendererOverride(endpoint, { rendererUrlOverride, rendererUrl } = {}) {
  const overrides = [rendererUrlOverride, rendererUrl].filter(value => value !== undefined && value !== null)
  if (overrides.length === 0) return
  const normalized = overrides.map(value => validateDesktopDevEndpoint(value))
  if (normalized.some(value => value.url !== endpoint.url) || normalized.some(value => value.url !== normalized[0].url)) {
    throw new TypeError(`DSH_DESKTOP_RENDERER_URL must match the planned renderer endpoint ${endpoint.url}`)
  }
}

export function desktopBuildPlan(
  target = 'all',
  _platform = process.platform,
  packagerExtraArgs = [],
  { root = PROJECT_ROOT, nodeExecutable = process.execPath } = {},
) {
  if (!BUILD_TARGETS.includes(target)) throw new TypeError(`Unknown desktop build target: ${String(target)}`)
  if (!Array.isArray(packagerExtraArgs) || packagerExtraArgs.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Invalid desktop packager arguments')
  }
  const renderer = nodeCliInvocation(packageCliPath(root, 'vite', 'bin/vite.js'), ['build'], nodeExecutable)
  const packager = nodeCliInvocation(
    packageCliPath(root, 'electron-builder', 'cli.js'),
    [...TARGET_FLAGS[target], ...packagerExtraArgs, '--publish', 'never'],
    nodeExecutable,
  )
  return Object.freeze({
    target,
    renderer,
    packager,
  })
}

export function desktopDevPlan({
  root = PROJECT_ROOT,
  nodeExecutable = process.execPath,
  electronExecutable,
  endpoint,
  rendererEndpoint,
  rendererUrlOverride,
  rendererUrl,
} = {}) {
  if (typeof electronExecutable !== 'string' || electronExecutable.length === 0) throw new TypeError('Invalid Electron executable')
  let endpointValue = endpoint
  if (endpointValue === undefined) {
    endpointValue = rendererEndpoint ?? DEFAULT_DESKTOP_DEV_ENDPOINT
  } else if (rendererEndpoint !== undefined) {
    const first = validateDesktopDevEndpoint(endpointValue)
    const second = validateDesktopDevEndpoint(rendererEndpoint)
    if (first.url !== second.url) throw new TypeError('Conflicting desktop renderer endpoints')
  }
  const devEndpoint = validateDesktopDevEndpoint(endpointValue)
  assertMatchingRendererOverride(devEndpoint, { rendererUrlOverride, rendererUrl })

  const renderer = nodeCliInvocation(
    packageCliPath(root, 'vite', 'bin/vite.js'),
    [
      '--host', devEndpoint.host,
      '--port', String(devEndpoint.port),
      '--strictPort',
    ],
    nodeExecutable,
  )
  const electronEnvironment = Object.freeze({ DSH_DESKTOP_RENDERER_URL: devEndpoint.rendererUrl })
  const server = Object.freeze({
    host: devEndpoint.host,
    port: devEndpoint.port,
    strictPort: devEndpoint.strictPort,
    readinessUrl: devEndpoint.readinessUrl,
    rendererUrl: devEndpoint.rendererUrl,
  })

  return Object.freeze({
    endpoint: devEndpoint,
    rendererEndpoint: devEndpoint,
    host: devEndpoint.host,
    port: devEndpoint.port,
    strictPort: devEndpoint.strictPort,
    readinessUrl: devEndpoint.readinessUrl,
    rendererUrl: devEndpoint.rendererUrl,
    rendererMarkers: DESKTOP_DEV_RENDERER_MARKERS,
    server,
    vite: server,
    renderer,
    electron: Object.freeze({
      command: electronExecutable,
      args: Object.freeze(['.']),
      env: electronEnvironment,
    }),
  })
}
