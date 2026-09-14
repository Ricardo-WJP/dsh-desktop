import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePluginCompatibilityPolicy } from '../src/compatibility/plugin-policy.js'

test('unknown future plugins use native behavior even when an old recipe marked itself required', () => {
  const report = { checks: [
    { packageName: 'future-search', version: '9.0.0', required: true, state: 'unrecognized' },
    { packageName: 'voice', state: 'compatible' },
    { packageName: 'optional', state: 'absent' },
  ] }
  const result = resolvePluginCompatibilityPolicy(report)
  assert.deepEqual(result.checks.map(check => check.state), ['native', 'compatible', 'absent'])
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].packageName, 'future-search')
  assert.equal(report.checks[0].state, 'unrecognized')
})

test('an explicit mandatory capability and invalid receipts still reject the candidate', () => {
  assert.throws(() => resolvePluginCompatibilityPolicy({
    checks: [{ packageName: 'required-capability', state: 'unrecognized', blocking: true }],
  }), { code: 'PLUGIN_DESKTOP_CAPABILITY_REQUIRED' })
  assert.throws(() => resolvePluginCompatibilityPolicy({ checks: [null] }), TypeError)
})
