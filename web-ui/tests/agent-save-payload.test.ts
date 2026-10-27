import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAgentSavePayload } from '../src/lib/agent-save.ts'

test('agent save payload includes bound knowledge bases', () => {
  const payload = buildAgentSavePayload({
    name: '页面展示专家',
    alias: '小前',
    projectDir: '/tmp/boot',
    description: '页面',
    prompt: '提示词',
    enabled: true,
    systemRolePromptId: '3',
    type: '子Agent',
    tools: ['代码生成'],
    boundKBs: ['boot知识库'],
  })

  assert.equal(payload.bound_kbs.length, 1)
  assert.equal(payload.bound_kbs[0], 'boot知识库')
})
