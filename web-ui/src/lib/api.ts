import type {
  ApiResponse, Conversation, Message, TraceEvent, Settings,
  Agent, Skill, ModelDef, Datasource, DatasourceTestResult, KBDocument, KnowledgeBaseInfo, KGOverview, KBTriple,
  MCPServer, Prompt, PromptType,
  SecurityLog, Template, Space, SpaceSubsystem, BizTask, TaskDetail,
  ConversationDetail, ArtifactItem, SubSystemStats, UploadAttachmentResult, SendExtra,
  VectorSpaceStat, ChunkItem, UserProfile,
  KBSearchHit, KnowledgeConfidence, KnowledgeSearchResult,
  MigrateTask, MigrateTaskDetail, MigrateFlowNode,
  ArtifactVersionItem, ArtifactDiff, TraceLogItem,
  WorkspaceDiff, WorkspaceEvidence, WorkspaceFile, WorkspaceSummary, WorkspaceTree,
  WorkflowTemplateResponse, WorkflowParseResponse,
  AnalysisCenterInfo, AnalysisSceneResult, AnalysisNodeResult,
  AnalysisWorkflowResult, AnalysisMessageResult, CustomerOrderMessageResult,
  AcceptMessageResult, StructuredOrderInfoResult, DefSceneResult,
  SceneRulesResult, BusiCmptResult, DecryptResult, DecryptBatchResult,
  AsyncFlowResult, ProductConfigResult, SoPreBusiLimitResult, InstanceUserResult,
  StaticConfigResult, ProductDriveResult, BusinessInfoResult, UpRuleResult,
} from './types'

// —— 登录令牌（localStorage 持久化，401 统一踢回登录页） ——
const TOKEN_KEY = 'jarvis_token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function handleUnauthorized(status: number, path: string): void {
  // 登录接口自身的 401 是「用户名或密码错误」，交给页面提示，不清令牌不刷新
  if (status !== 401 || path === '/api/auth/login') return
  // 会话过期/无效：清令牌回登录页（仅当存有令牌，避免无令牌时的刷新循环）
  if (getToken()) {
    clearToken()
    window.location.reload()
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<ApiResponse<T>> {
  const opt: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...authHeaders() } }
  if (body) opt.body = JSON.stringify(body)
  const res = await fetchWithAuth(path, opt)
  handleUnauthorized(res.status, path)
  return res.json()
}

/** 带 Authorization 头的 fetch（直连 fetch 的调用统一走这里） */
async function fetchWithAuth(path: string, opt: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...opt, headers: { ...authHeaders(), ...(opt.headers ?? {}) } })
  handleUnauthorized(res.status, path)
  return res
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),
  // —— 登录鉴权 ——
  login: (username: string, password: string) =>
    request<{ token: string; username: string; display_name: string }>(
      '/api/auth/login', 'POST', { username, password }),
  logout: () => request<never>('/api/auth/logout', 'POST', {}),
  changePassword: (old_password: string, new_password: string) =>
    request<{ message: string }>('/api/auth/change-password', 'POST', { old_password, new_password }),
  listAuthUsers: () => request<unknown[]>('/api/auth/users'),
  createAuthUser: (payload: { username: string; password: string; display_name: string; role: string }) =>
    request<{ message: string }>('/api/auth/users', 'POST', payload),
  deleteAuthUser: (username: string) =>
    request<{ message: string }>(`/api/auth/users/${encodeURIComponent(username)}`, 'DELETE'),
  resetAuthUserPassword: (username: string, new_password: string) =>
    request<{ message: string }>(`/api/auth/users/${encodeURIComponent(username)}/reset-password`, 'POST', { new_password }),
  authMe: () => request<{ username: string; display_name: string; role: string }>('/api/auth/me'),
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
    request<{ id: number; title: string; space_id?: number; space_name?: string; task_id?: number }>(
      '/api/conversations', 'POST', { title, ...extra }),
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
  /** 通过业务任务 ID 查找关联的跨工程迭代任务详情（无则返回 data=null） */
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
  testDatasource: async (name: string, timeoutMs = 90000): Promise<ApiResponse<DatasourceTestResult>> => {
    // 后端最长 建连10s+读60s；前端兜底超时，避免网络黑洞时按钮无限等待
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchWithAuth(`/api/datasources/${encodeURIComponent(name)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      })
      const body = await res.json() as ApiResponse<DatasourceTestResult>
      if (!res.ok) {
        return { success: false, error: body?.detail || `数据源测试失败 (${res.status})` }
      }
      return body
    } catch (e) {
      const errName = (e as Error)?.name || ''
      if (errName === 'AbortError') {
        return { success: false, error: `测试超时（${Math.round(timeoutMs / 1000)}s），请检查 VPN/网络后重试` }
      }
      return { success: false, error: `测试请求失败: ${e}` }
    } finally {
      clearTimeout(timer)
    }
  },
  queryDatasource: (name: string, sql: string, limit = 100) =>
    request<{ ok: boolean; columns: string[]; rows: string[][]; row_count: number; message: string }>(
      `/api/datasources/${encodeURIComponent(name)}/query`, 'POST', { sql, limit }),
  explainDatasource: (name: string, sql: string) =>
    request<unknown>(`/api/datasources/${encodeURIComponent(name)}/explain`, 'POST', { sql }),
  listDocuments: (spaceId?: number, subSystemId?: number, kbId?: number) => {
    const params = new URLSearchParams()
    if (spaceId) params.set('space_id', String(spaceId))
    if (subSystemId) params.set('sub_system_id', String(subSystemId))
    if (kbId) params.set('kb_id', String(kbId))
    const qs = params.toString()
    return request<KBDocument[]>(`/api/kb/documents${qs ? '?' + qs : ''}`)
  },
  listKbs: () => request<KnowledgeBaseInfo[]>('/api/kbs'),
  createKb: (payload: { name: string; description?: string }) =>
    request<{ id: number; name: string }>('/api/kbs', 'POST', payload),
  deleteKb: (id: number) => request<never>(`/api/kbs/${id}`, 'DELETE'),
  uploadDocument: (file: File, extra?: {
    space_id?: number
    sub_system_id?: number
    kb_id?: number
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
    if (extra?.kb_id != null) fd.append('kb_id', String(extra.kb_id))
    fd.append('kb_type', extra?.kb_type || 'doc')
    fd.append('business_domain', extra?.business_domain || 'jarvis_iter')
    if (extra?.target_db) fd.append('target_db', extra.target_db)
    if (extra?.stage) fd.append('stage', extra.stage)
    if (extra?.object_type) fd.append('object_type', extra.object_type)
    fd.append('confidence', extra?.confidence || 'verified')
    fd.append('source', extra?.source || 'upload')
    if (extra?.source_ref) fd.append('source_ref', extra.source_ref)
    return fetch('/api/kb/documents', { method: 'POST', body: fd }).then(r => r.json()) as Promise<ApiResponse<{ id: number; chunks: number }>>
  },
  deleteDocument: (id: number) => request<never>(`/api/kb/documents/${id}`, 'DELETE'),
  searchKB: (q: string, opts?: { top_k?: number; space_id?: number; kb_id?: number }) => {
    const p = new URLSearchParams({ q })
    if (opts?.top_k) p.set('top_k', String(opts.top_k))
    if (opts?.space_id) p.set('space_id', String(opts.space_id))
    if (opts?.kb_id != null) p.set('kb_id', String(opts.kb_id))
    return request<KBSearchHit[]>('/api/kb/search?' + p.toString())
  },
  searchKnowledge: (payload: {
    query: string
    top_k?: number
    space_id?: number
    kb_id?: number
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
  listArtifacts: (convId?: number, namespace?: string, scope?: { space_id?: number; sub_system_id?: number; task_id?: number; conv_id?: number }) => {
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
  getArtifactContent: (rid: number) =>
    request<{ content?: string; message?: string }>(`/api/artifacts/${rid}/file`),
  agentWorkspaceSummary: (agentId: string) =>
    request<WorkspaceSummary>(`/api/agents/${encodeURIComponent(agentId)}/workspace/summary`),
  agentWorkspaceChanges: (agentId: string) =>
    request<WorkspaceSummary>(`/api/agents/${encodeURIComponent(agentId)}/workspace/changes`),
  agentWorkspaceTree: (agentId: string, path = '') =>
    request<WorkspaceTree>(`/api/agents/${encodeURIComponent(agentId)}/workspace/tree?path=${encodeURIComponent(path)}`),
  agentWorkspaceFile: (agentId: string, path: string) =>
    request<WorkspaceFile>(`/api/agents/${encodeURIComponent(agentId)}/workspace/file?path=${encodeURIComponent(path)}`),
  agentWorkspaceDiff: (agentId: string, path: string) =>
    request<WorkspaceDiff>(`/api/agents/${encodeURIComponent(agentId)}/workspace/file/diff?path=${encodeURIComponent(path)}`),
  agentWorkspaceEvidence: (agentId: string, convId?: number | null) => {
    const params = new URLSearchParams()
    if (convId != null) params.set('conv_id', String(convId))
    return request<WorkspaceEvidence>(`/api/agents/${encodeURIComponent(agentId)}/workspace/evidence?${params.toString()}`)
  },
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
  securityLogs: (limit = 300) => request<SecurityLog[]>(`/api/security/logs?limit=${limit}`),
  listTemplates: (type?: string) => {
    const params = type ? `?type=${type}` : ''
    return request<Template[]>(`/api/templates${params}`)
  },
  createTemplate: (t: Partial<Template>) => request<Template>('/api/templates', 'POST', t),
  updateTemplate: (id: number, t: Partial<Template>) => request<Template>(`/api/templates/${id}`, 'PUT', t),
  deleteTemplate: (id: number) => request<never>(`/api/templates/${id}`, 'DELETE'),
  duplicateTemplate: (id: number) => request<Template>(`/api/templates/${id}/duplicate`, 'POST'),
  // —— 跨工程迭代：状态机编排 ——
  listMigrateTasks: (filter?: { space_id?: number; status?: string }) => {
    const p = new URLSearchParams()
    if (filter?.space_id) p.set('space_id', String(filter.space_id))
    if (filter?.status) p.set('status', String(filter.status))
    return request<MigrateTask[]>(`/api/jarvis/tasks?${p.toString()}`)
  },
  createMigrateTask: (d: Partial<MigrateTask>) => request<MigrateTask>('/api/jarvis/tasks', 'POST', d),
  getMigrateTask: (id: number) => request<MigrateTaskDetail>(`/api/jarvis/tasks/${id}`),
  deleteMigrateTask: (id: number) => request<never>(`/api/jarvis/tasks/${id}`, 'DELETE'),
  resetMigrateTask: (id: number, sess?: string) => request<MigrateTask>(`/api/jarvis/tasks/${id}/reset`, 'POST', { ...(sess ? { session_id: sess } : {}) }),
  resumeMigrateTask: (id: number, sess?: string) => request<MigrateTask>(`/api/jarvis/tasks/${id}/resume`, 'POST', { ...(sess ? { session_id: sess } : {}) }),
  retryMigrateTaskStage: (id: number, stage: string, sess?: string) =>
    request<{ task: MigrateTask; conv_id: number }>('/api/jarvis/tasks/' + id + '/retry-stage', 'POST', {
      stage,
      ...(sess ? { session_id: sess } : {}),
    }),
  runMigrationStage: async (convId: number) => {
    const res = await fetchWithAuth('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '开始迭代',
        conv_id: convId,
        agent_id: 'jarvis_commander',
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
    request<{ task: MigrateTask; from: string; to: string; advanced: boolean; warning?: string }>(`/api/jarvis/tasks/${id}/advance`, 'POST', params),
  setMigrateStepConfirm: (id: number, step_confirm: boolean) =>
    request<MigrateTaskDetail>(`/api/jarvis/tasks/${id}/step-confirm`, 'POST', { step_confirm }),
  setMigrateStrictFlow: (id: number, strict_flow: boolean) =>
    request<MigrateTaskDetail>(`/api/jarvis/tasks/${id}/strict-flow`, 'POST', { strict_flow }),
  getTraceLogs: (traceId: string) => request<TraceLogItem[]>(`/api/trace/${encodeURIComponent(traceId)}`),
  getMigrateFlow: () => request<MigrateFlowNode[]>('/api/jarvis/flow'),
  /** 任务流程静态表：全量保存编排（增删/排序/闸门/启停） */
  saveMigrateFlow: (nodes: Partial<MigrateFlowNode>[]) =>
    request<MigrateFlowNode[]>('/api/jarvis/flow', 'PUT', { nodes }),
  /** 任务流程静态表：恢复默认流程 */
  resetMigrateFlow: () => request<MigrateFlowNode[]>('/api/jarvis/flow/reset', 'POST', {}),
  /** 工作流模板：按模板编码查询并解析版本（source: remote 远端配置库 / local 本地库） */
  getWorkflowTemplate: async (tag: string,
                               source: 'remote' | 'local' = 'remote'): Promise<ApiResponse<WorkflowTemplateResponse>> => {
    const res = await fetchWithAuth(`/api/workflow-templates?template_tag=${encodeURIComponent(tag)}&source=${source}`)
    const body = await res.json() as ApiResponse<WorkflowTemplateResponse> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `工作流模板查询失败 (${res.status})` }
    }
    return body
  },
  /** 工作流模板：解析编辑后的 XML 文本（图形编辑器同步用） */
  parseWorkflowTemplate: async (xml: string): Promise<ApiResponse<WorkflowParseResponse>> => {
    const res = await fetchWithAuth('/api/workflow-templates/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml }),
    })
    const body = await res.json() as ApiResponse<WorkflowParseResponse> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `工作流模板解析失败 (${res.status})` }
    }
    return body
  },
  /** 数据分析：业务中心与场景配置 */
  listAnalysisCenters: async (): Promise<ApiResponse<AnalysisCenterInfo[]>> => {
    const res = await fetchWithAuth('/api/analysis/centers')
    const body = await res.json() as ApiResponse<AnalysisCenterInfo[]> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `业务中心加载失败 (${res.status})` }
    }
    return body
  },
  /** 数据分析：场景级联查询 */
  queryAnalysisScene: async (centerCode: string, payload: {
    scene_code: string; business_key: string; city_code: string
    in_transit: boolean; history_month: string
  }): Promise<ApiResponse<AnalysisSceneResult>> => {
    const res = await fetchWithAuth(`/api/analysis/${encodeURIComponent(centerCode)}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json() as ApiResponse<AnalysisSceneResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `数据查询失败 (${res.status})` }
    }
    return body
  },
  /** 数据分析：单节点实时查询（点击调度单查工单） */
  queryAnalysisNode: async (centerCode: string, payload: {
    scene_code: string; node_code: string; value: string
    city_code: string; in_transit: boolean; history_month: string
  }): Promise<ApiResponse<AnalysisNodeResult>> => {
    const res = await fetchWithAuth(`/api/analysis/${encodeURIComponent(centerCode)}/query-node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json() as ApiResponse<AnalysisNodeResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `节点查询失败 (${res.status})` }
    }
    return body
  },
  /** 数据分析：家庭订单工作流信息 */
  getAnalysisWorkflow: async (params: {
    order_id: string; scheduler_ids: string; city_code: string
    in_transit: string; history_month: string
  }): Promise<ApiResponse<AnalysisWorkflowResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/family-order/workflow?${search}`)
    const body = await res.json() as ApiResponse<AnalysisWorkflowResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `工作流查询失败 (${res.status})` }
    }
    return body
  },
  /** 数据分析：家庭订单报文类查询（有线/计费/阶段性回复） */
  getAnalysisMessage: async (kind: 'wired-message' | 'billing-message' | 'stage-reply',
                             params: Record<string, string>): Promise<ApiResponse<AnalysisMessageResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/family-order/${kind}?${search}`)
    const body = await res.json() as ApiResponse<AnalysisMessageResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `报文查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：异步流程（ord_async_method_deal_task_order，家庭订单库；在途查不到自动回退近月历史表） */
  getAsyncFlow: async (params: {
    order_id: string; city_code: string
    in_transit: string; history_month: string
  }): Promise<ApiResponse<AsyncFlowResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/family-order/async-flow?${search}`)
    const body = await res.json() as ApiResponse<AsyncFlowResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `异步流程查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：档次配置（up_product_item/up_item_feature/up_plan_plan_rel，产品库） */
  getProductConfig: async (params: {
    product_item_id: string
  }): Promise<ApiResponse<ProductConfigResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-center/product-config?${search}`)
    const body = await res.json() as ApiResponse<ProductConfigResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `档次配置查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：策划配置（档次配置/特性/预占限制/关联产品，产品库） */
  getPlanConfig: async (params: {
    product_item_id: string
  }): Promise<ApiResponse<ProductConfigResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-center/plan-config?${search}`)
    const body = await res.json() as ApiResponse<ProductConfigResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `策划配置查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：属性信息（up_item_relat 单产品资费服务关系；关联产品点击下钻） */
  getItemRelat: async (params: {
    product_item_id: string
  }): Promise<ApiResponse<ProductConfigResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-center/item-relat?${search}`)
    const body = await res.json() as ApiResponse<ProductConfigResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `属性信息查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：限制参数（UP_PRE_LMT_PARAM；前项限制 rule_exp 拆分下钻） */
  getPreLmtParam: async (params: {
    limit_code: string
    param_id: string
  }): Promise<ApiResponse<ProductConfigResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-center/pre-lmt-param?${search}`)
    const body = await res.json() as ApiResponse<ProductConfigResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `限制参数查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：用户信息（实例中心，so570{city}.ins_user_{city} 按计费账号，营业库） */
  getInstanceUser: async (params: {
    bill_id: string
  }): Promise<ApiResponse<InstanceUserResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/instance-center/user-info?${search}`)
    const body = await res.json() as ApiResponse<InstanceUserResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `用户信息查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：框架规则定义（busicfg.UP_RULE 按规则ID，家庭业务配置库；框架规则点击弹窗） */
  getUpRule: async (params: {
    rule_id: string
  }): Promise<ApiResponse<UpRuleResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-drive-center/up-rule?${search}`)
    const body = await res.json() as ApiResponse<UpRuleResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `框架规则定义查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：业务信息（product.up_business 按业务ID，产品库；业务关系点击弹窗） */
  getBusinessInfo: async (params: {
    business_id: string
  }): Promise<ApiResponse<BusinessInfoResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-center/business-info?${search}`)
    const body = await res.json() as ApiResponse<BusinessInfoResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `业务信息查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：产品驱动（家庭业务中心；待接入真实 SQL） */
  getProductDrive: async (params: {
    product_item_id: string
    offer_id: string
    category: string
  }): Promise<ApiResponse<ProductDriveResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-drive-center/product-drive?${search}`)
    const body = await res.json() as ApiResponse<ProductDriveResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `产品驱动查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：静态配置（bs_para_detail / bs_static_data 按编码，家庭订单库） */
  getStaticConfig: async (params: {
    code: string
  }): Promise<ApiResponse<StaticConfigResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/family-order/static-config?${search}`)
    const body = await res.json() as ApiResponse<StaticConfigResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `静态配置查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：订购信息（实例中心，按计费账号，营业库；表名待确认） */
  getInstanceOrder: async (params: {
    bill_id: string
  }): Promise<ApiResponse<InstanceUserResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/instance-center/order-info?${search}`)
    const body = await res.json() as ApiResponse<InstanceUserResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `订购信息查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：业务限制（rule_Cfg.SO_PRE_BUSI_LIMIT，规则配置库；限制参数 limit_code 点击弹窗） */
  getSoPreBusiLimit: async (params: {
    limit_code: string
  }): Promise<ApiResponse<SoPreBusiLimitResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/product-center/so-pre-busi-limit?${search}`)
    const body = await res.json() as ApiResponse<SoPreBusiLimitResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `业务限制查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：客户订单下单报文（hall_cust_dtl，客户订单库 OceanBase） */
  getCustomerOrderMessage: async (params: {
    cust_order_id: string; city_code: string
    in_transit: string; history_month: string
  }): Promise<ApiResponse<CustomerOrderMessageResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/hall-center/order-message?${search}`)
    const body = await res.json() as ApiResponse<CustomerOrderMessageResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `报文查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：流程实例受理报文（HALL_ORDER_BUSI_LOG 最近一条） */
  getAcceptMessage: async (params: {
    cust_order_id: string; task_flow_ins_id: string
  }): Promise<ApiResponse<AcceptMessageResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/hall-center/accept-message?${search}`)
    const body = await res.json() as ApiResponse<AcceptMessageResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `受理报文查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：结构化订单信息（17 张 HALL_ORD_* 表并行查询） */
  getStructuredOrderInfo: async (params: {
    cust_order_id: string; city_code: string
    in_transit: string; history_month: string
  }): Promise<ApiResponse<StructuredOrderInfoResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/hall-center/structured-order-info?${search}`)
    const body = await res.json() as ApiResponse<StructuredOrderInfoResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `结构化订单查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：工单重试（task_type=5，HALL_TASK.TASK_STATE 与 HALL_TASK_FLOW_INS.handle_type 置 2，固定模板写操作） */
  retryHallTask: (params: { cust_order_id: string; task_id: string }) =>
    request<{
      ok: boolean
      rowcount: number
      message: string
      task: { ok: boolean; rowcount: number; message: string }
      flow_ins: { ok: boolean; rowcount: number; message: string }
    }>('/api/analysis/hall-center/retry-task', 'POST', params),

  /** 数据分析：展示场景（DEF_SCENE，客户订单配置库） */
  getDefScene: async (params: { scene_id: string }): Promise<ApiResponse<DefSceneResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/hall-center/def-scene?${search}`)
    const body = await res.json() as ApiResponse<DefSceneResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `场景查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：配置查询（按场景ID查 DEF_RULE 规则定义 + DEF_BUSI_CMPT 业务组件） */
  getSceneRules: async (params: {
    scene_id: string
  }): Promise<ApiResponse<SceneRulesResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/hall-center/scene-rules?${search}`)
    const body = await res.json() as ApiResponse<SceneRulesResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `配置查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：业务组件定义（DEF_BUSI_CMPT 按 BUSI_CMPT_ID） */
  getBusiCmpt: async (params: { busi_cmpt_id: string }): Promise<ApiResponse<BusiCmptResult>> => {
    const search = new URLSearchParams(params).toString()
    const res = await fetchWithAuth(`/api/analysis/hall-center/busi-cmpt?${search}`)
    const body = await res.json() as ApiResponse<BusiCmptResult> & { detail?: string }
    if (!res.ok) {
      return { success: false, error: body?.detail || `业务组件查询失败 (${res.status})` }
    }
    return body
  },

  /** 数据分析：SM4 加密字段解密（密文信封 → 密码服务） */
  decryptValue: (payload: { policy: string; cipher: string }) =>
    request<DecryptResult>('/api/analysis/family-order/decrypt', 'POST', payload),

  /** 数据分析：批量解密裸密文（结果按入参顺序对齐） */
  decryptValues: (payload: { ciphers: string[] }) =>
    request<DecryptBatchResult>('/api/analysis/family-order/decrypt-batch', 'POST', payload),
}
