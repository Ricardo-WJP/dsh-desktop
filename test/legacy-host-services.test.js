import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { prepareLegacyHostServicePatch } from '../src/compatibility/legacy-host-services.js'

test('legacy prompt optimizer waits for model services through an owned overlay without editing the plugin', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-legacy-services-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profile')
  const plugin = join(profile, 'node_modules', 'dsh-prompt-polish')
  await mkdir(join(plugin, 'lib'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-prompt-polish'] } } }))
  const source = "export const inject = ['timer']; export function apply(ctx) { const llm = ctx.get('llm'); }"
  await writeFile(join(plugin, 'lib', 'index.js'), source)
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: optimizer-custom-id\n      name: dsh-prompt-polish\n')
  const path = await prepareLegacyHostServicePatch(home, profile)
  assert.deepEqual(parse(await readFile(path, 'utf8')), [{ id: 'optimizer-custom-id', inject: ['timer', 'llm', 'agentDefaultModel'] }])
  assert.equal(await readFile(join(plugin, 'lib', 'index.js'), 'utf8'), source)
  assert.equal(await prepareLegacyHostServicePatch(home, profile), path)
  await writeFile(join(plugin, 'lib', 'index.js'), source.replace("['timer']", "['timer', 'llm']"))
  assert.equal(await prepareLegacyHostServicePatch(home, profile), undefined, 'upstream fix owns its own dependencies')
  await writeFile(join(profile, 'package.json'), '{}')
  assert.equal(await prepareLegacyHostServicePatch(home, profile), undefined, 'uninstalled plugin is never added')
})
