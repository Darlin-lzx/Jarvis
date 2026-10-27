import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sidebar = readFileSync(new URL('../src/components/layout/sidebar.tsx', import.meta.url), 'utf8')

test('sidebar does not render the top-left new conversation control', () => {
  assert.equal(sidebar.includes('title="新建会话"'), false)
  assert.equal(sidebar.includes('新建会话'), false)
})
