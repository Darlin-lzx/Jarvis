import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/migrate/flow-board.tsx', import.meta.url),
  'utf8',
)

test('migrate flow board aligns every stage with its graph agent node', () => {
  for (const [stage, agent] of [
    ['DATA_COLLECTION', 'migration_collector'],
    ['ASSESSMENT_RUNNING', 'migration_assessor'],
    ['SOLUTION_GENERATE', 'migration_planner'],
    ['CODE_MIGRATE', 'code_migrator'],
    ['VERIFY_STAGE', 'migration_verifier'],
  ] as const) {
    assert.equal(source.includes(`'${stage}': { agent`), true)
    assert.equal(source.includes(`agentId: '${agent}'`), true)
  }
  assert.equal(source.includes('STAGE_AGENT_META'), true)
  assert.equal(source.includes('stageAgent.agentId'), true)
  assert.equal(source.includes('stageAgent.alias'), true)
})
