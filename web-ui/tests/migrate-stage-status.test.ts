import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const board = readFileSync(
  new URL('../src/components/migrate/state-board.tsx', import.meta.url),
  'utf8',
)
const chat = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8',
)
const types = readFileSync(
  new URL('../src/lib/types.ts', import.meta.url),
  'utf8',
)

test('stage board marks the active stage done once its agent finishes', () => {
  assert.equal(board.includes('currentStageExecutionDone'), true)
  assert.match(board, /step_status[^\n]+'done'[^\n]+'waiting_confirm'/)
  assert.equal(board.includes('current_step'), true)
  assert.equal(types.includes('step_status?:'), true)
  assert.equal(types.includes('current_step?:'), true)
})

test('compact chat progress uses the same stage execution state', () => {
  assert.equal(chat.includes('currentStageExecutionDone(liveMigrateDetail, boardStages)'), true)
})

test('chat refreshes task detail after the stream commits artifacts', () => {
  assert.equal(chat.includes('const refreshMigrateDetail'), true)
  assert.equal(chat.includes('void refreshMigrateDetail()'), true)
})
