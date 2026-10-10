import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const hook = readFileSync(
  new URL('../src/hooks/use-chat-stream.ts', import.meta.url),
  'utf8',
)
const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')

test('chat stop notifies the backend before aborting the stream', () => {
  const stop = hook.slice(
    hook.indexOf('const stop = useCallback'),
    hook.indexOf('const send = useCallback'),
  )

  assert.equal(stop.includes('activeConvRef.current'), true)
  assert.equal(stop.includes('api.cancelChat'), true)
  assert.equal(stop.includes('controller?.abort()'), true)
})

test('chat API exposes the server-side cancellation endpoint', () => {
  assert.equal(api.includes("cancelChat: (id: number) =>"), true)
  assert.equal(api.includes("'/api/chat/'"), true)
  assert.equal(api.includes("'/cancel'"), true)
})
