import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9229)
const pagePattern = process.argv[3] ?? '127.0.0.1:3080'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && String(item.url).includes(pagePattern))
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
const metrics = async () => {
  const result = await send('Performance.getMetrics')
  return Object.fromEntries((result.metrics ?? []).map(entry => [entry.name, entry.value]))
}

await send('Performance.enable')
await send('HeapProfiler.enable')
const before = await metrics()
await send('HeapProfiler.collectGarbage')
const after = await metrics()
const dom = await send('Runtime.evaluate', {
  expression: `({ nodes: document.querySelectorAll('*').length, dialogs: document.querySelectorAll('[role="dialog"]').length, pluginStyles: document.querySelectorAll('style[data-plugin],style[data-plugin-css]').length })`,
  returnByValue: true,
})
socket.close()
process.stdout.write(`${JSON.stringify({
  target: { title: target.title, url: target.url },
  before: { jsHeapUsedBytes: before.JSHeapUsedSize, jsHeapTotalBytes: before.JSHeapTotalSize, domNodes: before.Nodes },
  after: { jsHeapUsedBytes: after.JSHeapUsedSize, jsHeapTotalBytes: after.JSHeapTotalSize, domNodes: after.Nodes },
  document: dom.result?.value,
}, null, 2)}\n`)
