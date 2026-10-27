import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/workbench/datasources-panel.tsx', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')

test('datasource connectivity test judges data.ok instead of success', () => {
  // 连接失败时后端返回 200 + success:true + data.ok:false，只判 success 会永远显示可达
  assert.equal((source.match(/r\.success && data\?\.ok/g) ?? []).length, 2)
  assert.equal(source.includes("msg: data?.message || '可达'"), true)
  assert.equal(source.includes("|| r.detail || '不可达'"), true)
  assert.equal(source.includes('JSON.stringify(r.data'), false)
  assert.equal(apiSource.includes('testDatasource: async (name: string): Promise<ApiResponse<DatasourceTestResult>>'), true)
  assert.equal(typesSource.includes('export interface DatasourceTestResult'), true)
})

test('datasource edit form backfills port, database and password from location', () => {
  // location host:port/database 拆开回填：端口不再带 /order4，库名进「服务名/数据库名」
  assert.equal(source.includes("const DB_KINDS = ['Oracle', 'OceanBase', 'MySQL', 'PostgreSQL', 'Excel']"), true)
  assert.equal(
    source.includes("const [hostPort = '', database = ''] = isExcel ? [] : (ds.location || '').split('/')"),
    true)
  assert.equal(source.includes("const [host, port] = hostPort.split(':')"), true)
  assert.equal(source.includes("password: ds.password || ''"), true)
  assert.equal(source.includes("DB_KINDS.find(item => item.toLowerCase() === ds.kind)"), true)
  // 保存时把库名拼回 location，避免编辑丢失 /ordercb
  assert.equal(source.includes('const location = form.database.trim() ? `${base}/${form.database.trim()}` : base'), true)
  // 密码可切换明文查看
  assert.equal(source.includes("type={showPassword ? 'text' : 'password'}"), true)
  assert.equal(source.includes('setShowPassword'), true)
  assert.equal(source.includes('<EyeOff'), true)
})
