import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createQuitLifecycle } from '../src/quit-lifecycle.js'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const controller = readFileSync(new URL('../src/desktop-runtime-controller.js', import.meta.url), 'utf8')

test('runtime controller owns shutdown draining while main installs the quit fence', () => {
  assert.match(controller, /const drain = operationCoordinator\.close\(reason\)/)
  assert.match(controller, /const stopServer = lifecycleOwner\.stopAll\(\)/)
  assert.match(controller, /const stopMode = publishedModeOwner/)
  assert.match(controller, /Promise\.allSettled\(\[drain, stopServer, stopMode\]\)/)
  assert.match(main, /createQuitLifecycle/)
  assert.match(main, /quitLifecycle\.handleBeforeQuit\(event\)/)
})

test('before-quit cancels re-entrant events and allows only the final app.quit', async () => {
  const sequence = []
  let beforeQuit
  let releaseShutdown
  let releaseLog
  const shutdown = new Promise(resolve => { releaseShutdown = resolve })
  const logClose = new Promise(resolve => { releaseLog = resolve })
  const runtime = {
    shutdown: reason => {
      sequence.push(['shutdown', reason.message])
      return shutdown
    },
  }
  const app = {
    quit() {
      sequence.push(['app.quit'])
      const event = { preventDefault: () => sequence.push(['prevent-final']) }
      beforeQuit(event)
      return event
    },
  }
  const lifecycle = createQuitLifecycle({
    app,
    getRuntime: () => runtime,
    getLog: () => ({ close: () => { sequence.push(['log.close']); return logClose } }),
  })
  beforeQuit = event => lifecycle.handleBeforeQuit(event)

  const firstEvent = { preventDefault: () => sequence.push(['prevent-first']) }
  assert.equal(beforeQuit(firstEvent), true)
  const secondEvent = { preventDefault: () => sequence.push(['prevent-second']) }
  assert.equal(beforeQuit(secondEvent), true)
  await Promise.resolve()
  assert.deepEqual(sequence, [
    ['prevent-first'],
    ['shutdown', 'Desktop shutdown'],
    ['prevent-second'],
    ['log.close'],
  ])

  releaseShutdown()
  await Promise.resolve()
  assert.equal(sequence.some(entry => entry[0] === 'app.quit'), false)
  releaseLog()
  await lifecycle.pending
  assert.deepEqual(sequence, [
    ['prevent-first'],
    ['shutdown', 'Desktop shutdown'],
    ['prevent-second'],
    ['log.close'],
    ['app.quit'],
  ])
})
