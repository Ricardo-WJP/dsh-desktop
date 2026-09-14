import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const port = Number(process.argv[2] ?? 9229)
const outputDir = path.resolve(process.argv[3] ?? 'output/compact-settings-layout')
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

async function waitFor(expression, label, timeoutMs = 8_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 50))
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

await mkdir(outputDir, { recursive: true })
await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')

const normalizeFunction = `value => String(value ?? '').replace(/\\s+/g, '').toLowerCase()`
const settingsButton = `Array.from(document.querySelectorAll('button,[role="button"]')).find(element => {
  if (!element.getClientRects().length || element.closest('[role="dialog"]')) return false
  const label = (${normalizeFunction})(element.getAttribute('aria-label') || element.title || element.textContent)
  return label === '设置' || label === 'settings'
})`

// Normalize the starting state without changing the user's remembered right-panel state.
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
await waitFor(`!document.body.hasAttribute('data-dsh-desktop-settings-open')`, 'existing settings dialog to close')

const sidebarState = await evaluate(`(() => {
  const root = document.querySelector('.dcu-root')
  if (!root) throw new Error('Left sidebar root was not found')
  const width = root.getBoundingClientRect().width
  if (!root.classList.contains('dcu-compact') && width > 80) {
    const collapse = Array.from(root.querySelectorAll('button')).find(element => {
      const label = (${normalizeFunction})(element.getAttribute('aria-label') || element.title)
      return label === '折叠侧边栏' || label === '收缩侧边栏' || label === 'collapsesidebar'
    })
    if (!collapse) {
      const labels = Array.from(root.querySelectorAll('button')).map(element => element.getAttribute('aria-label') || element.title || element.textContent?.trim()).filter(Boolean)
      throw new Error('Left sidebar collapse button was not found. Visible labels: ' + JSON.stringify(labels))
    }
    collapse.click()
  }
  return { className: root.className, width }
})()`)
await waitFor(`(() => { const root = document.querySelector('.dcu-root'); return root?.classList.contains('dcu-compact') === true || (root?.getBoundingClientRect().width ?? 999) <= 80 })()`, 'left sidebar compact state')
await new Promise(resolve => setTimeout(resolve, 450))

await evaluate(`(() => {
  const button = ${settingsButton}
  if (!button) throw new Error('Compact Settings button was not found')
  button.click()
  return true
})()`)
await waitFor(`document.body.getAttribute('data-dsh-desktop-settings-open') === 'true'`, 'compact Settings dialog to open')
await waitFor(`Boolean(document.querySelector('[data-dsh-desktop-settings-dialog="true"]'))`, 'desktop Settings layout markers')
await new Promise(resolve => setTimeout(resolve, 250))

const inspectDialog = await evaluate(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const overlay = document.querySelector('[data-dsh-desktop-settings-overlay="true"]')
  const nav = dialog?.querySelector('[data-dsh-desktop-settings-nav="true"]')
  const content = dialog ? Array.from(dialog.children).find(element => element !== nav && element.getClientRects().length) : null
  const rect = element => {
    const value = element?.getBoundingClientRect()
    return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } : null
  }
  const visibleActions = dialog
    ? Array.from(dialog.querySelectorAll('button,[role="button"]')).filter(element => element.getClientRects().length)
    : []
  const textOverflow = visibleActions.filter(element => {
    const text = element.textContent?.trim()
    return text && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)
  }).map(element => ({ text: element.textContent.trim(), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }))
  const overlaps = []
  for (let index = 0; index < visibleActions.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < visibleActions.length; otherIndex += 1) {
      const left = visibleActions[index]
      const right = visibleActions[otherIndex]
      if (left.contains(right) || right.contains(left)) continue
      const a = left.getBoundingClientRect()
      const b = right.getBoundingClientRect()
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (width > 4 && height > 4) overlaps.push([left.textContent?.trim() || left.getAttribute('aria-label'), right.textContent?.trim() || right.getAttribute('aria-label')])
    }
  }
  const customIcons = Array.from(dialog?.querySelectorAll('[data-dsh-desktop-custom-settings-icon="true"]') ?? []).map(button => {
    const svg = button.querySelector(':scope > svg:first-child')
    return { text: button.textContent?.trim(), genericSvgDisplay: svg ? getComputedStyle(svg).display : null }
  })
  const dialogRect = rect(dialog)
  const overlayRect = rect(overlay)
  return {
    viewport: { width: innerWidth, height: innerHeight },
    dialog: dialogRect,
    overlay: overlayRect,
    nav: rect(nav),
    content: rect(content),
    dialogHorizontalOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : null,
    compactMarkersInDialog: dialog?.querySelectorAll('[data-dsh-desktop-compact-action="true"]').length ?? null,
    textOverflow,
    overlaps,
    customIcons,
    centered: dialogRect ? Math.abs((dialogRect.left + dialogRect.width / 2) - innerWidth / 2) <= 2 : false,
  }
})()`)
const generalScreenshot = await capture('settings-general-compact.png')

await evaluate(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const button = Array.from(dialog?.querySelectorAll('button,[role="button"]') ?? []).find(element => (${normalizeFunction})(element.textContent) === '插件市场')
  if (!button) throw new Error('Plugin Market settings navigation item was not found')
  button.click()
  return true
})()`)
await waitFor(`(() => {
  const text = (${normalizeFunction})(document.querySelector('[data-dsh-desktop-settings-dialog="true"]')?.textContent)
  return text.includes('插件市场') && !text.includes('正在加载插件目录') && !text.includes('loadingplugincatalog')
})()`, 'Plugin Market catalog to finish loading', 15_000)
await new Promise(resolve => setTimeout(resolve, 250))

const inspectMarket = await evaluate(`(() => {
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const visibleActions = Array.from(dialog?.querySelectorAll('button,[role="button"]') ?? []).filter(element => element.getClientRects().length)
  return {
    compactMarkersInDialog: dialog?.querySelectorAll('[data-dsh-desktop-compact-action="true"]').length ?? null,
    horizontalOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : null,
    clippedTextButtons: visibleActions.filter(element => element.textContent?.trim() && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)).map(element => element.textContent.trim()),
    tinyTextButtons: visibleActions.filter(element => element.textContent?.trim().length > 2 && !/^[0-9]+$/.test(element.textContent.trim()) && element.clientWidth <= 38).map(element => ({ text: element.textContent.trim(), width: element.clientWidth, height: element.clientHeight })),
  }
})()`)
const marketScreenshot = await capture('settings-market-compact.png')

const checks = {
  dialogCentered: inspectDialog.centered,
  dialogHasSafeVerticalMargins: inspectDialog.dialog?.top >= 56 && inspectDialog.dialog?.bottom <= inspectDialog.viewport.height - 16,
  fullSettingsNavigation: inspectDialog.nav?.width >= 180,
  contentHasUsableWidth: inspectDialog.content?.width >= 520,
  noCompactMarkersInDialog: inspectDialog.compactMarkersInDialog === 0 && inspectMarket.compactMarkersInDialog === 0,
  noGeneralTextOverflow: inspectDialog.textOverflow.length === 0,
  noInteractiveOverlap: inspectDialog.overlaps.length === 0,
  noDialogHorizontalOverflow: inspectDialog.dialogHorizontalOverflow <= 2 && inspectMarket.horizontalOverflow <= 2,
  pluginIconsReplaceGenericGear: inspectDialog.customIcons.length >= 3 && inspectDialog.customIcons.every(icon => icon.genericSvgDisplay === 'none'),
  noMarketTextOverflow: inspectMarket.clippedTextButtons.length === 0,
  noMarketTextButtonsForcedCompact: inspectMarket.tinyTextButtons.length === 0,
}

const report = {
  target: { title: target.title, url: target.url },
  startingSidebarState: sidebarState,
  checks,
  settings: inspectDialog,
  market: inspectMarket,
  artifacts: { generalScreenshot, marketScreenshot },
}
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
if (sidebarState.width > 80) await evaluate(`(() => {
  const root = document.querySelector('.dcu-root.dcu-compact')
  const expand = Array.from(root?.querySelectorAll('button') ?? []).find(button => ['展开侧边栏','expandsidebar'].includes((${normalizeFunction})(button.getAttribute('aria-label') || button.title)))
  expand?.click()
})()`)
socket.close()

if (Object.values(checks).some(value => !value)) {
  process.stderr.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
}
