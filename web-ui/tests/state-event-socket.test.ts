import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('migration socket consumes state events and task page exposes global trace', () => {
  const read = (path: string) => readFileSync(path, 'utf8')
  const types = read('src/lib/types.ts')
  const hook = read('src/hooks/use-migrate-state-socket.ts')
  const taskPage = read('src/components/project/task-detail-page.tsx')
  const tracePanel = read('src/components/project/task-trace-panel.tsx')

  assert.match(types, /MigrateStateEventFrame/)
  assert.match(hook, /state_event/)
  assert.match(hook, /setEvents/)
  assert.match(taskPage, /trace_id/)
  assert.match(tracePanel, /全局追踪/)
})
