import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePluginCatalog, readBundledPluginCatalog, readExtraPluginEntries } from './plugin-catalog.js'
import { DESKTOP_PLUGIN_SUITE, pluginSuiteInstallSources, pluginSuiteRecommendations } from './plugin-suite.js'

export const ONBOARDING_CHANNELS = Object.freeze({
  recommendations: 'dsh-desktop:onboarding-recommendations',
  install: 'dsh-desktop:onboarding-install',
  progress: 'dsh-desktop:onboarding-progress',
  skip: 'dsh-desktop:onboarding-skip',
  window: Object.freeze({
    minimize: 'dsh-desktop:onboarding-window-minimize',
    toggleMaximize: 'dsh-desktop:onboarding-window-toggle-maximize',
    close: 'dsh-desktop:onboarding-window-close',
  }),
})

// This first-run set covers discovery, navigation and completion feedback
// without duplicating DSH's native context/model controls or bundling another
// full chat renderer. Every item remains optional and installs only after the
// user explicitly selects it.
const RECOMMENDED_PLUGIN_SPECS = Object.freeze([
  'dshmarket',
  'dsh-better-sidebar',
  'github:omdsh-dev/dsh-notification',
])

export const ONBOARDING_MARKER_VERSION = 1

function onboardingSource(entry) {
  const suiteEntry = DESKTOP_PLUGIN_SUITE.find(value => value.packageName === entry.packageName)
  if (suiteEntry !== undefined) return { ...suiteEntry.source }
  if (entry?.source === 'npm') {
    return { type: 'npm', package: entry.npm ?? entry.spec }
  }
  return {
    type: 'github',
    repository: entry.repository,
    ...(entry.path === undefined ? {} : { path: entry.path }),
  }
}

function recommendationId(entry) {
  return entry.source === 'npm' ? `npm:${entry.npm ?? entry.spec}` : `github:${entry.repository}${entry.path ?? ''}`
}

function packageNameForEntry(entry) {
  if (entry.source === 'npm') return entry.npm ?? entry.spec
  // The repository owner and npm package scope are independent identities.
  // Keep this aligned with the package.json at the pinned GitHub commit; the
  // transaction gate verifies the identity again before any install runs.
  if (entry.repository === 'omdsh-dev/dsh-genui') return '@changfenhuang/dsh-genui'
  return entry.repository.split('/')[1]
}

function readDefaultOnboardingCatalog() {
  const bundled = readBundledPluginCatalog()
  return normalizePluginCatalog({ ...bundled, plugins: [...bundled.plugins, ...readExtraPluginEntries()] })
}

export function readOnboardingRecommendations({ catalog = readDefaultOnboardingCatalog(), suite = false, tier = 'full' } = {}) {
  if (tier !== 'base' && tier !== 'full') throw new TypeError('Unknown onboarding recommendation tier')
  const bySpec = new Map((catalog.plugins ?? []).map(entry => [entry.spec, entry]))
  const baseRecommendations = RECOMMENDED_PLUGIN_SPECS.flatMap(spec => {
    const entry = bySpec.get(spec)
    if (entry === undefined) return []
    return [{
      id: recommendationId(entry),
      name: entry.name,
      owner: entry.owner,
      packageName: packageNameForEntry(entry),
      category: entry.category,
      description: entry.description,
      stars: entry.stars ?? null,
      source: entry.source,
      spec: entry.spec,
      repository: entry.repository,
      ...(entry.path === undefined ? {} : { path: entry.path }),
      page: entry.page ?? entry.url,
      tier: 'base',
    }]
  })
  const baseByPackage = new Map(baseRecommendations.map(entry => [entry.packageName, entry]))
  const suiteRecommendations = pluginSuiteRecommendations({ catalog })
    .filter(entry => suite || entry.source !== 'local-dev')
  const fullRecommendations = suite
    ? suiteRecommendations.map(entry => ({ ...entry, tier: baseByPackage.has(entry.packageName) ? 'base' : 'full' }))
    : [
        ...baseRecommendations,
        ...suiteRecommendations
          .filter(entry => !baseByPackage.has(entry.packageName))
          .map(entry => ({ ...entry, tier: 'full' })),
      ]
  return Object.freeze((tier === 'base' ? fullRecommendations.filter(entry => entry.tier === 'base') : fullRecommendations))
}

function normalizedPluginIdentity(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : undefined
}

function pluginIdentityAliases(value) {
  const normalized = normalizedPluginIdentity(value)
  if (normalized === undefined) return []
  const aliases = [normalized]
  if (normalized.startsWith('github:')) {
    const repository = normalized.slice('github:'.length).split('#', 1)[0]
    if (repository !== '') aliases.push(repository)
  }
  return aliases
}

function pluginIdentities(values) {
  return [...new Set(values.flatMap(pluginIdentityAliases))]
}

function installedPluginEntries(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.plugins)) return value.plugins
  return []
}

function recommendationIdentities(entry) {
  return pluginIdentities([entry.packageName, entry.name, entry.spec, entry.repository])
}

function installedIdentities(entry) {
  return pluginIdentities([
    entry?.name,
    entry?.npm,
    entry?.packageName,
    entry?.requested,
    entry?.specifier,
    entry?.source?.package,
    entry?.source?.repository,
  ])
}

/**
 * Joins the read-only native DSH plugin catalog to the curated first-run list.
 * The result contains only display-safe status fields; paths and requests are
 * intentionally not copied into the splash renderer.
 */
export function mergeOnboardingRecommendations(recommendations, installedCatalog) {
  if (!Array.isArray(recommendations)) throw new TypeError('Onboarding recommendations must be an array')
  const installedByIdentity = new Map()
  for (const plugin of installedPluginEntries(installedCatalog)) {
    for (const identity of installedIdentities(plugin)) {
      if (!installedByIdentity.has(identity)) installedByIdentity.set(identity, plugin)
    }
  }
  return Object.freeze(recommendations.map(entry => {
    const installed = recommendationIdentities(entry)
      .map(identity => installedByIdentity.get(identity))
      .find(value => value !== undefined)
    return {
      ...entry,
      installed: installed !== undefined,
      installedVersion: typeof installed?.version === 'string' ? installed.version : null,
      installedEnabled: installed === undefined || typeof installed.enabled !== 'boolean' ? null : installed.enabled,
    }
  }))
}

export function onboardingInstallSources(selectedIds, {
  catalog = readDefaultOnboardingCatalog(),
  suite = false,
  tier = 'full',
  repositoryRoot,
} = {}) {
  if (!Array.isArray(selectedIds)) throw new TypeError('Selected onboarding plugins must be an array')
  const recommendations = readOnboardingRecommendations({ catalog, suite, tier })
  const byId = new Map(recommendations.map(entry => [entry.id, entry]))
  const ids = [...new Set(selectedIds)]
  const selected = ids.map(id => {
    if (typeof id !== 'string' || !byId.has(id)) throw new TypeError('Unknown onboarding plugin')
    return byId.get(id)
  })
  if (suite) return pluginSuiteInstallSources(ids, { repositoryRoot })
  return selected.map(entry => ({
    id: entry.id,
    name: entry.packageName,
    packageName: entry.packageName,
    source: onboardingSource(entry),
    // Curated entries are still installed into a verified candidate. Build
    // scripts are allowed only for the packages the user explicitly chose.
    buildAllowed: true,
  }))
}

export function onboardingMarkerPath(userData) {
  if (typeof userData !== 'string' || userData.trim() === '') throw new TypeError('Invalid onboarding user-data path')
  return join(userData, 'onboarding.json')
}

export function onboardingCompleted(path) {
  if (typeof path !== 'string' || path.trim() === '') return false
  try {
    if (!existsSync(path)) return false
    const state = JSON.parse(readFileSync(path, 'utf8'))
    return state?.version === ONBOARDING_MARKER_VERSION && state?.completed === true
  } catch {
    return false
  }
}

export function markOnboardingCompleted(path, now = new Date().toISOString()) {
  if (typeof path !== 'string' || path.trim() === '') throw new TypeError('Invalid onboarding marker path')
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify({ version: ONBOARDING_MARKER_VERSION, completed: true, completedAt: now }, null, 2), 'utf8')
  // Rename is intentionally kept in the caller's process so a half-written
  // marker can never make a failed install look completed.
  renameSync(temporary, path)
  return true
}
