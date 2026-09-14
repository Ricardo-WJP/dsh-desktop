import { useEffect, useState } from 'react'
import { bridge, errorMessage } from '../api'
import type { DesktopStatus, SnapshotSummary } from '../global'
import { ActionButton, Panel, StatusPill, Unavailable } from '../components/Primitives'
import { stateLabel, userFacingDetail } from '../localization'

function bytesLabel(value: number) {
  if (!Number.isFinite(value) || value < 0) return '大小未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

export default function RecoveryRoute({ status, onCreate, onRestore, onSafeStart, onSafeExit, pendingAction = null }: { status: DesktopStatus; onCreate: () => void; onRestore: (snapshotId: string) => void; onSafeStart: () => void; onSafeExit: () => void; pendingAction?: string | null }) {
  const available = status.snapshots.available === true
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([])
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    let active = true
    if (!available) { setSnapshots([]); setRefreshing(false); return () => { active = false } }
    const api = bridge()
    if (api === undefined) { setError('桌面 Host 尚未连接。'); setRefreshing(false); return () => { active = false } }
    setRefreshing(true)
    void api.snapshots.list().then(result => {
      if (!active) return
      if (result.ok) { setSnapshots(result.snapshots); setError('') }
      else setError(errorMessage(result, '无法列出快照。'))
    }).catch(reason => { if (active) setError(userFacingDetail(reason instanceof Error ? reason.message : String(reason))) }).finally(() => { if (active) setRefreshing(false) })
    return () => { active = false }
  }, [available, status.snapshots.count, refreshVersion])

  return <div className="route">
    <div className="page-heading"><div><p className="eyebrow">恢复中心</p><h1>恢复数据与插件启动</h1><p className="lede">查看插件状态，创建或恢复已验证的数据快照。</p></div><ActionButton disabled={pendingAction !== null || !available || status.snapshots.busy} loading={pendingAction === 'create-snapshot'} onClick={onCreate}>{status.snapshots.busy || pendingAction === 'create-snapshot' ? '快照操作进行中…' : available ? '创建快照' : '快照不可用'}</ActionButton></div>
    {(status.plugins.compatibilityWarnings?.length ?? 0) > 0 ? <Panel title="插件兼容提示">
      <p className="panel-copy">以下插件继续使用原生实现。客户端不会因为缺少专用增强补丁而阻止启动；更新仍需通过隔离验证。</p>
      <ul className="check-list">{status.plugins.compatibilityWarnings?.map(item => <li key={item.packageName}>{item.message}</li>)}</ul>
    </Panel> : null}
    <Panel eyebrow="插件自修复" title="无需外部工具也能启动 DSH" action={<StatusPill tone={status.plugins.recoveryMode ? 'warning' : 'positive'}>{status.plugins.recoveryMode ? '安全模式运行中' : '正常模式'}</StatusPill>}>
      <p className="panel-copy">安全模式只用临时覆盖层隔离第三方插件；插件文件、启用状态和当前配置不会被删除。排查完成后可一键恢复正常启动。</p>
      <div className="button-row"><ActionButton disabled={pendingAction !== null || status.plugins.busy || (!status.plugins.recoveryMode && !status.plugins.recoveryAvailable)} loading={pendingAction === (status.plugins.recoveryMode ? 'plugin-safe-exit' : 'plugin-safe-start')} onClick={status.plugins.recoveryMode ? onSafeExit : onSafeStart}>{status.plugins.recoveryMode ? '退出插件安全模式' : '以插件安全模式重启'}</ActionButton></div>
    </Panel>
    <Panel eyebrow="恢复状态" title="快照存储" action={<StatusPill tone={available ? 'positive' : 'warning'}>{stateLabel(status.snapshots.state)}</StatusPill>}>
      {!available ? <Unavailable title="快照操作不可用" detail={userFacingDetail(status.snapshots.reason, '快照服务尚未连接。')} /> : <>
        <div className="detail-list"><div><span>已验证快照</span><strong>{status.snapshots.count ?? snapshots.length}</strong></div><div><span>存储大小</span><strong>{bytesLabel(status.snapshots.totalBytes ?? snapshots.reduce((total, item) => total + item.bytes, 0))}</strong></div></div>
        <div className="button-row"><ActionButton disabled={pendingAction !== null || status.snapshots.busy || refreshing} loading={refreshing} onClick={() => setRefreshVersion(value => value + 1)}>刷新已验证列表</ActionButton></div>
        {error ? <p className="feedback" role="alert">{error}</p> : null}
        {snapshots.length === 0 ? <p className="muted">尚未发布已验证的快照。</p> : <div className="snapshot-list">{snapshots.map(snapshot => <div className="plugin-row" key={snapshot.snapshotId}><div><strong>{snapshot.snapshotId}</strong><p className="muted">{stateLabel(snapshot.kind)} · {snapshot.count} 个文件 · {bytesLabel(snapshot.bytes)} · {new Date(snapshot.createdAt).toLocaleString('zh-CN')}</p></div><ActionButton disabled={pendingAction !== null || status.snapshots.busy} loading={pendingAction === 'restore-snapshot'} onClick={() => onRestore(snapshot.snapshotId)}>恢复此快照</ActionButton></div>)}</div>}
      </>}
    </Panel>
    <div className="content-grid content-grid--wide"><Panel eyebrow="验证保证" title="每个快照提供的证明"><ul className="check-list"><li>记录文件数量与字节数。</li><li>发布前验证哈希清单。</li><li>恢复失败时保留原始内容和救援产物。</li></ul></Panel><Panel eyebrow="安全边界" title="不会自动清理"><p className="panel-copy">快照绝不会被静默删除。清理仍是发布切换之外的一项独立且需明确执行的操作。</p></Panel></div>
  </div>
}
