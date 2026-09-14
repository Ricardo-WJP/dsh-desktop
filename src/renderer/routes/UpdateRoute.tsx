import { useEffect, useRef } from 'react'
import type { DesktopInstallerUpdate, DesktopStatus } from '../global'
import { ActionButton, Panel, StatusPill, Unavailable } from '../components/Primitives'
import { channelName, sourceName, stateLabel, userFacingDetail } from '../localization'

function installerState(update: DesktopInstallerUpdate) {
  return stateLabel(update.available ? update.state : 'unavailable')
}

function installerSupport(update: DesktopInstallerUpdate) {
  if (!update.available) return '桌面安装程序服务不可用'
  if (!update.releaseSourceConfigured) return '仅使用安装包内置版本号'
  if (update.supported) return '支持下载安装程序'
  return update.externalReleaseAvailable
    ? '不支持内置安装 · 可转到 GitHub Releases'
    : '不支持桌面安装程序'
}

function installerActionLabel(update: DesktopInstallerUpdate) {
  if (update.busy) return '桌面安装程序操作进行中…'
  if (!update.available) return '桌面安装程序更新不可用'
  if (!update.releaseSourceConfigured) return '仅显示本地版本'
  if (update.externalReleaseAvailable) return '查看最新桌面版发布'
  if (!update.supported) return '不支持桌面安装程序'
  if (update.downloaded) return '打开已下载的安装程序'
  return '检查桌面版更新'
}

export default function UpdateRoute({
  status,
  onDesktopCheck,
  onCheckDsh,
  onRestore,
  onPrepare,
  onSwitch,
  pendingAction = null,
}: {
  status: DesktopStatus
  onDesktopCheck: () => void
  onCheckDsh: () => void
  onRestore: () => void
  onPrepare: (channel: 'stable' | 'next') => void
  onSwitch: (candidateId: string) => void
  pendingAction?: string | null
}) {
  const runtime = status.update
  const installer = status.desktopUpdate
  const candidate = status.candidate
  const managed = runtime.managedRestoreAvailable
  const updateAvailable = runtime.updateAvailable === true
  const runtimeState = runtime.available ? runtime.state : 'unavailable'
  const runtimeVersion = runtime.currentVersion ?? status.runtime?.version
  const runtimeSource = sourceName(status.runtime?.source)
  const runtimeRestoreEnabled = runtime.available && managed && runtime.restoreAvailable && !runtime.busy
  const installerActionEnabled = installer.available
    && installer.checkAvailable
    && !installer.busy
    && (installer.supported || installer.externalReleaseAvailable)
  const runtimeRestoreLabel = runtime.busy
    || pendingAction === 'restore-runtime'
    ? 'DSH 运行时操作进行中…'
    : !runtime.available
      ? 'DSH 运行时恢复不可用'
      : !managed
        ? '没有可恢复的托管运行时'
        : runtimeRestoreEnabled
          ? '恢复内置运行时'
              : 'DSH 运行时恢复不可用'
  const autoProbeRef = useRef<{ version: string | null; attempted: boolean } | null>(null)
  useEffect(() => {
    const probeVersion = runtime.currentVersion ?? status.runtime?.version ?? null
    let probeState = autoProbeRef.current
    if (probeState === null) {
      probeState = { version: probeVersion, attempted: false }
      autoProbeRef.current = probeState
    } else if (probeState.version !== probeVersion && !probeState.attempted) {
      probeState.version = probeVersion
    } else if (probeState.version !== probeVersion && probeState.attempted && pendingAction === null && !runtime.busy) {
      probeState = { version: probeVersion, attempted: false }
      autoProbeRef.current = probeState
    }
    if (runtime.available && runtime.checkAvailable && !runtime.busy && runtime.latestVersion === null && pendingAction === null && !probeState.attempted) {
      probeState.attempted = true
      onCheckDsh()
    }
  }, [runtime.available, runtime.checkAvailable, runtime.busy, runtime.currentVersion, runtime.latestVersion, status.runtime?.version, onCheckDsh, pendingAction])
  return (
    <div className="route">
      <div className="page-heading"><div><p className="eyebrow">发布管理</p><h1>更新运行时与桌面安装程序</h1><p className="lede">分别检查桌面版与 DSH 运行时；切换候选版本前会显示真实状态。</p></div></div>
      {candidate.previousReleaseId ? <Panel title="回退程序版本">
        <p className="panel-copy">切换到上一份程序，保留当前用户数据。恢复历史数据请前往“恢复”页面。</p>
        <ActionButton disabled={pendingAction !== null || candidate.busy || !candidate.codeRollbackAvailable} loading={pendingAction === 'switch-candidate'} onClick={() => {
          if (candidate.previousReleaseId && window.confirm('回退到上一份程序版本？当前会话、记忆和设置不会恢复到历史快照，但服务需要重启。')) onSwitch(candidate.previousReleaseId)
        }}>{pendingAction === 'switch-candidate' ? '正在回退程序…' : '回退程序，保留数据'}</ActionButton>
      </Panel> : null}
      <div className="content-grid content-grid--wide">
        <Panel eyebrow="DeepSeek Harness Desktop 安装程序" title={installer.currentVersion ? `桌面版 ${installer.currentVersion}` : '桌面版版本待确认'} action={<StatusPill tone={installer.busy ? 'warning' : installer.available && installer.supported ? 'positive' : installer.available && installer.externalReleaseAvailable ? 'warning' : 'neutral'}>{installerState(installer)}</StatusPill>}>
          <p className="panel-copy">{installer.releaseSourceConfigured ? '桌面端只会与明确配置的第一方发行源比较，并在校验通过后提供安装包。' : '桌面端只认当前安装包内置的产品版本号，不会把 DSH 运行时或其他项目的版本当成桌面端版本。需要联网更新时，再明确配置我们自己的发行源。'}</p>
          <div className="detail-list">
            <div><span>当前版本</span><strong>{installer.currentVersion ?? '未上报'}</strong></div>
            <div><span>版本权威</span><strong>{installer.releaseSourceConfigured ? '第一方发行源' : '当前安装包构建号'}</strong></div>
            <div><span>支持情况</span><strong>{installerSupport(installer)}</strong></div>
            <div><span>状态</span><strong>{installerState(installer)}</strong></div>
            <div><span>进度</span><strong>{Math.round(installer.progress)}%</strong></div>
            <div><span>目标版本</span><strong>{installer.targetVersion ? `v${installer.targetVersion}` : '未上报'}</strong></div>
            <div><span>下载情况</span><strong>{installer.downloaded ? '可用' : '未下载'}</strong></div>
          </div>
          <div className="button-row"><ActionButton variant="primary" onClick={onDesktopCheck} disabled={pendingAction !== null || !installerActionEnabled} loading={pendingAction === 'check-desktop-update'}>{installerActionLabel(installer)}</ActionButton></div>
        </Panel>
        <Panel eyebrow="DSH 运行时" title={updateAvailable && runtime.latestVersion ? `发现更新 · ${runtime.latestVersion}` : runtimeVersion ? `${runtimeVersion} · ${runtimeSource}` : '运行时不可用'} action={<StatusPill tone={updateAvailable ? 'accent' : runtime.busy ? 'warning' : runtime.available ? 'positive' : 'neutral'}>{updateAvailable ? '有可用更新' : stateLabel(runtimeState)}</StatusPill>}>
          <p className="panel-copy">{updateAvailable && runtime.latestVersion ? `已检测到 DSH ${runtime.latestVersion}。先准备经过验证的候选版本，再由你明确确认切换。` : '新版 DSH 会在下方准备为配对且经过验证的候选版本；此区域仅保留安全的内置运行时恢复路径。'}</p>
          <div className="detail-list">
            <div><span>当前版本</span><strong>{runtimeVersion ?? '未上报'}</strong></div>
            <div><span>最新版本</span><strong>{runtime.latestVersion ?? '尚未检查'}</strong></div>
            <div><span>来源</span><strong>{runtimeSource}</strong></div>
            <div><span>状态</span><strong>{stateLabel(runtimeState)}</strong></div>
            <div><span>托管恢复</span><strong>{managed ? '空闲时可用' : '不可用'}</strong></div>
          </div>
          <div className="button-row"><ActionButton variant={updateAvailable ? 'primary' : 'secondary'} disabled={pendingAction !== null || !runtime.checkAvailable || runtime.busy} loading={pendingAction === 'probe-dsh'} onClick={onCheckDsh}>{pendingAction === 'probe-dsh' || runtime.busy ? '正在检测最新版本…' : '检测最新版本'}</ActionButton><ActionButton disabled={pendingAction !== null || !runtimeRestoreEnabled} loading={pendingAction === 'restore-runtime'} onClick={onRestore}>{runtimeRestoreLabel}</ActionButton></div>
        </Panel>
        <Panel eyebrow="候选版本" title="配对运行时 + profile" action={<StatusPill tone={candidate.busy ? 'warning' : candidate.state === 'ready' ? 'positive' : 'neutral'}>{stateLabel(candidate.state)}</StatusPill>}>
          {!candidate.available ? <Unavailable title="候选版本准备功能暂不可用" detail={userFacingDetail(candidate.reason, '稳定版与下一版槽位需要配对且不可变的发布元数据。')} /> : <>
            <p className="panel-copy">准备操作会下载精确版本的 DSH 运行时并构建匹配的不可变物理 profile，不会重启或更改当前活动版本。切换仍是一项独立且需明确触发的操作。</p>
            <div className="detail-list">
              <div><span>通道</span><strong>{candidate.channel ? channelName(candidate.channel) : '尚未准备'}</strong></div>
              <div><span>版本</span><strong>{candidate.version ?? '尚未解析'}</strong></div>
              <div><span>物理 Profile</span><strong>{candidate.physicalProfileName ?? '尚未构建'}</strong></div>
              <div><span>候选版本 ID</span><strong>{candidate.id ?? '无'}</strong></div>
            </div>
            <div className="button-row">
              <ActionButton variant="primary" disabled={pendingAction !== null || candidate.busy || !candidate.prepareAvailable} loading={pendingAction === 'prepare-stable'} onClick={() => onPrepare('stable')}>{candidate.busy || pendingAction === 'prepare-stable' ? '正在准备候选版本…' : '准备稳定版候选版本'}</ActionButton>
              <ActionButton disabled={pendingAction !== null || candidate.busy || !candidate.prepareAvailable} loading={pendingAction === 'prepare-next'} onClick={() => onPrepare('next')}>准备下一版候选版本</ActionButton>
              <ActionButton disabled={pendingAction !== null || candidate.busy || !candidate.switchAvailable || !candidate.id} loading={pendingAction === 'switch-candidate'} onClick={() => candidate.id && onSwitch(candidate.id)}>切换到已验证候选版本</ActionButton>
            </div>
          </>}
        </Panel>
      </div>
    </div>
  )
}
