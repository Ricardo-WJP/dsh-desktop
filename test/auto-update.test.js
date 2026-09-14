import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DIAGNOSTIC_LOG_ENTRY_MAX_CHARS, DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS } from '../src/diagnostics.js'
import {
  createGitHubReleaseSource,
  createInstallerUpdateController,
  downloadInstallerAsset,
  installerAssetName,
  parseLatestRelease,
  supportsInstallerDownloads,
} from '../src/auto-update.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const TEST_RELEASE_SOURCE = createGitHubReleaseSource('test-owner/dsh-desktop')

function releaseFixture(version = '1.0.0', overrides = {}) {
  const name = installerAssetName({ version, platform: 'linux', arch: 'x64' })
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{
      name,
      state: 'uploaded',
      size: 123,
      digest: DIGEST,
      browser_download_url: `${TEST_RELEASE_SOURCE.releasesUrl.replace('/latest', `/download/v${version}`)}/${name}`,
    }],
    ...overrides,
  }
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

function fixture(overrides = {}) {
  const messages = []
  const responses = [...(overrides.responses ?? [])]
  const openedReleases = []
  const openedFiles = []
  const downloads = []
  const progress = []
  const release = overrides.release ?? releaseFixture()
  const controller = createInstallerUpdateController({
    isPackaged: true,
    platform: 'linux',
    arch: 'x64',
    isChinese: false,
    currentVersion: '1.0.0',
    downloadsDirectory: '/Downloads',
    releaseSource: TEST_RELEASE_SOURCE,
    fetchImpl: overrides.fetchImpl ?? (async url => {
      assert.equal(url, TEST_RELEASE_SOURCE.apiUrl)
      return new Response(JSON.stringify(release), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
    dialog: overrides.dialog ?? {
      async showMessageBox(options) {
        messages.push(options)
        return { response: responses.shift() ?? 1 }
      },
    },
    getWindow: () => undefined,
    openReleasePage: async url => { openedReleases.push(url) },
    openDownloadedFile: async path => { openedFiles.push(path) },
    downloadImpl: overrides.downloadImpl ?? (async options => {
      downloads.push(options)
      options.onProgress(42)
      progress.push(42)
      return `/Downloads/${options.asset.name}`
    }),
    log: overrides.log,
    ...overrides.controller,
  })
  return { controller, downloads, messages, openedFiles, openedReleases, progress }
}

test('installer assets map to the packages published for each platform and architecture', () => {
  assert.equal(installerAssetName({ version: '1.2.3', platform: 'darwin', arch: 'arm64' }), 'DSH-Desktop-v1.2.3-macos-arm64.dmg')
  assert.equal(installerAssetName({ version: '1.2.3', platform: 'darwin', arch: 'x64' }), 'DSH-Desktop-v1.2.3-macos-x64.dmg')
  assert.equal(installerAssetName({ version: '1.2.3', platform: 'win32', arch: 'x64' }), 'DSH-Desktop-v1.2.3-windows-x64-setup.exe')
  assert.equal(installerAssetName({ version: '1.2.3', platform: 'linux', arch: 'x64' }), 'DSH-Desktop-v1.2.3-linux-x64.AppImage')
  assert.equal(supportsInstallerDownloads({ isPackaged: true, platform: 'win32', arch: 'arm64' }), false)
  assert.equal(supportsInstallerDownloads({ isPackaged: false, platform: 'darwin', arch: 'arm64' }), false)
})
test('latest Release parsing requires the exact installer and GitHub SHA-256 metadata', () => {
  const parsed = parseLatestRelease(releaseFixture('1.2.3'), { platform: 'linux', arch: 'x64', releaseSource: TEST_RELEASE_SOURCE })
  assert.equal(parsed.version, '1.2.3')
  assert.equal(parsed.asset.digest, DIGEST)

  const missingDigest = releaseFixture('1.2.3')
  missingDigest.assets[0].digest = null
  assert.throws(() => parseLatestRelease(missingDigest, { platform: 'linux', arch: 'x64', releaseSource: TEST_RELEASE_SOURCE }), /SHA-256/)

  const untrusted = releaseFixture('1.2.3')
  untrusted.assets[0].browser_download_url = `https://example.com/${untrusted.assets[0].name}`
  assert.throws(() => parseLatestRelease(untrusted, { platform: 'linux', arch: 'x64', releaseSource: TEST_RELEASE_SOURCE }), /not trusted/)
})

test('unsupported builds open the latest GitHub Release from the menu', async () => {
  const setup = fixture({ controller: { isPackaged: false } })

  assert.equal(setup.controller.initialize(), false)
  assert.equal(setup.controller.supported, false)
  assert.equal(setup.controller.externalReleaseAvailable, true)
   assert.equal(setup.controller.state, 'unsupported')
   assert.equal(setup.controller.progress, 0)
  assert.equal(setup.controller.checkAvailable, true)
  assert.equal(setup.controller.menuItem().label, 'View Latest Release…')
  await setup.controller.check(true)

  assert.deepEqual(setup.openedReleases, [TEST_RELEASE_SOURCE.releasesUrl])
})

test('desktop updates stay local-only until a first-party release source is explicitly configured', async () => {
  const setup = fixture({ controller: { releaseSource: undefined } })

  assert.equal(setup.controller.initialize(), false)
  assert.equal(setup.controller.state, 'local-only')
  assert.equal(setup.controller.releaseSourceConfigured, false)
  assert.equal(setup.controller.supported, false)
  assert.equal(setup.controller.externalReleaseAvailable, false)
  assert.equal(setup.controller.checkAvailable, false)
  assert.equal(setup.controller.menuItem().enabled, false)
  assert.match(setup.controller.menuItem().label, /local build/u)

  await setup.controller.check(true)
  assert.equal(setup.openedReleases.length, 0)
  assert.equal(setup.messages.length, 0)
})

test('packaged installer checks expose busy state and disable re-entry while checking', async () => {
  let resolveFetch
  const pending = new Promise(resolve => { resolveFetch = resolve })
  const setup = fixture({ fetchImpl: async () => pending })
  const checking = setup.controller.check(false)

  assert.equal(setup.controller.supported, true)
  assert.equal(setup.controller.busy, true)
  assert.equal(setup.controller.progress, 0)
  assert.equal(setup.controller.checkAvailable, false)
  assert.equal(setup.controller.menuItem().enabled, false)

  resolveFetch(new Response(JSON.stringify(releaseFixture('1.0.0')), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  await checking
  assert.equal(setup.controller.busy, false)
  assert.equal(setup.controller.checkAvailable, true)
})

test('a manual check reports when the installed version is current', async () => {
  const setup = fixture()
  assert.equal(setup.controller.initialize(), true)

  await setup.controller.check(true)

  assert.equal(setup.controller.state, 'idle')
  assert.equal(setup.messages.at(-1).title, 'You’re Up to Date')
  assert.equal(setup.downloads.length, 0)
})

test('an available update downloads the installer and opens the local file after confirmation', async () => {
  const setup = fixture({ release: releaseFixture('1.1.0'), responses: [0, 0] })

  await setup.controller.check(false)

  assert.equal(setup.messages[0].title, 'Update Available')
  assert.equal(setup.messages[1].title, 'Installer Downloaded')
  assert.equal(setup.downloads.length, 1)
  assert.equal(setup.downloads[0].asset.name, 'DSH-Desktop-v1.1.0-linux-x64.AppImage')
  assert.deepEqual(setup.openedFiles, ['/Downloads/DSH-Desktop-v1.1.0-linux-x64.AppImage'])
  assert.equal(setup.controller.state, 'downloaded')
   assert.equal(setup.controller.progress, 100)
  assert.equal(setup.controller.menuItem().label, 'Show Downloaded AppImage…')
})

test('aborting an unresolved installer confirmation drains and ignores a late download choice', async () => {
  const action = new AbortController()
  const messages = []
  let resolveDialog
  const setup = fixture({
    release: releaseFixture('1.1.0'),
    dialog: {
      showMessageBox: options => {
        messages.push(options)
        return new Promise(resolve => { resolveDialog = resolve })
      },
    },
  })

  const checking = setup.controller.check(false, { signal: action.signal })
  await nextTurn()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].signal, action.signal)
  action.abort(new Error('Desktop shutdown'))
  await checking

  assert.equal(setup.controller.state, 'idle')
  assert.equal(setup.controller.progress, 0)
  assert.equal(setup.downloads.length, 0)
  resolveDialog({ response: 0 })
  await nextTurn()
  assert.equal(setup.downloads.length, 0)
  assert.equal(setup.openedFiles.length, 0)
})

test('aborting the downloaded-state prompt preserves the downloaded installer', async () => {
  const messages = []
  let promptCount = 0
  let resolvePrompt
  const setup = fixture({
    release: releaseFixture('1.1.0'),
    responses: [0, 1],
    dialog: {
      showMessageBox: options => {
        messages.push(options)
        promptCount += 1
        if (promptCount < 3) return Promise.resolve({ response: promptCount === 1 ? 0 : 1 })
        return new Promise(resolve => { resolvePrompt = resolve })
      },
    },
  })
  await setup.controller.check(false)
  assert.equal(setup.controller.state, 'downloaded')
  const downloadedPath = setup.controller.downloadedPath
  const action = new AbortController()
  const prompt = setup.controller.check(true, { signal: action.signal })
  await nextTurn()
  assert.equal(messages.length, 3)
  assert.equal(messages[2].signal, action.signal)
  action.abort(new Error('Desktop shutdown'))
  await prompt

  assert.equal(setup.controller.state, 'downloaded')
  assert.equal(setup.controller.progress, 100)
  assert.equal(setup.controller.downloadedPath, downloadedPath)
  resolvePrompt({ response: 0 })
  await nextTurn()
  assert.equal(setup.openedFiles.length, 0)
})

test('opening a downloaded installer failure preserves downloaded availability and complete progress', async () => {
  const setup = fixture({
    release: releaseFixture('1.1.0'),
    responses: [0, 0],
    controller: { openDownloadedFile: async () => 'could not open installer' },
  })

  await setup.controller.check(false)

  assert.equal(setup.controller.state, 'downloaded')
  assert.equal(setup.controller.progress, 100)
  assert.equal(setup.controller.downloadedPath, '/Downloads/DSH-Desktop-v1.1.0-linux-x64.AppImage')
})

test('background Release check errors are logged without interrupting the user', async () => {
  const logs = []
  const setup = fixture({
    fetchImpl: async () => { throw new Error('offline') },
    log: (level, message) => logs.push({ level, message }),
  })

  await setup.controller.check(false)

  assert.equal(setup.controller.state, 'idle')
  assert.equal(setup.messages.length, 0)
  assert.match(logs.at(-1).message, /offline/)
})

test('installer diagnostics redact credentials and cap native detail/log output', async () => {
  const secret = 'auto-update-basic-secret-123456789'
  const failure = new Error(`Authorization: Basic ${secret}\n${'x'.repeat(100_000)}`)
  failure.stack = `prefix: preserve this\n${failure.message}\n${'y'.repeat(100_000)}`
  const logs = []
  const setup = fixture({
    fetchImpl: async () => { throw failure },
    log: (level, message) => logs.push({ level, message }),
  })

  await setup.controller.check(true)
  const detail = setup.messages.at(-1).detail
  assert.ok(detail.length <= DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS)
  assert.ok(logs.at(-1).message.length <= DIAGNOSTIC_LOG_ENTRY_MAX_CHARS)
  assert.doesNotMatch(detail, new RegExp(secret))
  assert.doesNotMatch(logs.at(-1).message, new RegExp(secret))
  assert.match(detail, /^prefix: preserve this/)
})

test('installer download streams to a collision-free file and verifies its digest', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const data = Buffer.from('verified installer data')
  const name = 'DSH-Desktop-v1.2.3-macos-arm64.dmg'
  writeFileSync(join(directory, name), 'existing file')
  const progress = []

  const path = await downloadInstallerAsset({
    asset: {
      name,
      size: data.length,
      digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
      url: `${TEST_RELEASE_SOURCE.releasesUrl.replace('/latest', '/download/v1.2.3')}/test.dmg`,
    },
    downloadsDirectory: directory,
    fetchImpl: async () => new Response(data),
    platform: 'darwin',
    onProgress: value => progress.push(value),
  })

  assert.equal(path, join(directory, 'DSH-Desktop-v1.2.3-macos-arm64 (1).dmg'))
  assert.deepEqual(readFileSync(path), data)
  assert.equal(readFileSync(join(directory, name), 'utf8'), 'existing file')
  assert.equal(progress.at(-1), 100)
})

test('aborting a stalled installer stream settles and removes its partial file', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const action = new AbortController()
  let fetched = false
  let resolveFetch
  const fetchStarted = new Promise(resolve => { resolveFetch = resolve })
  const downloading = downloadInstallerAsset({
    asset: {
      name: 'DSH-Desktop-v1.2.3-windows-x64-setup.exe',
      size: 10,
      digest: DIGEST,
       url: `${TEST_RELEASE_SOURCE.releasesUrl.replace('/latest', '/download/v1.2.3')}/test.exe`,
    },
    downloadsDirectory: directory,
    fetchImpl: async () => {
      fetched = true
      resolveFetch()
      return {
        ok: true,
        body: {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise(() => {}) }
          },
        },
      }
    },
    platform: 'win32',
    signal: action.signal,
  })
  await fetchStarted
  action.abort(new Error('Desktop shutdown'))
  await assert.rejects(downloading, /Desktop shutdown/)
  assert.equal(fetched, true)
})

test('installer download removes a file that fails SHA-256 verification', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const data = Buffer.from('tampered installer')

  await assert.rejects(downloadInstallerAsset({
    asset: {
      name: 'DSH-Desktop-v1.2.3-windows-x64-setup.exe',
      size: data.length,
      digest: DIGEST,
       url: `${TEST_RELEASE_SOURCE.releasesUrl.replace('/latest', '/download/v1.2.3')}/test.exe`,
    },
    downloadsDirectory: directory,
    fetchImpl: async () => new Response(data),
    platform: 'win32',
  }), /SHA-256/)

  assert.throws(() => readFileSync(join(directory, 'DSH-Desktop-v1.2.3-windows-x64-setup.exe')), /ENOENT/)
})

test('installer download still removes the verified file when closing its handle fails', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const data = Buffer.from('verified but not safely closed')
  const name = 'DSH-Desktop-v1.2.3-windows-x64-setup.exe'

  await assert.rejects(downloadInstallerAsset({
    asset: {
      name,
      size: data.length,
      digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
       url: `${TEST_RELEASE_SOURCE.releasesUrl.replace('/latest', '/download/v1.2.3')}/test.exe`,
    },
    downloadsDirectory: directory,
    fetchImpl: async () => new Response(data),
    platform: 'win32',
    openImpl: async (...args) => {
      const handle = await openFile(...args)
      return {
        write: handle.write.bind(handle),
        sync: handle.sync.bind(handle),
        close: async () => {
          await handle.close()
          throw new Error('injected close failure')
        },
      }
    },
  }), /injected close failure/u)

  assert.throws(() => readFileSync(join(directory, name)), /ENOENT/u)
})
