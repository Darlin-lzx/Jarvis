import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseFileLocation } from '../src/lib/file-location.ts'

test('parses project file references with optional line numbers', () => {
  assert.deepEqual(parseFileLocation('src/main/java/App.java'), {
    path: 'src/main/java/App.java',
  })
  assert.deepEqual(parseFileLocation('order_center/App.java:38'), {
    path: 'order_center/App.java',
    line: 38,
  })
  assert.deepEqual(parseFileLocation('App.java#L128'), {
    path: 'App.java',
    line: 128,
  })
})

test('does not treat URLs or multiline code as file references', () => {
  assert.equal(parseFileLocation('https://example.com/App.java'), null)
  assert.equal(parseFileLocation('App.java\nreturn'), null)
  assert.equal(parseFileLocation('not-a-file'), null)
})
