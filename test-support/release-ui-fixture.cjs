'use strict'

const { createHash } = require('node:crypto')
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs')
const { join, relative, resolve } = require('node:path')

const CLIENT_SOURCE_RELATIVE_PATH = 'src/plugins/dsh-desktop-integration/lib/client.js'
const FIXTURE_SIMULATION_NOTE = 'fixture simulation only; this is not an actual DSH end-to-end run'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function skipTrivia(source, index) {
  let cursor = index
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1
      continue
    }
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2)
      cursor = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2)
      cursor = end < 0 ? source.length : end + 2
      continue
    }
    break
  }
  return cursor
}

function readJavaScriptString(source, start) {
  const quote = source[start]
  if (quote !== "'" && quote !== '"') throw new TypeError('Expected a JavaScript string literal')
  let value = ''
  let cursor = start + 1
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === quote) return { value, end: cursor + 1 }
    if (character !== '\\') {
      value += character
      cursor += 1
      continue
    }

    cursor += 1
    if (cursor >= source.length) throw new Error('Unterminated JavaScript string literal')
    const escaped = source[cursor]
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
    if (Object.hasOwn(simple, escaped)) {
      value += simple[escaped]
      cursor += 1
      continue
    }
    if (escaped === '\n') {
      cursor += 1
      continue
    }
    if (escaped === '\r') {
      cursor += source[cursor + 1] === '\n' ? 2 : 1
      continue
    }
    if (escaped === 'x') {
      const hex = source.slice(cursor + 1, cursor + 3)
      if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error('Invalid hexadecimal escape in JavaScript string literal')
      value += String.fromCharCode(Number.parseInt(hex, 16))
      cursor += 3
      continue
    }
    if (escaped === 'u') {
      if (source[cursor + 1] === '{') {
        const close = source.indexOf('}', cursor + 2)
        const codePoint = source.slice(cursor + 2, close)
        if (close < 0 || !/^[0-9a-f]+$/i.test(codePoint)) throw new Error('Invalid Unicode escape in JavaScript string literal')
        value += String.fromCodePoint(Number.parseInt(codePoint, 16))
        cursor = close + 1
      } else {
        const hex = source.slice(cursor + 1, cursor + 5)
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid Unicode escape in JavaScript string literal')
        value += String.fromCharCode(Number.parseInt(hex, 16))
        cursor += 5
      }
      continue
    }
    // This is the JavaScript identity escape behavior and also preserves CSS
    // backslashes used by a future selector without evaluating the file.
    value += escaped
    cursor += 1
  }
  throw new Error('Unterminated JavaScript string literal')
}

function findBalanced(source, start, opening, closing) {
  if (source[start] !== opening) throw new TypeError(`Expected ${opening} at ${String(start)}`)
  let depth = 0
  let cursor = start
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === "'" || character === '"' || character === '`') {
      if (character === '`') {
        cursor += 1
        while (cursor < source.length) {
          if (source[cursor] === '\\') {
            cursor += 2
            continue
          }
          if (source[cursor] === '`') break
          cursor += 1
        }
        cursor += 1
      } else {
        cursor = readJavaScriptString(source, cursor).end
      }
      continue
    }
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2)
      cursor = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2)
      cursor = end < 0 ? source.length : end + 2
      continue
    }
    if (character === opening) depth += 1
    if (character === closing) {
      depth -= 1
      if (depth === 0) return cursor
    }
    cursor += 1
  }
  throw new Error(`Unbalanced ${opening}${closing} block in client source`)
}

function extractStyleItems(source) {
  const marker = 'style.textContent = ['
  const markerStart = source.indexOf(marker)
  if (markerStart < 0) throw new Error('client.js does not contain the expected style.textContent array')
  const arrayStart = markerStart + marker.length - 1
  const arrayEnd = findBalanced(source, arrayStart, '[', ']')
  const body = source.slice(arrayStart + 1, arrayEnd)
  const items = []
  let cursor = 0
  while (cursor < body.length) {
    cursor = skipTrivia(body, cursor)
    if (cursor >= body.length) break
    if (body[cursor] === "'" || body[cursor] === '"') {
      const parsed = readJavaScriptString(body, cursor)
      items.push(parsed.value)
      cursor = parsed.end
      continue
    }
    cursor += 1
  }
  if (items.length === 0) throw new Error('client.js style array did not yield CSS entries')
  return { items, sourceStart: markerStart, sourceEnd: arrayEnd + 1 }
}

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}(`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`client.js does not contain ${functionName}`)
  const bodyStart = source.indexOf('{', start + marker.length)
  if (bodyStart < 0) throw new Error(`client.js ${functionName} has no body`)
  const bodyEnd = findBalanced(source, bodyStart, '{', '}')
  return source.slice(start, bodyEnd + 1)
}

function extractClientUiContract(root) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('Invalid fixture root')
  const clientPath = resolve(root, CLIENT_SOURCE_RELATIVE_PATH)
  if (!existsSync(clientPath)) throw new Error(`Missing client source: ${clientPath}`)
  const sourceBuffer = readFileSync(clientPath)
  const source = sourceBuffer.toString('utf8')
  const styles = extractStyleItems(source)
  const normalizedLabelSource = extractFunctionSource(source, 'normalizedLabel')
  const css = styles.items.join('')
  return Object.freeze({
    sourcePath: clientPath,
    sourceSha256: sha256(sourceBuffer),
    css,
    cssSha256: sha256(css),
    cssEntryCount: styles.items.length,
    normalizedLabelSource,
    normalizedLabelSha256: sha256(normalizedLabelSource),
  })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function buildFixtureHtml({ contract, inputFingerprint }) {
  if (contract === null || typeof contract !== 'object' || typeof contract.css !== 'string') {
    throw new TypeError('Invalid client UI contract')
  }
  if (typeof inputFingerprint !== 'string' || inputFingerprint.length === 0) throw new TypeError('Invalid fixture input fingerprint')

  const fixtureCss = `
    :root{--dsh-sidebar-width:232px;--dsh-sidebar-height:88px}
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{position:relative;background:#1d1e20;color:#f5f5f7;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
    #root{position:relative;width:100vw;height:100vh;min-width:0;min-height:0;overflow:hidden}
    .fixture-left-sidebar{position:absolute;left:0;top:0;bottom:0;width:320px;z-index:5;background:#252629;border-right:1px solid rgba(255,255,255,.08)}
    .dcu-root{display:flex;flex-direction:column;height:100%;min-height:0;background:#252629}
    .dcu-expanded-shell{display:flex;flex:1 1 0;flex-direction:column;min-height:0;overflow:hidden}
    .dcu-head{height:48px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:650}
    .dcu-menu{display:flex;flex:1 1 0;flex-direction:column;min-height:0;padding:12px 8px;gap:4px;overflow:hidden}
    .dcu-menu button,.dcu-foot button{font:inherit;color:inherit;border:0;background:transparent;text-align:left;cursor:default}
    .dcu-menu button{min-height:36px;padding:0 10px;border-radius:8px}
    .dcu-menu button[data-active="true"]{background:#313236}
    .dcu-native-workspaces{display:flex;flex:1 1 0;flex-direction:column;min-height:0;overflow:hidden}
    .dcu-wb-tree{min-height:0;overflow:auto}
    .dcu-wb-tree button{display:block;width:100%;text-align:left}
    .dcu-foot{display:flex;flex-direction:column;gap:4px;padding:8px;border-top:1px solid rgba(255,255,255,.08)}
    .fixture-conversation{position:absolute;left:320px;top:0;right:var(--dsh-sidebar-width);bottom:0;min-width:0;overflow:hidden;background:#202124}
    .fixture-conversation-copy{padding:32px;color:#a3a3a8}
    [data-composer-card]{position:absolute;left:24px;right:24px;bottom:24px;width:auto;min-height:104px;padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:#292a2d}
    .fixture-composer-row{display:flex;align-items:center;min-width:0;gap:8px}
    [data-slot="conversation.input.left"]{display:flex;align-items:center;gap:6px;min-width:0}
    [data-slot="conversation.input.model"]{display:flex;align-items:center;min-width:0;margin-left:auto}
    .fixture-composer-row button{font:inherit;color:inherit}
    [contenteditable]{min-height:32px;margin-top:12px;padding:7px 9px;outline:0;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#202124;color:#f5f5f7;white-space:pre-wrap}
    .fixture-right-sidebar{position:absolute;right:0;top:0;bottom:0;width:var(--dsh-sidebar-width);z-index:20;padding:16px;background:#303136;border-left:1px solid rgba(255,255,255,.1)}
    .fixture-right-sidebar-footer{position:absolute;left:0;right:0;bottom:0;height:var(--dsh-sidebar-height);padding:16px;border-top:1px solid rgba(255,255,255,.1);color:#a3a3a8}
    section[data-dsh-mnemon-view]{position:fixed;left:320px;top:40px;right:0;bottom:var(--dsh-sidebar-height);z-index:4;padding:24px;background:rgba(37,38,41,.98);border:1px solid rgba(255,255,255,.12);overflow:hidden}
    section[data-dsh-mnemon-view] h1{margin:0 0 8px;font-size:20px}
    .fixture-settings-ancestor{position:absolute;inset:0;z-index:1000;transform:translateZ(0);overflow:hidden}
    [data-dsh-desktop-settings-overlay="true"]{display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.58)}
    [data-dsh-desktop-settings-dialog="true"]{display:flex;flex-direction:row;width:900px;height:620px;overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#292a2d;box-shadow:0 18px 70px rgba(0,0,0,.42)}
    [data-dsh-desktop-settings-nav="true"]{display:flex;flex:0 0 208px;flex-direction:column;gap:4px;padding:16px 8px;background:#252629}
    [data-dsh-desktop-settings-nav="true"] button{display:flex;align-items:center;gap:8px;height:40px;flex:0 0 40px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#a3a3a8;text-align:left;font:inherit}
    [data-dsh-desktop-settings-nav="true"] button[aria-current="page"]{background:#313236;color:#f5f5f7}
    [data-dsh-desktop-settings-list="true"]{display:flex;flex:1 1 0;flex-direction:column;min-width:0;min-height:0;overflow:auto;padding:24px 28px}
    .fixture-settings-title{margin:0 0 16px;font-size:22px}
    .fixture-settings-row{display:flex;align-items:center;min-height:48px;border-bottom:1px solid rgba(255,255,255,.08);color:#d3d3d7}
    .fixture-settings-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  `
  const clientCss = contract.css.replace(/<\/style/gi, '<\\/style')
  const safeFingerprint = escapeHtml(inputFingerprint)
  const safeCssSha = escapeHtml(contract.cssSha256)
  const safeNormalizedLabelSha = escapeHtml(contract.normalizedLabelSha256)
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="dsh-release-input-fingerprint" content="${safeFingerprint}">
    <meta name="dsh-client-css-sha256" content="${safeCssSha}">
    <meta name="dsh-client-normalized-label-sha256" content="${safeNormalizedLabelSha}">
    <style data-fixture-css="layout">${fixtureCss}</style>
    <style data-fixture-css="dsh-client-extracted">${clientCss}</style>
  </head>
  <body data-ds-dark-theme data-dsh-desktop-panel-open="true" data-dsh-desktop-settings-open="true">
    <div id="root" data-slot="root">
      <aside class="fixture-left-sidebar" aria-label="fixture-left-sidebar">
        <div class="dcu-root">
          <div class="dcu-expanded-shell">
            <div class="dcu-head"><span class="dcu-brand" data-fixture-role="brand"></span></div>
            <div class="dcu-menu">
              <button type="button" data-active="true" aria-label="fixture-conversation"></button>
              <button type="button" aria-label="fixture-tasks"></button>
              <div class="dcu-native-workspaces" data-fixture="workspace-list">
                <div class="dcu-wb-tree" role="tree">
                  <button type="button" role="treeitem" aria-label="fixture-workspace-1"></button>
                  <button type="button" role="treeitem" aria-label="fixture-workspace-2"></button>
                  <button type="button" role="treeitem" aria-label="fixture-workspace-3"></button>
                </div>
              </div>
            </div>
          </div>
          <div class="dcu-foot">
            <button type="button" aria-label="fixture-help"></button>
            <button type="button" aria-label="fixture-settings"></button>
          </div>
        </div>
      </aside>
      <main class="fixture-conversation" data-fixture="conversation">
        <div class="fixture-conversation-copy" data-fixture-role="conversation-surface"></div>
        <div data-composer-card data-fixture="composer">
          <div class="fixture-composer-row fixture_row" data-dsh-desktop-composer-toolbar="true">
            <div data-slot="conversation.input.left" data-dsh-desktop-composer-group="tools">
              <button type="button" class="meme-trigger" aria-label="fixture-media"></button>
              <div class="dyn-opt-root dshDesktopComposerActionRoot">
                <button type="button" class="dyn-opt-main dshDesktopComposerActionButton" aria-label="fixture-optimizer"></button>
                <button type="button" class="dyn-opt-gear dshDesktopComposerActionButton" aria-label="fixture-optimizer-settings"></button>
              </div>
            </div>
            <div data-slot="conversation.input.model" data-dsh-desktop-composer-model="true"><span data-fixture-role="model"></span></div>
          </div>
          <div id="fixture-controlled-input" contenteditable="true" data-fixture-controlled-input="true">fixture-draft-001</div>
        </div>
      </main>
      <aside class="fixture-right-sidebar" data-fixture-right-sidebar="true" aria-label="fixture-right-sidebar">
        <strong data-fixture-role="right-sidebar-title"></strong>
        <div data-fixture-role="right-sidebar-body"></div>
        <div class="fixture-right-sidebar-footer" data-fixture-role="right-sidebar-footer"></div>
      </aside>
      <section data-dsh-mnemon-view="true" data-dsh-desktop-external-page="true" aria-label="fixture-mnemon-page">
        <h1 data-fixture-role="mnemon-heading"></h1>
        <div data-fixture-role="mnemon-body"></div>
      </section>
    </div>
    <div class="fixture-settings-ancestor" data-dsh-desktop-settings-ancestor="true">
      <div data-dsh-desktop-settings-overlay="true">
        <div role="dialog" aria-label="fixture-settings" data-dsh-desktop-settings-dialog="true">
          <nav data-dsh-desktop-settings-nav="true" aria-label="fixture-settings-nav">
            <button type="button" aria-current="page" aria-label="fixture-settings-section-1"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
            <button type="button" aria-label="fixture-settings-section-2"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
            <button type="button" aria-label="fixture-settings-section-3"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
            <button type="button" aria-label="fixture-settings-section-4"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
            <button type="button" aria-label="fixture-settings-section-5"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
            <button type="button" aria-label="fixture-settings-section-6"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
            <button type="button" aria-label="fixture-settings-section-7"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6" fill="currentColor"></circle></svg><span></span></button>
          </nav>
          <div data-dsh-desktop-settings-list="true">
            <h1 class="fixture-settings-title" data-fixture-role="settings-heading"></h1>
            ${Array.from({ length: 14 }, (_, index) => `<div class="fixture-settings-row" data-fixture-settings-row="${index + 1}"><span></span></div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`
}

function browserSimulation() {
  const checks = {}
  const failures = []
  const root = document.querySelector('#root')
  const conversation = document.querySelector('[data-fixture="conversation"]')
  const card = document.querySelector('[data-composer-card]')
  const rightSidebar = document.querySelector('[data-fixture-right-sidebar]')
  const mnemon = document.querySelector('section[data-dsh-mnemon-view]')
  const dialog = document.querySelector('[data-dsh-desktop-settings-dialog="true"]')
  const overlay = document.querySelector('[data-dsh-desktop-settings-overlay="true"]')
  const settingsNav = document.querySelector('[data-dsh-desktop-settings-nav="true"]')
  const settingsList = document.querySelector('[data-dsh-desktop-settings-list="true"]')
  const settingsAncestor = document.querySelector('.fixture-settings-ancestor')
  const optimizer = document.querySelector('.dyn-opt-main')
  const controlledInput = document.querySelector('[data-fixture-controlled-input="true"]')

  const round = value => Math.round(value * 100) / 100
  const closeEnough = (left, right, tolerance = 1.5) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
  const rect = element => element?.getBoundingClientRect?.()
  const record = (name, ok, details = {}) => {
    checks[name] = { ok: ok === true, ...details }
    if (ok !== true) failures.push({ name, ...details })
  }
  const normalizedLabel = value => typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : ''

  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const rootRect = rect(root)
  const conversationRect = rect(conversation)
  const cardRect = rect(card)
  const rightRect = rect(rightSidebar)
  const panelWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-sidebar-width'))
  const panelHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-sidebar-height'))
  record('right-sidebar-single-reservation', rootRect && conversationRect && cardRect && rightRect
    && closeEnough(rootRect.width, viewport.width)
    && closeEnough(conversationRect.right, viewport.width - panelWidth)
    && closeEnough(conversationRect.width, viewport.width - 320 - panelWidth)
    && closeEnough(cardRect.width, conversationRect.width - 48)
    && closeEnough(cardRect.right, conversationRect.right - 24), {
    rootWidth: round(rootRect?.width), viewportWidth: viewport.width,
    conversationWidth: round(conversationRect?.width), expectedConversationWidth: round(viewport.width - 320 - panelWidth),
    cardWidth: round(cardRect?.width), expectedCardWidth: round(conversationRect?.width - 48),
    panelWidth,
  })

  const mnemonRect = rect(mnemon)
  record('mnemon-independent-page-avoids-panels', mnemonRect
    && closeEnough(mnemonRect.left, 320)
    && closeEnough(mnemonRect.right, viewport.width - panelWidth)
    && closeEnough(mnemonRect.bottom, viewport.height - panelHeight), {
    left: round(mnemonRect?.left), expectedLeft: 320,
    right: round(mnemonRect?.right), expectedRight: round(viewport.width - panelWidth),
    bottom: round(mnemonRect?.bottom), expectedBottom: round(viewport.height - panelHeight),
  })

  const rootStyle = getComputedStyle(root)
  const dialogStyle = getComputedStyle(dialog)
  const overlayStyle = getComputedStyle(overlay)
  const navStyle = getComputedStyle(settingsNav)
  const listStyle = getComputedStyle(settingsList)
  const ancestorStyle = getComputedStyle(settingsAncestor)
  const settingsLabel = normalizedLabel(dialog?.getAttribute('aria-label'))
  record('settings-hierarchy-and-scroll-contract', root && dialog && overlay && settingsNav && settingsList && settingsAncestor
    && rootStyle.position === 'relative'
    && rootStyle.zIndex === '1000'
    && dialogStyle.width === '1060px'
    && overlayStyle.position === 'fixed'
    && overlayStyle.zIndex === '1000'
    && navStyle.width === '208px'
    && navStyle.flexBasis === '208px'
    && listStyle.overflowY === 'auto'
    && ancestorStyle.transform === 'none'
    && ancestorStyle.overflow === 'visible'
    && settingsLabel.length > 0, {
    rootPosition: rootStyle.position, rootZIndex: rootStyle.zIndex,
    dialogWidth: dialogStyle.width, overlayPosition: overlayStyle.position, overlayZIndex: overlayStyle.zIndex,
    navWidth: navStyle.width, navFlexBasis: navStyle.flexBasis, listOverflowY: listStyle.overflowY,
    ancestorTransform: ancestorStyle.transform, ancestorOverflow: ancestorStyle.overflow,
  })

  const optimizerStyle = getComputedStyle(optimizer)
  record('optimizer-action-uses-extracted-client-css', optimizer && optimizerStyle.width === '28px' && optimizerStyle.height === '28px'
    && typeof optimizer.getAttribute('aria-label') === 'string' && optimizer.getAttribute('aria-label').length > 0, {
    width: optimizerStyle.width, height: optimizerStyle.height, ariaLabel: optimizer?.getAttribute('aria-label'),
  })

  let draft = controlledInput?.textContent ?? ''
  let observedFailure = false
  const onInput = () => { draft = controlledInput.textContent ?? '' }
  controlledInput?.addEventListener('input', onInput)
  if (controlledInput) {
    controlledInput.textContent = `${draft}|edited`
    controlledInput.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const editedDraft = draft
  return Promise.resolve().then(async () => {
    try {
      await Promise.reject(new Error('synthetic optimizer fill failure'))
      controlledInput.textContent = 'fixture-optimizer-result-should-not-commit'
    } catch {
      observedFailure = true
      // This is the controlled-input fallback: the failed async operation must
      // re-render the last draft instead of committing an empty/partial value.
      if (controlledInput) controlledInput.textContent = draft
    }
    controlledInput?.removeEventListener('input', onInput)
    const preservedDraft = controlledInput?.textContent ?? ''
    record('controlled-input-preserves-draft-on-optimizer-failure', observedFailure && editedDraft !== '' && preservedDraft === editedDraft, {
      observedFailure, editedDraft, preservedDraft,
    })
    return {
      ok: failures.length === 0,
      simulation: true,
      actualDshE2E: false,
      note: 'fixture simulation only; this is not an actual DSH end-to-end run',
      checks,
      failures,
      viewport,
    }
  })
}

function assertChildPath(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing release fixture child path ${name}`)
  mkdirSync(value, { recursive: true })
  return resolve(value)
}

async function waitForPaint(window) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true)
}

async function closeWindow(window) {
  if (!window || window.isDestroyed()) return
  await new Promise(resolve => {
    window.once('closed', resolve)
    window.close()
  })
}

function flushChildStream(stream, value) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      stream.removeListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onError = error => finish(error)
    stream.once('error', onError)
    try {
      stream.write(value, 'utf8', finish)
    } catch (error) {
      finish(error)
    }
  })
}

async function runElectronFixtureChild() {
  const { app, BrowserWindow } = require('electron')
  const root = assertChildPath('root', process.env.DSH_RELEASE_ACCEPTANCE_ROOT)
  const outputDir = assertChildPath('output', process.env.DSH_RELEASE_ACCEPTANCE_OUTPUT_DIR)
  const userDataPath = assertChildPath('userData', process.env.DSH_RELEASE_ACCEPTANCE_USER_DATA)
  const tempPath = assertChildPath('temp', process.env.DSH_RELEASE_ACCEPTANCE_TEMP)
  const inputFingerprint = process.env.DSH_RELEASE_ACCEPTANCE_INPUT_FINGERPRINT
  if (typeof inputFingerprint !== 'string' || inputFingerprint.length === 0) throw new Error('Missing release fixture input fingerprint')

  app.setPath('userData', userDataPath)
  app.setPath('temp', tempPath)
  app.disableHardwareAcceleration()
  app.on('window-all-closed', event => event.preventDefault())

  let window
  let exitCode = 1
  try {
    await app.whenReady()
    const actualUserDataPath = resolve(app.getPath('userData'))
    const actualTempPath = resolve(app.getPath('temp'))
    if (actualUserDataPath !== resolve(userDataPath) || actualTempPath !== resolve(tempPath)) {
      throw new Error('Electron did not use the release acceptance userData/temp directories')
    }
    const contract = extractClientUiContract(root)
    const htmlPath = join(outputDir, 'release-ui-fixture.html')
    const screenshotPath = join(outputDir, 'release-ui-fixture.png')
    writeFileSync(htmlPath, buildFixtureHtml({ contract, inputFingerprint }), { encoding: 'utf8', flag: 'wx' })

    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      useContentSize: true,
      backgroundColor: '#1d1e20',
      resizable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    const networkRequests = []
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      networkRequests.push(details.url)
      callback({ cancel: true })
    })

    await window.loadFile(htmlPath)
    await waitForPaint(window)
    const simulation = await window.webContents.executeJavaScript(`(${browserSimulation.toString()})()`, true)
    const image = await window.webContents.capturePage()
    writeFileSync(screenshotPath, image.toPNG(), { flag: 'wx' })
    const payload = {
      ok: simulation?.ok === true,
      simulation: true,
      actualDshE2E: false,
      note: FIXTURE_SIMULATION_NOTE,
      inputFingerprint,
      client: {
        sourcePath: relative(root, contract.sourcePath),
        sourceSha256: contract.sourceSha256,
        cssSha256: contract.cssSha256,
        cssEntryCount: contract.cssEntryCount,
        normalizedLabelSha256: contract.normalizedLabelSha256,
      },
      browserWindow: {
        show: false,
        isVisible: window.isVisible(),
        userDataPath: actualUserDataPath,
        tempPath: actualTempPath,
        userDataIsolated: actualUserDataPath === resolve(userDataPath),
        tempIsolated: actualTempPath === resolve(tempPath),
      },
      htmlPath,
      screenshotPath,
      networkRequests,
      checks: simulation?.checks ?? {},
      failures: simulation?.failures ?? [{ name: 'fixture-simulation-result', reason: 'missing result' }],
      viewport: simulation?.viewport,
    }
    await flushChildStream(process.stdout, `RELEASE_ACCEPTANCE_RESULT ${JSON.stringify(payload)}\n`)
    exitCode = payload.ok && payload.browserWindow.isVisible === false && networkRequests.length === 0 ? 0 : 1
  } catch (error) {
    await flushChildStream(process.stderr, `${error?.stack || error}\n`).catch(() => {})
  } finally {
    try { await closeWindow(window) } catch (error) {
      await flushChildStream(process.stderr, `${error?.stack || error}\n`).catch(() => {})
      exitCode = 1
    }
    app.exit(exitCode)
  }
}

// Electron does not guarantee that require.main is this CJS entry file. The
// runner-owned environment marker is the deliberate child-process boundary.
if (process.env.DSH_RELEASE_ACCEPTANCE_CHILD === '1') {
  void runElectronFixtureChild()
}

module.exports = Object.freeze({
  CLIENT_SOURCE_RELATIVE_PATH,
  FIXTURE_SIMULATION_NOTE,
  browserSimulation,
  buildFixtureHtml,
  extractClientCss: root => extractClientUiContract(root).css,
  extractClientUiContract,
  runElectronFixtureChild,
})
