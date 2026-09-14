import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptNativeProfileRevision } from '../src/profile/native-profile-revision.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-revision-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'profile'), profilePath = join(root, 'profiles/live')
  await mkdir(sourcePath, { recursive: true })
  await mkdir(join(profilePath, 'node_modules/plugin-a'), { recursive: true })
  for (const [path, version] of [[sourcePath, '1.0.0'], [profilePath, '1.0.1']]) {
    await writeFile(join(path, 'package.json'), JSON.stringify({ private: true, dependencies: { 'plugin-a': version } }))
    await writeFile(join(path, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      plugin-a:\n        specifier: ${version}\n        version: ${version}\n`)
    await writeFile(join(path, 'cordis.patch.yml'), '[]')
  }
  await writeFile(join(profilePath, 'node_modules/plugin-a/package.json'), JSON.stringify({ name: 'plugin-a', version: '1.0.1' }))
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ dsh: { version: '0.1.2-rc.1' }, profile: { physicalName: 'live' } }))
  return { candidateDir: root, sourcePath, profilePath, inspect: async () => ({ ok: true }), gate: async () => ({ ok: true }) }
}
test('accepts a complete native update without rewriting the release snapshot', async t => {
  const f = await fixture(t)
  const before = await readFile(join(f.sourcePath, 'package.json'), 'utf8')
  assert.equal(await acceptNativeProfileRevision(f), f.profilePath)
  assert.equal(await readFile(join(f.sourcePath, 'package.json'), 'utf8'), before)
})
test('rejects incomplete install and configuration changes before executing plugins', async t => {
  const f = await fixture(t)
  let called = false
  f.gate = async () => { called = true; return { ok: true } }
  await writeFile(join(f.profilePath, 'node_modules/plugin-a/package.json'), '{"name":"plugin-a","version":"1.0.0"}')
  await assert.rejects(acceptNativeProfileRevision(f), /incomplete/)
  await writeFile(join(f.profilePath, 'cordis.patch.yml'), '- changed')
  await assert.rejects(acceptNativeProfileRevision(f), /runtime configuration/)
  assert.equal(called, false)
})
test('runtime failure and concurrent input changes are not accepted', async t => {
  const f = await fixture(t)
  f.gate = async () => ({ ok: false })
  await assert.rejects(acceptNativeProfileRevision(f), /preflight failed/)
  f.gate = async () => { await writeFile(join(f.profilePath, 'cordis.patch.yml'), 'changed'); return { ok: true } }
  await assert.rejects(acceptNativeProfileRevision(f), /changed during validation/)
})
