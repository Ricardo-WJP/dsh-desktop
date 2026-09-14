'use strict'
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const output = resolve(process.argv[2] || join(root, 'output/composer-layout-smoke'))
const isolated = mkdtempSync(join(tmpdir(), 'dsh-composer-layout-'))
app.setPath('userData', isolated)
app.disableHardwareAcceleration()
const adapter = readFileSync(join(root, 'src/plugins/dsh-desktop-integration/lib/client.js'), 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#141414;color:#eee;font:14px system-ui}button{height:28px;background:#303134;color:inherit;border:0;border-radius:6px;corner-shape:squircle}
.wSkVaW_root{height:720px;--dsh-chat-content-width:var(--dsh-chat-user-width,748px);--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px);position:relative;display:flex;flex-direction:column}
[data-conversation-scroll]{height:100%;display:flex;flex-direction:column;position:relative;--dsh-composer-height:160px}
[data-fixture-transcript]{box-sizing:border-box;width:var(--dsh-chat-content-width);max-width:calc(100% - 64px);margin:auto;padding:20px;background:#202124;flex:1}
[data-composer-seat]{height:160px;flex:none;padding-top:8px;box-sizing:border-box}
.input_root{padding:0 16px;display:flex;justify-content:center}[data-composer-card]{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);height:150px;background:#292a2d;border:1px solid #666;border-radius:22px;padding:16px;display:flex;flex-direction:column;justify-content:space-between}
.native_row,.native_tools,.native_trailing{display:flex;align-items:center;gap:8px}[data-slot]{display:contents}.native_modes{display:flex;gap:6px}
[data-width-handle]{position:absolute;top:0;bottom:0;width:16px;background:#393b40}
[data-side=left]{right:calc(50% + var(--dsh-chat-content-width)/2 + 10px)}[data-side=right]{left:calc(50% + var(--dsh-chat-content-width)/2 + 10px)}
</style></head><body><div class="wSkVaW_root" data-phase="active"><div data-conversation-scroll><div data-fixture-transcript>聊天记录 · 与输入框同步调节宽度</div><div data-composer-seat><div class="input_root"><div data-composer-card><div contenteditable="true">布局验收草稿，不发送</div><div class="native_row"><div class="native_tools"><button aria-label="附件">＋</button><div class="native_modes"><button>工作区内修改</button></div><div data-slot="conversation.input.left"><button class="meme-trigger" aria-label="表情"></button><button class="stt-mic-btn" aria-label="语音"></button><div class="dyn-opt-root"><button class="dyn-opt-main"></button><button class="dyn-opt-gear"></button></div></div></div><div class="native_trailing"><div data-slot="conversation.input.model"><button data-fixture-model>测试模型</button></div><span data-fixture-context><button aria-label="上下文占用" aria-haspopup="dialog"></button></span><button data-fixture-send aria-label="发送" style="width:36px;height:36px"></button></div></div></div></div></div></div><div data-width-handle="left" data-side="left"></div><div data-width-handle="right" data-side="right"></div></div></body></html>`
app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true })
  const file = join(isolated, 'fixture.html')
  writeFileSync(file, html)
  const window = new BrowserWindow({ show: false, width: 1280, height: 760, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const report = { scope: 'real adapter and browser DOM, synthetic composer', checks: [], ok: false }
  report.consoleErrors = []
  window.webContents.on('console-message', event => { if (event.level === 'error') report.consoleErrors.push(event.message) })
  try {
    await window.loadFile(file)
    await window.webContents.executeJavaScript(`globalThis.dshDesktop={openPath(){},publishWorkspaceContext(){}};globalThis.__ModuleLoader__={load(spec){globalThis.fixtureAdapter=spec.factory(()=>({}))}};` + adapter)
    await window.webContents.executeJavaScript(`globalThis.fixtureDisposers=[];globalThis.fixtureEffects=[];fixtureAdapter.apply({locale:{bind:()=>x=>x},effect(fn,label){fixtureEffects.push(label);if(label.includes('native action styles')||label.includes('sidebar and settings layout'))fixtureDisposers.push(fn())}})`)
    report.adapter = await window.webContents.executeJavaScript(`({effects:fixtureEffects,styles:[...document.querySelectorAll('style')].map(s=>s.id),bridge:typeof dshDesktop.openPath})`)
    for (const viewport of [1280, 760]) for (const panel of [false, true]) for (const width of [680, 900]) {
      window.setContentSize(viewport, 760)
      await window.webContents.executeJavaScript(`document.body.toggleAttribute('data-dsh-desktop-panel-open',${panel});if(${panel})document.body.setAttribute('data-dsh-desktop-panel-open','true');document.querySelector('[data-phase]').style.setProperty('--dsh-chat-user-width','${width}px');`)
      await window.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 150))
      const result = await window.webContents.executeJavaScript(`(() => {
        const box=s=>document.querySelector(s).getBoundingClientRect().toJSON();
        return { transcript:box('[data-fixture-transcript]'),card:box('[data-composer-card]'),seat:box('[data-composer-seat]'),handle:box('[data-width-handle]'),model:box('[data-fixture-model]'),context:box('[data-fixture-context]'),send:box('[data-fixture-send]'),forcedStyleMarkers:document.querySelectorAll('[data-dsh-desktop-composer-control],[data-dsh-desktop-settings-control],.dshDesktopComposerActionButton').length,draft:document.querySelector('[contenteditable]').textContent};})()`)
      report.lastMeasurement = result
      assert.ok(Math.abs(result.card.width - result.transcript.width) <= 1, 'composer must match transcript width')
      assert.ok(result.handle.bottom <= result.seat.top - 8, 'width handle must end above composer')
      assert.ok(result.model.right <= result.context.left && result.context.right <= result.send.left, 'context follows model and precedes send')
      assert.equal(result.forcedStyleMarkers, 0, 'desktop integration must leave native button styling untouched')
      assert.equal(result.draft, '布局验收草稿，不发送')
      report.checks.push({ viewport, panel, width, result })
    }
    window.setContentSize(1280, 760)
    await window.webContents.executeJavaScript(`(() => {
      const left=document.querySelector('[data-slot="conversation.input.left"]');
      for(const label of ['插件操作 A','插件操作 B']){const b=document.createElement('button');b.textContent=label;b.style.width='200px';left.append(b)}
    })()`)
    await new Promise(resolve => setTimeout(resolve, 150))
    const floor = await window.webContents.executeJavaScript(`Number(document.querySelector('[data-phase]').dataset.dshDesktopChatMinWidth)`)
    assert.ok(floor > 640, 'minimum grows with added toolbar controls')
    await window.webContents.executeJavaScript(`(() => {
      const root=document.querySelector('[data-phase]'),handle=document.querySelector('[data-width-handle="left"]');
      handle.addEventListener('pointerup',()=>{root.style.setProperty('--dsh-chat-user-width','640px');localStorage.setItem('dsh.conversation.contentWidth','640')},{once:true});
      handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,pointerId:41,clientX:100,clientY:200}));
      handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,buttons:1,pointerId:41,clientX:1100,clientY:200}));
      handle.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:41,clientX:1100,clientY:200}));
    })()`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const minimumResult = await window.webContents.executeJavaScript(`({width:document.querySelector('[data-composer-card]').getBoundingClientRect().width,stored:Number(localStorage.getItem('dsh.conversation.contentWidth'))})`)
    assert.ok(minimumResult.width + 1 >= floor)
    assert.ok(minimumResult.stored >= floor)
    report.dynamicMinimum = { floor, ...minimumResult, clamped: true }
    writeFileSync(join(output, 'composer.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript('fixtureDisposers.forEach(dispose=>dispose?.())')
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('[data-dsh-desktop-composer-control],[data-dsh-desktop-conversation-layout]').length"), 0)
    report.ok = true
  } catch (error) { report.error = error.stack }
  finally { writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ok:report.ok,error:report.error,checks:report.checks.length})); window.destroy(); app.exit(report.ok ? 0 : 1) }
})
