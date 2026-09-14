import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')

test('workspace title-bar menus expose trusted, functional desktop actions', () => {
  assert.match(main, /const WORKSPACE_UI_ACTIONS = Object\.freeze\(/)
  assert.match(main, /newTask: `\(\(\) => \{[\s\S]+?document\.querySelectorAll\('button,\[role="button"\]'\)/)
  assert.match(main, /toggleSidebar: `\(\(\) => \{/)
  assert.match(main, /toggleBottomPanel: `\(\(\) => \{/)
  assert.match(main, /toggleRightPanel: `\(\(\) => \{/)
  assert.match(main, /function executeWorkspaceUiAction\(action\)/)
  assert.match(main, /executeWorkspaceUiAction\('newTask'\)/)
  assert.match(main, /executeWorkspaceUiAction\('toggleSidebar'\)/)
  assert.match(main, /executeWorkspaceUiAction\('toggleBottomPanel'\)/)
  assert.match(main, /executeWorkspaceUiAction\('toggleRightPanel'\)/)
  assert.match(main, /copy\.openDesktopControlCenter/)
  assert.match(main, /CmdOrCtrl\+Shift\+M/)
  assert.match(main, /windowHost\.loadManagementRoute\('overview'\)/)
  assert.match(main, /copy\.keyboardShortcuts/)
  assert.match(main, /copy\.documentation/)
  assert.match(main, /copy\.feedback/)
  assert.match(main, /copy\.about/)
})
