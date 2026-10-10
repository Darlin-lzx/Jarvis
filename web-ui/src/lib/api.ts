import type {
  ApiResponse, Conversation, Message, TraceEvent, Settings,
  Agent, Skill, ModelDef, Datasource, KBDocument, KGOverview, KBTriple,
  MCPServer, Prompt, PromptType, OpsHealthRecord, GovAsset, GovQualityRow,
  SecurityLog, Template, Space, SpaceSubsystem, BizTask, TaskDetail,
  ConversationDetail, ArtifactItem, SubSystemStats, UploadAttachmentResult, SendExtra,
  VectorSpaceStat, ChunkItem, UserProfile,
  KBSearchHit, KnowledgeConfidence, KnowledgeSearchResult,
  MigrateTask, MigrateAsset, MigrateTaskDetail, RuleScanResult, MigrateRule, MigrateFlowNode,
  ArtifactVersionItem, ArtifactDiff, TraceLogItem,
} from './types'

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<ApiResponse<T>> {
  const opt: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const res = await fetch(path, opt)
  return res.json()
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),
  me: () => request<UserProfile>('/api/me'),
  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (s: Partial<Settings>) => request<never>('/api/settings', 'PUT', s),
  fetchOllamaModels: () => request<string[]>('/api/ollama/models'),
  getDefaultSpace: () => request<Space>('/api/spaces/default'),
  // —— 模型管理（模型管理菜单 / 对话输入框模型下拉共用） ——
  listModels: (filter?: { type?: 'LLM' | 'Embedding'; enabled?: boolean }) => {
    const params = new URLSearchParams()
    if (filter?.type) params.set('type', filter.type)
    if (filter?.enabled !== undefined) params.set('enabled', filter.enabled ? '1' : '0')
    const qs = params.toString()
    return request<ModelDef[]>(`/api/models${qs ? '?' + qs : ''}`)
  },
  createModel: (m: Partial<ModelDef>) => request<ModelDef>('/api/models', 'POST', m),
  updateModel: (id: number, m: Partial<ModelDef>) => request<ModelDef>(`/api/models/${id}`, 'PUT', m),
  toggleModel: (id: number, enabled: boolean) => request<never>(`/api/models/${id}/toggle`, 'POST', { enabled }),
  deleteModel: (id: number) => request<never>(`/api/models/${id}`, 'DELETE'),
  /** 模型连接测试：服务商最小真实请求（LLM=1 token / Embedding=1 向量） */
  testModel: (id: number) => request<{ ok: boolean; latency_ms: number; message: string }>(`/api/models/${id}/test`, 'POST', {}),
  /** 模型连接测试（表单直测，无需先保存） */
  testModelConfig: (payload: { type: string; model_id: string; api_url: string; api_key?: string; timeout?: number }) =>
    request<{ ok: boolean; latency_ms: number; message: string }>('/api/models/test', 'POST', payload),
  /** 向量库统计（FAISS 真实数据，按知识库空间聚合） */
  getVectorStats: () => request<VectorSpaceStat[]>('/api/vector/stats'),
  /** 知识库文档 Chunk 列表 */
  getDocChunks: (docId: number) => request<ChunkItem[]>(`/api/kb/documents/${docId}/chunks`),
  listConversations: (filter?: { space_id?: number; sub_system_id?: number }) => {
    const params = new URLSearchParams()
    if (filter?.space_id) params.set('space_id', String(filter.space_id))
    if (filter?.sub_system_id) params.set('sub_system_id', String(filter.sub_system_id))
    const qs = params.toString()
    return request<Conversation[]>(`/api/conversations${qs ? '?' + qs : ''}`)
  },
  createConversation: (title: string, extra?: { space_id?: number; sub_system_id?: number; task_id?: number; agent_id?: string }) =>
    request<{ id: number; title: string; task_id?: number }>('/api/conversations', 'POST', { title, ...extra }),
  deleteConversation: (id: number) => request<never>(`/api/conversations/${id}`, 'DELETE'),
  renameConversation: (id: number, title: string) => request<{ id: number; title: string }>(`/api/conversations/${id}`, 'PUT', { title }),
  getMessages: (cid: number) => request<Message[]>(`/api/conversations/${cid}/messages`),
  getTrace: (cid: number) => request<TraceEvent[]>(`/api/conversations/${cid}/trace`),
  chatStream: (message: string, convId: number | null, agentId?: string, signal?: AbortSignal, extra?: SendExtra) => {
    const body: Record<string, unknown> = { message, conv_id: convId, agent_id: agentId }
    if (extra?.references?.length) body.references = extra.references
    if (extra?.attachment_ids?.length) body.attachment_ids = extra.attachment_ids
    if (extra?.skip_state_advance) body.skip_state_advance = true
    return fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  },
  cancelChat: (id: number) => request<never>('/api/chat/' + id + '/cancel', 'POST'),
  /** + 上传附件：多文件 multipart 上传，单项失败仅该项带 error；全部失败 success=false */
  uploadChatAttachments: (files: File[], opts?: { conv_id?: number | null; space_id?: number | null; auto_import?: boolean }) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    if (opts?.conv_id != null) fd.append('conv_id', String(opts.conv_id))
    if (opts?.space_id != null) fd.append('space_id', String(opts.space_id))
    if (opts?.auto_import) fd.append('auto_import', '1')
    return fetch('/api/chat/attachments', { method: 'POST', body: fd })
      .then(r => r.json()) as Promise<ApiResponse<UploadAttachmentResult[]>>
  },
  /** 知识图谱实体检索：q 为空返回最近 N 条 */
  kgEntities: (q?: string, limit = 20) => {
    const params = new URLSearchParams()
    const qs = (q || '').trim()
    if (qs) params.set('q', qs)
    params.set('limit', String(limit))
    return request<{ name: string; etype: string }[]>(`/api/kg/entities?${params.toString()}`)
  },
  listSpaces: () => request<Space[]>('/api/spaces'),
  getSpace: (id: number) => request<Space>(`/api/spaces/${id}`),
  createSpace: (d: { name: string; description?: string; kb_ids?: number[] }) =>
    request<Space>('/api/spaces', 'POST', d),
  updateSpace: (id: number, d: Partial<Space>) => request<Space>(`/api/spaces/${id}`, 'PUT', d),
  deleteSpace: (id: number) => request<never>(`/api/spaces/${id}`, 'DELETE'),
  createSubsystem: (spaceId: number, d: { name: string; description?: string; owner?: string; tags?: string[] }) =>
    request<SpaceSubsystem>(`/api/spaces/${spaceId}/subsystems`, 'POST', d),
  getSubsystem: (spaceId: number, ssid: number) =>
    request<SpaceSubsystem>(`/api/spaces/${spaceId}/subsystems/${ssid}`),
  updateSubsystem: (spaceId: number, ssid: number, d: Partial<SpaceSubsystem>) =>
    request<SpaceSubsystem>(`/api/spaces/${spaceId}/subsystems/${ssid}`, 'PUT', d),
  subsystemStats: (spaceId: number, ssid: number) =>
    request<SubSystemStats>(`/api/spaces/${spaceId}/subsystems/${ssid}/stats`),
  deleteSubsystem: (spaceId: number, ssid: number) =>
    request<never>(`/api/spaces/${spaceId}/subsystems/${ssid}`, 'DELETE'),
  listTasks: (spaceId?: number, status?: string, subSystemId?: number) => {
    const params = new URLSearchParams()
    if (spaceId) params.set('space_id', String(spaceId))
    if (status) params.set('status', status)
    if (subSystemId) params.set('sub_system_id', String(subSystemId))
    const qs = params.toString()
    return request<BizTask[]>(`/api/tasks${qs ? '?' + qs : ''}`)
  },
  createTask: (d: Partial<BizTask>) => request<BizTask>('/api/tasks', 'POST', d),
  getTask: (id: number) => request<TaskDetail>(`/api/tasks/${id}`),
  /** 通过业务任务 ID 查找关联的迁移任务详情（无则返回 data=null） */
  getMigrateTaskByTaskId: (id: number) => request<MigrateTaskDetail | null>(`/api/tasks/${id}/migrate-task`),
  updateTask: (id: number, d: Partial<BizTask>) => request<BizTask>(`/api/tasks/${id}`, 'PUT', d),
  deleteTask: (id: number) => request<never>(`/api/tasks/${id}`, 'DELETE'),
  getConversation: (cid: number) => request<ConversationDetail>(`/api/conversations/${cid}`),
  attachTask: (cid: number, d: { task_id?: number; name?: string; sub_system_id?: number; description?: string }) =>
    request<{ task_id: number; task_name: string }>(`/api/conversations/${cid}/attach-task`, 'POST', d),
  attachSpace: (cid: number, d: { space_id: number; sub_system_id?: number }) =>
    request<ConversationDetail>(`/api/conversations/${cid}/attach-space`, 'POST', d),
  listArtifactsByTask: (taskId: number) => request<ArtifactItem[]>(`/api/artifacts?task_id=${taskId}`),
  listAgents: (enabledOnly?: boolean) => request<Agent[]>(`/api/agents${enabledOnly ? '?enabled_only=true' : ''}`),
  createAgent: (a: Partial<Agent>) => request<Agent>('/api/agents', 'POST', a),
  updateAgent: (aid: string, data: Partial<Agent>) => request<Agent>(`/api/agents/${aid}`, 'PUT', data),
  toggleAgent: (aid: string, enabled: boolean) => request<never>(`/api/agents/${aid}/toggle`, 'POST', { enabled }),
  deleteAgent: (aid: string) => request<never>(`/api/agents/${aid}`, 'DELETE'),
  listDatasources: (spaceId?: number, subSystemId?: number) => {
    const params = new URLSearchParams()
    if (spaceId) params.set('space_id', String(spaceId))
    if (subSystemId) params.set('sub_system_id', String(subSystemId))
    const qs = params.toString()
    return request<Datasource[]>(`/api/datasources${qs ? '?' + qs : ''}`)
  },
  /** 上传 Excel 文件创建 Excel 数据源（源库不可连接时替代采集） */
  uploadDatasource: (fd: FormData) =>
    fetch('/api/datasources/upload', { method: 'POST', body: fd })
      .then(r => r.json()) as Promise<ApiResponse<Datasource>>,
  createDatasource: (d: Partial<Datasource> & { username?: string; password?: string; dsn?: string }) =>
    request<Datasource>('/api/datasources', 'POST', d),
  toggleDatasource: (name: string, enabled: boolean) =>
    request<never>(`/api/datasources/${encodeURIComponent(name)}/toggle`, 'POST', { enabled }),
  updateDatasource: (name: string, d: Partial<Datasource> & { username?: string; password?: string; dsn?: string }) =>
    request<Datasource>(`/api/datasources/${encodeURIComponent(name)}`, 'PUT', d),
  deleteDatasource: (name: string) => request<never>(`/api/datasources/${encodeURIComponent(name)}`, 'DELETE'),
  testDatasource: (name: string) => request<unknown>(`/api/datasources/${encodeURIComponent(name)}/test`, 'POST', {}),
  queryDatasource: (name: string, sql: string) =>
    request<unknown>(`/api/datasources/${encodeURIComponent(name)}/query`, 'POST', { sql }),
  explainDatasource: (name: string, sql: string) =>
    request<unknown>(`/api/datasources/${encodeURIComponent(name)}/explain`, 'POST', { sql }),
  listDocuments: (spaceId?: number, subSystemId?: number) => {
    const params = new URLSearchParams()
    if (spaceId) params.set('space_id', String(spaceId))
    if (subSystemId) params.set('sub_system_id', String(subSystemId))
    const qs = params.toString()
    return request<KBDocument[]>(`/api/kb/documents${qs ? '?' + qs : ''}`)
  },
  uploadDocument: (file: File, extra?: {
    space_id?: number
    sub_system_id?: number
    kb_type?: string
    business_domain?: string
    target_db?: string
    stage?: string
    object_type?: string
    confidence?: string
    source?: string
    source_ref?: string
  }) => {
    const fd = new FormData()
    fd.append('file', file)
    if (extra?.space_id != null) fd.append('space_id', String(extra.space_id))
    if (extra?.sub_system_id != null) fd.append('sub_system_id', String(extra.sub_system_id))
    fd.append('kb_type', extra?.kb_type || 'doc')
    fd.append('business_domain', extra?.business_domain || 'db_migrate')
    if (extra?.target_db) fd.append('target_db', extra.target_db)
    if (extra?.stage) fd.append('stage', extra.stage)
    if (extra?.object_type) fd.append('object_type', extra.object_type)
    fd.append('confidence', extra?.confidence || 'verified')
    fd.append('source', extra?.source || 'upload')
    if (extra?.source_ref) fd.append('source_ref', extra.source_ref)
    return fetch('/api/kb/documents', { method: 'POST', body: fd }).then(r => r.json()) as Promise<ApiResponse<{ id: number; chunks: number }>>
  },
  deleteDocument: (id: number) => request<never>(`/api/kb/documents/${id}`, 'DELETE'),
  searchKB: (q: string, opts?: { top_k?: number; space_id?: number }) => {
    const p = new URLSearchParams({ q })
    if (opts?.top_k) p.set('top_k', String(opts.top_k))
    if (opts?.space_id) p.set('space_id', String(opts.space_id))
    return request<KBSearchHit[]>('/api/kb/search?' + p.toString())
  },
  searchKnowledge: (payload: {
    query: string
    top_k?: number
    space_id?: number
    kb_types?: string[]
    business_domain?: string
    target_db?: string
    stage?: string
    object_type?: string
    candidate_k?: number
    min_similarity?: number
  }) => request<KnowledgeSearchResult>('/api/knowledge/search', 'POST', payload),
  feedbackKnowledge: (doc_id: number, feedback: 'positive' | 'negative', reason = '') =>
    request<{
      doc_id: number
      confidence: KnowledgeConfidence
      negative_feedback_count: number
      review_required: boolean
    }>('/api/knowledge/feedback', 'POST', { doc_id, feedback, reason }),
  listKbSpaces: () => request<{ id: number; name: string; description: string; doc_count: number; chunk_count: number; enabled: boolean; created_at: string }[]>('/api/kb/spaces'),
  createKbSpace: (payload: { name: string; description?: string }) => request<{ id: number; name: string }>('/api/kb/spaces', 'POST', payload),
  deleteKbSpace: (space_id: number) => request<never>(`/api/kb/spaces/${space_id}`, 'DELETE'),
  rebuildKG: () => request<{ entities: number; relations: number }>('/api/kg/rebuild', 'POST'),
  kgOverview: () => request<KGOverview>('/api/kg/overview'),
  kgExpand: (q: string) => request<{ terms: string[]; triples: KBTriple[] }>('/api/kg/expand?q=' + encodeURIComponent(q)),
  listSkills: () => request<Skill[]>('/api/skills'),
  createSkill: (text: string) => request<Skill>('/api/skills', 'POST', { text }),
  updateSkill: (sid: string, data: { name: string; description: string; content: string }) =>
    request<Skill>(`/api/skills/${sid}`, 'PUT', data),
  toggleSkill: (sid: string, enabled: boolean) => request<never>(`/api/skills/${sid}/toggle`, 'POST', { enabled }),
  deleteSkill: (sid: string) => request<never>(`/api/skills/${sid}`, 'DELETE'),
  runSkill: (sid: string) => request<unknown>(`/api/skills/${sid}/run`, 'POST', {}),
  uploadSkillScript: (sid: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`/api/skills/${sid}/script`, { method: 'POST', body: fd }).then(r => r.json())
  },
  listPrompts: (filter?: { type?: PromptType }) => {
    const qs = filter?.type ? new URLSearchParams({ type: filter.type }).toString() : ''
    return request<Prompt[]>(`/api/prompts${qs ? '?' + qs : ''}`)
  },
  createPrompt: (p: { name: string; category?: string; content: string; enabled?: boolean; type?: PromptType }) =>
    request<Prompt>('/api/prompts', 'POST', p),
  updatePrompt: (id: number, data: Partial<Prompt>) => request<Prompt>(`/api/prompts/${id}`, 'PUT', data),
  deletePrompt: (id: number) => request<never>(`/api/prompts/${id}`, 'DELETE'),
  promptBoundAgents: (id: number) => request<{ agent_id: string; name: string; enabled: boolean }[]>(`/api/prompts/${id}/agents`),
  listArtifacts: (convId?: number, namespace?: string, scope?: { space_id?: number; sub_system_id?: number; task_id?: number }) => {
    const params = new URLSearchParams()
    if (convId) params.set('conv_id', String(convId))
    if (namespace) params.set('namespace', namespace)
    if (scope?.space_id) params.set('space_id', String(scope.space_id))
    if (scope?.sub_system_id) params.set('sub_system_id', String(scope.sub_system_id))
    if (scope?.task_id) params.set('task_id', String(scope.task_id))
    return request<ArtifactItem[]>('/api/artifacts?' + params.toString())
  },
  listAllArtifacts: () => request<ArtifactItem[]>('/api/artifacts?all=1'),
  getArtifactFile: (rid: number) => request<string>(`/api/artifacts/${rid}/file`),
  listArtifactVersions: (rid: number) => request<ArtifactVersionItem[]>(`/api/products/${rid}/versions`),
  getArtifactVersion: (rid: number, version: number) =>
    request<ArtifactVersionItem & { content: string }>(`/api/products/${rid}/versions/${version}`),
  diffArtifact: (rid: number, left: number, right: number) =>
    request<ArtifactDiff>(`/api/products/${rid}/diff?left=${left}&right=${right}`),
  renameArtifact: (rid: number, object_name: string) => request<ArtifactItem>(`/api/artifacts/${rid}`, 'PUT', { object_name }),
  importArtifact: (rid: number, payload: { doc_name?: string; space_id?: number; description?: string }) =>
    request<{ doc_id: number; name: string; chunks: number }>(`/api/artifacts/${rid}/import`, 'POST', payload),
  deleteArtifact: (rid: number) => request<never>(`/api/artifacts/${rid}`, 'DELETE'),
  listMCPServers: () => request<MCPServer[]>('/api/mcp/servers'),
  createMCPServer: (s: { name: string; kind: string; command_or_url: string; description?: string; api_url?: string; api_key?: string; timeout?: number }) =>
    request<MCPServer>('/api/mcp/servers', 'POST', s),
  updateMCPServer: (id: number, s: Partial<MCPServer>) =>
    request<MCPServer>(`/api/mcp/servers/${id}`, 'PUT', s),
  deleteMCPServer: (id: number) => request<never>(`/api/mcp/servers/${id}`, 'DELETE'),
  toggleMCPServer: (id: number, enabled: boolean) =>
    request<never>(`/api/mcp/servers/${id}/toggle`, 'POST', { enabled }),
  testMCPServer: (id: number) => request<{ message: string }>(`/api/mcp/servers/${id}/test`, 'POST', {}),
  opsHealthHistory: () => request<OpsHealthRecord[]>('/api/ops/health/history?limit=30'),
  opsHealthCheck: (ds?: string) => request<{ message: string }>('/api/ops/health', 'POST', { ds }),
  opsSlowSQL: (thresholdMs?: number) => request<unknown>(`/api/ops/slow-sql?threshold_ms=${thresholdMs || 500}&limit=50`),
  opsBaseline: () => request<unknown>('/api/ops/baseline'),
  govCatalog: (ds?: string) => request<{ message: string }>('/api/gov/catalog', 'POST', { ds }),
  govAssets: (ds?: string) => request<GovAsset[]>('/api/gov/assets?ds=' + encodeURIComponent(ds || '')),
  govQuality: (ds?: string) => request<{ message: string }>('/api/gov/quality', 'POST', { ds }),
  govQualityRows: (ds?: string) => request<GovQualityRow[]>('/api/gov/quality/rows?ds=' + encodeURIComponent(ds || '')),
  govKgSync: () => request<{ message: string }>('/api/gov/kgsync', 'POST', {}),
  securityLogs: (limit = 300) => request<SecurityLog[]>(`/api/security/logs?limit=${limit}`),
  listTemplates: (type?: string) => {
    const params = type ? `?type=${type}` : ''
    return request<Template[]>(`/api/templates${params}`)
  },
  createTemplate: (t: Partial<Template>) => request<Template>('/api/templates', 'POST', t),
  updateTemplate: (id: number, t: Partial<Template>) => request<Template>(`/api/templates/${id}`, 'PUT', t),
  deleteTemplate: (id: number) => request<never>(`/api/templates/${id}`, 'DELETE'),
  duplicateTemplate: (id: number) => request<Template>(`/api/templates/${id}/duplicate`, 'POST'),
  // —— 数据库迁移：状态机 / 规则引擎 / 结构化资产 ——
  listMigrateTasks: (filter?: { space_id?: number; status?: string }) => {
    const p = new URLSearchParams()
    if (filter?.space_id) p.set('space_id', String(filter.space_id))
    if (filter?.status) p.set('status', String(filter.status))
    return request<MigrateTask[]>(`/api/migrate/tasks?${p.toString()}`)
  },
  createMigrateTask: (d: Partial<MigrateTask>) => request<MigrateTask>('/api/migrate/tasks', 'POST', d),
  getMigrateTask: (id: number) => request<MigrateTaskDetail>(`/api/migrate/tasks/${id}`),
  deleteMigrateTask: (id: number) => request<never>(`/api/migrate/tasks/${id}`, 'DELETE'),
  resetMigrateTask: (id: number, sess?: string) => request<MigrateTask>(`/api/migrate/tasks/${id}/reset`, 'POST', { ...(sess ? { session_id: sess } : {}) }),
  resumeMigrateTask: (id: number, sess?: string) => request<MigrateTask>(`/api/migrate/tasks/${id}/resume`, 'POST', { ...(sess ? { session_id: sess } : {}) }),
  retryMigrateTaskStage: (id: number, stage: string, sess?: string) =>
    request<{ task: MigrateTask; conv_id: number }>('/api/migrate/tasks/' + id + '/retry-stage', 'POST', {
      stage,
      ...(sess ? { session_id: sess } : {}),
    }),
  runMigrationStage: async (convId: number) => {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '开始执行',
        conv_id: convId,
        agent_id: 'migration_commander',
        skip_state_advance: true,
      }),
    })
    if (!res.ok) throw new Error(`阶段执行失败：${res.status}`)
    if (!res.body) return
    const reader = res.body.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  },
  advanceMigrateTask: (id: number, params: Record<string, unknown>) =>
    request<{ task: MigrateTask; from: string; to: string; advanced: boolean; warning?: string }>(`/api/migrate/tasks/${id}/advance`, 'POST', params),
  scanMigrateTask: (id: number, sess?: string) => request<{ object_count: number; findings: number }>(`/api/migrate/tasks/${id}/scan`, 'POST', { ...(sess ? { session_id: sess } : {}) }),
  setMigrateStepConfirm: (id: number, step_confirm: boolean) =>
    request<MigrateTaskDetail>(`/api/migrate/tasks/${id}/step-confirm`, 'POST', { step_confirm }),
  setMigrateStrictFlow: (id: number, strict_flow: boolean) =>
    request<MigrateTaskDetail>(`/api/migrate/tasks/${id}/strict-flow`, 'POST', { strict_flow }),
  listMigrateAssets: (id: number) => request<{ data: MigrateAsset[]; stats: { total: number; high: number; medium: number; low: number } }>(`/api/migrate/tasks/${id}/assets`),
  addMigrateAsset: (id: number, assets: Partial<MigrateAsset>[]) =>
    request<never>(`/api/migrate/tasks/${id}/assets`, 'POST', { assets }),
  deleteMigrateAsset: (id: number) => request<never>(`/api/migrate/assets/${id}`, 'DELETE'),
  getMigrateReport: (id: number) => request<{ task_id: number; title: string; markdown: string }>(`/api/migrate/tasks/${id}/assets/report`),
  getTraceLogs: (traceId: string) => request<TraceLogItem[]>(`/api/trace/${encodeURIComponent(traceId)}`),
  exportMigrateExcel: (id: number) => `/api/migrate/tasks/${id}/assets/export`,
  ruleScan: (sql: string, objectName?: string, assetType?: string) =>
    request<RuleScanResult>('/api/migrate/scan', 'POST', { sql, object_name: objectName, asset_type: assetType }),
  listMigrateRules: () => request<MigrateRule[]>('/api/migrate/rules'),
  /** 任务流程静态表：读取编排（空表返回默认流程） */
  getMigrateFlow: () => request<MigrateFlowNode[]>('/api/migrate/flow'),
  /** 任务流程静态表：全量保存编排（增删/排序/闸门/启停） */
  saveMigrateFlow: (nodes: Partial<MigrateFlowNode>[]) =>
    request<MigrateFlowNode[]>('/api/migrate/flow', 'PUT', { nodes }),
  /** 任务流程静态表：恢复默认流程 */
  resetMigrateFlow: () => request<MigrateFlowNode[]>('/api/migrate/flow/reset', 'POST', {}),
}
