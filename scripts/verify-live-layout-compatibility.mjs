import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { panelOccupiesLayoutOnce } from './lib/panel-layout-check.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const port = Number(process.argv[2] ?? 9338)
const outputDir = path.resolve(process.argv[3] ?? 'output/layout-compatibility')
const pagePattern = process.argv[4] ?? '127.0.0.1:3080'

const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && String(item.url).includes(pagePattern))
if (!target?.webSocketDebuggerUrl) {
  throw new Error(`No page target matched ${JSON.stringify(pagePattern)}. Targets: ${targets.map(item => item.url).join(', ')}`)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let sequence = 0
const pending = new Map()
socket.on('message', raw => {
  const message = JSON.parse(String(raw))
  if (!message.id || !pending.has(message.id)) return
  const entry = pending.get(message.id)
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
    }, 60_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result?.value
}

async function waitFor(expression, label, timeoutMs = 5_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function capture(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  const filePath = path.join(outputDir, name)
  await writeFile(filePath, Buffer.from(result.data, 'base64'))
  return filePath
}

const panelWidthExpression = `Math.max(0, Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-sidebar-width')) || 0)`
const visibleButtonExpression = label => `Array.from(document.querySelectorAll('button,[role="button"]')).find(element => element.getClientRects().length && element.getAttribute('aria-label') === ${JSON.stringify(label)})`
const panelButtonExpression = label => `Array.from(document.querySelectorAll('button,[role="button"]')).find(element => element.getClientRects().length && String(element.className).includes('nArs4W_toggleButton') && element.getAttribute('aria-label') === ${JSON.stringify(label)})`

await mkdir(outputDir, { recursive: true })
await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')

// Start from the conversation, with the right panel closed.
await evaluate(`(() => {
  const close = Array.from(document.querySelectorAll('button.VOzbGW_close')).find(element => element.getClientRects().length)
  close?.click()
  return true
})()`)
await waitFor(`!document.body.hasAttribute('data-dsh-desktop-settings-open')`, 'settings dialog to close')

if ((await evaluate(panelWidthExpression)) > 0) {
  await evaluate(`(${panelButtonExpression('折叠侧边栏')})?.click()`)
  await waitFor(`${panelWidthExpression} === 0`, 'right panel to close')
}

await evaluate(`(() => {
  const compactRoot = document.querySelector('aside.dcu-root.dcu-compact')
  if (!compactRoot) return false
  const expand = Array.from(compactRoot.querySelectorAll('button')).find(element =>
    element.getClientRects().length && element.getAttribute('aria-label') === '展开侧边栏')
  if (!expand) throw new Error('Left sidebar expand button was not found')
  expand.click()
  return true
})()`)
await waitFor(`(() => {
  const root = document.querySelector('aside.dcu-root')
  return Boolean(root && !root.classList.contains('dcu-compact') && !root.classList.contains('dcu-collapsing') && root.getBoundingClientRect().width > 200)
})()`, 'left sidebar to finish expanding')

const openTiming = await evaluate(`new Promise((resolve, reject) => {
  const button = ${panelButtonExpression('展开侧边栏')}
  if (!button) {
    reject(new Error('Right sidebar expand button was not found'))
    return
  }
  const startedAt = performance.now()
  const samples = []
  let finished = false
  const capture = phase => {
    const panelWidth = ${panelWidthExpression}
    const appRoot = document.querySelector('#root')
    const appRect = appRoot?.getBoundingClientRect()
    samples.push({
      phase,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      panelWidth,
      appWidth: appRect ? Number(appRect.width.toFixed(2)) : null,
      panelOpenAttribute: document.body.getAttribute('data-dsh-desktop-panel-open'),
    })
    if (!finished && panelWidth > 0 && document.body.getAttribute('data-dsh-desktop-panel-open') === 'true') {
      finished = true
      clearTimeout(timeout)
      observer.disconnect()
      resolve(samples)
    }
  }
  const observer = new MutationObserver(() => capture('mutation'))
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-dsh-desktop-panel-open'] })
  const timeout = setTimeout(() => {
    observer.disconnect()
    reject(new Error('Right sidebar did not update the conversation geometry within 1000ms'))
  }, 1000)
  button.click()
  capture('after-click')
  queueMicrotask(() => capture('microtask'))
})`)
await waitFor(`${panelWidthExpression} > 0 && document.body.getAttribute('data-dsh-desktop-panel-open') === 'true'`, 'right panel layout to open')
await waitFor(`(() => {
  const root = document.querySelector('aside.dcu-root')
  return Boolean(root && !root.classList.contains('dcu-compact') && !root.classList.contains('dcu-collapsing') && root.getBoundingClientRect().width > 200)
})()`, 'left sidebar to remain expanded beside the right panel')

const conversation = await evaluate(`(() => {
  const userFlow = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).at(-1)
  const userStack = userFlow?.querySelector('[data-time-hover-root]')
  const bubble = userStack?.firstElementChild
  userFlow?.scrollIntoView({ block: 'center' })
  const appRoot = document.querySelector('#root')
  const appRect = appRoot?.getBoundingClientRect()
  const stackRect = userStack?.getBoundingClientRect()
  const bubbleRect = bubble?.getBoundingClientRect()
  const panelWidth = ${panelWidthExpression}
  const leftSidebar = document.querySelector('aside.dcu-root')
  const leftSidebarRect = leftSidebar?.getBoundingClientRect()
  const frame = document.querySelector('#root [data-dsh-frame], #root > [data-slot="root"] > div')
  const frameRect = frame?.getBoundingClientRect()
  return {
    viewportWidth: innerWidth,
    appWidth: appRect ? Number(appRect.width.toFixed(2)) : null,
    panelWidth,
    frameWidth: frameRect ? Number(frameRect.width.toFixed(2)) : null,
    framePaddingRight: frame ? Number.parseFloat(getComputedStyle(frame).paddingRight) : null,
    panelOpenAttribute: document.body.getAttribute('data-dsh-desktop-panel-open'),
    leftSidebarClass: leftSidebar?.className ?? null,
    leftSidebarWidth: leftSidebarRect ? Number(leftSidebarRect.width.toFixed(2)) : null,
    userStackAlign: userStack ? getComputedStyle(userStack).alignItems : null,
    userStackRight: stackRect ? Number(stackRect.right.toFixed(2)) : null,
    userBubbleRight: bubbleRect ? Number(bubbleRect.right.toFixed(2)) : null,
    userBubbleLeft: bubbleRect ? Number(bubbleRect.left.toFixed(2)) : null,
  }
})()`)
const conversationScreenshot = await capture('conversation-right-sidebar-open.png')

const closeTiming = await evaluate(`new Promise((resolve, reject) => {
  const button = ${panelButtonExpression('折叠侧边栏')}
  if (!button) {
    reject(new Error('Right sidebar collapse button was not found'))
    return
  }
  const startedAt = performance.now()
  const samples = []
  let finished = false
  const capture = phase => {
    const panelWidth = ${panelWidthExpression}
    const appRoot = document.querySelector('#root')
    const appRect = appRoot?.getBoundingClientRect()
    samples.push({
      phase,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      panelWidth,
      appWidth: appRect ? Number(appRect.width.toFixed(2)) : null,
      panelOpenAttribute: document.body.getAttribute('data-dsh-desktop-panel-open'),
    })
    if (!finished && panelWidth === 0 && !document.body.hasAttribute('data-dsh-desktop-panel-open')) {
      finished = true
      clearTimeout(timeout)
      observer.disconnect()
      resolve(samples)
    }
  }
  const observer = new MutationObserver(() => capture('mutation'))
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-dsh-desktop-panel-open'] })
  const timeout = setTimeout(() => {
    observer.disconnect()
    reject(new Error('Right sidebar did not restore the conversation geometry within 1000ms'))
  }, 1000)
  button.click()
  capture('after-click')
  queueMicrotask(() => capture('microtask'))
})`)
await waitFor(`${panelWidthExpression} === 0 && !document.body.hasAttribute('data-dsh-desktop-panel-open')`, 'right panel layout to close')

// Reopen the right panel before opening Settings. The global modal must cover
// both sidebars without changing either sidebar's remembered open state.
await evaluate(`(() => {
  const button = ${panelButtonExpression('展开侧边栏')}
  if (!button) throw new Error('Right sidebar expand button was not found before Settings')
  button.click()
  return true
})()`)
await waitFor(`${panelWidthExpression} > 0 && document.body.getAttribute('data-dsh-desktop-panel-open') === 'true'`, 'right panel to reopen before settings')
await waitFor(`(() => {
  const root = document.querySelector('aside.dcu-root')
  return Boolean(root && !root.classList.contains('dcu-compact') && !root.classList.contains('dcu-collapsing') && root.getBoundingClientRect().width > 200)
})()`, 'left sidebar to remain expanded before settings')

await evaluate(`(() => {
  const button = ${visibleButtonExpression('设置')}
  if (!button) throw new Error('Settings button was not found')
  button.click()
  return true
})()`)
await waitFor(`document.body.getAttribute('data-dsh-desktop-settings-open') === 'true'`, 'settings dialog to open')

const settings = await evaluate(`(() => {
  const navigator = document.querySelector('.dcu-turn-navigator')
  const style = navigator ? getComputedStyle(navigator) : null
  const rect = navigator?.getBoundingClientRect()
  const overlay = document.querySelector('[data-dsh-desktop-settings-overlay="true"]')
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const appRoot = document.querySelector('#root')
  const panelHost = document.querySelector('[data-dsh-panel-host]')
  const overlayRect = overlay?.getBoundingClientRect()
  const dialogRect = dialog?.getBoundingClientRect()
  const rootRect = appRoot?.getBoundingClientRect()
  const hit = document.elementFromPoint(innerWidth - 24, Math.round(innerHeight / 2))
  return {
    viewportWidth: innerWidth,
    panelWidth: ${panelWidthExpression},
    bodyAttribute: document.body.getAttribute('data-dsh-desktop-settings-open'),
    dialogVisible: Boolean(Array.from(document.querySelectorAll('[role="dialog"]')).find(element => element.getClientRects().length)),
    rootWidth: rootRect ? Number(rootRect.width.toFixed(2)) : null,
    rootZIndex: appRoot ? Number.parseFloat(getComputedStyle(appRoot).zIndex) || 0 : null,
    panelHostZIndex: panelHost ? Number.parseFloat(getComputedStyle(panelHost).zIndex) || 0 : null,
    overlayLeft: overlayRect ? Number(overlayRect.left.toFixed(2)) : null,
    overlayWidth: overlayRect ? Number(overlayRect.width.toFixed(2)) : null,
    dialogCenterX: dialogRect ? Number((dialogRect.left + dialogRect.width / 2).toFixed(2)) : null,
    rightEdgeOwnedBySettings: Boolean(hit?.closest('[data-dsh-desktop-settings-overlay="true"]')),
    navigatorFound: Boolean(navigator),
    navigatorDisplay: style?.display ?? null,
    navigatorVisibility: style?.visibility ?? null,
    navigatorPointerEvents: style?.pointerEvents ?? null,
    navigatorWidth: rect ? Number(rect.width.toFixed(2)) : null,
    navigatorHeight: rect ? Number(rect.height.toFixed(2)) : null,
  }
})()`)
const settingsScreenshot = await capture('settings-over-right-sidebar.png')

await evaluate(`(() => {
  const close = Array.from(document.querySelectorAll('button.VOzbGW_close')).find(element => element.getClientRects().length)
  close?.click()
  return true
})()`)
await waitFor(`!document.body.hasAttribute('data-dsh-desktop-settings-open')`, 'settings dialog state to clear')
const afterSettingsClose = await evaluate(`(() => {
  const leftSidebar = document.querySelector('aside.dcu-root')
  const rect = leftSidebar?.getBoundingClientRect()
  return {
    leftSidebarClass: leftSidebar?.className ?? null,
    leftSidebarWidth: rect ? Number(rect.width.toFixed(2)) : null,
    panelWidth: ${panelWidthExpression},
  }
})()`)
await evaluate(`(${panelButtonExpression('折叠侧边栏')})?.click()`)
await waitFor(`${panelWidthExpression} === 0 && !document.body.hasAttribute('data-dsh-desktop-panel-open')`, 'right panel to close after settings')

const firstOpenLayoutFrame = openTiming.find(sample => sample.panelWidth > 0 && sample.panelOpenAttribute === 'true')
const firstClosedLayoutFrame = closeTiming.find(sample => sample.panelWidth === 0 && sample.panelOpenAttribute === null)
const checks = {
  panelOpensWithin250ms: Boolean(firstOpenLayoutFrame && firstOpenLayoutFrame.elapsedMs <= 250),
  panelClosesWithin250ms: Boolean(firstClosedLayoutFrame && firstClosedLayoutFrame.elapsedMs <= 250),
  panelAndConversationShareViewport: panelOccupiesLayoutOnce(conversation),
  bothSidebarsRemainOpen: !String(conversation.leftSidebarClass).includes('dcu-compact') && conversation.leftSidebarWidth > 200 && conversation.panelWidth > 0,
  // A fresh/empty conversation has no user bubble to inspect. The CSS rule is
  // covered statically; when a bubble is present this remains a live geometry check.
  userMessageRightAligned: conversation.userStackAlign === null
    || (conversation.userStackAlign === 'flex-end' && Math.abs(conversation.userStackRight - conversation.userBubbleRight) <= 1),
  settingsCoversOpenRightPanel: settings.panelWidth > 0
    && Number.isFinite(settings.rootWidth)
    && Math.abs(settings.rootWidth - settings.viewportWidth) <= 1
    && settings.overlayLeft === 0
    && settings.overlayWidth === settings.viewportWidth
    && Math.abs(settings.dialogCenterX - settings.viewportWidth / 2) <= 1
    && settings.rootZIndex > settings.panelHostZIndex
    && settings.rightEdgeOwnedBySettings,
  leftSidebarPreservedAfterSettingsClose: afterSettingsClose.panelWidth > 0
    && !String(afterSettingsClose.leftSidebarClass).includes('dcu-compact')
    && afterSettingsClose.leftSidebarWidth > 200,
  navigatorHiddenInSettings: settings.bodyAttribute === 'true'
    && (!settings.navigatorFound
      || (settings.navigatorDisplay === 'none'
        && settings.navigatorVisibility === 'hidden'
        && settings.navigatorPointerEvents === 'none'
        && settings.navigatorWidth === 0
        && settings.navigatorHeight === 0)),
}

const report = {
  target: { title: target.title, url: target.url },
  checks,
  openTiming,
  closeTiming,
  conversation,
  settings,
  afterSettingsClose,
  artifacts: {
    conversationScreenshot,
    settingsScreenshot,
  },
}
const reportPath = path.join(outputDir, 'report.json')
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

socket.close()

if (Object.values(checks).some(value => !value)) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
}
