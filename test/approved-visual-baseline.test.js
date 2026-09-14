import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Ricardo approved these styles on 2026-09-08. A visual change requires an
// explicit design review before these fingerprints are intentionally updated.
const hash = text => createHash('sha256').update(text).digest('hex')
const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = createRequire(import.meta.url)('../test-support/release-ui-fixture.cjs')

test('approved desktop layout and button CSS remains unchanged', () => {
  assert.equal(hash(fixture.extractClientCss(root)), '9a448a865d4d389e9aaee73125f8de7719a29918d7f8963cb86df6606d867f05')
})

test('approved custom appearance CSS remains unchanged', () => {
  const source = readFileSync(new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url), 'utf8')
  assert.equal(hash(source.match(/const CSS = `([\s\S]*?)`/)[1]), '6fbed12057f10bd3ebcf5e276cc2ad0826dfaffe9c21a6ad24b2751737f5da3f')
})

test('approved recommendation page CSS remains unchanged', () => {
  const source = readFileSync(new URL('../src/pages/plugins-onboarding.html', import.meta.url), 'utf8')
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1])
  assert.equal(hash(JSON.stringify(styles)), '075419c6146acaedc56eed27c77d4563f8d358c85766203df0ba24aadde7d2e9')
})
