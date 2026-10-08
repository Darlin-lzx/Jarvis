import assert from 'node:assert/strict'
import test from 'node:test'

import { isVisibleSystemTrace } from '../src/lib/trace-filter.ts'

test('stage block traces stay internal', () => {
  assert.equal(isVisibleSystemTrace({ event: 'stage_blocked', message: '状态机拦截' }), false)
})

test('ordinary system traces remain visible', () => {
  assert.equal(isVisibleSystemTrace({ event: 'calling_agent', message: '正在调用小采' }), true)
  assert.equal(isVisibleSystemTrace({ message: '系统提示' }), true)
})
