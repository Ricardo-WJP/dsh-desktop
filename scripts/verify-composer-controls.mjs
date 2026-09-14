import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const WebSocket = createRequire(import.meta.url)('ws')
const port = Number(process.argv[2] ?? 9230)
const output = resolve(process.argv[3] ?? 'output/native-hardening-ui')
await mkdir(output, { recursive: true })
const pages = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())
const page = pages.find(p => p.type === 'page' && p.url.startsWith('http://127.0.0.1:3080/'))
assert.ok(page, 'Live authenticated DSH workspace required')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no) })
let seq = 0
const pending = new Map()
ws.on('message', raw => {
  const data = JSON.parse(String(raw)); const p = pending.get(data.id); if (!p) return
  pending.delete(data.id); clearTimeout(p.timer); data.error ? p.no(Error(data.error.message)) : p.yes(data.result)
})
const send = (method, params = {}) => new Promise((yes, no) => {
  const id = ++seq; const timer = setTimeout(() => { pending.delete(id); no(Error(`Timed out: ${method}`)) }, 15000)
  pending.set(id, { yes, no, timer }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const delay = ms => new Promise(r => setTimeout(r, ms))

const results = {}
try {
  await evaluate(`(()=>{const b=document.querySelector('.re-model-trigger');if(!b)throw Error('Reasoning plugin missing');if(b.getAttribute('aria-expanded')!=='true')b.click()})()`)
  await delay(200)
  const original=await evaluate(`(()=>{const e=document.querySelector('.re-effort-input');if(!e)throw Error('Slider missing');return {level:e.getAttribute('aria-valuetext'),value:Number(e.value),max:Number(e.max)}})()`)
  assert.ok(original.max>0,'At least two real reasoning levels are needed')
  async function drag(fraction) {
    const rect=await evaluate(`(()=>{const e=document.querySelector('.re-effort-input'),r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`)
    const x=rect.x+rect.w*Math.max(0.02,Math.min(0.98,fraction)),y=rect.y+rect.h/2
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y})
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1})
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1})
    await delay(800)
    return evaluate(`({value:Number(document.querySelector('.re-effort-input').value),level:document.querySelector('.re-effort-input').getAttribute('aria-valuetext'),error:document.querySelector('.re-effort-sr')?.textContent??null})`)
  }
  const changed=await drag(original.value===0?0.98:0.02)
  assert.notEqual(changed.level,original.level,'Drag must commit a different level')
  assert.equal(changed.error,null)
  const restored=await drag(original.value/original.max)
  assert.equal(restored.level,original.level,'Restore original reasoning level')
  results.slider={original,changed,restored}
  results.motion=await evaluate(`({running:document.getAnimations().filter(a=>a.playState==='running').length,chibi:!!document.querySelector('.re-effort.is-chibi'),canvas:document.querySelector('.re-effort-canvas')?.width})`)
  assert.ok(results.motion.chibi&&results.motion.canvas>0)
  await evaluate(`document.querySelector('.re-model-trigger').click()`)
  results.memory=[]
  for(const compact of [false,true]) {
    await evaluate(`(()=>{const root=document.querySelector('.dcu-root');if(root.classList.contains('dcu-compact')!==${compact}){const b=[...root.querySelectorAll('button')].find(b=>['展开侧边栏','收缩侧边栏','折叠侧边栏'].includes(b.getAttribute('aria-label')||b.title));if(!b)throw Error('Sidebar toggle missing');b.click()}})()`)
    await delay(250)
    const position=await evaluate(`(()=>{const root=document.querySelector('.dcu-root');const a=root.querySelector('[data-dsh-mnemon-entry]');const b=root.querySelector('.dcu-foot button');const x=a.getBoundingClientRect(),y=b.getBoundingClientRect(),r=root.getBoundingClientRect();return {memoryTop:x.top,memoryBottom:x.bottom,settingsTop:y.top,leftGap:x.left-r.left,rightGap:r.right-x.right,count:root.querySelectorAll('[data-dsh-mnemon-entry]').length}})()`)
    assert.equal(position.count,1)
    assert.ok(position.memoryBottom<=position.settingsTop,'Memory entry must sit above settings')
    assert.ok(position.leftGap>=7&&position.rightGap>=7,'Memory button needs safe side spacing')
    results.memory.push({compact,...position})
  }
  await evaluate(`(()=>{const root=document.querySelector('.dcu-root');[...root.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.title)==='展开侧边栏')?.click()})()`)
  await delay(200)
  const shot=await send('Page.captureScreenshot',{format:'png'})
  await writeFile(join(output,'controls.png'),Buffer.from(shot.data,'base64'))
  await writeFile(join(output,'report.json'),JSON.stringify({ok:true,...results},null,2))
  console.log(JSON.stringify({ok:true,...results,report:join(output,'report.json')}))
} finally { ws.close() }
