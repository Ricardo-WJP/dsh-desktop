import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { DESKTOP_PLUGIN_SUITE, DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS } from '../src/plugin-suite.js'
import { readDesktopDistributionFlavor } from '../src/distribution-flavor.js'
import { resolveBundledMnemon } from '../src/plugin-suite-runtime.js'

test('network suite excludes local Signal implementation and pins its npm source', () => {
  const config = createRequire(import.meta.url)('../build/electron-builder.suite.cjs')
  assert(config.files.includes('!build/plugin-suite/plugins/dsh-signal/**/*'))
  assert(config.files.includes('!build/plugin-suite/plugins/dsh-signal.source.json'))
  const signal = DESKTOP_PLUGIN_SUITE.find(entry => entry.packageName === 'dsh-signal')
  assert.deepEqual(signal.source, { type: 'npm', package: 'dsh-signal', versionOrTag: '0.6.12' })
})

test('plugin suite sources are exact, unique, and fully permission-scoped', () => {
  assert.equal(DESKTOP_PLUGIN_SUITE.length, 27)
  assert.equal(new Set(DESKTOP_PLUGIN_SUITE.map(entry => entry.packageName)).size, DESKTOP_PLUGIN_SUITE.length)
  for (const entry of DESKTOP_PLUGIN_SUITE) {
    assert.equal(DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS[entry.packageName], true)
    if (entry.source.type === 'npm') assert.equal(entry.source.versionOrTag, entry.packageName === 'dsh-signal' ? '0.6.12' : undefined)
    if (entry.source.type === 'github') assert.match(entry.source.ref, /^[a-f0-9]{40}$/i)
    if (entry.source.type === 'local-dev') assert.equal(entry.packageName, 'dsh-signal')
  }
})

test('distribution flavor fails closed to standard', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-flavor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), '{"dshDesktopFlavor":"suite"}\n')
  assert.equal(readDesktopDistributionFlavor(root), 'suite')
  await writeFile(join(root, 'package.json'), '{"dshDesktopFlavor":"unknown"}\n')
  assert.equal(readDesktopDistributionFlavor(root), 'standard')
})

test('bundled Mnemon is accepted only with a matching receipt and checksum', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-suite-mnemon-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'build', 'plugin-suite', 'bin', 'win32-x64')
  await mkdir(directory, { recursive: true })
  const executable = Buffer.from('verified-mnemon-binary')
  const digest = createHash('sha256').update(executable).digest('hex')
  await writeFile(join(directory, 'mnemon.exe'), executable)
  await writeFile(join(directory, 'receipt.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    version: '0.2.3',
    executable: 'mnemon.exe',
    binarySha256: digest,
  })}\n`)
  const accepted = resolveBundledMnemon({ appPath: root, platform: 'win32', arch: 'x64' })
  assert.equal(accepted.sha256, digest)
  await writeFile(join(directory, 'mnemon.exe'), 'tampered')
  assert.throws(() => resolveBundledMnemon({ appPath: root, platform: 'win32', arch: 'x64' }), /checksum mismatch/)
})
