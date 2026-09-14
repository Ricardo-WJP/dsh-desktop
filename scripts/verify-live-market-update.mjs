const endpoint = process.env.DSH_DESKTOP_CDP_ENDPOINT ?? 'http://127.0.0.1:9229'
const harnessOrigin = process.env.DSH_DESKTOP_HARNESS_ORIGIN ?? 'http://127.0.0.1:3080'
const pluginName = process.argv[2]

if (typeof pluginName !== 'string' || !/^(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+$/i.test(pluginName)) {
  throw new TypeError('Pass one exact npm plugin name')
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
  if (message.id === undefined) return
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

const evaluate = async expression => {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result?.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Renderer evaluation failed')
  }
  return result?.result?.value
}

try {
  await command('Runtime.enable')
  const probe = await evaluate(`({
    url: location.href,
    managedFetch: fetch.dshDesktopManagedMarketUpdate === true,
    updateMethod: typeof globalThis.dshDesktop?.updateMarketPlugin,
    activateMethod: typeof globalThis.dshDesktop?.activateMarketUpdate,
  })`)
  if (probe?.managedFetch !== true || probe?.updateMethod !== 'function' || probe?.activateMethod !== 'function') {
    throw new Error(`Managed market bridge is not active: ${JSON.stringify(probe)}`)
  }
  process.stdout.write(`${JSON.stringify({ probe })}\n`)

  const started = await evaluate(`(() => {
    globalThis.__dshDesktopManagedMarketUpdate = fetch('/dsh-market/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(pluginName)} }),
    }).then(async response => ({ status: response.status, body: await response.json() }))
      .then(result => {
        globalThis.__dshDesktopManagedMarketUpdateResult = result
        return result
      })
      .catch(error => {
        globalThis.__dshDesktopManagedMarketUpdateResult = { error: String(error?.message ?? error) }
        throw error
      })
    return { started: true }
  })()`)
  process.stdout.write(`${JSON.stringify({ started })}\n`)
  if (started?.started !== true) throw new Error('Managed market update did not start')
} finally {
  socket.close()
}

// A real profile can contain tens of thousands of files. The desktop keeps
// verifying the candidate after pnpm exits, so allow the full safe transaction
// to finish instead of reporting a false timeout after three minutes.
const deadline = Date.now() + 600_000
let lastStatus
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${harnessOrigin}/dsh-market/updates?force=1`, { redirect: 'error' })
    if (response.ok) {
      const body = await response.json()
      lastStatus = body?.updates?.[pluginName]
      if (lastStatus?.updateAvailable === false && typeof lastStatus.current === 'string') {
        process.stdout.write(`${JSON.stringify({ result: lastStatus })}\n`)
        process.exit(0)
      }
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 2_000))
}

throw new Error(`Managed market update did not become current before timeout: ${JSON.stringify(lastStatus)}`)
