import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import process from 'node:process'
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, net, shell } from 'electron'
import { parse as parseYaml } from 'yaml'
import { readActiveDshRuntime, resolveManagedDshRuntimeRoot } from './dsh-runtime.js'
import { readManagedDataHome } from './storage/managed-data-home.js'
import { DEFAULT_DESKTOP_DEV_ENDPOINT, validateDesktopDevEndpoint } from './build-plan.js'
import {
  authorizeWorkspacePath,
  detectEditors,
  installDesktopPluginForNewWebProfile,
  isTextLikePath,
  launchEditor,
  normalizeEditorPreference,
  normalizeWorkspaceContext,
  prepareHarnessToolchain,
  readDesktopSettings,
  resolveDesktopColorScheme,
  resolveHarnessHome,
  selectedEditor,
  writeDesktopSettings,
} from './desktop-integration.js'
import { createWindowHost } from './window-host.js'
import { normalizePluginSourceUrl } from './plugin-catalog.js'
import { createDesktopRuntimeController } from './desktop-runtime-controller.js'
import {
  createDiagnosticLog,
  diagnosticDialogDetail,
  diagnosticErrorDetail,
  diagnosticLogText,
} from './diagnostics.js'
import { createDesktopIpcHost } from './ipc/desktop-host.js'
import { createQuitLifecycle } from './quit-lifecycle.js'
import { createBackgroundTray } from './background-tray.js'
import { configureWindowsAppIdentity } from './app-identity.js'
import { acquireReleaseOwnership } from './release/process-ownership.js'
import { readDesktopDistributionFlavor } from './distribution-flavor.js'
import { DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS } from './plugin-suite.js'
import { resolveBundledMnemon } from './plugin-suite-runtime.js'
import { readSharePreset, seedShareAppearance } from './share-preset.js'
import {
  ONBOARDING_CHANNELS,
  onboardingCompleted,
  onboardingInstallSources,
  onboardingMarkerPath,
  markOnboardingCompleted,
  mergeOnboardingRecommendations,
  readOnboardingRecommendations,
} from './onboarding.js'

const require = createRequire(import.meta.url)
const PREFERRED_LOCALE = 'zh-CN'
const TITLEBAR_MENU_ITEM_IDS = Object.freeze({
  file: 'dsh-titlebar-file',
  edit: 'dsh-titlebar-edit',
  view: 'dsh-titlebar-view',
  help: 'dsh-titlebar-help',
})
let isChinese = false
let copy

function setLocale(locale) {
  isChinese = locale.toLowerCase().startsWith('zh')
  copy = isChinese ? {
      preparing: '正在读取桌面配置与候选版本…',
      preparingPlugins: '正在核验 Harness 配置与插件清单…',
      loading: '正在创建 Harness 核心进程…',
      loadingServices: '已收到启动输出，正在等待本地服务就绪…',
      openingWorkspace: '本地服务已响应，正在载入工作区…',
      ready: '工作区已通过就绪校验',
      restarting: '正在重启 DeepSeek Harness…',
      startupFailed: 'DeepSeek Harness 启动失败',
      stopped: 'DeepSeek Harness 已停止',
      newTask: '新建任务',
      openLogs: '打开日志目录',
      retry: '重启 Harness',
      file: '文件',
      quit: '退出',
      edit: '编辑',
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
      selectAll: '全选',
      view: '视图',
      reload: '重新加载',
      actualSize: '实际大小',
      zoomIn: '放大',
      zoomOut: '缩小',
      toggleFullscreen: '切换全屏',
      developerTools: '开发者工具',
      window: '窗口',
      minimize: '最小化',
      close: '关闭',
      help: '帮助',
      workspace: '工作区',
      openWorkspaceInEditor: '在编辑器中打开工作区',
      openWorkspaceFolder: '在文件管理器中打开',
      preferredEditor: '首选编辑器',
      automaticEditor: '自动选择',
      noEditor: '未检测到受支持的编辑器',
      closeWindow: '关闭窗口',
      toggleSidebar: '切换侧边栏',
      toggleBottomPanel: '切换底部面板',
      toggleRightPanel: '切换插件侧边栏',
      openDesktopControlCenter: '打开桌面控制中心',
      settings: '设置',
      documentation: '文档',
      keyboardShortcuts: '键盘快捷键',
      shortcutsDetail: '文件：新建任务、打开工作区、关闭窗口\n视图：切换侧边栏、底部面板、插件侧边栏和桌面控制中心\n快捷键：Ctrl/Cmd+N 新建任务，Ctrl/Cmd+B 切换侧边栏，Ctrl/Cmd+J 切换底部面板，Ctrl/Cmd+Shift+M 打开桌面控制中心，F11 全屏',
      feedback: '反馈',
      about: '关于 DeepSeek Harness Desktop',
      aboutMessage: 'DeepSeek Harness Desktop',
      aboutDetail: (desktopVersion, dshVersion) => `桌面端版本 ${desktopVersion}\nDSH 版本 ${dshVersion}`,
      nativeOpenFailed: '无法打开本地路径',
      trayStatus: 'DeepSeek Harness · 正在运行',
      trayOpen: '打开 DeepSeek Harness',
      trayOpenWorkspace: '打开当前工作区',
      trayOpenLogs: '打开日志文件夹',
      trayDesktopUpdate: '检查桌面端更新',
      trayDshUpdate: '检查 DSH 更新',
      trayRestart: '重启 Harness',
      trayQuit: '退出 DeepSeek Harness',
      trayTooltip: 'DeepSeek Harness Desktop（后台运行中）',
      dshRollback: '新版 DSH 启动失败，正在恢复内置版本…',
      dshRollbackTitle: '已恢复内置 DSH',
      dshRollbackMessage: version => `无法使用更新后的 DSH ${version}，已自动恢复 DeepSeek Harness Desktop 内置版本。`,
    } : {
      preparing: 'Reading the desktop configuration and candidate release…',
      preparingPlugins: 'Verifying the Harness profile and plugin inventory…',
      loading: 'Creating the Harness core process…',
      loadingServices: 'Startup output received; waiting for local services…',
      openingWorkspace: 'Local services responded; loading the workspace…',
      ready: 'Workspace readiness verified',
      restarting: 'Restarting DeepSeek Harness…',
      startupFailed: 'DeepSeek Harness failed to start',
      stopped: 'DeepSeek Harness stopped',
      newTask: 'New Task',
      openLogs: 'Open Logs Folder',
      retry: 'Restart Harness',
      file: 'File',
      quit: 'Quit',
      edit: 'Edit',
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
      view: 'View',
      reload: 'Reload',
      actualSize: 'Actual Size',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
      toggleFullscreen: 'Toggle Full Screen',
      developerTools: 'Developer Tools',
      window: 'Window',
      minimize: 'Minimize',
      close: 'Close',
      help: 'Help',
      workspace: 'Workspace',
      openWorkspaceInEditor: 'Open Workspace in Editor',
      openWorkspaceFolder: 'Open in File Manager',
      preferredEditor: 'Preferred Editor',
      automaticEditor: 'Automatic',
      noEditor: 'No supported editor detected',
      closeWindow: 'Close Window',
      toggleSidebar: 'Toggle Sidebar',
      toggleBottomPanel: 'Toggle Bottom Panel',
      toggleRightPanel: 'Toggle Plugin Sidebar',
      openDesktopControlCenter: 'Open Desktop Control Center',
      settings: 'Settings',
      documentation: 'Documentation',
      keyboardShortcuts: 'Keyboard Shortcuts',
      shortcutsDetail: 'File: new task, open workspace, close window\nView: toggle the sidebar, bottom panel, plugin sidebar, and desktop control center\nShortcuts: Ctrl/Cmd+N new task, Ctrl/Cmd+B sidebar, Ctrl/Cmd+J bottom panel, Ctrl/Cmd+Shift+M desktop control center, F11 full screen',
      feedback: 'Feedback',
      about: 'About DeepSeek Harness Desktop',
      aboutMessage: 'DeepSeek Harness Desktop',
      aboutDetail: (desktopVersion, dshVersion) => `Desktop ${desktopVersion}\nDSH ${dshVersion}`,
      nativeOpenFailed: 'Could Not Open Local Path',
      trayStatus: 'DeepSeek Harness · Running',
      trayOpen: 'Open DeepSeek Harness',
      trayOpenWorkspace: 'Open Current Workspace',
      trayOpenLogs: 'Open Logs Folder',
      trayDesktopUpdate: 'Check Desktop Update',
      trayDshUpdate: 'Check DSH Update',
      trayRestart: 'Restart Harness',
      trayQuit: 'Quit DeepSeek Harness',
      trayTooltip: 'DeepSeek Harness Desktop (running in background)',
      dshRollback: 'The updated DSH failed to start. Restoring the bundled version…',
      dshRollbackTitle: 'Bundled DSH Restored',
      dshRollbackMessage: version => `DSH ${version} could not start, so DeepSeek Harness Desktop restored its bundled version automatically.`,
    }
}

app.commandLine.appendSwitch('lang', PREFERRED_LOCALE)
configureWindowsAppIdentity(app)
setLocale(PREFERRED_LOCALE)

let windowHost
let desktopIpcHost
let runtimeController
let releaseOwnership
let logStream
let logPath
let quitLifecycle
let backgroundTray
let activeWorkspace
let workspaceRoots = []
let workspaceResolvedTheme
let workspaceThemePreference = 'system'
let editors = []
let editorPreference = 'auto'
let desktopSettingsPath
let harnessHomePath
let managedRuntimeRootForTheme
// Stable/dev slots are not paired yet; keep the active owner truthful.
let managementMode = 'legacy'
let onboardingStatePath
let onboardingPending = false
let onboardingInstalling
let shareAutoConfigure = false
let applicationMenu
let desktopDistributionFlavor = 'standard'

function onboardingShouldShow() {
  return typeof onboardingStatePath === 'string' && !onboardingCompleted(onboardingStatePath)
}

function trustedOnboardingSender(event) {
  const splash = windowHost?.getWindow?.('splash')
  return splash?.webContents !== undefined && event?.sender === splash.webContents
}

function readHarnessThemePreference(home = harnessHomePath) {
  if (managedRuntimeRootForTheme !== undefined) {
    try { home = readManagedDataHome(managedRuntimeRootForTheme)?.dataHome ?? home }
    catch { /* Startup recovery owns data repair; the splash uses its saved theme. */ }
  }
  const settingsPath = typeof home === 'string' && home.trim() !== ''
    ? join(home, 'settings.yaml')
    : join(resolveHarnessHome(process.env, app.getPath('home'), app.getPath('home')), 'settings.yaml')
  try {
    const settings = parseYaml(readFileSync(settingsPath, 'utf8'))
    const preference = settings?.['ui-theme']?.preference
    if (preference === 'light' || preference === 'dark' || preference === 'system') return preference
  } catch {
    // DSH currently persists its renderer preference in the browser profile.
    // Use the last resolved renderer theme for desktop-owned startup pages.
  }
  if (desktopSettingsPath !== undefined) {
    const persisted = readDesktopSettings(desktopSettingsPath).theme
    if (persisted === 'light' || persisted === 'dark' || persisted === 'system') return persisted
  }
  return 'system'
}

function ensureHarnessSettingsDocument(home) {
  if (typeof home !== 'string' || home.trim() === '') return false
  const settingsPath = join(home, 'settings.yaml')
  try {
    const current = parseYaml(readFileSync(settingsPath, 'utf8'))
    if (current === null || (typeof current === 'object' && !Array.isArray(current))) return false
    return false
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
  }
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(settingsPath, '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

function sendOnboardingProgress({ transactionId, phase = 'working', label = '正在处理…', value = 0, indeterminate = false } = {}) {
  const splash = windowHost?.getWindow?.('splash')
  if (!splash?.webContents?.send) return
  const numericValue = Number.isFinite(Number(value))
    ? Math.max(0, Math.min(100, Math.round(Number(value))))
    : 0
  try {
    splash.webContents.send(ONBOARDING_CHANNELS.progress, {
      ...(typeof transactionId === 'string' ? { transactionId } : {}),
      phase: typeof phase === 'string' ? phase.slice(0, 32) : 'working',
      label: typeof label === 'string' ? label.slice(0, 160) : '正在处理…',
      value: numericValue,
      indeterminate: indeterminate === true,
    })
  } catch {
    // The splash can be closing during a successful hand-off. The operation
    // result remains authoritative and must not be turned into a failure just
    // because its progress surface disappeared.
  }
}

function showOnboardingAfterReveal() {
  if (!onboardingShouldShow()) return false
  // A restart can ask the window host to reveal while the recommendation
  // page is still waiting for its verified candidate. Keep the splash surface
  // in front without loading a second copy of the page.
  if (onboardingPending) return true
  onboardingPending = true
  handleDetached(
    windowHost.loadPage('splash', 'plugins-onboarding.html', { theme: readHarnessThemePreference() }).then(() => {
      if (windowHost.isOpen('splash') && !windowHost.isVisible('splash')) windowHost.show('splash')
    }),
    'Plugin onboarding page',
  )
  return true
}

function finishOnboarding() {
  if (typeof onboardingStatePath !== 'string') return false
  markOnboardingCompleted(onboardingStatePath)
  onboardingPending = false
  return windowHost.reveal()
}

function restartResultFailed(result) {
  return result === false
    || result === null
    || result === undefined
    || result?.ok === false
    || result?.success === false
    || ['failed', 'error', 'not-ready', 'unready'].includes(result?.status)
}

async function showInitialCompatibilityLoading() {
  const loadingWindow = windowHost?.currentLoadingWindow?.()
  if (loadingWindow === undefined) return false
  try {
    const loaded = await windowHost.loadFallbackPage(loadingWindow, 'loading.html', {
      lang: isChinese ? 'zh' : 'en',
      message: copy.preparingPlugins,
      progress: '8',
      stage: 'preparing',
      theme: readHarnessThemePreference(harnessHomePath),
    })
    if (loaded === false) return false
    return windowHost.show(loadingWindow)
  } catch (error) {
    reportDetachedFailure('Initial compatibility loading page', error)
    return false
  }
}

async function startInitialHarnessWithCompatibilityRepair() {
  await showInitialCompatibilityLoading()
  try {
    const repair = await runtimeController?.repairActiveCompatibility?.()
    if (repair?.repaired === true) return true
    if (repair?.ok === false) {
      writeLog('stderr', `[compatibility-repair] ${diagnosticLogText(repair.error ?? 'Compatibility repair was not completed')}\n`)
    }
  } catch (error) {
    writeLog('stderr', `[compatibility-repair] ${diagnosticLogText(error)}\n`)
  }
  return runtimeController?.restart('startup')
}

async function ensureOnboardingCandidate(options = {}) {
  const pluginStatus = runtimeController?.statusSnapshot?.().plugins
  // A stable candidate may already be active after an earlier onboarding
  // attempt or an app restart. Do not rebuild it: that could discard plugins
  // the user installed through native dsh-market.
  if (pluginStatus?.activeCandidate !== false) return { ok: true }
  if (typeof runtimeController?.prepareCandidate !== 'function' || typeof runtimeController?.switchCandidate !== 'function') {
    return { ok: false, error: '当前安装还没有可验证的插件候选环境，请先进入 DSH 后使用原生插件市场。' }
  }
  try {
    const prepared = await runtimeController.prepareCandidate('stable', options)
    const candidateId = prepared?.releaseId ?? prepared?.manifest?.releaseId
    if (typeof candidateId !== 'string' || candidateId.trim() === '') {
      return { ok: false, error: '无法准备可验证的 DSH 插件环境，未安装任何插件。' }
    }
    options.onProgress?.({ phase: 'stable-observation', completed: 0, total: 1 })
    const switched = await runtimeController.switchCandidate(candidateId)
    if (restartResultFailed(switched)) {
      return { ok: false, error: '基础 DSH 候选环境未能安全启动，未安装任何插件。' }
    }
    options.onProgress?.({ phase: 'stable-observation', completed: 1, total: 1 })
    return { ok: true }
  } catch (error) {
    writeLog('stderr', `[onboarding/candidate-error] ${diagnosticLogText(error)}\n`)
    return { ok: false, error: diagnosticDetail(error) }
  }
}

function registerOnboardingIpc() {
  const splashWindow = () => windowHost?.getWindow?.('splash')
  const trustedSplash = event => trustedOnboardingSender(event) ? splashWindow() : undefined
  ipcMain.handle(ONBOARDING_CHANNELS.window.minimize, event => {
    const window = trustedSplash(event)
    if (!window?.isDestroyed?.()) window.minimize?.()
    return { ok: window !== undefined }
  })
  ipcMain.handle(ONBOARDING_CHANNELS.window.toggleMaximize, event => {
    const window = trustedSplash(event)
    if (window?.isDestroyed?.()) return { ok: false }
    if (window.isMaximized?.()) window.unmaximize?.()
    else window.maximize?.()
    return { ok: true, maximized: window.isMaximized?.() === true }
  })
  ipcMain.handle(ONBOARDING_CHANNELS.window.close, event => {
    const window = trustedSplash(event)
    if (!window?.isDestroyed?.()) window.close?.()
    return { ok: window !== undefined }
  })
  ipcMain.handle(ONBOARDING_CHANNELS.recommendations, event => {
    if (!trustedOnboardingSender(event)) return { ok: false, error: 'Untrusted onboarding request' }
    try {
      const suite = desktopDistributionFlavor === 'suite'
      const recommendations = readOnboardingRecommendations({ suite })
      let installedCatalog
      try { installedCatalog = runtimeController?.pluginList?.() } catch { installedCatalog = undefined }
      const merged = mergeOnboardingRecommendations(recommendations, installedCatalog)
      return {
        ok: true,
        recommendations: merged,
        installedCount: Array.isArray(installedCatalog?.plugins) ? installedCatalog.plugins.length : 0,
        flavor: desktopDistributionFlavor,
        preselectAll: suite,
        autoConfigure: suite && shareAutoConfigure,
        level: 'full',
      }
    } catch (error) {
      return { ok: false, error: diagnosticDetail(error) }
    }
  })
  ipcMain.handle(ONBOARDING_CHANNELS.install, async (event, input) => {
    if (!trustedOnboardingSender(event)) return { ok: false, error: 'Untrusted onboarding request' }
    if (onboardingInstalling) return { ok: false, error: 'Plugin installation is already running' }
    const installRequest = Array.isArray(input) ? { selectedIds: input } : input
    if (installRequest === null || typeof installRequest !== 'object' || Array.isArray(installRequest)) {
      return { ok: false, error: 'Invalid onboarding installation request' }
    }
    const selectedIds = installRequest.selectedIds
    const requestedTransactionId = installRequest.transactionId
    if (requestedTransactionId !== undefined
      && (typeof requestedTransactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedTransactionId))) {
      return { ok: false, error: 'Invalid onboarding transaction id' }
    }
    const transactionId = requestedTransactionId ?? `onboarding-${randomUUID()}`
    onboardingInstalling = transactionId
    let progressValue = 0
    let progressSignature = ''
    const progress = update => {
      const nextValue = Number.isFinite(Number(update?.value)) ? Number(update.value) : progressValue
      const normalized = {
        ...update,
        transactionId,
        value: Math.max(progressValue, nextValue),
      }
      const signature = JSON.stringify([
        normalized.phase,
        normalized.label,
        Math.round(normalized.value),
        normalized.indeterminate === true,
      ])
      progressValue = normalized.value
      if (signature === progressSignature) return
      progressSignature = signature
      sendOnboardingProgress(normalized)
    }
    progress({ phase: 'prepare', label: '正在验证 DSH 运行环境…', value: 8, indeterminate: true })
    try {
      const suite = desktopDistributionFlavor === 'suite'
      const recommendations = readOnboardingRecommendations({ suite })
      let installedCatalog
      try { installedCatalog = runtimeController?.pluginList?.() } catch { installedCatalog = undefined }
      const installedIds = new Set(
        mergeOnboardingRecommendations(recommendations, installedCatalog)
          .filter(entry => entry.installed === true)
          .map(entry => entry.id),
      )
      const selected = onboardingInstallSources(selectedIds, {
        suite,
        repositoryRoot: app.getAppPath(),
      }).filter(entry => !installedIds.has(entry.id))
      if (selected.length === 0) {
        progress({ phase: 'done', label: '环境已就绪，正在打开 Harness…', value: 100 })
        return finishOnboarding()
          ? { ok: true, skipped: true, transactionId }
          : { ok: false, error: 'Unable to open the workspace', transactionId }
      }
      if (typeof runtimeController?.pluginInstallMany !== 'function') {
        return { ok: false, error: 'Candidate plugin installation is unavailable; use the native DSH plugin market after startup.' }
      }
      const candidate = await ensureOnboardingCandidate({
        onProgress: update => {
          const completed = Number(update?.completed)
          const total = Number(update?.total)
          if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return
          const ratio = Math.max(0, Math.min(1, completed / total))
          if (update?.phase === 'stable-observation') {
            progress({
              phase: 'stable-observation',
              label: completed >= total ? '基础环境稳定性验证完成…' : '基础环境已启动，正在进行稳定性观察（通常约 2 分钟）…',
              value: completed >= total ? 33 : 32,
              indeterminate: completed < total,
            })
            return
          }
          const isVerify = update?.phase === 'runtime-verify'
          const value = isVerify ? 26 + Math.round(ratio * 6) : 8 + Math.round(ratio * 18)
          progress({
            phase: 'prepare',
            label: isVerify ? '正在复核 DSH 运行时完整性…' : '正在验证 DSH 运行环境…',
            value,
            indeterminate: false,
          })
        },
      })
      if (candidate.ok !== true) {
        progress({ phase: 'error', label: 'DSH 运行环境验证失败', value: progressValue })
        return candidate
      }
      progress({ phase: 'candidate-ready', label: '环境验证完成，正在安装所选插件…', value: 34 })
      const request = {
        sources: selected.map(entry => ({ name: entry.packageName, source: entry.source })),
        buildPermissions: suite
          ? { ...DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS }
          : Object.fromEntries(selected.map(entry => [entry.packageName, entry.buildAllowed === true])),
      }
      progress({ phase: 'install', label: `正在安装 ${selected.length} 个插件，请稍候…`, value: 35, indeterminate: true })
      const staged = await runtimeController.pluginInstallMany(request, {
        onProgress: update => {
          const completed = Number(update?.completed)
          const total = Number(update?.total)
          const ratio = Number.isFinite(completed) && Number.isFinite(total) && total > 0
            ? Math.max(0, Math.min(1, completed / total))
            : 0
          const phase = update?.phase
          if (phase === 'candidate-clone') {
            progress({ phase, label: '正在创建隔离安装环境…', value: 35 + Math.round(ratio * 5), indeterminate: ratio === 0 })
          } else if (phase === 'source-resolve') {
            progress({ phase, label: '正在锁定插件版本与来源…', value: 40 + Math.round(ratio * 7) })
          } else if (phase === 'plugin-install') {
            progress({ phase, label: ratio < 1 ? `正在安装 ${selected.length} 个插件…` : '插件文件已安装，正在生成候选清单…', value: ratio < 1 ? 48 : 55, indeterminate: ratio < 1 })
          } else if (phase === 'candidate-finalize') {
            progress({ phase, label: ratio < 1 ? '正在复核候选版本身份与文件…' : '候选版本文件复核完成…', value: ratio < 1 ? 58 : 73, indeterminate: ratio < 1 })
          } else if (phase === 'runtime-verify') {
            progress({ phase, label: '正在校验 DSH 与插件运行时完整性…', value: 58 + Math.round(ratio * 14) })
          } else if (phase === 'static-gate') {
            progress({ phase, label: '正在检查插件结构与兼容性…', value: 74 + Math.round(ratio * 2), indeterminate: ratio === 0 })
          } else if (phase === 'runtime-gate') {
            progress({ phase, label: '正在隔离启动插件并验证核心功能…', value: 77 + Math.round(ratio * 3), indeterminate: ratio === 0 })
          } else if (phase === 'complete') {
            progress({ phase, label: '候选环境验证完成，准备重启…', value: 81 })
          }
        },
      })
      if (staged?.ok !== true) {
        const detail = diagnosticDetail(staged?.error ?? 'Plugin installation failed')
        writeLog('stderr', `[onboarding/plugin-transaction-error] ${detail}\n`)
        progress({ phase: 'error', label: '插件安装失败，正在保留当前环境', value: progressValue })
        return { ok: false, error: detail }
      }
      // Keep the splash surface in front while the verified candidate restarts.
      // The marker is written only after that restart succeeds.
      progress({ phase: 'restart', label: '插件已安装，正在重启并验证 Harness…', value: 82, indeterminate: true })
      const restarted = await runtimeController.restartPluginChanges('onboarding-plugin-restart')
      if (restartResultFailed(restarted)) {
        progress({ phase: 'error', label: 'Harness 重启验证失败', value: progressValue })
        return { ok: false, error: 'The selected plugins were staged but Harness could not restart safely.' }
      }
      progress({ phase: 'done', label: '安装验证完成，正在打开 Harness…', value: 100 })
      if (!finishOnboarding()) return { ok: false, error: '插件已验证，但桌面窗口无法安全打开。' }
      return { ok: true, installed: selected.map(entry => entry.packageName), restarted: true, transactionId }
    } catch (error) {
      writeLog('stderr', `[onboarding/error] ${diagnosticLogText(error)}\n`)
      progress({ phase: 'error', label: '安装失败，当前环境未被替换', value: progressValue })
      return { ok: false, error: diagnosticDetail(error) }
    } finally {
      if (onboardingInstalling === transactionId) onboardingInstalling = undefined
    }
  })
  ipcMain.handle(ONBOARDING_CHANNELS.skip, event => {
    if (!trustedOnboardingSender(event)) return { ok: false, error: 'Untrusted onboarding request' }
    if (onboardingInstalling) return { ok: false, error: 'Plugin installation is still running' }
    return finishOnboarding() ? { ok: true } : { ok: false, error: 'Unable to open the workspace' }
  })
}

function desktopIconPath() {
  const name = nativeTheme.shouldUseDarkColors ? 'icon-white' : 'icon-black'
  return join(import.meta.dirname, '..', 'assets', process.platform === 'win32' ? `${name}.ico` : `${name}.png`)
}

function desktopTheme() {
  const preference = readHarnessThemePreference()
  const dark = workspaceResolvedTheme === undefined
    ? preference === 'dark' || (preference === 'system' && nativeTheme.shouldUseDarkColors)
    : workspaceResolvedTheme === 'dark'
  return {
    dark,
    windowBackground: dark ? '#151517' : '#f7f8fa',
    // The native caption and Codex Suite sidebar share one neutral surface.
    // It is intentionally a touch lighter than the previous #151517 sidebar.
    titleBarColor: dark ? '#1d1e20' : '#f1f2f4',
    titleBarSymbolColor: dark ? '#f9fafb' : '#111827',
    windowBorderColor: dark ? '#1d1e20' : '#f1f2f4',
  }
}

function canConnectToLoopbackProxy({ host = '127.0.0.1', port = 7892, timeout = 450 } = {}) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function inheritDesktopLoopbackProxy(env) {
  if (env === null || typeof env !== 'object') return false
  const explicit = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some(name => typeof env[name] === 'string' && env[name].trim() !== '')
  if (explicit || !await canConnectToLoopbackProxy()) return false
  env.HTTP_PROXY = 'http://127.0.0.1:7892'
  env.HTTPS_PROXY = 'http://127.0.0.1:7892'
  env.ALL_PROXY = 'socks5://127.0.0.1:7892'
  const noProxy = new Set(String(env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(value => value.trim()).filter(Boolean))
  for (const value of ['localhost', '127.0.0.1', '::1']) noProxy.add(value)
  env.NO_PROXY = [...noProxy].join(',')
  return true
}

windowHost = createWindowHost({
  BrowserWindow,
  shell,
  path: { join },
  rendererOrigin: rendererDevelopmentUrl,
  getHarnessOrigin: () => runtimeController?.getHarnessOrigin(),
  callbacks: {
    isQuitting: () => runtimeController?.isQuitting() === true,
    getLanguage: () => isChinese ? 'zh' : 'en',
    getDesktopIcon: desktopIconPath,
    getDownloadsPath: () => app.getPath('downloads'),
    getTheme: desktopTheme,
    onWorkspaceCloseRequested: window => {
      if (backgroundTray === undefined || runtimeController?.isQuitting() === true) return false
      window.hide?.()
      return true
    },
    onWorkspaceClosed: () => {
      workspaceResolvedTheme = undefined
      runtimeController?.resetWorkspace()
    },
    onRevealRequested: () => showOnboardingAfterReveal(),
    onSplashClosed: () => app.quit(),
    onAsyncError: (label, error) => reportDetachedFailure(label, error),
  },
})

desktopIpcHost = createDesktopIpcHost({
  ipcMain,
  windows: {
    management: () => windowHost.getWindow('management'),
    harness: () => windowHost.getWindow('workspace'),
  },
  origins: {
    management: () => windowHost.managementRendererOrigin,
    harness: () => runtimeController?.getHarnessOrigin(),
  },
  paths: {
    managementRenderer: () => windowHost.rendererEntryPath(),
    workspaceFallback: () => [windowHost.pagePath('loading.html'), windowHost.pagePath('error.html')],
  },
  state: {
    app: () => ({ version: app.getVersion(), ready: app.isReady() }),
    data: () => runtimeController?.statusSnapshot().data ?? { state: 'unavailable', home: null },
    mode: () => runtimeController?.statusSnapshot().mode ?? managementMode,
    startup: () => runtimeController?.statusSnapshot().startup ?? { phase: 'idle', progress: 0, message: '' },
    runtime: () => runtimeController?.statusSnapshot().runtime,
    workspace: () => runtimeController?.statusSnapshot().workspace ?? { ready: false, origin: undefined },
    update: () => runtimeController?.getUpdateStatus() ?? { state: 'unavailable', available: false, busy: false, checkAvailable: false, managedRestoreAvailable: false, restoreAvailable: false },
    desktopUpdate: () => runtimeController?.getDesktopUpdateStatus() ?? { state: 'unavailable', currentVersion: app.getVersion(), available: false, releaseSourceConfigured: false, supported: false, externalReleaseAvailable: false, busy: false, checkAvailable: false, progress: 0, downloaded: false, targetVersion: null },
    updates: () => runtimeController?.getUpdates?.() ?? {},
    candidate: () => runtimeController?.getCandidateStatus() ?? { state: 'unavailable', available: false, prepareAvailable: false, switchAvailable: false, busy: false, reason: 'Candidate preparation is unavailable.' },
    snapshots: () => runtimeController?.getSnapshotStatus?.() ?? { state: 'unavailable', available: false, busy: false, count: null, totalBytes: null, reason: 'Snapshot owner is unavailable.' },
    plugins: () => runtimeController?.statusSnapshot().plugins ?? { state: 'unavailable', available: false, busy: false, installed: null },
    logs: () => ({ path: logPath }),
    operationBusy: () => runtimeController?.statusSnapshot().operationBusy === true,
    quitting: () => runtimeController?.isQuitting() === true,
  },
  effects: {
    runDetached: handleDetached,
    desktopUpdateCheck: () => openUpdatesAndCheck(),
    updatesCheck: () => runtimeController?.checkUpdates(),
    updatesExecute: request => runtimeController?.executeUpdates(request),
    updatesOpen: kind => {
      const value = runtimeController?.getUpdates?.()?.[kind]?.releaseNotesUrl
      if (!value) throw new Error('更新说明暂不可用')
      const url = new URL(value)
      const prefix = kind === 'dsh' ? '/deepseek-ai/deepseek-harness/releases' : '/Ricardo-WJP/dsh-desktop/releases'
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(prefix)) throw new Error('发行链接未通过验证')
      return shell.openExternal(url.href)
    },
    updateCheck: () => openUpdatesAndCheck(),
    updateProbe: options => runtimeController?.checkDshUpdateAvailability(options),
    updateRestore: () => runtimeController?.restoreDsh(),
    candidatePrepare: channel => runtimeController?.prepareCandidate(channel),
    candidateActivate: candidateId => runtimeController?.switchCandidate?.(candidateId),
    snapshotList: () => runtimeController?.listSnapshots?.(),
    snapshotCreate: () => runtimeController?.createSnapshot?.(),
    snapshotRestore: snapshotId => runtimeController?.restoreSnapshot?.(snapshotId),
    openLogFolder: path => shell.openPath(path),
    openWorkspace: () => windowHost.focus('workspace'),
    restart: () => runtimeController?.restart('ui-restart'),
    navigate: route => windowHost.loadManagementRoute(route),
    openPath: (path, intent) => reportDesktopAction(() => openDesktopPath(path, intent)),
    workspaceContext: normalized => {
      const activeChanged = normalized.active !== activeWorkspace
      activeWorkspace = normalized.active
      workspaceRoots = normalized.roots
      if (activeChanged) {
        buildMenu()
        backgroundTray?.setLabels?.({ workspaceEnabled: activeWorkspace !== undefined })
      }
    },
    workspaceTheme: theme => {
      const resolvedTheme = resolveDesktopColorScheme(theme, nativeTheme.shouldUseDarkColors)
      if (workspaceThemePreference === theme.preference && workspaceResolvedTheme === resolvedTheme) return
      workspaceThemePreference = theme.preference
      workspaceResolvedTheme = resolvedTheme
      nativeTheme.themeSource = theme.preference
      if (desktopSettingsPath !== undefined) {
        writeDesktopSettings(desktopSettingsPath, {
          ...readDesktopSettings(desktopSettingsPath),
          theme: theme.preference,
          resolvedTheme,
        })
      }
      windowHost?.updateTheme?.()
      backgroundTray?.setIcon(desktopIconPath())
    },
    titlebarMenu: request => popupWorkspaceTitlebarMenu(request),
    titlebarNavigate: direction => windowHost.navigateWorkspaceHistory(direction),
    openSettingsDocument: () => reportDesktopAction(() => openHarnessSettingsDocument()),
    pluginCatalog: () => runtimeController?.pluginList(),
    pluginList: () => runtimeController?.pluginList(),
    pluginDiscover: () => runtimeController?.pluginDiscover(),
    pluginTransaction: request => runtimeController?.pluginTransaction(request),
    pluginMarketInstall: request => runtimeController?.pluginMarketInstall(request),
    pluginMarketUpdate: request => runtimeController?.pluginMarketUpdate(request),
    pluginRemovePreview: request => runtimeController?.pluginRemovePreview(request),
    pluginConfirmRemove: request => runtimeController?.pluginConfirmRemove(request),
    pluginRestart: () => runtimeController?.restartPluginChanges?.('plugin-restart'),
    pluginSafeStart: () => runtimeController?.startPluginSafeMode?.(),
    pluginSafeExit: () => runtimeController?.exitPluginSafeMode?.(),
    openPluginDocs: url => shell.openExternal(url),
    openPluginSource: url => shell.openExternal(url),
  },
  adapters: {
    normalizeWorkspaceContext,
    normalizePluginSourceUrl,
  },
  logger: { write: writeLog },
})

function writeLog(source, text) {
  const safeText = diagnosticLogText(text)
  const prefix = `[${new Date().toISOString()}] [${source}] `
  logStream?.write(`${prefix}${safeText}`)
  if (!app.isPackaged) process[source === 'stderr' ? 'stderr' : 'stdout'].write(safeText)
}

function diagnosticDetail(value) {
  return diagnosticDialogDetail(diagnosticErrorDetail(value))
}

function reportDetachedFailure(label, error) {
  writeLog('stderr', `${label} failed: ${diagnosticDetail(error)}\n`)
}

function handleDetached(promiseOrAction, label) {
  try {
    Promise.resolve(typeof promiseOrAction === 'function' ? promiseOrAction() : promiseOrAction)
      .catch(error => reportDetachedFailure(label, error))
  } catch (error) {
    reportDetachedFailure(label, error)
  }
}

function createDesktopTray() {
  backgroundTray?.destroy?.()
  backgroundTray = createBackgroundTray({
    Tray,
    Menu,
    nativeImage,
    iconPath: desktopIconPath(),
    labels: {
      status: copy.trayStatus,
      open: copy.trayOpen,
      openWorkspace: copy.trayOpenWorkspace,
      openLogs: copy.trayOpenLogs,
      desktopUpdate: copy.trayDesktopUpdate,
      dshUpdate: copy.trayDshUpdate,
      restart: copy.trayRestart,
      quit: copy.trayQuit,
      tooltip: copy.trayTooltip,
      workspaceEnabled: activeWorkspace !== undefined,
    },
    onOpen: () => windowHost.focus('workspace') || windowHost.focus('management'),
    onOpenWorkspace: () => {
      if (activeWorkspace !== undefined) handleDetached(reportDesktopAction(() => openDesktopPath(activeWorkspace, 'default')), 'Tray open workspace')
    },
    onOpenLogs: () => {
      if (logPath !== undefined) handleDetached(() => shell.openPath(dirname(logPath)), 'Tray open log folder')
    },
    onDesktopUpdate: () => handleDetached(openUpdatesAndCheck(), 'Tray installer update check'),
    onDshUpdate: () => handleDetached(openUpdatesAndCheck(), 'Tray DSH update check'),
    onRestart: () => handleDetached(runtimeController?.restartPluginChanges?.('tray-restart'), 'Tray Harness restart'),
    onQuit: () => app.quit(),
  })
  return backgroundTray
}

quitLifecycle = createQuitLifecycle({
  app,
  getRuntime: () => runtimeController,
  getLog: () => logStream,
  onError: error => reportDetachedFailure('Desktop shutdown', error),
})

function selectedDesktopEditor() {
  return selectedEditor(editors, editorPreference)
}

function rendererDevelopmentUrl() {
  if (app.isPackaged) return undefined
  const value = process.env.DSH_DESKTOP_RENDERER_URL
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const endpoint = validateDesktopDevEndpoint(value)
    // The dev supervisor owns the endpoint plan. The renderer process accepts
    // only the exact endpoint exported by that plan, never an independent
    // loopback override that could split Vite and Electron onto two origins.
    if (endpoint.url !== DEFAULT_DESKTOP_DEV_ENDPOINT.url) return undefined
    return endpoint.rendererUrl
  } catch {
    return undefined
  }
}

async function openSystemPath(path) {
  const error = await shell.openPath(path)
  if (error !== '') throw new Error(error)
}

async function openDesktopPath(path, intent = 'auto') {
  const target = authorizeWorkspacePath(path, workspaceRoots)
  const stats = statSync(target)
  const editor = selectedDesktopEditor()
  const useEditor = intent === 'editor' || (intent === 'auto' && stats.isFile() && isTextLikePath(target))

  if (useEditor) {
    if (editor === undefined) {
      if (intent === 'editor') throw new Error(copy.noEditor)
    } else {
      await launchEditor(editor, target)
      return
    }
  }
  await openSystemPath(target)
}

async function openHarnessSettingsDocument() {
  const settingsPath = await runtimeController?.getActiveSettingsPath?.()
  if (typeof settingsPath !== 'string' || settingsPath.trim() === '') {
    throw new Error('The active Harness settings document is unavailable')
  }
  ensureHarnessSettingsDocument(dirname(settingsPath))
  const editor = selectedDesktopEditor()
  if (editor !== undefined) {
    await launchEditor(editor, settingsPath)
    return
  }
  try {
    await openSystemPath(settingsPath)
  } catch (error) {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const notepad = join(systemRoot, 'System32', 'notepad.exe')
    if (process.platform !== 'win32' || !existsSync(notepad)) throw error
    await launchEditor({ id: 'notepad', label: 'Notepad', command: notepad }, settingsPath)
  }
}

async function reportDesktopAction(action) {
  try {
    await action()
    return { ok: true }
  } catch (error) {
    const detail = diagnosticDetail(error)
    writeLog('stderr', `${copy.nativeOpenFailed}: ${detail}\n`)
    const workspace = windowHost.getWindow('workspace')
    if (windowHost.isOpen(workspace)) {
      handleDetached(() => dialog.showMessageBox(workspace, {
        type: 'error',
        title: copy.nativeOpenFailed,
        message: copy.nativeOpenFailed,
        detail,
      }), 'Native path error dialog')
    }
    return { ok: false, error: detail }
  }
}

function saveEditorPreference(preference) {
  editorPreference = normalizeEditorPreference(preference, editors)
  if (desktopSettingsPath !== undefined) {
    writeDesktopSettings(desktopSettingsPath, {
      ...readDesktopSettings(desktopSettingsPath),
      editor: editorPreference,
    })
  }
  buildMenu()
}

function clearWorkspaceContext() {
  if (activeWorkspace === undefined && workspaceRoots.length === 0) return
  activeWorkspace = undefined
  workspaceRoots = []
  buildMenu()
}

function resolveBundledDshManifest() {
  return require.resolve('@deepseek-ai/dsh/package.json')
}

function resolveDshEntry(activeRuntime) {
  if (activeRuntime?.entry !== undefined) return activeRuntime.entry
  const manifest = resolveBundledDshManifest()
  const entry = join(dirname(manifest), 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`DeepSeek Harness entry point is missing: ${entry}`)
  return entry
}

function resolvePnpmEntry() {
  const manifest = require.resolve('pnpm')
  const entry = join(dirname(manifest), 'bin', 'pnpm.mjs')
  if (!existsSync(entry)) throw new Error(`Bundled pnpm entry point is missing: ${entry}`)
  return entry
}

// These are deliberately fixed, named actions. The renderer can request a
// menu by name, but it never supplies JavaScript to execute in the workspace.
// That keeps the richer native menus useful without widening the IPC trust
// boundary.
const WORKSPACE_UI_ACTIONS = Object.freeze({
  newTask: `(() => {
    const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    const label = value => String(value ?? '').trim().toLowerCase().replaceAll(' ', '')
    const names = new Set(['新建任务', '新建会话', '新建对话', 'newtask', 'newsession', 'newconversation'])
    const button = [...document.querySelectorAll('button,[role="button"]')]
      .find(element => visible(element) && names.has(label(element.getAttribute('aria-label') || element.textContent)))
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`,
  toggleSidebar: `(() => {
    const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    const names = new Set(['收起侧边栏', '打开侧边栏', '折叠侧边栏', '展开侧边栏', 'collapsesidebar', 'expandsidebar'])
    const label = value => String(value ?? '').trim().toLowerCase().replaceAll(' ', '')
    const button = [...document.querySelectorAll('.dcu-root button,.dcu-root [role="button"]')]
      .find(element => visible(element) && names.has(label(element.getAttribute('aria-label') || element.title)))
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`,
  toggleBottomPanel: `(() => {
    const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    const names = new Set(['展开底部面板', '折叠底部面板', '打开底部面板', '关闭底部面板', 'openbottompanel', 'closebottompanel'])
    const label = value => String(value ?? '').trim().toLowerCase().replaceAll(' ', '')
    const button = [...document.querySelectorAll('button,[role="button"]')]
      .find(element => visible(element) && names.has(label(element.getAttribute('aria-label') || element.title)))
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`,
  toggleRightPanel: `(() => {
    const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    const names = new Set(['折叠侧边栏', '展开侧边栏', '收起侧边栏', '打开侧边栏', 'collapsesidebar', 'expandsidebar'])
    const label = value => String(value ?? '').trim().toLowerCase().replaceAll(' ', '')
    const button = [...document.querySelectorAll('.nArs4W_toggleButton')]
      .find(element => visible(element) && names.has(label(element.getAttribute('aria-label') || element.title)))
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`,
  settings: `(() => {
    const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    const button = [...document.querySelectorAll('.dcu-settings-seat button,[data-slot="sidebar.settings"] button')]
      .find(element => visible(element))
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`,
})

function executeWorkspaceUiAction(action) {
  const script = WORKSPACE_UI_ACTIONS[action]
  const workspaceWindow = windowHost.getWindow('workspace')
  if (typeof script !== 'string'
    || !windowHost.isOpen(workspaceWindow)
    || typeof workspaceWindow?.webContents?.executeJavaScript !== 'function') return Promise.resolve(false)
  return Promise.resolve(workspaceWindow.webContents.executeJavaScript(script, true)).then(value => value === true)
}

function showWorkspaceShortcuts() {
  const workspaceWindow = windowHost.getWindow('workspace')
  if (!windowHost.isOpen(workspaceWindow)) return Promise.resolve({ response: -1 })
  return dialog.showMessageBox(workspaceWindow, {
    type: 'info',
    title: copy.keyboardShortcuts,
    message: copy.keyboardShortcuts,
    detail: copy.shortcutsDetail,
  })
}

function showWorkspaceAbout() {
  const workspaceWindow = windowHost.getWindow('workspace')
  if (!windowHost.isOpen(workspaceWindow)) return Promise.resolve({ response: -1 })
  const runtimeVersion = runtimeController?.statusSnapshot?.()?.runtime?.version ?? 'unknown'
  return dialog.showMessageBox(workspaceWindow, {
    type: 'info',
    title: copy.about,
    message: copy.aboutMessage,
    detail: copy.aboutDetail(app.getVersion(), runtimeVersion),
  })
}

function popupWorkspaceTitlebarMenu({ menu, x, y }) {
  const workspaceWindow = windowHost.getWindow('workspace')
  if (!windowHost.isOpen(workspaceWindow)) throw new Error('Workspace window is unavailable')
  if (applicationMenu === undefined) buildMenu()
  const item = applicationMenu?.getMenuItemById?.(TITLEBAR_MENU_ITEM_IDS[menu])
  if (item?.submenu === undefined || typeof item.submenu.popup !== 'function') throw new Error('Title-bar menu is unavailable')
  item.submenu.popup({
    window: workspaceWindow,
    x,
    y,
    positioningItem: 0,
  })
}

async function openUpdatesAndCheck() {
  windowHost?.focus('workspace')
  const window = windowHost?.getWindow('workspace')
  if (window?.webContents && !window.isDestroyed()) await window.webContents.executeJavaScript("window.dispatchEvent(new Event('dsh-desktop:open-updates'))")
  return runtimeController?.checkUpdates()
}

function buildMenu() {
  const editor = selectedDesktopEditor()
  const updates = runtimeController?.getUpdateAdapters() ?? {}
  const updateItem = updates.desktop?.menuItem?.()
  const dshUpdateItem = updates.dsh?.menuItem?.()
  const dshRestoreItem = updates.dsh?.restoreItem?.()
  const editorItems = editors.length === 0
    ? [{ label: copy.noEditor, enabled: false }]
    : [
        {
          label: editor === undefined ? copy.automaticEditor : `${copy.automaticEditor} (${editor.label})`,
          type: 'radio',
          checked: editorPreference === 'auto',
          click: () => saveEditorPreference('auto'),
        },
        { type: 'separator' },
        ...editors.map(candidate => ({
          label: candidate.label,
          type: 'radio',
          checked: editorPreference === candidate.id,
          click: () => saveEditorPreference(candidate.id),
        })),
      ]
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      id: TITLEBAR_MENU_ITEM_IDS.file,
      label: copy.file,
      submenu: [
        {
          label: copy.newTask,
          accelerator: 'CmdOrCtrl+N',
          click: () => handleDetached(executeWorkspaceUiAction('newTask'), 'New workspace task'),
        },
        {
          label: copy.openWorkspaceInEditor,
          accelerator: 'CmdOrCtrl+Shift+O',
          enabled: activeWorkspace !== undefined && editor !== undefined,
          click: () => {
            if (activeWorkspace !== undefined) handleDetached(reportDesktopAction(() => openDesktopPath(activeWorkspace, 'editor')), 'Open workspace in editor')
          },
        },
        {
          label: copy.openWorkspaceFolder,
          enabled: activeWorkspace !== undefined,
          click: () => {
            if (activeWorkspace !== undefined) handleDetached(reportDesktopAction(() => openDesktopPath(activeWorkspace, 'default')), 'Open workspace folder')
          },
        },
        { type: 'separator' },
        { label: copy.preferredEditor, submenu: editorItems },
        { type: 'separator' },
        {
          label: copy.closeWindow,
          accelerator: 'CmdOrCtrl+W',
          click: () => windowHost.close('workspace'),
        },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit', label: copy.quit }]),
      ],
    },
    {
      id: TITLEBAR_MENU_ITEM_IDS.edit,
      label: copy.edit,
      submenu: [
        { role: 'undo', label: copy.undo },
        { role: 'redo', label: copy.redo },
        { type: 'separator' },
        { role: 'cut', label: copy.cut },
        { role: 'copy', label: copy.copy },
        { role: 'paste', label: copy.paste },
        { type: 'separator' },
        { role: 'selectAll', label: copy.selectAll },
        { type: 'separator' },
        {
          label: copy.settings,
          accelerator: 'CmdOrCtrl+,',
          click: () => handleDetached(executeWorkspaceUiAction('settings'), 'Open Settings'),
        },
      ],
    },
    {
      id: TITLEBAR_MENU_ITEM_IDS.view,
      label: copy.view,
      submenu: [
        {
          label: copy.toggleSidebar,
          accelerator: 'CmdOrCtrl+B',
          click: () => handleDetached(executeWorkspaceUiAction('toggleSidebar'), 'Toggle sidebar'),
        },
        {
          label: copy.toggleBottomPanel,
          accelerator: 'CmdOrCtrl+J',
          click: () => handleDetached(executeWorkspaceUiAction('toggleBottomPanel'), 'Toggle bottom panel'),
        },
        {
          label: copy.toggleRightPanel,
          click: () => handleDetached(executeWorkspaceUiAction('toggleRightPanel'), 'Toggle plugin sidebar'),
        },
        {
          label: copy.openDesktopControlCenter,
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => handleDetached(() => windowHost.loadManagementRoute('overview'), 'Open desktop control center'),
        },
        { type: 'separator' },
        { label: copy.reload, accelerator: 'CmdOrCtrl+R', click: () => windowHost.reload('workspace') },
        { label: copy.retry, click: () => handleDetached(runtimeController?.restart('menu-restart'), 'Menu Harness restart') },
        { type: 'separator' },
        { role: 'resetZoom', label: copy.actualSize },
        { role: 'zoomIn', label: copy.zoomIn },
        { role: 'zoomOut', label: copy.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: copy.toggleFullscreen },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: copy.developerTools }] : []),
      ],
    },
    ...(process.platform === 'darwin' ? [{
      label: copy.window,
      submenu: [
        { role: 'minimize', label: copy.minimize },
        { role: 'close', label: copy.close },
      ],
    }] : []),
    {
      id: TITLEBAR_MENU_ITEM_IDS.help,
      label: copy.help,
      submenu: [
        {
          label: copy.documentation,
          click: () => handleDetached(() => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness#readme'), 'Open Harness documentation'),
        },
        {
          label: copy.keyboardShortcuts,
          click: () => handleDetached(showWorkspaceShortcuts(), 'Show keyboard shortcuts'),
        },
        {
          label: copy.feedback,
          click: () => handleDetached(() => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness/issues'), 'Open Harness feedback'),
        },
        { type: 'separator' },
        ...(updateItem === undefined ? [] : [{
          label: updateItem.label,
          enabled: updateItem.enabled,
          click: () => handleDetached(openUpdatesAndCheck(), 'Installer update check'),
        }, { type: 'separator' }]),
        ...(dshUpdateItem === undefined ? [] : [{
          label: dshUpdateItem.label,
          enabled: dshUpdateItem.enabled,
          click: () => handleDetached(openUpdatesAndCheck(), 'DSH update check'),
        }]),
        ...(dshRestoreItem === undefined ? [] : [{
          label: dshRestoreItem.label,
          enabled: dshRestoreItem.enabled,
          click: () => handleDetached(runtimeController?.restoreDsh(), 'DSH runtime restore'),
        }]),
        ...(dshUpdateItem === undefined ? [] : [{ type: 'separator' }]),
        { label: copy.openLogs, click: () => { if (logPath !== undefined) handleDetached(() => shell.openPath(dirname(logPath)), 'Open log folder') } },
        { label: 'DeepSeek Harness', click: () => handleDetached(() => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'), 'Open Harness repository') },
        { type: 'separator' },
        { label: copy.about, click: () => handleDetached(showWorkspaceAbout(), 'Show About dialog') },
      ],
    },
  ]
  applicationMenu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(applicationMenu)
  const workspaceWindow = windowHost.getWindow('workspace')
  if (process.platform === 'win32' && windowHost.isOpen(workspaceWindow)) {
    if (typeof workspaceWindow.setAutoHideMenuBar === 'function') workspaceWindow.setAutoHideMenuBar(true)
    if (typeof workspaceWindow.setMenuBarVisibility === 'function') workspaceWindow.setMenuBarVisibility(false)
  }
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  nativeTheme.on('updated', () => {
    if (workspaceThemePreference === 'system') {
      const resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      workspaceResolvedTheme = resolvedTheme
      if (desktopSettingsPath !== undefined) {
        writeDesktopSettings(desktopSettingsPath, {
          ...readDesktopSettings(desktopSettingsPath),
          theme: 'system',
          resolvedTheme,
        })
      }
    }
    windowHost?.updateTheme?.()
    backgroundTray?.setIcon(desktopIconPath())
  })

  app.on('second-instance', () => {
    windowHost.focus('splash') || windowHost.focus('workspace') || windowHost.focus('management')
  })

  app.whenReady().then(async () => {
    app.setName('DeepSeek Harness Desktop')
    setLocale(PREFERRED_LOCALE)
    desktopDistributionFlavor = readDesktopDistributionFlavor(app.getAppPath())
    const logsDirectory = join(app.getPath('userData'), 'logs')
    mkdirSync(logsDirectory, { recursive: true })
    logPath = join(logsDirectory, 'desktop.log')
    logStream = createDiagnosticLog({
      path: logPath,
      onError: error => {
        const detail = error instanceof Error ? error.message : String(error)
        if (!app.isPackaged) process.stderr.write(`Unable to persist desktop log: ${diagnosticLogText(detail)}\n`)
      },
    })
    onboardingStatePath = onboardingMarkerPath(desktopDistributionFlavor === 'suite'
      ? join(app.getPath('userData'), 'plugin-suite')
      : app.getPath('userData'))
    registerOnboardingIpc()
    writeLog('desktop', `DeepSeek Harness Desktop ${app.getVersion()} starting on ${process.platform}/${process.arch}.\n`)

    const runtimeRoot = resolveManagedDshRuntimeRoot({
      userProfile: process.env.USERPROFILE,
      userData: app.getPath('userData'),
    })
    managedRuntimeRootForTheme = runtimeRoot
    releaseOwnership = await acquireReleaseOwnership({
      stateRoot: join(runtimeRoot, 'release-state'),
      role: 'desktop',
    })
    const initialRuntime = readActiveDshRuntime({
      runtimeRoot,
      bundledManifestPath: resolveBundledDshManifest(),
    })
    if (initialRuntime.managedError !== undefined) writeLog('stderr', `[dsh-updater/error] Ignoring invalid managed DSH runtime: ${initialRuntime.managedError}\n`)
    writeLog('desktop', `[dsh-updater/info] Using DSH ${initialRuntime.version} from the ${initialRuntime.source} runtime.\n`)

    const dshHome = resolveHarnessHome(process.env, app.getPath('home'), app.getPath('home'))
    if (desktopDistributionFlavor === 'suite' && readSharePreset(app.getAppPath())) {
      shareAutoConfigure = !existsSync(join(dshHome, 'settings.yaml')) && onboardingShouldShow()
      seedShareAppearance(app.getAppPath(), dshHome)
    }
    harnessHomePath = dshHome
    const harnessEnv = prepareHarnessToolchain({
      directory: join(app.getPath('userData'), 'toolchain'),
      execPath: process.execPath,
      pnpmEntry: resolvePnpmEntry(),
      env: process.env,
    })
    harnessEnv.DSH_DESKTOP_APP_VERSION = app.getVersion()
    if (typeof logPath === 'string') harnessEnv.DSH_DESKTOP_LOG_PATH = logPath
    if (desktopDistributionFlavor === 'suite') {
      try {
        const mnemon = resolveBundledMnemon({ appPath: app.getAppPath() })
        harnessEnv.MNEMON_CLI_PATH = mnemon.path
        writeLog('desktop', `[plugin-suite] Verified bundled Mnemon ${mnemon.version} for ${process.platform}/${process.arch}.\n`)
      } catch (error) {
        writeLog('stderr', `[plugin-suite] Bundled Mnemon is unavailable or untrusted: ${diagnosticLogText(error)}\n`)
      }
    }
    if (await inheritDesktopLoopbackProxy(harnessEnv)) {
      writeLog('desktop', 'Inherited the available 127.0.0.1:7892 proxy for connector sign-in processes.\n')
    }
    editors = detectEditors()
    desktopSettingsPath = join(app.getPath('userData'), 'desktop-settings.json')
    const desktopSettings = readDesktopSettings(desktopSettingsPath)
    editorPreference = normalizeEditorPreference(desktopSettings.editor, editors)
    workspaceThemePreference = desktopSettings.theme
    nativeTheme.themeSource = desktopSettings.theme
    workspaceResolvedTheme = desktopSettings.theme === 'system'
      ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
      : desktopSettings.theme
    writeLog('desktop', `Detected editors: ${editors.map(editor => editor.id).join(', ') || 'none'}.\n`)

    writeLog('desktop', '[startup] Creating the desktop runtime controller.\n')
    runtimeController = createDesktopRuntimeController({
      window: windowHost,
      copy,
      isChinese,
      dialog,
      net,
      shell,
      app,
      process,
      releaseOwnership,
      effects: {
        notify: () => { buildMenu(); desktopIpcHost?.notify() },
        writeLog,
        reportDetachedFailure,
        clearWorkspaceContext,
        getLogPath: () => logPath,
        getLanguage: () => isChinese ? 'zh' : 'en',
        getThemePreference: () => readHarnessThemePreference(dshHome),
        preserveLoadingSurface: () => onboardingInstalling !== undefined,
      },
      runtime: {
        app,
        process,
        env: harnessEnv,
        dshHome,
        runtimeRoot,
        repositoryRoot: app.getAppPath(),
        desktopReleaseRepository: 'Ricardo-WJP/dsh-desktop',
        desktopDistributionFlavor: (() => {
          try { const p = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')); return ['standard', 'suite'].includes(p.dshDesktopFlavor) ? p.dshDesktopFlavor : undefined } catch { return undefined }
        })(),
        initialRuntime,
        resolvePnpmEntry,
        resolveDshEntry,
      },
    })
    writeLog('desktop', '[startup] Desktop runtime controller is ready.\n')

    desktopIpcHost.register()
    createDesktopTray()
    writeLog('desktop', '[startup] Creating workspace and splash windows before release recovery.\n')
    windowHost.create('workspace')
    windowHost.create('splash')
    writeLog('desktop', '[startup] Recovering any pending release transaction.\n')
    const releaseRecovery = await runtimeController.recoverPendingRelease()
    writeLog('desktop', `[startup] Release recovery completed with status ${String(releaseRecovery?.status ?? 'unknown')}.\n`)
    runtimeController.initializeUpdates()
    buildMenu()
    if (releaseRecovery?.status !== 'idle') {
      writeLog('desktop', `[release/recovery] Recovered pending ${releaseRecovery?.operation ?? 'release'} transaction before normal startup.\n`)
    }
    const stagedPluginCandidateId = runtimeController.statusSnapshot()?.plugins?.pendingCandidateId
    if (typeof stagedPluginCandidateId === 'string' && stagedPluginCandidateId !== '') {
      try {
        writeLog('desktop', `[plugin-transaction] Resuming staged candidate ${stagedPluginCandidateId} before normal startup.\n`)
        const resumed = await runtimeController.restartPluginChanges('startup-plugin-resume')
        if (restartResultFailed(resumed)) throw new Error(`Staged plugin candidate ${stagedPluginCandidateId} did not become ready`)
        if (onboardingShouldShow()) finishOnboarding()
        return
      } catch (error) {
        writeLog('stderr', `[plugin-transaction] Unable to resume staged candidate safely: ${diagnosticLogText(error)}\n`)
        try {
          await runtimeController.abandonPendingPluginCandidate?.('startup resume failure')
        } catch (cleanupError) {
          writeLog('stderr', `[plugin-transaction] Unable to retire failed startup candidate: ${diagnosticLogText(cleanupError)}\n`)
        }
        handleDetached(runtimeController.restart('startup-after-plugin-resume-failure'), 'Fallback Harness startup')
        return
      }
    }
    if (ensureHarnessSettingsDocument(dshHome)) {
      writeLog('desktop', '[bootstrap] Prepared a writable DSH settings document for first-run acknowledgement.\n')
    }
    const desktopPlugin = installDesktopPluginForNewWebProfile({
      sourceDir: join(import.meta.dirname, 'plugins', 'dsh-desktop-integration'),
      dshHome,
    })
    if (desktopPlugin.installed) {
      const action = desktopPlugin.repaired ? 'Refreshed' : 'Installed'
      writeLog('desktop', `[bootstrap] ${action} the bundled desktop integration at ${desktopPlugin.targetDir}.\n`)
    } else {
      writeLog('desktop', '[bootstrap] Verified the bundled desktop integration is current.\n')
    }
    handleDetached(startInitialHarnessWithCompatibilityRepair(), 'Initial Harness startup')
  }).catch(async error => {
    const detail = diagnosticDetail(error)
    writeLog('stderr', `${copy.startupFailed}: ${detail}\n`)
    try { dialog.showErrorBox(copy.startupFailed, detail) } catch (dialogError) { reportDetachedFailure('Startup failure dialog', dialogError) }
    if (runtimeController === undefined) {
      try { await releaseOwnership?.release?.() } catch (releaseError) { reportDetachedFailure('Release ownership cleanup', releaseError) }
    }
    app.quit()
  })

  app.on('activate', () => {
    if (!windowHost.hasOpenWindows()) {
      windowHost.create('workspace')
      windowHost.create('splash')
      handleDetached(runtimeController?.restart('activate-startup'), 'Activated Harness startup')
    } else {
      windowHost.focusActive()
    }
  })

  app.on('before-quit', event => {
    quitLifecycle.handleBeforeQuit(event)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && backgroundTray === undefined) app.quit()
  })

  app.on('will-quit', () => {
    backgroundTray?.destroy?.()
    backgroundTray = undefined
    if (runtimeController === undefined) void releaseOwnership?.release?.().catch(error => reportDetachedFailure('Release ownership cleanup', error))
  })
}
