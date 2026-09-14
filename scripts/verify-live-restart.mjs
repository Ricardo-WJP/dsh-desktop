import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9229)
const harnessUrl = process.argv[3] ?? 'http://127.0.0.1:3080/'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && String(item.url).startsWith(harnessUrl))
if (!target?.webSocketDebuggerUrl) throw new Error('Harness renderer target was not found')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
let sequence = 0
const pending = new Map()
socket.on('message', raw => {
  const message = JSON.parse(String(raw))
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

const startedAt = Date.now()
const result = await send('Runtime.evaluate', {
  expression: 'globalThis.dshDesktop.restart()',
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
})
if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
if (result.result?.value?.ok !== true || result.result?.value?.accepted !== true) {
  throw new Error(`Harness restart IPC was rejected: ${JSON.stringify(result.result?.value)}`)
}
socket.close()

let observedOffline = false
let consecutiveReady = 0
let lastError
for (let attempt = 0; attempt < 180; attempt += 1) {
  try {
    const response = await fetch(harnessUrl, { cache: 'no-store' })
    if (response.ok) {
      consecutiveReady += 1
      if (consecutiveReady >= 3 && (observedOffline || Date.now() - startedAt > 3_000)) {
        process.stdout.write(`${JSON.stringify({ ok: true, ipc: result.result?.value, observedOffline, elapsedMs: Date.now() - startedAt })}\n`)
        process.exit(0)
      }
    } else {
      observedOffline = true
      consecutiveReady = 0
    }
  } catch (error) {
    lastError = error
    observedOffline = true
    consecutiveReady = 0
  }
  await new Promise(resolve => setTimeout(resolve, 250))
}
throw new Error(`Harness did not recover after restart: ${String(lastError?.message ?? lastError ?? 'timeout')}`)
