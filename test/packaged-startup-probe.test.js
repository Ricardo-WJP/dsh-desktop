import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyPageState,
  isPathWithin,
  parseArguments,
  validateEphemeralCi,
  validatePathBoundaries,
} from '../scripts/verify-packaged-startup.mjs'

test('packaged startup probe parses only explicit, bounded verification flags', () => {
  const options = parseArguments([
    '--executable', 'C:\\package\\DeepSeek Harness Desktop.exe',
    '--output-dir', 'C:\\temp\\proof',
    '--isolated-home', 'C:\\temp\\home',
    '--ephemeral-ci',
    '--complete-onboarding',
    '--reuse-isolated-home',
  ])
  assert.equal(options.ephemeralCi, true)
  assert.equal(options.completeOnboarding, true)
  assert.equal(options.reuseIsolatedHome, true)
  assert.equal(options.timeoutMs, 90_000)
})

test('packaged startup probe classifies actual workspace and onboarding bridge states separately', () => {
  assert.deepEqual(classifyPageState({
    documentReady: true,
    desktopBridge: true,
    onboardingBridge: false,
    workspaceBridge: true,
    loopbackRuntimePage: true,
    harnessRoot: true,
  }), {
    packagedStartupReady: true,
    runtimeReady: true,
    onboardingReady: false,
    desktopBridge: true,
    onboardingBridge: false,
    workspaceBridge: true,
  })
  const onboarding = classifyPageState({ documentReady: true, onboardingBridge: true })
  assert.equal(onboarding.packagedStartupReady, true)
  assert.equal(onboarding.onboardingReady, true)
  assert.equal(onboarding.runtimeReady, false)
})

test('packaged startup probe rejects path overlap and executable-directory nesting by platform path semantics', () => {
  assert.equal(isPathWithin('C:\\build', 'C:\\build\\win-unpacked', 'win32'), true)
  assert.equal(isPathWithin('/runner/temp', '/runner/workspace', 'darwin'), false)
  assert.doesNotThrow(() => validatePathBoundaries({
    executable: 'C:\\build\\win-unpacked\\DeepSeek Harness Desktop.exe',
    outputDirectory: 'C:\\build\\proof',
    isolatedHome: 'C:\\temp\\home',
    platform: 'win32',
  }))
  assert.throws(() => validatePathBoundaries({
    executable: 'C:\\build\\win-unpacked\\DeepSeek Harness Desktop.exe',
    outputDirectory: 'C:\\build\\win-unpacked\\proof',
    isolatedHome: 'C:\\temp\\home',
    platform: 'win32',
  }), error => error?.code === 'EXECUTABLE_DIRECTORY_OVERLAP')
})

test('ephemeral CI mode accepts only a matching GitHub Actions runner with temp-contained output and home', () => {
  const environment = {
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    RUNNER_OS: 'macOS',
    RUNNER_TEMP: '/Users/runner/work/_temp',
    GITHUB_WORKSPACE: '/Users/runner/work/repository/repository',
  }
  assert.equal(validateEphemeralCi({
    enabled: true,
    platform: 'darwin',
    env: environment,
    executable: '/Users/runner/work/repository/repository/dist/mac/DSH.app/Contents/MacOS/DSH',
    outputDirectory: '/Users/runner/work/_temp/probe-output',
    isolatedHome: '/Users/runner/work/_temp/probe-home',
  }).isolationMode, 'ephemeral GitHub runner; app userData path not independently verified')
  assert.throws(() => validateEphemeralCi({
    enabled: true,
    platform: 'darwin',
    env: { ...environment, CI: 'false' },
    executable: '/Users/runner/work/repository/repository/dist/mac/DSH.app/Contents/MacOS/DSH',
    outputDirectory: '/Users/runner/work/_temp/probe-output',
    isolatedHome: '/Users/runner/work/_temp/probe-home',
  }), error => error?.code === 'EPHEMERAL_CI_ENVIRONMENT_UNVERIFIED')
})

test('ephemeral CI mode requires the runner OS to match Windows when requested there', () => {
  assert.throws(() => validateEphemeralCi({
    enabled: true,
    platform: 'win32',
    env: {
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      RUNNER_OS: 'macOS',
      RUNNER_TEMP: 'D:\\a\\_temp',
      GITHUB_WORKSPACE: 'D:\\a\\repository\\repository',
    },
    executable: 'D:\\a\\repository\\repository\\dist\\win-unpacked\\DSH.exe',
    outputDirectory: 'D:\\a\\_temp\\probe-output',
    isolatedHome: 'D:\\a\\_temp\\probe-home',
  }), error => error?.code === 'EPHEMERAL_CI_ENVIRONMENT_UNVERIFIED')
  assert.throws(() => validateEphemeralCi({
    enabled: false,
    platform: 'win32',
    executable: 'D:\\a\\repository\\repository\\dist\\win-unpacked\\DSH.exe',
    outputDirectory: 'D:\\a\\_temp\\probe-output',
    isolatedHome: 'D:\\a\\_temp\\probe-home',
  }), error => error?.code === 'LOCAL_USER_DATA_ROOT_UNVERIFIED')
})
