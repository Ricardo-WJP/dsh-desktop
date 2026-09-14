import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 } from 'node:path'
import { createPreflightEnvironment } from '../src/profile/preflight-environment.js'

const HOME = 'C:\\tmp\\dsh-preflight-test-001'

function assertInsideHome(directory) {
  const relative = win32.relative(win32.resolve(HOME), directory)
  assert.notEqual(relative, '')
  assert.equal(win32.isAbsolute(relative), false)
  assert.equal(relative === '..' || relative.startsWith('..\\'), false)
}

test('builds a minimal Windows environment without mutating or expanding the source env', () => {
  const source = {
    Path: 'path-from-Path',
    PATH: 'path-from-PATH',
    path: 'path-from-lowercase-path',
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE',
    OS: 'Windows_NT',
    processor_architecture: 'AMD64',
    http_proxy: 'http://proxy.example:7892',
    HTTPS_PROXY: 'https://proxy.example:7892',
    all_proxy: 'socks5://proxy.example:7892',
    No_Proxy: 'localhost,127.0.0.1',
    npm_config_offline: 'true',
    npm_config_cache: 'C:\\user\\npm-cache',
    OPENAI_API_KEY: 'secret-openai',
    OPENCODE_GO_API_KEY: 'secret-opencode',
    AGY_API_KEY: 'secret-agy',
    NODE_OPTIONS: '--require attacker.js',
    DSH_HOME: 'C:\\user\\dsh',
    DSH_PLUGIN_HOME: 'C:\\user\\plugins',
    DSH_SETTINGS_PATH: 'C:\\user\\settings.json',
  }
  const before = structuredClone(source)

  const result = createPreflightEnvironment({ env: source, home: HOME, platform: 'win32' })

  assert.deepEqual(source, before)
  assert.notStrictEqual(result.env, source)
  assert.equal(result.env.PATH, 'path-from-PATH')
  assert.equal(result.env.Path, undefined)
  assert.equal(Object.keys(result.env).filter(key => key.toLowerCase() === 'path').length, 1)
  assert.equal(result.env.SystemRoot, 'C:\\Windows')
  assert.equal(result.env.WINDIR, 'C:\\Windows')
  assert.equal(result.env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(result.env.PATHEXT, '.COM;.EXE')
  assert.equal(result.env.OS, 'Windows_NT')
  assert.equal(result.env.PROCESSOR_ARCHITECTURE, 'AMD64')
  assert.equal(result.env.HTTP_PROXY, 'http://proxy.example:7892')
  assert.equal(result.env.HTTPS_PROXY, 'https://proxy.example:7892')
  assert.equal(result.env.ALL_PROXY, 'socks5://proxy.example:7892')
  assert.equal(result.env.NO_PROXY, 'localhost,127.0.0.1')
})

test('overrides user homes and removes credentials, routing flags, plugin homes, and settings paths', () => {
  const result = createPreflightEnvironment({
    env: {
      PATH: 'C:\\Windows\\System32',
      OPENAI_API_KEY: 'secret',
      OPENCODE_API_KEY: 'secret',
      AGY_TOKEN: 'secret',
      NODE_OPTIONS: '--inspect',
      npm_config_offline: 'true',
      CODEX_HOME: 'C:\\user\\codex',
      DSH_PLUGIN_HOME: 'C:\\user\\plugins',
      PI_CODING_AGENT_DIR: 'C:\\user\\pi',
      DSH_SETTINGS_PATH: 'C:\\user\\settings.json',
      USER_SETTINGS_FILE: 'C:\\user\\settings.json',
    },
    home: HOME,
    platform: 'win32',
  })

  assert.equal(result.env.HOME, win32.join(HOME, 'home'))
  assert.equal(result.env.USERPROFILE, win32.join(HOME, 'home'))
  assert.equal(result.env.APPDATA, win32.join(HOME, 'appdata', 'roaming'))
  assert.equal(result.env.LOCALAPPDATA, win32.join(HOME, 'appdata', 'local'))
  assert.equal(result.env.XDG_CONFIG_HOME, win32.join(HOME, 'xdg', 'config'))
  assert.equal(result.env.XDG_DATA_HOME, win32.join(HOME, 'xdg', 'data'))
  assert.equal(result.env.XDG_CACHE_HOME, win32.join(HOME, 'xdg', 'cache'))
  assert.equal(result.env.TEMP, win32.join(HOME, 'tmp'))
  assert.equal(result.env.TMP, result.env.TEMP)
  assert.equal(result.env.TMPDIR, result.env.TEMP)
  assert.equal(result.env.DSH_HOME, win32.join(HOME, 'dsh'))
  assert.equal(result.env.DSH_DOCTOR_HOME, win32.join(HOME, 'dsh-doctor'))
  assert.equal(result.env.MNEMON_DATA_DIR, win32.join(HOME, 'mnemon'))
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(result.env.DSH_DESKTOP, '1')
  assert.equal(result.env.FORCE_COLOR, '0')
  assert.equal(result.env.NO_COLOR, '1')

  for (const key of [
    'OPENAI_API_KEY',
    'OPENCODE_API_KEY',
    'AGY_TOKEN',
    'NODE_OPTIONS',
    'npm_config_offline',
    'CODEX_HOME',
    'DSH_PLUGIN_HOME',
    'PI_CODING_AGENT_DIR',
    'DSH_SETTINGS_PATH',
    'USER_SETTINGS_FILE',
  ]) {
    assert.equal(Object.hasOwn(result.env, key), false, `unexpected inherited key: ${key}`)
  }
})

test('returns only explicit child directories under the temporary home', () => {
  const result = createPreflightEnvironment({ env: {}, home: HOME, platform: 'win32' })

  assert.ok(Array.isArray(result.directories))
  assert.ok(result.directories.length >= 9)
  for (const directory of result.directories) {
    assert.equal(typeof directory, 'string')
    assertInsideHome(directory)
  }
  for (const key of [
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'TEMP',
    'DSH_HOME',
    'DSH_DOCTOR_HOME',
    'MNEMON_DATA_DIR',
  ]) {
    assert.ok(result.directories.includes(result.env[key]), `missing directory for ${key}`)
  }
})

test('preserves lowercase proxy variables through canonical uppercase names on POSIX', () => {
  const result = createPreflightEnvironment({
    env: {
      PATH: '/usr/bin',
      http_proxy: 'http://proxy.example:7892',
      HtTpS_PrOxY: 'https://proxy.example:7892',
      all_proxy: 'socks5://proxy.example:7892',
      no_proxy: 'localhost,127.0.0.1',
      NODE_OPTIONS: '--require attacker.js',
    },
    home: '/tmp/dsh-preflight-test-001',
    platform: 'linux',
  })

  assert.equal(result.env.PATH, '/usr/bin')
  assert.equal(result.env.HTTP_PROXY, 'http://proxy.example:7892')
  assert.equal(result.env.HTTPS_PROXY, 'https://proxy.example:7892')
  assert.equal(result.env.ALL_PROXY, 'socks5://proxy.example:7892')
  assert.equal(result.env.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal(result.env.SystemRoot, undefined)
  assert.equal(result.env.NODE_OPTIONS, undefined)
})

test('rejects non-absolute and NUL-containing homes', () => {
  assert.throws(
    () => createPreflightEnvironment({ env: {}, home: 'relative-home', platform: 'win32' }),
    /absolute path/u,
  )
  assert.throws(
    () => createPreflightEnvironment({ env: {}, home: 'C:\\tmp\\bad\0home', platform: 'win32' }),
    /NUL/u,
  )
})
