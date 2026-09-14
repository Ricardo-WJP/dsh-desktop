import { assertIpcChannel, IPC_REGISTRATION_CHANNEL_VALUES } from './contracts.js'

const EXPECTED_REGISTRATIONS = new Set(IPC_REGISTRATION_CHANNEL_VALUES)

/**
 * Injectable IPC registration seam. Main-process startup fails closed if a
 * handler or listener is ever wired with an undefined, unknown, duplicate, or
 * missing channel.
 */
export function createIpcRegistrar(ipcMain) {
  if (ipcMain === undefined || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('Invalid ipcMain registrar')
  }

  const registrations = new Map()
  const register = (kind, channel, listener) => {
    const validated = assertIpcChannel(channel)
    if (!EXPECTED_REGISTRATIONS.has(validated)) throw new TypeError(`IPC channel is not an inbound registration: ${validated}`)
    if (typeof listener !== 'function') throw new TypeError(`Invalid IPC ${kind} listener for ${validated}`)
    if (registrations.has(validated)) throw new Error(`IPC channel registered more than once: ${validated}`)
    registrations.set(validated, kind)
    return ipcMain[kind](validated, listener)
  }

  return Object.freeze({
    handle(channel, listener) {
      return register('handle', channel, listener)
    },
    on(channel, listener) {
      return register('on', channel, listener)
    },
    registeredChannels() {
      return Object.freeze([...registrations.keys()])
    },
    assertComplete() {
      const missing = IPC_REGISTRATION_CHANNEL_VALUES.filter(channel => !registrations.has(channel))
      if (missing.length > 0) throw new Error(`Missing IPC registrations: ${missing.join(', ')}`)
      return true
    },
  })
}
