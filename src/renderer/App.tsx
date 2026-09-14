import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bridge, errorMessage, previewStatus, readStatus } from './api'
import type { DesktopResult, DesktopStatus } from './global'
import AppShell, { type AppFeedback, type RouteName } from './components/AppShell'
import LoadingRoute from './routes/LoadingRoute'
import OverviewRoute from './routes/OverviewRoute'
import ModeRoute from './routes/ModeRoute'
import UpdateRoute from './routes/UpdateRoute'
import RecoveryRoute from './routes/RecoveryRoute'
import DiagnosticsRoute from './routes/DiagnosticsRoute'
import ErrorRoute from './routes/ErrorRoute'
import { channelName, modeName, userFacingDetail } from './localization'

function routeFromLocation(): RouteName {
  const hashRoute = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  const queryRoute = new URLSearchParams(window.location.search).get('route') ?? ''
  const value = hashRoute || queryRoute
  return ['loading', 'overview', 'mode', 'update', 'recovery', 'diagnostics', 'error'].includes(value) ? value as RouteName : 'overview'
}

function thrownMessage(error: unknown) {
  return userFacingDetail(error instanceof Error ? error.message : String(error))
}

export default function App() {
  const [route, setRoute] = useState<RouteName>(routeFromLocation)
  const [status, setStatus] = useState<DesktopStatus>(previewStatus())
  const [feedback, setFeedback] = useState<AppFeedback | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const desktop = bridge()

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromLocation())
    window.addEventListener('hashchange', onHashChange)
    let active = true
    void readStatus().then(next => { if (active) setStatus(next) }).catch(error => {
      if (active) setFeedback({ message: thrownMessage(error), tone: 'error' })
    })
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = desktop?.status.subscribe(next => { if (active) setStatus(next) })
    } catch (error) {
      if (active) setFeedback({ message: thrownMessage(error), tone: 'error' })
    }
    return () => { active = false; window.removeEventListener('hashchange', onHashChange); unsubscribe?.() }
  }, [desktop])

  const runAction = useCallback(async <T,>(name: string, operation: () => Promise<DesktopResult<T>> | undefined, fallback: string, pendingMessage: string, onSuccess?: (result: T) => AppFeedback | string | undefined) => {
    if (pendingActionRef.current !== null) return
    if (desktop === undefined) {
      setFeedback({ message: '桌面 Host 尚未连接。', tone: 'error' })
      return
    }
    pendingActionRef.current = name
    setPendingAction(name)
    setFeedback({ message: pendingMessage, tone: 'info' })
    try {
      const result = await operation()
      if (result === undefined) {
        setFeedback({ message: fallback, tone: 'error' })
      } else if (result.ok) {
        const successMessage = onSuccess?.(result)
        setFeedback(typeof successMessage === 'string' ? { message: successMessage, tone: 'info' } : successMessage ?? null)
      } else {
        setFeedback({ message: errorMessage(result, fallback), tone: 'error' })
      }
    } catch (error) {
      setFeedback({ message: thrownMessage(error) || fallback, tone: 'error' })
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
    }
  }, [desktop])

  const actions = useMemo(() => ({
    restart: () => { void runAction('restart', () => desktop?.app.restart(), 'Harness 重启请求未被接受。', '正在请求重启 Harness…') },
    openWorkspace: () => { void runAction('open-workspace', () => desktop?.workspace.open(), '工作区打开请求未被接受。', '正在打开工作区…') },
    openLogs: () => { void runAction('open-logs', () => desktop?.logs.open(), '日志文件夹打开请求未被接受。', '正在打开日志文件夹…') },
    checkUpdate: () => { void runAction('check-update', () => desktop?.update.check(), 'DSH 运行时候选版本准备请求未被接受。', '正在准备 DSH 候选版本…') },
    probeDshUpdate: () => { void runAction('probe-dsh', () => desktop?.update.probe(), 'DSH 最新版本检测请求未被接受。', '正在检查 DSH 更新…', result => {
      if (result.available === true) return `发现 DSH 更新：${result.latestVersion ?? '版本信息已上报'}。可在候选版本区域安全准备。`
      if (typeof result.error === 'string' && result.error !== '') return { message: `DSH 更新检测失败：${userFacingDetail(result.error)}`, tone: 'error' }
      return `检测完成：当前 DSH ${result.currentVersion ?? '版本信息未上报'} 未发现可用更新。`
    }) },
    checkDesktopUpdate: () => { void runAction('check-desktop-update', () => desktop?.update.desktopCheck(), '桌面安装程序更新检查请求未被接受。', '正在检查桌面版更新…') },
    restore: () => { void runAction('restore-runtime', () => desktop?.update.restore(), '内置 DSH 运行时恢复请求未被接受。', '正在恢复内置 DSH 运行时…') },
    createSnapshot: () => { void runAction('create-snapshot', () => desktop?.snapshots.create(), '当前无法创建快照。', '正在创建数据快照…') },
    restoreSnapshot: (snapshotId: string) => {
      if (!window.confirm(`恢复数据快照 ${snapshotId}？\n这会覆盖快照之后的数据修改。系统会先备份当前数据。\n如果只想回退程序版本，请取消并前往更新页面。`)) return
      void runAction('restore-snapshot', () => desktop?.snapshots.restore(snapshotId), '快照恢复请求未被接受。', '正在恢复数据快照…')
    },
    startPluginSafeMode: () => { void runAction('plugin-safe-start', () => desktop?.recovery.startPluginSafeMode(), '插件安全模式启动请求未被接受。', '正在以插件安全模式重启…') },
    exitPluginSafeMode: () => { void runAction('plugin-safe-exit', () => desktop?.recovery.exitPluginSafeMode(), '插件安全模式退出请求未被接受。', '正在退出插件安全模式…') },
    selectMode: (mode: 'stable' | 'dev') => { void runAction(`select-mode-${mode}`, () => desktop?.mode.set(mode), `当前无法切换到${modeName(mode)}。`, `正在切换到${modeName(mode)}…`) },
    prepareCandidate: (channel: 'stable' | 'next') => { void runAction(`prepare-${channel}`, () => desktop?.candidate.prepare(channel), `${channelName(channel)}候选版本准备请求未被接受。`, `正在准备${channelName(channel)}…`) },
    switchCandidate: (candidateId: string) => { void runAction('switch-candidate', () => desktop?.candidate.activate(candidateId), '当前无法切换候选版本。', '正在切换候选版本…') },
    rollbackProgram: (candidateId: string) => {
      if (!window.confirm('回退到上一份程序版本？当前会话、记忆和设置不会恢复到历史快照，但服务需要重启。')) return
      void runAction('rollback-program', () => desktop?.candidate.activate(candidateId), '程序回退请求未被接受。', '正在准备程序回退…')
    },
  }), [desktop, runAction])

  const page = route === 'loading' ? <LoadingRoute status={status} onRetry={actions.restart} onOpenLogs={actions.openLogs} pendingAction={pendingAction} />
    : route === 'overview' ? <OverviewRoute status={status} onOpenWorkspace={actions.openWorkspace} onRestart={actions.restart} onOpenLogs={actions.openLogs} onCheckUpdate={actions.probeDshUpdate} onRollback={actions.rollbackProgram} onOpenRecovery={() => { window.location.hash = '#/recovery' }} pendingAction={pendingAction} />
      : route === 'mode' ? <ModeRoute status={status} onSelect={actions.selectMode} pendingAction={pendingAction} />
        : route === 'update' ? <UpdateRoute status={status} onDesktopCheck={actions.checkDesktopUpdate} onCheckDsh={actions.probeDshUpdate} onRestore={actions.restore} onPrepare={actions.prepareCandidate} onSwitch={actions.switchCandidate} pendingAction={pendingAction} />
          : route === 'recovery' ? <RecoveryRoute status={status} onCreate={actions.createSnapshot} onRestore={actions.restoreSnapshot} onSafeStart={actions.startPluginSafeMode} onSafeExit={actions.exitPluginSafeMode} pendingAction={pendingAction} />
            : route === 'diagnostics' ? <DiagnosticsRoute status={status} onOpenLogs={actions.openLogs} pendingAction={pendingAction} />
              : <ErrorRoute status={status} onRetry={actions.restart} onOpenLogs={actions.openLogs} onSafeStart={actions.startPluginSafeMode} onSafeExit={actions.exitPluginSafeMode} pendingAction={pendingAction} />
  return <AppShell route={route} status={status} feedback={feedback}>{page}</AppShell>
}
