import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runOwnedCommand } from '../src/owned-command.js'
import { HarnessServer } from '../src/harness-server.js'
import { createChildSupervisor, createOwnedProcessTree, waitForChild, waitForChildClose } from '../src/process-tree.js'
import { runGit, runPnpm } from '../src/plugin-management.js'

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killSignals = []
  }

  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal)
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

function abortableProcess({ command, run, args }) {
  const calls = []
  let child
  const controller = new AbortController()
  const spawnImpl = (actualCommand, actualArgs, options) => {
    child = new FakeChild(8801)
    calls.push({ actualCommand, actualArgs, options })
    return child
  }
  const processKill = (pid, signal) => {
    calls.push({ pid, signal })
    if (signal === 'SIGKILL') {
      child.signalCode = signal
      child.emit('exit', null, signal)
    }
  }
  const promise = run({
    args,
    ...(command === 'pnpm'
      ? { execPath: '/app/electron.exe', pnpmEntry: '/app/pnpm.mjs', profileDir: '/profile' }
      : { cwd: '/profile' }),
    spawnImpl,
    processKill,
    platform: 'linux',
    terminationTimeoutMs: 3,
    signal: controller.signal,
  })
  child.stdout.write('partial output\n')
  controller.abort(new Error(`${command} canceled`))
  return { calls, child, promise }
}

test('waitForChild preserves exit semantics while waitForChildClose waits for close', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  const exitWait = waitForChild(child)
  const closeWait = waitForChildClose(child)
  child.exitCode = 0
  child.emit('exit', 0, null)
  assert.deepEqual(await exitWait, { code: 0, signal: null })
  let closed = false
  closeWait.then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  child.emit('close', 0, null)
  assert.deepEqual(await closeWait, { code: 0, signal: null })
})

test('Windows never taskkills a root after exit, including a zero exit, without a completion contract', async () => {
  const calls = []
  const root = new FakeChild(8810)
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      return root
    },
  })
  const child = supervisor.spawn('C:\\node.exe', ['one-shot.js'])
  root.exitCode = 0
  root.signalCode = null
  root.emit('exit', 0, null)
  root.emit('close', 0, null)

  assert.equal(supervisor.releaseExitedRoot(child), false)
  assert.equal(supervisor.children.length, 1)
  await assert.rejects(supervisor.stopAll(), /identity lost/)
  assert.equal(calls.some(call => call.command.endsWith('taskkill.exe')), false)
  assert.equal(supervisor.children.length, 0)
})

test('close-only roots stay descendants-unverified until an explicit one-shot contract is supplied', async () => {
  const root = new EventEmitter()
  root.pid = 8811
  root.exitCode = null
  root.signalCode = null
  const owner = createOwnedProcessTree({
    child: root,
    platform: 'win32',
    taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
    spawnImpl: () => { throw new Error('taskkill must not run') },
    terminationTimeoutMs: 1,
  })

  root.emit('close', 1, null)
  assert.equal(owner.rootExited, true)
  assert.equal(owner.cleanupState, 'root-exited/descendants-unverified')
  assert.equal(owner.descendantsVerified, false)
  assert.equal(owner.releaseAfterUnexpectedExit(), true)
  assert.equal(owner.cleanupState, 'root-exited/descendants-unverified')
  assert.equal(owner.descendantsVerified, false)
  assert.equal(root.listenerCount('exit'), 0)
  assert.equal(root.listenerCount('close'), 0)
  await assert.rejects(owner.stop(), /descendants are unverified/)
})

test('an explicit one-shot no-descendants contract is the only exited-root release path', async () => {
  const calls = []
  const root = new FakeChild(8812)
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      return root
    },
  })
  const child = supervisor.spawn('C:\\node.exe', ['failed.js'])
  root.exitCode = 1
  root.signalCode = null
  root.emit('exit', 1, null)
  root.emit('close', 1, null)

  assert.equal(supervisor.releaseCompletedRoot(child), false)
  assert.equal(supervisor.releaseExitedRoot(child, { oneShot: true, descendants: 'none' }), true)
  assert.equal(supervisor.children.length, 0)
  assert.equal(calls.some(call => call.command.endsWith('taskkill.exe')), false)
})

test('runOwnedCommand defaults to root-only completion without taskkilling or hiding descendant uncertainty', async () => {
  for (const code of [0, 1]) {
    const calls = []
    const root = new FakeChild(8813 + code)
    const spawnImpl = (command, args) => {
      calls.push({ command, args })
      queueMicrotask(() => {
        root.exitCode = code
        root.signalCode = null
        root.emit('exit', code, null)
        root.emit('close', code, null)
      })
      return root
    }
    const request = {
      command: 'C:\\node.exe',
      args: ['custom-script.js'],
      cwd: 'C:\\profile',
      env: {},
      platform: 'win32',
      taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
      spawnImpl,
      outputLabel: 'custom node script',
    }

    if (code === 0) {
      const result = await runOwnedCommand(request)
      assert.equal(result.cleanupState, 'root-exited/descendants-unverified')
      assert.equal(result.descendantsVerified, false)
    } else {
      await assert.rejects(runOwnedCommand(request), error => {
        assert.equal(error instanceof AggregateError, false)
        assert.equal(error.cleanupState, 'root-exited/descendants-unverified')
        assert.equal(error.descendantsVerified, false)
        assert.match(error.message, /custom node script exited with code 1/)
        return true
      })
    }
    assert.equal(calls.some(call => call.command.endsWith('taskkill.exe')), false)
    assert.equal(root.listenerCount('exit'), 0)
    assert.equal(root.listenerCount('close'), 0)
    assert.equal(root.listenerCount('error'), 0)
  }
})

test('runOwnedCommand upgrades only an explicitly contracted one-shot root to complete', async () => {
  const calls = []
  const root = new FakeChild(8815)
  const result = await runOwnedCommand({
    command: 'C:\\node.exe',
    args: ['trusted-build-step.js'],
    cwd: 'C:\\profile',
    env: {},
    platform: 'win32',
    taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
    completionContract: { oneShot: true, descendants: 'none' },
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      queueMicrotask(() => {
        root.exitCode = 0
        root.signalCode = null
        root.emit('exit', 0, null)
        root.emit('close', 0, null)
      })
      return root
    },
    outputLabel: 'trusted build step',
  })

  assert.equal(result.cleanupState, undefined)
  assert.equal(result.descendantsVerified, undefined)
  assert.equal(calls.some(call => call.command.endsWith('taskkill.exe')), false)
})

test('runPnpm abort settles after exact detached-tree graceful then force cleanup', async () => {
  const { calls, child, promise } = abortableProcess({ command: 'pnpm', run: runPnpm, args: ['install'] })
  await assert.rejects(promise, /pnpm canceled/)
  assert.deepEqual(calls.filter(call => call.pid !== undefined), [
    { pid: -8801, signal: 'SIGTERM' },
    { pid: -8801, signal: 'SIGKILL' },
  ])
  assert.equal(child.killSignals.length, 0)
})

test('runGit timeout settles and drains the exact owned process group', async () => {
  const calls = []
  let child
  const promise = runGit({
    args: ['fetch'],
    cwd: '/profile',
    timeoutMs: 2,
    terminationTimeoutMs: 3,
    platform: 'linux',
    spawnImpl: (_command, _args, options) => {
      child = new FakeChild(8802)
      calls.push(options)
      return child
    },
    processKill: (pid, signal) => {
      calls.push({ pid, signal })
      if (signal === 'SIGKILL') {
        child.signalCode = signal
        child.emit('exit', null, signal)
      }
    },
  })
  await assert.rejects(promise, /git timed out/)
  assert.equal(calls[0].shell, false)
  assert.equal(calls[0].detached, true)
  assert.deepEqual(calls.slice(1), [
    { pid: -8802, signal: 'SIGTERM' },
    { pid: -8802, signal: 'SIGKILL' },
  ])
})

test('HarnessServer drains descendants after a root exit before readiness', async () => {
  const signals = []
  let child
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'linux',
    shutdownTimeoutMs: 3,
    spawnImpl: () => {
      child = new FakeChild(8803)
      queueMicrotask(() => {
        child.exitCode = 1
        child.emit('exit', 1, null)
      })
      return child
    },
    processKill: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL') child.emit('exit', null, signal)
    },
  })
  await assert.rejects(server.start(), /exited before it was ready/)
  await server.stop()
  assert.deepEqual(signals, [[-8803, 'SIGTERM'], [-8803, 'SIGKILL']])
})

test('HarnessServer startup timeout drains an alive root and settles stop', async () => {
  const signals = []
  let child
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'linux',
    startupTimeoutMs: 2,
    shutdownTimeoutMs: 3,
    spawnImpl: () => {
      child = new FakeChild(8804)
      return child
    },
    processKill: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL') {
        child.signalCode = signal
        child.emit('exit', null, signal)
      }
    },
  })
  await assert.rejects(server.start(), /did not become ready/)
  await server.stop()
  assert.deepEqual(signals, [[-8804, 'SIGTERM'], [-8804, 'SIGKILL']])
})
