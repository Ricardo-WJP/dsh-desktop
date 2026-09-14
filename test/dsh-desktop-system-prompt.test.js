import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply, inject, profileFromArgv } from '../src/plugins/dsh-desktop-integration/lib/index.js'

test('desktop host adds one native dynamic prompt section without replacing existing prompt content', async (t) => {
  const root = new Context()
  t.after(() => root.fiber.dispose())

  root.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
    source: 'process',
    values: {
      DSH_HOME: 'D:\\fixture\\dsh-home',
      DSH_DESKTOP_APP_VERSION: '1.0.0-fixture',
      DSH_DESKTOP_LOG_PATH: 'D:\\fixture\\desktop.log',
      DSH_PROFILE: 'stale-web-value',
      DSH_PROFILE_DIR: 'D:\\fixture\\dsh-home\\profiles\\service-profile',
    },
  }]))

  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  const systemPrompt = root.get('systemPrompt')
  systemPrompt.section({ name: 'fixture:existing', order: 0, text: 'existing deployment persona' })
  await root.plugin({ name: 'dsh-desktop-integration-fixture', inject, apply })

  const assembly = await systemPrompt.assemble({
    agent: { session: { header: { cwd: 'D:\\fixture\\workspace' } } },
  })
  const prompt = renderPrompt(assembly)

  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(assembly.sections.filter(section => section.name === 'dsh-desktop:runtime-context').length, 1)
  assert.match(prompt, /existing deployment persona/)
  assert.match(prompt, /DSH_HOME=D:\\fixture\\dsh-home/)
  assert.match(prompt, /桌面客户端版本：1\.0\.0-fixture/)
  assert.match(prompt, /D:\\fixture\\desktop\.log/)
  assert.match(prompt, /活动 profile=service-profile/)
  assert.match(prompt, /当前工作区：D:\\fixture\\workspace/)
  assert.match(prompt, /默认使用简体中文/)
  assert.match(prompt, /子智能体按任务需求、模型能力和总成本分派/)
  assert.match(prompt, /用户要求亲自完成时不委派/)
  assert.match(prompt, /区分静态检查、模拟测试与真实运行/)
  assert.doesNotMatch(prompt, /GLM|gpt-\d|Luna|Claude|Gemini/)
  assert.match(prompt, /不默认给每个插件补兼容层/)
  assert.match(prompt, /已确认的视觉、布局、文案和正常交互属于保护基线/)
  assert.match(prompt, /只重启已核实的目标进程/)
  assert.match(prompt, /10\. 交付简要说明/)
  assert.doesNotMatch(prompt, /complete/i)
})

test('profile selection accepts the real DSH --profile forms without falling back to web', () => {
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', 'ricardo-stable']), 'ricardo-stable')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile=ricardo-stable']), 'ricardo-stable')
  assert.equal(profileFromArgv(['node', 'dsh']), undefined)
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', '--port', '3080']), undefined)
})
