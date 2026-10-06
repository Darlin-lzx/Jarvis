import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentTabClickHandler } from '../src/lib/agent-assignment.ts'

test('agent tab invokes assignment when enabled', () => {
  let assigned = ''
  const handler = createAgentTabClickHandler({
    id: 'migration_assessor',
    onChange: id => { assigned = id },
    disabled: false,
  })

  handler?.()
  assert.equal(assigned, 'migration_assessor')
})

test('agent tab remains read-only without callback or while streaming', () => {
  assert.equal(createAgentTabClickHandler({
    id: 'migration_assessor',
    disabled: false,
  }), undefined)

  let assigned = ''
  const handler = createAgentTabClickHandler({
    id: 'migration_assessor',
    onChange: id => { assigned = id },
    disabled: true,
  })
  handler?.()
  assert.equal(assigned, '')
})
