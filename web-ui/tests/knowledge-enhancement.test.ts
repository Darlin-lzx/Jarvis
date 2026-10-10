import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('knowledge UI uses the unified retrieval contract and provenance', () => {
  const api = read('../src/lib/api.ts')
  const panel = read('../src/components/workbench/kb-panel.tsx')
  const types = read('../src/lib/types.ts')

  assert.equal(api.includes("'/api/knowledge/search'"), true)
  assert.equal(api.includes("'/api/knowledge/feedback'"), true)
  assert.equal(panel.includes('businessDomain'), true)
  assert.equal(panel.includes('confidence'), true)
  assert.equal(panel.includes('source_ref'), true)
  assert.equal(panel.includes('feedbackKnowledge'), true)
  assert.equal(types.includes('interface KnowledgeSearchResult'), true)
})

test('knowledge upload captures classification metadata', () => {
  const panel = read('../src/components/workbench/kb-panel.tsx')

  for (const field of [
    'kb_type', 'business_domain', 'target_db', 'stage', 'object_type',
    'confidence', 'source_ref',
  ]) {
    assert.equal(panel.includes(field), true)
  }
})
