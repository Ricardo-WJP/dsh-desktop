import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Desktop shell UI overrides.
 *
 * Owns every visual correction that belongs to the desktop shell:
 *   - the shared window title bar (menu row, back/forward buttons)
 *   - ONE sidebar width for both pages (main sidebar + settings nav)
 *   - ONE sidebar-width grip, used on both pages
 *   - settings nav surface/text colours matched to the main sidebar
 *   - icon/shape corrections (panel toggle, folder, nav icons, pills, loader)
 *   - the full-access accent colour
 *
 * Injected into the workspace window through the executeJavaScript channel;
 * the stylesheet travels as a JSON parameter so no template-escaping is
 * involved.
 */

/** Single source of truth for the shell layout. */
export const DESKTOP_UI = {
  sidebarWidth: 240,
  sidebarMinWidth: 240,
  sidebarMaxWidth: 420,
  titleBarHeight: 40,
  /** Measured colours so the settings nav matches the main sidebar exactly. */
  sidebarColor: { dark: '#262728', light: '#f4f4f5' },
  textColor: { dark: '#f9fafb', light: '#1a1b1c' },
}

const CSS_PATH = fileURLToPath(new URL('./shell-ui-overrides.css', import.meta.url))

const SHELL_UI_JS = `
;(function () {
  window.__dshShellUiSetCss = function (cssText) {
    var el = document.getElementById('dsh-shell-ui-style')
    if (!el) {
      el = document.createElement('style')
      el.id = 'dsh-shell-ui-style'
      document.head.appendChild(el)
    }
    el.textContent = cssText
  }
  if (window.__dshShellUiInstalled) return
  window.__dshShellUiInstalled = true
  var CONFIG = {
    sidebarWidth: ${DESKTOP_UI.sidebarWidth},
    sidebarMin: ${DESKTOP_UI.sidebarMinWidth},
    sidebarMax: ${DESKTOP_UI.sidebarMaxWidth},
    titleBarHeight: ${DESKTOP_UI.titleBarHeight},
    sidebarColor: ${JSON.stringify(DESKTOP_UI.sidebarColor)},
    textColor: ${JSON.stringify(DESKTOP_UI.textColor)}
  }
  var SVG_NS = 'http://www.w3.org/2000/svg'
  var sharedSidebarWidth = null
  var widthFromOurGrip = false
  var settingsWidthOwner = null
  var dragging = false
  var chromeState = { nav: null, scheme: null, fingerprint: null }
  var appliedStoredWidth = null
  function isDark() {
    var scheme = ''
    try { scheme = getComputedStyle(document.body).colorScheme || '' } catch (e) {}
    if (/light/.test(scheme) && !/dark/.test(scheme)) return false
    return true
  }
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag)
    for (var k in attrs) el.setAttribute(k, attrs[k])
    return el
  }
  function clampSidebar(value) {
    return Math.min(CONFIG.sidebarMax, Math.max(CONFIG.sidebarMin, Math.round(value)))
  }
  /**
   * ONE sidebar width for both pages. The main sidebar is only forced while
   * the user drags OUR grip; otherwise the native sidebar owns its width and
   * we mirror it into the shared value (see observeNativeSidebar).
   */
  function applySharedSidebarWidth(value) {
    var width = clampSidebar(value)
    var nav = document.querySelector('nav.dcu-settings-nav')
    if (nav && nav.__dshShellUiW !== width) {
      nav.__dshShellUiW = width
      nav.style.setProperty('width', width + 'px', 'important')
      var page = nav.closest('.dcu-settings-page')
      if (page) page.style.gridTemplateColumns = width + 'px 1fr'
    }
    return width
  }
  /** The sidebar is .dcu-root with width:100%, so its real width comes from
   *  the app's own grid column definition ("260px 1140px 0px"). Writing a
   *  width on the aside detaches it from that layout and locks the native grip
   *  — the reported "sidebar can't be resized" bug. Drive the grid column. */
  function setSidebarWidth(width) {
    // Route the completed gesture through the native owner, including its
    // internal remembered width. Writing the grid alone gets reverted by React.
    var handle = document.querySelector('[data-side="sidebar"]')
    var aside = document.querySelector('aside.dcu-root')
    if (!handle || !aside || aside.getBoundingClientRect().width < 120) return
    var frame = handle.closest('[class*="_frame"]')
    // The native drag owner starts from its grid track, not a potentially
    // interpolated bounding box measured during a layout transition.
    var track = frame?.style.gridTemplateColumns.match(/^([0-9.]+)px(?: |$)/)
    var current = track ? Number(track[1]) : aside.getBoundingClientRect().width
    var delta = clampSidebar(width) - current
    if (Math.abs(delta) < 1) return
    var x = handle.getBoundingClientRect().left
    var y = handle.getBoundingClientRect().top + 10
    for (var kind of ['pointerdown', 'pointermove', 'pointerup']) {
      handle.dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerId: 700001,
        pointerType: 'mouse', button: 0, buttons: kind === 'pointerup' ? 0 : 1,
        clientX: kind === 'pointerdown' ? x : x + delta, clientY: y }))
    }
  }
  /** Mirror the native main-sidebar resize into the shared width (with a
   *  dead zone so our own writes can never ping-pong). */
  function observeNativeSidebar() {
    var aside = document.querySelector('aside')
    if (!aside || aside.hasAttribute('data-dsh-shell-ui-observed')) return
    aside.setAttribute('data-dsh-shell-ui-observed', '')
    if (typeof ResizeObserver !== 'function') return
    var observer = new ResizeObserver(function () {
      if (widthFromOurGrip || dragging) return
      // A settings gesture owns this page's width until it closes. Native
      // ResizeObserver echoes (old/intermediate widths) must not overwrite it.
      if (settingsWidthOwner?.isConnected && document.querySelector('nav.dcu-settings-nav') === settingsWidthOwner) return
      var w = Math.round(aside.getBoundingClientRect().width)
      if (w < 120) return
      if (sharedSidebarWidth !== null && Math.abs(w - sharedSidebarWidth) <= 2) return
      sharedSidebarWidth = clampSidebar(w)
      applySharedSidebarWidth(sharedSidebarWidth)
      positionGrip(sharedSidebarWidth)
    })
    observer.observe(aside)
  }
  function restoreTitleBar() {
    var drag = document.querySelector('.dshDesktopTitlebarDrag')
    if (!drag) return
    var row = drag.parentElement
    // Settings isolates body siblings. The existing desktop toolbar is an
    // intentional exception, not a second imitation titlebar.
    row.removeAttribute('inert')
    var controls = document.querySelector('.dshDesktopTitlebarControls')
    var els = [row, drag, controls]
    for (var i = 0; i < els.length; i++) {
      if (els[i]) els[i].style.setProperty('visibility', 'visible', 'important')
    }
    var buttons = document.querySelectorAll('.dshDesktopTitlebarControls button, .dshDesktopTitlebarDrag button, .dshDesktopTitlebarNav')
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j]
      // These keep the app's own corner radius: an earlier revision forced
      // 999px here, which is exactly the "pill" look that was reported.
      if (btn.style && btn.style.getPropertyValue('border-radius')) btn.style.removeProperty('border-radius')
      if (btn.hasAttribute('data-dsh-shell-ui-tb')) continue
      btn.setAttribute('data-dsh-shell-ui-tb', '')
      btn.style.setProperty('visibility', 'visible', 'important')
      // The app hides the glyphs inside the shared titlebar buttons; the
      // buttons themselves were already visible, so the icons vanished.
      var glyphs = btn.querySelectorAll('svg, svg *')
      for (var g = 0; g < glyphs.length; g++) {
        glyphs[g].style.setProperty('visibility', 'visible', 'important')
      }
    }
  }
  /** Settings nav surface + text must match the main sidebar.
   *  Runs only when the nav element or its content actually changed — the
   *  earlier version walked every leaf on every pass and caused drag lag. */
  function syncSettingsChrome() {
    var nav = document.querySelector('nav.dcu-settings-nav')
    if (!nav) { chromeState.nav = null; return }
    var dark = isDark()
    var fingerprint = nav.childElementCount + ':' + (nav.textContent || '').length
    if (chromeState.nav === nav && chromeState.scheme === dark && chromeState.fingerprint === fingerprint) return
    chromeState.nav = nav
    chromeState.scheme = dark
    chromeState.fingerprint = fingerprint
    var fg = dark ? CONFIG.textColor.dark : CONFIG.textColor.light
    // CSS inherits semantic text colours without overwriting disabled leaves.
    var trigger = document.querySelector('.dcu-settings-trigger, .dcu-settings-trigger-content')
    if (trigger) trigger.style.setProperty('color', fg, 'important')
  }
  /** The settings entry in the MAIN sidebar must not read as disabled. It was
   *  handled inside syncSettingsChrome(), which only runs while the settings
   *  page is open — so the main page kept the dim 0.76 colour. */
  var triggerState = { el: null, scheme: null }
  function syncSettingsTrigger() {
    var inner = document.querySelector('.dcu-settings-trigger-content')
    var btn = document.querySelector('.dcu-settings-trigger')
    if (!btn && !inner) { triggerState.el = null; return }
    var dark = isDark()
    var anchor = inner || btn
    if (triggerState.el === anchor && triggerState.scheme === dark) return
    triggerState.el = anchor
    triggerState.scheme = dark
    var fg = dark ? CONFIG.textColor.dark : CONFIG.textColor.light
    if (btn) btn.style.setProperty('color', fg, 'important')
    if (inner) inner.style.setProperty('color', fg, 'important')
    var parts = anchor.querySelectorAll('span, svg, path')
    for (var i = 0; i < parts.length; i++) parts[i].style.setProperty('color', fg, 'important')
  }
  /** Restore the main sidebar's native surface. Earlier revisions painted it
   *  an opaque colour, which destroyed the window's acrylic translucency and
   *  made the two sidebars look different; the sidebar is transparent by
   *  design, so we only strip the overrides we previously wrote. */
  var asideState = { el: null }
  function restoreMainSidebarSurface() {
    var aside = document.querySelector('aside')
    if (!aside || asideState.el === aside) return
    asideState.el = aside
    if (aside.style.getPropertyValue('background-color')) aside.style.removeProperty('background-color')
    if (aside.style.getPropertyValue('backdrop-filter')) aside.style.removeProperty('backdrop-filter')
  }
  /** Round the main content panel's top-left corner. The composer seat is
   *  absent on the welcome view, so fall back to the content column. */
  function markChatRoot() {
    if (document.querySelector('[data-dsh-shell-ui-chat-root]')) return
    var target = null
    var seat = findComposerSeat()
    if (seat) {
      var n = seat.parentElement
      while (n && n !== document.body) {
        if (/_root/.test(String(n.className))) target = n
        n = n.parentElement
      }
    }
    if (!target) {
      var col = document.querySelector('[class*="_centerCol"]')
      if (col) {
        var kids = col.querySelectorAll('*')
        for (var i = 0; i < kids.length; i++) {
          var s = getComputedStyle(kids[i])
          var r = kids[i].getBoundingClientRect()
          if (r.width > 400 && r.height > 200 && s.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(s.backgroundColor)) {
            target = kids[i]
            break
          }
        }
        if (!target) target = col
      }
    }
    if (target) target.setAttribute('data-dsh-shell-ui-chat-root', '')
  }
  var NAV_ICONS = {
    'Agent 预设': ['M12 8V4H8', 'M4 8h16v12H4z', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
    '记忆系统': ['M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z', 'M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z'],
    '表情包': ['M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z', 'M15 3v6h6', 'M9.5 17c.667-.5 2.5-1.5 5-1'],
    'Signal 用量': ['M12 20V10', 'M18 20V4', 'M6 20v-4'],
    '语音输入': ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
    '文件提及': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
    '通知': ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']
  }
  var BOX_ICON_PREFIX = 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0'
  var CODEX_FOLDER_D = 'M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756ZM13 9.4837L13.65 9.4837L13.65 3.53962L13 3.53962L12.35 3.53962L12.35 9.4837L13 9.4837ZM11.3264 1.86603L11.3264 1.21603L6.52313 1.21603L6.52313 1.86603L6.52313 2.51603L11.3264 2.51603L11.3264 1.86603ZM5.58054 1.34727L6.12968 0.999489L5.60495 0.170972L5.05582 0.518756L4.50669 0.86654L5.03141 1.69506L5.58054 1.34727ZM4.11323 1.23058e-13L4.11323 -0.65L1.67359 -0.65L1.67359 5.00699e-14L1.67359 0.65L4.11323 0.65L4.11323 1.23058e-13ZM0 1.67359L-0.65 1.67359L-0.65 9.4837L0 9.4837L0.65 9.4837L0.65 1.67359L0 1.67359ZM11.3264 11.1573L11.3264 10.5073L1.67359 10.5073L1.67359 11.1573L1.67359 11.8073L11.3264 11.8073L11.3264 11.1573ZM0 9.4837L-0.65 9.4837C-0.65 10.767 0.390308 11.8073 1.67359 11.8073L1.67359 11.1573L1.67359 10.5073C1.10828 10.5073 0.65 10.049 0.65 9.4837L0 9.4837ZM1.67359 5.00699e-14L1.67359 -0.65C0.390307 -0.65 -0.65 0.390309 -0.65 1.67359L0 1.67359L0.65 1.67359C0.65 1.10828 1.10828 0.65 1.67359 0.65L1.67359 5.00699e-14ZM5.05582 0.518756L5.60495 0.170972C5.28121 -0.340193 4.71829 -0.65 4.11323 -0.65L4.11323 1.23058e-13L4.11323 0.65C4.27282 0.65 4.4213 0.731715 4.50669 0.86654L5.05582 0.518756ZM6.52313 1.86603L6.52313 1.21603C6.36354 1.21603 6.21507 1.13431 6.12968 0.999489L5.58054 1.34727L5.03141 1.69506C5.35515 2.20622 5.91808 2.51603 6.52313 2.51603L6.52313 1.86603ZM13 3.53962L13.65 3.53962C13.65 2.25634 12.6097 1.21603 11.3264 1.21603L11.3264 1.86603L11.3264 2.51603C11.8917 2.51603 12.35 2.97431 12.35 3.53962L13 3.53962ZM13 9.4837L12.35 9.4837C12.35 10.049 11.8917 10.5073 11.3264 10.5073L11.3264 11.1573L11.3264 11.8073C12.6097 11.8073 13.65 10.767 13.65 9.4837L13 9.4837Z'
  var SQUIRCLE_LOADER_PREFIX = 'M2.871 13.1286'
  var cachedSeat = null
  function findComposerSeat() {
    if (cachedSeat && cachedSeat.isConnected) return cachedSeat
    var editable = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
    if (!editable) return null
    var node = editable.parentElement
    var seat = null
    while (node && node !== document.body) {
      var r = node.getBoundingClientRect()
      if (r.width > 300 && r.height > 60 && r.height < 220) seat = node
      node = node.parentElement
    }
    cachedSeat = seat
    return seat
  }
  function positionGrip(width) {
    var handle = document.querySelector('[data-dsh-shell-ui-resize]')
    if (!handle) return null
    // Keep the hot zone fully inside the nav: it used to straddle the nav/main
    // boundary, where the main panel captured the pointer and the drag never
    // started. The zone is pointer-transparent; the drag is driven by the
    // global listener below.
    handle.style.left = Math.max(0, Math.round(width) - 8) + 'px'
    return handle
  }
  function startSidebarDrag(ev, nav) {
    settingsWidthOwner = nav
    dragging = true
    widthFromOurGrip = true
    // Keep the cursor a resize cursor for the whole gesture: with the global
    // drag the pointer hovers other elements whose cursor would otherwise win.
    document.body.classList.add('dsh-shell-ui-dragging')
    var startX = ev.clientX
    var startW = nav.getBoundingClientRect().width
    var move = function (e2) {
      var target = clampSidebar(startW + (e2.clientX - startX))
      sharedSidebarWidth = target
      applySharedSidebarWidth(target)
      positionGrip(target)
    }
    var up = function () {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('dsh-shell-ui-dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
      setSidebarWidth(sharedSidebarWidth)
      widthFromOurGrip = false
      schedule()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
  }
  function ensureGrip() {
    var nav = document.querySelector('nav.dcu-settings-nav')
    var handle = document.querySelector('[data-dsh-shell-ui-resize]')
    // The grip belongs to the settings page only: hiding it outside keeps the
    // main sidebar free of the stray line that used to stay behind.
    if (!nav) {
      if (handle) handle.style.display = 'none'
      return null
    }
    if (!handle) {
      handle = document.createElement('div')
      handle.setAttribute('data-dsh-shell-ui-resize', '')
      // pointer-events stays ON so hovering the edge shows the resize cursor
      // immediately (it sits fully inside the nav, so the main panel cannot
      // steal the press; the global listener below drives the actual drag).
      handle.style.cssText = 'top:' + CONFIG.titleBarHeight + 'px;height:calc(100vh - ' + CONFIG.titleBarHeight + 'px);'
      nav.appendChild(handle)
    }
    if (handle.parentElement !== nav) nav.appendChild(handle)
    handle.removeAttribute('inert')
    handle.style.display = 'block'
    return positionGrip(sharedSidebarWidth || CONFIG.sidebarWidth)
  }
  /** Query only the shell containers instead of the whole document: scanning
   *  every SVG path in a long transcript on each pass was a major cost. */
  function scopedQuery(selector) {
    var containers = ['aside', 'nav.dcu-settings-nav', 'header']
    var out = []
    for (var i = 0; i < containers.length; i++) {
      var c = document.querySelector(containers[i])
      if (!c) continue
      var found = c.querySelectorAll(selector)
      for (var j = 0; j < found.length; j++) out.push(found[j])
    }
    return out
  }
  function patch() {
    try {
      window.__dshShellUiPatchCount = (window.__dshShellUiPatchCount || 0) + 1
      // Page ownership ends when its DOM is removed. These document-lifetime
      // caches must not retain the previous settings tree after navigation.
      if (chromeState.nav && !chromeState.nav.isConnected) {
        chromeState.nav = null
        chromeState.fingerprint = null
      }
      if (settingsWidthOwner && !settingsWidthOwner.isConnected) settingsWidthOwner = null
      observeNativeSidebar()
      ensureGrip()
      var settingsNav = document.querySelector('nav.dcu-settings-nav')
      if (settingsNav) {
        settingsNav.style.position = 'relative'
        applySharedSidebarWidth(sharedSidebarWidth || CONFIG.sidebarWidth)
        // Commit to the native owner only when a user gesture finishes.
        syncSettingsChrome()
      }
      var settingsOpen = document.body.classList.contains('dsh-signal-settings-open') || Boolean(settingsNav)
      if (settingsOpen) restoreTitleBar()
      syncSettingsTrigger()
      restoreMainSidebarSurface()
      // Undo the legacy mistake from earlier builds: an inline !important
      // width on the aside detaches it from the grid and freezes resizing.
      var asideEl = document.querySelector('aside')
      if (asideEl && asideEl.style.getPropertyPriority('width') === 'important') asideEl.style.removeProperty('width')
      var seat = findComposerSeat()
      if (seat && !seat.hasAttribute('data-dsh-shell-ui-composer')) {
        seat.setAttribute('data-dsh-shell-ui-composer', '')
      }
      markChatRoot()
      var panelSvg = document.querySelector('button[aria-label="展开底部面板"] svg')
      if (panelSvg && !panelSvg.hasAttribute('data-dsh-shell-ui-filled')) {
        var rightBtn = null
        var buttons = document.querySelectorAll('button')
        for (var bi = 0; bi < buttons.length; bi++) {
          if ((buttons[bi].getAttribute('aria-label') || '').indexOf('右侧边栏') !== -1) { rightBtn = buttons[bi]; break }
        }
        var rightPath = rightBtn ? rightBtn.querySelector('svg path') : null
        if (rightPath && rightPath.getAttribute('d')) {
          panelSvg.setAttribute('data-dsh-shell-ui-filled', '')
          while (panelSvg.firstChild) panelSvg.removeChild(panelSvg.firstChild)
          panelSvg.appendChild(svgEl('rect', { x: 1, y: 2, width: 14, height: 12, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }))
          panelSvg.appendChild(svgEl('path', { d: 'M1 10h14', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }))
        }
      }
      // Leave project folder paths and expanded/selected state to DSH.
      var nav = document.querySelector('nav.dcu-settings-nav')
      if (nav) {
        var items = nav.querySelectorAll('button')
        for (var ii = 0; ii < items.length; ii++) {
          var label = (items[ii].textContent || '').trim()
          var iconPaths = NAV_ICONS[label]
          if (!iconPaths) continue
          var isvg = items[ii].querySelector('svg')
          var firstPath = isvg ? isvg.querySelector('path') : null
          if (!isvg || !firstPath) continue
          if ((firstPath.getAttribute('d') || '').indexOf(BOX_ICON_PREFIX) !== 0) continue
          while (isvg.firstChild) isvg.removeChild(isvg.firstChild)
          for (var ki = 0; ki < iconPaths.length; ki++) isvg.appendChild(svgEl('path', { d: iconPaths[ki] }))
        }
      }
      var allPaths = scopedQuery('svg path')
      for (var li = 0; li < allPaths.length; li++) {
        var ld = allPaths[li].getAttribute('d') || ''
        if (ld.indexOf(SQUIRCLE_LOADER_PREFIX) === 0) {
          var lsvg = allPaths[li].ownerSVGElement
          if (lsvg && !lsvg.hasAttribute('data-dsh-shell-ui-circle')) {
            lsvg.setAttribute('data-dsh-shell-ui-circle', '')
            while (lsvg.firstChild) lsvg.removeChild(lsvg.firstChild)
            lsvg.appendChild(svgEl('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-dasharray': '33 8', 'stroke-linecap': 'round', transform: 'rotate(-45 8 8)' }))
          }
        }
      }
    } catch (err) { /* never break the host renderer */ }
  }
  /** rAF-throttled, paused while the user drags — the previous per-mutation
   *  microtask pass ran the whole patch on every DOM change and was the main
   *  cause of the sidebar lag. */
  var scheduled = false
  function schedule() {
    if (scheduled || dragging) return
    scheduled = true
    var run = function () { scheduled = false; patch() }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }
  function start() {
    patch()
    var observer = new MutationObserver(schedule)
    // Watch style attributes too: the app rewrites the frame grid behind our
    // back after a resize, and without this the correction pass never fires.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'inert'] })
    window.addEventListener('pointerup', function () { if (!dragging) schedule() })
    // Global press router, so nothing can swallow the gesture:
    //  - settings page: pressing within 8px of the nav's right edge drags it;
    //  - main page: pressing within 12px of the sidebar's right edge releases
    //    our width override, handing the drag straight back to the app.
    document.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      var nav = document.querySelector('nav.dcu-settings-nav')
      if (nav) {
        var navRight = nav.getBoundingClientRect().right
        if (Math.abs(ev.clientX - navRight) <= 8) {
          ev.preventDefault()
          startSidebarDrag(ev, nav)
          return
        }
      }
      var aside = document.querySelector('aside')
      if (!aside) return
      var edge = aside.getBoundingClientRect().right
      if (Math.abs(ev.clientX - edge) <= 12) {
        // The native grip already owns the drag here; nothing to release.
      }
    }, true)
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
`

let installedWindows = new WeakSet()

/** Install the shell UI overrides into a workspace window's webContents. */
export function installShellUiOverrides(window) {
  if (!window || installedWindows.has(window)) return
  installedWindows.add(window)
  const css = readFileSync(CSS_PATH, 'utf8')
  const script = SHELL_UI_JS + '\n;window.__dshShellUiSetCss(' + JSON.stringify(css) + ')'
  const apply = async () => {
    const wc = window.webContents
    if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') return
    try {
      await wc.executeJavaScript(script, true)
    } catch { /* window navigated away mid-injection */ }
  }
  window.webContents?.on?.('dom-ready', apply)
  window.webContents?.on?.('did-finish-load', apply)
}
