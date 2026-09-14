import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

test('a mismatched onboarding response unlocks the existing retry path', async () => {
  const source = readFileSync(new URL('../src/pages/plugins-onboarding.html', import.meta.url), 'utf8')
  const start = source.indexOf("install.addEventListener('click', async () => {")
  const end = source.indexOf('const unsubscribeProgress', start)
  assert(start >= 0 && end > start)
  let click
  const busy = []
  const errors = []
  const context = vm.createContext({
    busy: false, activeTransactionId: '',
    crypto: { randomUUID: () => 'fixture' },
    install: { addEventListener: (_event, fn) => { click = fn } },
    selectedIds: () => ['fixture-plugin'],
    bridge: { install: async () => ({ ok: true, transactionId: 'wrong-transaction' }) },
    setBusy: value => busy.push(value), setProgress() {}, setStatus() {},
    showError: message => errors.push(message),
  })
  vm.runInContext(source.slice(start, end), context)
  await click()
  assert.deepEqual(busy, [true, false])
  assert.equal(context.activeTransactionId, '')
  assert.equal(errors.length, 1)
})
