import type { DesktopStatus } from '../global'
import { ActionButton, Panel, StatusPill, Unavailable } from '../components/Primitives'
import { modeName, stateLabel } from '../localization'

function modeState(status: string, active: boolean) {
  if (active) return '当前使用'
  return stateLabel(status)
}

export default function ModeRoute({ status, onSelect, pendingAction = null }: { status: DesktopStatus; onSelect: (mode: 'stable' | 'dev') => void; pendingAction?: string | null }) {
  const effectiveActive = status.mode.active
  const legacyActive = effectiveActive === 'legacy'
  const stableActive = effectiveActive === 'stable'
  const devActive = effectiveActive === 'dev'
  const slotEyebrow = status.mode.active === 'legacy' ? '计划槽位' : '运行模式'
  const actionLabel = (mode: 'stable' | 'dev', active: boolean) => active ? '当前模式' : status.mode.switchAvailable ? `使用${mode === 'stable' ? '稳定' : '开发'}模式` : '当前未配置可切换模式'
  return (
    <div className="route">
      <div className="page-heading"><div><p className="eyebrow">运行模式</p><h1>运行模式</h1><p className="lede">仅在桌面服务确认槽位可用时切换稳定或开发模式。</p></div></div>
      <div className="content-grid content-grid--wide">
        {legacyActive ? <Panel className="panel--selected" eyebrow="当前服务" title="旧版 / 引导兼容模式" action={<StatusPill tone="warning">当前使用</StatusPill>}>
          <p className="panel-copy">现有桌面启动器和 profile 仍由兼容路径负责。这个状态是有意保留的，不代表稳定或开发槽位已经完成配对。</p>
          <ActionButton disabled>当前兼容路径</ActionButton>
        </Panel> : null}
        <Panel className={stableActive ? 'panel--selected' : ''} eyebrow={slotEyebrow} title="稳定模式" action={<StatusPill tone={stableActive ? 'positive' : 'neutral'}>{modeState(status.mode.stable.state, stableActive)}</StatusPill>}>
          <p className="panel-copy">不可变运行时槽位与独立物理 profile 成对使用，不启用源码监听，也不写入可变 profile。</p>
          <ActionButton disabled={pendingAction !== null || !status.mode.switchAvailable || stableActive} loading={pendingAction === 'select-mode-stable'} onClick={() => onSelect('stable')}>{actionLabel('stable', stableActive)}</ActionButton>
        </Panel>
        <Panel className={devActive ? 'panel--selected' : ''} eyebrow={slotEyebrow} title="开发模式" action={<StatusPill tone={devActive ? 'accent' : 'neutral'}>{modeState(status.mode.dev.state, devActive)}</StatusPill>}>
          <p className="panel-copy">固定源码检出与独立 Client 监听器配合使用，桌面服务会分别报告 Host 与监听器的健康状态。</p>
          <ActionButton disabled={pendingAction !== null || !status.mode.switchAvailable || devActive} loading={pendingAction === 'select-mode-dev'} onClick={() => onSelect('dev')}>{actionLabel('dev', devActive)}</ActionButton>
        </Panel>
      </div>
      {!status.mode.switchAvailable ? <Unavailable title="当前未配置可切换模式" detail={`当前运行模式为${modeName(effectiveActive)}。桌面服务尚未提供可切换的模式开关。`} /> : null}
    </div>
  )
}
