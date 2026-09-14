import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { removeTemporaryHome, runCandidateRuntimeGate } from '../src/profile/runtime-gate.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-gate-'))
  const profilePath = join(root, 'candidate', 'profile')
  await mkdir(profilePath, { recursive: true })
  await writeFile(join(profilePath, 'package.json'), '{"name":"candidate-profile"}\n')
  return {
    root,
    recipe: {
      entry: join(root, 'candidate', 'runtime', 'bin.js'),
      profilePath,
      profileHome: join(root, 'candidate'),
      physicalProfileName: 'candidate-001',
      cwd: profilePath,
    },
  }
}

class FakeServer extends EventEmitter {
  constructor(options, { crash = false, url = 'http://127.0.0.1:51427' } = {}) {
    super()
    this.options = options
    this.crash = crash
    this.url = url
  }

  async start() {
    if (this.crash) setTimeout(() => this.emit('exit', { code: 1, signal: null, ready: true }), 5)
    return this.url
  }

  async stop() {}
}

test('candidate runtime gate boots only an isolated profile and returns smoke evidence', async t => {
  const setup = await fixture()
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(setup.root, { recursive: true, force: true })) })
  let options
  const result = await runCandidateRuntimeGate({
    recipe: setup.recipe,
    candidateId: 'candidate-001',
    env: { DSH_HOME: 'must-be-replaced' },
    serverFactory: value => {
      options = value
      return new FakeServer(value, { url: 'http://127.0.0.1:51427/?token=preflight-token' })
    },
    fetchImpl: async () => {
      const mountedModules = join(options.env.DSH_HOME, 'profiles', 'node_modules')
      const candidateModules = join(setup.recipe.profileHome, 'profiles', 'node_modules')
      assert.equal((await lstat(mountedModules)).isSymbolicLink(), true)
      assert.equal(await realpath(mountedModules), await realpath(candidateModules))
      return { status: 200 }
    },
    probeTerminalImpl: async () => ({ status: 101 }),
    stabilityWindowMs: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(result.httpStatus, 200)
  assert.equal(result.terminalProbe, 'upgraded')
  assert.equal(options.startupTimeoutMs, 120_000)
  assert.equal(options.forceWindowsTreeTermination, true)
  assert.notEqual(options.env.DSH_HOME, setup.recipe.profileHome)
  await result.cleanupStatus.home.completion
  assert.equal(result.cleanupStatus.server.status, 'complete')
  assert.equal(result.cleanupStatus.home.status, 'complete')
  await assert.rejects(stat(options.env.DSH_HOME))
  assert.equal((await stat(join(setup.recipe.profileHome, 'profiles', 'node_modules'))).isDirectory(), true)
})

test('candidate runtime gate probes the advertised query URL without appending after the query', async t => {
  const setup = await fixture()
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(setup.root, { recursive: true, force: true })) })
  let options
  let requestedUrl
  await runCandidateRuntimeGate({
    recipe: setup.recipe,
    candidateId: 'candidate-query-url',
    serverFactory: value => {
      options = value
      return new FakeServer(value, { url: 'http://127.0.0.1:51427/?token=preflight-token' })
    },
    fetchImpl: async url => {
      requestedUrl = String(url)
      return { status: 200 }
    },
    probeTerminalImpl: async () => ({ status: 101 }),
    stabilityWindowMs: 1,
  })
  assert.equal(requestedUrl, 'http://127.0.0.1:51427/?token=preflight-token')
  assert.equal(options.env.DSH_HOME.includes('dsh-runtime-gate-'), false)
})

test('candidate runtime gate accepts a token session redirect as a healthy Host response', async t => {
  const setup = await fixture()
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(setup.root, { recursive: true, force: true })) })
  const result = await runCandidateRuntimeGate({
    recipe: setup.recipe,
    candidateId: 'candidate-token-redirect',
    serverFactory: options => new FakeServer(options, { url: 'http://127.0.0.1:51427/?token=preflight-token' }),
    fetchImpl: async () => ({ status: 303 }),
    probeTerminalImpl: async () => ({ status: 101 }),
    stabilityWindowMs: 1,
  })
  assert.equal(result.httpStatus, 303)
})

test('candidate runtime gate rejects a Host crash without touching the candidate profile', async t => {
  const setup = await fixture()
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(setup.root, { recursive: true, force: true })) })
  await assert.rejects(
    runCandidateRuntimeGate({
      recipe: setup.recipe,
      candidateId: 'candidate-001',
      serverFactory: options => new FakeServer(options, { crash: true }),
      fetchImpl: async () => ({ status: 200 }),
      probeTerminalImpl: async () => ({ status: undefined }),
      stabilityWindowMs: 20,
    }),
    error => error?.code === 'CANDIDATE_RUNTIME_GATE_FAILED' && /exited during runtime preflight/u.test(error.message),
  )
  assert.equal((await stat(setup.recipe.profilePath)).isDirectory(), true)
})

test('candidate runtime gate leaves its temporary home untouched when server shutdown fails', async t => {
  const setup = await fixture()
  let gateHome
  t.after(async () => {
    if (gateHome !== undefined) await rm(gateHome, { recursive: true, force: true })
    await rm(setup.root, { recursive: true, force: true })
  })
  let stopCalls = 0
  await assert.rejects(
    runCandidateRuntimeGate({
      recipe: setup.recipe,
      candidateId: 'candidate-001',
      serverFactory: options => {
        gateHome = options.env.DSH_HOME
        const server = new FakeServer(options)
        server.stop = async () => { stopCalls += 1; throw new Error('injected stop failure') }
        return server
      },
      fetchImpl: async () => ({ status: 200 }),
      probeTerminalImpl: async () => ({ status: undefined }),
      stabilityWindowMs: 1,
    }),
    error => error?.code === 'CANDIDATE_RUNTIME_GATE_FAILED'
      && /could not stop its preflight server/u.test(error.message)
      && error.cleanupStatus?.server?.status === 'failed'
      && error.cleanupStatus?.home?.status === 'pending'
      && error.cleanupStatus?.home?.path === gateHome,
  )
  assert.equal(stopCalls, 1)
  assert.equal((await stat(gateHome)).isDirectory(), true)
  const entries = await readdir(dirname(gateHome))
  assert.equal(entries.some(name => name.startsWith(`${basename(gateHome)}.pending-delete-`)), false)
})

test('candidate runtime gate preserves the primary failure when cleanup also fails', async t => {
  const setup = await fixture()
  let gateHome
  t.after(async () => {
    if (gateHome !== undefined) await rm(gateHome, { recursive: true, force: true })
    await rm(setup.root, { recursive: true, force: true })
  })
  await assert.rejects(
    runCandidateRuntimeGate({
      recipe: setup.recipe,
      candidateId: 'candidate-001',
      serverFactory: options => {
        gateHome = options.env.DSH_HOME
        const server = new FakeServer(options)
        server.stop = async () => { throw new Error('injected stop failure') }
        return server
      },
      fetchImpl: async () => { throw new Error('injected HTTP failure') },
      probeTerminalImpl: async () => ({ status: undefined }),
      stabilityWindowMs: 1,
    }),
    error => error?.code === 'CANDIDATE_RUNTIME_GATE_FAILED'
      && /injected HTTP failure/u.test(error.message)
      && /injected stop failure/u.test(error.cleanupError?.message ?? ''),
  )
  assert.equal((await stat(gateHome)).isDirectory(), true)
  assert.equal((await readdir(dirname(gateHome))).some(name => name.startsWith(`${basename(gateHome)}.pending-delete-`)), false)
})

test('removeTemporaryHome cleans the exact temporary root without touching an adjacent path', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-runtime-gate-cleanup-'))
  const sibling = `${home}-sibling`
  await mkdir(sibling)
  await writeFile(join(sibling, 'keep.txt'), 'keep\n')
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
    await rm(sibling, { recursive: true, force: true })
  })

  const pendingHome = `${home}.pending-delete-fixed-id`
  const removeCalls = []
  const cleanup = await removeTemporaryHome(home, {
    randomUUIDImpl: () => 'fixed-id',
    removeImpl: async (path, options) => {
      removeCalls.push({ path, options })
      return rm(path, options)
    },
  })
  await cleanup.completion

  assert.equal(cleanup.status, 'complete')
  assert.equal(cleanup.path, pendingHome)
  assert.deepEqual(removeCalls.map(call => call.path), [pendingHome])
  await assert.rejects(stat(home), error => error?.code === 'ENOENT')
  assert.equal((await stat(sibling)).isDirectory(), true)
})

test('removeTemporaryHome disables Electron asar interpretation and reports cleanup failures', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-runtime-gate-asar-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  const electronRuntime = { versions: { electron: '43.4.0' } }
  const calls = []
  let cleanupError
  const pendingHome = `${home}.pending-delete-asar-test`
  const cleanup = await removeTemporaryHome(home, {
    randomUUIDImpl: () => 'asar-test',
    electronRuntime,
    renameImpl: async (source, target) => {
      calls.push({ operation: 'rename', source, target, noAsar: electronRuntime.noAsar })
    },
    removeImpl: async (path, options) => {
      calls.push({ operation: 'remove', path, options, noAsar: electronRuntime.noAsar })
      const error = new Error('injected cleanup failure')
      error.code = 'EIO'
      throw error
    },
    onError: error => { cleanupError = error },
  })
  await cleanup.completion

  assert.equal(cleanup.status, 'failed')
  assert.equal(cleanup.path, pendingHome)
  assert.equal(cleanupError?.message, 'injected cleanup failure')
  assert.equal(electronRuntime.noAsar, undefined)
  assert.equal(calls.every(call => call.noAsar === true), true)
  assert.deepEqual(calls.map(call => call.operation), ['rename', 'remove'])
  assert.equal(calls[0].source, home)
  assert.equal(calls[0].target, pendingHome)
  assert.equal(calls[1].path, pendingHome)
})

test('candidate runtime gate rejects profile names that can escape its isolated mount', async t => {
  const setup = await fixture()
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(setup.root, { recursive: true, force: true })) })
  await assert.rejects(
    runCandidateRuntimeGate({
      recipe: { ...setup.recipe, physicalProfileName: '..\\outside' },
      candidateId: 'candidate-001',
      serverFactory: options => new FakeServer(options),
    }),
    /invalid physical profile name/u,
  )
})

test('candidate runtime gate rejects relative runtime paths before mounting', async t => {
  const setup = await fixture()
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(setup.root, { recursive: true, force: true })) })
  await assert.rejects(
    runCandidateRuntimeGate({
      recipe: { ...setup.recipe, entry: 'relative-runtime.js' },
      candidateId: 'candidate-001',
      serverFactory: options => new FakeServer(options),
    }),
    /invalid entry/u,
  )
})

test('preflight does not inherit credentials, user homes, NODE_OPTIONS or the live cwd', async t => {
  const setup = await fixture()
  t.after(() => rm(setup.root, { recursive: true, force: true }))
  let options
  const result = await runCandidateRuntimeGate({
    recipe: setup.recipe, candidateId: 'isolated-environment',
    env: { OPENAI_API_KEY: 'fixture-not-real', OPENCODE_GO_API_KEY: 'fixture-not-real', NODE_OPTIONS: '--import=user-code', HOME: '/live/home', DSH_DOCTOR_HOME: '/live/doctor', MNEMON_DATA_DIR: '/live/memory', HTTP_PROXY: 'http://127.0.0.1:7892' },
    serverFactory: value => { options = value; return new FakeServer(value) },
    fetchImpl: async () => ({ status: 200 }), probeTerminalImpl: async () => ({ status: 404 }), stabilityWindowMs: 1,
  })
  for (const key of ['OPENAI_API_KEY', 'OPENCODE_GO_API_KEY', 'NODE_OPTIONS']) assert.equal(options.env[key], undefined)
  assert.equal(options.env.HTTP_PROXY, 'http://127.0.0.1:7892')
  assert.notEqual(options.cwd, setup.recipe.cwd)
  assert.equal(options.cwd, options.env.HOME)
  assert.ok(options.env.MNEMON_DATA_DIR.startsWith(options.env.DSH_HOME))
  assert.ok(options.env.DSH_DOCTOR_HOME.startsWith(options.env.DSH_HOME))
  assert.equal(result.isolation, 'environment-and-working-directory')
  await result.cleanupStatus.home.completion
})

test('overlapping Electron cleanups keep asar disabled until both scopes release', async () => {
  const runtime = { versions: { electron: 'fixture' }, noAsar: false }
  const releases = []
  const options = { electronRuntime: runtime, renameImpl: async () => {}, removeImpl: async () => new Promise(resolve => releases.push(resolve)) }
  const first = await removeTemporaryHome(join(tmpdir(), 'owned-preflight-fixture-a'), options)
  const second = await removeTemporaryHome(join(tmpdir(), 'owned-preflight-fixture-b'), options)
  assert.equal(runtime.noAsar, true)
  releases[0]()
  await first.completion
  assert.equal(runtime.noAsar, true)
  releases[1]()
  await second.completion
  assert.equal(runtime.noAsar, false)
})
