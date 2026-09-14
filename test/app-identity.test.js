import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  configureWindowsAppIdentity,
  WINDOWS_APP_USER_MODEL_ID,
} from '../src/app-identity.js'

test('Windows notification identity matches the packaged app id', async () => {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.equal(WINDOWS_APP_USER_MODEL_ID, manifest.build.appId)
})

test('Windows app identity is configured before notification use', () => {
  const calls = []
  assert.equal(configureWindowsAppIdentity({ setAppUserModelId: value => calls.push(value) }, 'win32'), true)
  assert.deepEqual(calls, [WINDOWS_APP_USER_MODEL_ID])
  assert.equal(configureWindowsAppIdentity({ setAppUserModelId: value => calls.push(value) }, 'linux'), false)
  assert.deepEqual(calls, [WINDOWS_APP_USER_MODEL_ID])
})
