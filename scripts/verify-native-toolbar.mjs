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
const results = []
try {
  for (const width of [1400, 1000, 840]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
    await delay(200)
    const result = await evaluate(`(() => {
      const toolbar=document.querySelector('[data-dsh-desktop-composer-toolbar]');
      if(!toolbar)throw Error('Native model toolbar was not identified');
      const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const all=[...toolbar.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.closest('[role="dialog"],.dyn-opt-pop,.dyn-opt-result'));
      const buttons=all.map(b=>({label:b.getAttribute('aria-label')||b.title||b.textContent,box:box(b),radius:getComputedStyle(b).borderRadius}));
      const collisions=[];for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
        const a=box(all[i]),b=box(all[j]);if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2)collisions.push([i,j]);
      }
      return {width:innerWidth,buttons,collisions,toolbar:box(toolbar),hasNativeModel:!!toolbar.querySelector('[data-slot="conversation.input.model"]'),motionPreference:matchMedia('(prefers-reduced-motion:reduce)').matches};
    })()`)
    const mic=result.buttons.find(b=>b.label.includes('语音输入'))
    const polish=result.buttons.find(b=>b.label.includes('优化当前提示词'))
    const gear=result.buttons.find(b=>b.label==='提示词优化设置')
    const model=result.buttons.find(b=>b.label.startsWith('选择模型')||b.label.startsWith('模型 '))
    assert.ok(mic&&polish&&gear&&model, 'Missing real composer controls')
    assert.equal(result.collisions.length, 0, `Overlapping controls at ${width}`)
    for(const b of [mic,polish,gear])assert.equal(b.radius, '50%')
    assert.ok(result.buttons.every(b=>b.box.left>=result.toolbar.left-2&&b.box.right<=result.toolbar.right+2), `Toolbar clips at ${width}`)
    if(width===1400){assert.ok(mic.box.right<=polish.box.left&&polish.box.right<=gear.box.left&&gear.box.right<=model.box.left);assert.ok(Math.abs(mic.box.top-model.box.top)<=2)}
    results.push(result)
    const shot=await send('Page.captureScreenshot', {format:'png'})
    await writeFile(join(output,`toolbar-${width}.png`),Buffer.from(shot.data,'base64'))
    await evaluate(`document.querySelector('.dyn-opt-gear').click()`)
    await delay(150)
    const pop=await evaluate(`(()=>{const e=document.querySelector('.dyn-opt-pop');if(!e||!e.getClientRects().length)throw Error('Prompt settings failed to open');const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:innerHeight}})()`)
    assert.ok(pop.left>=0&&pop.right<=width+1&&pop.top>=40&&pop.bottom<=pop.viewport,`Prompt settings clipped at ${width}: ${JSON.stringify(pop)}`)
    await evaluate(`document.querySelector('.dyn-opt-gear').click()`)
  }
  const mutations=await evaluate(`new Promise(resolve=>{let count=0;const root=document.querySelector('[data-dsh-desktop-composer-toolbar]');const o=new MutationObserver(r=>{count+=r.length});o.observe(root,{subtree:true,attributes:true,attributeFilter:['class','style']});setTimeout(()=>{o.disconnect();resolve(count)},800)})`)
  assert.ok(mutations<20,`Idle toolbar writes repeatedly: ${mutations}`)
  await writeFile(join(output,'report.json'),JSON.stringify({ok:true,results,idleToolbarMutations:mutations},null,2))
  console.log(JSON.stringify({ok:true,widths:results.map(r=>r.width),idleToolbarMutations:mutations,report:join(output,'report.json')}))
} finally {
  await send('Emulation.clearDeviceMetricsOverride').catch(()=>{})
  ws.close()
}
