import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  createMainNavigationPolicy,
  createManagementNavigationPolicy,
  isDesktopPage,
  isManagementPage,
} from '../src/navigation.js'

test('disallowed workspace navigation prevents default without throwing', () => {
  const external = []
  let prevented = 0
  const policy = createMainNavigationPolicy({
    getHarnessOrigin: () => 'http://127.0.0.1:43121',
    desktopPaths: [join(tmpdir(), 'dsh-fallback', 'loading.html')],
    openExternal: url => external.push(url),
  })
  const event = { preventDefault: () => { prevented += 1 } }
  assert.doesNotThrow(() => policy.handleWillNavigate(event, 'https://outside.example/blocked'))
  policy.handleWillRedirect(event, 'https://outside.example/redirect')
  assert.equal(prevented, 2)
  assert.deepEqual(external, ['https://outside.example/blocked', 'https://outside.example/redirect'])
})

test('canonical navigation policy allows the exact Harness and desktop fallback pages', () => {
  let prevented = 0
  const desktopPath = join(tmpdir(), 'dsh-fallback', 'loading.html')
  const policy = createMainNavigationPolicy({
    getHarnessOrigin: () => 'http://127.0.0.1:43121',
    desktopPaths: [desktopPath],
  })
  const event = { preventDefault: () => { prevented += 1 } }
  policy.handleWillNavigate(event, 'http://127.0.0.1:43121/workspace')
  policy.handleWillNavigate(event, `${pathToFileURL(desktopPath).href}?lang=en`)
  assert.equal(prevented, 0)
  assert.equal(isDesktopPage(`${pathToFileURL(desktopPath).href}?lang=en`, [desktopPath]), true)
})

test('management navigation policy prevents foreign pages and allows only its renderer', () => {
  const rendererPath = join(tmpdir(), 'dsh-renderer', 'index.html')
  const policy = createManagementNavigationPolicy({
    rendererPath,
    developmentOrigin: 'http://127.0.0.1:5173',
  })
  let prevented = 0
  const event = { preventDefault: () => { prevented += 1 } }
  policy.handleWillNavigate(event, 'https://outside.example/redirect')
  policy.handleWillRedirect(event, 'http://127.0.0.1:5174/redirect')
  assert.equal(prevented, 2)
  policy.handleWillNavigate(event, `${pathToFileURL(rendererPath).href}?route=overview`)
  policy.handleWillRedirect(event, 'http://127.0.0.1:5173/#/overview')
  assert.equal(prevented, 2)
  assert.equal(isManagementPage(`${pathToFileURL(rendererPath).href}?route=overview`, { rendererPath }), true)
  assert.equal(isManagementPage('https://outside.example/redirect', { rendererPath }), false)
})
