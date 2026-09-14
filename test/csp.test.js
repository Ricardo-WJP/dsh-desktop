import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

function assertStrictCsp(html, label) {
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)
  assert.ok(match, `${label} must contain a CSP meta tag`)
  const csp = match[1]
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /style-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.match(csp, /base-uri 'none'/)
  assert.doesNotMatch(csp, /unsafe-eval|https:\/\/(?!127\.0\.0\.1)/)
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
  return csp
}

function configCsp(name) {
  const match = config.match(new RegExp(`export const ${name} = "([^"]+)"`))
  assert.ok(match, `${name} must be declared in vite.config.ts`)
  return match[1]
}

test('renderer source carries a strict production CSP', () => {
  assertStrictCsp(source, 'renderer source')
})

test('Vite applies a command-aware CSP and explicitly permits loopback React refresh only in dev', () => {
  const production = configCsp('PRODUCTION_CSP')
  const development = configCsp('DEVELOPMENT_CSP')
  assert.doesNotMatch(production, /unsafe-inline|unsafe-eval|127\.0\.0\.1:5173|ws:/)
  assert.match(development, /script-src 'self' 'unsafe-inline' http:\/\/127\.0\.0\.1:5173/)
  assert.match(development, /style-src 'self' 'unsafe-inline' http:\/\/127\.0\.0\.1:5173/)
  assert.match(development, /connect-src 'self' http:\/\/127\.0\.0\.1:5173 ws:\/\/127\.0\.0\.1:5173/)
  assert.match(config, /const csp = command === 'serve' \? DEVELOPMENT_CSP : PRODUCTION_CSP/)
  assert.match(config, /transformIndexHtml:\s*\{\s*order: 'post'/)
})

test('production build retains strict CSP and dev HMR is loopback-only', () => {
  const builtPath = new URL('../build/renderer/index.html', import.meta.url)
  assert.equal(existsSync(builtPath), true, 'npm test pretest must build renderer HTML')
  const built = readFileSync(builtPath, 'utf8')
  const csp = assertStrictCsp(built, 'renderer build')
  const builtScript = readFileSync(new URL('../build/renderer/assets/renderer.js', import.meta.url), 'utf8')
  assert.doesNotMatch(builtScript, /style:\{width:/, 'loading progress must not compile to a renderer inline style object')
  assert.doesNotMatch(built, /<style\b/i, 'production HTML must not contain an inline style block')
  assert.doesNotMatch(csp, /127\.0\.0\.1:5173|ws:/)
  assert.match(config, /host:\s*'127\.0\.0\.1'/)
  assert.match(config, /origin:\s*'http:\/\/127\.0\.0\.1:5173'/)
  assert.match(config, /allowedHosts:\s*\['127\.0\.0\.1'\]/)
  assert.match(config, /hmr:\s*\{[\s\S]*host:\s*'127\.0\.0\.1'[\s\S]*protocol:\s*'ws'[\s\S]*port:\s*5173/)
  assert.match(config, /DEVELOPMENT_CSP[\s\S]*http:\/\/127\.0\.0\.1:5173[\s\S]*ws:\/\/127\.0\.0\.1:5173/)
  assert.doesNotMatch(config, /script-src[^\n]*https?:\/\/(?!127\.0\.0\.1)/)
})
