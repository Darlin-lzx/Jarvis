import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/workbench/analysis-panel.tsx', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')
const workbenchSource = readFileSync(
  new URL('../src/components/workbench/workbench-view.tsx', import.meta.url),
  'utf8',
)
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(
  new URL('../src/components/layout/sidebar.tsx', import.meta.url),
  'utf8',
)

test('analysis panel is reachable from sidebar data analysis group', () => {
  assert.equal(sidebarSource.includes("id: 'analysis',"), true)
  assert.equal(sidebarSource.includes("label: '数据分析',"), true)
  assert.equal(sidebarSource.includes("value: 'analysis', label: '数据查询', icon: Activity"), true)
  assert.equal(appSource.includes("'workflows', 'analysis']"), true)
  assert.equal(workbenchSource.includes("import { AnalysisPanel } from './analysis-panel'"), true)
  assert.equal(workbenchSource.includes("case 'analysis': return <AnalysisPanel />"), true)
})

test('analysis api client covers engine and family-order endpoints', () => {
  assert.equal(apiSource.includes('listAnalysisCenters: async (): Promise<ApiResponse<AnalysisCenterInfo[]>>'), true)
  assert.equal(apiSource.includes('queryAnalysisScene: async (centerCode: string, payload: {'), true)
  assert.equal(apiSource.includes('queryAnalysisNode: async (centerCode: string, payload: {'), true)
  assert.equal(apiSource.includes('getAnalysisWorkflow: async (params: {'), true)
  assert.equal(apiSource.includes("getAnalysisMessage: async (kind: 'wired-message' | 'billing-message' | 'stage-reply',"), true)
  assert.equal(apiSource.includes("'/api/analysis/centers'"), true)
  assert.equal(apiSource.includes('`/api/analysis/${encodeURIComponent(centerCode)}/query`'), true)
  assert.equal(apiSource.includes('`/api/analysis/family-order/workflow?${search}`'), true)
  assert.equal(typesSource.includes('export interface AnalysisSceneResult'), true)
  assert.equal(typesSource.includes('export interface AnalysisNodeResult'), true)
  assert.equal(typesSource.includes('export interface AnalysisWorkflowResult'), true)
})

test('analysis panel queries by center scene and transit mode', () => {
  assert.equal(source.includes('data-analysis-panel'), true)
  assert.equal(source.includes('data-center-tabs'), true)
  assert.equal(source.includes('data-transit-toggle'), true)
  assert.equal(source.includes('data-scene-tabs'), true)
  assert.equal(source.includes('api.listAnalysisCenters()'), true)
  assert.equal(source.includes('api.queryAnalysisScene(centerCode, {'), true)
  assert.equal(source.includes("scene_code: 'order_info',"), true)
  assert.equal(source.includes('history_month: inTransit ? \'\' : historyMonth,'), true)
  assert.equal(source.includes('请输入业务主键'), true)
  assert.equal(source.includes('总耗时'), true)
})

test('analysis panel restores state from module snapshot after remount', () => {
  assert.equal(source.includes('let analysisSnapshot: Partial<AnalysisSnapshot> = {}'), true)
  assert.equal(source.includes('interface AnalysisSnapshot'), true)
  assert.equal(source.includes("analysisSnapshot.businessKey ?? ''"), true)
  assert.equal(source.includes('analysisSnapshot.sceneCache ?? {}'), true)
  assert.equal(source.includes('analysisSnapshot.workflowResult ?? null'), true)
  assert.equal(source.includes('快照已有配置，无需重拉'), true)
  // 每次渲染后同步快照，切走菜单（组件卸载）时数据留在模块变量里
  assert.match(source, /useEffect\(\(\) => \{\s*analysisSnapshot = \{/)
})

test('analysis panel supports live work order query and message dialogs', () => {
  assert.equal(source.includes("node_code: 'work_order',"), true)
  assert.equal(source.includes('api.queryAnalysisNode(centerCode, {'), true)
  assert.equal(source.includes('queryLiveWorkOrder'), true)
  assert.equal(source.includes('点击行实时查询工单'), true)
  assert.equal(source.includes('订单项统计：'), true)
  assert.equal(source.includes('itemTypeStats'), true)
  assert.equal(source.includes('MessageDialog'), true)
  assert.equal(source.includes("key: 'SEND_TO_IMEP', label: '送 IMEP 报文'"), true)
  assert.equal(source.includes("key: 'billing', label: '计费报文'"), true)
  assert.equal(source.includes("key: 'stage', label: '阶段性回复'"), true)
  assert.equal(source.includes('data-message-result'), true)
  assert.equal(source.includes('prettyContent'), true)
})

test('analysis workflow tab collects scheduler ids from order info scene', () => {
  assert.equal(source.includes('schedulerIdsFromCache'), true)
  assert.equal(source.includes("node_code === 'scheduler_order'"), true)
  assert.equal(source.includes('values.scheduler_order_id'), true)
  assert.equal(source.includes('data-workflow-results'), true)
})

test('product center shows product config tab only with minimal form', () => {
  // 产品中心挂「档次配置」「策划配置」两个 tab；工作流/异步流程 tab 仅保留在家庭订单中心
  assert.equal(source.includes("const PRODUCT_CENTER_CODE = 'product_center'"), true)
  assert.equal(source.includes('? [PRODUCT_CONFIG_SCENE, PLAN_CONFIG_SCENE]'), true)
  assert.equal(source.includes("scene_name: '档次配置'"), true)
  assert.equal(source.includes("scene_name: '策划配置'"), true)
  assert.equal(source.includes('getProductConfig({ product_item_id: keyValue })'), true)
  assert.equal(source.includes('getPlanConfig({ product_item_id: keyValue })'), true)
  // 结果按查询时编号缓存：跳转/切 tab 编号一致时不重查
  assert.equal(source.includes('productResultKey === effectiveKey'), true)
  assert.equal(source.includes('planResultKey === effectiveKey'), true)
  assert.equal(source.includes('data-product-config-results'), true)
  assert.equal(source.includes('data-plan-config-results'), true)
  // 产品关系的 relat_product_item_id 可点击，携带值跳转策划配置自动查询
  assert.equal(source.includes("clickableColumns={['relat_product_item_id']}"), true)
  assert.equal(source.includes('setSceneCode(PLAN_CONFIG_SCENE.scene_code)'), true)
  assert.equal(source.includes('点击 关联产品编号 跳转策划配置查询'), true)
  // 策划配置「关联产品」点击编号下钻属性信息（up_item_relat）
  assert.equal(source.includes('queryItemRelat'), true)
  assert.equal(source.includes('data-item-relat-results'), true)
  // 策划配置「前项限制」rule_exp 拆分 limit_code/param_id 下钻限制参数
  assert.equal(source.includes('queryPreLmtParam'), true)
  assert.equal(source.includes("clickableValue={value => /^(\\w+)\\(\\d+\\)$/.test(value.trim())}"), true)
  assert.equal(source.includes('data-pre-lmt-param-results'), true)
  // 限制参数 limit_code 点击 → 业务限制弹窗（规则配置库）
  assert.equal(source.includes('SoPreBusiLimitDialog'), true)
  assert.equal(source.includes('getSoPreBusiLimit'), true)
  assert.equal(source.includes('data-so-pre-busi-limit-result'), true)
  // 跳转策划配置后切回档次配置，还原跳转前的产品编号
  assert.equal(source.includes('productKeyMemoRef'), true)
  // 产品中心场景隐藏 地市/数据类型（含历史月份），主键标签改为 产品编号（策划配置为 产品/策划编号）
  assert.equal(source.includes("const isProductScene = centerCode === PRODUCT_CENTER_CODE"), true)
  assert.equal(source.includes("'产品/策划编号'"), true)
  assert.equal(source.includes("'档次编号'"), true)
  assert.equal(source.includes('{!(isProductScene || isInstanceScene || isDriveScene) && ('), true)
  // 实例中心：用户信息 + 订购信息 tab（按计费账号，营业库）
  assert.equal(source.includes("const INSTANCE_CENTER_CODE = 'instance_center'"), true)
  assert.equal(source.includes('? [INSTANCE_USER_SCENE, INSTANCE_ORDER_SCENE]'), true)
  assert.equal(source.includes("isInstanceScene ? '计费账号'"), true)
  assert.equal(source.includes('getInstanceUser({ bill_id: keyValue })'), true)
  assert.equal(source.includes('data-instance-user-results'), true)
  assert.equal(source.includes('getInstanceOrder({ bill_id: keyValue })'), true)
  assert.equal(source.includes('data-instance-order-results'), true)
})
