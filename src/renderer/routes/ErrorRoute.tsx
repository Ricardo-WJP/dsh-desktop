import type { DesktopStatus } from '../global'
import { ActionButton, StatusPill } from '../components/Primitives'
import { stateLabel, userFacingDetail } from '../localization'

export default function ErrorRoute({ status, onRetry, onOpenLogs, onSafeStart, onSafeExit, pendingAction = null }: { status: DesktopStatus; onRetry: () => void; onOpenLogs: () => void; onSafeStart: () => void; onSafeExit: () => void; pendingAction?: string | null }) {
  const detail = userFacingDetail(status.startup.error || status.startup.message, '未上报详细信息')
  const safeMode = status.plugins.recoveryMode
  return <div className="route route--error"><section className="hero hero--error startup-hero error-hero">
    <div className="error-hero__status"><span className="error-hero__status-dot" aria-hidden="true" />运行状态 / 已停止 · 启动 / 恢复边界<StatusPill tone="danger">Host 尚未就绪</StatusPill></div>
    <h1>DeepSeek Harness 已停止。</h1>
    <p className="lede">本地 Harness 未能就绪。可以先重启；如果怀疑第三方插件导致故障，安全模式会临时隔离插件后启动，不删除插件或改写当前配置。</p>
    <div className="hero__actions"><ActionButton variant="primary" onClick={onRetry} disabled={pendingAction !== null || status.update.busy || status.plugins.busy} loading={pendingAction === 'restart'}>重启 Harness</ActionButton><ActionButton onClick={safeMode ? onSafeExit : onSafeStart} disabled={pendingAction !== null || status.plugins.busy || (!safeMode && !status.plugins.recoveryAvailable)} loading={pendingAction === (safeMode ? 'plugin-safe-exit' : 'plugin-safe-start')}>{safeMode ? '退出插件安全模式' : '插件安全模式'}</ActionButton><ActionButton variant="quiet" onClick={onOpenLogs} disabled={pendingAction !== null} loading={pendingAction === 'open-logs'}>打开日志</ActionButton></div>
    <div className="error-hero__diagnostic"><div className="error-hero__diagnostic-head"><span>最近状态</span><strong>{stateLabel(status.startup.phase)}</strong></div><code>{detail}</code></div>
    <div className="error-hero__footer"><span>日志和诊断视图已保留</span><span>未执行的修复不会被标记为已完成</span></div>
  </section></div>
}
