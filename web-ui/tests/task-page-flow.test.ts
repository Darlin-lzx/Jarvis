import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const board = readFileSync(
  new URL('../src/components/migrate/state-board.tsx', import.meta.url),
  'utf8',
)
const taskPage = readFileSync(
  new URL('../src/components/project/task-detail-page.tsx', import.meta.url),
  'utf8',
)

test('task page renderers derive stages from the configured migrate flow', () => {
  assert.equal(board.includes('boardStagesFromFlow'), true)
  assert.equal(board.includes('getMigrateFlow'), true)
  assert.equal(taskPage.includes('StateBoard'), true)
  assert.equal(taskPage.includes('TaskTracePanel'), false)
})

test('task page does not expose an execution trace panel', () => {
  assert.equal(taskPage.includes('loadTraces'), false)
  assert.equal(taskPage.includes('任务执行链路'), false)
})
