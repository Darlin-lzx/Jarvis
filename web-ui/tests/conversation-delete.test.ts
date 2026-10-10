import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const panel = readFileSync(
  new URL('../src/components/workbench/conversations-panel.tsx', import.meta.url),
  'utf8',
)
const taskPage = readFileSync(
  new URL('../src/components/project/task-detail-page.tsx', import.meta.url),
  'utf8',
)

test('conversation panel keeps the dialog open when deletion fails', () => {
  const singleDelete = panel.slice(
    panel.indexOf('const handleDelete = async'),
    panel.indexOf('const handleRestore'),
  )

  assert.equal(singleDelete.includes('const r = await api.deleteConversation'), true)
  assert.equal(singleDelete.includes('if (!r.success)'), true)
  const failureBranch = singleDelete.slice(
    singleDelete.indexOf('if (!r.success)'),
    singleDelete.indexOf('setDeleteTarget(null)'),
  )
  assert.equal(failureBranch.includes('window.alert'), true)
  assert.equal(failureBranch.includes('return'), true)
})

test('conversation panel batch delete validates every API response', () => {
  const batchDelete = panel.slice(
    panel.indexOf('const handleBatchDelete'),
    panel.indexOf('const handleDelete = async'),
  )

  assert.equal(batchDelete.includes('const results = await Promise.all'), true)
  assert.equal(batchDelete.includes('r.success'), true)
  assert.equal(batchDelete.includes('window.alert'), true)
})

test('clearing task sessions stops on the first failed deletion', () => {
  const clearSessions = taskPage.slice(
    taskPage.indexOf('const clearSessions'),
    taskPage.indexOf('// 删除单个会话'),
  )

  assert.equal(clearSessions.includes('const r = await api.deleteConversation'), true)
  assert.equal(clearSessions.includes('if (!r.success)'), true)
  assert.equal(clearSessions.includes('return'), true)
  assert.equal(clearSessions.includes('setMoreOpen(false)'), true)
})
