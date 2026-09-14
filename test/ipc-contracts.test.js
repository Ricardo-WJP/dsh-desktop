import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  ACTIVE_MODES,
  IPC_CHANNELS,
  IPC_CHANNEL_VALUES,
  MANAGEMENT_ROUTES,
  SWITCHABLE_MODES,
  assertIpcChannel,
  isTrustedSender,
  validateActiveMode,
  validateBuildScripts,
  validateCandidateChannel,
  validateEnabled,
  validateLogLimit,
  validateManagementRoute,
  validateMarketPluginUpdateRequest,
  validateMode,
  validatePluginName,
  validatePluginSpec,
  validateSnapshotId,
  validateSourceUrl,
  validateTitlebarMenuRequest,
  validateTitlebarNavigation,
} from '../src/ipc/contracts.js'

const rendererPath = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))

 test('IPC channels and management routes are explicit and stable', () => {
  assert.equal(IPC_CHANNELS.status.get, 'dsh-desktop:status')
  assert.equal(IPC_CHANNELS.update.desktopCheck, 'dsh-desktop:desktop-update-check')
  assert.deepEqual(ACTIVE_MODES, ['legacy', 'stable', 'dev'])
  assert.deepEqual(SWITCHABLE_MODES, ['stable', 'dev'])
  assert.equal(IPC_CHANNELS.openPath, 'dsh-desktop:open-path')
  assert.equal(IPC_CHANNELS.workspaceContext, 'dsh-desktop:workspace-context')
  assert.equal(IPC_CHANNELS.workspace.titlebarMenu, 'dsh-desktop:workspace-titlebar-menu')
  assert.equal(IPC_CHANNELS.workspace.titlebarNavigate, 'dsh-desktop:workspace-titlebar-navigate')
  assert.equal(IPC_CHANNELS.plugins.openManager, 'dsh-desktop:plugins-open-manager')
  assert.equal(IPC_CHANNELS.plugins.install, 'dsh-desktop:plugins-install')
  assert.equal(IPC_CHANNELS.snapshots.restore, 'dsh-desktop:snapshot-restore')
  assert.deepEqual(MANAGEMENT_ROUTES, ['loading', 'overview', 'mode', 'plugins', 'update', 'recovery', 'diagnostics', 'error'])
  assert.equal(new Set(IPC_CHANNEL_VALUES).size, IPC_CHANNEL_VALUES.length)
  for (const channel of IPC_CHANNEL_VALUES) assert.equal(assertIpcChannel(channel), channel)
  assert.throws(() => assertIpcChannel(undefined), /Unknown IPC channel/)
})

test('IPC argument validators reject shell-like and out-of-range input', () => {
  assert.equal(validatePluginSpec('@scope/plugin@1.2.3'), '@scope/plugin@1.2.3')
  assert.equal(validatePluginSpec('github:owner/repo#abc123'), 'github:owner/repo#abc123')
  assert.throws(() => validatePluginSpec('--global'), /Invalid plugin spec/)
  assert.throws(() => validatePluginSpec('plugin && del *'), /Invalid plugin spec/)
  assert.equal(validatePluginName('@scope/plugin'), '@scope/plugin')
  assert.throws(() => validatePluginName('../plugin'), /Invalid plugin name/)
  assert.equal(validateBuildScripts(false), false)
  assert.equal(validateEnabled(true), true)
  assert.equal(validateActiveMode('legacy'), 'legacy')
  assert.equal(validateMode('stable'), 'stable')
  assert.throws(() => validateActiveMode('bootstrap'), /Invalid active mode/)
  assert.throws(() => validateMode('legacy'), /Invalid mode/)
  assert.throws(() => validateMode('shell'), /Invalid mode/)
  assert.equal(validateCandidateChannel('next'), 'next')
  assert.equal(validateSnapshotId('snapshot-1'), 'snapshot-1')
  assert.equal(validateLogLimit(200), 200)
  assert.throws(() => validateLogLimit(0), /Invalid log limit/)
  assert.equal(validateManagementRoute('diagnostics'), 'diagnostics')
  assert.throws(() => validateManagementRoute('src/main.js'), /Invalid management route/)
  assert.equal(validateSourceUrl('https://github.com/example/plugin'), 'https://github.com/example/plugin')
  assert.throws(() => validateSourceUrl('https://example.com/plugin'), /GitHub HTTPS/)
  assert.deepEqual(validateTitlebarMenuRequest({ menu: 'file', x: 12, y: 40 }), { menu: 'file', x: 12, y: 40 })
  assert.equal(validateTitlebarNavigation('back'), 'back')
  assert.equal(validateTitlebarNavigation('forward'), 'forward')
  assert.throws(() => validateTitlebarMenuRequest({ menu: 'window', x: 12, y: 40 }), /Invalid title-bar menu/)
  assert.throws(() => validateTitlebarMenuRequest({ menu: 'file', x: -1, y: 40 }), /menu x/)
  assert.throws(() => validateTitlebarMenuRequest({ menu: 'file', x: 12, y: 40, command: 'quit' }), /Unknown title-bar menu field/)
  assert.throws(() => validateTitlebarNavigation('reload'), /Invalid title-bar navigation direction/)
  assert.deepEqual(validateMarketPluginUpdateRequest({
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.2.3' },
      { name: 'plugin-b', kind: 'github', target: 'a'.repeat(40) },
    ],
  }), {
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.2.3' },
      { name: 'plugin-b', kind: 'github', target: 'a'.repeat(40) },
    ],
  })
  assert.throws(() => validateMarketPluginUpdateRequest({
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.2.3' },
      { name: 'plugin-a', kind: 'npm', target: '1.2.4' },
    ],
  }), /duplicates/i)
})

test('sender validation requires the exact BrowserWindow and allowed origin/path', () => {
  const webContents = {}
  const window = { webContents, isDestroyed: () => false }
  const rendererUrl = pathToFileURL(rendererPath).href
  assert.equal(isTrustedSender({ sender: webContents, senderFrame: { url: rendererUrl } }, window, { allowedPaths: [rendererPath] }), true)
  assert.equal(isTrustedSender({ sender: {}, senderFrame: { url: rendererUrl } }, window, { allowedPaths: [rendererPath] }), false)
  assert.equal(isTrustedSender({ sender: webContents, senderFrame: { url: 'http://127.0.0.1:5173/' } }, window, { allowedOrigins: ['http://127.0.0.1:5173'] }), true)
  assert.equal(isTrustedSender({ sender: webContents, senderFrame: { url: 'http://127.0.0.1:5174/' } }, window, { allowedOrigins: ['http://127.0.0.1:5173'] }), false)
})
