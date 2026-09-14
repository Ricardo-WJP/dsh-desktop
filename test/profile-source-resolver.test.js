import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolvePluginSource } from '../src/profile/source-resolver.js'

const commit = 'a'.repeat(40)

test('resolves an exact npm version and a tag through argv-only pnpm', async () => {
  const calls = []
  const runPnpm = async request => {
    calls.push(request)
    return { output: JSON.stringify({ version: request.args[1].endsWith('@next') ? '2.0.0-beta.1' : '1.2.3', dist: { integrity: 'sha512-integrity' } }) }
  }

  const exact = await resolvePluginSource({
    mode: 'stable',
    source: { type: 'npm', package: '@scope/plugin', versionOrTag: '1.2.3' },
    runPnpm,
  })
  const tag = await resolvePluginSource({
    mode: 'next',
    source: { type: 'npm', package: '@scope/plugin', versionOrTag: 'next' },
    runPnpm,
  })

  assert.equal(exact.version, '1.2.3')
  assert.equal(exact.integrity, 'sha512-integrity')
  assert.equal(tag.version, '2.0.0-beta.1')
  assert.deepEqual(calls.map(call => call.args), [
    ['view', '@scope/plugin@1.2.3', 'version', 'dist.integrity', '--json'],
    ['view', '@scope/plugin@next', 'version', 'dist.integrity', '--json'],
  ])
  assert.ok(calls.every(call => call.shell === false && call.args.every(argument => typeof argument === 'string')))
})

test('accepts pnpm flat dist.integrity registry output', async () => {
  const resolved = await resolvePluginSource({
    mode: 'stable',
    source: { type: 'npm', package: 'dshmarket', versionOrTag: 'latest' },
    runPnpm: async () => ({
      output: JSON.stringify({
        version: '1.26.0',
        'dist.integrity': 'sha512-cmVhZHk=',
      }),
    }),
  })

  assert.equal(resolved.version, '1.26.0')
  assert.equal(resolved.integrity, 'sha512-cmVhZHk=')
})

test('parses clean pnpm stdout when the combined stream contains multiline stderr warnings', async () => {
  const stdout = `${JSON.stringify({
    version: '1.29.2',
    'dist.integrity': 'sha512-cmVhZHk=',
  }, undefined, 2)}\n`
  const resolved = await resolvePluginSource({
    mode: 'stable',
    source: { type: 'npm', package: 'dshmarket', versionOrTag: '1.29.2' },
    runPnpm: async () => ({
      stdout,
      stderr: 'ExperimentalWarning: EnvHttpProxyAgent is experimental\n',
      output: `ExperimentalWarning: EnvHttpProxyAgent is experimental\n${stdout}`,
    }),
  })

  assert.equal(resolved.version, '1.29.2')
  assert.equal(resolved.integrity, 'sha512-cmVhZHk=')
})

test('resolves GitHub default/ref to an exact commit and preserves the fixed path form', async () => {
  const calls = []
  const runGit = async request => {
    calls.push(request)
    return { output: `${commit}\t${request.args.at(-1) === 'HEAD' ? 'HEAD' : 'refs/tags/v1.0.0'}\n` }
  }

  const defaultRef = await resolvePluginSource({
    mode: 'stable',
    source: { type: 'github', repository: 'owner/repo' },
    runGit,
  })
  const tagged = await resolvePluginSource({
    mode: 'stable',
    source: { type: 'github', repository: 'owner/repo', ref: 'v1.0.0', path: '/packages/plugin' },
    runGit,
  })

  assert.equal(defaultRef.commit, commit)
  assert.equal(tagged.specifier, `github:owner/repo#${commit}&path:/packages/plugin`)
  assert.deepEqual(calls.map(call => call.args), [
    ['ls-remote', '--symref', 'https://github.com/owner/repo.git', 'HEAD'],
    ['ls-remote', '--refs', 'https://github.com/owner/repo.git', 'v1.0.0'],
  ])
  assert.ok(calls.every(call => call.shell === false))
})

test('rejects commands, shell injection, unknown fields, and invalid GitHub shapes', async () => {
  const never = async () => { throw new Error('runner must not be called') }
  await assert.rejects(() => resolvePluginSource('npm install evil', { mode: 'stable', runPnpm: never }))
  await assert.rejects(() => resolvePluginSource({ mode: 'stable', source: { type: 'npm', package: 'pkg', command: 'echo pwned' }, runPnpm: never }), /Unknown/)
  await assert.rejects(() => resolvePluginSource({ mode: 'stable; echo pwned', source: { type: 'npm', package: 'pkg' }, runPnpm: never }), /mode/)
  await assert.rejects(() => resolvePluginSource({ mode: 'stable', source: { type: 'npm', package: 'pkg;echo pwned' }, runPnpm: never }), /npm package/)
  await assert.rejects(() => resolvePluginSource({ mode: 'stable', source: { type: 'github', repository: 'owner/repo', ref: 'main&echo pwned' }, runGit: never }), /GitHub ref/)
  await assert.rejects(() => resolvePluginSource({ mode: 'stable', source: { type: 'github', repository: 'https://github.com/owner/repo' }, runGit: never }), /owner\/repository/)
})

test('local-dev is an explicit dev-only link confined to allowed roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-source-outside-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  const pluginPath = join(root, 'plugin')
  await mkdir(pluginPath)
  const local = await resolvePluginSource({
    mode: 'dev',
    source: { type: 'local-dev', path: pluginPath },
    allowedRoots: [root],
  })
  assert.equal(local.link, `link:${resolve(pluginPath)}`)
  assert.equal(local.promotable, false)
  await assert.rejects(() => resolvePluginSource({ mode: 'stable', source: { type: 'local-dev', path: root }, allowedRoots: [root] }), /dev mode/)
  await assert.rejects(() => resolvePluginSource({ mode: 'next', source: { type: 'local-dev', path: root }, allowedRoots: [root] }), /dev mode/)
  await assert.rejects(() => resolvePluginSource({ mode: 'dev', source: { type: 'local-dev', path: outside }, allowedRoots: [root] }), /outside/)
  await assert.rejects(() => resolvePluginSource({ mode: 'dev', source: { type: 'local-dev', path: root } }), /allowedRoots/)
  await assert.rejects(() => resolvePluginSource({ mode: 'dev', source: { type: 'local-dev', path: join(root, 'missing') }, allowedRoots: [root] }), /ENOENT/)
})

test('AbortSignal is forwarded and aborts a pending resolver', async () => {
  const controller = new AbortController()
  let request
  const pending = resolvePluginSource({
    mode: 'stable',
    source: { type: 'npm', package: 'pkg', versionOrTag: 'latest' },
    signal: controller.signal,
    runPnpm: value => {
      request = value
      return new Promise(() => {})
    },
  })
  controller.abort(new Error('test abort'))
  await assert.rejects(pending, /test abort/)
  assert.equal(request.signal, controller.signal)
  assert.equal(request.shell, false)
})
