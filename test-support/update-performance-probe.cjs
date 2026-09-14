// Chromium microbenchmark for update entry reconciliation; synthetic data only.
const { app, BrowserWindow, session } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const base = resolve(process.argv[2]), output = resolve(process.argv[3])
const isolated = mkdtempSync(join(tmpdir(),'dsh-update-perf-'))
app.setPath('userData',isolated);app.setPath('sessionData',isolated)
const pause = ms => new Promise(r=>setTimeout(r,ms))
app.whenReady().then(async()=>{
  let win
  try{
    session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('data:')}))
    mkdirSync(output,{recursive:true})
    const {updateUiScript}=await import(pathToFileURL(base).href)
    win=new BrowserWindow({width:1400,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true}})
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><style>body{margin:0;color:white;background:#141414;color-scheme:dark}aside{width:240px;height:100vh;background:#202020}.dcu-settings-seat{position:absolute;bottom:8px;width:224px;left:8px}button{color:inherit;background:transparent;border:0;height:36px;text-align:left}main{position:absolute;left:300px;top:50px}</style><aside class="dcu-root"><div class="dcu-settings-seat"><button class="dcu-settings-trigger">设置</button></div></aside><main id="stream"></main>'))
    const ev=s=>win.webContents.executeJavaScript(s)
    await ev(`window.dshDesktop={getUpdates:async()=>({dsh:{state:'current',hasUpdate:false,currentVersion:'1.0.0'},desktop:{state:'available',hasUpdate:true,canUpdate:false,currentVersion:'1.0.0',targetVersion:'1.1.0'},busy:false}),onUpdatesChanged(){}};window.q=0;window.a=0;const original=document.querySelector;document.querySelector=function(...args){window.q++;return original.apply(this,args)};const set=Element.prototype.setAttribute;Element.prototype.setAttribute=function(...args){window.a++;return set.apply(this,args)};void 0`)
    await ev(updateUiScript());win.showInactive();await pause(250)
    // End each mutation batch before the next: reproduces streamed DOM updates.
    const samples=[]
    for(let run=0;run<33;run++) {
      const sample=await ev(`(async()=>{const host=document.getElementById('stream'),q0=q,a0=a,start=performance.now();for(let i=0;i<1000;i++){host.replaceChildren(document.createTextNode('固定合成文本 '+i));await new Promise(r=>queueMicrotask(r))}return{ms:performance.now()-start,queries:q-q0,attributeWrites:a-a0}})()`)
      if(run>=3)samples.push(sample)
    }
    await ev(`document.getElementById('stream').textContent='固定合成文本';document.querySelector('.dshDualUpdateEntry').focus()`);await pause(100)
    const geometry=await ev(`(()=>{const b=document.querySelector('.dshDualUpdateEntry'),s=b.querySelector('svg'),r=b.getBoundingClientRect(),q=s.getBoundingClientRect(),c=getComputedStyle(b);return{width:r.width,height:r.height,dx:q.x+q.width/2-r.x-r.width/2,dy:q.y+q.height/2-r.y-r.height/2,background:c.background,color:c.color,focus:document.activeElement===b}})()`)
    writeFileSync(join(output,'entry.png'),(await win.webContents.capturePage()).toPNG())
    writeFileSync(join(output,'report.json'),JSON.stringify({mode:'synthetic stream microbenchmark, not full app performance',electron:process.versions.electron,samples,geometry},null,2))
  }catch(e){console.error(e);process.exitCode=1}finally{win?.destroy();app.quit()}
})
