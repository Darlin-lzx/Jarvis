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
  assert.equal(sidebarSource.includes("label: 'Analytics',"), true)
  assert.equal(sidebarSource.includes("value: 'analysis', label: 'Data Query', icon: Activity"), true)
  assert.equal(appSource.includes("'workflows', 'analysis', 'sql', 'apicall', 'users']"), true)
  assert.equal(workbenchSource.includes("import { AnalysisPanel } from './analysis-panel'"), true)
  assert.equal(workbenchSource.includes("case 'analysis': return ("), true)
})

test('analysis api client covers engine and family-order endpoints', () => {
  // 样板已收敛为 analysisGet/analysisPost 泛型封装，各端点保留专属兜底文案
  assert.equal(apiSource.includes('listAnalysisCenters: () =>'), true)
  assert.equal(apiSource.includes('queryAnalysisScene: (centerCode: string, payload: {'), true)
  assert.equal(apiSource.includes('queryAnalysisNode: (centerCode: string, payload: {'), true)
  assert.equal(apiSource.includes('getAnalysisWorkflow: (params: {'), true)
  assert.equal(apiSource.includes("getAnalysisMessage: (kind: 'wired-message' | 'billing-message' | 'stage-reply',"), true)
  assert.equal(apiSource.includes("'/api/analysis/centers'"), true)
  assert.equal(apiSource.includes('`/api/analysis/${encodeURIComponent(centerCode)}/query`'), true)
  assert.equal(apiSource.includes("analysisGet<AnalysisWorkflowResult>(\n      '/api/analysis/family-order/workflow', params, `Workflow query failed`)"), true)
  assert.equal(apiSource.includes("'/api/analysis/rule-center/busi-rules', params, `Business rule query failed`)"), true)
  assert.equal(typesSource.includes('export interface AnalysisSceneResult'), true)
  assert.equal(typesSource.includes('export interface AnalysisNodeResult'), true)
  assert.equal(typesSource.includes('export interface AnalysisWorkflowResult'), true)
  assert.equal(typesSource.includes('export interface RuleBusiResult'), true)
  assert.equal(typesSource.includes('export interface OfferSrvAttrResult'), true)
  assert.equal(apiSource.includes("'/api/analysis/family-order/offer-srv-attr', params, `Linked srv attribute query failed`)"), true)
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
  assert.equal(source.includes('Enter a business key'), true)
  assert.equal(source.includes('Total '), true)
})

test('analysis panel restores state from module snapshot after remount', () => {
  assert.equal(source.includes('let analysisSnapshot: Partial<AnalysisSnapshot> = {}'), true)
  assert.equal(source.includes('interface AnalysisSnapshot'), true)
  // 业务主键改为按中心记忆（businessKeyByCenter），快照只还原中心代码
  assert.equal(source.includes("businessKeyByCenter[analysisSnapshot.centerCode ?? ''] ?? ''"), true)
  assert.equal(source.includes('analysisSnapshot.sceneCache ?? {}'), true)
  assert.equal(source.includes('analysisSnapshot.workflowResult ?? null'), true)
  assert.equal(source.includes('快照已有配置，无需重拉'), true)
  // 每次渲染后同步快照，切走菜单（组件卸载）时数据留在模块变量里
  // （effect 内先记录当前中心的业务主键，再整体覆盖模块级快照）
  assert.match(source, /useEffect\(\(\) => \{[^]*?analysisSnapshot = \{/)
})

test('analysis panel supports live work order query and message dialogs', () => {
  assert.equal(source.includes("node_code: 'work_order',"), true)
  assert.equal(source.includes('api.queryAnalysisNode(centerCode, {'), true)
  assert.equal(source.includes('queryLiveWorkOrder'), true)
  assert.equal(source.includes('Click row for live ticket query'), true)
  assert.equal(source.includes('Order item stats:'), true)
  assert.equal(source.includes('itemTypeStats'), true)
  assert.equal(source.includes('MessageDialog'), true)
  assert.equal(source.includes("key: 'SEND_TO_IMEP', label: 'To IMEP message'"), true)
  assert.equal(source.includes("key: 'billing', label: 'Billing message'"), true)
  assert.equal(source.includes("key: 'stage', label: 'Stage reply'"), true)
  assert.equal(source.includes('data-message-result'), true)
  assert.equal(source.includes('prettyContent'), true)
})

test('hall task rows expose retry and so-bus-print actions', () => {
  // 协议单（task_type=3）「免填单」：bill_id/create_date 取自 hall_cust 行，营业库弹窗展示
  assert.equal(source.includes('renderTaskOrderActions'), true)
  assert.equal(source.includes('data-so-busi-print-action'), true)
  assert.equal(source.includes("node.node_code === 'cust_order'"), true)
  assert.equal(source.includes('Customer order missing BILL_ID or create date'), true)
  // 通用弹窗以 testId prop 传入测试锚点（渲染为 data-testid）
  assert.equal(source.includes('testId="so-busi-print-result"'), true)
  assert.equal(source.includes('api.getSoBusiPrint({ bill_id: billId.trim(), create_date: createDate.trim(), city_code: city })'), true)
  // 表格展示全部查询列（create_date 倒序）；报文列在行首，复制按钮拷贝拼接全文
  assert.equal(source.includes('sortSoBusiPrintRows'), true)
  assert.equal(source.includes("column.toLowerCase() === 'create_date'"), true)
  assert.equal(source.includes("const SO_BUSI_PRINT_INFO_COLUMNS = ['info_data', 'info_data_1', 'info_data_2', 'info_data_3',"), true)
  assert.equal(source.includes('data-so-busi-print-copy'), true)
  assert.equal(source.includes('await navigator.clipboard.writeText(rowText(row))'), true)
  assert.equal(source.includes('>Message</th>'), true)
  // 重试仍只对 在途 + task_type=5 生效
  assert.equal(source.includes('if (!inTransit) return null'), true)
  assert.equal(source.includes("String(values.task_type) !== '5'"), true)
})

test('plan offer rows expose srv-attr relation dialog', () => {
  // 策划订单项「关联」：行内 customer_order_id + offer_order_id 弹窗查 ord_srv_attr（家庭订单库）
  assert.equal(source.includes('data-offer-srv-attr-action'), true)
  assert.equal(source.includes('renderPlanSrvAttrAction'), true)
  assert.equal(source.includes("node.node_code === 'plan' && centerCode === 'family_order'"), true)
  assert.equal(source.includes('Row missing customer_order_id / offer_order_id'), true)
  assert.equal(source.includes('testId="offer-srv-attr-result"'), true)
  assert.equal(source.includes('<OfferSrvAttrDialog'), true)
  assert.equal(source.includes('context={{ city, inTransit, historyMonth }}'), true)
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
  assert.equal(source.includes("scene_name: 'Offer Config'"), true)
  assert.equal(source.includes("scene_name: 'Plan Config'"), true)
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
  assert.equal(source.includes('Click related product ID to open plan config query'), true)
  // 策划配置「关联产品」点击编号下钻属性信息（up_item_relat）
  assert.equal(source.includes('queryItemRelat'), true)
  assert.equal(source.includes('data-item-relat-results'), true)
  // 工作流信息 state 枚举转中文（值：含义，未匹配原样）
  assert.equal(source.includes("'21': 'Replied to flow engine'"), true)
  assert.equal(source.includes("col.toLowerCase() === 'state'"), true)

  // 策划配置「前项限制」rule_exp 拆分 limit_code/param_id 下钻限制参数
  assert.equal(source.includes('queryPreLmtParam'), true)
  assert.equal(source.includes("clickableValue={value => /^(\\w+)\\(\\d+\\)$/.test(value.trim())}"), true)
  assert.equal(source.includes('data-pre-lmt-param-results'), true)
  // 限制参数 limit_code 点击 → 业务限制弹窗（规则配置库）
  assert.equal(source.includes('SoPreBusiLimitDialog'), true)
  assert.equal(source.includes('getSoPreBusiLimit'), true)
  assert.equal(source.includes('testId="so-pre-busi-limit-result"'), true)
  // 跳转策划配置后切回档次配置，还原跳转前的产品编号
  assert.equal(source.includes('productKeyMemoRef'), true)
  // 产品中心场景隐藏 地市/数据类型（含历史月份），主键标签改为 产品编号（策划配置为 产品/策划编号）
  assert.equal(source.includes("const isProductScene = centerCode === PRODUCT_CENTER_CODE"), true)
  assert.equal(source.includes("'Product/Plan ID'"), true)
  assert.equal(source.includes("'Offer ID'"), true)
  assert.equal(source.includes('{!(isProductScene || isInstanceScene || isDriveScene || isRuleScene) && ('), true)
  // 规则中心：业务规则场景（业务编码 / 规则编码二选一，联查实例/模板/因子构造链）
  assert.equal(source.includes("const RULE_CENTER_CODE = 'rule_center'"), true)
  assert.equal(source.includes("const RULE_BUSI_SCENE = { scene_code: 'rule_busi', scene_name: 'Business Rules', render_mode: 'rule_busi' }"), true)
  assert.equal(source.includes('busi_code: businessKey.trim(), rule_code: ruleCode.trim(),'), true)
  assert.equal(source.includes('Enter a business code or rule code'), true)
  assert.equal(source.includes('<span>Rule Code</span>'), true)
  assert.equal(source.includes('data-rule-busi-results'), true)
  assert.equal(source.includes('<span>Business Code</span>'), true)
  // 实例中心：用户信息 + 订购信息 + 终端 tab（按计费账号，营业库）
  assert.equal(source.includes("const INSTANCE_CENTER_CODE = 'instance_center'"), true)
  assert.equal(source.includes('? [INSTANCE_USER_SCENE, INSTANCE_ORDER_SCENE, INSTANCE_TERMINAL_SCENE]'), true)
  assert.equal(source.includes("isInstanceScene ? 'Billing Account'"), true)
  assert.equal(source.includes('getInstanceUser({ bill_id: keyValue })'), true)
  assert.equal(source.includes('data-instance-user-results'), true)
  assert.equal(source.includes('getInstanceOrder({ bill_id: keyValue })'), true)
  assert.equal(source.includes('data-instance-order-results'), true)
  // 终端 tab：场景定义 + 请求分发 + 结果渲染
  assert.equal(source.includes("const INSTANCE_TERMINAL_SCENE = { scene_code: 'terminal_info', scene_name: 'Terminal', render_mode: 'instance_terminal' }"), true)
  assert.equal(source.includes('getInstanceTerminal({ bill_id: keyValue })'), true)
  assert.equal(source.includes('data-instance-terminal-results'), true)
  assert.equal(source.includes('api.getInstanceTerminal'), true)
})
