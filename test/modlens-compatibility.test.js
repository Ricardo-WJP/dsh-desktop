import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../profiles/packages/modlens/', import.meta.url)
const client = readFileSync(new URL('dsh/client.js', root), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const policy = JSON.parse(readFileSync(new URL('../compatibility/plugins.json', import.meta.url), 'utf8'))

test('ModLens compatibility fork preserves package identity and is an immutable local bundle', () => {
  assert.equal(manifest.name, '@liustack/modlens')
  assert.equal(manifest.version, '3.18.1-ricardo.1')
  assert.equal(manifest.scripts, undefined)
  assert.equal(policy.localPackages['@liustack/modlens'], 'profiles/packages/modlens')
  assert.equal(policy.order.filter(name => name === '@liustack/modlens').length, 1)
})

test('ModLens registers the keyed settings slot with one stable key', () => {
  assert.match(client, /ctx\.slots\.inject\('settings\.plugin\.item'/)
  assert.match(client, /ctx\.slots\.register\(\{ name: 'settings\.plugin\.item', key: 'modlens', id: 'modlens', order: 30 \}, Card\)/)
  assert.equal((client.match(/name: 'settings\.plugin\.item'/g) ?? []).length, 1)
  assert.doesNotMatch(client, /name: 'settings\.plugin\.item', id: 'modlens'/)
})
