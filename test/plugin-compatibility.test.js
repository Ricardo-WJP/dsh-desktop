import assert from 'node:assert/strict'
import test from 'node:test'
import { canPluginSurfaceUse, PLUGIN_COMPATIBILITY, pluginOwnerFor } from '../src/plugin-compatibility.js'

test('legacy plugin manager remains the sole catalog and mutation owner', () => {
  assert.equal(pluginOwnerFor('catalog'), PLUGIN_COMPATIBILITY.legacySurface)
  assert.equal(pluginOwnerFor('mutation'), PLUGIN_COMPATIBILITY.legacySurface)
  assert.equal(canPluginSurfaceUse('catalog', PLUGIN_COMPATIBILITY.legacySurface), true)
  assert.equal(canPluginSurfaceUse('mutation', PLUGIN_COMPATIBILITY.legacySurface), true)
  assert.equal(canPluginSurfaceUse('catalog', 'react-status-entry'), false)
  assert.equal(canPluginSurfaceUse('mutation', 'react-status-entry'), false)
  assert.equal(PLUGIN_COMPATIBILITY.reactRole, 'status-entry')
  assert.match(PLUGIN_COMPATIBILITY.retirementTrigger, /PluginTransactionService parity/)
  assert.match(PLUGIN_COMPATIBILITY.retirementTrigger, /React route\/action regression suite/)
  assert.throws(() => pluginOwnerFor('unknown'), /Unknown plugin capability/)
})
