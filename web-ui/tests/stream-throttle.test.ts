import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/hooks/use-chat-stream.ts', import.meta.url), 'utf8')

test('streaming text updates are throttled and flushed at stream end', () => {
  assert.equal(source.includes('scheduleAssistantText(fullText)'), true)
  assert.equal(source.includes('setAssistantText(fullText)'), false)
  assert.equal(source.includes('STREAM_UI_INTERVAL_MS = 80'), true)
  assert.equal(source.includes('flushAssistantText(true)'), true)
})
