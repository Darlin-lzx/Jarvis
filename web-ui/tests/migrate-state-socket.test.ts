import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const hook = readFileSync(
  new URL('../src/hooks/use-migrate-state-socket.ts', import.meta.url),
  'utf8',
)
const taskPage = readFileSync(
  new URL('../src/components/project/task-detail-page.tsx', import.meta.url),
  'utf8',
)
const chat = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8',
)
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

test('migrate state socket merges snapshots and falls back to polling', () => {
  assert.match(hook, /export function useMigrateStateSocket/)
  assert.match(hook, /new WebSocket\(migrateSocketUrl\(taskId\)\)/)
  assert.match(hook, /const fallbackTimer = setInterval\(\(\) => refreshRef.current\?\.\(\), 5000\)/)
  assert.match(hook, /setSnapshot\(message\)/)
})

test('task and chat state boards consume websocket snapshots', () => {
  assert.match(taskPage, /useMigrateStateSocket\(migrateDetail\?\.task_id, load\)/)
  assert.match(chat, /useMigrateStateSocket\(migrateDetail\?\.task_id, refreshMigrateDetail\)/)
  assert.match(vite, /'\/ws'/)
})

test('pages merge websocket snapshots into migrate detail', () => {
  assert.match(taskPage, /mergeMigrateSnapshot\(migrateDetail, migrateSocket\.snapshot\)/)
  assert.match(chat, /mergeMigrateSnapshot\(migrateDetail, migrateSocket\.snapshot\)/)
})
