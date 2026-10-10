import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/settings/settings-dialog.tsx', import.meta.url),
  'utf8',
)

test('settings dialog supports the Zhipu GLM provider', () => {
  assert.equal(source.includes('value="zhipu"'), true)
  assert.equal(source.includes('智谱 GLM'), true)
})
