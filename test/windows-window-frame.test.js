import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyWindowsWindowFrameTheme,
  colorRefFromHex,
  DWMWA_BORDER_COLOR,
  DWMWA_CAPTION_COLOR,
  DWMWA_COLOR_NONE,
  DWMWA_TEXT_COLOR,
  DWMWA_WINDOW_CORNER_PREFERENCE,
  suppressWindowsWindowBorder,
} from '../src/windows-window-frame.js'

function fakeWindow(handle = 0x1234n) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(handle)
  return { getNativeWindowHandle: () => buffer }
}

test('Acrylic windows request native rounded corners without a thick frame', () => {
  const calls = []
  assert.equal(applyWindowsWindowFrameTheme(fakeWindow(), {
    platform: 'win32', cornerPreference: 2,
    api: { setWindowAttribute: (_handle, attribute, value) => {
      calls.push([attribute, value.readUInt32LE(0)])
      return 0
    } },
  }), true)
  assert.deepEqual(calls, [[DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE], [DWMWA_WINDOW_CORNER_PREFERENCE, 2]])
})

test('Windows border suppression sends DWMWA_COLOR_NONE without changing the frame', () => {
  const calls = []
  const result = suppressWindowsWindowBorder(fakeWindow(), {
    platform: 'win32',
    api: {
      setWindowAttribute: (handle, attribute, color, size) => {
        calls.push({ handle, attribute, color: color.readUInt32LE(0), size })
        return 0
      },
    },
  })

  assert.equal(result, true)
  assert.deepEqual(calls, [{
    handle: 0x1234n,
    attribute: DWMWA_BORDER_COLOR,
    color: DWMWA_COLOR_NONE,
    size: 4,
  }])
})

test('Windows border suppression converts a CSS theme color to COLORREF', () => {
  const calls = []
  const result = suppressWindowsWindowBorder(fakeWindow(), {
    platform: 'win32',
    color: '#f9fafb',
    api: {
      setWindowAttribute: (handle, attribute, color, size) => {
        calls.push({ handle, attribute, color: color.readUInt32LE(0), size })
        return 0
      },
    },
  })

  assert.equal(colorRefFromHex('#f9fafb'), 0x00fbfaf9)
  assert.equal(colorRefFromHex('#0C1017'), 0x0017100c)
  assert.equal(colorRefFromHex('transparent'), undefined)
  assert.equal(result, true)
  assert.deepEqual(calls, [{
    handle: 0x1234n,
    attribute: DWMWA_BORDER_COLOR,
    color: 0x00fbfaf9,
    size: 4,
  }])
})

test('Windows frame theme applies matching border, caption and readable symbols', () => {
  const calls = []
  const result = applyWindowsWindowFrameTheme(fakeWindow(), {
    platform: 'win32',
    borderColor: '#1d1e20',
    captionColor: '#1d1e20',
    textColor: '#f9fafb',
    api: {
      setWindowAttribute: (_handle, attribute, color) => {
        calls.push({ attribute, color: color.readUInt32LE(0) })
        return 0
      },
    },
  })

  assert.equal(result, true)
  assert.deepEqual(calls, [
    { attribute: DWMWA_BORDER_COLOR, color: colorRefFromHex('#1d1e20') },
    { attribute: DWMWA_CAPTION_COLOR, color: colorRefFromHex('#1d1e20') },
    { attribute: DWMWA_TEXT_COLOR, color: colorRefFromHex('#f9fafb') },
  ])
})

test('Windows border suppression is a safe no-op off Windows or without a native handle', () => {
  let called = false
  const api = { setWindowAttribute: () => { called = true; return 0 } }
  assert.equal(suppressWindowsWindowBorder(fakeWindow(), { platform: 'linux', api }), false)
  assert.equal(suppressWindowsWindowBorder({}, { platform: 'win32', api }), false)
  assert.equal(called, false)
})

test('Windows border suppression tolerates DWM failure', () => {
  assert.equal(suppressWindowsWindowBorder(fakeWindow(), {
    platform: 'win32',
    api: { setWindowAttribute: () => { throw new Error('unsupported') } },
  }), false)
})
