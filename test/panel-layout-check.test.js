import assert from 'node:assert/strict'
import test from 'node:test'
import { panelOccupiesLayoutOnce } from '../scripts/lib/panel-layout-check.mjs'

test('native panel reserves its width once without shrinking the measured frame', () => {
  for (const viewportWidth of [840, 1000, 1400, 1920]) {
    for (const panelWidth of [0, 240, 280, 400]) {
      const measurement = { viewportWidth, appWidth: viewportWidth, frameWidth: viewportWidth, framePaddingRight: panelWidth, panelWidth }
      assert.equal(panelOccupiesLayoutOnce(measurement), true)
      if (panelWidth > 0) {
        assert.equal(panelOccupiesLayoutOnce({ ...measurement, appWidth: viewportWidth - panelWidth, frameWidth: viewportWidth - panelWidth }), false)
        assert.equal(panelOccupiesLayoutOnce({ ...measurement, framePaddingRight: 0 }), false)
        assert.equal(panelOccupiesLayoutOnce({ ...measurement, framePaddingRight: panelWidth * 2 }), false)
      }
    }
  }
})

test('missing, hidden or invalid layout measurements cannot pass', () => {
  const good = { viewportWidth: 1400, appWidth: 1400, frameWidth: 1400, framePaddingRight: 280, panelWidth: 280 }
  for (const key of Object.keys(good)) {
    for (const value of [null, undefined, NaN, Infinity, '280']) {
      assert.equal(panelOccupiesLayoutOnce({ ...good, [key]: value }), false)
    }
  }
  assert.equal(panelOccupiesLayoutOnce({ ...good, viewportWidth: 0 }), false)
  assert.equal(panelOccupiesLayoutOnce({ ...good, panelWidth: -1 }), false)
})
