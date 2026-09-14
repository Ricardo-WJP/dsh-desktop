import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import channels from '../src/ipc/channels.cjs'
import {
  profileWriteLockKey,
  runGit,
  runPnpm,
  withProfileWriteLock,
} from '../src/plugin-management.js'

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-plugin-manager-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('default and user profile mutations share one exclusive abortable owner', async t => {
  const dshHome = temporaryDirectory(t)
  const order = []
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = withProfileWriteLock({ dshHome, signal: firstController.signal }, async () => {
    order.push('default-start')
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push('default-end')
  })
  const second = withProfileWriteLock({ dshHome, signal: secondController.signal }, async () => {
    order.push('user-start')
    order.push('user-end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['default-start', 'default-end', 'user-start', 'user-end'])

  const blockedController = new AbortController()
  const laterOrder = []
  let releaseOwner
  const owner = withProfileWriteLock({ dshHome }, async () => {
    laterOrder.push('active-start')
    await new Promise(resolve => { releaseOwner = resolve })
    laterOrder.push('active-end')
  })
  const waiting = withProfileWriteLock({ dshHome, signal: blockedController.signal }, async () => {
    throw new Error('aborted writer ran')
  })
  blockedController.abort(new Error('shutdown'))
  const later = withProfileWriteLock({ dshHome }, async () => { laterOrder.push('later-start') })
  await assert.rejects(waiting, /shutdown/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(laterOrder, ['active-start'])
  releaseOwner()
  await Promise.all([owner, later])
  assert.deepEqual(laterOrder, ['active-start', 'active-end', 'later-start'])
})

test('canonicalizes equivalent profile lock spellings on Windows', async t => {
  const dshHome = temporaryDirectory(t)
  const equivalentHome = process.platform === 'win32'
    ? `${dshHome.toUpperCase()}\\profiles\\..`
    : join(dshHome, 'profiles', '..')
  assert.equal(
    profileWriteLockKey({ dshHome }),
    profileWriteLockKey({ dshHome: equivalentHome }),
  )
  if (process.platform !== 'win32') return

  let active = 0
  let maximum = 0
  const first = withProfileWriteLock({ dshHome }, async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active -= 1
  })
  const second = withProfileWriteLock({ dshHome: equivalentHome }, async () => {
    active += 1
    maximum = Math.max(maximum, active)
    active -= 1
  })
  await Promise.all([first, second])
  assert.equal(maximum, 1)
})

test('runs bundled pnpm through the desktop executable with the hidden child policy and no shell', async () => {
  let invocation
  const controller = new AbortController()
  const spawn = (command, args, options) => {
    invocation = { command, args, options }
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => {
      child.stdout.write('installed\n')
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
    return child
  }

  const result = await runPnpm({
    args: ['add', '@example/plugin'],
    execPath: '/app/dsh-desktop',
    pnpmEntry: '/app/resources/pnpm/bin/pnpm.mjs',
    hiddenChildProcess: '/app/resources/app/src/runtime/windows-hidden-child-process.cjs',
    profileDir: '/profile/web',
    env: { PATH: '/usr/bin' },
    signal: controller.signal,
    platform: 'linux',
    spawnImpl: spawn,
  })
  assert.equal(result.output, 'installed\n')
  assert.equal(invocation.command, '/app/dsh-desktop')
  assert.deepEqual(invocation.args, [
    '--require',
    '/app/resources/app/src/runtime/windows-hidden-child-process.cjs',
    '/app/resources/pnpm/bin/pnpm.mjs',
    'add',
    '@example/plugin',
  ])
  assert.equal(invocation.options.cwd, '/profile/web')
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.signal, controller.signal)
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, '1')
})

test('queries GitHub refs through git without a shell or credential prompts', async () => {
  let invocation
  const spawn = (command, args, options) => {
    invocation = { command, args, options }
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => {
      child.stdout.write('abc123\tHEAD\n')
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
    return child
  }

  const result = await runGit({
    args: ['ls-remote', 'https://github.com/example/repository.git', 'HEAD'],
    cwd: '/profile/web',
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    spawnImpl: spawn,
  })
  assert.equal(result.output, 'abc123\tHEAD\n')
  assert.equal(invocation.command, 'git')
  assert.deepEqual(invocation.args, ['ls-remote', 'https://github.com/example/repository.git', 'HEAD'])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(invocation.options.env.GCM_INTERACTIVE, 'Never')
})

test('successful commands retain output through exit until close drains stdio', async () => {
  const child = new EventEmitter()
  child.pid = 51_000
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const resultPromise = runPnpm({
    args: ['--version'],
    execPath: '/app/dsh-desktop',
    pnpmEntry: '/app/pnpm.mjs',
    profileDir: '/profile/web',
    platform: 'linux',
    spawnImpl: () => {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
        child.stdout.write('final stdout after exit\\n')
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0, null)
      })
      return child
    },
  })
  const result = await resultPromise
  assert.equal(result.output, 'final stdout after exit\\n')
})

test('failed commands surface stderr diagnostics before progress output', async () => {
  const child = new EventEmitter()
  child.pid = 51_000
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const resultPromise = runPnpm({
    args: ['add', '@example/plugin'],
    execPath: '/app/dsh-desktop',
    pnpmEntry: '/app/pnpm.mjs',
    profileDir: '/profile/web',
    platform: 'linux',
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write('Progress: resolved 504, reused 35, downloaded 412\\n')
        child.stderr.write('Error: readStream must be readable\\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 1
        child.signalCode = null
        child.emit('exit', 1, null)
        child.emit('close', 1, null)
      })
      return child
    },
  })
  await assert.rejects(resultPromise, error => {
    assert.match(error.message, /readStream must be readable/)
    assert.match(error.message, /Progress: resolved 504/)
    return true
  })
})

const TASKKILL_PATH = 'C:\\Windows\\System32\\taskkill.exe'

class WindowsCommandChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  complete(code = 0, signal = null, output = '', errorOutput = '') {
    if (output !== '') this.stdout.write(output)
    if (errorOutput !== '') this.stderr.write(errorOutput)
    this.stdout.end()
    this.stderr.end()
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

test('successful Windows pnpm releases its completed root instead of taskkilling an exited PID', async () => {
  const calls = []
  const root = new WindowsCommandChild(51_001)
  const result = await runPnpm({
    args: ['--version'],
    execPath: 'C:\\dsh-desktop.exe',
    pnpmEntry: 'C:\\resources\\pnpm\\bin\\pnpm.mjs',
    profileDir: 'C:\\profile\\web',
    env: { PATH: 'C:\\Windows\\System32' },
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      queueMicrotask(() => root.complete(0, null, '10.0.0\n'))
      return root
    },
  })
  assert.equal(result.output, '10.0.0\n')
  assert.equal(calls.some(call => call.command === TASKKILL_PATH), false)
  assert.equal(root.listenerCount('exit'), 0)
  assert.equal(root.listenerCount('close'), 0)
})

test('successful Windows git releases its completed root instead of taskkilling an exited PID', async () => {
  const calls = []
  const root = new WindowsCommandChild(51_002)
  const result = await runGit({
    args: ['rev-parse', 'HEAD'],
    cwd: 'C:\\profile\\web',
    env: { PATH: 'C:\\Windows\\System32' },
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      queueMicrotask(() => root.complete(0, null, 'abc123\n'))
      return root
    },
  })
  assert.equal(result.output, 'abc123\n')
  assert.equal(calls.some(call => call.command === TASKKILL_PATH), false)
  assert.equal(root.listenerCount('exit'), 0)
  assert.equal(root.listenerCount('close'), 0)
})

test('failed Windows pnpm preserves its diagnostic after the exited root is safely released', async () => {
  const calls = []
  const root = new WindowsCommandChild(51_003)
  await assert.rejects(
    runPnpm({
      args: ['install'],
      execPath: 'C:\\dsh-desktop.exe',
      pnpmEntry: 'C:\\resources\\pnpm\\bin\\pnpm.mjs',
      profileDir: 'C:\\profile\\web',
      env: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
      taskkillPath: TASKKILL_PATH,
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options })
        queueMicrotask(() => root.complete(1, null, '', '[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE] wrong store\n'))
        return root
      },
    }),
    error => !(error instanceof AggregateError)
      && /ERR_PNPM_UNEXPECTED_VIRTUAL_STORE/.test(error?.message ?? ''),
  )
  assert.equal(calls.some(call => call.command === TASKKILL_PATH), false)
  assert.equal(root.listenerCount('exit'), 0)
  assert.equal(root.listenerCount('close'), 0)
})

test('keeps native plugin transaction code separate from the desktop renderer', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../src/ipc/desktop-host.js', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../src/plugin-management.js', import.meta.url), 'utf8')
  const command = readFileSync(new URL('../src/owned-command.js', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../build/preload/preload.cjs', import.meta.url), 'utf8')
  assert.match(host, /senderIsPluginManager\(event\)/)
  assert.match(host, /getPath\('pluginManager'\)/)
  assert.doesNotMatch(main, /showPluginManager|pluginManagerWindow|firstLaunchRecommendations/)
  assert.doesNotMatch(host, /senderIsExtensionManager|extensions\.html|dsh-desktop:skills-/)
  assert.equal(channels.plugins.update, 'dsh-desktop:plugins-update')
  assert.match(main, /pluginTransaction: request => runtimeController\?\.pluginTransaction\(request\)/)
  assert.match(main, /pluginRemovePreview: request => runtimeController\?\.pluginRemovePreview\(request\)/)
  assert.match(main, /pluginConfirmRemove: request => runtimeController\?\.pluginConfirmRemove\(request\)/)
  assert.doesNotMatch(main, /pluginInstall:|pluginUpdate: name|pluginRemove: name/)
  assert.match(service, /export function ensureDefaultPlugins/)
  assert.match(readFileSync(new URL('../src/desktop-runtime-controller.js', import.meta.url), 'utf8'), /operationCoordinator\.enqueue\('plugin-transaction'/)
  assert.match(host, /Legacy live-profile plugin mutation; use structured candidate transactions/)
  assert.equal(channels.plugins.discover, 'dsh-desktop:plugins-discover')
  assert.match(host, /normalizePluginSourceUrl/)
  assert.match(command, /shell: false/)
  assert.equal(channels.plugins.install, 'dsh-desktop:plugins-install')
  assert.equal(channels.plugins.update, 'dsh-desktop:plugins-update')
  assert.equal(channels.plugins.discover, 'dsh-desktop:plugins-discover')
  assert.equal(channels.plugins.source, 'dsh-desktop:plugins-source')
  assert.equal(channels.plugins.enabled, 'dsh-desktop:plugins-enabled')
  assert.equal(channels.plugins.remove, 'dsh-desktop:plugins-remove')
  assert.doesNotMatch(preload, /dsh-desktop:skills-|dshPluginManager|plugins:/)
  assert.doesNotMatch(preload, /child_process|exec\(|spawn\(/)
})
