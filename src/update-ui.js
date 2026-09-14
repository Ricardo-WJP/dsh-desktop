const CSS = `
.dshDualUpdateRow{display:flex!important;align-items:center;gap:4px;min-width:0}.dshDualUpdateRow .dcu-settings-trigger{flex:1 1 auto;min-width:0;width:auto!important}
.dshDualUpdateEntry{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:32px;height:32px;flex:0 0 32px;margin:0;padding:0;border:0;border-radius:50%;corner-shape:superellipse(1.5);color:var(--dsw-alias-state-business-primary,#679efe);cursor:pointer;background:transparent}
.dshDualUpdateRow button.dshDualUpdateEntry{--dsh-update-size:32px;box-sizing:border-box!important;width:var(--dsh-update-size)!important;min-width:var(--dsh-update-size)!important;max-width:var(--dsh-update-size)!important;height:var(--dsh-update-size)!important;min-height:var(--dsh-update-size)!important;max-height:var(--dsh-update-size)!important;flex:0 0 var(--dsh-update-size)!important;padding:0!important;gap:0!important;align-self:center!important;align-items:center!important;justify-content:center!important;line-height:0!important}
.dshDualUpdateRow button.dshDualUpdateEntry svg{flex:none!important;margin:0!important;padding:0!important}
.dcu-root.dcu-compact .dshDualUpdateRow button.dshDualUpdateEntry{--dsh-update-size:24px}
.dshDualUpdateEntry:hover{filter:brightness(1.08)}.dshDualUpdateEntry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:1px}.dshDualUpdateEntry svg{width:18px;height:18px;display:block}
.dcu-root .dshDualUpdateRow button.dshDualUpdateEntry{background:var(--dsh-update-fill,#416ee6)!important;color:#fff!important}.dshDualUpdateEntry[data-kind=desktop]{--dsh-update-fill:#7953c5}.dshDualUpdateEntry[data-kind=both]{--dsh-update-fill:linear-gradient(100deg,#416ee6,#7953c5)}
.dcu-root.dcu-compact .dcu-settings-seat.dshDualUpdateRow{width:48px!important;max-width:48px!important;gap:0;margin-inline:auto}.dcu-root.dcu-compact .dshDualUpdateRow .dcu-settings-trigger{width:24px!important;min-width:24px!important;flex:0 0 24px;padding-inline:0!important}.dcu-root.dcu-compact .dshDualUpdateEntry{width:24px;height:28px;flex-basis:24px}
.dshDualUpdateDialog{box-sizing:border-box;width:min(580px,calc(100vw - 32px));max-height:calc(100vh - 60px);overflow:auto;padding:20px;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:20px;color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-1,#242424);font:14px/1.5 var(--dsw-font-family,system-ui)}
.dshDualUpdateDialog::backdrop{background:#0006}.dshDualUpdateCards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
.dshDualUpdateCard{min-width:0;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:14px;padding:12px}.dshDualUpdateCard label{display:flex;gap:8px;align-items:center;font-weight:600}.dshDualUpdateCard p{margin:8px 0;overflow-wrap:anywhere}.dshDualUpdateCard progress{width:100%;accent-color:#416ee6}
.dshDualUpdateDialog button{font:inherit;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#666);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2,#333);color:inherit;cursor:pointer}.dshDualUpdateDialog button:disabled{opacity:.5;cursor:default}.dshDualUpdateActions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.dshDualUpdateError{color:var(--dsw-alias-state-danger-primary,#f28b82)}
@media(max-width:480px){.dshDualUpdateCards{grid-template-columns:1fr}}
`
export function updateUiScript() {
  return `(${mountUpdateUi.toString()})(${JSON.stringify(CSS)})`
}
function mountUpdateUi(css) {
  const bridge = window.dshDesktop
  if (!bridge?.getUpdates || window.__dshDualUpdates) return
  window.__dshDualUpdates = true
  const style = document.createElement('style'); style.textContent = css; document.head.append(style)
  const entry = document.createElement('button'); entry.className = 'dshDualUpdateEntry'
  entry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="update-a" d="M12 4v11m-4-4 4 4 4-4"/><path class="update-b" d="M4 16v4h16v-4"/></svg>'
  let entryRow
  const dialog = document.createElement('dialog'); dialog.className = 'dshDualUpdateDialog'; dialog.setAttribute('aria-label', '选择更新项目'); document.body.append(dialog)
  let state = { dsh: {}, desktop: {} }, selected = new Set(), selectionTouched = false, checking = false, submitting = false, feedback = '', last = ''
  const labels = { idle: '尚未检查', checking: '正在检查', current: '已是最新版本', available: '发现新版本', error: '操作失败，可重试', downloading: '正在下载', downloaded: '下载完成', opening: '安装程序已启动', updating: '正在验证并更新 DSH' }
  const reasons = { 'unknown-flavor-cannot-update': '此旧安装版未标记发行类型，请从发布页选择；新版构建将明确标记 Suite。', 'dev-build-cannot-update': '开发环境只检查版本，不执行安装。', 'installer-asset-invalid': '当前平台安装包或完整性信息无效，不能安装。', 'release-source-not-configured': '尚未配置桌面发行源。', 'release-check-failed': '检查失败，请稍后重试。', 'download-or-open-failed': '下载或启动安装包失败，重新检查后可重试。' }
  function mountEntry() {
    const d = state.dsh?.hasUpdate, a = state.desktop?.hasUpdate
    if (!d && !a) { entry.remove(); entryRow?.classList.remove('dshDualUpdateRow'); entryRow = undefined; return }
    const setting = document.querySelector('.dcu-settings-seat') || document.querySelector('.dcu-settings-trigger')
    if (!setting?.parentElement) return
    const row = setting.classList.contains('dcu-settings-seat') ? setting : setting.parentElement
    if (entryRow !== row) entryRow?.classList.remove('dshDualUpdateRow')
    entryRow = row
    if (!row.classList.contains('dshDualUpdateRow')) row.classList.add('dshDualUpdateRow')
    if (entry.parentElement !== row) row.append(entry)
    const kind = d && a ? 'both' : d ? 'dsh' : 'desktop'
    if (entry.dataset.kind !== kind) entry.dataset.kind = kind
    entry.title = `DSH ${state.dsh?.targetVersion || '无更新'}；桌面端 ${state.desktop?.targetVersion || '无更新'}`
    entry.setAttribute('aria-label', `更新：${entry.title}`)
  }
  function button(text, fn, disabled) { const b = document.createElement('button'); b.textContent = text; b.disabled = Boolean(disabled); b.onclick = fn; return b }
  function render() {
    mountEntry(); if (!dialog.open) return
    dialog.replaceChildren()
    const title = document.createElement('strong'); title.textContent = '选择更新项目'; dialog.append(title)
    const cards = document.createElement('div'); cards.className = 'dshDualUpdateCards'
    for (const [kind, name] of [['dsh', 'DSH 运行时更新'], ['desktop', '桌面端更新']]) {
      const item = state[kind] || {}, card = document.createElement('section'); card.className = 'dshDualUpdateCard'
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'
      input.checked = selected.has(kind); input.disabled = !item.canUpdate || state.busy || submitting
      input.onchange = () => { selectionTouched = true; input.checked ? selected.add(kind) : selected.delete(kind); render() }
      label.append(input, name); card.append(label)
      for (const text of [`当前：${item.currentVersion || '待确认'}`, `目标：${item.targetVersion || '暂无'}`, labels[item.state] || '暂不可用', item.reason === 'busy-startup' ? '等待当前启动或更新操作结束后重试。' : reasons[item.reason] || item.error || item.reason]) if (text) { const p = document.createElement('p'); p.textContent = text; if(item.error && text === (reasons[item.reason] || item.error))p.className='dshDualUpdateError'; card.append(p) }
      if (item.state === 'downloading') { const p = document.createElement('progress'); p.max = 100; p.value = item.progress || 0; p.setAttribute('aria-label','下载进度'); card.append(p) }
      card.append(button(item.hasUpdate && !item.canUpdate ? '前往下载' : '查看更新内容', () => { void bridge.openUpdateLink(kind) }, !item.releaseNotesUrl))
      cards.append(card)
    }
    dialog.append(cards)
    if (feedback) { const p = document.createElement('p'); p.textContent = feedback; p.setAttribute('role', 'status'); dialog.append(p) }
    const actions = document.createElement('div'); actions.className = 'dshDualUpdateActions'
    actions.append(button('检查更新', async () => { if(checking)return;checking=true;render();try{accept(await bridge.checkUpdates())}catch(e){feedback=String(e.message)}finally{checking=false;render()} }, checking || state.busy),
      button(state.busy ? '更新进行中…' : '更新所选项', async () => {
        if (submitting || state.busy) return
        submitting = true; feedback = ''; render()
        try { const r = await bridge.executeUpdates({ dsh: selected.has('dsh'), desktop: selected.has('desktop'), dshVersion: state.dsh.targetVersion, desktopVersion: state.desktop.targetVersion }); if(r?.ok!==true)feedback=r?.error||'更新请求未被接受' }
        catch(e){feedback=String(e.message)} finally{submitting=false;accept(await bridge.getUpdates());render()}
      }, submitting || state.busy || ![...selected].some(k=>state[k]?.canUpdate)),
      button('关闭', () => dialog.close(), false))
    dialog.append(actions)
  }
  function accept(value) { if(value?.ok===false){feedback=value.error||'检查失败';render();return} if(!value?.dsh||!value?.desktop)return;const text=JSON.stringify(value);if(text===last)return;last=text;state=value;for(const key of [...selected])if(!state[key]?.canUpdate&&!state.busy&&state[key]?.state!=='checking')selected.delete(key);if(!state.busy&&!selectionTouched)selected=new Set(state.desktop?.canUpdate?['desktop']:state.dsh?.canUpdate?['dsh']:[]);if(state.busy&&!dialog.open){selected=new Set(['dsh','desktop'].filter(k=>state.selection?.[k]));dialog.removeAttribute('inert');dialog.showModal()}render() }
  function open() { selectionTouched=false;selected = new Set(state.desktop?.canUpdate ? ['desktop'] : state.dsh?.canUpdate ? ['dsh'] : []); feedback='';dialog.removeAttribute('inert');if(!dialog.open)dialog.showModal();render() }
  entry.onclick = open
  window.addEventListener('dsh-desktop:open-updates', open)
  bridge.onUpdatesChanged(accept)
  new MutationObserver(records => {
    // Text-only mutations cannot introduce a settings seat. Element changes
    // retain the original reconciliation path (including new plugin shells).
    if (!state.dsh?.hasUpdate && !state.desktop?.hasUpdate) return
    if (entryRow?.isConnected && entry.parentElement === entryRow && entryRow.classList.contains('dshDualUpdateRow')) {
      let addedElement = false
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) { addedElement = true; break }
        }
        if (addedElement) break
      }
      if (!addedElement) return
    }
    mountEntry()
  }).observe(document.body,{childList:true,subtree:true})
  void bridge.getUpdates().then(accept).catch(e=>{feedback=String(e.message)})
}
const installed = new WeakSet()
export function installUpdateUi(window) {
  if (!window || installed.has(window)) return
  installed.add(window)
  const apply = () => { const wc = window.webContents; if (wc?.isDestroyed?.() || typeof wc?.executeJavaScript !== 'function') return; void wc.executeJavaScript(updateUiScript()).catch(() => {}) }
  window.webContents?.on?.('dom-ready', apply)
  window.webContents?.on?.('did-finish-load', apply)
}
