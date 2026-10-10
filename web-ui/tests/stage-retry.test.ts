import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const board = readFileSync(
  new URL('../src/components/migrate/state-board.tsx', import.meta.url),
  'utf8',
)
const chat = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8',
)
const taskPage = readFileSync(
  new URL('../src/components/project/task-detail-page.tsx', import.meta.url),
  'utf8',
)

test('migration stage retry is exposed as a dedicated API', () => {
  assert.equal(api.includes('retryMigrateTaskStage'), true)
  assert.equal(api.includes("'/api/migrate/tasks/' + id + '/retry-stage'"), true)
})

test('stage board renders retry controls for executable nodes', () => {
  assert.equal(board.includes('onRetryStage?: (stage: string) => void'), true)
  assert.equal(board.includes('showRetry'), true)
  assert.equal(board.includes('重新执行'), true)
  assert.equal(board.includes("s.keys.includes('FINISHED')"), true)
})

test('chat retry resets the node and immediately reruns the commander', () => {
  const doRetry = chat.slice(
    chat.indexOf('const doRetryStage'),
    chat.indexOf('/** 切换逐级确认开关'),
  )

  assert.equal(doRetry.includes('retryMigrateTaskStage'), true)
  assert.equal(
    doRetry.includes(
      "handleSend('开始执行', { skip_state_advance: true }, 'migration_commander')",
    ),
    true,
  )
  assert.equal(chat.includes('onRetryStage={doRetryStage}'), true)
})

test('task page can rerun one stage without entering the conversation first', () => {
  assert.equal(taskPage.includes('const doRetryStage'), true)
  assert.equal(taskPage.includes('api.runMigrationStage'), true)
  assert.equal(taskPage.includes('onRetryStage={doRetryStage}'), true)
})
