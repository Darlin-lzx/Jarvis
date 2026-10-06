import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/chat/composer.tsx', import.meta.url), 'utf8')
const lucideImport = source.match(/import\s+\{([^}]+)\}\s+from\s+'lucide-react'/)
const importedIcons = new Set((lucideImport?.[1] || '')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean))
const usedIcons = [...source.matchAll(/<([A-Z][A-Za-z0-9]*)(?:\s|\/>)/g)]
  .map(match => match[1])
  .filter(name => name !== 'Button' && name !== 'Textarea' && name !== 'ReferencePicker')

test('composer renders only imported lucide icons', () => {
  const missing = [...new Set(usedIcons)].filter(name => !importedIcons.has(name))
  assert.deepEqual(missing, [])
})
