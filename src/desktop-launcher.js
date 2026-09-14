import process from 'node:process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export {
  buildWindowsProcessTreeTermination,
  buildWindowsTreeTermination,
  createChildSupervisor,
  createProcessTreeOwner,
  createProcessTreeSupervisor,
  createSpawnOptions,
  createOwnedProcessTree,
  spawnDirect,
  spawnOwnedProcess,
  waitForChild,
  resolveTrustedTaskkillPath,
} from './process-tree.js'

export {
  OwnedProcessTree,
  createOwnedProcessTree as createRuntimeProcessOwner,
} from './runtime/process-owner.js'
export { StableSupervisor, createStableSupervisor } from './runtime/stable-supervisor.js'
export { DevSupervisor, createDevSupervisor } from './runtime/dev-supervisor.js'
export { ModeSupervisor, createModeSupervisor } from './runtime/mode-supervisor.js'

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))

export function packageCliPath(root, packageName, relativePath) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('Invalid package root')
  if (typeof packageName !== 'string' || packageName.length === 0) throw new TypeError('Invalid package name')
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new TypeError('Invalid package CLI path')
  return join(root, 'node_modules', packageName, ...relativePath.split('/'))
}

export function nodeCliInvocation(cliPath, args = [], nodeExecutable = process.execPath) {
  if (typeof cliPath !== 'string' || cliPath.length === 0) throw new TypeError('Invalid package CLI path')
  if (typeof nodeExecutable !== 'string' || nodeExecutable.length === 0) throw new TypeError('Invalid Node executable')
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) throw new TypeError('Invalid CLI arguments')
  return Object.freeze({
    command: nodeExecutable,
    args: Object.freeze([cliPath, ...args]),
  })
}

function isAllowedReadinessUrl(parsed) {
  return parsed !== null
    && ['http:', 'https:'].includes(parsed.protocol)
    && parsed.hostname === '127.0.0.1'
    && parsed.username === ''
    && parsed.password === ''
}

function waitForDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Wait aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Wait aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Wait for a healthy local HTTP endpoint without accepting Vite's fallback 404.
 * When `expectedContent`/`bodyIncludes` is supplied, every marker must be
 * present in the response body before readiness is reported.
 */
export async function waitForHttp(url, {
  timeoutMs = 30_000,
  intervalMs = 150,
  fetchImpl = fetch,
  signal,
  expectedContent,
  bodyIncludes,
  marker,
} = {}) {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('Invalid readiness URL')
  let plannedUrl
  try {
    plannedUrl = new URL(url)
  } catch (error) {
    throw new TypeError('Invalid readiness URL', { cause: error })
  }
  if (!isAllowedReadinessUrl(plannedUrl)) throw new TypeError('Readiness URL must use http or https on loopback 127.0.0.1')
  if (typeof fetchImpl !== 'function') throw new TypeError('Invalid fetch implementation')
  const plannedEndpoint = plannedUrl.href
  const requestedContent = expectedContent ?? bodyIncludes ?? marker
  const contentMarkers = requestedContent === undefined
    ? []
    : typeof requestedContent === 'string'
      ? [requestedContent]
      : Array.isArray(requestedContent) && requestedContent.every(value => typeof value === 'string' && value.length > 0)
        ? requestedContent
        : undefined
  if (contentMarkers === undefined) throw new TypeError('Invalid readiness content markers')

  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Readiness wait aborted')
    try {
      const response = await fetchImpl(url, { signal })
      let responseEndpoint
      let responseUrl
      try {
        responseUrl = typeof response?.url === 'string' ? new URL(response.url) : undefined
        responseEndpoint = responseUrl?.href
      } catch {
        responseUrl = undefined
        responseEndpoint = undefined
      }
      if (response?.redirected === true) {
        lastError = new Error(`Vite readiness response followed a redirect away from the planned endpoint ${plannedEndpoint}`)
      } else if (responseUrl === undefined || !isAllowedReadinessUrl(responseUrl)) {
        lastError = new Error('Vite readiness response URL must use http or https on loopback 127.0.0.1')
      } else if (responseEndpoint !== plannedEndpoint) {
        lastError = new Error(`Vite readiness response URL does not match the planned endpoint ${plannedEndpoint}`)
      } else {
        const status = Number(response?.status)
        if (!Number.isInteger(status) || status < 200 || status >= 300 || response?.ok === false) {
          lastError = new Error(`Vite returned unhealthy HTTP ${String(response?.status)}`)
        } else if (contentMarkers.length === 0) {
          return response
        } else if (typeof response?.text !== 'function') {
          lastError = new Error('Vite readiness response has no readable body')
        } else {
          const body = await response.text()
          if (contentMarkers.every(content => body.includes(content))) return response
          lastError = new Error('Vite readiness response is missing the renderer marker')
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Readiness wait aborted')
      lastError = error
    }
    if (Date.now() >= deadline) break
    await waitForDelay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal)
  }
  throw lastError ?? new Error('Timed out waiting for Vite')
}
