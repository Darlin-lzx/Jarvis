import assert from 'node:assert/strict'
import test from 'node:test'

import { isCoreArtifact } from '../src/lib/artifact-filter.ts'
import type { ArtifactItem } from '../src/lib/types.ts'

function artifact(path: string, type = ''): ArtifactItem {
  return {
    id: 1,
    namespace: 'sess_1/agent/task',
    type,
    path,
  }
}

test('historical process files are not core artifacts', () => {
  assert.equal(isCoreArtifact(artifact('/tmp/artifacts/result.json', 'json')), false)
  assert.equal(isCoreArtifact(artifact('/tmp/artifacts/任务索引.md', 'md')), false)
})

test('agent reports and scripts remain visible', () => {
  assert.equal(isCoreArtifact(artifact('/tmp/artifacts/assessment_report.md', 'md')), true)
  assert.equal(isCoreArtifact(artifact('/tmp/artifacts/DDL_ORDER.sql', 'sql')), true)
})
