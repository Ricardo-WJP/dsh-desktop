import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { DSH_012_COMPATIBILITY_RECIPE } from '../compatibility/recipes/dsh-0.1.2-rc.1.js'

test('pi-ai session attribution preserves identity and separates conversations', () => {
  const target = DSH_012_COMPATIBILITY_RECIPE.targets.find(t => t.id === 'pi-ai-native-session-header')
  const source = target.operations[0].replace + `
    const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()));
    return {...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))), ...attribution};
  }`
  const context = vm.createContext({ attributionHeaders: () => ({ 'User-Agent': 'deepseek-harness/test' }) })
  const headers = vm.runInContext(`${source}; requestHeaders`, context)
  for (const id of ['parent', 'parent', 'child']) {
    const result = headers({ 'X-DeepSeek-Harness-Session-ID': 'stale', Custom: 'preserved' }, id)
    assert.equal(result['x-deepseek-harness-session-id'], id)
    assert.equal(result['X-DeepSeek-Harness-Session-ID'], undefined)
    assert.equal(result.Custom, 'preserved')
    assert.equal(result['User-Agent'], 'deepseek-harness/test')
  }
  assert.equal(headers({}, undefined)['x-deepseek-harness-session-id'], undefined)
  assert.equal(target.operations[1].replace, 'headers: requestHeaders(profile.headers, options.sessionId)')
})
