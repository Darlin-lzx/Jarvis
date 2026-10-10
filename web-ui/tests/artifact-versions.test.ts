import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('artifact version and diff APIs are wired into the delivery panel', () => {
  const read = (path: string) => readFileSync(path, 'utf8')
  const types = read('src/lib/types.ts')
  const api = read('src/lib/api.ts')
  const panel = read('src/components/chat/delivery-panel.tsx')

  assert.match(types, /version\?: number/)
  assert.match(api, /listArtifactVersions/)
  assert.match(api, /getArtifactVersion/)
  assert.match(api, /diffArtifact/)
  assert.match(panel, /版本历史/)
  assert.match(panel, /差异对比/)
  assert.match(panel, /diffBlocks/)
})
