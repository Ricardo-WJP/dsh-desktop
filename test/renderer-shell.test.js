import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { createDesktopRuntimeController } from '../src/desktop-runtime-controller.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const integrationPackage = JSON.parse(readFileSync(new URL('../src/plugins/dsh-desktop-integration/package.json', import.meta.url), 'utf8'))
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('renderer dependencies and scripts are exact pinned', () => {
  for (const name of ['react', 'react-dom']) assert.match(packageJson.dependencies[name], /^\d+\.\d+\.\d+$/)
  for (const name of ['vite', 'typescript', '@vitejs/plugin-react', '@types/react', '@types/react-dom']) assert.match(packageJson.devDependencies[name], /^\d+\.\d+\.\d+$/)
  assert.equal(packageJson.scripts['dev:desktop'], 'node scripts/dev-desktop.mjs')
  assert.equal(packageJson.scripts.design, 'node scripts/dev-desktop.mjs')
  assert.equal(packageJson.scripts['build:renderer'], 'vite build')
  assert.equal(packageJson.scripts['renderer:typecheck'], 'tsc --noEmit')
  assert.match(packageJson.build.files.join('\n'), /build\/renderer\/\*\*\//)
})

test('Task 3 DSH client dependencies stay exact at rc.2', () => {
  const clientPeers = Object.entries(integrationPackage.peerDependencies)
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-client-'))
  assert.deepEqual(clientPeers.map(([name]) => name).sort(), [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-client-ui-workspace',
  ])
  for (const [name, version] of clientPeers) assert.equal(version, '0.1.1-rc.2', `${name} must be exact`)

  const directManifests = [
    packageJson.dependencies,
    packageJson.devDependencies,
    integrationPackage.peerDependencies,
    packageLock.packages?.['']?.dependencies,
    packageLock.packages?.['']?.devDependencies,
  ]
  for (const manifest of directManifests) {
    for (const [name, version] of Object.entries(manifest ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh')) assert.doesNotMatch(String(version), /0\.1\.1-rc\.1/)
    }
  }
})

test('renderer tree has editable route owners and centralized tokens', () => {
  assert.equal(existsSync(new URL('../src/renderer/index.html', import.meta.url)), true)
  assert.equal(existsSync(new URL('../src/renderer/App.tsx', import.meta.url)), true)
  assert.equal(existsSync(new URL('../src/renderer/styles/tokens.css', import.meta.url)), true)
  const app = source('../src/renderer/App.tsx')
  for (const route of ['LoadingRoute', 'OverviewRoute', 'ModeRoute', 'UpdateRoute', 'RecoveryRoute', 'DiagnosticsRoute', 'ErrorRoute']) assert.match(app, new RegExp(route))
  assert.doesNotMatch(app, /PluginsRoute|pluginManager|推荐插件/)
  assert.doesNotMatch(source('../src/renderer/App.tsx'), /nodeIntegration|require\(['"]electron/)
  assert.match(source('../src/renderer/styles/tokens.css'), /--color-accent/)
  assert.match(source('../src/renderer/styles/tokens.css'), /--motion-standard/)
  assert.match(source('../src/renderer/global.d.ts'), /checkAvailable: boolean/)
  assert.match(source('../src/renderer/global.d.ts'), /managedRestoreAvailable: boolean/)
  assert.match(source('../src/renderer/global.d.ts'), /desktopUpdate: DesktopInstallerUpdate/)
  assert.match(source('../src/renderer/global.d.ts'), /desktopCheck: \(\) => Promise/)
  assert.match(source('../src/renderer/App.tsx'), /catch\s*\(error\)/)
  assert.match(source('../src/renderer/routes/ModeRoute.tsx'), /!status\.mode\.switchAvailable/)
  assert.equal(source('../src/renderer/App.tsx').includes('src/release'), false)
})

test('loading progress uses semantic markup and CSS rather than renderer inline style', () => {
  const loading = source('../src/renderer/routes/LoadingRoute.tsx')
  const styles = source('../src/renderer/styles/app.css')
  assert.match(loading, /<progress\s+className="progress-track"/)
  assert.doesNotMatch(loading, /style\s*=|progress-track[^\n]*<span/)
  assert.match(styles, /\.progress-track::-webkit-progress-value/)
  assert.match(styles, /\.progress-track::-moz-progress-bar/)
  assert.doesNotMatch(styles, /\.progress-track span/)
})

test('mode and update surfaces remain truthful and distinct', () => {
  const api = source('../src/renderer/api.ts')
  const mode = source('../src/renderer/routes/ModeRoute.tsx')
  const updates = source('../src/renderer/routes/UpdateRoute.tsx')
  const channels = source('../src/ipc/channels.cjs')
  const main = source('../src/main.js')
  const controller = source('../src/desktop-runtime-controller.js')
  const host = source('../src/ipc/desktop-host.js')
  assert.match(api, /active: 'legacy'/)
  assert.match(mode, /旧版 \/ 引导兼容模式/)
  assert.match(mode, /effectiveActive = status\.mode\.active/)
  assert.match(mode, /legacyActive \? <Panel/)
  assert.match(mode, /!status\.mode\.switchAvailable \? <Unavailable/)
  assert.match(mode, /status\.mode\.active === 'legacy' \? '计划槽位' : '运行模式'/)
  assert.match(source('../src/renderer/routes/OverviewRoute.tsx'), /effectiveMode = status\.mode\.active/)
  assert.match(mode, /当前未配置可切换模式/)
  assert.match(updates, /onDesktopCheck/)
  assert.match(updates, /DSH 运行时/)
  assert.match(updates, /桌面安装程序/)
  assert.match(updates, /支持|不支持/)
  assert.match(updates, /进度/)
  assert.match(updates, /disabled={pendingAction !== null \|\| !installerActionEnabled}/)
  assert.doesNotMatch(updates, /runtimeCheckEnabled|Update and Restart/)
  assert.match(updates, /准备稳定版候选版本/)
  assert.match(updates, /disabled={pendingAction !== null \|\| candidate\.busy \|\| !candidate\.prepareAvailable}/)
  assert.match(updates, /disabled={pendingAction !== null \|\| !runtimeRestoreEnabled}/)
  assert.match(source('../src/renderer/routes/RecoveryRoute.tsx'), /status\.snapshots\.available === true/)
  assert.match(source('../src/renderer/global.d.ts'), /supported: boolean/)
  assert.match(source('../src/renderer/global.d.ts'), /releaseSourceConfigured: boolean/)
  assert.match(source('../src/renderer/global.d.ts'), /progress: number/)
  assert.match(channels, /desktopCheck: 'dsh-desktop:desktop-update-check'/)
  assert.match(host, /desktopUpdate:/)
  assert.match(main, /desktopUpdate: \(\) =>/)
  assert.match(controller, /getDesktopUpdateStatus\(\)/)
  assert.match(host, /supported: desktopUpdate\.supported/)
  assert.match(host, /progress: desktopUpdate\.progress/)
  assert.match(host, /registrar\.handle\(IPC_CHANNELS\.update\.desktopCheck, event =>/)
  assert.match(host, /function trustedManagement\(event\)/)
  assert.match(main, /async function openUpdatesAndCheck\(\)/)
  assert.match(main, /desktopUpdateCheck: \(\) => openUpdatesAndCheck\(\)/)
  assert.match(main, /windowHost\?\.focus\('workspace'\)/)
  assert.match(main, /new Event\('dsh-desktop:open-updates'\)/)
  assert.match(main, /return runtimeController\?\.checkUpdates\(\)/)
  assert.match(main, /let managementMode = 'legacy'/)
  assert.match(host, /activeMode = \['stable', 'dev'\]\.includes\(mode\.active\) \? mode\.active : 'legacy'/)
  assert.match(host, /compatibility: activeMode === 'legacy' \? 'bootstrap' : 'managed'/)
  assert.match(host, /activeMode === 'stable' \? mode\.state/)
  assert.match(host, /activeMode === 'dev' \? mode\.state/)
})

test('approved native control center A stays operation-first and truthful', () => {
  const shell = source('../src/renderer/components/AppShell.tsx')
  const overview = source('../src/renderer/routes/OverviewRoute.tsx')
  const html = source('../src/renderer/index.html')
  assert.match(shell, /className="topnav"/)
  assert.match(shell, /aria-label="管理导航"/)
  assert.match(overview, /api\.logs\.read\(8\)/)
  assert.match(overview, /activity\.loading && entries\.length === 0/)
  assert.match(overview, /previousReleaseId/)
  assert.match(overview, /codeRollbackAvailable/)
  assert.match(overview, /runtime-panel/)
  assert.doesNotMatch(overview, /示例记录|所有服务运行正常|已是最新/)
  assert.doesNotMatch(shell, /设计预览/)
  assert.match(html, /cbf0029e/)
  assert.match(shell, /native-sidebar/)
  assert.match(overview, /<details className="control-center__right native-runtime">/)
})

test('installer update owner remains injectable through the controller boundary', () => {
  const update = { initialize: () => false }
  let options
  const controller = createDesktopRuntimeController({
    window: { getWindow: () => undefined },
    app: { isPackaged: false, getVersion: () => '0.1.0', getPath: () => '/tmp' },
    process: { platform: 'linux', arch: 'x64', execPath: 'node', env: {} },
    owners: { createInstallerUpdate: received => { options = received; return update } },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  })

  const adapters = controller.initializeUpdates()
  assert.equal(adapters.desktop, update)
  assert.equal(options?.platform, 'linux')
  assert.equal(options?.currentVersion, '0.1.0')
})

test('desktop shell leaves optional plugin lifecycle to native DSH', () => {
  const readme = source('../README.renderer.md')
  assert.match(readme, /blank profile/i)
  assert.match(readme, /native DSH/)
  assert.match(readme, /dsh-market/)
  assert.doesNotMatch(readme, /plugins\.html|legacy manager|React `plugins` route/)
  assert.doesNotMatch(source('../src/renderer/App.tsx'), /PluginsRoute|pluginManager/)
  assert.doesNotMatch(source('../src/window-host.js'), /pluginManager|plugins\.html/)
  assert.equal(existsSync(new URL('../src/renderer/routes/PluginsRoute.tsx', import.meta.url)), false)
})
