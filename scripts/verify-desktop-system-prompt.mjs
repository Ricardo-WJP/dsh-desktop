import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const { apply, inject } = await import(process.argv[3]
  ? pathToFileURL(resolve(process.argv[3])).href
  : new URL('../src/plugins/dsh-desktop-integration/lib/index.js', import.meta.url).href)

// Inspect only the installed runtime identity; assemble entirely synthetic
// prompt context. No user prompt, credential, session or inference is read.
const runtimeRoot = resolve(process.argv[2])
const active = JSON.parse(await readFile(join(runtimeRoot, 'release-state/active.json'), 'utf8'))
assert.match(active.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const candidate = join(runtimeRoot, 'candidates', active.releaseId)
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'))
assert.match(manifest.dsh.version, /^[0-9A-Za-z.+-]+$/)
const require = createRequire(join(candidate, 'runtime/versions', manifest.dsh.version, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
const ctx = new Context()
try {
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    DSH_HOME: 'D:/fixture/user-data', DSH_PROFILE_DIR: 'D:/fixture/candidates/release/profiles/verified-profile',
  } }]))
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  ctx.get('systemPrompt').section({ name: 'fixture:original', text: 'Existing original persona', order: 0 })
  const registration = await ctx.plugin({ inject, apply })
  const assembled = await ctx.get('systemPrompt').assemble({ agent: { session: { header: { cwd: 'D:/fixture/workspace' } } } })
  const prompt = renderPrompt(assembled)
  assert.match(prompt, /DSH Desktop/)
  assert.match(prompt, /Existing original persona/)
  assert.match(prompt, /verified-profile/)
  assert.match(prompt, /D:\/fixture\/workspace/)
  assert.equal(assembled.sections.filter(s => s.name === 'dsh-desktop:runtime-context').length, 1)
  await registration?.dispose?.()
  console.log(JSON.stringify({ ok: true, dshVersion: manifest.dsh.version, nativeSystemPromptAssembly: true, originalPersonaPreserved: true, dynamicProfileAndWorkspace: true, inferenceRequested: false }))
} finally { await ctx.fiber.dispose() }
