import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9229)
const outputDir = path.resolve(process.argv[3] ?? 'output/live-plugin-suite')
const pagePattern = process.argv[4] ?? '127.0.0.1:3080'

const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && String(item.url).includes(pagePattern))
if (!target?.webSocketDebuggerUrl) throw new Error(`No Harness page target matched ${JSON.stringify(pagePattern)}`)

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
  clearTimeout(entry.timer)
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} timed out`))
    }, 30_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
async function waitFor(expression, label, timeoutMs = 8_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function capture(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const filePath = path.join(outputDir, name)
  await writeFile(filePath, Buffer.from(result.data, 'base64'))
  return filePath
}

await mkdir(outputDir, { recursive: true })
await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')

const normalizeFunction = `value => String(value ?? '').replace(/\\s+/g, '').toLowerCase()`
await evaluate(`(() => {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.getClientRects().length) continue
    const close = Array.from(dialog.querySelectorAll('button,[role="button"]')).find(element => {
      const label = (${normalizeFunction})(element.getAttribute('aria-label') || element.title || element.textContent)
      return ['关闭','close'].includes(label) || String(element.className).includes('VOzbGW_close')
    })
    close?.click()
  }
  return true
})()`)
await waitFor(`!document.body.hasAttribute('data-dsh-desktop-settings-open')`, 'existing Settings dialog to close')
await waitFor(`Boolean(document.querySelector('.dcu-root'))`, 'Harness sidebar to mount')
await new Promise(resolve => setTimeout(resolve, 250))

const composer = await evaluate(`(async () => {
  let microphonePermission = 'unsupported'
  try { microphonePermission = (await navigator.permissions.query({ name: 'microphone' })).state } catch {}
  const voice = Array.from(document.querySelectorAll('button.stt-mic-btn')).filter(element => element.getClientRects().length)
  const polish = Array.from(document.querySelectorAll('button,[role="button"]')).filter(element => {
    if (!element.getClientRects().length) return false
    const label = (${normalizeFunction})(element.getAttribute('aria-label') || element.title || element.textContent)
    return label.includes('优化当前提示词') || label.includes('参考聊天记录上下文优化当前提示词') || label.includes('promptpolish')
  })
  return {
    secureContext: globalThis.isSecureContext,
    speechRecognition: typeof globalThis.SpeechRecognition,
    webkitSpeechRecognition: typeof globalThis.webkitSpeechRecognition,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
    microphonePermission,
    voiceButtons: voice.map(element => element.getAttribute('aria-label') || element.title),
    polishButtons: polish.map(element => element.getAttribute('aria-label') || element.title || element.textContent?.trim()),
  }
})()`)

await evaluate(`(() => {
  const settings = Array.from(document.querySelectorAll('button,[role="button"]')).find(element => {
    if (!element.getClientRects().length || element.closest('[role="dialog"]')) return false
    const label = (${normalizeFunction})(element.getAttribute('aria-label') || element.title || element.textContent)
    return label === '设置' || label === 'settings'
  })
    if (!settings) {
      const labels = Array.from(document.querySelectorAll('.dcu-root button')).map(element => element.getAttribute('aria-label') || element.title || element.textContent?.trim()).filter(Boolean)
      throw new Error('Settings button was not found: ' + JSON.stringify(labels))
    }
  settings.click()
  return true
})()`)
await waitFor(`document.body.getAttribute('data-dsh-desktop-settings-open') === 'true'`, 'Settings dialog to open')
await waitFor(`Boolean(document.querySelector('[data-dsh-desktop-settings-dialog="true"]'))`, 'Settings layout markers')
await evaluate(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const memory = Array.from(dialog?.querySelectorAll('button,[role="button"]') ?? []).find(element => {
    const label = (${normalizeFunction})(element.textContent || element.getAttribute('aria-label'))
    return label === '记忆系统' || label === 'memorysystem'
  })
  if (!memory) throw new Error('Mnemon Settings navigation item was not found')
  memory.click()
  return true
})()`)
await waitFor(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const text = (${normalizeFunction})(dialog?.textContent)
  return text.includes('记忆系统设置') || text.includes('记忆引擎') || text.includes('memorysystemsettings')
})()`, 'Mnemon Settings content', 12_000)
await new Promise(resolve => setTimeout(resolve, 300))

const memory = await evaluate(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const text = dialog?.textContent ?? ''
  return {
    visible: Boolean(dialog?.getClientRects().length),
    hasSettingsTitle: text.includes('记忆系统设置') || text.includes('记忆引擎'),
    hasUnavailableError: text.includes('无法加载记忆系统设置') || text.includes('Host 尚未提供'),
    hasProviderSection: text.includes('记忆体 Provider') || text.includes('Provider'),
    hasStorageSection: text.includes('记忆范围') || text.includes('运行时记忆'),
  }
})()`)
const screenshot = await capture('mnemon-settings.png')
const marketCompatibility = await evaluate(`(async () => {
  const response = await fetch('/dsh-market/updates?force=1', { cache: 'no-store' })
  const body = await response.json()
  const deferred = ['@linxin666/dsh-client-ui-task-board', '@linxin666/dsh-liangshen']
    .map(name => ({ name, update: body?.updates?.[name] ?? null }))
  return { status: response.status, deferred }
})()`)

const checks = {
  secureComposerContext: composer.secureContext === true,
  browserSpeechApiAvailable: composer.speechRecognition === 'function' || composer.webkitSpeechRecognition === 'function',
  microphoneApiAvailable: composer.getUserMedia === 'function',
  microphonePermissionNotDenied: composer.microphonePermission !== 'denied',
  voiceButtonMounted: composer.voiceButtons.length > 0,
  promptPolishMounted: composer.polishButtons.length > 0,
  mnemonSettingsMounted: memory.visible && memory.hasSettingsTitle,
  mnemonSettingsRpcAvailable: !memory.hasUnavailableError,
  mnemonSectionsRendered: memory.hasProviderSection && memory.hasStorageSection,
  marketOffersHealthy: marketCompatibility.status === 200
    && marketCompatibility.deferred.every(entry => {
      const update = entry.update
      if (update === null || typeof update !== 'object'
        || typeof update.current !== 'string' || typeof update.latest !== 'string'
        || update.desktopDeferred === true) return false
      return update.updateAvailable === true
        || (update.updateAvailable === false && update.current === update.latest)
    }),
}
const report = { target: { title: target.title, url: target.url }, checks, composer, memory, marketCompatibility, screenshot }
const reportPath = path.join(outputDir, 'report.json')
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

await evaluate(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const close = Array.from(dialog?.querySelectorAll('button,[role="button"]') ?? []).find(element => {
    const label = (${normalizeFunction})(element.getAttribute('aria-label') || element.title || element.textContent)
    return ['关闭','close'].includes(label) || String(element.className).includes('VOzbGW_close')
  })
  close?.click()
  return true
})()`)
socket.close()

if (Object.values(checks).some(value => !value)) {
  process.stderr.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
}
