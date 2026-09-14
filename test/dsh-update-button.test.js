import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const packageUrl = new URL('../profiles/packages/dsh-update-button/package.json', import.meta.url)
const patchUrl = new URL('../profiles/packages/dsh-update-button/cordis.patch.yml', import.meta.url)
const hostUrl = new URL('../profiles/packages/dsh-update-button/lib/index.js', import.meta.url)
const clientUrl = new URL('../profiles/packages/dsh-update-button/lib/client.js', import.meta.url)

function source(url) {
  return readFileSync(fileURLToPath(url), 'utf8')
}

function loadClient(bridge) {
  let registration
  const context = vm.createContext({
    dshDesktop: bridge,
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  vm.runInContext(source(clientUrl), context, { filename: fileURLToPath(clientUrl) })
  assert.equal(registration?.id, 'dsh-update-button')
  const react = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
  }
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`Unexpected client dependency: ${specifier}`)
  })
  return { plugin, context }
}

function registerWithMock(plugin) {
  const injected = []
  const registrations = []
  const slots = {
    inject(name, callback) {
      injected.push(name)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  plugin.apply({ slots })
  return { injected, registrations }
}

test('manifest keeps the rc.2 sidebar slot dependency and stable loader entry', () => {
  const manifest = JSON.parse(source(packageUrl))
  assert.equal(manifest.name, 'dsh-update-button')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.match(source(patchUrl), /id: update-button/)
  assert.match(source(patchUrl), /name: dsh-update-button/)
})

test('registers one additive official sidebar action with a stable id', () => {
  const { plugin } = loadClient({ openUpdate: () => Promise.resolve({ ok: true }) })
  const result = registerWithMock(plugin)

  assert.deepEqual(result.injected, ['sidebar.footer.action'])
  assert.equal(result.registrations.length, 1)
  const { options, component } = result.registrations[0]
  assert.equal(options.name, 'sidebar.footer.action')
  assert.equal(options.id, 'dsh-update-button')
  assert.equal(options.order, 100)
  assert.equal(options.label, '更新 DSH')
  assert.equal(Object.hasOwn(options, 'key'), false)
  assert.equal(typeof component, 'function')
})

test('click delegates only to the trusted Desktop update route', () => {
  const opened = []
  const bridge = {
    openUpdate() {
      opened.push('update')
      return Promise.resolve({ ok: true })
    },
  }
  const { plugin } = loadClient(bridge)
  const { registrations } = registerWithMock(plugin)
  const button = registrations[0].component({ wide: true })

  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-label'], '更新 DSH')
  button.props.onClick()
  assert.deepEqual(opened, ['update'])
})

test('fails closed when the workspace bridge has no trusted route method', () => {
  for (const bridge of [undefined, {}, { openUpdate: 'not-a-function' }]) {
    const { plugin } = loadClient(bridge)
    const { registrations } = registerWithMock(plugin)
    assert.equal(registrations[0].component({ wide: false }), null)
  }
})

test('host and client source contain no second update owner or DOM injection path', async () => {
  const host = source(hostUrl)
  const client = source(clientUrl)
  const patch = source(patchUrl)
  const all = `${host}\n${client}\n${patch}`

  assert.doesNotMatch(all, /\/dsh-update\/apply/)
  assert.doesNotMatch(all, /MutationObserver/)
  assert.doesNotMatch(all, /\b(?:spawn|spawnSync|exec|execSync)\s*\(/)
  assert.doesNotMatch(all, /node:child_process|node:fs|launcher|pnpm/)
  assert.doesNotMatch(client, /document\.|querySelector|appendChild|insertBefore|location\./)

  const hostModule = await import(pathToFileURL(fileURLToPath(hostUrl)).href)
  assert.doesNotThrow(() => hostModule.apply({}))
  assert.equal(Object.keys(hostModule).includes('triggerUpdate'), false)
  assert.equal(JSON.parse(source(new URL('../package.json', import.meta.url))).name, 'dsh-desktop')
})
