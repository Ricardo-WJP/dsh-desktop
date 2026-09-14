import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const DWMWA_BORDER_COLOR = 34
export const DWMWA_CAPTION_COLOR = 35
export const DWMWA_TEXT_COLOR = 36
export const DWMWA_WINDOW_CORNER_PREFERENCE = 33
export const DWMWA_COLOR_NONE = 0xfffffffe

export function colorRefFromHex(value) {
  if (typeof value !== 'string') return undefined
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (match === null) return undefined
  const rgb = Number.parseInt(match[1], 16)
  const red = (rgb >>> 16) & 0xff
  const green = (rgb >>> 8) & 0xff
  const blue = rgb & 0xff
  return ((blue << 16) | (green << 8) | red) >>> 0
}

let cachedApi

function nativeHandle(window) {
  if (typeof window?.getNativeWindowHandle !== 'function') return undefined
  const value = window.getNativeWindowHandle()
  if (!Buffer.isBuffer(value)) return undefined
  if (value.byteLength >= 8) return value.readBigUInt64LE(0)
  if (value.byteLength >= 4) return BigInt(value.readUInt32LE(0))
  return undefined
}

function windowsFrameApi() {
  cachedApi ??= (() => {
    const koffi = require('koffi')
    const dwmapi = koffi.load('dwmapi.dll')
    return {
      setWindowAttribute: dwmapi.func(
        'long __stdcall DwmSetWindowAttribute(void *, uint32, void *, uint32)',
      ),
    }
  })()
  return cachedApi
}

function writeColorAttribute(frameApi, handle, attribute, color) {
  const colorRef = typeof color === 'string' ? colorRefFromHex(color) : color
  if (!Number.isInteger(colorRef) || colorRef < 0 || colorRef > 0xffffffff) return false
  const colorBuffer = Buffer.alloc(4)
  colorBuffer.writeUInt32LE(colorRef, 0)
  return frameApi.setWindowAttribute(handle, attribute, colorBuffer, colorBuffer.byteLength) === 0
}

/**
 * Themes the ordinary Windows non-client frame while keeping native dragging,
 * resize handles, rounded corners, shadows and caption-button behaviour.
 * Unsupported attributes fail cosmetically and never block application start.
 */
export function applyWindowsWindowFrameTheme(window, {
  platform = process.platform,
  api,
  borderColor = DWMWA_COLOR_NONE,
  captionColor,
  textColor,
  cornerPreference,
} = {}) {
  if (platform !== 'win32') return false
  const handle = nativeHandle(window)
  if (handle === undefined) return false

  try {
    const frameApi = api ?? windowsFrameApi()
    const requested = [
      [DWMWA_BORDER_COLOR, borderColor],
      [DWMWA_CAPTION_COLOR, captionColor],
      [DWMWA_TEXT_COLOR, textColor],
      [DWMWA_WINDOW_CORNER_PREFERENCE, cornerPreference],
    ].filter(([, color]) => color !== undefined)
    return requested.length > 0 && requested.every(([attribute, color]) => (
      writeColorAttribute(frameApi, handle, attribute, color)
    ))
  } catch {
    return false
  }
}

/** Backwards-compatible border-only helper used by older callers and tests. */
export function suppressWindowsWindowBorder(window, {
  platform = process.platform,
  api,
  color = DWMWA_COLOR_NONE,
} = {}) {
  return applyWindowsWindowFrameTheme(window, { platform, api, borderColor: color })
}
