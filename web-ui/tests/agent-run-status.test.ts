import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const chatView = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8'
)
const traceFilter = readFileSync(
  new URL('../src/lib/trace-filter.ts', import.meta.url),
  'utf8'
)

test('finished agent status replaces stale calling status', () => {
  assert.equal(chatView.includes('isFinishedAgentTrace'), true)
  assert.equal(chatView.includes("event === 'calling_agent'"), true)
  assert.equal(traceFilter.includes('agent_finished'), true)
})

test('assistant reply is committed before artifact cards', () => {
  assert.match(chatView, /const runItems[\s\S]*?const artifactItems/)
  const assistantPush = chatView.indexOf('next.push({')
  const artifactPush = chatView.indexOf('next.push(...artifactItems)')
  assert.ok(assistantPush >= 0 && artifactPush > assistantPush)
})
