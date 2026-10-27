import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  chunkXmlContent, buildWorkflowInsertSql, formatSqlDateTime, formatSqlDate,
  CONTENT_CHUNK_SIZE, CONTENT_CHUNK_COUNT,
} from '../src/components/workbench/workflow-sql-export.ts'

const BASE_INPUT = {
  templateVersionId: '1789959874520',
  orderNum: '5',
  templateTag: 'com.ai.order.workflow.shedule.vm.DefaultGsmYdkjNewWFSchedule',
  createStaffId: '103747',
  createDate: '2026-10-09 19:36:10.000',
  modifyDesc: '紧凑中轴等距布局',
  validDate: '2026-10-09 00:00:00.000',
  expireDate: '2099-12-31 00:00:00.000',
}

test('chunkXmlContent splits by utf-8 code points without breaking multibyte chars', () => {
  assert.deepEqual(chunkXmlContent('abc', 2), ['ab', 'c'])
  // 中文与 emoji（代理对）都不会被切断，块大小按码点计算
  const text = '中'.repeat(CONTENT_CHUNK_SIZE) + '😀中'
  const chunks = chunkXmlContent(text)
  assert.equal(chunks.length, 2)
  assert.equal(Array.from(chunks[0]).length, CONTENT_CHUNK_SIZE)
  assert.equal(chunks[1], '😀中')
  assert.equal(chunks.join(''), text)
})

test('buildWorkflowInsertSql escapes single quotes and pads unused content columns with NULL', () => {
  const xml = `<workflow label="it's">\n</workflow>`
  const result = buildWorkflowInsertSql({ ...BASE_INPUT, xml })
  assert.ok('sql' in result)
  const sql = (result as { sql: string }).sql
  assert.ok(sql.includes(`<workflow label="it''s">`))
  assert.equal((sql.match(/NULL/g) ?? []).length, CONTENT_CHUNK_COUNT - 1)
  assert.ok(sql.endsWith('NULL);\n'))
  assert.ok(sql.startsWith('INSERT INTO aif_comframe.vm_template_version (template_version_id,order_num,template_tag,create_staff_id,create_date,modify_desc,valid_date,expire_date,"content",content1,'))
})

test('buildWorkflowInsertSql rejects oversized xml beyond 16 chunks', () => {
  const xml = 'x'.repeat(CONTENT_CHUNK_SIZE * CONTENT_CHUNK_COUNT + 1)
  const result = buildWorkflowInsertSql({ ...BASE_INPUT, xml })
  assert.ok('error' in result)
  assert.match((result as { error: string }).error, /超过 64000 字符/)
})

test('buildWorkflowInsertSql validates tag and xml presence', () => {
  assert.ok('error' in buildWorkflowInsertSql({ ...BASE_INPUT, templateTag: ' ' }))
  assert.ok('error' in buildWorkflowInsertSql({ ...BASE_INPUT, xml: '  ' }))
})

test('buildWorkflowInsertSql targets configured table for local jarvis database', () => {
  const result = buildWorkflowInsertSql({
    ...BASE_INPUT, xml: '<workflow />', table: 'vm_template_version',
  })
  assert.ok('sql' in result)
  assert.ok((result as { sql: string }).sql.startsWith('INSERT INTO vm_template_version ('))
  const remote = buildWorkflowInsertSql({ ...BASE_INPUT, xml: '<workflow />' })
  assert.ok((remote as { sql: string }).sql.startsWith('INSERT INTO aif_comframe.vm_template_version ('))
})

test('generated sql reproduces the existing hand-made export file content and shape', () => {
  const original = readFileSync(
    new URL('../../file/vm_template_version_no_decision_no_shell_ordered.sql', import.meta.url),
    'utf8',
  )
  const firstNewline = original.indexOf('\n')
  const sqlPart = original.slice(firstNewline + 1)

  const literals = [...sqlPart.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1])
  const [tag, staff, createDate, modifyDesc, validDate, expireDate] = literals.slice(0, 6)
  const xml = literals.slice(6).map(chunk => chunk.replace(/''/g, "'")).join('')

  const result = buildWorkflowInsertSql({
    templateVersionId: '1789959874520',
    orderNum: '5',
    templateTag: tag,
    createStaffId: staff,
    createDate,
    modifyDesc,
    validDate,
    expireDate,
    xml,
  })
  assert.ok('sql' in result)
  const sql = (result as { sql: string }).sql

  // 头部字段与尾部 NULL 填充格式与既有文件一致
  assert.ok(sql.startsWith(
    `INSERT INTO aif_comframe.vm_template_version (template_version_id,order_num,template_tag,create_staff_id,create_date,modify_desc,valid_date,expire_date,"content",content1,content2,content3,content4,content5,content6,content7,content8,content9,content10,content11,content12,content13,content14,content15) VALUES\n\t(1789959874520,5,'${tag}','${staff}','${createDate}','${modifyDesc}','${validDate}','${expireDate}',\n`,
  ))
  assert.ok(sql.endsWith('NULL,\nNULL,\nNULL,\nNULL,\nNULL,\nNULL,\nNULL,\nNULL,\nNULL,\nNULL,\nNULL);\n'))

  // 再从生成的 SQL 里抽回全部字面量：内容往返无损、每块 ≤ 4000 码点
  const regenerated = [...sql.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1])
  assert.equal(regenerated.slice(6).map(chunk => chunk.replace(/''/g, "'")).join(''), xml)
  for (const chunk of chunkXmlContent(xml)) {
    assert.ok(Array.from(chunk).length <= CONTENT_CHUNK_SIZE)
  }
  assert.equal((sql.match(/NULL/g) ?? []).length, CONTENT_CHUNK_COUNT - chunkXmlContent(xml).length)
})

test('format helpers produce database datetime style', () => {
  const date = new Date(2026, 9, 14, 9, 5, 3, 12)
  assert.equal(formatSqlDateTime(date), '2026-10-14 09:05:03.012')
  assert.equal(formatSqlDate(date), '2026-10-14 00:00:00.000')
})
