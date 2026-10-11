import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const panel = readFileSync('src/components/chat/workspace-panel.tsx', 'utf8')

test('workspace preview renders as a fullscreen overlay', () => {
  assert.match(panel, /role="dialog"\s+aria-modal="true"/)
  assert.match(panel, /fixed inset-0 z-\[120\] flex flex-col/)
  assert.match(panel, /aria-label="关闭预览"/)
  assert.match(panel, /min-h-0 flex-1 overflow-auto/)
  assert.doesNotMatch(panel, /h-\[48%\]/)
})

test('fullscreen preview preserves line targeting and horizontal scrolling', () => {
  assert.match(panel, /data-line=\{index \+ 1\}/)
  assert.match(panel, /previewLine === index \+ 1/)
  assert.match(panel, /whitespace-pre/)
  assert.doesNotMatch(panel, /whitespace-pre-wrap break-words/)
})

test('fullscreen preview closes with Escape', () => {
  assert.match(panel, /event\.key === 'Escape'/)
  assert.match(panel, /window\.addEventListener\('keydown', closePreview\)/)
  assert.match(panel, /window\.removeEventListener\('keydown', closePreview\)/)
})
