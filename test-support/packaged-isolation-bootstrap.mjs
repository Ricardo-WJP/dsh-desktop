// Test-only replacement entry in generated win-unpacked; never ship this file.
import { app, BrowserWindow, dialog } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const base = resolve(process.env.DSH_PERF_HOME || '')
if (!/^C:\\tmp\\dsh-performance-[^\\]+$/i.test(base)) throw Error('Explicit isolated test home required')
for (const name of ['home','appdata','local','temp','session','logs','downloads','documents','desktop']) mkdirSync(join(base,name),{recursive:true})
// Capture a startup error instead of blocking this unattended test on the
// application's error box. This interception exists only in this test entry.
dialog.showErrorBox=(title,content)=>{
  writeFileSync(join(base,'startup-error.json'),JSON.stringify({title,content},null,2))
  app.quit()
}
app.setPath('home',join(base,'home'))
app.setPath('userData',join(base,'appdata'))
app.setPath('sessionData',join(base,'session'))
app.setPath('temp',join(base,'temp'))
app.setPath('logs',join(base,'logs'))
for(const name of ['downloads','documents','desktop']) app.setPath(name,join(base,name))
// Do not pass agent/provider credentials or real application-home overrides
// into a fresh test runtime. Retain only Windows executable/tool discovery.
const keep=new Set(['path','pathext','systemroot','windir','comspec','number_of_processors','processor_architecture','os','programfiles','programfiles(x86)','programdata','allusersprofile','username','userdomain'])
for(const key of Object.keys(process.env)) if(!keep.has(key.toLowerCase())) delete process.env[key]
Object.assign(process.env,{
  USERPROFILE:join(base,'home'),DSH_HOME:join(base,'home','dsh'),
  APPDATA:join(base,'appdata'),LOCALAPPDATA:join(base,'local'),
  TEMP:join(base,'temp'),TMP:join(base,'temp'),
})
const start=performance.now()
const rows=[]
app.whenReady().then(()=>{
  const timer=setInterval(()=>{
    rows.push({elapsedMs:performance.now()-start,metrics:app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,cpu:p.cpu,memory:p.memory})),windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),loading:w.webContents.isLoading()}))})
  },5000)
  setTimeout(async()=>{
    clearInterval(timer)
    const windows=[]
    for(const w of BrowserWindow.getAllWindows()){
      let timeout
      try {
        const state=await Promise.race([
          w.webContents.executeJavaScript('(async()=>({ready:document.readyState,inputs:document.querySelectorAll("textarea,[contenteditable=true]").length,title:document.title,bodyLength:document.body?.innerText.length,updates:await window.dshDesktop?.getUpdates?.()}))()'),
          new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Renderer probe timed out after 5s')),5000)}),
        ])
        const url=new URL(w.webContents.getURL())
        windows.push({state,scheme:url.protocol,origin:url.origin})
      }catch(e){windows.push({error:String(e.message)})}finally{clearTimeout(timeout)}
    }
    writeFileSync(join(base,'probe.json'),JSON.stringify({mode:'packaged entry with explicit isolated paths; fresh bundled runtime, NOT the production active runtime baseline',isPackaged:app.isPackaged,version:app.getVersion(),home:app.getPath('home'),userData:app.getPath('userData'),rows,windows},null,2))
    app.quit()
  },60000)
})
await import('./main.performance-original.js')
