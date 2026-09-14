// Real Chromium / synthetic shell fixture. Never connects to production DSH.
const { app, BrowserWindow, session } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const source = resolve(process.argv[2])
const output = resolve(process.argv[3])
const isolated = mkdtempSync(join(tmpdir(), 'dsh-shell-perf-'))
app.setPath('userData', isolated); app.setPath('sessionData', isolated)
const delay = ms => new Promise(r => setTimeout(r, ms))
app.whenReady().then(async () => {
  let win
  try {
    session.defaultSession.webRequest.onBeforeRequest((d,cb) => cb({ cancel: !/^(file:|data:|devtools:)/.test(d.url) }))
    mkdirSync(output, { recursive: true })
    const { installShellUiOverrides } = await import(pathToFileURL(source).href)
    const wc = new EventEmitter(); let injected
    wc.isDestroyed = () => false; wc.executeJavaScript = async s => { injected = s }
    installShellUiOverrides({ webContents: wc }); wc.emit('dom-ready'); await Promise.resolve()
    // Diagnostic-only access to closure owners; never shipped in the app.
    injected = injected.replace('if (document.body) start()', 'window.__probeOwners = () => ({ chrome: Boolean(chromeState.nav && !chromeState.nav.isConnected), width: Boolean(settingsWidthOwner && !settingsWidthOwner.isConnected) }); if (document.body) start()')
    win = new BrowserWindow({ width:1400,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true} })
    const html = `<!doctype html><html><head><style>body{margin:0;background:#141414;color:white;color-scheme:dark;font:14px system-ui}aside{width:240px;height:860px;position:absolute;top:40px;background:#262728}#dsh-desktop-titlebar{height:40px;display:flex}.dshDesktopTitlebarDrag{width:100px}.dcu-settings-page{position:absolute;top:40px;display:grid;grid-template-columns:240px 1fr;width:100%;height:860px}.dcu-settings-nav{background:#262728}.dcu-settings-main{padding:50px}button{color:inherit;background:#333;border:0;padding:8px}nav button{display:block;width:90%;margin:8px}</style></head><body><div id="dsh-desktop-titlebar"><div class="dshDesktopTitlebarDrag">文件</div><div class="dshDesktopTitlebarControls"><button>编辑</button></div></div><aside class="dcu-root"><div class="dcu-settings-seat"><button class="dcu-settings-trigger">设置</button></div></aside><main class="qa_root" style="margin-left:240px;width:1160px;height:860px;background:#141414"><div class="qa_card"><textarea placeholder="输入测试内容"></textarea></div></main></body></html>`
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await win.webContents.executeJavaScript(injected)
    win.showInactive()
    const evalJs = s => win.webContents.executeJavaScript(s)
    const stats = () => evalJs('({patches:window.__dshShellUiPatchCount,nodes:document.querySelectorAll("*").length,owners:window.__probeOwners(),heap:performance.memory.usedJSHeapSize})')
    const open = `(()=>{const p=document.createElement('section');p.className='dcu-settings-page';p.innerHTML='<nav class="dcu-settings-nav"><button>返回应用</button><button>常规</button><button>模型</button></nav><div class="dcu-settings-main"><h1>常规</h1><p>固定合成测试内容</p><input value="保留输入状态"></div>';document.body.append(p)})()`
    await evalJs(open); await delay(1500)
    const before=await stats(); await delay(5000); const after=await stats()
    const png=await win.webContents.capturePage(); writeFileSync(join(output,'settings.png'),png.toPNG())
    const geometry=await evalJs(`Array.from(document.querySelectorAll('.dcu-settings-page,nav.dcu-settings-nav,nav button,input,#dsh-desktop-titlebar')).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,class:e.className,x:r.x,y:r.y,w:r.width,h:r.height,color:s.color,bg:s.backgroundColor,font:s.font,border:s.borderRadius}})`)
    await evalJs('document.querySelector(".dcu-settings-page").remove()'); await delay(200)
    const closed=await stats()
    const cycles=[]
    for(let n=0;n<30;n++) { await evalJs(open); await delay(40); await evalJs('document.querySelector(".dcu-settings-page").remove()'); await delay(40); cycles.push(await stats()) }
    writeFileSync(join(output,'report.json'),JSON.stringify({ mode:'synthetic shell / real Electron, no real DSH backend or plugins',electron:process.versions.electron,before,after,closed,cycles,geometry},null,2))
    console.log(JSON.stringify({output,before,after,closed,last:cycles.at(-1)}))
  }catch(e){console.error(e);process.exitCode=1}finally{win?.destroy();app.quit()}
})
