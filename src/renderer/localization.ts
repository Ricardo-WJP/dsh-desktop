const stateLabels: Record<string, string> = {
  active: '当前使用',
  available: '可用',
  booting: '正在启动',
  checking: '正在检查',
  connected: '已连接',
  creating: '正在创建',
  degraded: '部分可用',
  downloaded: '已下载',
  downloading: '正在下载',
  error: '错误',
  failed: '失败',
  idle: '空闲',
  'local-only': '仅本地版本',
  'not connected': '未连接',
  pending: '等待中',
  planned: '待启用',
  prepared: '已准备',
  preparing: '正在准备',
  preview: '预览',
  ready: '就绪',
  restoring: '正在恢复',
  running: '运行中',
  starting: '正在启动',
  stopped: '已停止',
  switching: '正在切换',
  unavailable: '不可用',
  unsupported: '不受支持',
}

export function stateLabel(value: string | null | undefined, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback
  return stateLabels[value.toLowerCase()] ?? (/[㐀-鿿]/.test(value) ? value : '未知状态')
}

export function modeName(value: string) {
  if (value === 'legacy') return '兼容模式'
  if (value === 'stable') return '稳定模式'
  if (value === 'dev') return '开发模式'
  return /[㐀-鿿]/.test(value) ? value : '未知模式'
}

export function channelName(value: string) {
  if (value === 'stable') return '稳定通道'
  if (value === 'next') return '预览通道'
  if (value === 'local') return '本地通道'
  return /[㐀-鿿]/.test(value) ? value : '未知通道'
}

export function sourceName(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return '不可用'
  if (value === 'bundled') return '内置运行时'
  if (value === 'managed') return '托管运行时'
  if (value === 'bootstrap') return '引导运行时'
  return /[㐀-鿿]/.test(value) ? value : '未知来源'
}

export function pluginActionName(value: string) {
  const labels: Record<string, string> = {
    configure: '配置修改',
    install: '安装',
    promoteLocal: '本地开发版本固化',
    remove: '移除',
    reorder: '顺序调整',
    replaceSource: '来源替换',
    setEnabled: '启用状态修改',
    update: '更新',
  }
  return labels[value] ?? (/[㐀-鿿]/.test(value) ? value : '未知操作')
}

const detailLabels: Record<string, string> = {
  'Candidate preparation paths are unavailable.': '候选版本准备路径不可用。',
  'Candidate preparation was cancelled.': '候选版本准备已取消。',
  'Transactions are owned by the configured candidate transaction service.': '候选版本事务由已配置的事务服务统一管理。',
  'Plugin transaction owner is unavailable.': '插件事务服务不可用。',
  'No active immutable candidate release is available.': '当前没有可用的活动不可变候选版本。',
  'Candidate transactions remain disabled until the full Task 11 compatibility gate is connected.': '完整兼容性门禁接入前，候选版本事务保持禁用。',
  'Paired candidate release operations land after Task 3.': '配对候选版本服务尚未接入。',
  'Snapshot and recovery operations land after Task 3.': '快照与恢复服务尚未接入。',
}

export function userFacingDetail(value: string | null | undefined, fallback = '详细技术原因已记录到日志。') {
  if (value === null || value === undefined || value.trim() === '') return fallback
  if (/[㐀-鿿]/.test(value)) return value
  return detailLabels[value.trim()] ?? fallback
}
