import type { DesktopStatus } from '../global'
import { ActionButton, Panel, StatusPill } from '../components/Primitives'
import { stateLabel, userFacingDetail } from '../localization'

export default function LoadingRoute({ status, onRetry, onOpenLogs, pendingAction = null }: { status: DesktopStatus; onRetry: () => void; onOpenLogs: () => void; pendingAction?: string | null }) {
  const failed = status.startup.phase === 'error' || Boolean(status.startup.error)
  const progress = Math.min(100, Math.max(0, status.startup.progress))
  return (
    <div className="route route--loading">
      <div className="hero hero--loading startup-hero">
        <div className="startup-hero__brand"><span className="startup-hero__mark"><img src="favicon.ico" alt="" /></span><div><strong>DeepSeek Harness Desktop</strong><small>本地运行环境</small></div></div>
        <p className="eyebrow">运行状态 / {failed ? '需要处理' : '连接中'}</p>
        <h1>{failed ? '本地工作区需要处理。' : '正在准备本地工作区。'}</h1>
        <p className="lede">专用 DSH 工作区启动期间，桌面服务会保持可用。只有收到 Host 确认后，操作才会显示为已完成。</p>
        <div className="loading-progress" aria-live="polite">
          <div className="loading-progress__meta"><span>{userFacingDetail(status.startup.message, '正在准备…')}</span><strong>{Math.round(progress)}%</strong></div>
          <progress className="progress-track" max={100} value={progress} aria-label="启动进度" />
          <div className="loading-progress__stage"><span>{stateLabel(status.startup.phase)}</span><StatusPill tone={failed ? 'danger' : 'accent'}>{failed ? '需要重试' : '进行中'}</StatusPill></div>
        </div>
        <div className="hero__actions">{failed && <ActionButton variant="primary" onClick={onRetry} disabled={pendingAction !== null || status.update.busy} loading={pendingAction === 'restart'}>重启 Harness</ActionButton>}<ActionButton variant="quiet" onClick={onOpenLogs} disabled={pendingAction !== null} loading={pendingAction === 'open-logs'}>打开日志</ActionButton></div>
      </div>
      <Panel eyebrow="职责边界" title="两个窗口，一个控制中心">
        <div className="split-note"><div><strong>桌面服务</strong><p>用于查看状态、更新、恢复和诊断的独立界面。</p></div><div><strong>DSH 工作区</strong><p>实际 Harness 页面运行在独立的沙盒 BrowserWindow 中，桌面服务不会向其中注入 DOM。</p></div></div>
      </Panel>
    </div>
  )
}
