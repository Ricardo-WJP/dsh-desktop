import { useEffect, useState, type ReactNode } from 'react'
import type { DesktopStatus } from '../global'
import { bridge, errorMessage } from '../api'
import { ActionButton, EmptyState, Panel, StatusPill } from '../components/Primitives'
import { modeName, sourceName, stateLabel, userFacingDetail } from '../localization'

type IconName = 'workspace' | 'refresh' | 'update' | 'rollback' | 'snapshot' | 'arrow' | 'external' | 'info' | 'check' | 'warning'

type ActivityState = {
  lines: string[]
  loading: boolean
  error: string
}

type ActivityEntry = {
  id: string
  timestamp: string | null
  timeLabel: string
  message: string
  source: string
  sourceLabel: string
  tone: 'positive' | 'warning' | 'danger' | 'neutral'
}

const activityLinePattern = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$/
const activityErrorPattern = /\b(error|failed|failure|fatal)\b/i
const activityWarningPattern = /\b(warn|warning|degraded)\b/i

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    workspace: <><path d="M3.5 7.5h6l1.7 2h9.3v9.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" /><path d="M3.5 7.5V5.3A1.8 1.8 0 0 1 5.3 3.5h3.1l1.7 2h8.6a1.8 1.8 0 0 1 1.8 1.8" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0 1 4" /><path d="m20 4 1 7-7-1" /></>,
    update: <><path d="M12 19V5" /><path d="m6.5 11 5.5-6 5.5 6" /><circle cx="12" cy="19" r="2" /></>,
    rollback: <><path d="M4 12a8 8 0 1 0 3-6" /><path d="M4 4v6h6" /></>,
    snapshot: <><path d="M4 7.5h16v12H4z" /><path d="M8 7.5V5h8v2.5M8 12h8M8 16h5" /></>,
    arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    check: <><path d="m5 12 4.2 4.2L19 6.5" /></>,
    warning: <><path d="m12 4 9 16H3z" /><path d="M12 9v5M12 17h.01" /></>,
  }
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function activitySourceLabel(source: string) {
  if (source === 'desktop') return '桌面服务'
  if (source === 'stderr') return '错误输出'
  return source || '日志'
}

function activityTone(source: string, message: string): ActivityEntry['tone'] {
  if (source === 'stderr' || activityErrorPattern.test(message)) return 'danger'
  if (activityWarningPattern.test(message)) return 'warning'
  return 'neutral'
}

function parseActivityLine(line: string, index: number): ActivityEntry | null {
  const raw = line.trim()
  if (!raw) return null
  const match = raw.match(activityLinePattern)
  const timestamp = match?.[1] ?? null
  const source = match?.[2]?.trim() ?? ''
  const message = (match?.[3] ?? raw).trim() || '日志内容为空'
  const parsedTimestamp = timestamp === null ? null : new Date(timestamp)
  const validTimestamp = parsedTimestamp !== null && !Number.isNaN(parsedTimestamp.getTime())
  return {
    id: `${timestamp ?? 'unknown'}-${source}-${message}-${index}`,
    timestamp: validTimestamp ? parsedTimestamp.toISOString() : null,
    timeLabel: validTimestamp
      ? parsedTimestamp.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : '时间未上报',
    message,
    source,
    sourceLabel: activitySourceLabel(source),
    tone: activityTone(source, message),
  }
}

function dataStateLabel(state: DesktopStatus['data'] extends infer T ? T extends { state: infer S } ? S : never : never) {
  if (state === 'independent') return '用户数据独立保存'
  if (state === 'candidate') return '候选版本数据目录'
  return '数据目录未上报'
}

function dataStateTone(state: DesktopStatus['data'] extends infer T ? T extends { state: infer S } ? S : never : never): 'positive' | 'accent' | 'warning' {
  if (state === 'independent') return 'positive'
  if (state === 'candidate') return 'accent'
  return 'warning'
}

function navigate(route: 'update' | 'recovery' | 'diagnostics') {
  window.location.hash = `#/${route}`
}

export default function OverviewRoute({
  status,
  onOpenWorkspace,
  onRestart,
  onOpenLogs,
  onCheckUpdate,
  onRollback,
  onOpenRecovery,
  pendingAction = null,
}: {
  status: DesktopStatus
  onOpenWorkspace: () => void
  onRestart: () => void
  onOpenLogs: () => void
  onCheckUpdate: () => void
  onRollback: (candidateId: string) => void
  onOpenRecovery: () => void
  pendingAction?: string | null
}) {
  const [activity, setActivity] = useState<ActivityState>({ lines: [], loading: true, error: '' })
  const startupFailed = status.startup.phase === 'error' || Boolean(status.startup.error)
  const workspaceReady = status.workspace.ready
  const anyBusy = pendingAction !== null
    || status.update.busy
    || status.candidate.busy === true
    || status.snapshots.busy === true
    || status.plugins.busy
  const effectiveMode = status.mode.active
  const dataState = status.data?.state ?? 'unavailable'
  const canCheckUpdate = status.update.available && status.update.checkAvailable && !status.update.busy && pendingAction === null
  const rollbackId = status.candidate.previousReleaseId
  const canRollback = typeof rollbackId === 'string'
    && rollbackId.length > 0
    && status.candidate.codeRollbackAvailable === true
    && status.candidate.busy !== true
    && pendingAction === null
  const readyTone = startupFailed ? 'danger' : workspaceReady ? 'positive' : 'warning'
  const readyTitle = startupFailed ? '工作区未就绪' : workspaceReady ? '工作区已就绪' : '工作区正在启动'
  const readyDetail = startupFailed
    ? userFacingDetail(status.startup.error || status.startup.message, '桌面 Host 未能完成启动。')
    : workspaceReady
      ? '桌面 Host 已确认工作区窗口，可以开始工作。'
      : userFacingDetail(status.startup.message, '正在等待桌面 Host 完成启动。')
  const updateLabel = pendingAction === 'probe-dsh' || status.update.busy
    ? '正在检查更新…'
    : canCheckUpdate
      ? '检查更新'
      : '检查更新不可用'
  const rollbackLabel = pendingAction === 'rollback-program'
    ? '正在准备回退…'
    : canRollback
      ? '回退程序版本'
      : '暂无可回退程序'
  const checkStatus = status.update.latestVersion === null
    ? '尚未检查'
    : status.update.updateAvailable
      ? '发现可用版本'
      : '已检查，未发现更新'

  useEffect(() => {
    let active = true
    const api = bridge()
    if (api === undefined) {
      setActivity({ lines: [], loading: false, error: '桌面 Host 尚未连接。' })
      return () => { active = false }
    }
    if (status.logs.state !== 'available') {
      setActivity({ lines: [], loading: false, error: '' })
      return () => { active = false }
    }
    setActivity(current => ({ ...current, loading: true, error: '' }))
    void api.logs.read(8).then(result => {
      if (!active) return
      if (result.ok) setActivity({ lines: result.lines, loading: false, error: '' })
      else setActivity({ lines: [], loading: false, error: errorMessage(result, '无法读取近期活动。') })
    }).catch(reason => {
      if (active) setActivity({ lines: [], loading: false, error: userFacingDetail(reason instanceof Error ? reason.message : String(reason), '无法读取近期活动。') })
    })
    return () => { active = false }
  }, [status.logs.path, status.logs.state, status.startup.phase, status.update.busy, status.candidate.busy, status.snapshots.busy, status.plugins.busy])

  const entries = activity.lines
    .map(parseActivityLine)
    .filter((entry): entry is ActivityEntry => entry !== null)
    .slice(-5)
    .reverse()

  return (
    <div className="route route--overview control-center">
      <div className="control-center__columns">
        <div className="control-center__left">
          <section className="panel control-panel readiness-panel" aria-labelledby="workspace-ready-title">
            <div className="readiness-panel__copy">
              <div className="readiness-panel__heading"><h1 id="workspace-ready-title">桌面控制中心</h1></div>
              <p className="lede">管理工作区、版本更新与数据恢复。</p>
              <div className="readiness-panel__actions">
                <ActionButton variant="primary" onClick={onOpenWorkspace} disabled={!workspaceReady || anyBusy} loading={pendingAction === 'open-workspace'}><Icon name="workspace" /><span>打开工作区</span></ActionButton>
              </div>
            </div>
          </section>
          <div className="native-status-strip">
            <StatusPill tone={readyTone}>{readyTitle}</StatusPill>
            <span>DSH {status.runtime?.version ?? '版本未上报'}</span>
            <ActionButton variant="quiet" onClick={onRestart} disabled={anyBusy} loading={pendingAction === 'restart'}><Icon name="refresh" /><span>重启服务</span></ActionButton>
          </div>
          {!workspaceReady && <p className="feedback" role={startupFailed ? 'alert' : 'status'}>{readyDetail}</p>}

          <section className="panel control-panel operations-panel" aria-labelledby="operations-title">
            <header className="operations-panel__header"><h2 id="operations-title" className="panel__title">维护</h2></header>
            <div className="operation-list">
              <div className="operation-row operation-row--update">
                <span className="operation-row__icon" aria-hidden="true"><Icon name="update" /></span>
                <div className="operation-row__body"><h3>检查更新</h3><p>{status.update.available ? '检查 DSH 运行时是否有可用版本。' : 'DSH 运行时更新服务未上报可用。'}</p></div>
                <ActionButton variant="secondary" onClick={onCheckUpdate} disabled={!canCheckUpdate} loading={pendingAction === 'probe-dsh'}>{updateLabel}</ActionButton>
              </div>
              <div className="operation-row operation-row--snapshot">
                <span className="operation-row__icon" aria-hidden="true"><Icon name="snapshot" /></span>
                <div className="operation-row__body"><h3>恢复数据快照</h3><p>前往恢复中心查看快照；恢复前会先提示覆盖范围。</p></div>
                <ActionButton variant="secondary" onClick={onOpenRecovery}><span>管理快照</span><Icon name="arrow" /></ActionButton>
              </div>
            </div>
          </section>

          <section className="panel control-panel activity-panel" aria-labelledby="activity-title">
            <header className="activity-panel__header"><h2 id="activity-title" className="panel__title">近期活动</h2><button className="text-action" type="button" onClick={() => navigate('diagnostics')}><span>查看全部日志</span><Icon name="arrow" /></button></header>
            <div className="activity-table" role="table" aria-busy={activity.loading} aria-live="polite">
              <div className="activity-row activity-row--head" role="row"><span role="columnheader">时间</span><span role="columnheader">事件</span><span role="columnheader">来源</span><span aria-hidden="true" /></div>
              {activity.loading && entries.length === 0 ? <div className="activity-empty" role="row"><span className="activity-empty__label">正在读取日志…</span></div>
                : activity.error ? <div className="activity-empty activity-empty--error" role="row"><strong>{activity.error}</strong><span>可打开日志与诊断查看详细原因。</span></div>
                  : entries.length === 0 ? <EmptyState title="暂无可读取的活动记录" detail={status.logs.state === 'available' ? '日志服务未返回内容。' : '日志服务尚未提供可读取的记录。'} />
                    : entries.map(entry => <div className="activity-row" role="row" key={entry.id}><span role="cell" className="activity-cell activity-cell--time" data-label="时间">{entry.timestamp ? <time dateTime={entry.timestamp}>{entry.timeLabel}</time> : entry.timeLabel}</span><span role="cell" className="activity-cell activity-cell--message" data-label="事件" title={entry.message}>{entry.message}</span><span role="cell" className={`activity-cell activity-cell--source activity-cell--${entry.tone}`} data-label="来源"><span className="activity-source-dot" aria-hidden="true" />{entry.sourceLabel}</span><span className="activity-row__chevron" aria-hidden="true"><Icon name="arrow" /></span></div>)}
            </div>
          </section>
        </div>

        <details className="control-center__right native-runtime">
          <summary>运行详情</summary>
          <Panel className="control-panel runtime-panel" title="运行信息" action={<span className="info-mark" title="信息来自桌面 Host" aria-label="信息来自桌面 Host"><Icon name="info" /></span>}>
            <div className="runtime-list">
              <div className="runtime-row"><span>桌面端版本</span><strong>{status.app.version || '未上报'}</strong></div>
              <div className="runtime-row"><span>DSH 版本</span><strong>{status.runtime?.version ?? '未上报'}</strong></div>
              <div className="runtime-row"><span>运行模式</span><strong>{modeName(effectiveMode)}</strong></div>
              <div className="runtime-row"><span>工作区</span><strong className={`runtime-value runtime-value--${workspaceReady ? 'positive' : 'warning'}`}>{workspaceReady ? '已就绪' : stateLabel(status.startup.phase)}</strong></div>
              <div className="runtime-row"><span>数据存储状态</span><strong className={`runtime-value runtime-value--${dataStateTone(dataState)}`}>{dataStateLabel(dataState)}</strong></div>
              {status.data?.home ? <div className="runtime-row runtime-row--path"><span>数据目录</span><strong title={status.data.home}>{status.data.home}</strong></div> : null}
              <div className="runtime-row"><span>更新检查</span><strong>{checkStatus}</strong></div>
              <div className="runtime-row runtime-row--logs"><span>日志与诊断</span><button className="text-action" type="button" onClick={() => navigate('diagnostics')}><span>打开诊断视图</span><Icon name="external" /></button></div>
            </div>
            <div className="runtime-panel__footer"><span>日志目录</span><ActionButton variant="quiet" onClick={onOpenLogs} disabled={status.logs.state !== 'available' || anyBusy} loading={pendingAction === 'open-logs'}><span>打开日志文件夹</span><Icon name="external" /></ActionButton></div>
            <p className="route-note">{sourceName(status.runtime?.source)} · 状态持续由桌面 Host 提供</p>
            <ActionButton variant="secondary" onClick={() => rollbackId && onRollback(rollbackId)} disabled={!canRollback} loading={pendingAction === 'rollback-program'}>{rollbackLabel}</ActionButton>
          </Panel>
        </details>
      </div>
    </div>
  )
}
