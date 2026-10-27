import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const taskPage = read('../src/components/project/task-detail-page.tsx')
const chatView = read('../src/components/chat/chat-view.tsx')

test('task detail no longer exposes the execution chain', () => {
  assert.equal(taskPage.includes('TaskTracePanel'), false)
  assert.equal(taskPage.includes('任务执行链路'), false)
  assert.equal(taskPage.includes('链路日志'), false)
  assert.equal(taskPage.includes('api.getTrace'), false)
})

test('chat no longer renders execution chain steps or timing statistics', () => {
  assert.equal(chatView.includes('kind: \'step\''), false)
  assert.equal(chatView.includes('总耗时'), false)
  assert.equal(chatView.includes('执行链路'), false)
  assert.equal(existsSync(new URL('../src/components/chat/chat-step-panel.tsx', import.meta.url)), false)
  assert.equal(existsSync(new URL('../src/components/project/task-trace-panel.tsx', import.meta.url)), false)
})
