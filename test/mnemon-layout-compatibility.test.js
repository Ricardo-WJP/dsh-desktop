import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  MNEMON_EXTERNAL_PAGE_MARKER,
  MNEMON_EXTERNAL_PAGE_SELECTOR,
  mnemonExternalPageSize,
} from '../scripts/lib/mnemon-layout-compatibility.mjs'

const clientPath = fileURLToPath(new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url))

test('mnemon external page owns neither root width nor native panel state', () => {
  const client = readFileSync(clientPath, 'utf8')
  assert.match(client, new RegExp(MNEMON_EXTERNAL_PAGE_SELECTOR.replace(/[.[\]()*+?^${}|\\]/g, '\\$&')))
  const marker = client.match(/const markExternalPageLayout = \(\) => \{[\s\S]+?\n      \}/)
  assert.ok(marker, 'the external page marker should remain a dedicated synchronizer')
  assert.match(marker[0], /querySelectorAll\('section\[data-dsh-mnemon-view\]'\)/)
  assert.match(marker[0], /page\.dataset\.dshDesktopExternalPage = 'true'/)
  assert.doesNotMatch(marker[0], /getBoundingClientRect|style\.(?:width|height)|setProperty\(['"](?:width|height)/)
  assert.match(client, /markPanelLayout\(\)\n\s+markExternalPageLayout\(\)/)
  assert.match(client, /right:var\(--dsh-sidebar-width,0px\)!important/)
  assert.match(client, /bottom:var\(--dsh-sidebar-height,0px\)!important/)
  assert.match(client, /width:auto!important;height:auto!important/)
  assert.match(client, /body\[data-dsh-sidebar-dragging\] section\[data-dsh-mnemon-view\]/)
  assert.match(client, /window\.addEventListener\('resize', onResize\)/)
  assert.doesNotMatch(client, /#root[^{}]*width:calc\(100%\s*-\s*var\(--dsh-sidebar-width/)
  assert.match(client, new RegExp(`delete element\\.dataset\\.dshDesktopExternalPage`))
  assert.equal(MNEMON_EXTERNAL_PAGE_MARKER, 'data-dsh-desktop-external-page')
})

test('right and bottom panel insets remain independent for the fixed page', () => {
  assert.deepEqual(mnemonExternalPageSize({
    viewportWidth: 1440,
    viewportHeight: 900,
    left: 248,
    top: 40,
    rightInset: 280,
    bottomInset: 300,
  }), { width: 912, height: 560 })

  assert.deepEqual(mnemonExternalPageSize({
    viewportWidth: 1440,
    viewportHeight: 900,
    left: 248,
    top: 40,
    rightInset: 0,
    bottomInset: 0,
  }), { width: 1192, height: 860 })
})

test('invalid or oversized panel insets cannot create negative page geometry', () => {
  assert.deepEqual(mnemonExternalPageSize({
    viewportWidth: 400,
    viewportHeight: 300,
    left: 500,
    top: 400,
    rightInset: Infinity,
    bottomInset: -20,
  }), { width: 0, height: 0 })
})
