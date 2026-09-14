import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  mergeOnboardingRecommendations,
  markOnboardingCompleted,
  onboardingCompleted,
  onboardingInstallSources,
  onboardingMarkerPath,
  readOnboardingRecommendations,
} from '../src/onboarding.js'
import { DESKTOP_PLUGIN_SUITE, pluginSuiteInstallSources, pluginSuitePackageNames } from '../src/plugin-suite.js'

test('first-run recommendations are a curated optional subset', () => {
  const recommendations = readOnboardingRecommendations({ tier: 'base' })
  assert.deepEqual(recommendations.map(entry => entry.packageName), [
    'dshmarket',
    'dsh-better-sidebar',
    'dsh-notification',
  ])
  assert.equal(recommendations.length >= 3 && recommendations.length <= 5, true)
  assert.equal(recommendations.every(entry => entry.preselected !== true), true)
  assert.equal(recommendations.some(entry => entry.packageName === 'dsh-at-file'), false)
  assert.equal(recommendations.some(entry => entry.packageName === 'dsh-context'), false)
  assert.equal(recommendations.some(entry => entry.packageName === 'dsh-cost-meter'), false)
  assert.equal(recommendations.some(entry => entry.packageName === 'dsh-mnemon'), false)
  assert.equal(recommendations.some(entry => entry.packageName === 'dsh-reasoning-effort'), false)
  assert.equal(recommendations.some(entry => /aegis/i.test(`${entry.name} ${entry.spec}`)), false)
  const selected = onboardingInstallSources([recommendations[0].id, recommendations[2].id])
  assert.deepEqual(selected.map(entry => entry.packageName), ['dshmarket', 'dsh-notification'])
  assert.deepEqual(selected.map(entry => entry.source.type), ['npm', 'github'])
  assert.deepEqual(selected[1].source, { type: 'github', repository: 'omdsh-dev/dsh-notification', ref: '675aab9b43d5011738feb6185281596c0365ccba' })
  assert.throws(() => onboardingInstallSources(['npm:dsh-context']), /Unknown onboarding plugin/)
})

test('recommendations detect installed packages without exposing profile paths', () => {
  const recommendations = readOnboardingRecommendations()
  const merged = mergeOnboardingRecommendations(recommendations, {
    plugins: [
      { name: 'dshmarket', requested: 'dshmarket', version: '1.0.0', enabled: true, profileDir: 'C:\\private' },
      { name: 'dsh-notification', requested: 'github:omdsh-dev/dsh-notification#v0.1.4', version: '0.1.4', enabled: false },
      { name: 'unrelated-plugin', version: '9.0.0', enabled: true },
    ],
  })
  assert.deepEqual(merged.filter(entry => entry.installed).map(entry => entry.packageName), [
    'dshmarket',
    'dsh-notification',
  ])
  assert.equal(merged.find(entry => entry.packageName === 'dshmarket').installedVersion, '1.0.0')
  assert.equal(merged.find(entry => entry.packageName === 'dsh-notification').installedVersion, '0.1.4')
  assert.equal(merged.find(entry => entry.packageName === 'dsh-notification').installedEnabled, false)
  assert.equal(merged.find(entry => entry.packageName === 'dsh-better-sidebar').installed, false)
  assert.equal(Object.hasOwn(merged[0], 'profileDir'), false)
})

test('installed identity aliases keep the installed marker for package and source-shaped catalogs', () => {
  const recommendations = readOnboardingRecommendations({ tier: 'base' })
  const merged = mergeOnboardingRecommendations(recommendations, [
    { source: { package: 'dshmarket' }, version: '1.2.3', enabled: true },
    { specifier: 'github:omdsh-dev/dsh-notification#675aab9b43d5011738feb6185281596c0365ccba', version: '0.1.4', enabled: false },
  ])
  assert.deepEqual(merged.filter(entry => entry.installed).map(entry => entry.packageName), [
    'dshmarket',
    'dsh-notification',
  ])
})

test('published Signal is remotely installable in both standard and suite recommendations', () => {
  const standard = readOnboardingRecommendations()
  assert.equal(standard.length, 27)
  assert.equal(standard.some(entry => entry.packageName === 'dsh-signal'), true)
  assert.deepEqual(
    new Set(standard.map(entry => entry.packageName)),
    new Set(pluginSuitePackageNames()),
  )
  assert.equal(standard.filter(entry => entry.tier === 'base').length, 3)
  assert.equal(readOnboardingRecommendations({ tier: 'base' }).length, 3)
  const standardSelected = onboardingInstallSources(standard.map(entry => entry.id), { repositoryRoot: '/workspace' })
  assert.equal(standardSelected.length, 27)
  assert.equal(standardSelected.some(entry => entry.source.type === 'local-dev'), false)
  assert.equal(standardSelected.find(entry => entry.packageName === 'dsh-prompt-polish').source.ref, '6738824af10e145a471dd6620a884f5e3ab9fd77')
  assert.equal(onboardingInstallSources(['suite:dsh-signal'], { repositoryRoot: '/workspace' })[0].source.type, 'npm')

  const recommendations = readOnboardingRecommendations({ suite: true })
  assert.equal(recommendations.length, 27)
  assert.equal(recommendations.some(entry => entry.packageName === 'dsh-signal'), true)
  const selected = onboardingInstallSources(recommendations.map(entry => entry.id), {
    suite: true,
    repositoryRoot: '/workspace',
  })
  assert.equal(selected.length, 27)
  assert.equal(selected.find(entry => entry.packageName === 'dsh-notification').source.ref, '675aab9b43d5011738feb6185281596c0365ccba')
  assert.throws(() => onboardingInstallSources(['suite:not-a-real-plugin'], { suite: true, repositoryRoot: '/workspace' }), /Unknown onboarding plugin/)
  assert.equal(pluginSuitePackageNames().length, 27)
  const full = pluginSuiteInstallSources(DESKTOP_PLUGIN_SUITE.map(entry => entry.id), { repositoryRoot: '/workspace' })
  assert.equal(full.length, 27)
  assert.equal(full.find(entry => entry.packageName === 'dsh-prompt-polish').source.ref, '6738824af10e145a471dd6620a884f5e3ab9fd77')
  assert.equal(full.find(entry => entry.packageName === 'dsh-stt-input').source.ref, '2f751d5ea14a6bfa9513d4439a45880f4b7a97de')
  assert.deepEqual(full.find(entry => entry.packageName === 'dsh-signal').source, { type: 'npm', package: 'dsh-signal', versionOrTag: '0.6.12' })
})

test('recommendation surface keeps the viewport clean and cards keyboard-clickable', () => {
  const page = readFileSync(new URL('../src/pages/plugins-onboarding.html', import.meta.url), 'utf8')
  assert.match(page, /overflow: hidden/)
  assert.match(page, /scrollbar-width: none/)
  assert.match(page, /grid-template-columns: minmax\(0, 1fr\) max-content/)
  assert.match(page, /min-width: max-content/)
  assert.match(page, /white-space: nowrap/)
  assert.match(page, /role="progressbar"/)
  assert.match(page, /\.progress-region\[hidden\]/)
  assert.match(page, /status\.hidden = progressVisible/)
  assert.match(page, /--button-surface/)
  assert.doesNotMatch(page, /window-bar|data-window-action/)
  assert.match(page, /\.drag-strip[^}]*-webkit-app-region: drag/)
  assert.match(page, /<div class="drag-strip" aria-hidden="true"><\/div>/)
  assert.match(page, /\.shell[\s\S]*flex: 1 1 auto[\s\S]*height: auto[\s\S]*min-height: 0/)
  assert.match(page, /data-theme="light"|data-theme/)
  assert.match(page, /--card-hover-surface/)
  assert.match(page, /min-height: 104px/)
  assert.match(page, /body[\s\S]*background: var\(--bg\)/)
  assert.match(page, /justify-content: center/)
  assert.match(page, /@media \(max-height: 760px\)/)
  assert.doesNotMatch(page, /setPointerCapture|pointermove|screenX|screenY/)
  assert.match(page, /progress\?\.subscribe/)
  assert.match(page, /activeTransactionId/)
  assert.match(page, /value\.transactionId !== activeTransactionId/)
  assert.match(page, /bridge\.install\(\{ selectedIds: selected, transactionId: activeTransactionId \}\)/)
  assert.match(page, /\.card:focus-visible/)
  assert.match(page, /\.card:focus-within/)
  assert.doesNotMatch(page, /toggleFromPointer/)
  assert.doesNotMatch(page, /label\.addEventListener\('pointerdown'/)
  assert.doesNotMatch(page, /label\.addEventListener\('click'/)
  assert.doesNotMatch(page, /label\.addEventListener\('keydown'/)
  assert.match(page, /input\.tabIndex = 0/)
  assert.match(page, /input\.checked = selected\.has\(entry\.id\)/)
  assert.match(page, /基础（3）/)
  assert.match(page, /完整套件/)
  assert.match(page, /data-tier="base"/)
  assert.match(page, /data-tier="full"/)
  assert.match(page, /allEntries.filter/)
  assert.match(page, /normalizeRecommendations/)
  assert.match(page, /basePackageNames/)
  assert.match(page, /当前没有可安装的推荐插件/)
  assert.match(page, /role="status" aria-live="polite"/)
  assert.match(page, /pageSize = 6/)
  assert.match(page, /result\.autoConfigure === true/)
  assert.match(page, /result\.flavor === 'suite'/)
  assert.match(page, /result\.level === 'full'/)
  assert.match(page, /autoConfigureTriggered \|\| busy \|\| selectedIds\(\)\.length === 0/)
  assert.match(page, /if \(autoConfigure\) triggerAutoConfigure\(\)/)
  assert.match(page, /首次联网自动配置/)
  assert.match(page, /手动重试安装/)
})

test('onboarding marker is atomic and only completed after explicit finish', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-onboarding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marker = onboardingMarkerPath(root)
  assert.equal(onboardingCompleted(marker), false)
  markOnboardingCompleted(marker, '2026-08-23T00:00:00.000Z')
  assert.equal(onboardingCompleted(marker), true)
  const before = readFileSync(marker, 'utf8')
  const recommendations = readOnboardingRecommendations()
  onboardingInstallSources([recommendations[0].id])
  assert.equal(onboardingCompleted(marker), true)
  assert.equal(readFileSync(marker, 'utf8'), before)
})
