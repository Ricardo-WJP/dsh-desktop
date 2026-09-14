import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

const OWNER_SCHEMA_VERSION = 1
const OWNER_ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const OWNER_BIND_TIMEOUT_MS = 5_000

export class ReleaseOwnershipError extends Error {
  constructor(message, { endpoint, owner, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ReleaseOwnershipError'
    this.code = 'DSH_RELEASE_OWNER_BUSY'
    this.endpoint = endpoint
    this.owner = owner
  }
}

function normalizedRoot(stateRoot, platform) {
  if (typeof stateRoot !== 'string' || stateRoot === '' || stateRoot.includes('\0') || !isAbsolute(stateRoot)) {
    throw new TypeError('Release ownership state root must be an absolute path')
  }
  const absolute = resolve(stateRoot)
  return platform === 'win32' ? absolute.replaceAll('/', '\\').toLowerCase() : absolute
}

export function releaseOwnershipEndpoint(stateRoot, {
  platform = process.platform,
  temporaryRoot = tmpdir(),
} = {}) {
  const digest = createHash('sha256').update(normalizedRoot(stateRoot, platform)).digest('hex').slice(0, 32)
  if (platform === 'win32') return `\\\\.\\pipe\\dsh-desktop-release-${digest}`
  if (platform === 'linux') return `\0dsh-desktop-release-${digest}`
  return join(temporaryRoot, `dsh-desktop-release-${digest}.sock`)
}

function ownerRecord({ role, pid, startedAt }) {
  if (typeof role !== 'string' || !OWNER_ROLE.test(role)) throw new TypeError('Invalid release ownership role')
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('Invalid release ownership process id')
  const timestamp = new Date(startedAt)
  if (Number.isNaN(timestamp.getTime())) throw new TypeError('Invalid release ownership timestamp')
  return Object.freeze({
    schemaVersion: OWNER_SCHEMA_VERSION,
    role,
    pid,
    startedAt: timestamp.toISOString(),
  })
}

function parseOwner(value) {
  try {
    const parsed = JSON.parse(value)
    if (parsed?.schemaVersion !== OWNER_SCHEMA_VERSION
      || typeof parsed.role !== 'string'
      || !OWNER_ROLE.test(parsed.role)
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.startedAt !== 'string') return undefined
    return ownerRecord(parsed)
  } catch {
    return undefined
  }
}

function probeOwner(endpoint, { connectImpl = connect, timeoutMs = 1_500 } = {}) {
  return new Promise(resolveProbe => {
    let socket
    let settled = false
    let text = ''
    const finish = value => {
      if (settled) return
      settled = true
      socket?.destroy?.()
      resolveProbe(value)
    }
    try {
      socket = connectImpl(endpoint)
    } catch {
      finish(undefined)
      return
    }
    socket.setEncoding?.('utf8')
    socket.setTimeout?.(timeoutMs, () => finish(undefined))
    socket.on?.('data', chunk => {
      if (text.length < 4096) text += String(chunk).slice(0, 4096 - text.length)
    })
    socket.once?.('end', () => finish(parseOwner(text)))
    socket.once?.('close', () => finish(parseOwner(text)))
    socket.once?.('error', () => finish(undefined))
  })
}

function listen(server, endpoint, { timeoutMs = OWNER_BIND_TIMEOUT_MS } = {}) {
  return new Promise((resolveListen, rejectListen) => {
    let settled = false
    let timer
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      server.off?.('listening', onListening)
      server.off?.('error', onError)
    }
    const finish = error => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolveListen()
      else rejectListen(error)
    }
    const onError = error => {
      finish(error)
    }
    const onListening = () => {
      finish()
    }
    const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : OWNER_BIND_TIMEOUT_MS
    timer = setTimeout(() => {
      const error = new Error(`Release ownership endpoint did not bind within ${String(boundedTimeout)}ms`)
      error.code = 'ETIMEDOUT'
      finish(error)
      // A named pipe can remain in a pending bind state when another native
      // process owns it but does not answer our probe. Keep a disposable error
      // listener while closing the local server so the timeout cannot turn
      // into an uncaught late `error` event.
      server.once?.('error', () => {})
      try { server.close?.(() => {}) } catch { /* preserve the bind timeout */ }
    }, boundedTimeout)
    timer.unref?.()
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(endpoint)
    } catch (error) {
      finish(error)
    }
  })
}

async function bindOwnerServer(endpoint, record, {
  createServerImpl = createServer,
  connectImpl = connect,
  platform,
  retryStaleSocket = true,
  bindTimeoutMs = OWNER_BIND_TIMEOUT_MS,
} = {}) {
  const serialized = `${JSON.stringify(record)}\n`
  const server = createServerImpl(socket => {
    socket.on?.('error', () => {})
    socket.end?.(serialized)
  })
  try {
    await listen(server, endpoint, { timeoutMs: bindTimeoutMs })
  } catch (error) {
    server.close?.()
    if (error?.code !== 'EADDRINUSE' && error?.code !== 'ETIMEDOUT') throw error
    const owner = await probeOwner(endpoint, { connectImpl })
    if (owner === undefined && platform !== 'win32' && platform !== 'linux' && retryStaleSocket) {
      await rm(endpoint, { force: true })
      return bindOwnerServer(endpoint, record, {
        createServerImpl,
        connectImpl,
        platform,
        retryStaleSocket: false,
        bindTimeoutMs,
      })
    }
    const detail = owner === undefined
      ? (error?.code === 'ETIMEDOUT' ? 'an unresponsive process' : 'another process')
      : `${owner.role} process ${String(owner.pid)}`
    throw new ReleaseOwnershipError(`Release state is already owned by ${detail}`, { endpoint, owner, cause: error })
  }
  server.unref?.()
  let lostError
  server.on('error', error => { lostError ??= error })
  return { server, get lostError() { return lostError } }
}

export async function acquireReleaseOwnership({
  stateRoot,
  role = 'desktop',
  pid = process.pid,
  startedAt = new Date(),
  platform = process.platform,
  temporaryRoot = tmpdir(),
  createServerImpl = createServer,
  connectImpl = connect,
  bindTimeoutMs = OWNER_BIND_TIMEOUT_MS,
} = {}) {
  const endpoint = releaseOwnershipEndpoint(stateRoot, { platform, temporaryRoot })
  const owner = ownerRecord({ role, pid, startedAt })
  const bound = await bindOwnerServer(endpoint, owner, { createServerImpl, connectImpl, platform, bindTimeoutMs })
  let released = false
  let releasePromise

  function release() {
    if (releasePromise !== undefined) return releasePromise
    released = true
    releasePromise = new Promise((resolveRelease, rejectRelease) => {
      try {
        bound.server.close(error => {
          if (error !== undefined) rejectRelease(error)
          else resolveRelease()
        })
      } catch (error) {
        rejectRelease(error)
      }
    }).finally(async () => {
      if (platform !== 'win32' && platform !== 'linux') await rm(endpoint, { force: true })
    })
    return releasePromise
  }

  return Object.freeze({
    endpoint,
    owner,
    release,
    get released() { return released },
    get lostError() { return bound.lostError },
  })
}

export const internals = Object.freeze({ ownerRecord, parseOwner, probeOwner })
