import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { promisify } from 'node:util'

const WRAPPER_PATH = new URL('../src/runtime/windows-hidden-child-process.cjs', import.meta.url)
const BASELINE_PATH = new URL('./fixtures/windows-hidden-child-process.baseline.cjs', import.meta.url)
const METHOD_NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']

async function loadWrapper(platform = 'win32', { implementations = {}, loads = 1, sourcePath = WRAPPER_PATH } = {}) {
  const source = await readFile(sourcePath, 'utf8')
  const calls = []
  const childProcess = Object.fromEntries(METHOD_NAMES.map(name => [name, function (...args) {
    calls.push({ name, args, thisValue: this })
    if (implementations[name]) return implementations[name].apply(this, args)
    return name
  }]))
  const originals = { ...childProcess }
  for (const name of ['exec', 'execFile']) {
    Object.defineProperty(childProcess[name], promisify.custom, {
      value: () => { throw new Error('Original custom promisifier bypassed hidden execution') },
    })
  }
  let synchronized = 0
  const context = vm.createContext({
    process: { platform },
    require(specifier) {
      if (specifier === 'node:child_process') return childProcess
      if (specifier === 'node:module') return { syncBuiltinESMExports: () => { synchronized += 1 } }
      if (specifier === 'node:util') return { promisify }
      throw new Error(`Unexpected require: ${specifier}`)
    },
  })
  for (let index = 0; index < loads; index += 1) vm.runInContext(source, context, { filename: WRAPPER_PATH.pathname })
  return { childProcess, originals, calls, synchronized: () => synchronized }
}

function assertSameForwarding(actual, expected) {
  assert.equal(actual.name, expected.name)
  assert.equal(actual.args.length, expected.args.length)
  for (let index = 0; index < actual.args.length; index += 1) {
    const [received, baseline] = [actual.args[index], expected.args[index]]
    if (Array.isArray(received) || Array.isArray(baseline)) {
      assert.ok(Array.isArray(received) && Array.isArray(baseline))
      assert.deepEqual(Array.from(received), Array.from(baseline))
    } else if (received != null && baseline != null
      && typeof received === 'object' && typeof baseline === 'object') {
      assert.deepEqual({ ...received }, { ...baseline })
    } else {
      assert.equal(received, baseline)
    }
  }
}

test('refactor keeps function signatures, descriptors, this, and overload forwarding differential-equivalent', async () => {
  const [setup, baseline] = await Promise.all([
    loadWrapper(),
    loadWrapper('win32', { sourcePath: BASELINE_PATH }),
  ])
  const callback = () => {}
  const receiver = { fixture: 'this' }
  const frozen = Object.freeze({ windowsHide: false, cwd: 'C:\\fixture-work' })
  const forms = [
    ['spawn', ['fixture']], ['spawn', ['fixture', frozen]], ['spawn', ['fixture', [], frozen]],
    ['spawn', ['fixture', null, null]], ['spawnSync', ['fixture', 'invalid']],
    ['fork', ['fixture', frozen]], ['fork', ['fixture', [], frozen]],
    ['exec', ['fixture', callback]], ['exec', ['fixture', frozen, callback]],
    ['execSync', ['fixture']], ['execSync', ['fixture', null]],
    ['execFile', ['fixture', callback]], ['execFile', ['fixture', frozen, callback]],
    ['execFile', ['fixture', undefined, callback]], ['execFile', ['fixture', null, frozen, callback]],
    ['execFileSync', ['fixture']], ['execFileSync', ['fixture', frozen]],
    ['execFileSync', ['fixture', null, frozen]],
  ]

  for (const name of METHOD_NAMES) {
    assert.equal(setup.childProcess[name].name, baseline.childProcess[name].name)
    assert.equal(setup.childProcess[name].length, baseline.childProcess[name].length)
  }
  for (const name of ['exec', 'execFile']) {
    const actual = Object.getOwnPropertyDescriptor(setup.childProcess[name], promisify.custom)
    const expected = Object.getOwnPropertyDescriptor(baseline.childProcess[name], promisify.custom)
    assert.deepEqual(
      { configurable: actual.configurable, enumerable: actual.enumerable, writable: actual.writable },
      { configurable: expected.configurable, enumerable: expected.enumerable, writable: expected.writable },
    )
  }
  for (const [name, args] of forms) {
    assert.equal(setup.childProcess[name].call(receiver, ...args), baseline.childProcess[name].call(receiver, ...args))
    assert.equal(setup.calls.at(-1).thisValue, receiver)
    assert.equal(baseline.calls.at(-1).thisValue, receiver)
    assertSameForwarding(setup.calls.at(-1), baseline.calls.at(-1))
  }
})

test('managed Windows child-process APIs always force hidden console execution', async () => {
  const setup = await loadWrapper()
  const callback = () => {}
  const cases = [
    { invoke: () => setup.childProcess.spawn('cmd.exe', ['/c', 'exit'], { windowsHide: false, marker: 1 }), optionsIndex: 2 },
    { invoke: () => setup.childProcess.spawnSync('cmd.exe', ['/c', 'exit'], { windowsHide: false, marker: 2 }), optionsIndex: 2 },
    { invoke: () => setup.childProcess.exec('exit', { windowsHide: false, marker: 3 }, callback), optionsIndex: 1 },
    { invoke: () => setup.childProcess.execSync('exit', { windowsHide: false, marker: 4 }), optionsIndex: 1 },
    { invoke: () => setup.childProcess.execFile('cmd.exe', ['/c', 'exit'], { windowsHide: false, marker: 5 }, callback), optionsIndex: 2 },
    { invoke: () => setup.childProcess.execFileSync('cmd.exe', ['/c', 'exit'], { windowsHide: false, marker: 6 }), optionsIndex: 2 },
    { invoke: () => setup.childProcess.fork('worker.cjs', [], { windowsHide: false, marker: 7 }), optionsIndex: 2 },
  ]

  for (const fixture of cases) {
    fixture.invoke()
    const options = setup.calls.at(-1).args[fixture.optionsIndex]
    assert.equal(options.windowsHide, true)
    assert.ok(options.marker >= 1)
  }
  assert.equal(setup.synchronized(), 1)
})

test('managed Windows child-process overloads add hidden options when callers omit them', async () => {
  const setup = await loadWrapper()
  const callback = () => {}
  setup.childProcess.spawn('cmd.exe', ['/c', 'exit'])
  setup.childProcess.exec('exit', callback)
  setup.childProcess.execFile('cmd.exe', callback)
  setup.childProcess.fork('worker.cjs', [])

  assert.equal(setup.calls[0].args[2].windowsHide, true)
  assert.equal(setup.calls[1].args[1].windowsHide, true)
  assert.equal(setup.calls[2].args[2].windowsHide, true)
  assert.equal(setup.calls[3].args[2].windowsHide, true)
})

test('non-Windows runtimes leave child-process exports untouched', async () => {
  const setup = await loadWrapper('linux')
  setup.childProcess.spawn('sh', ['-c', 'true'], { windowsHide: false })
  assert.equal(setup.calls[0].args[2].windowsHide, false)
  assert.equal(setup.synchronized(), 0)
  for (const name of METHOD_NAMES) assert.equal(setup.childProcess[name], setup.originals[name])
})

test('Windows overloads preserve frozen options and cannot disable hiding', async t => {
  for (const name of METHOD_NAMES) {
    await t.test(name, async () => {
      const setup = await loadWrapper()
      const options = Object.freeze({
        windowsHide: false,
        cwd: 'C:\\fixture-work',
        env: Object.freeze({ FIXTURE_ONLY: 'yes' }),
        timeout: 500,
        signal: new AbortController().signal,
        shell: false,
        stdio: 'pipe',
        killSignal: 'SIGTERM',
      })
      const forms = name === 'exec' || name === 'execSync'
        ? [[options]]
        : [[options], [[], options], [undefined, options], [null, options]]
      for (const args of forms) {
        setup.childProcess[name]('fixture', ...args)
        const forwarded = setup.calls.at(-1).args.find(value => value?.windowsHide === true)
        assert.ok(forwarded)
        assert.notEqual(forwarded, options)
        assert.deepEqual({ ...forwarded }, { ...options, windowsHide: true })
        assert.equal(options.windowsHide, false)
      }
    })
  }
})

test('execFile preserves every callback overload including null or undefined args', async () => {
  const setup = await loadWrapper()
  const callback = () => {}
  const options = Object.freeze({ windowsHide: false, cwd: 'C:\\fixture-work' })
  for (const args of [
    [callback], [options, callback], [[], callback], [[], options, callback],
    [undefined, options, callback], [null, options, callback],
    [undefined, callback], [null, callback], [[], null, callback],
  ]) {
    setup.childProcess.execFile('fixture', ...args)
    const forwarded = setup.calls.at(-1).args
    assert.ok(Array.isArray(forwarded[1]))
    assert.equal(forwarded[2].windowsHide, true)
    assert.equal(forwarded[3], callback)
    if (args.includes(options)) assert.equal(forwarded[2].cwd, options.cwd)
  }
  for (const args of [[callback], [options, callback], [undefined, callback], [null, callback]]) {
    setup.childProcess.exec('fixture', ...args)
    assert.equal(setup.calls.at(-1).args[1].windowsHide, true)
    assert.equal(setup.calls.at(-1).args[2], callback)
  }
})

test('invalid spawn/file options and args remain available to Node validators', async () => {
  const setup = await loadWrapper()
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    for (const invalid of ['invalid', 7, [], () => {}]) {
      // execFile treats a function in the options position as a callback.
      if (typeof invalid === 'function' && name.startsWith('execFile')) continue
      setup.childProcess[name]('fixture', [], invalid)
      assert.equal(setup.calls.at(-1).args[2], invalid)
    }
    for (const invalid of ['invalid', 7]) {
      setup.childProcess[name]('fixture', invalid)
      assert.equal(setup.calls.at(-1).args[1], invalid)
    }
  }
  for (const name of ['spawn', 'spawnSync']) {
    setup.childProcess[name]('fixture', [], null)
    assert.equal(setup.calls.at(-1).args[2].windowsHide, true)
  }
  for (const name of ['fork', 'execFile', 'execFileSync']) {
    setup.childProcess[name]('fixture', [], null)
    assert.equal(setup.calls.at(-1).args[2].windowsHide, true)
  }
})

test('custom promisify preserves stdout stderr child errors and hidden execution', async t => {
  for (const name of ['exec', 'execFile']) {
    for (const fail of [false, true]) {
      await t.test(`${name} ${fail ? 'failure' : 'success'}`, async () => {
        const child = { pid: 123, kill: () => true }
        let callback
        const setup = await loadWrapper('win32', {
          implementations: { [name]: (...args) => { callback = args.at(-1); return child } },
        })
        const options = Object.freeze({ windowsHide: false, timeout: 100 })
        const promise = promisify(setup.childProcess[name])('fixture', options)
        assert.equal(promise.child, child)
        const forwardedOptions = setup.calls.at(-1).args[name === 'exec' ? 1 : 2]
        assert.equal(forwardedOptions.windowsHide, true)
        assert.equal(forwardedOptions.timeout, 100)
        const stdout = Buffer.from('stdout')
        const stderr = Buffer.from('stderr')
        if (fail) {
          const error = Object.assign(new Error('fixture failure'), { code: 'ABORT_ERR' })
          callback(error, stdout, stderr)
          await assert.rejects(promise, received => received === error
            && received.stdout === stdout && received.stderr === stderr && received.code === 'ABORT_ERR')
        } else {
          callback(null, stdout, stderr)
          const result = await promise
          assert.deepEqual({ ...result }, { stdout, stderr })
        }
      })
    }
  }
})

test('promisify supports omitted args, synchronous callbacks and repeated preload', async () => {
  for (const name of ['exec', 'execFile']) {
    const child = { pid: 123 }
    const setup = await loadWrapper('win32', {
      loads: 2,
      implementations: { [name]: (...args) => { args.at(-1)(null, 'out', 'err'); return child } },
    })
    for (const args of name === 'execFile' ? [[], [undefined, { windowsHide: false }], [null, { windowsHide: false }]] : [[]]) {
      const promise = promisify(setup.childProcess[name])('fixture', ...args)
      assert.equal(promise.child, child)
      assert.deepEqual({ ...await promise }, { stdout: 'out', stderr: 'err' })
      assert.equal(setup.calls.at(-1).args[name === 'exec' ? 1 : 2].windowsHide, true)
    }
    assert.equal(setup.synchronized(), 2)
  }
})

test('promisify preserves native synchronous validation failures', async () => {
  for (const name of ['exec', 'execFile']) {
    const error = new TypeError('fixture invalid arguments')
    const setup = await loadWrapper('win32', {
      implementations: { [name]: () => { throw error } },
    })
    assert.throws(() => promisify(setup.childProcess[name])('fixture'), received => received === error)
  }
})
