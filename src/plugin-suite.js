import { join, resolve } from 'node:path'
import { readSharePreset } from './share-preset.js'

export const DESKTOP_PLUGIN_SUITE_VERSION = 1

const sources = Object.freeze([
  ['@changfenhuang/dsh-genui', { type: 'npm', package: '@changfenhuang/dsh-genui' }],
  ['@linxin666/dsh-client-ui-task-board', { type: 'npm', package: '@linxin666/dsh-client-ui-task-board' }],
  ['@linxin666/dsh-doctor', { type: 'npm', package: '@linxin666/dsh-doctor' }],
  ['@linxin666/dsh-liangshen', { type: 'npm', package: '@linxin666/dsh-liangshen' }],
  ['@michengai/dsh-agency-agents', { type: 'npm', package: '@michengai/dsh-agency-agents' }],
  ['@michengai/dsh-archive-manager', { type: 'npm', package: '@michengai/dsh-archive-manager' }],
  ['@michengai/dsh-automation', { type: 'npm', package: '@michengai/dsh-automation' }],
  ['@michengai/dsh-codex-ui', { type: 'npm', package: '@michengai/dsh-codex-ui' }],
  ['@michengai/dsh-im-connect', { type: 'npm', package: '@michengai/dsh-im-connect' }],
  ['@michengai/dsh-skills-manager', { type: 'npm', package: '@michengai/dsh-skills-manager' }],
  ['better-dsh-pet', { type: 'npm', package: 'better-dsh-pet' }],
  ['dsh-at-file', { type: 'github', repository: 'omdsh-dev/dsh-at-file', ref: 'da602d1a8f1b417b8a1d8d4059e0f4cb1c353524' }],
  ['dsh-better-sidebar', { type: 'npm', package: 'dsh-better-sidebar' }],
  ['dsh-client-auto-continue', { type: 'npm', package: 'dsh-client-auto-continue' }],
  ['dsh-context', { type: 'npm', package: 'dsh-context' }],
  ['dsh-codex-connect', { type: 'npm', package: 'dsh-codex-connect' }],
  ['dsh-easyrewrite', { type: 'npm', package: 'dsh-easyrewrite' }],
  ['dsh-find-plugin', { type: 'npm', package: 'dsh-find-plugin' }],
  ['dsh-free-search', { type: 'npm', package: 'dsh-free-search' }],
  ['dsh-meme', { type: 'npm', package: 'dsh-meme' }],
  ['dsh-mnemon', { type: 'npm', package: 'dsh-mnemon' }],
  ['dsh-notification', { type: 'github', repository: 'omdsh-dev/dsh-notification', ref: '675aab9b43d5011738feb6185281596c0365ccba' }],
  ['dsh-prompt-polish', { type: 'github', repository: '1321928757/dsh-prompt-polish', ref: '6738824af10e145a471dd6620a884f5e3ab9fd77' }],
  ['dsh-reasoning-effort', { type: 'github', repository: 'HanaAyane/dsh-reasoning-effort', ref: '54c76c7e652b8f792f7c3f94d0a723d382e32db5' }],
  ['dsh-signal', { type: 'npm', package: 'dsh-signal', versionOrTag: '0.6.12' }],
  ['dsh-stt-input', { type: 'github', repository: 'baisama-cloud/dsh-stt-input', ref: '2f751d5ea14a6bfa9513d4439a45880f4b7a97de' }],
  ['dshmarket', { type: 'npm', package: 'dshmarket' }],
])

const fallback = Object.freeze({
  'dsh-signal': Object.freeze({
    name: 'DSH Signal',
    owner: 'DeepSeek Harness Desktop',
    category: 'observability',
    description: Object.freeze({
      zh: '点阵品牌区、多 Provider 资源、账户连接中心与本地 Token 用量。',
      en: 'Tidal branding, multi-provider resources, account connections, and local token usage.',
    }),
  }),
})

export const DESKTOP_PLUGIN_SUITE = Object.freeze(sources.map(([packageName, source]) => Object.freeze({
  id: `suite:${packageName}`,
  packageName,
  source: Object.freeze(source),
  buildAllowed: true,
})))

export const DESKTOP_PLUGIN_SUITE_BUILD_PERMISSIONS = Object.freeze({
  ...Object.fromEntries(DESKTOP_PLUGIN_SUITE.map(entry => [entry.packageName, true])),
  'node-pty': true,
  protobufjs: true,
})

function identity(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : undefined
}

function catalogEntryFor(source, packageName, catalog) {
  return (catalog?.plugins ?? []).find(entry => {
    if (source.type === 'npm') return identity(entry?.npm ?? entry?.spec) === identity(packageName)
    if (source.type === 'github') return identity(entry?.repository) === identity(source.repository)
    return false
  })
}

export function pluginSuiteRecommendations({ catalog } = {}) {
  return Object.freeze(DESKTOP_PLUGIN_SUITE.map(entry => {
    const catalogEntry = catalogEntryFor(entry.source, entry.packageName, catalog)
    const details = catalogEntry ?? fallback[entry.packageName] ?? {
      name: entry.packageName,
      owner: 'DSH community',
      category: 'plugin',
      description: { zh: entry.packageName, en: entry.packageName },
    }
    return {
      id: entry.id,
      name: details.name ?? details.displayName ?? entry.packageName,
      owner: details.owner ?? 'DSH community',
      packageName: entry.packageName,
      category: details.category ?? 'plugin',
      description: details.description ?? { zh: entry.packageName, en: entry.packageName },
      stars: details.stars ?? null,
      source: entry.source.type,
      spec: details.spec ?? entry.packageName,
      repository: entry.source.repository,
      page: details.page ?? details.url ?? (entry.source.repository ? `https://github.com/${entry.source.repository}` : undefined),
      suite: true,
      preselected: true,
    }
  }))
}

export function pluginSuiteInstallSources(selectedIds, { repositoryRoot } = {}) {
  if (!Array.isArray(selectedIds)) throw new TypeError('Selected plugin suite IDs must be an array')
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim() === '') throw new TypeError('Plugin suite repository root is required')
  const root = resolve(repositoryRoot)
  const preset = readSharePreset(root)
  const pins = new Map((preset?.plugins ?? []).map(item => [item.name, item.version]))
  const byId = new Map(DESKTOP_PLUGIN_SUITE.map(entry => [entry.id, entry]))
  return [...new Set(selectedIds)].map(id => {
    const entry = byId.get(id)
    if (entry === undefined) throw new TypeError('Unknown plugin suite entry')
    let source = entry.source.type === 'local-dev'
      ? { type: 'local-dev', path: join(root, entry.source.relativePath) }
      : { ...entry.source }
    const pin = pins.get(entry.packageName)
    if (pin && source.type === 'npm') source.versionOrTag = pin
    if (pin?.startsWith('github:') && source.type === 'github') {
      const [repository, ref] = pin.slice(7).split('#')
      source = { type: 'github', repository, ref }
    }
    return {
      id: entry.id,
      name: entry.packageName,
      packageName: entry.packageName,
      source,
      buildAllowed: entry.buildAllowed,
    }
  })
}

export function pluginSuitePackageNames() {
  return DESKTOP_PLUGIN_SUITE.map(entry => entry.packageName)
}
