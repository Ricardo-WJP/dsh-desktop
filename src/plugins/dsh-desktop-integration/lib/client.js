window.__ModuleLoader__.load({
  id: '@dsh-desktop/integration',
  factory: (require) => {
    const module = { exports: {} }
    const bridge = globalThis.dshDesktop

    const NS = 'dsh-desktop'
    const STYLE_ID = '@dsh-desktop/integration/actions'
    const WORKSPACE_ACTIONS_MARKER = 'dshDesktopWorkspaceActions'
    const UPDATE_BUTTON_MARKER = 'dshDesktopUpdateButton'
    const NOTIFICATION_SETTINGS_KEY = 'dsh-notification.v4'
    const NOTIFICATION_COMPATIBLE_REVISION = '75143eb7f8d8'
    const inject = ['sessions', 'workspaces', 'locale', 'theme']
    const dictionaries = {
      zh: {
        'open.editor': '用编辑器打开',
        'open.fileManager': '打开文件夹',
      },
      en: {
        'open.editor': 'Open in Editor',
        'open.fileManager': 'Open Folder',
      },
    }

    function iconElement(kind) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('fill', 'currentColor')
      if (kind === 'editor') {
        path.setAttribute('fill-rule', 'evenodd')
        path.setAttribute('d', 'M13.25 1.2 7 7.05 3.5 4.35 1.5 6.15 4.25 8 1.5 9.85l2 1.8L7 8.95l6.25 5.85 1.25-.6V1.8l-1.25-.6Zm0 3v7.6L8.9 8l4.35-3.8Z')
      } else {
        path.setAttribute('d', 'M2.42 2.25h3.03c.45 0 .87.22 1.12.6l.48.72h6.53c.83 0 1.5.67 1.5 1.5v6.93c0 .97-.78 1.75-1.75 1.75H2.42A1.5 1.5 0 0 1 .92 12V3.75c0-.83.67-1.5 1.5-1.5Zm0 1.3a.2.2 0 0 0-.2.2V12c0 .25.2.45.45.45h10.66c.25 0 .45-.2.45-.45V5.07a.2.2 0 0 0-.2-.2H6.35L5.5 3.6a.12.12 0 0 0-.1-.05H2.42Z')
      }
      svg.append(path)
      return svg
    }

    async function requestNativeOpen(path, intent) {
      const result = await bridge.openPath(path, intent)
      if (result?.ok !== true) throw new Error(result?.error ?? 'Desktop path open failed')
    }

    function jsonResponse(status, body) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    function requestUrl(input) {
      const value = typeof input === 'string' || input instanceof URL
        ? input
        : input instanceof Request ? input.url : undefined
      if (value === undefined) return undefined
      try { return new URL(value, globalThis.location.href) } catch { return undefined }
    }

    async function requestJson(input, init) {
      if (typeof init?.body === 'string') return JSON.parse(init.body)
      if (input instanceof Request) return JSON.parse(await input.clone().text())
      throw new Error('The plugin market update request format is unsupported by this Desktop version')
    }

    function installManagedMarketUpdateBridge() {
      if (typeof globalThis.fetch !== 'function'
        || typeof bridge.installMarketPlugin !== 'function'
        || typeof bridge.updateMarketPlugin !== 'function'
        || typeof bridge.activateMarketUpdate !== 'function') return () => {}

      const originalFetch = globalThis.fetch
      if (originalFetch.dshDesktopManagedMarketUpdate === true) return () => {}
      let batchIntent = false
      let batch
      let batchPreparing
      let disposed = false
      const inFlight = new Map()
      let activationTimer
      let batchNotice
      const reportBatch = (names, phase) => {
        if (names.length < 2 || typeof document?.createElement !== 'function' || typeof document?.body?.append !== 'function') return
        if (!batchNotice?.isConnected) {
          batchNotice = document.createElement('div')
          batchNotice.setAttribute('data-dsh-plugin-update-feedback', '')
          batchNotice.setAttribute('role', 'status')
          batchNotice.setAttribute('aria-live', 'polite')
          document.body.append(batchNotice)
        }
        batchNotice.replaceChildren()
        const summary = document.createElement('span')
        summary.textContent = `批量更新 ${names.length} 个插件 · ${phase}`
        const details = document.createElement('details')
        const label = document.createElement('summary')
        label.textContent = '查看本批插件'
        const list = document.createElement('ul')
        list.style.cssText = 'max-height:180px;overflow:auto;margin:8px 0;padding-left:20px'
        for (const name of names) {
          const item = document.createElement('li')
          item.textContent = name
          list.append(item)
        }
        details.append(label, list)
        batchNotice.append(summary, details)
      }

      const reportActivationFailure = message => {
        console.warn('[dsh-desktop] Plugin activation failed.', message)
        if (typeof document?.createElement !== 'function' || !document.body?.append) return
        document.querySelector('[data-dsh-plugin-update-feedback]')?.remove()
        const notice = document.createElement('div')
        notice.dataset.dshPluginUpdateFeedback = 'true'
        notice.setAttribute('role', 'alert')
        const text = document.createElement('span')
        text.textContent = `插件更新尚未完成：${message}。当前版本已保留。`
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.textContent = '重试启用'
        retry.addEventListener('click', () => { notice.remove(); scheduleActivation(0) })
        const close = document.createElement('button')
        close.type = 'button'
        close.textContent = '关闭'
        close.addEventListener('click', () => notice.remove())
        notice.append(text, retry, close)
        document.body.append(notice)
      }

      const scheduleActivation = delay => {
        globalThis.clearTimeout(activationTimer)
        activationTimer = globalThis.setTimeout(() => {
          if (disposed) return
          const activatingBatch = batch
          void bridge.activateMarketUpdate().then((activation) => {
            if (activation?.ok === true && batch === activatingBatch) batch = undefined
            if (activation?.ok !== true && !disposed) reportActivationFailure(activation?.error ?? '启用失败')
          }).catch((error) => { if (!disposed) reportActivationFailure(error.message) })
        }, delay)
      }

      const captureUpdateAll = event => {
        if (!(event.target instanceof Element)) return
        const button = event.target.closest('button')
        const label = normalizedLabel(button?.getAttribute?.('aria-label') || button?.textContent)
        if (button?.getAttribute?.('data-action') !== 'update-all' && !label.startsWith('全部更新') && !label.startsWith('updateall')) return
        if (batchPreparing || batch) return
        batchIntent = true
      }
      const canObserveDocument = typeof document === 'object' && typeof document.addEventListener === 'function'
      if (canObserveDocument) document.addEventListener('click', captureUpdateAll, true)

      const supportedOffer = (name, offered) => {
        if (offered?.updateAvailable !== true
          || !['npm', 'github'].includes(offered?.kind)
          || typeof offered?.latest !== 'string') return undefined
        return { name, kind: offered.kind, target: offered.latest }
      }

      const processMutation = async (input, init, managedInstall) => {
        try {
          const payload = await requestJson(input, init)
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid plugin market request')
          let result
          if (managedInstall) {
            if (typeof payload.url !== 'string') throw new Error('The plugin market install request is missing a source address')
            result = await bridge.installMarketPlugin({ url: payload.url })
            if (result?.ok !== true) throw new Error(result?.error ?? 'Desktop could not stage the plugin install')
          } else {
            if (typeof payload.name !== 'string') throw new Error('The plugin market update request is missing a plugin name')
            if (payload.restore === true) throw new Error('请在恢复页面选择已验证快照进行回退')
            // Publish the promise before the first async probe. Simultaneous
            // update rows then share a single transaction, including failure.
            if (batchPreparing) await batchPreparing
            if (batch?.names?.has(payload.name)) {
              result = batch.result
              batch.completed.add(payload.name)
            } else {
              const batchRequested = batchIntent
              batchIntent = false
              const prepare = async () => {
                const offeredResponse = await originalFetch.call(globalThis, '/dsh-market/updates?force=1', { cache: 'no-store' })
                if (!offeredResponse.ok) throw new Error(`Plugin market update probe failed with HTTP ${offeredResponse.status}`)
                const offeredBody = await offeredResponse.json()
                const selected = supportedOffer(payload.name, offeredBody?.updates?.[payload.name])
                if (selected === undefined) throw new Error(`The plugin market did not offer a supported update for ${payload.name}`)
                const updates = batchRequested
                  ? Object.entries(offeredBody?.updates ?? {}).map(([name, offered]) => supportedOffer(name, offered)).filter(Boolean)
                  : [selected]
                if (updates.length > 256) throw new Error('单次最多更新 256 个插件，请分批选择')
                reportBatch(updates.map(update => update.name), '正在安装并验证整批插件')
                const prepared = updates.length > 1
                  ? await bridge.updateMarketPlugin({ updates })
                  : await bridge.updateMarketPlugin(selected)
                if (prepared?.ok !== true) throw new Error(prepared?.error ?? 'Desktop could not stage the plugin update')
                reportBatch(updates.map(update => update.name), '准备完成，等待启用；尚未切换运行版本')
                if (updates.length > 1) batch = { names: new Set(updates.map(update => update.name)), completed: new Set([payload.name]), result: prepared }
                return prepared
              }
              if (batchRequested) {
                const pending = prepare()
                batchPreparing = pending
                try { result = await pending } finally { if (batchPreparing === pending) batchPreparing = undefined }
              } else result = await prepare()
            }
          }
          const batchComplete = batch !== undefined && batch.completed.size >= batch.names.size
          const batchSize = batch?.names?.size ?? 1
          if (batchComplete) batch = undefined
          scheduleActivation(batchComplete || batch === undefined ? 500 : 5_000)
          const skipped = result?.report?.skipped ?? []
          const skippedRow = skipped.find(item => item.name === payload.name)
          if (skippedRow) return jsonResponse(409, { ok: false, desktopManaged: true, error: skippedRow.reason, skipped })
          return jsonResponse(200, { ok: true, desktopManaged: true, restartRequired: true,
            candidateId: result?.report?.candidateId ?? null, batchSize, skipped })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn('[dsh-desktop] Plugin transaction failed.', error)
          if (batchNotice?.isConnected) batchNotice.textContent = `批量更新未完成：${message}。当前运行版本已保留。`
          return jsonResponse(409, { ok: false, desktopManaged: true, error: message })
        }
      }

      const managedFetch = async (input, init) => {
        const url = requestUrl(input)
        const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        const managedProbe = url?.origin === globalThis.location.origin && url.pathname === '/dsh-market/updates' && method === 'GET'
        const managedUpdate = url?.origin === globalThis.location.origin && url.pathname === '/dsh-market/update' && method === 'POST'
        const managedInstall = url?.origin === globalThis.location.origin && url.pathname === '/dsh-market/install' && method === 'POST'
        if (managedProbe) return originalFetch.call(globalThis, input, init)
        if (!managedUpdate && !managedInstall) {
          return originalFetch.call(globalThis, input, init)
        }

        let key
        try { key = JSON.stringify([managedInstall ? 'install' : 'update', await requestJson(input, init)]) } catch (error) {
          return jsonResponse(400, { ok: false, error: error.message })
        }
        if (inFlight.has(key)) return (await inFlight.get(key)).clone()
        const pending = processMutation(input, init, managedInstall)
        inFlight.set(key, pending)
        try { return (await pending).clone() } finally { if (inFlight.get(key) === pending) inFlight.delete(key) }
      }
      Object.defineProperty(managedFetch, 'dshDesktopManagedMarketUpdate', { value: true })
      Object.defineProperty(managedFetch, 'dshDesktopManagedMarketInstall', { value: true })
      Object.defineProperty(managedFetch, 'dshDesktopManagedMarketCompatibility', { value: true })
      globalThis.fetch = managedFetch

      return () => {
        disposed = true
        batchNotice?.remove()
        globalThis.clearTimeout(activationTimer)
        document.querySelector?.('[data-dsh-plugin-update-feedback]')?.remove()
        if (canObserveDocument) document.removeEventListener('click', captureUpdateAll, true)
        if (globalThis.fetch === managedFetch) globalThis.fetch = originalFetch
      }
    }

    function installNativeSettingsDocumentBridge() {
      if (typeof globalThis.fetch !== 'function' || typeof bridge.openSettingsDocument !== 'function') return () => {}
      const originalFetch = globalThis.fetch
      if (originalFetch.dshDesktopSettingsDocument === true) return () => {}

      const nativeFetch = async (input, init) => {
        const url = requestUrl(input)
        const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (url?.origin !== globalThis.location.origin || url.pathname !== '/api/settings.openDocument' || method !== 'POST') {
          return originalFetch.call(globalThis, input, init)
        }
        try {
          const result = await bridge.openSettingsDocument()
          if (result?.ok !== true) throw new Error(result?.error ?? 'Desktop could not open the Harness settings document')
          return jsonResponse(200, { result: { ok: true, value: { opened: true, desktopManaged: true } } })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn('[dsh-desktop] Native settings document open failed.', error)
          return jsonResponse(500, { result: { ok: false, error: { message } } })
        }
      }
      Object.defineProperty(nativeFetch, 'dshDesktopSettingsDocument', { value: true })
      globalThis.fetch = nativeFetch
      return () => {
        if (globalThis.fetch === nativeFetch) globalThis.fetch = originalFetch
      }
    }

    function installStyle() {
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = '@dsh-desktop/integration'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        // Scoped desktop refinements: keep modal and plugin content controls native.
        'html body[data-ds-dark-theme] .dcu-root{--dcu-sidebar-hover:#303030!important;--dcu-sidebar-active:#303030!important}',
        'html body[data-ds-light-theme] .dcu-root{--dcu-sidebar-hover:#e5e5e5!important;--dcu-sidebar-active:#e5e5e5!important}',
        'html body .dcu-menu>.dshDesktopCodexTaskboardExpanded>span:first-child{width:16px!important;height:16px!important;flex:0 0 16px!important;margin:0!important;display:grid!important;place-items:center!important}',
        '.dcu-wb-project:has(>.dcu-wb-project-head[aria-expanded="true"])>.dcu-wb-project-head>.dcu-wb-folder>svg,.dcu-wb-project:has(.dcu-wb-selected)>.dcu-wb-project-head>.dcu-wb-folder>svg{display:none!important}',
        '.dcu-wb-project:has(>.dcu-wb-project-head[aria-expanded="true"])>.dcu-wb-project-head>.dcu-wb-folder:before,.dcu-wb-project:has(.dcu-wb-selected)>.dcu-wb-project-head>.dcu-wb-folder:before{content:"";display:block;width:16px;height:16px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22black%22 stroke-width=%221.7%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M3 20h16a2 2 0 0 0 2-1.5l2-8.5H7l-3 10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h8a2 2 0 0 1 2 2v1%22/%3E%3C/svg%3E") center/contain no-repeat}',
        'html body .dcu-root:not(.dcu-compact)>.dcu-foot{padding-left:6px!important;padding-right:6px!important}',
        'html body .dcu-root:not(.dcu-compact) .dcu-settings-seat .VOzbGW_trigger{height:36px!important;padding:0 4px!important;font-size:14px!important;gap:8px!important}',
        'html body .dcu-root:not(.dcu-compact) .dcu-settings-seat .VOzbGW_trigger [data-slot="settings.trigger"]>svg{box-sizing:content-box!important;width:16px!important;height:16px!important;padding:0 2px!important;flex:0 0 16px!important}',
        'html body .dcu-root.dcu-compact .dcu-compact-shell,html body .dcu-root.dcu-compact .dcu-compact-nav{box-sizing:border-box!important;width:100%!important;padding-left:0!important;padding-right:0!important;align-items:center!important}',
        'html body .dcu-root.dcu-compact .dcu-compact-shell .dcu-icon{margin-left:auto!important;margin-right:auto!important}',
        'html body .dcu-root:not(.dcu-compact)>[data-dsh-mnemon-entry]{width:calc(100% - 12px)!important;margin:4px 6px!important;padding:0 4px!important;gap:8px!important;height:36px!important;min-height:36px!important;border-radius:8px!important;font-size:14px!important}',
        'html body .dcu-root:not(.dcu-compact)>[data-dsh-mnemon-entry]>span:first-child{width:20px!important;flex:0 0 20px!important;display:grid!important;place-items:center!important}',
        'html body .dcu-root.dcu-compact>.dcu-foot{padding-left:0!important;padding-right:0!important;display:flex!important;flex-direction:column!important;align-items:center!important}',
        'html body .dcu-root.dcu-compact .dcu-settings-seat,html body .dcu-root.dcu-compact .VOzbGW_triggerRow{width:36px!important;min-width:36px!important;max-width:36px!important;margin-left:auto!important;margin-right:auto!important;padding:0!important}',
        'html body .dcu-root.dcu-compact :is(.dcu-compact-shell .dcu-icon,[data-dsh-mnemon-entry],.dcu-settings-seat .VOzbGW_trigger){box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0!important;width:36px!important;min-width:36px!important;max-width:36px!important;height:36px!important;min-height:36px!important;padding:0!important;gap:0!important;border:0!important;border-radius:50%!important;corner-shape:superellipse(1.5)!important}',
        'html body .dcu-root.dcu-compact :is(.dcu-compact-shell .dcu-icon,[data-dsh-mnemon-entry],.dcu-settings-seat .VOzbGW_trigger) svg{display:block!important;width:16px!important;height:16px!important;flex:0 0 16px!important;margin:0!important}',
        'body[data-ds-dark-theme] .dcu-root .dcu-wb-project-head:is(:hover,.dcu-wb-menu-open){background:#303030!important}',
        '.dcu-settings-seat .VOzbGW_triggerRow{box-sizing:border-box!important;width:100%!important;max-width:100%!important}',
        '.dcu-settings-seat .VOzbGW_trigger{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important}',
        '.pI_x6G_sidebarCol{border-right:0!important}',
        /* Bound the decorative welcome backdrop, not the interactive scroll area. */
        '.wSkVaW_scrollBody .dsh-signal-field{max-width:100%!important;pointer-events:none}',
        '.pI_x6G_centerCol:has(.wSkVaW_root){border-left:0!important}',
        'html body header:has([data-dcu-inline-tabs]){border-bottom:1px solid var(--dsw-alias-border-l3)!important}',
        'html body [data-composer-card]{padding-top:10px!important;padding-bottom:0!important;min-height:120px!important}',
        '[data-composer-card]>.uV2eYG_scroll{flex:1 1 auto!important}',
        '[data-composer-card]>.uV2eYG_row{flex:0 0 auto!important;margin-top:auto!important;padding-bottom:8px!important}',
        'html body header [data-dcu-inline-tabs] [data-dcu-tab-slider]{height:22px!important;top:3px!important}',
        '.dcu-root .dcu-foot{padding:4px 8px 8px!important}',
        '.dcu-settings-seat .VOzbGW_triggerRow{height:36px!important;min-height:36px!important;margin:0!important}',
        '.dcu-settings-seat .VOzbGW_trigger{height:36px!important;min-height:36px!important;padding:0 8px!important;font-size:13px!important;border-radius:8px!important;gap:8px!important}',
        'body[data-ds-dark-theme] .dcu-root{--dcu-sidebar-primary:#f5f5f7!important;--dcu-sidebar-secondary:#f5f5f7!important;--dcu-sidebar-navigation:#f5f5f7!important;--dcu-sidebar-icon:#f5f5f7!important;--dcu-sidebar-active:#303030!important;color:#f5f5f7!important}',
        'body[data-ds-dark-theme] .dcu-root :is(.dcu-brand,.dcu-menu button,.dcu-wb-session,.dcu-wb-project-head,.dcu-wb-project-title,.dcu-wb-session-title,.VOzbGW_trigger,[data-dsh-mnemon-entry]){color:#f5f5f7!important}',
        'body[data-ds-dark-theme] .dcu-root .dcu-wb-selected{background:#303030!important}',
        '.pI_x6G_centerCol:has(.wSkVaW_root){background:var(--dsw-specific-sidebar-fill)!important}',
        '.pI_x6G_centerCol>.wSkVaW_root,.pI_x6G_centerCol>[data-slot="conversation"]>.wSkVaW_root{border-top-left-radius:20px!important;corner-shape:round!important;overflow:hidden!important}',
        'header [data-dcu-title-more]{box-sizing:border-box!important;width:28px!important;min-width:28px!important;height:28px!important;padding:0!important;border-radius:50%!important;corner-shape:superellipse(1.5)!important;flex:none!important}',
        'html body header [data-dcu-inline-tabs]{border-radius:12px!important;corner-shape:round!important}',
        'html body header [data-dcu-inline-tabs] [role="tab"]{border-radius:9px!important;corner-shape:round!important;transition:background-color 160ms ease,color 160ms ease!important}',
        'html body header [data-dcu-inline-tabs] [data-dcu-tab-slider]{display:block!important;left:-1px!important;top:3px!important;height:22px!important;border-radius:9px!important;corner-shape:round!important;opacity:1!important;background:var(--dsw-alias-state-business-primary)!important;box-shadow:none!important;filter:none!important;transition:transform 180ms ease,width 180ms ease!important}',
        'html body header [data-dcu-inline-tabs] [role="tab"][aria-selected="true"],html body header [data-dcu-inline-tabs] [role="tab"][data-state="active"]{background:transparent!important}',
        '[data-composer-card]{border-radius:24px!important;corner-shape:round!important;min-height:112px!important;padding-top:18px!important;padding-bottom:6px!important}',
        '[data-composer-card] :is(.uV2eYG_add,.uV2eYG_primary,.JObwrW_trigger,.meme-trigger,.stt-mic-btn,.dyn-opt-main,.dyn-opt-gear){border-radius:50%!important;corner-shape:round!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:none!important}',
        '[data-composer-card] :is(.meme-trigger,.stt-mic-btn,.dyn-opt-main,.dyn-opt-gear){box-sizing:border-box!important;width:28px!important;min-width:28px!important;height:28px!important;min-height:28px!important;padding:0!important;gap:0!important}',
        '[data-composer-card] .dyn-opt-main{font-size:0!important}',
        '[data-composer-card] :is(.Sh0Q9G_trigger,.aag-btn,.re-model-trigger,._7KE1Ra_trigger){border-radius:999px!important;corner-shape:round!important}',
        '.dshDesktopWorkspaceSeparator{height:1px;background:var(--dsw-alias-border-l3);margin:4px 8px}',
        '.dcu-root>[data-dsh-mnemon-entry]{flex:0 0 36px!important;min-height:36px!important;width:calc(100% - 16px)!important;margin:4px 8px!important;padding:0 8px!important;gap:8px!important;border-radius:8px!important;font:inherit!important;font-size:13px!important}',
        '.dcu-root>[data-dsh-mnemon-entry]>span:first-child{width:20px!important;flex:0 0 20px!important}',
        '.dcu-root>[data-dsh-mnemon-entry] svg{width:16px!important;height:16px!important}',
        '.dcu-root.dcu-compact>[data-dsh-mnemon-entry]{width:36px!important;height:36px!important;margin:4px auto!important;padding:0!important;justify-content:center!important}',
        '.dcu-root.dcu-compact>[data-dsh-mnemon-entry]>span:last-child{display:none!important}',
        '.dcu-root:has(>[data-dsh-mnemon-entry])>.dcu-foot{margin-top:0!important;padding-top:4px!important;padding-bottom:12px!important}',
        '[data-dsh-taskboard-entry]>span:first-child,[data-dsh-skill-explorer-entry]>span:first-child{display:grid!important;place-items:center!important;width:20px!important;height:20px!important;min-width:20px!important}',
        '[data-dsh-taskboard-entry]>span:first-child svg,[data-dsh-skill-explorer-entry]>span:first-child svg{display:block!important;width:16px!important;height:16px!important}',
        '.dcu-compact [data-dsh-taskboard-entry],.dcu-compact [data-dsh-skill-explorer-entry]{display:grid!important;place-items:center!important;width:36px!important;height:36px!important;min-height:36px!important;margin:0 auto 2px!important;padding:0!important;border-radius:8px!important}',
        'body[data-ds-dark-theme] .dcu-root{background:#1d1e20!important;--dcu-sidebar-primary:var(--dsw-alias-text-primary,#f5f5f7);--dcu-sidebar-secondary:var(--dsw-alias-text-secondary,#a3a3a8);--dcu-sidebar-tertiary:var(--dsw-alias-text-tertiary,#707075);--dcu-sidebar-navigation:var(--dsw-alias-text-secondary,#a3a3a8);--dcu-sidebar-icon:var(--dsw-alias-text-secondary,#a3a3a8);--dcu-sidebar-hover:#292a2d;--dcu-sidebar-active:#313236;--dcu-sidebar-border:var(--dsw-alias-border-l3,rgba(255,255,255,.08))}',
        'body[data-ds-light-theme] .dcu-root{background:#f1f2f4!important;--dcu-sidebar-hover:#e4e6e9;--dcu-sidebar-active:#dadde2;--dcu-sidebar-border:rgba(17,24,39,.09)}',
        '@media (prefers-color-scheme:light){body:not([data-ds-dark-theme]) .dcu-root{background:#f1f2f4!important;--dcu-sidebar-hover:#e4e6e9;--dcu-sidebar-active:#dadde2;--dcu-sidebar-border:rgba(17,24,39,.09)}}',
        'header:has([data-dcu-inline-tabs]){box-sizing:border-box!important;height:42px!important;min-height:42px!important;padding-top:6px!important;padding-bottom:6px!important;align-items:center!important}',
        'header:has([data-dcu-inline-tabs]) [class*="crumbs"],header:has([data-dcu-inline-tabs]) [class*="headerActions"],header:has([data-dcu-inline-tabs]) [class*="headerUtilities"],header:has([data-dcu-inline-tabs]) [data-dcu-inline-tabs]{align-self:center!important}',
        'header:has([data-dcu-inline-tabs]){display:flex!important;flex-wrap:nowrap!important;align-items:center!important;gap:10px!important}',
        'header:has([data-dcu-inline-tabs]) [class*="titleRow"],header:has([data-dcu-inline-tabs]) [class*="titleCluster"]{display:contents!important}',
        'header:has([data-dcu-inline-tabs]) [class*="crumbs"],header:has([data-dcu-inline-tabs]) [class*="headerActions"],header:has([data-dcu-inline-tabs]) [class*="headerUtilities"],header:has([data-dcu-inline-tabs]) [data-dcu-inline-tabs],header:has([data-dcu-inline-tabs]) [data-dcu-title-folder],header:has([data-dcu-inline-tabs]) [data-dcu-title-more],header:has([data-dcu-inline-tabs]) [data-dcu-session-log-download]{align-self:center!important;top:auto!important;bottom:auto!important;margin-top:0!important;margin-bottom:0!important;transform:none!important;translate:none!important}',
        '[data-dsh-desktop-folder-button]{box-sizing:border-box!important;display:inline-grid!important;place-items:center!important;width:28px!important;min-width:28px!important;height:28px!important;min-height:28px!important;margin:0!important;padding:0!important;border:0!important;corner-shape:superellipse(1.5)!important;border-radius:50%!important;line-height:0!important;background:transparent!important;color:var(--dsw-alias-label-secondary)!important}',
        '[data-dsh-desktop-folder-button]:hover{background:var(--dsw-alias-interactive-bg-hover)!important;color:var(--dsw-alias-label-primary)!important}',
        'header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tabs{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;gap:2px!important;width:max-content!important;max-width:100%!important;min-height:35px!important;margin-top:5px!important;padding:3px 5px!important;border:1px solid var(--dsw-alias-border-l2)!important;border-radius:14px!important;background:var(--dsw-alias-bg-layer-2)!important;box-shadow:none!important;filter:none!important}',
        'header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tab{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;height:26px!important;min-height:26px!important;min-width:48px!important;margin:0!important;padding:0 9px!important;border:0!important;border-radius:8px!important;color:var(--dsw-alias-label-secondary)!important;font-size:12px!important;font-weight:500!important;line-height:18px!important;white-space:nowrap!important;transition:background-color 140ms ease,color 140ms ease,box-shadow 140ms ease!important}',
        'header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tab:after{display:none!important}',
        'header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tab:focus,header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tab:focus-visible{outline:none!important;box-shadow:none!important}',
        'header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tab:hover:not(.wSkVaW_tabActive){color:var(--dsw-alias-label-primary)!important;background:var(--dsw-alias-interactive-bg-hover)!important}',
        'header:has(.wSkVaW_tabs:not([data-dcu-inline-tabs])) .wSkVaW_tabActive{color:var(--dsw-alias-label-primary)!important;background:var(--dsw-alias-state-business-primary)!important;box-shadow:none!important;filter:none!important}',
        'header [data-dcu-title-folder],[data-dsh-desktop-folder-button]{box-sizing:border-box!important;display:inline-grid!important;place-items:center!important;width:28px!important;min-width:28px!important;height:28px!important;min-height:28px!important;margin:0!important;padding:0!important;border:0!important;corner-shape:superellipse(1.5)!important;border-radius:50%!important;line-height:0!important;background:transparent!important;color:var(--dsw-alias-label-secondary)!important}',
        'header [data-dcu-title-folder]:hover,[data-dsh-desktop-folder-button]:hover{background:var(--dsw-alias-interactive-bg-hover)!important;color:var(--dsw-alias-label-primary)!important}',
        'header [data-dcu-inline-tabs]{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;gap:1px!important;width:max-content!important;max-width:100%!important;height:30px!important;min-height:30px!important;margin:0!important;padding:2px 4px!important;border:1px solid var(--dsw-alias-border-l2)!important;border-radius:12px!important;background:var(--dsw-alias-bg-layer-2)!important;box-shadow:none!important;filter:none!important}',
        'header [data-dcu-inline-tabs] [role="tab"]{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;height:24px!important;min-height:24px!important;min-width:44px!important;margin:0!important;padding:0 8px!important;border:0!important;border-radius:7px!important;color:var(--dsw-alias-label-secondary)!important;font-size:12px!important;font-weight:500!important;line-height:18px!important;white-space:nowrap!important;box-shadow:none!important;transition:background-color 140ms ease,color 140ms ease!important}',
        'header [data-dcu-inline-tabs] [role="tab"][aria-selected="true"],header [data-dcu-inline-tabs] [role="tab"][data-state="active"]{color:var(--dsw-alias-label-primary)!important;background:var(--dsw-alias-state-business-primary)!important;box-shadow:none!important;filter:none!important}',
        'header [data-dcu-inline-tabs] [role="tab"]:hover:not([aria-selected="true"]):not([data-state="active"]){color:var(--dsw-alias-label-primary)!important;background:var(--dsw-alias-interactive-bg-hover)!important}',
        'header [data-dcu-inline-tabs] [role="tab"]:focus,header [data-dcu-inline-tabs] [role="tab"]:focus-visible{outline:none!important;box-shadow:none!important}',
        'header [data-dcu-inline-tabs] [role="tab"]+ [role="tab"]{border-left:0!important}',
        'header [data-dcu-inline-tabs] [data-dcu-tab-slider]{display:none!important;opacity:0!important;background:transparent!important;box-shadow:none!important;filter:none!important}',
        '.nArs4W_panel .nArs4W_pane>.nArs4W_tabBar{box-sizing:border-box!important;height:42px!important;min-height:42px!important;align-items:center!important}',
        '.nArs4W_panel .nArs4W_pane>.nArs4W_tabBar .nArs4W_tab{box-sizing:border-box!important;height:40px!important;min-height:40px!important;align-items:center!important;padding:0 10px!important}',
        '.nArs4W_panel .nArs4W_pane>.nArs4W_tabBar .nArs4W_tabBarPlus{width:28px!important;height:28px!important;align-self:center!important;margin:0 6px!important}',
        'body[data-dsh-desktop-titlebar-layout="true"] [data-dsh-toggle-cluster],body[data-dsh-title-bar-compat] [data-dsh-toggle-cluster]{top:calc(var(--dsh-title-bar-strip,40px) + 8px)!important}',
        // The sidebar owns AppFrame's right padding. Keep #root viewport-wide:
        // shrinking it as well reserves the same panel width twice and also
        // makes the native responsive frame choose the wrong breakpoint.
        'body[data-dsh-desktop-panel-open="true"] [data-slot="root"],body[data-dsh-desktop-panel-open="true"] [data-conversation-scroll],body[data-dsh-desktop-panel-open="true"] [data-composer-seat],body[data-dsh-desktop-panel-open="true"] [data-slot="conversation.composer"]{min-width:0!important;max-width:100%!important}',
        'body[data-dsh-desktop-panel-open="true"] [data-composer-card]{max-width:min(100%,var(--dsh-composer-card-max-width,100%))!important}',
        '[data-dsh-desktop-conversation-layout="true"][data-phase="active"]{--dsh-composer-card-max-width:var(--dsh-chat-content-width)!important}',
        '[data-dsh-desktop-conversation-layout="true"][data-phase="active"] [data-composer-card]{max-width:min(var(--dsh-chat-content-width),calc(100% - 32px))!important}',
        '[data-dsh-desktop-conversation-layout="true"] [data-width-handle]{top:16px!important;bottom:calc(var(--dsh-desktop-composer-height,160px) + 16px)!important}',
        '[data-dsh-desktop-width-locked="true"] [data-width-handle]{display:none!important}',
        // Mnemon's workspace is an independent fixed/portal surface. Keep
        // its inline left/top anchor, but let the two native panel variables
        // own its exposed right/bottom edges without touching #root or chat.
        'section[data-dsh-mnemon-view][data-dsh-desktop-external-page="true"]{box-sizing:border-box!important;right:var(--dsh-sidebar-width,0px)!important;bottom:var(--dsh-sidebar-height,0px)!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;transition:right var(--ds-transition-duration-slow) var(--ds-ease-in-out),bottom var(--ds-transition-duration-slow) var(--ds-ease-in-out)}',
        'body[data-dsh-sidebar-dragging] section[data-dsh-mnemon-view][data-dsh-desktop-external-page="true"]{transition:none!important}',
        '@media (prefers-reduced-motion: reduce){section[data-dsh-mnemon-view][data-dsh-desktop-external-page="true"]{transition:none!important}}',
        'body[data-dsh-desktop-settings-open] #root{position:relative!important;z-index:1000!important}',
        'body[data-dsh-desktop-settings-open] .dcu-root{position:relative!important;z-index:1000!important}',
        'body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-ancestor="true"]{transform:none!important;translate:none!important;scale:none!important;rotate:none!important;filter:none!important;perspective:none!important;contain:none!important;content-visibility:visible!important;container-type:normal!important;will-change:auto!important;overflow:visible!important;animation:none!important;transition:none!important}',
        'body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-overlay="true"]{position:fixed!important;z-index:1000!important;width:auto!important;max-width:none!important}',
        'body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-dialog="true"]{box-sizing:border-box!important;width:min(1000px,calc(100vw - 48px))!important;max-width:calc(100vw - 48px)!important}',
        'body[data-dsh-desktop-settings-open] .fV0t5q_root,body[data-dsh-desktop-settings-open] [data-composer-seat]{visibility:hidden!important;pointer-events:none!important}',
        'body[data-dsh-desktop-settings-open] .dcu-head .dcu-brand,body[data-dsh-desktop-settings-open] .dsh-signal-hero{visibility:hidden!important;pointer-events:none!important}',
        'body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-dialog="true"] .dcu-brand,body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-dialog="true"] [class*="brandMark"],body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-dialog="true"] [class*="brandName"]{display:none!important}',
        '[data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-settings-nav="true"]{box-sizing:border-box!important;display:flex!important;flex:0 0 188px!important;min-width:188px!important;max-width:188px!important;visibility:visible!important;overflow:hidden!important}',
        '[data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-settings-nav="true"] button{box-sizing:border-box!important;display:flex!important;visibility:visible!important;align-items:center!important;width:100%!important;min-width:0!important;flex:0 0 40px!important;white-space:nowrap!important}',
        '[data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-settings-nav="true"] button svg{display:block!important;visibility:visible!important;flex:0 0 16px!important;width:16px!important;height:16px!important}',
        '[data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-custom-settings-icon="true"]>svg:first-child{display:none!important;visibility:hidden!important}',
        '[data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-settings-nav="true"] button span{display:block!important;visibility:visible!important;max-width:none!important;overflow:visible!important;white-space:nowrap!important}',
        '[data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-settings-list="true"]{box-sizing:border-box!important;display:flex!important;flex:1 1 0!important;min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;scrollbar-gutter:stable}',
        'body[data-dsh-desktop-trajectory-open] [data-composer-seat],body[data-dsh-desktop-trajectory-open] [data-slot="conversation.composer"]{display:none!important;visibility:hidden!important;pointer-events:none!important}',
        'body:not([data-dsh-desktop-conversation-open]) .dcu-turn-navigator,body[data-dsh-desktop-settings-open] .dcu-turn-navigator{display:none!important;visibility:hidden!important;pointer-events:none!important}',
        'html body [data-conversation-scroll] [data-chat-flow-kind="user"] [data-time-hover-root],html body [data-conversation-scroll] [data-pending-steering][data-time-hover-root]{align-items:flex-end!important}',
        'html body [data-conversation-scroll] [data-chat-flow-kind="user"] [data-time-hover-root]>div,html body [data-conversation-scroll] [data-pending-steering][data-time-hover-root]>div{align-items:flex-end!important}',
        '.dshDesktopSidebarTooltip{box-sizing:border-box;position:fixed;z-index:2147483000;left:0;top:0;max-width:min(280px,calc(100vw - 80px));padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:7px;background:var(--dsw-alias-bg-layer-3,#2c2d30);color:var(--dsw-alias-label-primary,#f5f5f7);box-shadow:0 8px 24px rgba(0,0,0,.28);font:12px/16px system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;pointer-events:none;opacity:0;transform:translateY(-50%) translateX(-2px);transition:opacity 90ms ease,transform 90ms ease}',
        '.dshDesktopSidebarTooltip[data-open="true"]{opacity:1;transform:translateY(-50%) translateX(0)}',
        'body[data-ds-light-theme] .dshDesktopSidebarTooltip{border-color:rgba(17,24,39,.12);background:#fff;color:#202124;box-shadow:0 8px 24px rgba(17,24,39,.16)}',
        '.dcu-root,.dcu-expanded-shell,.dcu-compact-shell,.dcu-workspaces,.dcu-native-workspaces{min-height:0!important}',
        '.dcu-root{width:100%!important;min-width:0!important}',
        '.dcu-root>.dcu-expanded-shell{width:100%!important;min-width:0!important}',
        '.dcu-root>.dcu-expanded-shell>.dcu-head{box-sizing:border-box!important;width:100%!important;min-width:0!important;overflow:hidden!important}',
        '.dcu-root>.dcu-expanded-shell>.dcu-head-actions{min-width:64px!important;flex:none!important}',
        '.dcu-expanded-shell{flex:1 1 0!important;overflow:hidden!important}',
        '.dcu-compact-shell{overflow:hidden!important}',
        '.dcu-workspaces,.dcu-native-workspaces{flex:1 1 0!important;overflow:hidden!important}',
        '.dcu-native-workspaces>*{min-height:0!important}',
        '.dcu-foot{flex:0 0 auto!important;position:relative;z-index:2}',
        '.dcu-compact-nav,[data-dsh-desktop-sidebar-scroll="true"],[data-dsh-desktop-settings-list="true"]{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 30%,transparent) transparent;overscroll-behavior:contain}',
        '.dcu-compact-nav::-webkit-scrollbar,[data-dsh-desktop-sidebar-scroll="true"]::-webkit-scrollbar,[data-dsh-desktop-settings-list="true"]::-webkit-scrollbar{width:6px}',
        '.dcu-compact-nav::-webkit-scrollbar-thumb,[data-dsh-desktop-sidebar-scroll="true"]::-webkit-scrollbar-thumb,[data-dsh-desktop-settings-list="true"]::-webkit-scrollbar-thumb{border-radius:99px;background:color-mix(in srgb,currentColor 26%,transparent)}',
        '[data-dsh-desktop-sidebar-scroll="true"]{min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important}',
        '[data-dsh-desktop-settings-nav="true"]{display:flex!important;height:100%!important;max-height:100%!important;min-height:0!important;flex-direction:column!important;overflow:hidden!important}',
        '[data-dsh-desktop-settings-list="true"]{box-sizing:border-box!important;min-height:0!important;flex:1 1 0!important;overflow-y:auto!important;overflow-x:hidden!important;padding-bottom:16px!important;scroll-padding-bottom:16px!important;scrollbar-gutter:stable}',
        'body[data-dsh-desktop-titlebar-layout="true"] [data-dsh-desktop-settings-overlay="true"]{box-sizing:border-box!important;inset:40px 0 0!important;align-items:center!important;justify-content:center!important;padding:24px!important}',
        '[data-dsh-desktop-settings-dialog="true"]{height:min(700px,calc(100vh - 88px))!important;max-height:calc(100vh - 88px)!important;margin-block:auto!important}',
        '.dyn-opt-pop,.dyn-opt-result{left:auto!important;right:0!important;box-sizing:border-box!important;width:min(360px,calc(100vw - 48px))!important;max-width:calc(100vw - 48px)!important;max-height:min(480px,var(--dsh-desktop-popover-height,calc(100dvh - 120px)))!important;overflow-y:auto!important;overscroll-behavior:contain}',
        '.dyn-opt-pop-body{box-sizing:border-box!important;min-width:0!important}',
        'html body[data-ds-dark-theme] .dyn-opt-select{color-scheme:dark!important;background-color:#2c2c2e!important;color:#f5f5f7!important}',
        'html body[data-ds-dark-theme] .dyn-opt-select option{background-color:#2c2c2e!important;color:#f5f5f7!important}',
        'html body[data-ds-light-theme] .dyn-opt-select{color-scheme:light!important;background-color:#fff!important;color:#202124!important}',
        'html body[data-ds-light-theme] .dyn-opt-select option{background-color:#fff!important;color:#202124!important}',
        '@media (prefers-color-scheme:light){html body:not([data-ds-dark-theme]) .dyn-opt-select{color-scheme:light!important;background-color:#fff!important;color:#202124!important}html body:not([data-ds-dark-theme]) .dyn-opt-select option{background-color:#fff!important;color:#202124!important}}',
        '.aag-btn-wrap{display:flex!important;height:28px!important;align-items:center!important}',
        '.aag-btn,[data-dsh-desktop-expert-button="true"]{display:inline-flex!important;height:28px!important;align-items:center!important;justify-content:center!important;gap:4px!important;padding:0 6px!important;line-height:1!important}',
        '.aag-btn>span,[data-dsh-desktop-expert-button="true"]>span{display:inline-flex!important;height:16px!important;align-items:center!important;line-height:16px!important;margin:0!important}',
        '.aag-btn>svg,[data-dsh-desktop-expert-button="true"]>svg{display:block!important;position:static!important;width:14px!important;height:14px!important;flex:none!important;align-self:center!important;margin:0!important;transform:none!important;vertical-align:middle!important}',
        '.dshDesktopTaskboardAnchor{display:none!important}',
        '.dshDesktopTaskboardSource{display:none!important}',
        '.dcu-menu>.dshDesktopCodexTaskboardExpanded>span:first-child{display:grid!important;place-items:center!important;width:20px!important;height:20px!important;flex:0 0 20px!important}',
        '.dcu-menu>.dshDesktopCodexTaskboardExpanded>span:first-child svg,.dshDesktopCodexTaskboardCompact svg{display:block!important;width:16px!important;height:16px!important}',
        '.dshDesktopCodexTaskboardCompact[data-active="true"],.dcu-menu>.dshDesktopCodexTaskboardExpanded[data-active="true"]{background:var(--dcu-sidebar-active,var(--dcu-sidebar-hover))!important;color:var(--dcu-sidebar-primary)!important}',
        '.dshDesktopSettingsRow{display:flex!important;align-items:center;min-width:0;gap:4px}',
        '.dshDesktopSettingsRow [data-dsh-desktop-settings-target="true"]{min-width:0;flex:1 1 auto}',
        '[data-dsh-desktop-composer-toolbar="true"]{display:flex!important;align-items:center!important;flex-wrap:wrap!important;column-gap:8px!important;row-gap:8px!important}',
        '[data-dsh-desktop-composer-group]{display:contents!important}',
        '[data-dsh-desktop-composer-toolbar] [data-slot="conversation.input.left"]>*{order:40!important}',
        '[data-dsh-desktop-composer-toolbar] [data-slot="conversation.input.left"]>.meme-trigger{order:20!important}',
        '[data-dsh-desktop-composer-toolbar] [data-dsh-desktop-composer-group="tools"]>[class*="_modes"]{order:10!important}',
        '[data-dsh-desktop-composer-toolbar] [data-slot="conversation.input.left"]>.dshDesktopComposerActionMic{order:85!important;margin-inline-start:0!important}',
        '[data-dsh-desktop-composer-toolbar] [data-slot="conversation.input.left"]>.dshDesktopComposerActionRoot{order:80!important;margin-inline-start:auto!important}',
        '[data-dsh-desktop-composer-toolbar] [data-slot="conversation.input.right"]>*{order:90!important}',
        '[data-dsh-desktop-composer-model]>*{order:100!important;min-width:0;max-width:100%}',
        '[data-dsh-desktop-composer-group="trailing"]>:not([data-dsh-desktop-composer-model]):not(button){order:105!important}',
        '[data-dsh-desktop-composer-toolbar] [data-dsh-desktop-composer-group="trailing"]>button{order:110!important}',
        '[data-dsh-plugin-update-feedback]{position:fixed;z-index:1100;inset:auto 24px 24px auto;max-width:min(480px,calc(100vw - 48px));display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:16px;background:var(--dsw-alias-bg-layer-2,#292a2d);color:var(--dsw-alias-text-primary,#f5f5f7);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:12px;font:13px/1.5 system-ui}',
        '[data-dsh-plugin-update-feedback]>span{flex:1 1 100%;overflow-wrap:anywhere}',
        '[data-dsh-plugin-update-feedback]>button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,#555);background:transparent;border-radius:8px;padding:6px 12px;cursor:pointer}',
        'body[data-ds-dark-theme] .pI_x6G_centerCol:has(.wSkVaW_root){background:#1d1e20!important}',
        'body[data-ds-light-theme] .pI_x6G_centerCol:has(.wSkVaW_root){background:#f1f2f4!important}',
        'html body [data-composer-card]{min-height:114px!important}',
        'html body [data-composer-card] .stt-mic-btn{border:0!important;box-shadow:none!important}',
        '[data-composer-card] .uV2eYG_row button:not([role="menuitem"]){align-items:center!important;justify-content:center!important}',
        '[data-composer-card] .uV2eYG_row button>svg{display:block;flex-shrink:0;vertical-align:middle}',
        'html body[data-dsh-desktop-settings-open] [data-dsh-desktop-settings-dialog="true"]{width:min(1060px,calc(100vw - 48px))!important}',
        'html body [data-dsh-desktop-settings-dialog="true"] [data-dsh-desktop-settings-nav="true"]{flex-basis:208px!important;width:208px!important;min-width:208px!important;max-width:208px!important}',
        '[data-composer-card] .uV2eYG_primary{transform:none!important}',
        'html body [data-dsh-desktop-settings-list="true"]{padding-right:12px!important;scrollbar-gutter:stable!important}',
      ].join('')
      document.head.append(style)
      return () => style.remove()
    }

    function normalizedLabel(value) {
      return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : ''
    }

    function installComposerServiceCompatibility(ctx) {
      if (typeof ctx.inject !== 'function') return
      // Cordis rebinds a Service's ctx to its caller. ModelDirectoryResolver
      // owns remote.session, but old consumers only inject modelDirectories.
      // Resolve through the service's already-authorized provider context.
      ctx.inject(['modelDirectories'], scope => scope.effect(() => {
        const service = scope.modelDirectories
        const prototype = Object.getPrototypeOf(service)
        const original = prototype?.directoryFor
        if (typeof original !== 'function' || original.dshProviderContext === true || !service.catalog?.ctx) return
        function directoryFor(sessionId) {
          const provider = this.catalog?.ctx
          if (!provider) return original.call(this, sessionId)
          const owned = Object.create(this, { ctx: { value: provider } })
          return original.call(owned, sessionId)
        }
        directoryFor.dshProviderContext = true
        prototype.directoryFor = directoryFor
        return () => { if (prototype.directoryFor === directoryFor) prototype.directoryFor = original }
      }, 'dsh-desktop: model provider context'))

      ctx.inject(['slots'], scope => scope.effect(() => {
        const slots = scope.slots
        if (typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return
        const React = require('react')
        const wrappers = new Set()
        const mounted = new Map()
        let disposed = false
        let syncing = false
        const names = ['conversation.input.left', 'conversation.input.right', 'conversation.input.dock']
        const sync = () => {
          if (disposed || syncing) return
          syncing = true
          try {
            const originals = new Set()
            for (const name of names) for (const entry of slots.entries(name)) {
              if (wrappers.has(entry.component) || typeof entry.options?.id !== 'string') continue
              originals.add(entry)
              if (mounted.has(entry)) continue
              function LegacyInputFace(props) {
                const input = typeof props.useInput === 'function' ? props.useInput(value => value) : props.input
                const session = typeof props.useSession === 'function' ? props.useSession(value => value) : props.session
                return React.createElement(entry.component, { ...props, input: props.input ?? input, session: props.session ?? session })
              }
              LegacyInputFace.displayName = 'DesktopInputFace'
              wrappers.add(LegacyInputFace)
              const priority = Math.min(-10000, ...slots.entries(name).map(item => item.options?.priority ?? 0)) - 1
              const stop = slots.register({ ...entry.options, name, priority, ...(entry.inject ? { inject: entry.inject } : {}), ...(entry.locale ? { locale: entry.locale } : {}) }, LegacyInputFace)
              mounted.set(entry, { stop, component: LegacyInputFace })
            }
            for (const [entry, item] of mounted) if (!originals.has(entry)) { item.stop(); mounted.delete(entry); wrappers.delete(item.component) }
          } finally { syncing = false }
        }
        const stops = names.map(name => slots.subscribe(name, sync))
        sync()
        return () => { disposed = true; stops.forEach(stop => stop()); for (const item of mounted.values()) item.stop(); mounted.clear(); wrappers.clear() }
      }, 'dsh-desktop: legacy composer snapshot face'))
    }

    function installLayoutCompatibility() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      let scheduledFrame = 0
      let defaultsApplied = false
      let panelWasOpen = false
      let settingsWasOpen = false
      let leftSidebarExpandedBeforePanel = false
      let restoreExpandedSidebarForPanel = false
      let observedRoot
      let rootResizeObserver
      let widthDrag
      const widthPreferenceKey = 'dsh.conversation.contentWidth'
      let tooltip
      let tooltipButton
      let tooltipPendingButton
      let tooltipHoverButton
      let tooltipTimer
      const TOOLTIP_DELAY_MS = 420
      const processedStartupControls = new WeakSet()
      const observedStartupDefaults = new Set()
      const expectedStartupDefaults = new Set(['task', 'extensions', 'pinned', 'recent'])

      const markScrollableSidebar = root => {
        const workspace = root.querySelector('.dcu-native-workspaces')
        if (!(workspace instanceof HTMLElement)) return
        for (const marked of root.querySelectorAll('[data-dsh-desktop-sidebar-scroll]')) {
          delete marked.dataset.dshDesktopSidebarScroll
        }
        const semanticTree = workspace.querySelector('.dcu-wb-tree,[role="tree"]')
        if (semanticTree instanceof HTMLElement) {
          semanticTree.dataset.dshDesktopSidebarScroll = 'true'
          return
        }
        const candidates = [workspace, ...workspace.querySelectorAll('*')]
          .filter(element => element instanceof HTMLElement)
          .filter(element => element.querySelectorAll('button,[role="treeitem"]').length > 0)
          .sort((left, right) => right.clientHeight - left.clientHeight)
        const target = candidates.find(element => element.scrollHeight > element.clientHeight + 2)
          ?? candidates.find(element => element.clientHeight > 80)
        if (target instanceof HTMLElement) target.dataset.dshDesktopSidebarScroll = 'true'
      }

      const markSettingsNavigation = () => {
        let settingsOpen = false
        let settingsLayoutReady = false
        let navigationToReset
        let listToReset
        for (const ancestor of document.querySelectorAll('[data-dsh-desktop-settings-ancestor="true"]')) {
          delete ancestor.dataset.dshDesktopSettingsAncestor
        }
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
          if (!(dialog instanceof HTMLElement)) continue
          const dialogText = normalizedLabel(dialog.textContent)
          if (!dialogText.includes('设置') && !dialogText.includes('settings')) continue
          const semanticNav = dialog.querySelector('nav')
          const candidates = [...dialog.querySelectorAll('nav,aside,div')]
            .filter(element => element instanceof HTMLElement)
            .filter(element => element.clientWidth > 120 && element.clientWidth < Math.max(360, dialog.clientWidth * 0.46))
            .filter(element => element.querySelectorAll('button,[role="button"]').length >= 6)
          const nav = semanticNav instanceof HTMLElement && semanticNav.querySelectorAll('button,[role="button"]').length >= 6
            ? semanticNav
            : candidates.find(element => candidates.some(other => other !== element && element.contains(other)))
            ?? candidates[0]
          // Only the native DSH Settings dialog owns a navigation rail. Third-
          // party dialogs (for example dsh-prompt-polish's anchored settings
          // popover) also use role="dialog" and contain the word 设置, but must
          // not activate the desktop-wide Settings visibility rules. Mark the
          // state only after the native navigation shell is positively found.
          if (!(nav instanceof HTMLElement)) continue
          settingsOpen = true
          const directLists = [...nav.children]
            .filter(element => element instanceof HTMLElement)
            .filter(element => element.querySelectorAll('button,[role="button"]').length >= 5)
          const list = directLists.sort((left, right) => right.scrollHeight - left.scrollHeight)[0] ?? nav
          const overlay = dialog.parentElement
          dialog.dataset.dshDesktopSettingsDialog = 'true'
          if (overlay instanceof HTMLElement) overlay.dataset.dshDesktopSettingsOverlay = 'true'
          let ancestor = overlay?.parentElement
          while (ancestor instanceof HTMLElement && ancestor !== document.body) {
            ancestor.dataset.dshDesktopSettingsAncestor = 'true'
            ancestor = ancestor.parentElement
          }
          nav.dataset.dshDesktopSettingsNav = 'true'
          list.dataset.dshDesktopSettingsList = 'true'
          for (const button of nav.querySelectorAll('button,[role="button"]')) {
            if (!(button instanceof HTMLElement)) continue
            const icon = getComputedStyle(button, '::before')
            const content = icon.content
            const mask = icon.maskImage || icon.webkitMaskImage
            const background = icon.backgroundImage
            const hasPluginIcon = (content === '""' || content === "''")
              && ((typeof mask === 'string' && mask !== 'none')
                || (typeof background === 'string' && background !== 'none'))
            if (hasPluginIcon) button.dataset.dshDesktopCustomSettingsIcon = 'true'
            else delete button.dataset.dshDesktopCustomSettingsIcon
          }
          if (!settingsLayoutReady) {
            settingsLayoutReady = true
            navigationToReset = nav
            listToReset = list
          }
        }
        // The settings shell keeps its nav list mounted between section changes,
        // and Chromium may retain the previous scroll offset when the dialog is
        // reopened from the compact rail. Reset only on a completed open
        // transition so manual scrolling inside Settings is still preserved.
        if (settingsLayoutReady && !settingsWasOpen) {
          if (navigationToReset instanceof HTMLElement) navigationToReset.scrollTop = 0
          if (listToReset instanceof HTMLElement) listToReset.scrollTop = 0
        }
        settingsWasOpen = settingsLayoutReady
        if (settingsOpen) document.body.setAttribute('data-dsh-desktop-settings-open', 'true')
        else document.body.removeAttribute('data-dsh-desktop-settings-open')
        if (!settingsOpen) settingsWasOpen = false
      }

      const markTrajectoryState = () => {
        const tab = [...document.querySelectorAll('.wSkVaW_tab')]
          .find(element => ['轨迹', 'trajectory', 'trace'].includes(normalizedLabel(element.textContent)))
        const active = tab instanceof HTMLElement
          && (tab.classList.contains('wSkVaW_tabActive') || tab.getAttribute('aria-selected') === 'true')
        if (active) document.body.setAttribute('data-dsh-desktop-trajectory-open', 'true')
        else document.body.removeAttribute('data-dsh-desktop-trajectory-open')
      }

      const markConversationState = () => {
        const activeTab = [...document.querySelectorAll('.wSkVaW_tab')]
          .find(element => element.classList.contains('wSkVaW_tabActive') || element.getAttribute('aria-selected') === 'true')
        const active = activeTab instanceof HTMLElement
          && ['对话', 'conversation', 'chat'].includes(normalizedLabel(activeTab.textContent))
        if (active) document.body.setAttribute('data-dsh-desktop-conversation-open', 'true')
        else document.body.removeAttribute('data-dsh-desktop-conversation-open')

        const header = document.querySelector('.wSkVaW_header')
        document.querySelectorAll('[data-dsh-desktop-folder-button]').forEach(element => {
          if (element !== header) delete element.dataset.dshDesktopFolderButton
        })
        if (header instanceof HTMLElement) {
          const headerBox = header.getBoundingClientRect()
          const folderButton = [...header.querySelectorAll('button:not(.wSkVaW_tab)')]
            .find(button => {
              if (!(button instanceof HTMLElement) || button.closest('.wSkVaW_tabs') !== null) return false
              if (button.textContent?.trim() !== '') return false
              const box = button.getBoundingClientRect()
              return box.width > 0 && box.left < headerBox.left + 160
            })
          if (folderButton instanceof HTMLElement) folderButton.dataset.dshDesktopFolderButton = 'true'
        }
      }

      const syncHeaderCenterline = () => {
        const tabs = document.querySelector('header [data-dcu-inline-tabs]')
        const header = tabs?.closest('header')
        const cluster = document.querySelector('[data-dsh-toggle-cluster]')
        if (!(tabs instanceof HTMLElement) || !(header instanceof HTMLElement) || !(cluster instanceof HTMLElement)) return
        const headerBox = header.getBoundingClientRect()
        const clusterBox = cluster.getBoundingClientRect()
        if (headerBox.height <= 0 || clusterBox.height <= 0) return
        const offsetParent = cluster.offsetParent instanceof HTMLElement ? cluster.offsetParent : document.documentElement
        const parentBox = typeof offsetParent.getBoundingClientRect === 'function'
          ? offsetParent.getBoundingClientRect()
          : { top: 0 }
        const targetTop = Math.round(headerBox.top - parentBox.top + (headerBox.height - clusterBox.height) / 2)
        if (cluster.style.getPropertyValue('top') !== `${targetTop}px`) cluster.style.setProperty('top', `${targetTop}px`, 'important')
        if (cluster.style.getPropertyValue('margin-top') !== '0px') cluster.style.setProperty('margin-top', '0px', 'important')
        cluster.dataset.dshDesktopCenterline = 'true'
      }

      const ensureTooltip = () => {
        if (tooltip instanceof HTMLElement && tooltip.isConnected) return tooltip
        tooltip = document.createElement('div')
        tooltip.className = 'dshDesktopSidebarTooltip'
        tooltip.setAttribute('role', 'tooltip')
        document.body.append(tooltip)
        return tooltip
      }

      const clearTooltipTimer = () => {
        if (tooltipTimer === undefined) return
        window.clearTimeout(tooltipTimer)
        tooltipTimer = undefined
      }

      const hideTooltip = () => {
        clearTooltipTimer()
        tooltipPendingButton = undefined
        tooltipHoverButton = undefined
        tooltipButton = undefined
        tooltip?.removeAttribute('data-open')
      }

      const showTooltip = button => {
        if (!(button instanceof HTMLElement)) return
        const label = button.dataset.dshDesktopTooltip
        if (typeof label !== 'string' || label === '') return
        clearTooltipTimer()
        tooltipPendingButton = undefined
        const layer = ensureTooltip()
        const rect = button.getBoundingClientRect()
        layer.textContent = label
        const width = layer.getBoundingClientRect().width
        const left = Math.min(Math.max(12, Math.round(rect.right + 8)), Math.max(12, globalThis.innerWidth - width - 12))
        const top = Math.min(Math.max(12, Math.round(rect.top + rect.height / 2)), Math.max(12, globalThis.innerHeight - 12))
        layer.style.left = `${left}px`
        layer.style.top = `${top}px`
        layer.dataset.open = 'true'
        tooltipButton = button
      }

      const scheduleTooltip = button => {
        if (!(button instanceof HTMLElement)) return
        const label = button.dataset.dshDesktopTooltip
        if (typeof label !== 'string' || label.trim() === '') return
        if (button === tooltipButton || button === tooltipPendingButton) return
        clearTooltipTimer()
        tooltipPendingButton = button
        tooltipTimer = window.setTimeout(() => {
          tooltipTimer = undefined
          if (tooltipPendingButton !== button || tooltipHoverButton !== button || !button.isConnected) return
          showTooltip(button)
        }, TOOLTIP_DELAY_MS)
      }

      const compactAction = target => target instanceof Element
        ? target.closest('[data-dsh-desktop-compact-action="true"]')
        : null
      const onPointerOver = event => {
        const button = compactAction(event.target)
        if (!(button instanceof HTMLElement)) return
        if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
        if (tooltipButton !== undefined && tooltipButton !== button) hideTooltip()
        tooltipHoverButton = button
        scheduleTooltip(button)
      }
      const onPointerOut = event => {
        const button = compactAction(event.target)
        if (!(button instanceof HTMLElement)) return
        if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
        if (button === tooltipButton || button === tooltipPendingButton) hideTooltip()
      }
      const onFocusOut = event => {
        const button = compactAction(event.target)
        if (!(button instanceof HTMLElement)) return
        if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
        if (button === tooltipButton || button === tooltipPendingButton) hideTooltip()
      }

      const markCompactNavigation = root => {
        for (const button of root.querySelectorAll('[data-dsh-desktop-compact-action="true"]')) {
          if (!(button instanceof HTMLElement) || button.closest('[role="dialog"]') === null) continue
          delete button.dataset.dshDesktopCompactAction
          delete button.dataset.dshDesktopTooltip
        }
        const candidates = root.querySelectorAll('.dcu-compact-shell button,.dcu-compact .dcu-foot button,.dcu-compact [data-slot="sidebar.settings"] button,.dcu-compact .dcu-settings-seat button,.dcu-compact>[data-dsh-mnemon-entry]')
        for (const button of candidates) {
          if (!(button instanceof HTMLElement)) continue
          if (button.closest('[role="dialog"]') !== null) continue
          let label = button.getAttribute('aria-label') || button.title || button.textContent?.trim()
          if ((!label || label.trim() === '') && button.closest('[data-slot="sidebar.settings"],.dcu-settings-seat')) label = '设置'
          if (typeof label !== 'string' || label.trim() === '') continue
          button.dataset.dshDesktopCompactAction = 'true'
          button.dataset.dshDesktopTooltip = label.trim()
          if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', label.trim())
          // aria-label remains the accessible name. Removing title avoids the
          // browser's immediate native tooltip competing with the unified one.
          button.removeAttribute('title')
        }
      }

      const markPanelLayout = () => {
        const root = document.querySelector('#root')
        if (!(root instanceof HTMLElement)) return
        if (observedRoot !== root && typeof ResizeObserver === 'function') {
          rootResizeObserver?.disconnect()
          rootResizeObserver = new ResizeObserver(() => schedule())
          rootResizeObserver.observe(root)
          observedRoot = root
        }

        const panelWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-sidebar-width')) || 0
        const panelOpen = panelWidth > 1
        if (panelOpen) document.body.setAttribute('data-dsh-desktop-panel-open', 'true')
        else document.body.removeAttribute('data-dsh-desktop-panel-open')
        const codexRoot = root.querySelector('.dcu-root')
        if (!(codexRoot instanceof HTMLElement)) {
          panelWasOpen = panelOpen
          return
        }
        if (!panelOpen) {
          leftSidebarExpandedBeforePanel = !codexRoot.classList.contains('dcu-compact')
          restoreExpandedSidebarForPanel = false
          panelWasOpen = false
          return
        }
        if (!panelWasOpen) restoreExpandedSidebarForPanel = leftSidebarExpandedBeforePanel
        panelWasOpen = true
        // The upstream responsive frame collapses the left sidebar when the
        // right panel reduces #root below its breakpoint. Restore only the
        // state that was expanded immediately before this panel opened; once
        // restored, later user-initiated collapses remain untouched.
        if (restoreExpandedSidebarForPanel && codexRoot.classList.contains('dcu-compact')) {
          const expand = [...codexRoot.querySelectorAll('button')]
            .find(button => button.getClientRects().length > 0
              && ['展开侧边栏', 'expandsidebar'].includes(normalizedLabel(button.getAttribute('aria-label') || button.title)))
          restoreExpandedSidebarForPanel = false
          if (expand instanceof HTMLButtonElement) expand.click()
        }
      }

      // Mnemon renders this view through the shell overlay slot, so it is not
      // a child whose width can be inherited from the native AppFrame. Mark
      // only the documented host node; the CSS contract then tracks the
      // native right/bottom variables without measuring or writing dimensions.
      const markExternalPageLayout = () => {
        for (const page of document.querySelectorAll('section[data-dsh-mnemon-view]')) {
          if (!(page instanceof HTMLElement)) continue
          page.dataset.dshDesktopExternalPage = 'true'
        }
      }

      const applyStartupDefaults = root => {
        if (defaultsApplied) return
        const taskTab = [...root.querySelectorAll('.dcu-im-tab')]
          .find(button => ['任务', 'tasks'].includes(normalizedLabel(button.textContent)))
        if (!(taskTab instanceof HTMLButtonElement)) return
        if (!processedStartupControls.has(taskTab)) {
          if (taskTab.dataset.on !== 'true') taskTab.click()
          processedStartupControls.add(taskTab)
          observedStartupDefaults.add('task')
        }

        const expandable = [...root.querySelectorAll('button[aria-expanded]')]
        for (const button of expandable) {
          if (!(button instanceof HTMLButtonElement) || processedStartupControls.has(button)) continue
          const label = normalizedLabel(button.getAttribute('aria-label') || button.textContent)
          const kind = ['扩展管理', 'extensions'].includes(label)
            ? 'extensions'
            : ['置顶', 'pinned'].includes(label)
                ? 'pinned'
                : ['最近', 'recent'].includes(label)
                    ? 'recent'
                    : undefined
          if (kind === undefined) continue
          if (button.getAttribute('aria-expanded') === 'true') button.click()
          processedStartupControls.add(button)
          observedStartupDefaults.add(kind)
        }
        defaultsApplied = [...expectedStartupDefaults].every(kind => observedStartupDefaults.has(kind))
        document.body?.setAttribute('data-dsh-desktop-sidebar-defaults', defaultsApplied ? 'applied' : 'applying')
      }

      const markExpertComposerButton = () => {
        for (const composer of document.querySelectorAll('[data-composer-card]')) {
          for (const button of composer.querySelectorAll('button,[role="button"]')) {
            if (!(button instanceof HTMLElement)) continue
            if (['专家', 'expert'].includes(normalizedLabel(button.textContent))) {
              button.dataset.dshDesktopExpertButton = 'true'
            }
          }
        }
      }

      const markComposerActionLayout = () => {
        for (const composer of document.querySelectorAll('[data-composer-card]')) {
          const modelSlot = composer.querySelector('[data-slot="conversation.input.model"]')
          const model = modelSlot?.firstElementChild ?? composer.querySelector('.re-model-root')
          const mic = composer.querySelector('.stt-mic-btn')
          const optimizer = composer.querySelector('.dyn-opt-root')
          const row = mic?.closest('[class*="_row"]') ?? optimizer?.closest('[class*="_row"]')
          if (!(model instanceof HTMLElement) || !(row instanceof HTMLElement) || !row.contains(model)) continue
          // Stable DSH slot semantics survive hashed class names and model
          // plugins being replaced by the native model selector.
          const left = row.querySelector('[data-slot="conversation.input.left"]')
          const tools = left?.parentElement
          const trailing = modelSlot?.parentElement
          if (!tools || !trailing || tools.parentElement !== row || trailing.parentElement !== row) continue
          row.dataset.dshDesktopComposerToolbar = 'true'
          tools.dataset.dshDesktopComposerGroup = 'tools'
          trailing.dataset.dshDesktopComposerGroup = 'trailing'
          if (modelSlot) modelSlot.dataset.dshDesktopComposerModel = 'true'
          for (const element of [mic, optimizer]) {
            if (!(element instanceof HTMLElement)) continue
            if (element.style.getPropertyValue('--dsh-desktop-composer-action-shift')) element.style.removeProperty('--dsh-desktop-composer-action-shift')
          }
          if (mic instanceof HTMLElement) {
            if (!mic.classList.contains('dshDesktopComposerActionMic')) mic.classList.add('dshDesktopComposerActionMic')
            if (!mic.getAttribute('aria-label')) mic.setAttribute('aria-label', mic.title || '语音输入')
          }
          if (optimizer instanceof HTMLElement) {
            if (!optimizer.classList.contains('dshDesktopComposerActionRoot')) optimizer.classList.add('dshDesktopComposerActionRoot')
            const height = `${Math.max(100, Math.floor(optimizer.getBoundingClientRect().top - 56))}px`
            if (optimizer.style.getPropertyValue('--dsh-desktop-popover-height') !== height) optimizer.style.setProperty('--dsh-desktop-popover-height', height)
            for (const [selector, label] of [['.dyn-opt-main', '优化提示词'], ['.dyn-opt-gear', '提示词优化设置']]) {
              const button = optimizer.querySelector(selector)
              if (!(button instanceof HTMLElement)) continue
              if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', button.title || label)
              if (selector === '.dyn-opt-main') {
                const hint = '先输入提示词，再点击优化'
                const empty = !(composer.querySelector('[contenteditable]')?.textContent ?? '').trim()
                if (button.disabled && empty) {
                  if (button.title && button.title !== hint) button.dataset.dshOptimizerTitle = button.title
                  if (button.title !== hint) button.title = hint
                } else if (button.title === hint) {
                  button.title = button.dataset.dshOptimizerTitle || '优化当前提示词'
                }
              }
            }
          }
        }
      }

      const px = value => Number.parseFloat(value) || 0
      const rowItems = element => [...element.children].flatMap(child => {
        const style = getComputedStyle(child)
        if (style.display === 'none' || ['absolute', 'fixed'].includes(style.position)) return []
        return style.display === 'contents' ? rowItems(child) : [child]
      })
      const intrinsicRowWidth = element => {
        const style = getComputedStyle(element)
        const children = rowItems(element)
        const inset = px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
        const width = children.reduce((sum, child) => {
          const childStyle = getComputedStyle(child)
          return sum + ((childStyle.display === 'flex' || childStyle.display === 'inline-flex')
            && !childStyle.flexDirection.startsWith('column') && child.tagName !== 'BUTTON'
            ? intrinsicRowWidth(child) : child.getBoundingClientRect().width)
        }, 0) + Math.max(0, children.length - 1) * px(style.columnGap) + inset
        return Math.max(px(style.minWidth), width)
      }
      const publishWidthFloor = (root, minimum, persist) => {
        const value = `${minimum}px`
        if (root.style.getPropertyValue('--dsh-chat-user-width') !== value) root.style.setProperty('--dsh-chat-user-width', value)
        if (persist) {
          try { if (localStorage.getItem(widthPreferenceKey) !== String(minimum)) localStorage.setItem(widthPreferenceKey, String(minimum)) } catch { /* visual clamp remains usable without durable storage */ }
        }
      }
      const onWidthPointerDown = event => {
        const handle = event.target instanceof Element ? event.target.closest('[data-width-handle]') : null
        const root = handle?.closest('[data-dsh-desktop-conversation-layout]')
        if (!root || event.button !== 0) return
        const minimum = Number(root.dataset.dshDesktopChatMinWidth)
        if (!Number.isFinite(minimum) || root.dataset.dshDesktopWidthLocked === 'true') return
        const card = root.querySelector('[data-composer-card]')
        if (!card) return
        if (card.getBoundingClientRect().width < minimum) publishWidthFloor(root, minimum, true)
        widthDrag = { root, handle, minimum, base: card.getBoundingClientRect().width, x: event.clientX, pointerId: event.pointerId, side: handle.dataset.widthHandle }
      }
      const onWidthPointerMove = event => {
        if (!widthDrag || event.pointerId !== widthDrag.pointerId) return
        const { root, handle, minimum, base, x, side } = widthDrag
        if (!root.isConnected || event.buttons === 0) { widthDrag = undefined; return }
        const wanted = base + (side === 'left' ? x - event.clientX : event.clientX - x) * 2
        if (wanted >= minimum && Math.max(640, root.getBoundingClientRect().width - 176) >= minimum) return
        // Only intercept the below-minimum part of the gesture. Native DSH
        // still owns pointer capture, normal resizing, and preference storage.
        event.preventDefault()
        event.stopPropagation()
        publishWidthFloor(root, minimum, false)
        handle.style.setProperty('--dsh-width-handle-pointer-y', `${event.clientY - handle.getBoundingClientRect().top}px`)
      }
      const onWidthPointerUp = event => {
        if (!widthDrag || event.pointerId !== widthDrag.pointerId) return
        const { root, minimum } = widthDrag
        widthDrag = undefined
        // This bubble listener runs after React's native commit handler.
        if (root.isConnected && px(root.style.getPropertyValue('--dsh-chat-user-width')) < minimum) publishWidthFloor(root, minimum, true)
      }
      const markConversationGeometry = () => {
        for (const scroller of document.querySelectorAll('[data-conversation-scroll]')) {
          const root = scroller.closest('[data-phase]')
          const seat = scroller.querySelector('[data-composer-seat]')
          if (!(root instanceof HTMLElement) || !(seat instanceof HTMLElement)) continue
          // Share DSH's own live width variable, not a second stored width.
          // Native ResizeObserver publishes composer height on the scroller;
          // lift that measurement to the common parent of its sibling handles.
          if (!getComputedStyle(root).getPropertyValue('--dsh-chat-content-width').trim()) continue
          if (root.dataset.dshDesktopConversationLayout !== 'true') root.dataset.dshDesktopConversationLayout = 'true'
          const height = `${Math.ceil(seat.getBoundingClientRect().height)}px`
          if (root.style.getPropertyValue('--dsh-desktop-composer-height') !== height) root.style.setProperty('--dsh-desktop-composer-height', height)
          const card = seat.querySelector('[data-composer-card]')
          const row = card?.querySelector('[data-dsh-desktop-composer-toolbar],[class*="_row"]')
          if (row && card && root.dataset.phase === 'active') {
            const cardStyle = getComputedStyle(card)
            const minimum = Math.ceil(Math.max(640, intrinsicRowWidth(row) + px(cardStyle.paddingLeft) + px(cardStyle.paddingRight) + 2))
            root.dataset.dshDesktopChatMinWidth = String(minimum)
            // A window narrower than the toolbar must keep its native
            // responsive layout; never force overflow or close a sidebar.
            const locked = scroller.clientWidth - 64 < minimum
            root.dataset.dshDesktopWidthLocked = String(locked)
            if (!locked && card.getBoundingClientRect().width + 1 < minimum) publishWidthFloor(root, minimum, true)
          }
        }
      }

      const layoutSubtreeSelector = [
        '.dcu-expanded-shell',
        '.dcu-compact-shell',
        '.dcu-native-workspaces',
        '.dcu-settings-seat',
        '.wSkVaW_root',
        '.wSkVaW_tabs',
        '.wSkVaW_tab',
        '[data-slot="sidebar"]',
        '[data-slot="sidebar.settings"]',
        '[data-composer-card]',
        '[data-dsh-desktop-conversation-layout]',
        'section[data-dsh-mnemon-view]',
        '[role="dialog"]',
      ].join(',')
      const layoutMutationSelector = `.dcu-root,${layoutSubtreeSelector}`
      const nodeTouchesLayout = node => node instanceof Element
        && (node.matches(layoutMutationSelector) || node.querySelector(layoutMutationSelector) !== null)
      const nodeTouchesSettings = node => node instanceof Element
        && (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]') !== null)
      const mutationTouchesSettings = record => record.type === 'childList'
        && ((record.target instanceof Element
            && (record.target.matches('[role="dialog"]') || record.target.closest('[role="dialog"]') !== null))
          || [...record.addedNodes, ...record.removedNodes].some(nodeTouchesSettings))
      const mutationTouchesPanel = record => record.type === 'attributes'
        && ((record.target === document.documentElement && record.attributeName === 'style')
          || (record.attributeName === 'class'
            && record.target instanceof Element
            && record.target.matches('.dcu-root')))
      const mutationTouchesTrajectory = record => record.type === 'attributes'
        && record.attributeName === 'class'
        && record.target instanceof Element
        && record.target.matches('.wSkVaW_root,.wSkVaW_tabs,.wSkVaW_tab')
      const mutationAffectsLayout = record => {
        if (record.type === 'attributes') {
          if (record.target === document.documentElement) return record.attributeName === 'style'
          return record.target instanceof Element
            && (record.target.matches(layoutMutationSelector)
              || record.target.closest(layoutSubtreeSelector) !== null)
        }
        if (record.target instanceof Element
          && (record.target.matches(layoutMutationSelector)
            || record.target.closest(layoutSubtreeSelector) !== null)) return true
        return [...record.addedNodes, ...record.removedNodes].some(nodeTouchesLayout)
      }

      const synchronize = () => {
        scheduledFrame = 0
        const root = document.querySelector('.dcu-root')
        if (root instanceof HTMLElement) {
          const memory = root.querySelector(':scope > [data-dsh-mnemon-entry]')
          const footer = root.querySelector(':scope > .dcu-foot')
          // Mnemon owns this DOM button, not a React child. Keep its parent
          // intact so its own placement observer and click handler stay valid.
          if (memory && footer && memory.nextElementSibling !== footer) root.insertBefore(memory, footer)
          markScrollableSidebar(root)
          markCompactNavigation(root)
          applyStartupDefaults(root)
          const settings = root.querySelector('.dcu-settings-seat button,[data-slot="sidebar.settings"] button')
          if (settings instanceof HTMLElement) {
            if (!settings.getAttribute('aria-label')) settings.setAttribute('aria-label', '设置')
            if (settings.closest('.dcu-compact')) settings.removeAttribute('title')
            else if (!settings.title) settings.title = '设置'
          }
        }
        markSettingsNavigation()
        markTrajectoryState()
        markConversationState()
        syncHeaderCenterline()
        markPanelLayout()
        markExternalPageLayout()
        markExpertComposerButton()
        markComposerActionLayout()
        markConversationGeometry()
      }
      const schedule = () => {
        if (scheduledFrame !== 0) return
        scheduledFrame = window.requestAnimationFrame(synchronize)
      }
      const observer = new MutationObserver(records => {
        // These two states control top-level geometry and must not wait for an
        // animation frame: Chromium may suspend rAF while the desktop window
        // is briefly occluded during a rapid panel toggle.
        if (records.some(mutationTouchesPanel)) markPanelLayout()
        if (records.some(mutationTouchesSettings)) markSettingsNavigation()
        if (records.some(mutationTouchesTrajectory)) {
          markTrajectoryState()
          markConversationState()
        }
        if (records.some(mutationAffectsLayout)) schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'aria-disabled'] })
      // Better Sidebar publishes its live push width on <html>, outside the
      // body subtree. Observe that exact style owner as a second target so a
      // panel toggle resizes the conversation on the very next frame.
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
      document.addEventListener('pointerover', onPointerOver, true)
      document.addEventListener('pointerout', onPointerOut, true)
      document.addEventListener('focusout', onFocusOut, true)
      document.addEventListener('scroll', hideTooltip, true)
      document.addEventListener('pointerdown', hideTooltip, true)
      document.addEventListener('pointerdown', onWidthPointerDown, true)
      document.addEventListener('pointermove', onWidthPointerMove, true)
      document.addEventListener('pointerup', onWidthPointerUp)
      document.addEventListener('pointercancel', onWidthPointerUp)
      document.addEventListener('click', hideTooltip, true)
      document.addEventListener('visibilitychange', hideTooltip, true)
      window.addEventListener('blur', hideTooltip)
      const onResize = () => {
        hideTooltip()
        schedule()
      }
      window.addEventListener('resize', onResize)
      schedule()
      return () => {
        observer.disconnect()
        if (scheduledFrame !== 0) window.cancelAnimationFrame(scheduledFrame)
        rootResizeObserver?.disconnect()
        window.removeEventListener('resize', onResize)
        document.removeEventListener('pointerover', onPointerOver, true)
        document.removeEventListener('pointerout', onPointerOut, true)
        document.removeEventListener('focusout', onFocusOut, true)
        document.removeEventListener('scroll', hideTooltip, true)
        document.removeEventListener('pointerdown', hideTooltip, true)
        document.removeEventListener('pointerdown', onWidthPointerDown, true)
        document.removeEventListener('pointermove', onWidthPointerMove, true)
        document.removeEventListener('pointerup', onWidthPointerUp)
        document.removeEventListener('pointercancel', onWidthPointerUp)
        widthDrag = undefined
        document.removeEventListener('click', hideTooltip, true)
        document.removeEventListener('visibilitychange', hideTooltip, true)
        window.removeEventListener('blur', hideTooltip)
        clearTooltipTimer()
        tooltip?.remove()
        settingsWasOpen = false
        document.body.removeAttribute('data-dsh-desktop-settings-open')
        document.body.removeAttribute('data-dsh-desktop-panel-open')
        document.body.removeAttribute('data-dsh-desktop-trajectory-open')
        document.body.removeAttribute('data-dsh-desktop-conversation-open')
        document.querySelectorAll('[data-dsh-desktop-conversation-layout]').forEach(element => {
          delete element.dataset.dshDesktopConversationLayout
          delete element.dataset.dshDesktopChatMinWidth
          delete element.dataset.dshDesktopWidthLocked
          element.style.removeProperty('--dsh-desktop-composer-height')
        })
        document.querySelectorAll('[data-dsh-desktop-centerline]').forEach(element => {
          delete element.dataset.dshDesktopCenterline
          element.style.removeProperty('top')
          element.style.removeProperty('margin-top')
        })
        document.querySelectorAll('[data-dsh-desktop-composer-control]').forEach(element => {
          delete element.dataset.dshDesktopComposerControl
          element.style.removeProperty('--dsh-desktop-control-size')
        })
        document.querySelectorAll('[data-dsh-desktop-settings-control]').forEach(element => {
          delete element.dataset.dshDesktopSettingsControl
          element.style.removeProperty('--dsh-desktop-settings-control-size')
        })
        document.querySelectorAll('[data-dsh-desktop-sidebar-scroll],[data-dsh-desktop-settings-overlay],[data-dsh-desktop-settings-dialog],[data-dsh-desktop-settings-ancestor],[data-dsh-desktop-settings-nav],[data-dsh-desktop-settings-list],[data-dsh-desktop-custom-settings-icon],[data-dsh-desktop-expert-button],[data-dsh-desktop-compact-action],[data-dsh-desktop-folder-button],[data-dsh-desktop-external-page]')
          .forEach(element => {
            delete element.dataset.dshDesktopSidebarScroll
            delete element.dataset.dshDesktopSettingsOverlay
            delete element.dataset.dshDesktopSettingsDialog
            delete element.dataset.dshDesktopSettingsAncestor
            delete element.dataset.dshDesktopSettingsNav
            delete element.dataset.dshDesktopSettingsList
            delete element.dataset.dshDesktopCustomSettingsIcon
            delete element.dataset.dshDesktopExpertButton
            delete element.dataset.dshDesktopCompactAction
            delete element.dataset.dshDesktopFolderButton
            delete element.dataset.dshDesktopExternalPage
            delete element.dataset.dshDesktopTooltip
          })
        document.querySelectorAll('.dshDesktopComposerActionMic,.dshDesktopComposerActionRoot,.dshDesktopComposerActionButton')
          .forEach(element => {
            element.classList.remove('dshDesktopComposerActionMic', 'dshDesktopComposerActionRoot', 'dshDesktopComposerActionButton')
            element.style.removeProperty('--dsh-desktop-composer-action-shift')
          })
      }
    }

    function installCodexTaskBoardBridge() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      let expandedButton
      let compactButton
      let activeObserver
      let scheduled = false

      const synchronize = () => {
        scheduled = false
        const root = document.querySelector('.dcu-root')
        if (!(root instanceof HTMLElement)) return
        const sidebarHost = root.closest('[data-slot="sidebar"]') ?? root.parentElement ?? root

        let anchor = root.querySelector(':scope > .dshDesktopTaskboardAnchor')
        if (!(anchor instanceof HTMLButtonElement)) {
          anchor = document.createElement('button')
          anchor.type = 'button'
          anchor.className = 'dshDesktopTaskboardAnchor newSession'
          anchor.tabIndex = -1
          anchor.setAttribute('aria-hidden', 'true')
          root.append(anchor)
        }

        const entry = sidebarHost.querySelector('[data-dsh-taskboard-entry]:not([data-dsh-taskboard-proxy])')
        if (!(entry instanceof HTMLButtonElement)) return
        const expandedMenu = root.querySelector('.dcu-expanded-shell .dcu-menu')
        const compactMenu = root.querySelector('.dcu-compact-nav')
        if (!(expandedMenu instanceof HTMLElement) || !(compactMenu instanceof HTMLElement)) return

        entry.classList.add('dshDesktopTaskboardSource')
        const clickEntry = () => {
          const current = sidebarHost.querySelector('[data-dsh-taskboard-entry]:not([data-dsh-taskboard-proxy])')
          if (current instanceof HTMLButtonElement) current.click()
        }

        if (!(expandedButton instanceof HTMLButtonElement) || !expandedButton.isConnected) {
          expandedButton = entry.cloneNode(true)
          expandedButton.removeAttribute('data-dsh-taskboard-entry')
          expandedButton.dataset.dshTaskboardProxy = 'expanded'
          expandedButton.classList.remove('dshDesktopTaskboardSource')
          expandedButton.classList.add('dshDesktopCodexTaskboardExpanded')
          expandedButton.addEventListener('click', clickEntry)
          expandedMenu.insertBefore(expandedButton, expandedMenu.children[1] ?? null)
        }

        if (!(compactButton instanceof HTMLButtonElement) || !compactButton.isConnected) {
          compactButton = document.createElement('button')
          compactButton.type = 'button'
          compactButton.className = 'dcu-icon dshDesktopCodexTaskboardCompact'
          compactButton.setAttribute('aria-label', entry.getAttribute('aria-label') ?? '任务看板')
          compactButton.title = entry.getAttribute('title') ?? entry.getAttribute('aria-label') ?? '任务看板'
          const icon = entry.querySelector('svg')?.cloneNode(true)
          if (icon !== undefined) compactButton.append(icon)
          compactButton.addEventListener('click', clickEntry)
          compactMenu.insertBefore(compactButton, compactMenu.children[1] ?? null)
        }

        const syncActive = () => {
          const active = entry.dataset.active === 'true'
          for (const button of [expandedButton, compactButton]) {
            if (!(button instanceof HTMLButtonElement)) continue
            if (active) button.dataset.active = 'true'
            else delete button.dataset.active
          }
        }
        activeObserver?.disconnect()
        activeObserver = new MutationObserver(syncActive)
        activeObserver.observe(entry, { attributes: true, attributeFilter: ['data-active'] })
        syncActive()
      }

      const schedule = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(synchronize)
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      schedule()
      return () => {
        observer.disconnect()
        activeObserver?.disconnect()
        expandedButton?.remove()
        compactButton?.remove()
        document.querySelector('[data-dsh-taskboard-entry]:not([data-dsh-taskboard-proxy])')?.classList.remove('dshDesktopTaskboardSource')
        document.querySelector('.dshDesktopTaskboardAnchor')?.remove()
      }
    }

    function notificationSettings() {
      const defaults = {
        enabled: true,
        notifyCompleted: true,
        backgroundOnly: true,
      }
      try {
        const parsed = JSON.parse(globalThis.localStorage?.getItem(NOTIFICATION_SETTINGS_KEY) ?? 'null')
        return parsed !== null && typeof parsed === 'object' ? { ...defaults, ...parsed } : defaults
      } catch {
        return defaults
      }
    }

    function needsNotificationCompatibility() {
      const entries = globalThis.__DSH_BOOT__?.entries
      if (!Array.isArray(entries)) return false
      return entries.some(entry => entry?.id === 'dsh-notification'
        && entry?.rev === NOTIFICATION_COMPATIBLE_REVISION)
    }

    function sessionEntries(state) {
      if (Array.isArray(state?.items)) {
        return state.items
          .filter(summary => typeof summary?.sessionId === 'string')
          .map(summary => [summary.sessionId, summary])
      }
      return Object.entries(state?.byId ?? {})
    }

    function installNotificationCompatibility(sessions) {
      if (!needsNotificationCompatibility() || typeof globalThis.Notification !== 'function') return () => {}

      let previous
      const notifiedSinceRun = new Set()
      const observe = () => {
        const state = sessions.list.getSnapshot()
        const next = new Map()
        for (const [sessionId, summary] of sessionEntries(state)) {
          const current = {
            running: summary?.running === true,
            completed: summary?.completed === true,
          }
          next.set(sessionId, current)
          if (current.running) notifiedSinceRun.delete(sessionId)
          const before = previous?.get(sessionId)
          if (before === undefined) continue

          const stopped = before.running && !current.running
          const completionAppeared = !before.completed && current.completed
          if (!stopped && !completionAppeared) continue
          if (notifiedSinceRun.has(sessionId)) continue

          const settings = notificationSettings()
          if (settings.enabled === false || settings.notifyCompleted === false) continue
          if (settings.backgroundOnly !== false && state.current === sessionId) continue
          if (globalThis.Notification.permission !== 'granted') continue

          const title = typeof summary?.title === 'string' && summary.title.trim() !== ''
            ? summary.title.trim()
            : 'DSH 任务'
          const revision = summary?.updatedAt ?? summary?.lastUpdatedAt ?? Date.now()
          try {
            new globalThis.Notification('DSH 任务已完成', {
              body: `${title} 已完成。`,
              tag: `dsh-notification-${sessionId}-desktop-${revision}`,
            })
            notifiedSinceRun.add(sessionId)
            console.info('[dsh-desktop] Recovered a completion notification missed by dsh-notification 0.1.3.')
          } catch (error) {
            console.warn('[dsh-desktop] Notification compatibility fallback failed.', error)
          }
        }
        previous = next
      }

      const unsubscribe = sessions.list.subscribe(observe)
      observe()
      return unsubscribe
    }

    function updateIcon() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M8 2.25v8.1m0 0 3.1-3.1M8 10.35l-3.1-3.1M3.25 12.25v1.5h9.5v-1.5')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.35')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.append(path)
      return svg
    }

    function settingsButton() {
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
      const sidebarButton = buttons.find(button => button.closest('.dcu-settings-seat') instanceof HTMLElement
        && ['设置', 'settings'].includes(normalizedLabel(button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent)))
      if (sidebarButton !== undefined) return sidebarButton
      return buttons.find(button => {
        const labels = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
          .filter(value => typeof value === 'string')
          .map(value => value.replace(/\s+/g, '').toLowerCase())
        return labels.some(label => label === '设置' || label === 'settings')
      })
    }

    function settingsRow(button) {
      const seat = button?.closest?.('.dcu-settings-seat')
      if (seat instanceof HTMLElement) return seat
      let current = button?.parentElement
      for (let depth = 0; current instanceof HTMLElement && depth < 5; depth += 1) {
        const display = window.getComputedStyle(current).display
        if (display === 'flex' || display === 'inline-flex') return current
        current = current.parentElement
      }
      return button?.parentElement
    }

    function installUpdateButton() {
      if (typeof bridge.getUpdates === 'function') return () => {} // Main-owned dual updater replaces legacy polling.
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || typeof bridge.checkUpdate !== 'function') return () => {}
      let available = false
      let button
      let disposed = false
      let checkTimer

      const removeButton = () => {
        button?.remove()
        button = undefined
      }

      const ensureButton = () => {
        if (!available) {
          removeButton()
          return
        }
        const settings = settingsButton()
        if (!(settings instanceof HTMLElement)) return
        const row = settingsRow(settings)
        if (!(row instanceof HTMLElement)) return
        if (row.querySelector(`[data-dsh-desktop-marker="${UPDATE_BUTTON_MARKER}"]`) instanceof HTMLElement) return
        row.classList.add('dshDesktopSettingsRow')
        settings.dataset.dshDesktopSettingsTarget = 'true'
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshDesktopUpdateButton'
        button.dataset.dshDesktopMarker = UPDATE_BUTTON_MARKER
        button.setAttribute('aria-label', '更新 DSH')
        button.title = '发现 DSH 更新'
        button.append(updateIcon())
        button.addEventListener('click', async event => {
          event.preventDefault()
          event.stopPropagation()
          if (button?.disabled) return
          button.disabled = true
          try {
            const result = await bridge.openUpdate()
            if (result?.ok !== true) console.warn('DeepSeek Harness Desktop could not open the DSH update page.', result?.error)
          } catch (error) {
            console.warn('DeepSeek Harness Desktop update navigation failed.', error)
          } finally {
            if (button !== undefined) button.disabled = false
          }
        })
        row.append(button)
      }

      const observer = new MutationObserver(() => ensureButton())
      observer.observe(document.body, { childList: true, subtree: true })
      ensureButton()
      const check = async () => {
        try {
          const result = await bridge.checkUpdate()
          if (disposed) return
          available = result?.ok === true && result.available === true
          ensureButton()
        } catch (error) {
          console.warn('DeepSeek Harness Desktop DSH update check failed.', error)
        }
        if (disposed) return
        checkTimer = window.setTimeout(() => { void check() }, available ? 60_000 : 8_000)
      }
      checkTimer = window.setTimeout(() => { void check() }, 1200)

      return () => {
        disposed = true
        window.clearTimeout(checkTimer)
        observer.disconnect()
        removeButton()
      }
    }

    function installAppearanceSettings(ctx) {
      if (typeof ctx?.inject !== 'function' || typeof ctx?.theme?.overrideTokens !== 'function') return () => {}
      const { createElement: h, useEffect, useRef, useState } = require('react')
      const theme = ctx?.theme
      const SOURCE = '@dsh-desktop/integration/appearance'
      const STORAGE_KEY = 'dsh-desktop.appearance.v1'
      const STYLE_ID = 'dsh-desktop-appearance-style'
    
      const DEFAULTS = {
        light: { accent: '#4176e6', background: '#ffffff', foreground: '#0f1115' },
        dark: { accent: '#679efe', background: '#151517', foreground: '#f9fafb' },
        fonts: {
          ui: 'system-ui, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Helvetica Neue, Helvetica, Arial, sans-serif',
          content: 'system-ui, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Helvetica Neue, Helvetica, Arial, sans-serif',
          code: 'SF Mono, JetBrains Mono, Fira Code, Consolas, Liberation Mono, Menlo, Courier, PingFang SC, Microsoft YaHei',
        },
        sidebar: { opacity: 0.84, contrast: 1 },
      }
    
      const clone = value => JSON.parse(JSON.stringify(value))
      const validThemeIds = new Set(['system', 'light', 'dark'])
    
      function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
      }
    
      function error(message) {
        throw new TypeError(message)
      }
    
      function validateColor(value, path) {
        if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
          error(`${path} 必须是 6 位十六进制颜色，例如 #4f7cff`)
        }
        return value.toLowerCase()
      }
    
      // Font input is deliberately narrower than CSS: no quotes, functions,
      // escapes, declarations, URLs, or variable references can cross this line.
      function validateFont(value, path) {
        if (typeof value !== 'string') error(`${path} 必须是字体族列表`)
        const normalized = value.trim().replace(/\s+/g, ' ')
        const pattern = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}(,\s*[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79})*$/u
        if (normalized.length === 0 || normalized.length > 240 || !pattern.test(normalized)) {
          error(`${path} 含有不支持的字体字符；只允许字体名、空格、逗号、短横线和下划线`)
        }
        return normalized
      }
    
      function validateNumber(value, path, min, max) {
        const number = Number(value)
        if (!Number.isFinite(number) || number < min || number > max) {
          error(`${path} 必须在 ${min} 到 ${max} 之间`)
        }
        return number
      }
    
      function validateConfig(value) {
        if (!isRecord(value)) error('外观设置必须是 JSON 对象')
        if (!isRecord(value.light) || !isRecord(value.dark)) error('外观设置缺少 light 或 dark 颜色组')
        if (!isRecord(value.fonts)) error('外观设置缺少 fonts 字体组')
        if (!isRecord(value.sidebar)) error('外观设置缺少 sidebar 侧栏组')
        return {
          light: {
            accent: validateColor(value.light.accent, 'light.accent'),
            background: validateColor(value.light.background, 'light.background'),
            foreground: validateColor(value.light.foreground, 'light.foreground'),
          },
          dark: {
            accent: validateColor(value.dark.accent, 'dark.accent'),
            background: validateColor(value.dark.background, 'dark.background'),
            foreground: validateColor(value.dark.foreground, 'dark.foreground'),
          },
          fonts: {
            ui: validateFont(value.fonts.ui, 'fonts.ui'),
            content: validateFont(value.fonts.content, 'fonts.content'),
            code: validateFont(value.fonts.code, 'fonts.code'),
          },
          sidebar: {
            opacity: validateNumber(value.sidebar.opacity, 'sidebar.opacity', 0.5, 1),
            contrast: validateNumber(value.sidebar.contrast, 'sidebar.contrast', 0.8, 1.2),
          },
        }
      }
    
      function loadConfig() {
        try {
          const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
          if (raw === null || raw === undefined) return null
          const parsed = JSON.parse(raw)
          return validateConfig(parsed.settings ?? parsed)
        } catch (cause) {
          console.warn('[dsh-desktop] Ignoring invalid local appearance settings.', cause)
          return null
        }
      }
    
      function persistConfig(config) {
        try {
          if (!globalThis.localStorage) return false
          if (config === null) globalThis.localStorage?.removeItem(STORAGE_KEY)
          else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, settings: config }))
          return true
        } catch (cause) {
          console.warn('[dsh-desktop] Could not persist local appearance settings.', cause)
          return false
        }
      }
    
      function rgb(hex) {
        return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16))
      }
    
      function rgba(hex, alpha) {
        const [red, green, blue] = rgb(hex)
        return `rgba(${red}, ${green}, ${blue}, ${alpha})`
      }
    
      function mix(first, second, amount) {
        const a = rgb(first)
        const b = rgb(second)
        const channel = index => Math.round(a[index] + (b[index] - a[index]) * amount).toString(16).padStart(2, '0')
        return `#${channel(0)}${channel(1)}${channel(2)}`
      }
    
      function pair(light, dark) {
        return { light, dark }
      }
    
      function buildTokenOverrides(config) {
        const light = config.light
        const dark = config.dark
        // Paint one alpha layer over the native Acrylic backdrop. Descendants
        // stay transparent so the title bar, sidebar and corner never stack alpha.
        const chrome = pair(rgba(mix('#f1f2f4', '#ffffff', (config.sidebar.contrast - 0.8) / 2), config.sidebar.opacity), rgba(mix('#1d1e20', '#000000', (config.sidebar.contrast - 0.8) / 2), config.sidebar.opacity))
        return {
          '--dsw-alias-bg-base': pair(light.background, dark.background),
          '--dsw-alias-bg-layer-1': pair(mix(light.background, '#000000', 0.035), mix(dark.background, '#ffffff', 0.08)),
          '--dsw-alias-bg-layer-2': pair(mix(light.background, '#000000', 0.07), mix(dark.background, '#ffffff', 0.14)),
          '--dsw-alias-bg-layer-3': pair(mix(light.background, '#000000', 0.11), mix(dark.background, '#ffffff', 0.2)),
          '--dsw-alias-bg-overlay': pair(mix(light.background, '#000000', 0.14), mix(dark.background, '#ffffff', 0.24)),
          '--dsw-alias-brand-primary': pair(light.accent, dark.accent),
          '--dsw-alias-state-business-primary': pair(light.accent, dark.accent),
          '--dsw-alias-label-primary': pair(light.foreground, dark.foreground),
          '--dsw-alias-label-secondary': pair(rgba(light.foreground, 0.72), rgba(dark.foreground, 0.76)),
          '--dsw-alias-label-tertiary': pair(rgba(light.foreground, 0.52), rgba(dark.foreground, 0.54)),
          '--dsw-alias-border-l1': pair(rgba(light.foreground, 0.11), rgba(dark.foreground, 0.14)),
          '--dsw-alias-border-l2': pair(rgba(light.foreground, 0.18), rgba(dark.foreground, 0.22)),
          '--dsw-alias-interactive-bg-hover': pair(rgba('#000000', 0.08), rgba('#ffffff', 0.10)),
          '--dsw-specific-sidebar-fill': chrome,
          '--dsw-specific-sidebar-nav-item-hover': pair(rgba('#000000', 0.08 * config.sidebar.contrast), rgba('#ffffff', 0.14 * config.sidebar.contrast)),
          '--dsw-specific-sidebar-nav-item-active': pair(rgba('#000000', 0.13 * config.sidebar.contrast), rgba('#ffffff', 0.23 * config.sidebar.contrast)),
          '--dsw-font-family': pair(config.fonts.ui, config.fonts.ui),
          '--ds-font-family-code': pair(config.fonts.code, config.fonts.code),
          '--dsh-appearance-content-font-family': pair(config.fonts.content, config.fonts.content),
          '--dsh-appearance-contrast': pair(String(config.sidebar.contrast), String(config.sidebar.contrast)),
        }
      }
    
      const CSS = `
        .dsh-desktop-appearance-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
        .dsh-appearance-disclosure .dsh-desktop-appearance-settings button{transition:opacity 150ms ease!important}
        html body:not([data-ds-dark-theme]) .dsh-appearance-disclosure .dsh-desktop-appearance-settings button{background:#161616!important;color:#fff!important;border-color:#161616!important}
        html body[data-ds-dark-theme] .dsh-appearance-disclosure .dsh-desktop-appearance-settings button{background:#fff!important;color:#151517!important;border-color:#fff!important}
        html body[data-ds-dark-theme] .dsh-appearance-disclosure{--appearance-control:#fff;--appearance-control-ink:#151517;--appearance-hover:#e5e5e5}
        html body:not([data-ds-dark-theme]) .dsh-appearance-disclosure{--appearance-control:#161616;--appearance-control-ink:#fff;--appearance-hover:#353535}
        ._8HJdBW_group>.dsh-appearance-disclosure{margin:0;border-bottom:0}
        .dsh-appearance-disclosure .dsh-desktop-appearance-settings :is(.dsh-desktop-appearance-action,.dsh-desktop-appearance-reset){background:var(--appearance-control)!important;color:var(--appearance-control-ink)!important;border-color:var(--appearance-control)!important}
        html body:is([data-ds-dark-theme],:not([data-ds-dark-theme])) .dsh-appearance-disclosure .dsh-desktop-appearance-settings button:hover:not(:disabled){background:var(--appearance-hover)!important;filter:none!important}
        .dsh-appearance-disclosure .dsh-desktop-appearance-settings input:is([type=range],[type=checkbox]){accent-color:var(--appearance-control)!important}
        .dsh-appearance-disclosure .dsh-desktop-appearance-settings :is(button,input,textarea):focus-visible,.dsh-appearance-disclosure>summary:focus-visible{outline-color:var(--appearance-control)!important}
        .dsh-appearance-disclosure{width:100%;min-width:0;margin:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dsh-appearance-disclosure>summary{display:flex;align-items:center;gap:12px;padding:14px 0;cursor:pointer;list-style:none;font-size:14px;color:var(--dsw-alias-label-primary)}
        .dsh-appearance-disclosure>summary::-webkit-details-marker{display:none}
        .dsh-appearance-disclosure>summary:after{content:'';width:6px;height:6px;border-right:1.5px solid;border-bottom:1.5px solid;transform:rotate(45deg);margin:0 4px 3px auto;transition:transform .16s ease}
        .dsh-appearance-disclosure[open]>summary:after{transform:rotate(225deg);margin-bottom:-3px}
        .dsh-appearance-disclosure>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:8px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-settings{width:100%;padding:0 0 16px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-group:first-child{border-top:0;padding-top:4px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-palette-card{background:transparent;border-color:var(--dsw-alias-border-l2);padding:16px;border-radius:16px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-color-field{min-height:40px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-settings input[type=color]{width:42px;height:28px;padding:4px;border-radius:999px;corner-shape:round}
        .dsh-appearance-disclosure input[type=color]::-webkit-color-swatch-wrapper{padding:0}
        .dsh-appearance-disclosure input[type=color]::-webkit-color-swatch{border:0;border-radius:999px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-font-grid{grid-template-columns:1fr;gap:12px}
        .dsh-appearance-disclosure .dsh-desktop-appearance-font-grid>label{display:grid;grid-template-columns:100px minmax(0,1fr);align-items:center}
        .dsh-appearance-disclosure .dsh-desktop-appearance-font-grid input{border-radius:12px;height:36px}
        .dsh-appearance-disclosure :is(.dsh-desktop-appearance-action,.dsh-desktop-appearance-reset){border-radius:999px;corner-shape:round;min-height:34px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center}
        .dsh-appearance-disclosure button:disabled{opacity:.4;cursor:default}
        .dsh-appearance-disclosure .dsh-desktop-appearance-preview{display:none}
        @media(max-width:640px){.dsh-appearance-disclosure .dsh-desktop-appearance-palette{grid-template-columns:1fr}}
        .dsh-desktop-appearance-settings {
          box-sizing: border-box;
          width: min(760px, 100%);
          padding: 4px 0 24px;
          color: var(--dsw-alias-label-primary, #0f1115);
          font-family: var(--dsw-font-family, system-ui, sans-serif);
        }
        .dsh-desktop-appearance-settings *,
        .dsh-desktop-appearance-settings *::before,
        .dsh-desktop-appearance-settings *::after { box-sizing: border-box; }
        .dsh-desktop-appearance-heading { margin: 0 0 6px; font-size: 20px; line-height: 28px; font-weight: 650; letter-spacing: -0.015em; }
        .dsh-desktop-appearance-description { margin: 0 0 22px; max-width: 70ch; color: var(--dsw-alias-label-secondary, #545557); font-size: 13px; line-height: 20px; }
        .dsh-desktop-appearance-group { padding: 18px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); }
        .dsh-desktop-appearance-group-title { margin: 0 0 12px; color: var(--dsw-alias-label-primary, #0f1115); font-size: 14px; line-height: 20px; font-weight: 620; }
        .dsh-desktop-appearance-help { margin: -5px 0 12px; color: var(--dsw-alias-label-tertiary, #65676b); font-size: 12px; line-height: 18px; }
        .dsh-desktop-appearance-theme-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .dsh-desktop-appearance-theme-button,
        .dsh-desktop-appearance-action,
        .dsh-desktop-appearance-reset { min-height: 36px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15)); border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #545557); font: inherit; font-size: 13px; cursor: pointer; transition: border-color .15s ease, background-color .15s ease, color .15s ease; }
        .dsh-desktop-appearance-theme-button:hover,
        .dsh-desktop-appearance-action:hover,
        .dsh-desktop-appearance-reset:hover { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dsw-alias-label-primary, #0f1115); }
        .dsh-desktop-appearance-theme-button[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, var(--dsw-alias-bg-layer-1, #fff)); color: var(--dsw-alias-label-primary, #0f1115); }
        .dsh-desktop-appearance-theme-button:focus-visible,
        .dsh-desktop-appearance-action:focus-visible,
        .dsh-desktop-appearance-reset:focus-visible,
        .dsh-desktop-appearance-settings input:focus-visible,
        .dsh-desktop-appearance-settings textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset: 2px; }
        .dsh-desktop-appearance-palette { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .dsh-desktop-appearance-palette-card { min-width: 0; padding: 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
        .dsh-desktop-appearance-palette-title { margin: 0 0 12px; color: var(--dsw-alias-label-primary, #0f1115); font-size: 13px; font-weight: 620; }
        .dsh-desktop-appearance-color-field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; min-height: 34px; color: var(--dsw-alias-label-secondary, #545557); font-size: 12px; }
        .dsh-desktop-appearance-color-field + .dsh-desktop-appearance-color-field { margin-top: 8px; }
        .dsh-desktop-appearance-color-field input[type="color"] { width: 32px; height: 26px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15)); border-radius: 7px; background: transparent; cursor: pointer; }
        .dsh-desktop-appearance-color-value { font-family: var(--ds-font-family-code, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary, #65676b); }
        .dsh-desktop-appearance-font-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .dsh-desktop-appearance-font-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; color: var(--dsw-alias-label-secondary, #545557); font-size: 12px; }
        .dsh-desktop-appearance-font-field input,
        .dsh-desktop-appearance-settings textarea { width: 100%; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15)); border-radius: 8px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #0f1115); font: inherit; }
        .dsh-desktop-appearance-font-field input { min-height: 36px; padding: 0 10px; }
        .dsh-desktop-appearance-settings textarea { min-height: 128px; padding: 10px; resize: vertical; font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px; }
        .dsh-desktop-appearance-range-row { display: grid; grid-template-columns: minmax(0, 1fr) 68px; align-items: center; gap: 14px; }
        .dsh-desktop-appearance-range-row input[type="range"] { width: 100%; accent-color: var(--dsw-alias-state-business-primary, #4176e6); }
        .dsh-desktop-appearance-range-value { min-width: 0; text-align: right; color: var(--dsw-alias-label-secondary, #545557); font-family: var(--ds-font-family-code, monospace); font-size: 12px; }
        .dsh-desktop-appearance-check-row { display: flex; align-items: flex-start; gap: 9px; color: var(--dsw-alias-label-primary, #0f1115); font-size: 13px; line-height: 20px; cursor: pointer; }
        .dsh-desktop-appearance-check-row input { margin-top: 3px; accent-color: var(--dsw-alias-state-business-primary, #4176e6); }
        .dsh-desktop-appearance-json-actions,
        .dsh-desktop-appearance-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
        .dsh-desktop-appearance-json-actions { margin-top: 10px; }
        .dsh-desktop-appearance-action.primary { border-color: var(--dsw-alias-state-business-primary, #4176e6); background: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dsw-alias-label-primary-foreground, #fff); }
        .dsh-desktop-appearance-action.primary:hover { filter: brightness(1.06); color: var(--dsw-alias-label-primary-foreground, #fff); }
        .dsh-desktop-appearance-footer { justify-content: flex-end; padding-top: 18px; }
        .dsh-desktop-appearance-reset { margin-right: auto; border-color: transparent; background: transparent; color: var(--dsw-alias-label-tertiary, #65676b); }
        .dsh-desktop-appearance-status { min-height: 20px; margin: 12px 0 0; color: var(--dsw-alias-label-secondary, #545557); font-size: 12px; line-height: 18px; }
        .dsh-desktop-appearance-status[data-error="true"] { color: var(--dsw-alias-state-error-primary, #ec1313); }
        .dsh-desktop-appearance-preview { display: grid; grid-template-columns: 112px minmax(0, 1fr); min-height: 96px; margin-top: 12px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 12px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #0f1115); }
        .dsh-desktop-appearance-preview-sidebar { padding: 12px 10px; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1, #fff)); border-right: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); font-size: 11px; }
        .dsh-desktop-appearance-preview-sidebar div + div { margin-top: 7px; color: var(--dsw-alias-label-secondary, #545557); }
        .dsh-desktop-appearance-preview-content { padding: 14px; font-family: var(--dsh-appearance-content-font-family, var(--dsw-font-family, system-ui)); font-size: 12px; line-height: 18px; }
        .dsh-desktop-appearance-preview-content strong { color: var(--dsw-alias-state-business-primary, #4176e6); }
        @media (max-width: 680px) {
          .dsh-desktop-appearance-settings { padding: 18px 16px 24px; }
          .dsh-desktop-appearance-font-grid { grid-template-columns: 1fr; }
        }
    
        /* Applied only while a validated local appearance layer is active. */
        html body[data-dsh-appearance-custom][data-ds-dark-theme] .dcu-root,
        html body[data-dsh-appearance-custom][data-ds-light-theme] .dcu-root,
        html body[data-dsh-appearance-custom]:not([data-ds-dark-theme]) .dcu-root {
          background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1)) !important;
          color: var(--dsw-alias-label-primary) !important;
          font-family: var(--dsw-font-family) !important;
          
          --dcu-sidebar-primary: var(--dsw-alias-label-primary) !important;
          --dcu-sidebar-secondary: var(--dsw-alias-label-secondary) !important;
          --dcu-sidebar-tertiary: var(--dsw-alias-label-tertiary) !important;
          --dcu-sidebar-navigation: var(--dsw-alias-label-secondary) !important;
          --dcu-sidebar-icon: var(--dsw-alias-label-secondary) !important;
          --dcu-sidebar-hover: var(--dsw-specific-sidebar-nav-item-hover) !important;
          --dcu-sidebar-active: var(--dsw-specific-sidebar-nav-item-active) !important;
          --dcu-sidebar-border: var(--dsw-alias-border-l1) !important;
        }
        html body[data-dsh-appearance-custom][data-ds-dark-theme] .dcu-root :is(.dcu-brand,.dcu-menu button,.dcu-wb-session,.dcu-wb-project-head,.dcu-wb-project-title,.dcu-wb-session-title,.VOzbGW_trigger,[data-dsh-mnemon-entry]),
        html body[data-dsh-appearance-custom][data-ds-light-theme] .dcu-root :is(.dcu-brand,.dcu-menu button,.dcu-wb-session,.dcu-wb-project-head,.dcu-wb-project-title,.dcu-wb-session-title,.VOzbGW_trigger,[data-dsh-mnemon-entry]),
        html body[data-dsh-appearance-custom]:not([data-ds-dark-theme]) .dcu-root :is(.dcu-brand,.dcu-menu button,.dcu-wb-session,.dcu-wb-project-head,.dcu-wb-project-title,.dcu-wb-session-title,.VOzbGW_trigger,[data-dsh-mnemon-entry]) {
          color: var(--dsw-alias-label-primary) !important;
          font-family: var(--dsw-font-family) !important;
        }
        html body[data-dsh-appearance-custom] .dcu-root :is(.dcu-menu button:hover,.dcu-wb-project-head:hover,.dcu-wb-menu-open,.VOzbGW_trigger:hover,[data-dsh-mnemon-entry]:hover) { background: var(--dsw-specific-sidebar-nav-item-hover) !important; }
        html body[data-dsh-appearance-custom] .dcu-root :is(.dcu-wb-selected,[aria-current="page"],[data-active="true"]) { background: var(--dsw-specific-sidebar-nav-item-active) !important; color: var(--dsw-alias-label-primary) !important; }
        html body[data-dsh-appearance-custom] :is(button,input,select,textarea) { font-family: var(--dsw-font-family) !important; }
        html body[data-dsh-appearance-custom], html body[data-dsh-appearance-custom] #root,
        html body[data-dsh-appearance-custom] #dsh-desktop-titlebar { font-family:var(--dsw-font-family)!important; }
        html body[data-dsh-appearance-custom] :is(.dcu-conversation,[data-conversation],.dcu-message,.dcu-turn,[class*="markdown"],[class*="message"]) { font-family: var(--dsh-appearance-content-font-family, var(--dsw-font-family)) !important; }
        html body[data-dsh-appearance-custom] :is(pre,code,kbd,samp,[data-diff],[data-terminal],.cm-editor) { font-family: var(--ds-font-family-code) !important; }
        html body[data-dsh-appearance-custom] .pI_x6G_centerCol:has(.wSkVaW_root) { background: var(--dsw-specific-sidebar-fill) !important; }
        html body[data-dsh-appearance-custom][data-dsh-desktop-titlebar-layout="true"] > #dsh-desktop-titlebar,
        html body[data-dsh-appearance-custom] .pI_x6G_sidebarCol { background: var(--dsw-specific-sidebar-fill) !important; }
        html body[data-dsh-appearance-custom] #dsh-desktop-titlebar button:hover { background: var(--dsw-specific-sidebar-nav-item-hover) !important; }
        /* The absolute right-panel shell extends behind the desktop title bar.
           Its panes keep their opaque fill; the shell must not tint chrome. */
        html body[data-dsh-appearance-custom] .nArs4W_panel { background:transparent!important; }
        html body[data-dsh-desktop-titlebar-layout="true"] .nArs4W_panel { top:40px!important;height:calc(100% - 40px)!important;padding-top:0!important; }
        html body .dcu-root .dcu-settings-seat .VOzbGW_trigger :is([data-slot="settings.trigger"],span,svg) { color:var(--dsw-alias-label-primary)!important; }
        html:has(>body[data-dsh-appearance-custom]) { background:transparent!important; }
        html body[data-dsh-appearance-custom] { background:var(--dsw-specific-sidebar-fill)!important; }
        html body[data-dsh-appearance-custom] #root,
        html body[data-dsh-appearance-custom] #root :is(div,main):has(.dcu-root),
        html body[data-dsh-appearance-custom] .pI_x6G_centerCol:has(.wSkVaW_root),
        html body[data-dsh-appearance-custom][data-dsh-desktop-titlebar-layout="true"] > #dsh-desktop-titlebar,
        html body[data-dsh-appearance-custom]:is([data-ds-dark-theme],:not([data-ds-dark-theme])) .dcu-root { background:transparent!important; }
      `
    
      function installStyle() {
        if (typeof document === 'undefined' || !document.head) return () => {}
        const old = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
        if (old) return () => {}
        const style = document.createElement('style')
        style.dataset.plugin = '@dsh-desktop/integration'
        style.dataset.pluginCss = STYLE_ID
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }
    
      function setCustomMarker(active) {
        if (typeof document === 'undefined' || !document.body) return
        if (active) document.body.setAttribute('data-dsh-appearance-custom', '')
        else document.body.removeAttribute('data-dsh-appearance-custom')
      }
    
      function getPreference() {
        const preference = theme?.getTheme?.()?.preference
        return validThemeIds.has(preference) ? preference : 'system'
      }
    
      let tokenDisposer
      let activeConfig = loadConfig()
    
      function applyConfig(config) {
        if (config !== null) {
          try { config = validateConfig(config) } catch (cause) { return { ok: false, error: cause.message } }
        }
        if (tokenDisposer) {
          tokenDisposer()
          tokenDisposer = undefined
        }
        if (config === null) {
          setCustomMarker(false)
          activeConfig = null
          return { ok: true }
        }
        try {
          const validated = validateConfig(config)
          if (typeof theme?.overrideTokens !== 'function') throw new Error('当前 DSH theme service 不支持 token override')
          tokenDisposer = theme.overrideTokens(SOURCE, buildTokenOverrides(validated))
          setCustomMarker(true)
          activeConfig = validated
          return { ok: true }
        } catch (cause) {
          setCustomMarker(false)
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
        }
      }
    
      function setPreference(preference) {
        if (!validThemeIds.has(preference)) return { ok: false, error: '主题值无效' }
        try {
          if (typeof theme?.setTheme !== 'function') throw new Error('当前 DSH theme service 不支持主题切换')
          // Theme mode is owned exclusively by the always-visible native cards.
          return { ok: true }
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
        }
      }
    
      const removeStyle = installStyle()
      if (activeConfig !== null) {
        const result = applyConfig(activeConfig)
        if (!result.ok) console.warn('[dsh-desktop] Local appearance settings were not applied.', result.error)
      }
    
      function appearancePayload(config, enabled, preference) {
        return JSON.stringify({
          version: 1,
          theme: preference,
          settings: enabled ? config : null,
        }, null, 2)
      }
    
      function ColorField({ label, value, onChange }) {
        return h('label', { className: 'dsh-desktop-appearance-color-field' },
          h('span', null, label, h('span', { className: 'dsh-desktop-appearance-color-value' }, ` ${value}`)),
          h('input', { type: 'color', value, 'aria-label': label, onChange: event => onChange(event.currentTarget.value) }))
      }
    
      function AppearanceSettings() {
        const initialRef = useRef(null)
        if (initialRef.current === null) {
          initialRef.current = { config: activeConfig === null ? null : clone(activeConfig), preference: getPreference() }
        }
        const initial = initialRef.current
        const [draft, setDraft] = useState(() => clone(activeConfig ?? DEFAULTS))
        const [enabled, setEnabled] = useState(() => activeConfig !== null)
        const [preference, setPreferenceState] = useState(initial.preference)
        const [instant, setInstant] = useState(true)
        const [jsonText, setJsonText] = useState(() => appearancePayload(activeConfig ?? DEFAULTS, activeConfig !== null, initial.preference))
        const [feedback, setFeedback] = useState('修改后可即时预览；未保存的预览在取消或离开此页时回退。')
        const [isError, setIsError] = useState(false)
        const dirty = JSON.stringify({ config: enabled ? draft : null, preference }) !== JSON.stringify({ config: initial.config, preference: initial.preference })
        const dirtyRef = useRef(false)
        dirtyRef.current = dirty
    
        useEffect(() => {
          let off
          if (typeof ctx?.on === 'function') {
            off = ctx.on('theme/change', snapshot => {
              const next = validThemeIds.has(snapshot?.preference) ? snapshot.preference : 'system'
              initial.preference = next
              setPreferenceState(next)
            })
          }
          return typeof off === 'function' ? off : undefined
        }, [])
    
        useEffect(() => {
          return () => {
            if (!dirtyRef.current) return
            const configResult = applyConfig(initial.config)
            if (!configResult.ok) console.warn('[dsh-desktop] Could not roll back appearance preview.', configResult.error)
            const themeResult = setPreference(initial.preference)
            if (!themeResult.ok) console.warn('[dsh-desktop] Could not roll back appearance theme preview.', themeResult.error)
          }
        }, [])
    
        const showResult = result => {
          setIsError(!result.ok)
          setFeedback(result.ok ? '' : result.error)
          return result.ok
        }
    
        const preview = (nextDraft, nextEnabled, nextPreference) => {
          if (!instant) return true
          const configResult = applyConfig(nextEnabled ? nextDraft : null)
          if (!configResult.ok) return showResult(configResult)
          if (nextPreference !== getPreference()) {
            const themeResult = setPreference(nextPreference)
            if (!themeResult.ok) return showResult(themeResult)
          }
          setIsError(false)
          setFeedback('即时预览已应用；点击“保存设置”后保留。')
          return true
        }
    
        const updateDraft = updater => {
          const next = updater(clone(draft))
          setDraft(next)
          setEnabled(true)
          setJsonText(appearancePayload(next, true, preference))
          preview(next, true, preference)
        }
    
        const updatePreference = next => {
          setPreferenceState(next)
          setJsonText(appearancePayload(draft, enabled, next))
          preview(draft, enabled, next)
        }
    
        const handleCopy = async () => {
          const value = appearancePayload(draft, enabled, preference)
          try {
            if (typeof globalThis.navigator?.clipboard?.writeText === 'function') await globalThis.navigator.clipboard.writeText(value)
            else {
              const helper = document.createElement('textarea')
              helper.value = value
              helper.style.position = 'fixed'
              helper.style.opacity = '0'
              document.body.append(helper)
              helper.select()
              document.execCommand('copy')
              helper.remove()
            }
            setIsError(false)
            setFeedback('JSON 已复制到剪贴板。')
          } catch (cause) {
            showResult({ ok: false, error: `复制失败：${cause instanceof Error ? cause.message : String(cause)}` })
          }
        }
    
        const handleImport = () => {
          try {
            const parsed = JSON.parse(jsonText)
            if (!isRecord(parsed) || parsed.version !== 1) error('JSON version 必须为 1')
            const nextPreference = parsed.theme === undefined ? preference : parsed.theme
            if (!validThemeIds.has(nextPreference)) error('theme 必须是 system、light 或 dark')
            const nextEnabled = parsed.settings !== null
            const nextDraft = nextEnabled ? validateConfig(parsed.settings ?? parsed) : clone(DEFAULTS)
            setDraft(nextDraft)
            setEnabled(nextEnabled)
            setPreferenceState(nextPreference)
            setJsonText(appearancePayload(nextDraft, nextEnabled, nextPreference))
            if (!preview(nextDraft, nextEnabled, nextPreference)) return
            setIsError(false)
            setFeedback('JSON 已导入到预览；点击“保存设置”后保留。')
          } catch (cause) {
            showResult({ ok: false, error: `JSON 未导入：${cause instanceof Error ? cause.message : String(cause)}` })
          }
        }
    
        const handleReset = () => {
          const next = clone(DEFAULTS)
          setDraft(next)
          setEnabled(false)
          setPreferenceState('system')
          setJsonText(appearancePayload(next, false, 'system'))
          if (instant) {
            const configResult = applyConfig(null)
            const themeResult = setPreference('system')
            if (!configResult.ok) return showResult(configResult)
            if (!themeResult.ok) return showResult(themeResult)
            setFeedback('已恢复 DSH 原生外观预览；点击“保存设置”后保留。')
          } else {
            setIsError(false)
            setFeedback('已准备恢复 DSH 原生外观；点击“保存设置”后生效。')
          }
        }
    
        const handleCancel = () => {
          const configResult = applyConfig(initial.config)
          const themeResult = setPreference(initial.preference)
          setDraft(clone(initial.config ?? DEFAULTS))
          setEnabled(initial.config !== null)
          setPreferenceState(initial.preference)
          setJsonText(appearancePayload(initial.config ?? DEFAULTS, initial.config !== null, initial.preference))
          if (!configResult.ok) return showResult(configResult)
          if (!themeResult.ok) return showResult(themeResult)
          setIsError(false)
          setFeedback('已取消预览，恢复到进入此页时的外观。')
        }
    
        const handleSave = () => {
          let validated = null
          try {
            validated = enabled ? validateConfig(draft) : null
          } catch (cause) {
            return showResult({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
          }
          const configResult = applyConfig(validated)
          if (!configResult.ok) return showResult(configResult)
          const themeResult = setPreference(preference)
          if (!themeResult.ok) {
            applyConfig(initial.config)
            setPreference(initial.preference)
            return showResult(themeResult)
          }
          const stored = persistConfig(validated)
          activeConfig = validated
          initial.config = validated === null ? null : clone(validated)
          initial.preference = preference
          setDraft(clone(validated ?? DEFAULTS))
          setEnabled(validated !== null)
          setJsonText(appearancePayload(validated ?? DEFAULTS, validated !== null, preference))
          setIsError(false)
          setFeedback(stored ? '外观设置已保存到本机。' : '外观已应用，但本机存储不可用；下次启动可能恢复默认。')
        }
    
        return h('section', { className: 'dsh-desktop-appearance-settings', 'data-dsh-desktop-appearance': '' },
          h('div', { className: 'dsh-desktop-appearance-group' },
            h('h3', { className: 'dsh-desktop-appearance-group-title' }, '颜色'),
            h('p', { className: 'dsh-desktop-appearance-help' }, '分别设置浅色和深色主题的强调色、背景色与前景色。'),
            h('div', { className: 'dsh-desktop-appearance-palette' },
              [['light', '浅色主题'], ['dark', '深色主题']].map(([mode, title]) => h('div', { key: mode, className: 'dsh-desktop-appearance-palette-card' },
                h('h4', { className: 'dsh-desktop-appearance-palette-title' }, title),
                h(ColorField, { label: '强调色', value: draft[mode].accent, onChange: value => updateDraft(next => { next[mode].accent = value; return next }) }),
                h(ColorField, { label: '背景色', value: draft[mode].background, onChange: value => updateDraft(next => { next[mode].background = value; return next }) }),
                h(ColorField, { label: '前景色', value: draft[mode].foreground, onChange: value => updateDraft(next => { next[mode].foreground = value; return next }) }))))),
          h('div', { className: 'dsh-desktop-appearance-group' },
            h('h3', { className: 'dsh-desktop-appearance-group-title' }, '字体'),
            h('p', { className: 'dsh-desktop-appearance-help' }, '推荐两套中文字体：Noto Sans SC 清晰利落，Noto Serif SC 适合长文阅读。使用本机字体；未安装时回退到系统字体。'),
            h('div', { className: 'dsh-desktop-appearance-actions' },
              h('button', { type: 'button', className: 'dsh-desktop-appearance-action', onClick: () => updateDraft(next => { next.fonts.ui = 'Noto Sans SC, Microsoft YaHei, sans-serif'; next.fonts.content = next.fonts.ui; return next }) }, '非衬线 · Noto Sans SC'),
              h('button', { type: 'button', className: 'dsh-desktop-appearance-action', onClick: () => updateDraft(next => { next.fonts.ui = 'Noto Serif SC, Songti SC, SimSun, serif'; next.fonts.content = next.fonts.ui; return next }) }, '衬线 · Noto Serif SC')),
            h('div', { className: 'dsh-desktop-appearance-font-grid' },
              [['ui', 'UI 字体'], ['content', '内容字体'], ['code', '代码字体']].map(([key, label]) => h('label', { key, className: 'dsh-desktop-appearance-font-field' },
                h('span', null, label),
                h('input', { value: draft.fonts[key], onChange: event => updateDraft(next => { next.fonts[key] = event.currentTarget.value; return next }), 'aria-label': label })))),
          h('div', { className: 'dsh-desktop-appearance-group' },
            h('h3', { className: 'dsh-desktop-appearance-group-title' }, '标题栏与侧栏'),
            h('div', { className: 'dsh-desktop-appearance-help' }, '标题栏、侧栏与圆角共用透明底层，聊天区保持不透明。Windows 11 22H2 及以上桌面端使用真实窗口透明通道：不透明度越低，越能透出背后的窗口；对比度单独调节底色。'),
            h('label', { className: 'dsh-desktop-appearance-font-field' },
              h('span', null, '外框不透明度（越低越通透）'),
              h('div', { className: 'dsh-desktop-appearance-range-row' },
                h('input', { type: 'range', min: '0.5', max: '1', step: '0.01', value: draft.sidebar.opacity, onChange: event => updateDraft(next => { next.sidebar.opacity = Number(event.currentTarget.value); return next }), 'aria-label': '侧栏透明度' }),
                h('span', { className: 'dsh-desktop-appearance-range-value' }, `${Math.round(draft.sidebar.opacity * 100)}%`))),
            h('label', { className: 'dsh-desktop-appearance-font-field', style: { marginTop: '14px' } },
              h('span', null, '外框对比度'),
              h('div', { className: 'dsh-desktop-appearance-range-row' },
                h('input', { type: 'range', min: '0.8', max: '1.2', step: '0.01', value: draft.sidebar.contrast, onChange: event => updateDraft(next => { next.sidebar.contrast = Number(event.currentTarget.value); return next }), 'aria-label': '侧栏对比度' }),
                h('span', { className: 'dsh-desktop-appearance-range-value' }, `${Math.round(draft.sidebar.contrast * 100)}%`))),
            h('div', { className: 'dsh-desktop-appearance-preview', 'aria-label': '外观即时预览' },
              h('div', { className: 'dsh-desktop-appearance-preview-sidebar' }, h('div', null, '工作区'), h('div', null, '当前任务'), h('div', null, '设置')),
              h('div', { className: 'dsh-desktop-appearance-preview-content' }, h('strong', null, '即时预览'), h('br'), '内容字体与代码字体会分别作用于对应区域。'))),
          h('div', { className: 'dsh-desktop-appearance-group' },
            h('h3', { className: 'dsh-desktop-appearance-group-title' }, '预览与 JSON'),
            h('label', { className: 'dsh-desktop-appearance-check-row' },
              h('input', { type: 'checkbox', checked: instant, onChange: event => { setInstant(event.currentTarget.checked); setFeedback(event.currentTarget.checked ? '即时预览已开启。' : '即时预览已关闭，修改将在保存时生效。') } }),
              h('span', null, '即时预览（修改即生效，未保存离开时回退）')),
            h('textarea', { value: jsonText, onChange: event => setJsonText(event.currentTarget.value), spellCheck: false, 'aria-label': '外观 JSON 设置' }),
            h('div', { className: 'dsh-desktop-appearance-json-actions' },
              h('button', { type: 'button', className: 'dsh-desktop-appearance-action', onClick: handleCopy }, '复制 JSON'),
              h('button', { type: 'button', className: 'dsh-desktop-appearance-action', onClick: handleImport }, '导入 JSON'))),
          h('p', { className: 'dsh-desktop-appearance-status', role: isError ? 'alert' : 'status', 'aria-live': 'polite', 'data-error': isError ? 'true' : 'false' }, feedback),
          h('div', { className: 'dsh-desktop-appearance-footer' },
            h('button', { type: 'button', className: 'dsh-desktop-appearance-reset', onClick: handleReset }, '恢复 DSH 默认'),
            h('button', { type: 'button', className: 'dsh-desktop-appearance-action', disabled: !dirty, onClick: handleCancel }, '取消预览'),
            h('button', { type: 'button', className: 'dsh-desktop-appearance-action primary', disabled: !dirty, onClick: handleSave }, '保存设置'))))
      }
    
      function AppearanceDisclosure() {
        const [host, setHost] = useState(null)
        useEffect(() => {
          let current
          const sync = () => { const next = document.querySelector('._8HJdBW_group'); if (next !== current) { current = next; setHost(next) } }
          sync()
          const observer = new MutationObserver(sync)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => observer.disconnect()
        }, [])
        if (!host) return null
        return require('react-dom').createPortal(
          h('details', { className: 'dsh-appearance-disclosure' },
            h('summary', { 'aria-label': '展开或收起外观选项' }, '更多选项'), h(AppearanceSettings)), host)
      }
      ctx.inject(['slots'], scope => scope.slots.inject('settings.general.item', () => scope.slots.register({
        name: 'settings.general.item',
        id: 'desktop-appearance',
        order: 10.5,
      }, AppearanceDisclosure)))
    
      const dispose = () => {
        if (tokenDisposer) tokenDisposer()
        tokenDisposer = undefined
        setCustomMarker(false)
        removeStyle()
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-desktop: appearance settings')
      return dispose
    }

    function installThemeReporter(ctx) {
      if (typeof bridge.reportTheme !== 'function' || typeof ctx.theme?.getTheme !== 'function') return () => {}

      let reported
      const publish = (snapshot = ctx.theme.getTheme()) => {
        const preference = snapshot?.preference
        const resolved = snapshot?.active?.colorScheme
        if (!['light', 'dark', 'system'].includes(preference) || !['light', 'dark'].includes(resolved)) return
        const fingerprint = `${preference}:${resolved}`
        if (fingerprint === reported) return
        reported = fingerprint
        bridge.reportTheme({ preference, resolved })
      }
      const dispose = ctx.on('theme/change', publish)
      publish()
      return dispose
    }

    function workspaceRows() {
      return Array.from(document.querySelectorAll('[role="treeitem"][aria-expanded]'))
        .filter(row => row.querySelectorAll('button').length >= 2)
    }

    function createMenuAction(template, label, kind, path, intent) {
      const wrapper = template.cloneNode(true)
      wrapper.dataset.dshDesktopAction = kind
      const button = wrapper.querySelector('button[role="menuitem"]')
      if (button === null) return undefined
      button.removeAttribute('disabled')
      button.removeAttribute('aria-expanded')
      button.removeAttribute('aria-haspopup')
      const spans = button.querySelectorAll('span')
      if (spans.length < 2) return undefined
      spans[0].replaceChildren(iconElement(kind))
      spans[1].textContent = label
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        void requestNativeOpen(path, intent).catch((error) => {
          console.warn(`DeepSeek Harness Desktop could not open the workspace with intent ${intent}.`, error)
        })
      })
      return wrapper
    }

    function installWorkspaceMenuActions(workspaces, t) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      let pendingPath
      let pendingAt = 0
      let pendingTimer

      const injectActions = (menu) => {
        if (pendingPath === undefined || performance.now() - pendingAt > 1500) return false
        if (!(menu instanceof HTMLElement) || menu.dataset[WORKSPACE_ACTIONS_MARKER] === 'true') return false
        const viewport = Array.from(menu.children).find(child => child.getAttribute('role') === 'presentation')
        if (!(viewport instanceof HTMLElement)) return false
        const menuItems = Array.from(viewport.children)
          .map(child => child.querySelector(':scope > button[role="menuitem"]'))
          .filter(button => button !== null)
        const labels = menuItems.map(button => button.textContent?.trim())
        const isWorkspaceMenu = menuItems.length === 2
          && ['Rename', '重命名'].includes(labels[0])
          && ['Delete workspace', '删除工作区'].includes(labels[1])
        if (!isWorkspaceMenu) return false
        const template = menuItems[0].parentElement
        if (!(template instanceof HTMLElement)) return false

        const editor = createMenuAction(template, t('open.editor'), 'editor', pendingPath, 'editor')
        const fileManager = createMenuAction(template, t('open.fileManager'), 'fileManager', pendingPath, 'default')
        if (editor === undefined || fileManager === undefined) return false
        const separator = document.createElement('div')
        separator.className = 'dshDesktopWorkspaceSeparator'
        separator.setAttribute('role', 'separator')
        const fragment = document.createDocumentFragment()
        fragment.append(editor, fileManager, separator)
        viewport.prepend(fragment)
        menu.dataset[WORKSPACE_ACTIONS_MARKER] = 'true'
        pendingPath = undefined
        clearTimeout(pendingTimer)
        return true
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue
            if (node.getAttribute('role') === 'menu' && injectActions(node)) return
            for (const menu of node.querySelectorAll('[role="menu"]')) {
              if (injectActions(menu)) return
            }
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })

      const captureWorkspaceMenu = (event) => {
        if (!(event.target instanceof Element)) return
        const button = event.target.closest('button')
        const row = button?.closest('[role="treeitem"][aria-expanded]')
        if (button === null || row === null) return
        const buttons = Array.from(row.querySelectorAll('button'))
        if (buttons.length < 2 || buttons[0] !== button) return
        const rows = workspaceRows()
        const index = rows.indexOf(row)
        const workspace = index < 0 ? undefined : workspaces.list.getSnapshot().items[index]
        if (typeof workspace?.path !== 'string') return
        pendingPath = workspace.path
        pendingAt = performance.now()
        clearTimeout(pendingTimer)
        pendingTimer = setTimeout(() => {
          pendingPath = undefined
        }, 1500)
      }
      document.addEventListener('click', captureWorkspaceMenu, true)

      return () => {
        clearTimeout(pendingTimer)
        observer.disconnect()
        document.removeEventListener('click', captureWorkspaceMenu, true)
      }
    }

    function apply(ctx) {
      if (bridge === undefined
        || typeof bridge.openPath !== 'function'
        || typeof bridge.publishWorkspaceContext !== 'function') return

      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-desktop: browser dictionaries')
      const t = ctx.locale.bind(NS)

      installComposerServiceCompatibility(ctx)
      installAppearanceSettings(ctx)

      ctx.effect(installStyle, 'dsh-desktop: native action styles')
      ctx.effect(installLayoutCompatibility, 'dsh-desktop: sidebar and settings layout compatibility')
      ctx.effect(installCodexTaskBoardBridge, 'dsh-desktop: Codex task-board bridge')
      ctx.effect(installNativeSettingsDocumentBridge, 'dsh-desktop: native settings document')
      ctx.effect(installManagedMarketUpdateBridge, 'dsh-desktop: managed market updates')
      ctx.effect(() => installThemeReporter(ctx), 'dsh-desktop: native title-bar theme')
      ctx.effect(installUpdateButton, 'dsh-desktop: DSH update action')
      ctx.effect(() => installNotificationCompatibility(ctx.sessions), 'dsh-desktop: notification compatibility')

      // Harness exposes a slot for the header utility, but not for children of
      // the Workspace ellipsis menu. Keep this adapter scoped to that portal.
      ctx.effect(() => installWorkspaceMenuActions(ctx.workspaces, t), 'dsh-desktop: workspace menu actions')

      ctx.effect(() => {
        const workspaces = ctx.workspaces
        const sessions = ctx.sessions
        const originalOpenPath = workspaces.openPath
        const hadOwnOpenPath = Object.hasOwn(workspaces, 'openPath')

        const openPath = async (path) => {
          let result
          try {
            result = await bridge.openPath(path, 'auto')
          } catch (error) {
            console.warn('DeepSeek Harness Desktop path bridge failed; falling back to the Harness opener.', error)
            return originalOpenPath.call(workspaces, path)
          }
          if (result?.ok !== true) throw new Error(result?.error ?? 'Desktop path open failed')
        }

        const publish = () => {
          const sessionState = sessions.list.getSnapshot()
          const workspaceState = workspaces.list.getSnapshot()
          const currentPath = sessionEntries(sessionState)
            .find(([sessionId]) => sessionId === sessionState.current)?.[1]?.cwd
          const recentPath = workspaceState.recentWorkspaceId === undefined
            ? undefined
            : workspaceState.items.find(workspace => workspace.workspaceId === workspaceState.recentWorkspaceId)?.path
          const active = currentPath ?? recentPath
          bridge.publishWorkspaceContext({
            active,
            roots: workspaceState.items.map(workspace => workspace.path),
          })
        }

        workspaces.openPath = openPath
        const unsubscribeSessions = sessions.list.subscribe(publish)
        const unsubscribeWorkspaces = workspaces.list.subscribe(publish)
        publish()

        return () => {
          unsubscribeSessions()
          unsubscribeWorkspaces()
          if (workspaces.openPath === openPath) {
            if (hadOwnOpenPath) workspaces.openPath = originalOpenPath
            else delete workspaces.openPath
          }
        }
      }, 'dsh-desktop: native path adapter')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
