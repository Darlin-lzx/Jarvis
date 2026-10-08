import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const chatView = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8',
)
const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')

test('chat exposes an independent strict-flow toggle backed by task API', () => {
  assert.equal(types.includes('strict_flow?: boolean'), true)
  assert.equal(
    api.includes("request<MigrateTaskDetail>(`/api/migrate/tasks/${id}/strict-flow`"),
    true,
  )
  assert.equal(chatView.includes('流程强校验'), true)
  assert.equal(chatView.includes('toggleStrictFlow'), true)
})
