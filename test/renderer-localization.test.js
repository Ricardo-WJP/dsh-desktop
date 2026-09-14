import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const rendererFiles = [
  '../src/renderer/components/AppShell.tsx',
  '../src/renderer/routes/LoadingRoute.tsx',
  '../src/renderer/routes/OverviewRoute.tsx',
  '../src/renderer/routes/ModeRoute.tsx',
  '../src/renderer/routes/UpdateRoute.tsx',
  '../src/renderer/routes/RecoveryRoute.tsx',
  '../src/renderer/routes/DiagnosticsRoute.tsx',
  '../src/renderer/routes/ErrorRoute.tsx',
]

function staticVisibleText(code) {
  const values = []
  for (const match of code.matchAll(/>([^<>{}\r\n]*)</g)) values.push(match[1].trim())
  for (const match of code.matchAll(/\b(?:aria-label|placeholder|eyebrow|title|detail)=["']([^"']+)["']/g)) values.push(match[1].trim())
  return values.filter(Boolean)
}

test('renderer document and every major route default to Simplified Chinese', () => {
  const html = source('../src/renderer/index.html')
  assert.match(html, /<html lang="zh-CN">/)
  assert.match(html, /<title>DeepSeek Harness Desktop<\/title>/)

  const anchors = new Map([
    ['../src/renderer/components/AppShell.tsx', ['DeepSeek Harness', '管理导航']],
    ['../src/renderer/routes/LoadingRoute.tsx', ['正在准备本地工作区', '启动进度']],
    ['../src/renderer/routes/OverviewRoute.tsx', ['控制中心', '打开工作区']],
    ['../src/renderer/routes/ModeRoute.tsx', ['运行模式', '当前未配置可切换模式']],
    ['../src/renderer/routes/UpdateRoute.tsx', ['发布管理', '准备稳定版候选版本']],
    ['../src/renderer/routes/RecoveryRoute.tsx', ['恢复中心', '创建快照']],
    ['../src/renderer/routes/DiagnosticsRoute.tsx', ['运行诊断', '打开日志文件夹']],
    ['../src/renderer/routes/ErrorRoute.tsx', ['启动 / 恢复边界', '未能就绪']],
  ])

  for (const [path, expected] of anchors) {
    const code = source(path)
    for (const text of expected) assert.match(code, new RegExp(text), `${path} should expose ${text}`)
  }
})

test('major renderer shell and routes have no English-only static UI copy', () => {
  const allowedTechnicalValues = new Set(['DeepSeek Harness Desktop', 'DSH Desktop', 'npm', 'GitHub', 'local-dev'])
  const offenders = []

  for (const path of rendererFiles) {
    for (const value of staticVisibleText(source(path))) {
      const hasEnglishWord = /[A-Za-z]{2,}/.test(value)
      const hasChinese = /[\u3400-\u9fff]/.test(value)
      if (hasEnglishWord && !hasChinese && !allowedTechnicalValues.has(value)) offenders.push(`${path}: ${value}`)
    }
  }

  assert.deepEqual(offenders, [])
})

test('hardcoded renderer feedback, errors, and empty states are localized', () => {
  const code = [
    source('../src/renderer/api.ts'),
    source('../src/renderer/App.tsx'),
    ...rendererFiles.map(source),
  ].join('\n')
  const retiredEnglishCopy = [
    'The desktop host is not connected',
    'Candidate transaction finished',
    'Configuration must be a JSON object',
    'No catalog snapshot loaded',
    'Desktop installer updates unavailable',
    'Unable to list snapshots',
    'No verified snapshots have been published',
    'No log lines have been reported',
    'No detail reported',
  ]
  for (const text of retiredEnglishCopy) assert.doesNotMatch(code, new RegExp(text))
  for (const text of ['桌面 Host 尚未连接', '尚未上报日志内容', '未上报详细信息']) assert.match(code, new RegExp(text))
})

test('unknown backend English is kept in logs instead of leaking into Chinese UI copy', () => {
  const localization = source('../src/renderer/localization.ts')
  assert.match(localization, /export function userFacingDetail/)
  assert.match(localization, /详细技术原因已记录到日志/)
  for (const path of [
    '../src/renderer/api.ts',
    '../src/renderer/App.tsx',
    '../src/renderer/routes/LoadingRoute.tsx',
    '../src/renderer/routes/ErrorRoute.tsx',
    '../src/renderer/routes/UpdateRoute.tsx',
    '../src/renderer/routes/RecoveryRoute.tsx',
    '../src/renderer/routes/DiagnosticsRoute.tsx',
  ]) assert.match(source(path), /userFacingDetail/)
})
