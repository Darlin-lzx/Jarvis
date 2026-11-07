import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/workbench/api-call-panel.tsx', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/components/layout/sidebar.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../src/components/workbench/workbench-view.tsx', import.meta.url), 'utf8')

test('api call panel switches between page and gateway modes', () => {
  // 两种模式切换（页面接口 / 中台接口，带图标），示例请求体各自预填
  assert.equal(source.includes('data-mode-tab={item}'), true)
  assert.equal(source.includes("['page', '页面接口', Globe]"), true)
  assert.equal(source.includes("['gateway', '中台接口', Server]"), true)
  assert.equal(source.includes('PAGE_BODY_SAMPLE'), true)
  assert.equal(source.includes('GATEWAY_BODY_SAMPLE'), true)
  // Content-Type 随模式展示（JSON / XML）
  assert.equal(source.includes("mode === 'page' ? 'application/json' : 'application/xml'"), true)
})

test('api call page uses postman-style split layout', () => {
  // 左请求 / 右响应两栏（窄屏堆叠），未发送时响应区有占位提示
  assert.equal(source.includes('grid grid-cols-1 items-stretch gap-3 xl:grid-cols-2'), true)
  assert.equal(source.includes('data-api-empty'), true)
  // URL 行带 POST 标记；请求头名称固定宽对齐
  assert.equal(source.includes('font-mono text-[11px] font-semibold text-indigo-300'), true)
  assert.equal(source.includes("w-[100px] shrink-0 truncate font-mono"), true)
  // JSON 模式请求体可一键格式化
  assert.equal(source.includes('data-api-format'), true)
  assert.equal(source.includes('JSON.stringify(JSON.parse(pageBody), null, 2)'), true)
  // 可按当前表单还原 cURL 命令复制
  assert.equal(source.includes('function buildCurl'), true)
  assert.equal(source.includes("replaceAll(\"'\", `'\\\\''`)"), true)
  assert.equal(source.includes('复制 cURL'), true)
})

test('page interface url composes base address and interface code', () => {
  // 服务地址默认 CSF 网关前缀；接口编码可输可选（datalist 下拉）
  assert.equal(source.includes('PAGE_BASE_URL_DEFAULT'), true)
  assert.equal(source.includes('8080-code-server-linzx5-adfbxj.ideserver.fsp.zj.chinamobile.com:32415/csf/'), true)
  assert.equal(source.includes('data-api-base-url'), true)
  assert.equal(source.includes('data-api-code'), true)
  assert.equal(source.includes('list="page-code-options"'), true)
  assert.equal(source.includes('<datalist id="page-code-options">'), true)
  // 完整地址实时预览
  assert.equal(source.includes('data-api-full-url'), true)
  assert.equal(source.includes('（填写接口编码后自动拼接）'), true)
  // 拼接规则：编码填 http 地址则原样用，否则 服务地址 + 编码（自动补 /）
  assert.equal(source.includes('function composePageUrl'), true)
  assert.equal(source.includes("if (/^https?:\\/\\//i.test(trimmedCode)) return trimmedCode"), true)
  assert.equal(source.includes("? trimmedBase + trimmedCode"), true)
  // 下拉候选 = 历史发送记录（最新在前）+ 内置示例
  assert.equal(source.includes('PAGE_CODE_SAMPLES'), true)
  assert.equal(source.includes('digitalFamily_IGoodsDetailsCSV_qryGoodsDetails'), true)
  assert.equal(source.includes('function loadCodeOptions'), true)
  assert.equal(source.includes('function recordCodeUsage'), true)
})

test('api call panel collects mainAcct/token for page interface', () => {
  // 页面接口：mainAcct 和 token 支持输入并随请求转发
  assert.equal(source.includes('data-api-header'), true)
  assert.equal(source.includes('main_acct: pageHeaders.mainAcct'), true)
  assert.equal(source.includes('token: pageHeaders.token'), true)
})

test('api call panel collects gateway auth headers', () => {
  // 中台接口：网关鉴权头（apiVersion/format 有默认值）
  assert.equal(source.includes("apiVersion: '1.0.0'"), true)
  assert.equal(source.includes("format: 'http+xml'"), true)
  assert.equal(source.includes('access_token: gatewayHeaders.accessToken'), true)
  assert.equal(source.includes('api_code: gatewayHeaders.apiCode'), true)
  assert.equal(source.includes('app_code: gatewayHeaders.appCode'), true)
  assert.equal(source.includes('operator_id: gatewayHeaders.operatorId'), true)
})

test('api call panel sends via proxied endpoint with memo', () => {
  // 经后端代理发送 + Ctrl/Cmd+Enter 快捷发送（输入框与请求体共用处理函数）
  assert.equal(source.includes('api.callInterface(payload)'), true)
  assert.equal(source.includes('event.metaKey || event.ctrlKey'), true)
  assert.equal(source.includes('function handleShortcutKey'), true)
  // 本次填写的 URL/请求体/请求头写入 localStorage 记忆
  assert.equal(source.includes('localStorage.setItem(`api-call:${mode}:${key}`, value)'), true)
})

test('api call result shows status, headers and body', () => {
  assert.equal(source.includes('data-api-result'), true)
  assert.equal(source.includes('HTTP {result.status}'), true)
  assert.equal(source.includes('result.elapsed_ms'), true)
  // JSON 响应格式化展示，失败按原文
  assert.equal(source.includes('function formatBody'), true)
})

test('api call menu registered and wired to panel', () => {
  // 侧边栏新分组「接口调试」+ 子项「接口调用」，workbench 渲染面板
  assert.equal(sidebarSource.includes("id: 'apicall'"), true)
  assert.equal(sidebarSource.includes("value: 'apicall'"), true)
  assert.equal(workbenchSource.includes("case 'apicall': return <ApiCallPanel />"), true)
})

test('api call client covers endpoint and types', () => {
  assert.equal(apiSource.includes("request<ApiCallResult>('/api/api-call', 'POST', payload)"), true)
  assert.equal(typesSource.includes('export interface ApiCallRequest'), true)
  assert.equal(typesSource.includes('export interface ApiCallResult'), true)
})
