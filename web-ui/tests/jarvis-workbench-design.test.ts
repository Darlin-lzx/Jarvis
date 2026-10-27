import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('Jarvis workbench uses the approved command deck design', () => {
  const component = read('src/components/workbench/jarvis-workbench.tsx')
  const css = read('src/components/workbench/jarvis-workbench.css')

  assert.match(component, /JARVIS/)
  assert.match(component, /AGENT FLEET/)
  assert.match(component, /KNOWLEDGE/)
  assert.match(css, /jarvis-hud-bg\.png/)
  assert.match(css, /scanline/)
  assert.match(css, /--jarvis-cyan/)
  assert.equal(existsSync('public/jarvis-hud-bg.png'), true)
  assert.equal(component.includes('数据库迁移'), false)
  assert.equal(component.includes('国产库迁移'), false)
})

test('Jarvis commands stay in the embedded workbench console', () => {
  const app = read('src/App.tsx')
  const view = read('src/components/workbench/workbench-view.tsx')
  const workbench = read('src/components/workbench/jarvis-workbench.tsx')

  assert.match(app, /jarvisConvId/)
  assert.match(app, /ensureJarvisConversation/)
  assert.match(view, /jarvisConvId=/)
  assert.match(workbench, /<JarvisConsole/)
  assert.equal(app.includes('handleJarvisCommand'), false)
  assert.equal(app.includes('setPendingCommand'), false)
  assert.equal(workbench.includes('onCommand?'), false)
})
