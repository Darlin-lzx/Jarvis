import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('sidebar omits the default conversation directory', () => {
  const source = read('../src/components/layout/sidebar.tsx')

  assert.equal(source.includes('默认会话'), false)
  assert.equal(source.includes('api.getDefaultSpace()'), false)
  assert.equal(source.includes('tempSpace'), false)
})
