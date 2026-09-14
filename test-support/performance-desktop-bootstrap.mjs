// Test-only Electron entry. Never imported by the product or packaged.
import { app, BrowserWindow, dialog, powerSaveBlocker } from 'electron'
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createStableSupervisor } from './src/runtime/stable-supervisor.js'
import { markOnboardingCompleted, onboardingMarkerPath } from './src/onboarding.js'
const config=JSON.parse(readFileSync(process.argv[2],'utf8'))
const home=resolve(config.home),runtimeRoot=resolve(config.runtimeRoot),out=resolve(config.output)
if(!home.includes('dsh-performance-')||!runtimeRoot.includes('dsh-performance-runtime-')||!out.includes('performance'))throw Error('Unsafe test configuration')
mkdirSync(out,{recursive:true})
for(const name of ['userData','sessionData','logs','temp','downloads','documents','desktop']){
  const p=join(home,name);mkdirSync(p,{recursive:true});app.setPath(name,p)
}
app.setPath('home',home)
const keep=new Set(['path','pathext','systemroot','windir','comspec','number_of_processors','processor_architecture','programfiles','programfiles(x86)','programdata','allusersprofile','os'])
for(const key of Object.keys(process.env))if(!keep.has(key.toLowerCase()))delete process.env[key]
Object.assign(process.env,{USERPROFILE:home,HOME:home,APPDATA:join(home,'userData'),LOCALAPPDATA:join(home,'local'),TEMP:join(home,'temp'),TMP:join(home,'temp'),DSH_HOME:config.dataHome,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'})
markOnboardingCompleted(onboardingMarkerPath(app.getPath('userData')))
markOnboardingCompleted(onboardingMarkerPath(join(app.getPath('userData'),'plugin-suite')))
globalThis.__dshPerformanceRuntimeRoot=runtimeRoot
async function freePort(){const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(config.port??0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));return p}
globalThis.__dshPerformanceStableFactory=o=>createStableSupervisor({...o,portAllocator:freePort})
if(config.debugPort)app.commandLine.appendSwitch('remote-debugging-port',String(config.debugPort))
const started=Date.now(),events=[],operations=[]
let sampleCount=0
let owner,win,timer,blocker,finished=false
const delay=ms=>new Promise(r=>setTimeout(r,ms))
const event=(type,data={})=>{const e={type,elapsedMs:Date.now()-started,...data};events.push(e);appendFileSync(join(out,'events.jsonl'),JSON.stringify(e)+'\n')}
dialog.showErrorBox=(title,content)=>{event('startup-error',{title,content});void finish(false,'startup error')}
app.on('browser-window-created',(_,w)=>{event('window-created');w.on('show',()=>event('window-shown'));})
async function evaluate(expression){
  let t
  try{return await Promise.race([win.webContents.executeJavaScript(expression),new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('Renderer evaluation timeout')),10000)})])}
  finally{clearTimeout(t)}
}
async function finish(ok,reason){
  if(finished)return;finished=true;clearInterval(timer)
  if(blocker!==undefined&&powerSaveBlocker.isStarted(blocker))powerSaveBlocker.stop(blocker)
  writeFileSync(join(out,'result.json'),JSON.stringify({ok,reason,mode:'production renderer and matched managed runtime, source Electron host, no real credentials; installation disabled',config,events,sampleCount,operations},null,2))
  try{await owner?.runtimeController?.shutdown(new Error('Performance trial complete'))}finally{app.quit()}
}
async function sample(phase){
  const s={elapsedMs:Date.now()-started,phase,focused:win.isFocused(),visible:win.isVisible(),metrics:app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,cpu:p.cpu,memory:p.memory}))}
  s.dom=await evaluate(`({elements:document.querySelectorAll('*').length,patches:window.__dshShellUiPatchCount||0,visibility:document.visibilityState,viewport:[innerWidth,innerHeight]})`)
  sampleCount++;appendFileSync(join(out,'samples.jsonl'),JSON.stringify(s)+'\n')
}
async function capture(name){
  // Fixed animation time for pixel comparison only, outside measured phases.
  await evaluate(`window.__perfAnimations=document.getAnimations().map(a=>({a,running:a.playState==='running',time:a.currentTime}));for(const x of window.__perfAnimations){x.a.pause();x.a.currentTime=1000};void 0`)
  await delay(60)
  writeFileSync(join(out,name+'.png'),(await win.webContents.capturePage()).toPNG())
  await evaluate(`for(const x of window.__perfAnimations||[]){x.a.currentTime=x.time;if(x.running)x.a.play()}delete window.__perfAnimations;void 0`)
}
async function click(selector){const end=Date.now()+3000;do{if(await evaluate(`(()=>{const b=window.__perfElement(${JSON.stringify(selector)});if(!b||b.disabled)return false;b.click();return true})()`))return true;await delay(50)}while(Date.now()<end);return false}
async function clickText(scope,text){return evaluate(`(()=>{const b=window.__perfElement(${JSON.stringify(scope)}+' button',${JSON.stringify(text)});if(!b)return false;b.click();return true})()`)}
async function waitFor(selector,exists=true){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)===exists)return;await delay(60)}throw Error('Expected UI state: '+selector)}
async function selectModel(label){
  const open=()=>evaluate(`document.querySelector('.re-model-trigger')?.getAttribute('aria-expanded')==='true'`)
  if(await evaluate(`document.querySelector('.re-model-trigger')?.textContent.includes(${JSON.stringify(label)})`)){
    if(await open())await click('.re-model-trigger')
    return
  }
  if(!await open()&&!await click('.re-model-trigger'))throw Error('Model trigger missing')
  await delay(350)
  await click('.re-model-row');await delay(350)
  await evaluate(`(()=>{const b=[...document.querySelectorAll('.re-model-option')].find(x=>x.textContent.replace(/✓/g,'').trim()===${JSON.stringify(label)});b?.scrollIntoView({block:'nearest'});return Boolean(b)})()`)
  await delay(100)
  const selected=await evaluate(`(()=>{const b=window.__perfElement('.re-model-option',${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`)
  if(!selected)throw Error('Test model missing: '+label+' '+JSON.stringify(await evaluate(`[...document.querySelectorAll('.re-model-option')].map(x=>x.textContent.trim())`)))
  const deadline=Date.now()+5000
  while(Date.now()<deadline){if(await evaluate(`document.querySelector('.re-model-trigger')?.textContent.includes(${JSON.stringify(label)})&&document.querySelector('.re-model-menu')?.getAttribute('aria-busy')!=='true'`))break;await delay(50)}
  if(!await evaluate(`document.querySelector('.re-model-trigger')?.textContent.includes(${JSON.stringify(label)})`))throw Error('Model selection not applied: '+label)
  // The existing picker intentionally returns to its effort pane on select.
  // Close that pane before the next independent action rather than toggling it.
  if(await open())await click('.re-model-trigger')
  await delay(120)
}
async function testUpdateCards(index){
  const d=index%4===1||index%4===3,a=index%4===2||index%4===3
  win.webContents.send('dsh-desktop:updates-changed',{dsh:{currentVersion:config.expectedVersion,targetVersion:'0.1.5-rc.2',state:d?'available':'current',hasUpdate:d,canUpdate:d},desktop:{currentVersion:'0.1.57',targetVersion:'0.1.58',state:a?'available':'current',hasUpdate:a,canUpdate:a},busy:false})
  await delay(80)
  if(!d&&!a){await waitFor('.dshDualUpdateEntry',false);return}
  if(!await click('.dshDualUpdateEntry'))throw Error('Update entry missing')
  await waitFor('.dshDualUpdateDialog[open]')
  const checks=await evaluate(`[...document.querySelectorAll('.dshDualUpdateDialog input[type=checkbox]')].map(x=>x.checked)`)
  if(JSON.stringify(checks)!==JSON.stringify([d&&!a,a]))throw Error('Update selection default changed')
  if(!await clickText('.dshDualUpdateDialog','关闭'))throw Error('Update dialog close missing')
}
async function cycle(index){
  const t=Date.now()
  if(!await click('.dcu-settings-trigger'))throw Error('Settings entry missing')
  await waitFor('nav.dcu-settings-nav')
  await clickText('nav.dcu-settings-nav','常规')
  await delay(120)
  const settingsOpened=Date.now()-t
  // Themes use the actual existing controls; absent controls are failures.
  if(!await clickText('.dcu-settings-main','浅色'))throw Error('Light theme control missing')
  await delay(180)
  if(index===0)await capture('settings-light')
  if(!await clickText('.dcu-settings-main','深色'))throw Error('Dark theme control missing')
  await delay(180)
  if(index===0)await capture('settings-dark')
  const initialWidth=await evaluate(`document.querySelector('nav.dcu-settings-nav').getBoundingClientRect().width`)
  for(const delta of [20,-20]){
    const point=await evaluate(`(()=>{const r=document.querySelector('nav.dcu-settings-nav').getBoundingClientRect();return{x:Math.round(r.right-4),y:Math.round(r.top+110)}})()`)
    win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1})
    win.webContents.sendInputEvent({type:'mouseMove',x:point.x+delta,y:point.y})
    win.webContents.sendInputEvent({type:'mouseUp',x:point.x+delta,y:point.y,button:'left',clickCount:1})
    await delay(120)
  }
  const finalWidth=await evaluate(`document.querySelector('nav.dcu-settings-nav').getBoundingClientRect().width`)
  if(Math.abs(finalWidth-initialWidth)>1)throw Error('Sidebar width did not restore')
  win.setContentSize(1100,760);await delay(180)
  const fits=await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`)
  if(!fits)throw Error('Unexpected page horizontal overflow')
  if(index===0)await capture('settings-narrow')
  win.setContentSize(1400,900);await delay(180)
  if(!await clickText('nav.dcu-settings-nav','Signal 用量'))throw Error('Usage page missing')
  await delay(500)
  const usage=await evaluate(`document.querySelector('.dcu-settings-main')?.innerText.slice(0,700)||''`)
  if(usage.length<20)throw Error('Usage page did not mount')
  if(index===0)await capture('usage')
  if(!await clickText('nav.dcu-settings-nav','返回应用'))throw Error('Settings return control missing')
  await waitFor('nav.dcu-settings-nav',false)
  await delay(350)
  await selectModel('测试模型 B');await selectModel('测试模型 A')
  await testUpdateCards(index)
  const state=await evaluate(`(()=>{const e=document.querySelector('[data-composer-input]');return {draft:e?.value??e?.textContent??'',focus:document.activeElement?.tagName,nodes:document.querySelectorAll('*').length}})()`)
  if(state.draft!=='性能测试草稿，请勿发送')throw Error('Draft changed during navigation')
  operations.push({index,elapsedMs:Date.now()-started,durationMs:Date.now()-t,settingsOpenedMs:settingsOpened,initialWidth,finalWidth,usage,state})
  appendFileSync(join(out,'operations.jsonl'),JSON.stringify(operations.at(-1))+'\n')
}
const module=await import('./src/main.js')
app.whenReady().then(async()=>{
blocker=powerSaveBlocker.start('prevent-display-sleep')
try{
  const deadline=Date.now()+180000
  let interactive=false
  while(Date.now()<deadline){
    owner=module.performanceTestOwners();win=owner.windowHost?.getWindow('workspace')
    if(win&&!win.isDestroyed()&&owner.runtimeController?.isWorkspaceReady()){
      interactive=await evaluate(`(()=>{const e=document.querySelector('textarea,[data-composer-input],[role=textbox]');return Boolean(e&&!e.disabled&&(e.tagName==='TEXTAREA'||e.isContentEditable))})()`).catch(()=>false)
      if(interactive||config.setupOnly)break
    }
    await delay(250)
  }
  if(!win||!owner.runtimeController?.isWorkspaceReady()||(!config.setupOnly&&!interactive))throw Error('Workspace did not become interactive')
  const version=owner.runtimeController.statusSnapshot().runtime?.version
  if(version!==config.expectedVersion)throw Error(`Wrong measured runtime: ${version}`)
  win.setContentSize(1400,900);win.show();win.focus()
  await evaluate(`window.__perfElement=(selector,text)=>[...document.querySelectorAll(selector)].find(e=>{if(text!==undefined&&e.textContent.replace(/✓/g,'').trim()!==text)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);if(r.width<=0||r.height<=0||s.visibility!=='visible'||s.display==='none')return false;const x=r.x+r.width/2,y=r.y+r.height/2;if(x<0||x>=innerWidth||y<0||y>=innerHeight)return false;const hit=document.elementFromPoint(x,y);return hit===e||e.contains(hit)});void 0`)
  event(config.setupOnly?'setup-shell-ready':'interactive',{version,editorEnabled:interactive,hostPackaged:app.isPackaged,pid:process.pid})
  if(config.setupOnly){event('setup-ready');await delay((config.setupSeconds??600)*1000);await finish(true,'setup complete')}
  else{
    await delay((config.settleSeconds??30)*1000)
    await selectModel('测试模型 A')
    const focused=await evaluate(`(()=>{const e=document.querySelector('[data-composer-input]');if(!e?.isContentEditable)return false;e.focus();const range=document.createRange();range.selectNodeContents(e);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return document.activeElement===e})()`)
    if(!focused)throw Error('Composer focus failed')
    // selectAll() posts an asynchronous edit command. Calling insertText()
    // immediately afterwards can append before selection has taken effect.
    // Await the renderer selection above, then use Chromium's real input path.
    await win.webContents.insertText('性能测试草稿，请勿发送')
    const seeded=await evaluate(`(()=>{const e=document.querySelector('[data-composer-input]');return e?.value??e?.textContent??''})()`)
    if(seeded!=='性能测试草稿，请勿发送')throw Error('Draft fixture initialization failed')
    event('draft-initialized',{characters:seeded.length})
    await capture('chat-dark')
    let phase='idle',sampling=false
    timer=setInterval(()=>{if(sampling)return;sampling=true;sample(phase).catch(e=>event('sample-error',{message:e.message})).finally(()=>{sampling=false})},5000)
    event('idle-start');await delay((config.idleSeconds??1800)*1000);event('idle-end')
    phase='loop';event('loop-start')
    const loopStart=Date.now(),cycles=config.cycles??60,interval=(config.loopSeconds??3600)*1000/cycles
    let index=0
    while(index<cycles){await cycle(index++);await delay(Math.max(0,loopStart+index*interval-Date.now()))}
    event('loop-end',{cycles:index});await sample('complete');await capture('chat-end');await finish(true,'all phases complete')
  }
}catch(e){event('failure',{message:e.stack});if(config.holdOnFailure)await delay(600000);await finish(false,e.message)}
})
