import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9229)
const outputDir = path.resolve(process.argv[3] ?? 'output/live-prompt-polish-settings')

const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && String(item.url).startsWith('http://127.0.0.1:3080'))
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
async function waitFor(expression, label, timeoutMs = 12_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function clickMatching(expression, label) {
  const point = await evaluate(`(() => {
    const element = (${expression})
    if (!(element instanceof HTMLElement)) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!point) throw new Error(`${label} was not found`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
}
function state(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return { present: false }
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      present: true,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
    }
  })()`
}
function visible(value) {
  return value?.present === true
    && value.rect.width > 0
    && value.rect.height > 0
    && value.display !== 'none'
    && value.visibility !== 'hidden'
    && value.opacity > 0.5
    && value.pointerEvents !== 'none'
}

await mkdir(outputDir, { recursive: true })
await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')

const report = { target: { title: target.title, url: target.url }, checks: {}, states: {} }
try {
  await waitFor('Boolean(document.querySelector(".dcu-root"))', 'Harness sidebar')
  await waitFor('Boolean(document.querySelector("button.dyn-opt-gear"))', 'prompt-polish settings gear')
  await waitFor('document.body.getAttribute("data-dsh-desktop-settings-open") !== "true"', 'native Settings to be closed')

  report.states.initial = await evaluate(`({ settingsOpen: document.body.getAttribute('data-dsh-desktop-settings-open'), compact: document.querySelector('.dcu-root')?.classList.contains('dcu-compact') })`)
  await clickMatching('document.querySelector("button.dyn-opt-gear")', 'prompt-polish settings gear')
  await waitFor('Boolean(document.querySelector(".dyn-opt-pop"))', 'prompt-polish quick settings')
  await new Promise(resolve => setTimeout(resolve, 250))
  report.states.quickPanel = await evaluate(`({ bodySettingsOpen: document.body.getAttribute('data-dsh-desktop-settings-open'), pop: ${state('.dyn-opt-pop')}, gear: ${state('button.dyn-opt-gear')} })`)
  report.checks.quickPanelVisible = visible(report.states.quickPanel.pop)
  report.checks.quickPanelDoesNotHideComposer = report.states.quickPanel.bodySettingsOpen !== 'true'
  report.checks.gearRemainsVisible = visible(report.states.quickPanel.gear)

  await clickMatching('Array.from(document.querySelectorAll(".dyn-opt-pop button")).find(button => button.textContent.includes("打开完整设置"))', 'full prompt-polish settings action')
  await waitFor('Boolean(document.querySelector(".dyn-opt-dialog-backdrop"))', 'full prompt-polish settings')
  await new Promise(resolve => setTimeout(resolve, 250))
  report.states.fullDialog = await evaluate(`({ bodySettingsOpen: document.body.getAttribute('data-dsh-desktop-settings-open'), dialog: ${state('.dyn-opt-dialog-backdrop')} })`)
  report.checks.fullDialogVisible = visible(report.states.fullDialog.dialog)
  report.checks.fullDialogDoesNotActivateNativeSettings = report.states.fullDialog.bodySettingsOpen !== 'true'
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await waitFor('!document.querySelector(".dyn-opt-dialog-backdrop") && !document.querySelector(".dyn-opt-pop")', 'prompt-polish dialogs to close')

  await clickMatching('Array.from(document.querySelectorAll("button,[role=button]")).find(button => !button.closest("[role=dialog]") && (button.getAttribute("aria-label") || button.title || button.textContent).replace(/\\s+/g, "").toLowerCase() === "设置")', 'native Settings button')
  await waitFor('document.body.getAttribute("data-dsh-desktop-settings-open") === "true"', 'native Settings state')
  await waitFor('Boolean(document.querySelector("[data-dsh-desktop-settings-dialog=\\"true\\"]"))', 'native Settings layout')
  report.states.nativeSettings = await evaluate(`({ bodySettingsOpen: document.body.getAttribute('data-dsh-desktop-settings-open'), gear: ${state('button.dyn-opt-gear')} })`)
  report.checks.nativeSettingsStillOpens = report.states.nativeSettings.bodySettingsOpen === 'true'
  await clickMatching('document.querySelector(".VOzbGW_close")', 'native Settings close button')
  await waitFor('document.body.getAttribute("data-dsh-desktop-settings-open") !== "true"', 'native Settings to close')
  await waitFor('Boolean(document.querySelector("button.dyn-opt-gear"))', 'prompt-polish gear after Settings close')
  report.states.afterNativeClose = await evaluate(`({ bodySettingsOpen: document.body.getAttribute('data-dsh-desktop-settings-open'), gear: ${state('button.dyn-opt-gear')} })`)
  report.checks.nativeSettingsCloseRestoresComposer = report.states.afterNativeClose.bodySettingsOpen !== 'true' && visible(report.states.afterNativeClose.gear)
} finally {
  await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    for (const close of document.querySelectorAll('.VOzbGW_close')) close.click()
    return true
  })()`).catch(() => {})
  await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  socket.close()
}

if (Object.values(report.checks).some(value => value !== true)) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
