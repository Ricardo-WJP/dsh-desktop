import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactName,
  createGitHubReleaseSource,
  createInstallerUpdateController,
} from '../src/auto-update.js'

const source = createGitHubReleaseSource('test-owner/dsh-desktop')

function release(version = '2.0.0', { flavor = 'standard', digest = `sha256:${'a'.repeat(64)}` } = {}) {
  const name = artifactName({ version, platform: 'linux', arch: 'x64', flavor })
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{
      name,
      state: 'uploaded',
      size: 1,
      digest,
      browser_download_url: `https://github.com/${source.repository}/releases/download/v${version}/${name}`,
    }],
  }
}

function setup(overrides = {}) {
  let fetchCount = 0
  const stateChanges = []
  const opened = []
  const suppliedFetch = overrides.fetchImpl
  const { fetchImpl: _ignoredFetch, ...controllerOverrides } = overrides
  const controller = createInstallerUpdateController({
    isPackaged: true,
    platform: 'linux',
    arch: 'x64',
    flavor: 'standard',
    currentVersion: '1.0.0',
    downloadsDirectory: '/Downloads',
    releaseSource: source,
    fetchImpl: async (...args) => {
      fetchCount += 1
      if (suppliedFetch !== undefined) return suppliedFetch(...args)
      return new Response(JSON.stringify(overrides.release ?? release()), { status: 200 })
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getWindow: () => undefined,
    openDownloadedFile: async path => { opened.push(path) },
    downloadImpl: overrides.downloadImpl ?? (async options => {
      options.onProgress(100)
      return '/Downloads/verified-installer'
    }),
    onStateChange: () => stateChanges.push(true),
    ...controllerOverrides,
  })
  return { controller, get fetchCount() { return fetchCount }, stateChanges, opened }
}

test('probe exposes current, available, error, and invalid-asset states without UI', async () => {
  const current = setup({ release: release('1.0.0') })
  assert.equal((await current.controller.probe()).state, 'current')
  assert.equal(current.controller.snapshot().hasUpdate, false)

  const available = setup()
  const availableSnapshot = await available.controller.probe()
  assert.equal(availableSnapshot.state, 'available')
  assert.equal(availableSnapshot.canUpdate, true)
  assert.equal(availableSnapshot.releaseNotesUrl, 'https://github.com/test-owner/dsh-desktop/releases/tag/v2.0.0')

  const invalid = setup({ release: release('2.0.0', { digest: 'sha256:bad' }) })
  const invalidSnapshot = await invalid.controller.probe()
  assert.equal(invalidSnapshot.hasUpdate, true)
  assert.equal(invalidSnapshot.canUpdate, false)
  assert.equal(invalidSnapshot.reason, 'installer-asset-invalid')
  assert.match(invalidSnapshot.error, /SHA-256/u)

  const failed = setup({ fetchImpl: async () => { throw new Error('offline') } })
  const failedSnapshot = await failed.controller.probe()
  assert.equal(failedSnapshot.state, 'error')
  assert.match(failedSnapshot.error, /offline/u)
})

test('Suite uses the exact Suite artifact while unknown flavor and dev builds remain probe-only', async () => {
  assert.equal(artifactName({ version: '2.0.0', platform: 'linux', arch: 'x64', flavor: 'suite' }), 'DSH-Desktop-Suite-v2.0.0-linux-x64.AppImage')
  const suite = setup({ flavor: 'suite', release: release('2.0.0', { flavor: 'suite' }) })
  const suiteSnapshot = await suite.controller.probe()
  assert.equal(suiteSnapshot.canUpdate, true)

  const unknown = setup({ flavor: undefined })
  const unknownSnapshot = await unknown.controller.probe()
  assert.equal(unknownSnapshot.hasUpdate, true)
  assert.equal(unknownSnapshot.canUpdate, false)
  assert.equal(unknownSnapshot.reason, 'unknown-flavor-cannot-update')

  const dev = setup({ isPackaged: false })
  const devSnapshot = await dev.controller.probe()
  assert.equal(devSnapshot.hasUpdate, true)
  assert.equal(devSnapshot.canUpdate, false)
  assert.equal(devSnapshot.reason, 'dev-build-cannot-update')
})

test('probe and execute deduplicate concurrent requests and execute does not open a dialog', async () => {
  let resolveFetch
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve })
  const setupResult = setup({ fetchImpl: async () => pendingFetch })
  const first = setupResult.controller.probe()
  const second = setupResult.controller.probe()
  resolveFetch(new Response(JSON.stringify(release()), { status: 200 }))
  await Promise.all([first, second])
  assert.equal(setupResult.fetchCount, 1)

  const execution = setupResult.controller.execute({ expectedVersion: '2.0.0' })
  const duplicate = setupResult.controller.execute({ expectedVersion: '2.0.0' })
  const snapshots = await Promise.all([execution, duplicate])
  assert.equal(snapshots[0].state, 'downloaded')
  assert.deepEqual(setupResult.opened, ['/Downloads/verified-installer'])
})

test('execute failure keeps the verified probe available for a later retry', async () => {
  let attempts = 0
  const setupResult = setup({
    downloadImpl: async () => {
      attempts += 1
      throw new Error('download failed')
    },
  })
  await setupResult.controller.probe()
  const failed = await setupResult.controller.execute({ expectedVersion: '2.0.0' })
  assert.equal(failed.state, 'error')
  assert.match(failed.error, /download failed/u)
  assert.equal(failed.hasUpdate, true)
  assert.equal(failed.canUpdate, false)
  assert.equal(attempts, 1)
})
