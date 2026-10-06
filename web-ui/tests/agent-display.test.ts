import assert from 'node:assert/strict'
import test from 'node:test'

import { agentDisplayName } from '../src/lib/agent-display.ts'

test('agent display name prefers alias', () => {
  assert.equal(agentDisplayName({ name: '迁移评估', alias: '评估专家' }), '评估专家')
})

test('agent display name falls back to name and placeholder', () => {
  assert.equal(agentDisplayName({ name: '迁移评估', alias: '' }), '迁移评估')
  assert.equal(agentDisplayName(null), '智能体')
  assert.equal(agentDisplayName({}), '智能体')
})
