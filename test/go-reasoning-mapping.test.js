import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOpenCodeGoCapabilities } from '../src/compatibility/opencode-go-catalog.js'

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const model = (id, api = 'openai-completions') => ({ id, api, provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 65536 })
const supported = m => !m.reasoning ? ['off'] : levels.filter(level => m.thinkingLevelMap?.[level] !== null && (!['max', 'xhigh'].includes(level) || m.thinkingLevelMap?.[level] !== undefined))

test('fresh capabilities repair cached false and expose only documented DeepSeek controls', () => {
  const base = model('deepseek-v4-flash-vision-exp')
  const result = applyOpenCodeGoCapabilities(base, {
    id: base.id, reasoning: true,
    reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
    modalities: { input: ['text', 'image'] }, limit: { context: 1000000, output: 384000 },
    interleaved: { field: 'reasoning_content' }, baseUrl: 'https://example.invalid',
  })
  assert.deepEqual(supported(result), ['off', 'low', 'high', 'max'])
  assert.equal(result.thinkingLevelMap.max, 'max')
  assert.equal(result.compat.thinkingFormat, 'deepseek')
  assert.equal(result.compat.supportsReasoningEffort, true)
  assert.equal(result.compat.requiresReasoningContentOnAssistantMessages, true)
  assert.equal(result.baseUrl, base.baseUrl)
  assert.equal(result.contextWindow, 1000000)
  assert.equal(result.maxTokens, 384000)
  assert.deepEqual(result.input, ['text', 'image'])
  assert.equal(base.reasoning, false)
})

test('max-only is not widened to default pi-ai levels and none maps to Off wire value', () => {
  const kimi = applyOpenCodeGoCapabilities(model('kimi-k3'), { id: 'kimi-k3', reasoning: true, reasoning_options: [{ type: 'effort', values: ['max'] }] })
  assert.deepEqual(supported(kimi), ['max'])
  const luna = applyOpenCodeGoCapabilities(model('gpt-5.6-luna', 'openai-responses'), { id: 'gpt-5.6-luna', reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }] })
  assert.deepEqual(supported(luna), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(luna.thinkingLevelMap.off, 'none')
})

test('Messages effort uses native adaptive dispatch, not fabricated numeric budgets', () => {
  const qwen = applyOpenCodeGoCapabilities(model('qwen3.8-max', 'anthropic-messages'), { id: 'qwen3.8-max', reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'xhigh'] }] })
  assert.deepEqual(supported(qwen), ['off', 'low', 'medium', 'xhigh'])
  assert.equal(qwen.compat.forceAdaptiveThinking, true)
})

test('missing, mismatched, and toggle-only metadata never invent named effort controls', () => {
  const base = model('new-model')
  assert.deepEqual(applyOpenCodeGoCapabilities(base), base)
  assert.deepEqual(applyOpenCodeGoCapabilities(base, { id: 'other', reasoning: true }), base)
  const toggle = applyOpenCodeGoCapabilities(base, { id: base.id, reasoning: true, reasoning_options: [{ type: 'toggle' }] })
  assert.equal(toggle.thinkingLevelMap, undefined)
  const removed = applyOpenCodeGoCapabilities({ ...base, reasoning: true, thinkingLevelMap: { high: 'high' } }, { id: base.id, reasoning: false })
  assert.equal(removed.reasoning, false)
  assert.equal(removed.thinkingLevelMap, undefined)
})
