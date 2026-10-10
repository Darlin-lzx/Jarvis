import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOptions } from '../src/components/chat/ui-form-options.ts'

test('flattens nested option arrays emitted by legacy UI render data', () => {
  assert.deepEqual(
    parseOptions([['本地', '浙江营业库A']]),
    ['本地', '浙江营业库A'],
  )
})

test('keeps object options and removes template placeholders', () => {
  assert.deepEqual(
    parseOptions([
      { label: '本地', value: 'local' },
      '{{system_data_source_list}}',
    ]),
    [{ label: '本地', value: 'local' }],
  )
})
