import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/chat/chat-view.tsx', import.meta.url),
  'utf8',
)

test('advancing a stage triggers the next chat run instead of only changing status', () => {
  const doAdvance = source.slice(
    source.indexOf('const doAdvance'),
    source.indexOf('/** 切换逐级确认开关'),
  )

  assert.equal(doAdvance.includes("r.data.advanced"), true)
  assert.equal(
    doAdvance.includes(
      "handleSend('开始执行', { skip_state_advance: true }, 'migration_commander')",
    ),
    true,
  )
})
