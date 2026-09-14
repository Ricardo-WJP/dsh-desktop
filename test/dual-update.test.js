import test from 'node:test'
import assert from 'node:assert/strict'
import { createDualUpdateManager } from '../src/dual-update.js'

function fixture({ dshTarget = '1.0.0', desktopTarget = '1.0.0', dshError, desktopError, dshFail = false, desktopFail = false, packaged = true } = {}) {
  const calls = []; let desktop = { state: 'idle', currentVersion: '1.0.0', hasUpdate: false, canUpdate: false }
  const manager = createDualUpdateManager({ isPackaged: () => packaged, getDshVersion: () => '1.0.0',
    getDesktop: () => ({ snapshot: () => desktop,
      probe: async () => { calls.push('desktop-check'); desktop = desktopError ? { ...desktop, state: 'error', error: 'offline' } : { ...desktop, state: desktopTarget === '1.0.0' ? 'current' : 'available', targetVersion: desktopTarget, hasUpdate: desktopTarget !== '1.0.0', canUpdate: desktopTarget !== '1.0.0' }; return desktop },
      execute: async () => { calls.push('desktop-update'); return desktopFail ? { state: 'error', error: 'download failed' } : { state: 'downloaded' } } }),
    probeDsh: async () => { calls.push('dsh-check'); return dshError ? { error: 'offline' } : { latestVersion: dshTarget } },
    updateDsh: async () => { calls.push('dsh-update'); if(dshFail)throw new Error('candidate rejected') },
  })
  return { manager, calls }
}
for (const [dshTarget, desktopTarget] of [['1.0.0','1.0.0'],['2.0.0','1.0.0'],['1.0.0','2.0.0'],['2.0.0','2.0.0']]) test(`independent versions ${dshTarget}/${desktopTarget}`, async () => {
  const {manager}=fixture({dshTarget,desktopTarget});const s=await manager.check()
  assert.equal(s.dsh.hasUpdate,dshTarget!=='1.0.0');assert.equal(s.desktop.hasUpdate,desktopTarget!=='1.0.0')
})
test('one failed check does not suppress the other update; requests are coalesced', async () => {
  const {manager,calls}=fixture({dshError:true,desktopTarget:'2.0.0'})
  await Promise.all([manager.check(),manager.check()]);assert.equal(calls.filter(x=>x==='dsh-check').length,1)
  assert.equal(manager.snapshot().dsh.state,'error');assert.equal(manager.snapshot().desktop.hasUpdate,true)
})
test('selected updates run DSH first, preserve partial failure, reject duplicate execution', async () => {
  const {manager,calls}=fixture({dshTarget:'2.0.0',desktopTarget:'2.0.0',dshFail:true,desktopFail:true})
  await manager.check();const request={dsh:true,desktop:true,dshVersion:'2.0.0',desktopVersion:'2.0.0'}
  const run=manager.execute(request);assert.throws(()=>manager.execute(request),/正在进行/)
  const r=await run;assert.deepEqual(calls.slice(-2),['dsh-update','desktop-update']);assert.equal(r.dsh.ok,false);assert.equal(r.desktop.ok,false)
  assert.equal(manager.snapshot().busy,false)
})
test('development and stale selections cannot install', async () => {
  const {manager}=fixture({dshTarget:'2.0.0',packaged:false});await manager.check()
  assert.throws(()=>manager.execute({dsh:true,desktop:false,dshVersion:'2.0.0'}),/开发环境/)
  const other=fixture({dshTarget:'2.0.0'}).manager;await other.check()
  assert.throws(()=>other.execute({dsh:true,desktop:false,dshVersion:'3.0.0'}),/变化/)
})
test('a desktop check failure leaves a DSH update available', async () => {
  const { manager } = fixture({ dshTarget: '2.0.0', desktopError: true })
  const result = await manager.check()
  assert.equal(result.dsh.hasUpdate, true)
  assert.equal(result.desktop.state, 'error')
})
test('partial success is retained independently for both execution directions', async () => {
  for (const dshFail of [false, true]) {
    const { manager } = fixture({ dshTarget: '2.0.0', desktopTarget: '2.0.0', dshFail, desktopFail: !dshFail })
    await manager.check()
    const r = await manager.execute({ dsh: true, desktop: true, dshVersion: '2.0.0', desktopVersion: '2.0.0' })
    assert.equal(r.dsh.ok, !dshFail); assert.equal(r.desktop.ok, dshFail)
  }
})
test('only one recurring scheduler is retained and stopped cleanly', () => {
  const timers=[];const cleared=[]
  const manager=createDualUpdateManager({getDesktop:()=>null,getDshVersion:()=>null,isPackaged:()=>false,probeDsh:async()=>({}),updateDsh:async()=>{},setTimer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t},clearTimer:t=>cleared.push(t)})
  manager.start();manager.start();assert.equal(timers.length,1);assert.equal(timers[0].ms,10000)
  manager.stop();assert.equal(cleared.length,1)
})
