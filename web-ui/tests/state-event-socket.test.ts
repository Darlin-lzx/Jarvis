import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('migration socket consumes state events without exposing trace panels', () => {
  const read = (path: string) => readFileSync(path, 'utf8')
  const types = read('src/lib/types.ts')
  const hook = read('src/hooks/use-migrate-state-socket.ts')
  const taskPage = read('src/components/project/task-detail-page.tsx')

  assert.match(types, /MigrateStateEventFrame/)
  assert.match(hook, /state_event/)
  assert.match(hook, /setEvents/)
  assert.equal(taskPage.includes('TaskTracePanel'), false)
})
