import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { DevSupervisor } from '../src/runtime/dev-supervisor.js'
import { ModeSupervisor } from '../src/runtime/mode-supervisor.js'
import { deferred, nextTurn } from '../test-support/runtime-process-fakes.js'

test('ModeSupervisor always initializes on legacy even when switch recipes exist', () => {
  const mode = new ModeSupervisor({ initialMode: 'stable', stable: { recipe: true }, dev: { recipe: true } })
  assert.equal(mode.activeMode, 'legacy')
  assert.equal(mode.status().active, 'legacy')
  assert.equal(mode.status().mode, 'legacy')
  assert.equal(mode.status().state, 'stopped')
})

test('ModeSupervisor keeps the prior active mode through drain and target readiness', async () => {
  const statusEvents = []
  const instances = new Map()
  const make = label => {
    const instance = new EventEmitter()
    const ready = deferred()
    instance.start = async () => {
      instance.emit('status', { state: 'starting' })
      return ready.promise
    }
    instance.stop = async () => { instance.emit('status', { state: 'stopped' }) }
    instance.status = () => ({ state: label === 'stable' ? 'ready' : 'starting' })
    instance.resolveReady = value => { ready.resolve(value); instance.emit('status', { state: 'ready' }) }
    instances.set(label, instance)
    return instance
  }
  const mode = new ModeSupervisor({
    stable: { recipe: true },
    dev: { recipe: true },
    createStable: () => make('stable'),
    createDev: () => make('dev'),
  })
  mode.on('status', event => statusEvents.push(event))
  // Use immediate-ready instances for the initial stable publication.
  const stable = make('stable')
  stable.start = async () => { stable.emit('status', { state: 'ready' }); return 'stable' }
  stable.status = () => ({ state: 'ready' })
  mode.removeAllListeners('status')
  mode.on('status', event => statusEvents.push(event))
  // The factory is replaced through a direct recipe instance so the first
  // activation is deterministic and the dev start remains pending.
  await mode.activate('stable', stable)
  const switching = mode.activate('dev', { start: instances.get('dev')?.start })
  await nextTurn()
  const provisional = mode.status()
  assert.equal(provisional.active, 'stable')
  assert.equal(provisional.target, 'dev')
  assert.equal(provisional.starting, true)
  assert.equal(provisional.state, 'starting')
  const dev = mode.status().dev
  assert.equal(dev.configured, true)
  // The configured factory instance is the pending dev owner.
  const pending = [...instances.values()].find(instance => instance !== stable && instance.listenerCount('status') > 0)
  pending?.resolveReady('dev')
  await switching
  const committed = mode.status()
  assert.equal(committed.active, 'dev')
  assert.equal(committed.target, undefined)
  assert.equal(committed.starting, false)
  const firstPublishedDev = statusEvents.findIndex(event => event.active === 'dev')
  const provisionalIndex = statusEvents.findIndex(event => event.active === 'stable' && event.target === 'dev')
  assert.equal(provisionalIndex >= 0, true)
  assert.equal(firstPublishedDev > provisionalIndex, true)
  await mode.stop()
})

test('ModeSupervisor rejects concurrent activation and stale readiness cannot publish', async () => {
  const ready = deferred()
  const instance = new EventEmitter()
  instance.start = async () => ready.promise
  instance.stop = async () => {}
  instance.status = () => ({ state: 'starting' })
  const mode = new ModeSupervisor()
  const first = mode.activate('stable', instance)
  await nextTurn()
  await assert.rejects(mode.activate('dev', { start: async () => 'dev' }), /activation is already in progress/)
  await mode.stop()
  ready.resolve('stable')
  await assert.rejects(first)
  assert.equal(mode.status().active, 'legacy')
  assert.equal(mode.status().target, undefined)
})

test('ModeSupervisor drains prior mode before publishing a new generation', async () => {
  const events = []
  const make = label => {
    const instance = new EventEmitter()
    instance.start = async () => { events.push(`${label}:start`); instance.emit('status', { state: 'ready' }); return label }
    instance.stop = async () => { events.push(`${label}:stop`) }
    instance.status = () => ({ state: 'ready' })
    return instance
  }
  const mode = new ModeSupervisor({
    stable: { recipe: true },
    dev: { recipe: true },
    createStable: () => make('stable'),
    createDev: () => make('dev'),
  })
  await mode.activate('stable')
  await mode.activate('dev')
  assert.deepEqual(events, ['stable:start', 'stable:stop', 'dev:start'])
  assert.equal(mode.status().active, 'dev')
  await mode.stop()
  assert.equal(mode.status().active, 'legacy')
})

test('ModeSupervisor rejects activation without a recipe and direct shell shims', async () => {
  const mode = new ModeSupervisor()
  await assert.rejects(mode.activate('stable'), /no immutable activation recipe/)
  assert.throws(() => new DevSupervisor({ checkoutPath: '/dsh', checkoutPin: 'a'.repeat(40), watcher: { command: 'pnpm.cmd', args: ['run', 'dev:web'] } }), /shell shim/)
})

test('ModeSupervisor permits later activation after a target factory throws before creating an instance', async () => {
  const factoryError = new Error('stable factory failed before instance creation')
  const dev = new EventEmitter()
  dev.start = async () => 'dev'
  dev.status = () => ({ state: 'ready' })
  dev.stop = async () => {}
  const mode = new ModeSupervisor({
    stable: { recipe: true },
    dev: { recipe: true },
    createStable: () => { throw factoryError },
    createDev: () => dev,
  })

  await assert.rejects(mode.activate('stable'), error => error === factoryError)
  assert.equal(mode.status().unsafe, false)
  assert.equal(mode.status().cleanupError, undefined)
  assert.equal(mode.activeMode, 'legacy')

  assert.equal(await mode.activate('dev'), 'dev')
  assert.equal(mode.activeMode, 'dev')
  await mode.stop()
})

test('ModeSupervisor blocks mode reuse after identity-lost cleanup', async () => {
  const stable = new EventEmitter()
  stable.start = async () => 'stable'
  stable.status = () => ({ state: 'ready' })
  stable.stop = async () => { throw new Error('identity lost') }
  const dev = new EventEmitter()
  dev.start = async () => 'dev'
  dev.status = () => ({ state: 'ready' })
  dev.stop = async () => {}
  const mode = new ModeSupervisor()
  await mode.activate('stable', stable)
  await assert.rejects(mode.activate('dev', dev), /identity lost/)
  assert.equal(mode.status().unsafe, true)
  await assert.rejects(mode.activate('stable', stable), /unsafe/)
})

test('ModeSupervisor stale stop cannot overwrite a newer activation', async () => {
  const stopGate = deferred()
  const stable = new EventEmitter()
  stable.start = async () => 'stable'
  stable.status = () => ({ state: 'ready' })
  stable.stop = async () => stopGate.promise
  const dev = new EventEmitter()
  dev.start = async () => 'dev'
  dev.status = () => ({ state: 'ready' })
  dev.stop = async () => {}
  const mode = new ModeSupervisor()
  await mode.activate('stable', stable)
  const oldStop = mode.stop(new Error('old stop'))
  await nextTurn()
  const newerActivation = mode.activate('dev', dev)
  await nextTurn()
  stopGate.resolve()
  await newerActivation
  await oldStop
  assert.equal(mode.status().active, 'dev')
  assert.equal(mode.status().state, 'ready')
})

test('ModeSupervisor publishes unsafe failed status after owner rejection during stop', async () => {
  const failure = new Error('mode owner cleanup failed')
  const stable = new EventEmitter()
  stable.start = async () => 'stable'
  stable.status = () => ({ state: 'ready' })
  stable.stop = async () => { throw failure }
  const mode = new ModeSupervisor()
  await mode.activate('stable', stable)
  await assert.rejects(mode.stop(), error => error === failure)
  const status = mode.status()
  assert.equal(status.active, 'stable')
  assert.equal(status.mode, 'stable')
  assert.equal(status.state, 'failed')
  assert.equal(status.unsafe, true)
  assert.equal(status.cleanupError, failure)
})

test('ModeSupervisor retains a failed child until delayed cleanup settles before replacement', async () => {
  const cleanup = deferred()
  const stable = new EventEmitter()
  let stableStops = 0
  stable.start = async () => 'stable'
  stable.status = () => ({ state: 'ready' })
  stable.stop = async () => { stableStops += 1; await cleanup.promise }
  const dev = new EventEmitter()
  let devStarts = 0
  dev.start = async () => { devStarts += 1; return 'dev' }
  dev.status = () => ({ state: 'ready' })
  const mode = new ModeSupervisor()

  await mode.activate('stable', stable)
  stable.emit('status', { state: 'failed', error: new Error('child failed') })
  const switching = mode.activate('dev', dev)
  await nextTurn()

  assert.equal(stableStops, 1)
  assert.equal(devStarts, 0)
  assert.equal(mode.status().active, 'stable')
  assert.equal(mode.activeMode, 'stable')
  assert.equal(mode.status().target, 'dev')
  assert.equal(mode.status().state, 'starting')

  cleanup.resolve()
  await switching
  assert.equal(devStarts, 1)
  assert.equal(mode.status().active, 'dev')
})

test('ModeSupervisor latches child cleanupError and blocks every replacement', async () => {
  const cleanupError = new Error('child cleanup incomplete')
  const stable = new EventEmitter()
  stable.start = async () => 'stable'
  stable.status = () => ({ state: 'ready' })
  stable.stop = async () => {}
  const dev = new EventEmitter()
  let devStarts = 0
  dev.start = async () => { devStarts += 1; return 'dev' }
  dev.status = () => ({ state: 'ready' })
  const mode = new ModeSupervisor()

  await mode.activate('stable', stable)
  stable.emit('status', { state: 'failed', unsafe: true, cleanupError })
  const status = mode.status()
  assert.equal(status.active, 'stable')
  assert.equal(status.state, 'failed')
  assert.equal(status.unsafe, true)
  assert.equal(status.cleanupError, cleanupError)
  await assert.rejects(mode.activate('dev', dev), /unsafe/)
  assert.equal(devStarts, 0)
})
