import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8',
)

test('advance failures use an in-app dialog instead of a browser alert', () => {
  assert.equal(source.includes('window.alert'), false)
  assert.equal(source.includes('role="dialog"'), true)
  assert.equal(source.includes('aria-modal="true"'), true)
  assert.equal(source.includes('阶段推进提示'), true)
  assert.equal(source.includes('我知道了'), true)
  assert.equal(source.includes('CircleAlert'), true)
  assert.equal(source.includes('backdrop-blur-sm'), true)
})
