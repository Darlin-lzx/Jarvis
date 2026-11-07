import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/workbench/sql-panel.tsx', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')

test('sql panel loads datasource-bound library file on select', () => {
  assert.equal(source.includes('data-sql-library'), true)
  assert.equal(source.includes('api.getSqlLibraryFile(datasource)'), true)
  assert.equal(source.includes('setLibraryExists(response.data.exists)'), true)
  // 未绑定文件 → 提供新建入口（写入示例模板并进入编辑）
  assert.equal(source.includes('新建 {datasource}.sql'), true)
  assert.equal(source.includes('NEW_LIBRARY_TEMPLATE'), true)
})

test('sql library entries execute with param substitution and memory', () => {
  assert.equal(source.includes('data-sql-library-item'), true)
  // 含 {param} → 参数弹窗（空值拦截）；不含 → 直接回填执行
  assert.equal(source.includes('data-sql-param-dialog'), true)
  assert.equal(source.includes('data-sql-param-input'), true)
  assert.equal(source.includes('data-sql-param-run'), true)
  assert.equal(source.includes('参数不能为空'), true)
  assert.equal(source.includes('sqlText.replaceAll(`{${key}}`, value)'), true)
  // 参数记忆：数据源+条目+参数名 → localStorage 记住上次填的值
  assert.equal(source.includes('localStorage.getItem(paramMemoKey(entry.name, param))'), true)
  assert.equal(source.includes('localStorage.setItem(paramMemoKey(entry.name, key), value)'), true)
  // 点选执行与手输执行共用 run 通道（支持 SQL 覆盖入参）
  assert.equal(source.includes('async function run(sqlOverride?: string)'), true)
  assert.equal(source.includes('api.queryDatasource(datasource, sqlText, limit)'), true)
})

test('sql library file editor saves via PUT api', () => {
  assert.equal(source.includes('data-sql-library-editor'), true)
  assert.equal(source.includes('data-sql-library-save'), true)
  assert.equal(source.includes('api.saveSqlLibraryFile(datasource, fileContent)'), true)
  // 保存成功后用返回的解析条目刷新列表
  assert.equal(source.includes('setEntries(response.data.entries)'), true)
})

test('sql api client covers library endpoints and types', () => {
  assert.equal(apiSource.includes("listSqlLibrary: () => request<SqlLibraryItem[]>('/api/sql-library')"), true)
  assert.equal(apiSource.includes('`/api/sql-library/${encodeURIComponent(datasource)}`'), true)
  assert.equal(typesSource.includes('export interface SqlLibraryEntry'), true)
  assert.equal(typesSource.includes('export interface SqlLibraryFile'), true)
  assert.equal(typesSource.includes('export interface SqlLibraryItem'), true)
})
