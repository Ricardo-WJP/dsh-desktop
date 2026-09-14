import assert from 'node:assert/strict'
import test from 'node:test'
import { createDualUpdateManager } from '../src/dual-update.js'

const currentDsh = { latestVersion: '1.0.0' }

test('manual check joins an in-flight scheduled startup retry', async () => {
  const timers=[]
  let calls=0,release
  const pending=new Promise(resolve=>{release=resolve})
  const manager=createDualUpdateManager({getDesktop:()=>null,getDshVersion:()=> '1.0.0',isPackaged:()=>true,
    probeDsh:async()=>{calls++;return calls===1?{busy:true}:pending}, updateDsh:async()=>{},
    setTimer:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer},clearTimer:()=>{}})
  manager.start();timers[0].fn()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(timers[1].delay,15000)
  timers[1].fn()
  const manual=manager.check()
  const observed=calls
  release(currentDsh);await manual;manager.stop()
  assert.equal(observed,2,'one initial busy probe plus one shared retry, not two concurrent retries')
})

test('coalesces concurrent checks into one DSH probe', async () => {
  let probeCalls = 0
  let releaseProbe
  const probePending = new Promise(resolve => { releaseProbe = resolve })
  const manager = createDualUpdateManager({
    getDesktop: () => null,
    getDshVersion: () => '1.0.0',
    isPackaged: () => true,
    probeDsh: async () => {
      probeCalls += 1
      return probePending
    },
    updateDsh: async () => {},
  })

  const first = manager.check()
  const second = manager.check()
  assert.strictEqual(second, first)
  assert.equal(probeCalls, 1)

  releaseProbe(currentDsh)
  await first
})

test('retains one startup scheduler and clears it on stop', () => {
  const timers = []
  const cleared = []
  const manager = createDualUpdateManager({
    getDesktop: () => null,
    getDshVersion: () => '1.0.0',
    isPackaged: () => false,
    probeDsh: async () => currentDsh,
    updateDsh: async () => {},
    setTimer: (fn, delay) => {
      const timer = { fn, delay }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => cleared.push(timer),
  })

  manager.start()
  manager.start()

  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 10_000)

  manager.stop()

  assert.deepEqual(cleared, [timers[0]])
})

test('manager.stop aborts and releases a cooperative pending DSH probe', async () => {
  let observedSignal
  const manager = createDualUpdateManager({
    getDesktop: () => null,
    getDshVersion: () => '1.0.0',
    isPackaged: () => true,
    probeDsh: async ({ signal }) => {
      observedSignal = signal
      return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
    },
    updateDsh: async () => {},
  })

  const checking = manager.check()
  await Promise.resolve()
  manager.stop()

  assert.ok(observedSignal)
  assert.equal(observedSignal.aborted, true)
  await checking
  assert.equal(manager.snapshot().dsh.state,'error')
})
