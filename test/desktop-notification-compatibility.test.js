import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = readFileSync(new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url), 'utf8')

function harness({ current = 'active', settings, permission = 'granted', revision = '75143eb7f8d8' } = {}) {
  let snapshot = {
    current,
    items: [
      { sessionId: 'active', title: '当前任务', running: false, completed: false, updatedAt: 1 },
      { sessionId: 'background', title: '后台任务', running: false, completed: false, updatedAt: 1 },
    ],
  }
  const listeners = new Set()
  const notifications = []
  let loaded

  class Notification {
    static permission = permission

    constructor(title, options) {
      notifications.push({ title, options })
    }
  }

  const storage = new Map()
  if (settings !== undefined) storage.set('dsh-notification.v4', JSON.stringify(settings))
  const context = {
    console,
    setTimeout,
    clearTimeout,
    dshDesktop: {
      openPath() {},
      publishWorkspaceContext() {},
    },
    Notification,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null },
    },
    __DSH_BOOT__: {
      entries: [{ id: 'dsh-notification', rev: revision }],
    },
  }
  context.globalThis = context
  context.window = {
    __ModuleLoader__: {
      load(value) { loaded = value },
    },
  }
  vm.runInNewContext(clientSource, context)
  const plugin = loaded.factory(() => {})
  const sessions = {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  plugin.apply({
    sessions,
    workspaces: {},
    locale: { bind: () => () => '', register: () => () => {} },
    effect(callback, label) {
      if (label === 'dsh-desktop: notification compatibility') callback()
    },
  })

  return {
    notifications,
    update(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
    snapshot: () => snapshot,
  }
}

test('notification compatibility reports a background session running-to-idle transition', () => {
  const app = harness()
  const running = structuredClone(app.snapshot())
  running.items[1].running = true
  running.items[1].updatedAt = 2
  app.update(running)

  const stopped = structuredClone(app.snapshot())
  stopped.items[1].running = false
  stopped.items[1].updatedAt = 3
  app.update(stopped)

  const completed = structuredClone(app.snapshot())
  completed.items[1].completed = true
  completed.items[1].updatedAt = 4
  app.update(completed)

  assert.equal(app.notifications.length, 1)
  assert.equal(app.notifications[0].title, 'DSH 任务已完成')
  assert.equal(app.notifications[0].options.body, '后台任务 已完成。')
  assert.equal(app.notifications[0].options.tag, 'dsh-notification-background-desktop-3')
})

test('notification compatibility respects foreground-only preference and plugin revision gate', () => {
  for (const app of [
    harness(),
    harness({ revision: 'future-fixed-revision' }),
  ]) {
    const running = structuredClone(app.snapshot())
    running.items[0].running = true
    app.update(running)
    const completed = structuredClone(app.snapshot())
    completed.items[0].running = false
    completed.items[0].completed = true
    app.update(completed)
    assert.equal(app.notifications.length, 0)
  }
})

test('notification compatibility can notify a visible session when backgroundOnly is disabled', () => {
  const app = harness({ settings: { enabled: true, notifyCompleted: true, backgroundOnly: false } })
  const running = structuredClone(app.snapshot())
  running.items[0].running = true
  app.update(running)
  const completed = structuredClone(app.snapshot())
  completed.items[0].running = false
  app.update(completed)
  assert.equal(app.notifications.length, 1)
})
