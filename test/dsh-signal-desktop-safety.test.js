import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const signalHostUrl = new URL('../build/plugin-suite/plugins/dsh-signal/lib/vendor/agy-link/host.js', import.meta.url)
const stableSupervisorUrl = new URL('../src/runtime/stable-supervisor.js', import.meta.url)

test('Antigravity startup probe is hidden and synchronous in Desktop-owned stable children', () => {
  const host = readFileSync(signalHostUrl, 'utf8')
  const supervisor = readFileSync(stableSupervisorUrl, 'utf8')
  assert.match(supervisor, /DSH_DESKTOP: '1'/)
  assert.match(host, /desktopWindows \? execFileSync\(currentBin, \["--version"\]/)
  assert.match(host, /windowsHide: true,\n\s+stdio: \["ignore", "pipe", "pipe"\]/)
  assert.doesNotMatch(host, /"start",\s*"cmd\.exe"/)
  assert.doesNotMatch(host, /path: "\/plugins\/agy-link\/pool\/open-terminal"[\s\S]{0,1800}execFile\(/)
})

test('Antigravity legacy account endpoints remain background-only', () => {
  const host = readFileSync(signalHostUrl, 'utf8')
  assert.match(host, /path: "\/plugins\/agy-link\/pool\/add"[\s\S]{0,1100}backgroundOnly: true/)
  assert.match(host, /path: "\/plugins\/agy-link\/pool\/open-terminal"[\s\S]{0,900}DSH Desktop 禁止打开外部命令行窗口/)
})
