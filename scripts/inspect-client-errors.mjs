import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9229)
const pattern = process.argv[3] ?? '127.0.0.1:3080'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && String(item.url).includes(pattern))
if (!target?.webSocketDebuggerUrl) throw new Error(`No page target matched ${pattern}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let sequence = 0
const pending = new Map()
const events = []
socket.on('message', raw => {
  const message = JSON.parse(String(raw))
  if (message.id && pending.has(message.id)) {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(message.params?.type)) {
    events.push({type:'console', text:(message.params.args||[]).map(a=>a.description??a.value??'').join(' ').split('\n').slice(0,1).join('\n').slice(0,500)})
  }
  if (message.method === 'Runtime.exceptionThrown') {
    events.push({ type: 'exception', text: message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text })
  }
  if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level)) {
    events.push({
      type: message.params.entry.level,
      source: message.params.entry.source,
      text: message.params.entry.text,
      url: message.params.entry.url,
      lineNumber: message.params.entry.lineNumber,
    })
  }
})

function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise(resolve => setTimeout(resolve, 12_000))
const state = await send('Runtime.evaluate', {
  expression: `({ url: location.href, title: document.title, readyState: document.readyState, text: document.body?.innerText?.slice(0, 1200) })`,
  returnByValue: true,
})
process.stdout.write(`${JSON.stringify({ state: state.result?.value, events }, null, 2)}\n`)
socket.close()
