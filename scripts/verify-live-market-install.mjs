const endpoint = process.env.DSH_DESKTOP_CDP_ENDPOINT ?? 'http://127.0.0.1:9229'
const harnessOrigin = process.env.DSH_DESKTOP_HARNESS_ORIGIN ?? 'http://127.0.0.1:3080'
const pluginUrl = process.argv[2]

let parsed
try { parsed = new URL(pluginUrl) } catch { throw new TypeError('Pass one HTTPS GitHub plugin URL') }
if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
  throw new TypeError('Pass one HTTPS GitHub plugin URL')
}
if (typeof WebSocket !== 'function') throw new Error('This Node runtime has no WebSocket client')

const targetResponse = await fetch(`${endpoint}/json/list`, { redirect: 'error' })
if (!targetResponse.ok) throw new Error(`CDP target query failed with HTTP ${targetResponse.status}`)
const targets = await targetResponse.json()
const target = targets.find(item => item?.type === 'page' && new URL(item.url).origin === harnessOrigin)
if (target === undefined || typeof target.webSocketDebuggerUrl !== 'string') {
  throw new Error(`No Harness renderer target is available at ${harnessOrigin}`)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0

socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  const owner = pending.get(message.id)
  if (owner === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) owner.reject(new Error(message.error.message))
  else owner.resolve(message.result)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('Unable to connect to the Harness renderer CDP target')), { once: true })
})

function command(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result?.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Renderer evaluation failed')
  }
  return result?.result?.value
}

try {
  await command('Runtime.enable')
  const probe = await evaluate(`({
    url: location.href,
    managedUpdate: fetch.dshDesktopManagedMarketUpdate === true,
    managedInstall: fetch.dshDesktopManagedMarketInstall === true,
    installMethod: typeof globalThis.dshDesktop?.installMarketPlugin,
    activateMethod: typeof globalThis.dshDesktop?.activateMarketUpdate,
  })`)
  if (probe?.managedUpdate !== true || probe?.managedInstall !== true || probe?.installMethod !== 'function' || probe?.activateMethod !== 'function') {
    throw new Error(`Managed market install bridge is not active: ${JSON.stringify(probe)}`)
  }
  process.stdout.write(`${JSON.stringify({ probe })}\n`)

  const result = await evaluate(`fetch('/dsh-market/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: ${JSON.stringify(parsed.href.replace(/\/$/u, ''))} }),
  }).then(async response => ({ status: response.status, body: await response.json() }))`)
  process.stdout.write(`${JSON.stringify({ result })}\n`)
  if (result?.status !== 200 || result?.body?.ok !== true || result?.body?.desktopManaged !== true) {
    throw new Error(`Managed market install was rejected: ${JSON.stringify(result)}`)
  }
} finally {
  socket.close()
}
