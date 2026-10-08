import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const chatView = readFileSync(new URL('../src/components/chat/chat-view.tsx', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../src/components/chat/composer.tsx', import.meta.url), 'utf8')
const message = readFileSync(new URL('../src/components/chat/message.tsx', import.meta.url), 'utf8')
const welcomePage = readFileSync(new URL('../src/components/chat/welcome-page.tsx', import.meta.url), 'utf8')

test('composer width is halved while user bubbles and chat layout stay unchanged', () => {
  assert.equal(
    message.includes('rounded-tr-sm px-4 py-2 max-w-[80%]'),
    true
  )
  assert.equal(composer.includes('w-full max-w-[48rem] mx-auto'), true)
  assert.equal(composer.includes('max-w-[1792px]'), false)
  assert.equal(welcomePage.includes('w-full max-w-[42rem] mx-auto'), true)
  assert.equal(welcomePage.includes('max-w-2xl mx-auto'), false)
  assert.equal(chatView.includes('max-w-[1792px]'), false)
  assert.equal(chatView.includes('max-w-3xl mx-auto w-full'), true)
})
