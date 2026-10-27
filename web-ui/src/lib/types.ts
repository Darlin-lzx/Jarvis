export interface Conversation {
  id: number
  title: string
  space_id?: number | null
  space_name?: string
  sub_system_id?: number | null
  sub_system_name?: string
  task_id?: number | null
  task_name?: string
  agent_id?: string
  created_at?: string
  updated_at?: string
  message_count?: number
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  agent_id?: string
  ui_render?: Record<string, unknown> | null
  created_at?: string
}

export interface TraceEvent {
  id: number
  node: string
  content: Record<string, unknown> | string
  agent_id?: string
  created_at?: string
  /** 聚合查询时附加：该 trace 所属会话 */
  conv_id?: number
  conv_title?: string
}

export interface StreamEvent {
  type: 'text' | 'parse' | 'route' | 'skill' | 'artifact' | 'error' | 'done' | 'system' | 'sub_agent' | 'ui_render' | 'migrate'
  content: unknown
}

/** 系统事件（调度中/工具调用/检索等，非 Agent 发言） */
export interface SystemEvent {
  message?: string
  event?: string
  agent_id?: string
}

/** 子 Agent 输出消息（含调度溯源信息） */
export interface SubAgentEvent {
  agent_id?: string
  agent_name?: string
  dispatcher_id?: string
  dispatcher_name?: string
  reply?: string
  error?: string
  artifacts?: ArtifactItem[]
}

export interface Settings {
  provider: string
  model: string
  base_url: string
  api_key: string
  embedding_model: string
}

export interface Agent {
  id: string
  agent_id?: string
  name: string
  /** 别名/昵称（展示用；来自数据库 agents.alias，未配置时为空） */
  alias?: string
  /** 工程目录（该智能体负责的工程代码根目录；来自数据库 agents.project_dir） */
  project_dir?: string
  /** 产物类型（来自数据库 agents.product_type，按此把该 Agent 生成的产物归类） */
  product_type?: string
  /** 迁移阶段（来自数据库 agents.stage，按此把该 Agent 生成的产物归入状态机阶段分组） */
  stage?: string
  /** 头像/标签展示色（前端展示用，后端 /api/agents 可能不下发） */
  color?: string
  intent?: string
  description?: string
  default_prompt?: string
  output_files?: string[]
  gen_artifact: boolean
  enabled: boolean
  builtin?: boolean
  agent_type?: string
  bound_kbs?: string[]
  // 绑定的系统角色提示词（来自 /api/agents，type=system_role 的 Prompt）
  system_role_prompt_id?: number | null
  system_role_name?: string | null
  system_role_enabled?: boolean | null
}

export interface Skill {
  id?: number
  skill_id: string
  name: string
  description?: string
  content?: string
  script?: string
  chain?: string[]
  enabled: boolean
  created_at?: string
}

/** 模型管理：LLM / Embedding 模型（对话输入框模型下拉 = models 表中 type=LLM 且已启用） */
export interface ModelDef {
  id: number
  name: string
  model_id: string
  type: 'LLM' | 'Embedding'
  provider: 'API接口' | '本地部署' | 'MCP模型'
  status: '已启用' | '已停用'
  api_url?: string
  api_key?: string
  version?: string
  timeout?: number
  max_tokens?: number
  description?: string
  total_calls?: number
  fail_count?: number
  used_by_agents?: string[]
  created_at?: string
}

export interface Datasource {
  id?: number
  name: string
  kind: string
  location?: string
  username?: string
  password?: string
  dsn?: string
  enabled: boolean
  description?: string
  tags?: string[]
  health_ok?: boolean
  last_synced_at?: string
  table_count?: number
  timeout?: number
  space_id?: number | null
  sub_system_id?: number | null
}

export interface DatasourceTestResult {
  ok: boolean
  scheme?: string
  tables?: string[]
  views?: string[]
  object?: string
  columns?: { name: string; type: string; nullable: boolean; pk: boolean }[]
  message?: string
}

export interface KBDocument {
  id: number
  name: string
  source_type: string
  chunk_count: number
  enabled: boolean
  space_id?: number | null
  sub_system_id?: number | null
  kb_id?: number | null
  kb_type?: string
  business_domain?: string
  target_db?: string
  stage?: string
  object_type?: string
  confidence?: KnowledgeConfidence
  source?: string
  source_ref?: string
  effective_time?: string | null
  negative_feedback_count?: number
  review_required?: boolean
  created_at: string
}

export interface KnowledgeBaseInfo {
  id: number
  name: string
  description?: string
  owner_agent_id?: string
  doc_count?: number
  chunk_count?: number
  enabled?: boolean
  bound_agent_ids?: string[]
  bound_agent_names?: string[]
  created_at?: string | null
}

export interface KBTriple {
  subject: string
  relation: string
  object: string
  doc?: string
}

export interface KGOverview {
  entities: number
  relations: number
  entity_types: { type: string; count: number }[]
  top_relations: { relation: string; count: number }[]
}

export interface MCPServer {
  id: number
  name: string
  kind: string
  command_or_url: string
  enabled: boolean
  description?: string
  tags?: string[]
  health_ok?: boolean
  health_checked_at?: string
  tools_count?: number
  calls_count?: number
  api_url?: string
  api_key?: string
  timeout?: number
}

export type PromptType = 'system_role' | 'task_instruction' | 'domain'

export interface Prompt {
  id: number
  name: string
  category: string
  content: string
  enabled: boolean
  type?: PromptType
  bound_agent_count?: number
  updated_at?: string
}

export interface OpsHealthRecord {
  ds: string
  kind: string
  ok: boolean
  latency_ms: number
  detail?: string
  created_at?: string
}

export interface GovAsset {
  ds: string
  object: string
  obj_type: string
  columns: string[]
  row_count: number
  pk?: string
}

export interface GovQualityRow {
  ds: string
  object: string
  row_count: number
  filled_rate: number
  unique_rate: number
  null_rate: number
  score: number
  issues: string[]
}

export interface SecurityLog {
  id: number
  method: string
  path: string
  ip: string
  status: number
  duration_ms: number
  notes?: string
  created_at?: string
}

export interface Template {
  id: number
  name: string
  type: 'task' | 'conversation'
  description?: string
  tags?: string[]
  is_public: boolean
  creator?: string
  created_at?: string
  // 任务模板配置
  default_name?: string
  skill?: string
  datasource_ids?: string[]
  agent_ids?: string[]
  kb_ids?: string[]
  mcp_ids?: string[]
  auto_import?: boolean
  // 会话模板配置
  prompt?: string
}

/** 向量库空间统计（/api/vector/stats，FAISS 真实数据） */
export interface VectorSpaceStat {
  id: number
  name: string
  key: string
  docCount: number
  vectorCount: number
  chunkCount: number
  storageMB: number
  status: '正常' | '无向量数据' | '索引异常'
}

/** 知识库文档 Chunk */
export interface ChunkItem { chunk_id: string; chunk_index: number; content: string; chars: number }
export interface KBSearchHit {
  chunk_id: string; doc_name: string; chunk_index: number
  type: string; content: string; score: number
}

export type KnowledgeConfidence =
  | 'verified' | 'human_authority' | 'pending_review' | 'model_generated'

export interface KnowledgeSearchHit extends KBSearchHit {
  doc_id: number
  kb_type: string
  business_domain: string
  target_db: string
  stage: string
  object_type: string
  confidence: KnowledgeConfidence
  confidence_score: number
  source: string
  source_ref: string
  effective_time?: string | null
  negative_feedback_count: number
  review_required: boolean
  needs_review: boolean
  domain_match: number
  matched_dimensions: string[]
  similarity: number
  fused_score: number
  keyword_hits: number
  match_type: 'exact' | 'semantic'
}

export interface KnowledgeSearchResult {
  results: KnowledgeSearchHit[]
  degraded: boolean
  elapsed_ms: number
  no_hit_reason?: string | null
  query: string
  candidate_k: number
  min_similarity: number
}

export interface UserProfile {
  name: string
  role: string
  title: string
  email: string
  avatar_color: string
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  detail?: string
  error?: string
  message?: string
}

// ---------- 跨工程迭代：状态机编排 ----------
/** 跨工程迭代任务状态机阶段（后端硬编码流转，LLM 无权跳转） */
export type MigrateStatus =
  | 'PAGE_SHOW' | 'ORDER_SPLIT' | 'ORDER_ACCEPT'
  | 'RULE_CHECK' | 'CUSTOMER_CHECK' | 'FINISHED' | 'ERROR'
  // 旧值兼容（存量任务映射前可能短暂出现）
  | 'INIT' | 'DATA_COLLECTION' | 'ASSESSMENT_RUNNING' | 'SOLUTION_GENERATE' | 'CODE_MIGRATE' | 'VERIFY_STAGE'

export const MIGRATE_STATUS_FLOW: MigrateStatus[] = [
  'PAGE_SHOW', 'ORDER_SPLIT', 'ORDER_ACCEPT',
  'RULE_CHECK', 'CUSTOMER_CHECK', 'FINISHED',
]

export const MIGRATE_STATUS_LABEL: Record<MigrateStatus, string> = {
  PAGE_SHOW: '页面展示',
  ORDER_SPLIT: '下单拆单',
  ORDER_ACCEPT: '订单受理',
  RULE_CHECK: '规则配置',
  CUSTOMER_CHECK: '客户数据',
  FINISHED: '已完成',
  ERROR: '异常中断（可续跑）',
  // 旧值兼容
  INIT: '页面展示',
  DATA_COLLECTION: '页面展示',
  ASSESSMENT_RUNNING: '下单拆单',
  SOLUTION_GENERATE: '订单受理',
  CODE_MIGRATE: '规则配置',
  VERIFY_STAGE: '客户数据',
}

export interface MigrateTask {
  task_id: number
  space_id?: number | null
  sub_system_id?: number | null
  task_name: string
  status: MigrateStatus
  status_label?: string
  frontend_task?: string
  business_scene?: string
  order_source?: string
  split_rule?: string
  accept_system?: string
  workflow_scene?: string
  rule_config?: string
  config_branch?: string
  customer_scope?: string
  data_range?: string
  object_count?: number
  error_msg?: string
  conv_id?: number | null
  current_step?: string
  step_status?: string
  awaiting_confirmation?: boolean
  step_confirm?: boolean
  strict_flow?: boolean
  trace_id?: string
  created_at?: string
  updated_at?: string
}

export interface MigrateTaskDetail extends MigrateTask {
  /** 执行锁状态（多会话互斥展示；无锁时 locked=false） */
  exec_lock?: MigrateExecLock
}

export interface MigrateStateSnapshot {
  event: 'state' | 'pong'
  task_id: number
  status?: MigrateStatus
  status_label?: string
  current_step?: string
  step_status?: string
  awaiting_confirmation?: boolean
  step_confirm?: boolean
  strict_flow?: boolean
  updated_at?: string | null
}

export interface MigrateStateEventData {
  id?: number | null
  task_id?: number | null
  conv_id?: number | null
  event_type?: string
  from_status?: string
  to_status?: string
  node_id?: string
  message?: string
  trace_id?: string
  created_at?: string | null
}

export interface MigrateStateEventFrame extends MigrateStateEventData {
  event: 'state_event'
}

export interface TraceLogItem {
  id: number
  trace_id: string
  conv_id?: number | null
  task_id?: number | null
  phase: string
  span?: string
  level: string
  message: string
  duration_ms?: number | null
  created_at?: string | null
}

export interface MigrateEvent {
  task_id: number
  from?: string
  to: string
  label: string
}

/** 任务执行锁（多会话互斥：一个任务同一时间只允许一个活跃执行流） */
export interface MigrateExecLock {
  locked: boolean
  session_id: string
  owner_user_id: string
  expire_time?: string | null
  expired: boolean
  readonly: boolean
  reason?: string
}

/** 任务流程静态表节点（页面可编排，后端状态机按此表驱动流转） */
export interface MigrateFlowNode {
  id?: number | null
  sort_order: number
  status: string
  label: string
  description: string
  need_confirm: boolean
  required_fields: string[]
  enabled: boolean
}

// ---------- 空间 / 子系统 / 业务任务（任务↔空间 归属体系） ----------
export interface SpaceSubsystem {
  id: number; space_id?: number; name: string
  description?: string; owner?: string; tags?: string[]; created_at?: string
  task_count?: number
}
export interface SubSystemStats {
  space_id: number; sub_system_id: number
  task_count: number; conv_count: number
  artifact_count: number; doc_count: number; ds_count: number
}
export interface Space {
  id: number; name: string; description?: string; kb_ids?: number[]
  enabled_agents?: string[]; members?: string[]
  subsystems: SpaceSubsystem[]; created_at?: string
  task_count?: number
}
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'paused'
export interface BizTask {
  id: number; space_id: number; sub_system_id?: number | null
  name: string; description?: string
  status: TaskStatus; kb_ids?: number[]; agent_id?: string; creator?: string
  conv_count?: number; artifact_count?: number
  created_at?: string; updated_at?: string
}
export interface ArtifactItem {
  id: number; namespace: string; conv_id?: number; agent_id?: string
  object_name?: string; type: string; path?: string
  space_id?: number; sub_system_id?: number; task_id?: number
  kb_doc_id?: number | null
  version?: number
  parent_version?: number | null
  trace_id?: string
  created_at?: string
}

export interface ArtifactVersionItem extends ArtifactItem {}

export interface ArtifactDiffBlock {
  kind: 'context' | 'added' | 'removed' | 'changed'
  left_start: number
  left_end: number
  right_start: number
  right_end: number
  left: string[]
  right: string[]
}

export interface ArtifactDiff {
  record_id: number
  left_version: number
  right_version: number
  summary: { added: number; removed: number; changed: number }
  blocks: ArtifactDiffBlock[]
}
export interface TaskDetail extends BizTask {
  space_name?: string; sub_system_name?: string
  sessions?: { id: number; title: string; created_at?: string }[]
  artifacts?: ArtifactItem[]
}
export interface ConversationDetail {
  id: number; title: string
  space_id?: number | null; space_name?: string
  sub_system_id?: number | null; sub_system_name?: string
  task_id?: number | null; task_name?: string; agent_id?: string
}

// ---------- 聊天输入增强：@ 引用 与 + 上传附件 ----------
export type ChatReferenceType = 'kb_doc' | 'history' | 'artifact' | 'agent' | 'skill' | 'kg'

/** @ 引用资源：随聊天流 references 字段注入上下文（type ∈ kb_doc|history|artifact|agent|skill|kg） */
export interface ChatReference {
  type: ChatReferenceType
  id: string | number
  name: string
}

/** 上传附件成功项（对应 POST /api/chat/attachments data 中的一条产物记录） */
export interface AttachmentItem {
  id: number
  name: string
  file_type: string
  object_name?: string
  text_len?: number
}

/** 上传附件接口返回的单文件条目（单项失败仅带 error，不整体失败） */
export interface UploadAttachmentResult extends AttachmentItem {
  attachment_id?: number
  kb_doc_id?: number
  error?: string
}

/** send 的扩展载荷：references 一次性、attachment_ids 挂载会话可多轮使用 */
export interface SendExtra {
  references?: ChatReference[]
  attachment_ids?: number[]
  /** 内部执行标记：阶段确认后自动执行当前智能体，不再解析为下一级确认 */
  skip_state_advance?: boolean
}

export interface WorkspaceChange {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface WorkspaceSummary {
  available: boolean
  agent_id: string
  name: string
  project_dir: string
  git: { is_repo: boolean; branch: string; error?: string }
  changes: WorkspaceChange[]
  changed_count: number
}

export interface WorkspaceTreeNode {
  name: string
  path: string
  type: 'directory' | 'file'
}

export interface WorkspaceTree {
  path: string
  items: WorkspaceTreeNode[]
  truncated: boolean
}

export interface WorkspaceFile {
  path: string
  content: string
  truncated: boolean
}

export interface WorkspaceDiff {
  path: string
  diff: string
  truncated: boolean
}

export interface WorkspaceEvidenceItem {
  id: number
  type: 'read' | 'search' | 'kb'
  path?: string
  query?: string
  matched_count?: number
  created_at?: string | null
}

export interface WorkspaceEvidence {
  agent_id: string
  name: string
  project_dir: string
  items: WorkspaceEvidenceItem[]
  counts: { read: number; search: number; kb: number }
}

export interface WorkflowVariable {
  name: string
  datatype: string
  defaultvalue: string
  inouttype: string
  description: string
}

export interface WorkflowLink {
  direction: string
  left: string
  right: string
  default_value: string
  default_value_type: string
}

export interface WorkflowService {
  runtype: string
  cross_center?: boolean | null
  centercode: string
  servicecode: string
  servicename: string
}

export interface WorkflowNode {
  id: string
  label: string
  type: string
  x: number
  y: number
  width: number
  height: number
  goto: string[]
  service?: WorkflowService | null
  links: WorkflowLink[]
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  source_kind: string
}

export interface WorkflowGraph {
  label?: string
  tasktag?: string
  tasktype?: string
  owntype?: string
  description?: string
  variables: WorkflowVariable[]
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  warnings: string[]
  width: number
  height: number
}

export interface WorkflowTemplateVersion {
  template_version_id: number
  order_num?: number | null
  template_tag: string
  create_staff_id?: string | number | null
  create_date?: string | null
  modify_desc?: string | null
  valid_date?: string | null
  expire_date?: string | null
  is_expired: boolean
  content: string | null
  workflow: WorkflowGraph | null
  parse_error: string | null
}

export interface WorkflowParseResponse {
  workflow: WorkflowGraph | null
  parse_error: string | null
}

export interface AnalysisSceneInfo {
  scene_code: string
  scene_name: string
  render_mode: string
}

export interface AnalysisCenterInfo {
  center_code: string
  center_name: string
  icon: string
  default_city: string
  scenes: AnalysisSceneInfo[]
}

export interface AnalysisNodeResult {
  node_code: string
  node_name: string
  table_name: string
  datasource_name: string
  color: string
  parent_node_code: string
  parent_field: string
  query_field: string
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
}

export interface AnalysisSceneResult {
  center_code: string
  scene_code: string
  business_key: string
  city: string
  in_transit: boolean
  history_month: string
  nodes: AnalysisNodeResult[]
}

export interface AnalysisQueryBlock {
  name: string
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
}

export interface AnalysisWorkflowResult {
  order_id: string
  scheduler_ids: string[]
  results: AnalysisQueryBlock[]
}

export interface AnalysisMessageResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  task_id?: string
  message_type?: string
  cust_order_id?: string
  key_ele_id?: string
}

/** 客户订单下单报文（hall_cust_dtl，CUST_DTL_INFO_A~P 拼接） */
export interface CustomerOrderMessageResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  cust_order_id: string
  table_name: string
  message: string
  original_data: unknown | null
  transformed_data: unknown | null
}

/** 流程实例受理报文（HALL_ORDER_BUSI_LOG 最近一条，REQ/RESP_MESSAGE 已在 SQL 内拼接） */
export interface AcceptMessageResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  cust_order_id: string
  task_flow_ins_id: string
}

/** 展示场景（客户订单配置库 DEF_SCENE，按 SCENE_ID 查询） */
export interface DefSceneResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  scene_id: string
  scene_name?: string
}

/** 异步流程（ord_async_method_deal_task_order_574，按客户订单号查询）；
 * 在途表为进程处理表，处理完成即移历史——在途查不到时后端自动回退近几个月历史表，
 * from_history 标记结果来自历史表，history_fallback 标记为自动回退命中 */
export interface AsyncFlowResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  order_id: string
  table_name: string
  from_history?: boolean
  history_fallback?: boolean
  checked_tables?: string[]
}

/** 产品配置单块结果（product.up_product_item / product.up_item_feature，按产品编号查询） */
export interface ProductConfigBlock {
  name: string
  table_name: string
  /** 数据源标注（后端返回；缺省由前端按 tab 兜底） */
  datasource?: string
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
}

/** 产品配置（产品库；不区分地市/在途历史，一次返回 配置+特性 两块） */
export interface ProductConfigResult {
  product_item_id: string
  results: ProductConfigBlock[]
}

/** 用户信息（实例中心，营业库）：ins_user 按计费账号查；cust_type=1 级联个人客户，
 * family_cust_id 非空级联家庭客户（不满足条件的块后端不返回） */
export interface InstanceUserResult {
  bill_id: string
  results: ProductConfigBlock[]
}

/** 框架规则定义（busicfg.UP_RULE 按规则ID查询，家庭业务配置库；框架规则点击弹窗展示） */
export interface UpRuleResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  rule_id: string
  table_name: string
}

/** 业务信息（product.up_business 按业务ID查询，产品库；业务关系点击弹窗展示） */
export interface BusinessInfoResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  business_id: string
  table_name: string
}

/** 产品驱动（家庭业务中心；待接入真实 SQL） */
export interface ProductDriveResult {
  category: string
  results: ProductConfigBlock[]
}

/** 静态配置（家庭订单中心·配置查询：bs_para_detail(para_type) + bs_static_data(code_type)，家庭订单库） */
export interface StaticConfigResult {
  code: string
  results: ProductConfigBlock[]
}

/** 业务限制（rule_Cfg.SO_PRE_BUSI_LIMIT，按限制编码查询，规则配置库；弹窗展示） */
export interface SoPreBusiLimitResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  limit_code: string
  table_name: string
}

/** 配置查询单块结果（DEF_RULE / DEF_BUSI_CMPT） */
export interface SceneRulePartResult {
  node_name: string
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
}

/** 配置查询：规则定义（按场景ID，客户订单配置库） */
export interface SceneRulesResult {
  scene_id: string
  rule: SceneRulePartResult
  /** 场景单元关系（HALLCFG.SCENE_UNIT_REL，按 SCENE_ID 查询） */
  unit_rel: SceneRulePartResult
}

/** 业务组件定义（DEF_BUSI_CMPT 按 BUSI_CMPT_ID 查询） */
export interface BusiCmptResult {
  success: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  error: string
  sql: string
  busi_cmpt_id: string
}

/** SM4 加密字段解密结果（密码服务 /api/decrypt） */
export interface DecryptResult {
  ok: boolean
  plain: string
  raw: unknown
  error: string
}

/** 批量解密结果（按入参顺序对齐） */
export interface DecryptBatchResult {
  results: DecryptResult[]
}

/** 结构化订单信息单表结果（HALL_ORD_*，按 CUST_ORDER_ID 查询） */
export interface StructuredOrderTableResult {
  label: string
  table_name: string
  sql: string
  success: boolean
  error: string
  columns: string[]
  rows: string[][]
  row_count: number
}

/** 结构化订单信息（17 张 HALL_ORD_* 表并行查询） */
export interface StructuredOrderInfoResult {
  cust_order_id: string
  tables: StructuredOrderTableResult[]
}

export interface WorkflowTemplateResponse {
  template_tag: string
  version_table?: string
  selected_version_id: number | null
  versions: WorkflowTemplateVersion[]
}
