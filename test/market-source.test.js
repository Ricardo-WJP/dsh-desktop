import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarketSource, resolveMarketSource } from '../src/profile/market-source.js'

test('direct npm and GitHub sources do not require a bundled marketplace entry', () => {
  assert.deepEqual(parseMarketSource('npm:@author/plugin@next'), { type: 'npm', package: '@author/plugin', versionOrTag: 'next' })
  assert.deepEqual(parseMarketSource('https://www.npmjs.com/package/@author/plugin'), { type: 'npm', package: '@author/plugin' })
  assert.deepEqual(parseMarketSource('https://github.com/author/repo/tree/main/packages/plugin'), {
    type: 'github', repository: 'author/repo', ref: 'main', path: '/packages/plugin',
  })
})

test('GitHub installation pins metadata and source to the same commit and reads the actual scoped name', async () => {
  const requests = []
  const sha = 'b'.repeat(40)
  const result = await resolveMarketSource('https://github.com/author/repo', { fetchImpl: async url => {
    requests.push(url)
    return Response.json(requests.length === 1 ? { sha } : { name: '@author/not-the-repo-name' })
  } })
  assert.deepEqual(result, { packageName: '@author/not-the-repo-name', source: { type: 'github', repository: 'author/repo', ref: sha } })
  assert.equal(requests[1], `https://raw.githubusercontent.com/author/repo/${sha}/package.json`)
})

test('invalid source schemes, credentials, ports, command fragments and redirects are rejected', async () => {
  for (const input of ['http://github.com/author/repo', 'https://github.com:444/author/repo', 'https://user:secret@github.com/author/repo', 'https://evil.invalid/author/repo', 'foo;calc', 'file:///tmp/plugin', 'https://github.com/author/repo?token=value', 'https://github.com/author/repo/tree/main/%2Fescape']) {
    assert.throws(() => parseMarketSource(input))
  }
  await assert.rejects(resolveMarketSource('https://github.com/author/repo', { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error')
    return new Response('', { status: 403 })
  } }), /HTTP 403/)
})

test('malformed or oversized upstream metadata cannot become an install identity', async () => {
  await assert.rejects(resolveMarketSource('https://github.com/author/repo', { fetchImpl: async () => Response.json({ sha: 'main' }) }), /exact plugin commit/)
  await assert.rejects(resolveMarketSource(`https://github.com/author/repo/tree/${'a'.repeat(40)}`, { fetchImpl: async () => new Response(' '.repeat(262145)) }), /too large/)
  await assert.rejects(resolveMarketSource(`https://github.com/author/repo/tree/${'a'.repeat(40)}`, { fetchImpl: async () => Response.json({ name: '../bad' }) }), /valid package name/)
})
