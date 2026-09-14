import { useEffect, useState } from 'react'
import type { DesktopStatus } from '../global'
import { bridge, errorMessage } from '../api'
import { ActionButton, Panel, StatusPill } from '../components/Primitives'
import { stateLabel, userFacingDetail } from '../localization'

export default function DiagnosticsRoute({ status, onOpenLogs, pendingAction = null }: { status: DesktopStatus; onOpenLogs: () => void; pendingAction?: string | null }) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const api = bridge()
    if (api === undefined) {
      setError('桌面 Host 尚未连接。')
    } else {
      void api.logs.read(180).then(result => {
        if (!active) return
        if (result.ok) setLines(result.lines)
        else setError(errorMessage(result))
      }).catch(reason => {
        if (active) setError(userFacingDetail(reason instanceof Error ? reason.message : String(reason)))
      })
    }
    return () => { active = false }
  }, [])
  return <div className="route"><div className="page-heading"><div><p className="eyebrow">运行诊断</p><h1>日志与诊断</h1><p className="lede">查看桌面 Host 的真实日志和当前连接状态。</p></div><div className="page-heading__actions"><ActionButton onClick={onOpenLogs} disabled={pendingAction !== null || status.logs.state !== 'available'} loading={pendingAction === 'open-logs'}>打开日志文件夹</ActionButton></div></div><div className="diagnostics-cards"><Panel eyebrow="桌面 Host" title="工作区"><StatusPill tone={status.workspace.ready ? 'positive' : 'warning'}>{stateLabel(status.workspace.ready ? 'ready' : status.startup.phase)}</StatusPill></Panel><Panel eyebrow="监视器" title="开发客户端"><StatusPill tone={status.mode.dev.watcher === 'ready' ? 'positive' : 'neutral'}>{stateLabel(status.mode.dev.watcher)}</StatusPill></Panel><Panel className="diagnostics-file-card" title="日志文件"><p className="diagnostics-file-path">{status.logs.path ?? '不可用'}</p><p className="muted">{stateLabel(status.logs.state)}</p></Panel></div><Panel eyebrow="最近输出" title="桌面日志末尾"><pre className="log-view" aria-live="polite">{error || (lines.length > 0 ? lines.join('\n') : '尚未上报日志内容。')}</pre></Panel></div>
}
