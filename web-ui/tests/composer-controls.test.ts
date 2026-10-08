import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/chat/composer.tsx', import.meta.url), 'utf8')

test('conversation composer has no duplicate agent or skill entry points', () => {
  assert.equal(source.includes('setActiveAgent'), false)
  assert.equal(source.includes('skillGroups'), false)
  assert.equal(source.includes('last_skill'), false)
  assert.equal(source.includes('[技能：'), false)
})
