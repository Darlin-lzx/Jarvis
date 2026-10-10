import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boardStagesFromFlow,
  taskStageDefsFromFlow,
} from '../src/components/migrate/flow-stages.ts'

test('task page board follows configured migrate flow order', () => {
  const stages = boardStagesFromFlow([
    { sort_order: 0, status: 'VERIFY_STAGE', label: '先验证', description: '', need_confirm: true, required_fields: [], enabled: true },
    { sort_order: 1, status: 'DATA_COLLECTION', label: '后采集', description: '', need_confirm: true, required_fields: [], enabled: true },
    { sort_order: 2, status: 'FINISHED', label: '完成', description: '', need_confirm: false, required_fields: [], enabled: true },
  ])

  assert.deepEqual(stages.map(s => s.keys[0]), [
    'VERIFY_STAGE',
    'DATA_COLLECTION',
    'FINISHED',
  ])
  assert.deepEqual(stages.map(s => s.label), ['先验证', '后采集', '完成'])
})

test('task trace stages use current graph agents and skip disabled nodes', () => {
  const stages = taskStageDefsFromFlow([
    { sort_order: 0, status: 'DATA_COLLECTION', label: '数据采集', description: '', need_confirm: true, required_fields: [], enabled: true },
    { sort_order: 1, status: 'ASSESSMENT_RUNNING', label: '迁移评估', description: '', need_confirm: true, required_fields: [], enabled: true },
    { sort_order: 2, status: 'SOLUTION_GENERATE', label: '迁移方案', description: '', need_confirm: true, required_fields: [], enabled: false },
    { sort_order: 3, status: 'CODE_MIGRATE', label: '代码改造', description: '', need_confirm: true, required_fields: [], enabled: true },
    { sort_order: 4, status: 'VERIFY_STAGE', label: '迁移验证', description: '', need_confirm: true, required_fields: [], enabled: true },
    { sort_order: 5, status: 'FINISHED', label: '完成', description: '', need_confirm: false, required_fields: [], enabled: true },
  ])

  assert.deepEqual(stages.map(s => s.id), [
    'DATA_COLLECTION',
    'ASSESSMENT_RUNNING',
    'CODE_MIGRATE',
    'VERIFY_STAGE',
    'FINISHED',
  ])
  assert.deepEqual(stages.map(s => s.agentId), [
    'migration_collector',
    'migration_assessor',
    'code_migrator',
    'migration_verifier',
    'migration_commander',
  ])
  assert.equal(stages.some(s => s.agentId === 'ddl_converter'), false)
})
