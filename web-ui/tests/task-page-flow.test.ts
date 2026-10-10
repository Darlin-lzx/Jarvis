import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const board = readFileSync(
  new URL('../src/components/migrate/state-board.tsx', import.meta.url),
  'utf8',
)
const trace = readFileSync(
  new URL('../src/components/project/task-trace-panel.tsx', import.meta.url),
  'utf8',
)
const taskPage = readFileSync(
  new URL('../src/components/project/task-detail-page.tsx', import.meta.url),
  'utf8',
)

test('task page renderers derive stages from the configured migrate flow', () => {
  assert.equal(board.includes('boardStagesFromFlow'), true)
  assert.equal(board.includes('getMigrateFlow'), true)
  assert.equal(trace.includes('taskStageDefsFromFlow'), true)
  assert.equal(trace.includes('ddl_converter'), false)
  assert.equal(trace.includes('SQL 转换'), false)
})

test('task trace refreshes whenever task detail polling returns', () => {
  assert.equal(taskPage.includes('useEffect(() => { void loadTraces() }, [detail])'), true)
  assert.equal(taskPage.includes('}, [detail?.sessions?.length])'), false)
})
