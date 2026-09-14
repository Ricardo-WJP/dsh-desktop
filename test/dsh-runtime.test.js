import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  activateManagedDsh,
  checkForDshUpdate,
  deactivateManagedDsh,
  installDshVersion,
  parseDshRegistryRelease,
  parseDshRegistryVersion,
  readActiveDshRuntime,
  resolveManagedDshRuntimeRoot,
  resolveDshDistTag,
} from '../src/dsh-runtime.js'

const fixtureUserProfile = process.platform === 'win32' ? 'C:\\Users\\tester' : '/Users/tester'

test('managed desktop runtime prefers the non-virtualized user profile over app data', () => {
  assert.equal(
    resolveManagedDshRuntimeRoot({
      userProfile: fixtureUserProfile,
      userData: join(fixtureUserProfile, 'AppData', 'Roaming', 'dsh-desktop'),
    }),
    join(fixtureUserProfile, '.dsh-desktop-runtime'),
  )
})

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-runtime-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeDshPackage(directory, version) {
  const packageDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageDirectory, 'lib'), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
  })}\n`)
  writeFileSync(join(packageDirectory, 'lib', 'bin.js'), '// dsh\n')
  return join(packageDirectory, 'package.json')
}

test('active DSH runtime falls back to the bundled package when no managed version is selected', (t) => {
  const root = temporaryDirectory(t)
  const bundledManifestPath = writeDshPackage(join(root, 'bundled'), '1.0.0')
  const runtimeRoot = join(root, 'runtime')

  const runtime = readActiveDshRuntime({ runtimeRoot, bundledManifestPath })

  assert.equal(runtime.source, 'bundled')
  assert.equal(runtime.version, '1.0.0')
  assert.equal(runtime.managedError, undefined)
})

test('active DSH runtime accepts only a verified app-managed version directory', (t) => {
  const root = temporaryDirectory(t)
  const bundledManifestPath = writeDshPackage(join(root, 'bundled'), '1.0.0')
  const runtimeRoot = join(root, 'runtime')
  writeDshPackage(join(runtimeRoot, 'versions', '1.1.0'), '1.1.0')
  mkdirSync(dirname(join(runtimeRoot, 'active.json')), { recursive: true })
  writeFileSync(join(runtimeRoot, 'active.json'), '{"version":"1.1.0"}\n')

  const runtime = readActiveDshRuntime({ runtimeRoot, bundledManifestPath })
  assert.equal(runtime.source, 'managed')
  assert.equal(runtime.version, '1.1.0')

  writeFileSync(join(runtimeRoot, 'active.json'), '{"version":"../outside"}\n')
  const fallback = readActiveDshRuntime({ runtimeRoot, bundledManifestPath })
  assert.equal(fallback.source, 'bundled')
  assert.match(fallback.managedError, /Invalid DSH version/)
})

test('registry version parser accepts pnpm JSON and rejects ambiguous output', () => {
  assert.equal(parseDshRegistryVersion('"0.1.0-rc.6"\n'), '0.1.0-rc.6')
  assert.equal(parseDshRegistryVersion('warning\n{"version":"1.2.3"}\n'), '1.2.3')
  assert.throws(() => parseDshRegistryVersion('latest'), /invalid DSH version/)
})

test('stable and next dist-tags resolve to an exact version plus package integrity', async t => {
  assert.deepEqual(parseDshRegistryRelease('warning\n{"version":"1.2.3","dist":{"integrity":"sha512-Y2xp"}}\n', 'stable'), {
    channel: 'stable',
    version: '1.2.3',
    integrity: 'sha512-Y2xp',
  })
  assert.throws(() => parseDshRegistryRelease('{"version":"^1.2.3"}', 'next'), /exact next DSH version and integrity/)
  assert.throws(() => parseDshRegistryRelease('{"version":"1.2.3"}', 'stable'), /exact stable DSH version and integrity/)

  const calls = []
  const resolved = await resolveDshDistTag({
    channel: 'next',
    runtimeRoot: temporaryDirectory(t),
    pnpmEntry: '/pnpm.mjs',
    runPnpmImpl: async invocation => {
      calls.push(invocation)
      return { output: '{"version":"1.3.0-rc.1","dist.integrity":"sha512-cmVhZHk="}' }
    },
  })
  assert.deepEqual(resolved, {
    packageName: '@deepseek-ai/dsh',
    distTag: 'next',
    channel: 'next',
    version: '1.3.0-rc.1',
    integrity: 'sha512-cmVhZHk=',
  })
  assert.deepEqual(calls[0].args, ['view', '@deepseek-ai/dsh@next', 'version', 'dist.integrity', '--json'])
})

test('stable dist-tag fallback resolves the latest published exact release when the tag is absent', async t => {
  const calls = []
  const resolved = await resolveDshDistTag({
    channel: 'stable',
    runtimeRoot: temporaryDirectory(t),
    pnpmEntry: '/pnpm.mjs',
    runPnpmImpl: async invocation => {
      calls.push(invocation)
      if (invocation.args[1] === '@deepseek-ai/dsh@stable') {
        throw new Error('{"error":{"code":"ERR_PNPM_PACKAGE_NOT_FOUND","message":"No matching version found for @deepseek-ai/dsh@stable"}}')
      }
      return { output: '{"version":"0.1.1-rc.2","dist.integrity":"sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg=="}' }
    },
  })

  assert.deepEqual(resolved, {
    packageName: '@deepseek-ai/dsh',
    distTag: 'stable',
    channel: 'stable',
    version: '0.1.1-rc.2',
    integrity: 'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==',
  })
  assert.deepEqual(calls.map(call => call.args), [
    ['view', '@deepseek-ai/dsh@stable', 'version', 'dist.integrity', '--json'],
    ['view', '@deepseek-ai/dsh', 'version', 'dist.integrity', '--json'],
  ])
})

test('DSH update check compares the running version with npm latest', async (t) => {
  const runtimeRoot = temporaryDirectory(t)
  const calls = []
  const result = await checkForDshUpdate({
    currentVersion: '0.1.0-rc.5',
    runtimeRoot,
    pnpmEntry: '/pnpm.mjs',
    runPnpmImpl: async options => {
      calls.push(options)
      return { output: '"0.1.0-rc.6"\n' }
    },
  })

  assert.equal(result.available, true)
  assert.equal(result.latestVersion, '0.1.0-rc.6')
  assert.deepEqual(calls[0].args, ['view', '@deepseek-ai/dsh', 'version', '--json'])
  assert.equal(calls[0].profileDir, runtimeRoot)
})

test('DSH installation stages, verifies, and reuses an exact npm version without activation', async (t) => {
  const runtimeRoot = temporaryDirectory(t)
  const calls = []
  let workspace
  const options = {
    version: '1.2.3',
    runtimeRoot,
    pnpmEntry: '/pnpm.mjs',
    runPnpmImpl: async invocation => {
      calls.push(invocation)
      workspace = readFileSync(join(invocation.profileDir, 'pnpm-workspace.yaml'), 'utf8')
      writeDshPackage(invocation.profileDir, '1.2.3')
      return { output: '' }
    },
  }

  const installed = await installDshVersion(options)
  assert.equal(installed.version, '1.2.3')
  assert.equal(installed.reused, false)
  assert.match(workspace, /node-pty: true/)
  assert.match(workspace, /"@google\/genai": false/)
  assert.equal(calls[0].args.at(-1), '@deepseek-ai/dsh@1.2.3')
  assert.equal(calls[0].args.includes('--ignore-scripts'), true)
  const expectedRebuildPackages = process.platform === 'win32'
    ? ['koffi', 'node-pty']
    : ['@deepseek-ai/dsh-subprocess-local', 'koffi', 'node-pty']
  assert.deepEqual(calls[1].args, ['rebuild', ...expectedRebuildPackages, '--reporter', 'append-only'])
  assert.equal(existsSync(join(runtimeRoot, 'active.json')), false)

  const reused = await installDshVersion(options)
  assert.equal(reused.reused, true)
  assert.equal(calls.length, 2)
  assert.equal(existsSync(join(runtimeRoot, 'active.json')), false)

  activateManagedDsh(runtimeRoot, '1.2.3')
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeRoot, 'active.json'), 'utf8')), { version: '1.2.3' })
  deactivateManagedDsh(runtimeRoot)
  assert.equal(readFileSync(join(installed.manifestPath), 'utf8').includes('1.2.3'), true)
})

test('expected DSH integrity fails closed when the staging lockfile has no integrity', async t => {
  const root = temporaryDirectory(t)
  const runtimeRoot = join(root, 'runtime')
  writeDshPackage(join(runtimeRoot, 'versions', '1.0.0'), '1.0.0')
  writeFileSync(join(runtimeRoot, 'active.json'), '{"version":"1.0.0"}\n')

  await assert.rejects(installDshVersion({
    version: '1.1.0',
    integrity: 'sha512-Y2xp',
    runtimeRoot,
    pnpmEntry: '/pnpm.mjs',
    runPnpmImpl: async invocation => {
      writeDshPackage(invocation.profileDir, '1.1.0')
      return { output: '' }
    },
  }), /package integrity is missing from the lockfile/)

  assert.deepEqual(JSON.parse(readFileSync(join(runtimeRoot, 'active.json'), 'utf8')), { version: '1.0.0' })
  assert.equal(existsSync(join(runtimeRoot, 'versions', '1.1.0')), false)
})

test('abort after pnpm leaves the previous active pointer untouched', async (t) => {
  const root = temporaryDirectory(t)
  const runtimeRoot = join(root, 'runtime')
  writeDshPackage(join(runtimeRoot, 'versions', '1.0.0'), '1.0.0')
  writeFileSync(join(runtimeRoot, 'active.json'), '{"version":"1.0.0"}\n')
  const action = new AbortController()

  await assert.rejects(installDshVersion({
    version: '1.1.0',
    runtimeRoot,
    pnpmEntry: '/pnpm.mjs',
    signal: action.signal,
    runPnpmImpl: async invocation => {
      writeDshPackage(invocation.profileDir, '1.1.0')
      action.abort(new Error('cancel after pnpm'))
      return { output: '' }
    },
  }), /cancel after pnpm/)

  assert.deepEqual(JSON.parse(readFileSync(join(runtimeRoot, 'active.json'), 'utf8')), { version: '1.0.0' })
  assert.equal(existsSync(join(runtimeRoot, 'versions', '1.1.0')), false)
})

test('DSH install preserves its primary error and reports cleanup failure', async t => {
  const runtimeRoot = temporaryDirectory(t)
  let cleanupOptions
  await assert.rejects(
    installDshVersion({
      version: '1.2.3',
      runtimeRoot,
      pnpmEntry: '/pnpm.mjs',
      runPnpmImpl: async () => { throw new Error('injected pnpm failure') },
      removeImpl: (_path, options) => {
        cleanupOptions = options
        throw new Error('injected runtime cleanup failure')
      },
    }),
    error => /injected pnpm failure/u.test(error.message)
      && /injected runtime cleanup failure/u.test(error.cleanupError?.message ?? ''),
  )
  assert.deepEqual(cleanupOptions, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  assert.equal(existsSync(join(runtimeRoot, 'active.json')), false)
})
