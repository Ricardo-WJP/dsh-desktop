import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicAppearance, readSharePreset, seedShareAppearance } from '../src/share-preset.js'

test('share preset allowlist excludes credentials, model routing, memory and paths', () => {
  const appearance = publicAppearance({
    'ui-theme': { preference: 'dark', apiKey: 'must-not-export' },
    'better-dsh-pet': { enabled: true, includeSubagents: true, path: 'private' },
    'llm-pi-ai': { providers: [{ key: 'must-not-export' }] },
    'agent-default-model': { model: 'private-model' },
    memory: 'private', sessions: ['private'], workspace: 'private',
  })
  assert.deepEqual(appearance, { 'ui-theme': { preference: 'dark' }, 'better-dsh-pet': { enabled: true, includeSubagents: true } })
  assert.doesNotMatch(JSON.stringify(appearance), /must-not-export|private/)
})

test('share appearance seeds fresh homes only and source pins reject floating versions', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-share-preset-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'build', 'plugin-suite')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'share-preset.json')
  const preset = { schemaVersion: 1, plugins: [{ name: 'dshmarket', version: '1.44.0' }], appearance: { 'ui-theme': { preference: 'dark' } } }
  writeFileSync(file, JSON.stringify(preset))
  assert.equal(readSharePreset(root).plugins.length, 1)
  const home = join(root, 'fresh-home')
  assert.equal(seedShareAppearance(root, home), true)
  const path = join(home, 'settings.yaml')
  assert.match(readFileSync(path, 'utf8'), /dark/)
  writeFileSync(path, 'existing: keep\n')
  assert.equal(seedShareAppearance(root, home), false)
  assert.equal(readFileSync(path, 'utf8'), 'existing: keep\n')
  preset.plugins[0].version = 'latest'
  writeFileSync(file, JSON.stringify(preset))
  assert.throws(() => readSharePreset(root), /Unpinned/)
})
