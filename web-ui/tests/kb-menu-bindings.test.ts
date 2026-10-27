import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('knowledge base list is backed by independent KB bindings', () => {
  const panel = read('src/components/workbench/kb-panel.tsx')
  const types = read('src/lib/types.ts')
  const api = read('src/lib/api.ts')

  assert.match(panel, /api\.listKbs\(\)/)
  assert.match(panel, /api\.createKb\(/)
  assert.match(panel, /api\.deleteKb\(/)
  assert.match(panel, /bound_agent_names/)
  assert.match(panel, /绑定智能体/)
  assert.match(types, /bound_agent_ids\?: string\[\]/)
  assert.match(types, /bound_agent_names\?: string\[\]/)
  assert.match(api, /createKb: \(payload: \{ name: string; description\?: string \}\)/)
})
