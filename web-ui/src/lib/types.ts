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

export interface KBDocument {
  id: number
  name: string
  source_type: string
  chunk_count: number
  enabled: boolean
  space_id?: number | null
  sub_system_id?: number | null
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

// ---------- 数据库迁移：状态机 / 规则引擎 / 结构化资产 ----------
/** 迁移任务状态机阶段（后端硬编码流转，LLM 无权跳转） */
export type MigrateStatus =
  | 'DATA_COLLECTION' | 'ASSESSMENT_RUNNING' | 'SOLUTION_GENERATE'
  | 'CODE_MIGRATE' | 'VERIFY_STAGE' | 'FINISHED' | 'ERROR'
  // 旧值兼容（存量任务映射前可能短暂出现）
  | 'INIT' | 'DATA_SOURCE_SELECTED' | 'BASIC_INFO_COLLECTED' | 'OBJECT_SCANNING' | 'SQL_TRANSFORM'

export const MIGRATE_STATUS_FLOW: MigrateStatus[] = [
  'DATA_COLLECTION', 'ASSESSMENT_RUNNING', 'SOLUTION_GENERATE',
  'CODE_MIGRATE', 'VERIFY_STAGE', 'FINISHED',
]

export const MIGRATE_STATUS_LABEL: Record<MigrateStatus, string> = {
  DATA_COLLECTION: '数据采集',
  ASSESSMENT_RUNNING: '迁移评估',
  SOLUTION_GENERATE: '迁移方案',
  CODE_MIGRATE: '代码改造',
  VERIFY_STAGE: '迁移验证',
  FINISHED: '已完成',
  ERROR: '异常中断（可续跑）',
  // 旧值兼容
  INIT: '数据采集',
  DATA_SOURCE_SELECTED: '数据采集',
  BASIC_INFO_COLLECTED: '数据采集',
  OBJECT_SCANNING: '数据采集',
  SQL_TRANSFORM: '代码改造',
}

export interface MigrateTask {
  task_id: number
  space_id?: number | null
  sub_system_id?: number | null
  task_name: string
  status: MigrateStatus
  status_label?: string
  source_ds_id?: string
  source_ds_name?: string
  source_db_type?: string
  target_db_type?: string
  db_business_level?: string
  db_capacity?: string
  stop_window?: string
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

export interface MigrateAsset {
  id: number
  task_id: number
  asset_type: string
  asset_name: string
  risk_level: string
  incompatible_detail: string
  rule_ids: string
  original_sql: string
  converted_sql: string
  suggestion: string
  source: string
  status: string
  owner?: string
  conv_id?: number | null
  created_at?: string
  updated_at?: string
}

export interface RuleFinding {
  rule_id: string
  desc: string
  risk: string
  suggest: string
  snippet?: string
}

export interface RuleScanResult {
  object_name: string
  asset_type: string
  findings: RuleFinding[]
  summary: { high: number; medium: number; low: number }
  hit_rules: string[]
}

export interface MigrateTaskDetail extends MigrateTask {
  assets: MigrateAsset[]
  assets_stats: { total: number; high: number; medium: number; low: number }
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

export interface MigrateRule {
  rule_id: string
  desc: string
  risk: string
  suggest: string
  match_pattern?: string
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
