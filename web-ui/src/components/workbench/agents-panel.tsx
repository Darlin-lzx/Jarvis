import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { Prompt } from '@/lib/types'
import {
  Plus, Search, ChevronRight, Trash2,
  Bot, FileText, Database, Wrench,
  AlertTriangle, Loader2, Eye, ShieldCheck, X
} from 'lucide-react'

type AgentType = '主Agent' | '子Agent'
type AgentStatus = '启用' | '禁用'

interface AgentRow {
  id: string
  name: string
  alias?: string
  uniqueKey: string
  type: AgentType
  boundKBs: string[]
  tools: string[]
  status: AgentStatus
  description: string
  prompt: string
  system_role_prompt_id?: number | null
  system_role_name?: string | null
  system_role_enabled?: boolean | null
}

// 意图到 Agent 类型的映射
const INTENT_TO_TYPE: Record<string, AgentType> = {
  'migration_assess': '主Agent',
  'ddl_convert': '子Agent',
  'code_migrate': '子Agent',
  'nl2sql': '子Agent',
  'ops_inspect': '子Agent',
  'gov_assess': '子Agent',
}

// 意图到工具权限的映射
const INTENT_TO_TOOLS: Record<string, string[]> = {
  'migration_assess': ['RAG知识库检索', '结果汇总'],
  'ddl_convert': ['RAG知识库检索', '代码生成'],
  'code_migrate': ['RAG知识库检索', '代码生成'],
  'nl2sql': ['RAG知识库检索', '数据库查询'],
  'ops_inspect': ['RAG知识库检索', '健康巡检', '慢SQL诊断'],
  'gov_assess': ['RAG知识库检索', '元数据抽取', '数据质量评估'],
}

// 将后端 Agent 数据转换为 UI 格式
function backendToUI(agent: any): AgentRow {
  const intent = agent.intent || ''
  const boundKbs: string[] = Array.isArray(agent.bound_kbs) ? agent.bound_kbs : []
  const tools: string[] = Array.isArray(agent.tools) ? agent.tools : (INTENT_TO_TOOLS[intent] || ['RAG知识库检索'])
  return {
    id: agent.id || agent.agent_id,
    name: agent.name || agent.id,
    alias: agent.alias || '',
    uniqueKey: agent.id || agent.agent_id,
    type: (agent.agent_type === '主Agent' || agent.agent_type === '子Agent') ? agent.agent_type : (INTENT_TO_TYPE[intent] || '子Agent'),
    boundKBs: boundKbs,
    tools,
    status: agent.enabled !== false ? '启用' : '禁用',
    description: agent.description || '',
    prompt: agent.default_prompt || '',
    system_role_prompt_id: agent.system_role_prompt_id ?? null,
    system_role_name: agent.system_role_name ?? null,
    system_role_enabled: agent.system_role_enabled ?? null,
  }
}

const allTools = [
  'RAG知识库检索', '代码沙盒执行', '文件读写', '联网搜索',
  '任务分发', '结果汇总', '代码生成', '需求梳理', '文档编写',
  '数据库查询', '健康巡检', '慢SQL诊断', '元数据抽取', '数据质量评估',
]

export function AgentsPanel({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('全部')
  const [typeFilter, setTypeFilter] = useState('全部')
  const [selected, setSelected] = useState<string[]>([])
  const [showBatchMenu, setShowBatchMenu] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)

  // 从后端加载 Agent 列表
  useEffect(() => {
    setLoading(true)
    api.listAgents().then(r => {
      if (r.success) {
        const uiAgents = ((r.data as any[]) || []).map(backendToUI)
        setAgents(uiAgents)
      }
    }).catch(() => {
      // 接口失败时使用空列表
      setAgents([])
    }).finally(() => {
      setLoading(false)
    })
  }, [])

  // 弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState<AgentRow | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [showValidationTip, setShowValidationTip] = useState(false)

  // 编辑/新建表单
  const [formName, setFormName] = useState('')
  const [formAlias, setFormAlias] = useState('')
  const [formKey, setFormKey] = useState('')
  const [formType, setFormType] = useState<AgentType>('子Agent')
  const [formStatus, setFormStatus] = useState<AgentStatus>('启用')
  const [formDesc, setFormDesc] = useState('')
  const [formPrompt, setFormPrompt] = useState('')
  const [formTools, setFormTools] = useState<string[]>([])

  // 系统角色提示词（只有 type=system_role 的提示词可选）
  const [systemRolePrompts, setSystemRolePrompts] = useState<Prompt[]>([])
  const [systemRoleLoading, setSystemRoleLoading] = useState(false)
  const [formSystemRoleId, setFormSystemRoleId] = useState('') // '' = 未绑定
  const [showPromptPreview, setShowPromptPreview] = useState<Prompt | null>(null)
  const [formError, setFormError] = useState('')

  // 打开弹窗时加载 type=system_role 的提示词
  const loadSystemRolePrompts = useCallback(async () => {
    setSystemRoleLoading(true)
    const r = await api.listPrompts({ type: 'system_role' })
    if (r.success) setSystemRolePrompts(r.data || [])
    setSystemRoleLoading(false)
  }, [])

  const selectedRole = systemRolePrompts.find(p => String(p.id) === formSystemRoleId) || null

  // 自动生成 key
  useEffect(() => {
    if (formName && !showEditModal) {
      setFormKey(formName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '_').replace(/\s+/g, '_'))
    }
  }, [formName, showEditModal])

  const filtered = agents.filter(a => {
    if (statusFilter !== '全部' && a.status !== statusFilter) return false
    if (typeFilter !== '全部' && a.type !== typeFilter) return false
    if (searchQ) {
      const q = searchQ.toLowerCase()
      if (!a.name.toLowerCase().includes(q) && !a.type.toLowerCase().includes(q)
        && !(a.alias || '').toLowerCase().includes(q)) return false
    }
    return true
  })

  const total = filtered.length
  const totalPages = Math.ceil(total / pageSize)
  const paginated = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const toggleAll = () => {
    setSelected(selected.length === paginated.length ? [] : paginated.map(a => a.id))
  }
  const toggleOne = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const openCreateModal = () => {
    setFormName('')
    setFormAlias('')
    setFormKey('')
    setFormType('子Agent')
    setFormStatus('启用')
    setFormDesc('')
    setFormPrompt('')
    setFormTools([])
    setFormSystemRoleId('')
    setFormError('')
    loadSystemRolePrompts()
    setShowCreateModal(true)
  }

  const openEditModal = (agent: AgentRow) => {
    setFormName(agent.name)
    setFormAlias(agent.alias || '')
    setFormKey(agent.uniqueKey)
    setFormType(agent.type)
    setFormStatus(agent.status)
    setFormDesc(agent.description)
    setFormPrompt(agent.prompt)
    setFormTools([...agent.tools])
    setFormSystemRoleId(agent.system_role_prompt_id != null ? String(agent.system_role_prompt_id) : '')
    setFormError('')
    loadSystemRolePrompts()
    setShowEditModal(agent)
  }

  const toggleTool = (tool: string) => {
    setFormTools(prev => prev.includes(tool) ? prev.filter(x => x !== tool) : [...prev, tool])
  }

  const handleSave = async () => {
    if (!formName.trim()) return

    // 校验：主Agent唯一性
    if (formType === '主Agent' && formStatus === '启用') {
      const otherMainAgent = agents.find(a =>
        a.type === '主Agent' && a.status === '启用' && a.id !== showEditModal?.id
      )
      if (otherMainAgent) {
        setShowValidationTip(true)
        return
      }
    }

    const agentId = formKey || formName.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/\s+/g, '_')
    const enabled = formStatus === '启用'
    const payload = {
      name: formName,
      alias: formAlias,
      description: formDesc,
      default_prompt: formPrompt,
      enabled,
      system_role_prompt_id: formSystemRoleId ? Number(formSystemRoleId) : null,
      // 持久化字段：类型 / 工具权限（bound_kbs 已废弃：知识库按 Space 绑定）
      agent_type: formType,
      tools: formTools,
    }

    try {
      if (showEditModal) {
        // 编辑：调用更新 API
        const r = await api.updateAgent(showEditModal.uniqueKey, payload)
        if (!r.success) {
          setFormError(r.detail || r.error || '保存失败')
          return
        }
        const role = systemRolePrompts.find(p => p.id === Number(formSystemRoleId))
        // 更新本地状态
        setAgents(prev => prev.map(a =>
          a.id === showEditModal.id
            ? {
                ...a,
                name: formName, alias: formAlias, type: formType, status: formStatus, description: formDesc,
                prompt: formPrompt, tools: formTools,
                system_role_prompt_id: payload.system_role_prompt_id,
                system_role_name: role?.name ?? null,
                system_role_enabled: role?.enabled ?? null,
              }
            : a
        ))
        setShowEditModal(null)
      } else {
        // 新建：调用创建 API
        const r = await api.createAgent({
          agent_id: agentId,
          intent: '',
          ...payload,
        })
        if (!r.success) {
          setFormError(r.detail || r.error || '保存失败')
          return
        }
        // 重新加载列表
        const rr = await api.listAgents()
        if (rr.success) {
          setAgents(((rr.data as any[]) || []).map(backendToUI))
        }
        setShowCreateModal(false)
      }
    } catch (err) {
      console.error('保存失败:', err)
      setFormError('保存失败，请稍后重试')
    }
  }

  const handleDelete = async () => {
    if (!showDeleteConfirm) return
    const agent = agents.find(a => a.id === showDeleteConfirm)
    if (!agent) return

    try {
      await api.deleteAgent(agent.uniqueKey)
      setAgents(prev => prev.filter(a => a.id !== showDeleteConfirm))
    } catch (err) {
      console.error('删除失败:', err)
    }
    setShowDeleteConfirm(null)
  }

  // 切换 Agent 启用/禁用状态
  const handleToggleStatus = async (agent: AgentRow) => {
    const newEnabled = agent.status === '启用' ? false : true
    try {
      await api.toggleAgent(agent.uniqueKey, newEnabled)
      setAgents(prev => prev.map(a =>
        a.id === agent.id ? { ...a, status: newEnabled ? '启用' : '禁用' } : a
      ))
    } catch (err) {
      console.error('切换状态失败:', err)
      window.alert('切换状态失败，请检查后端服务是否已重启')
    }
  }

  // 批量启用/禁用（持久化到数据库）
  const batchSetEnabled = async (enabled: boolean) => {
    const targets = agents.filter(a => selected.includes(a.id))
    if (!targets.length) return
    try {
      for (const a of targets) {
        await api.toggleAgent(a.uniqueKey, enabled)
      }
      setAgents(prev => prev.map(a =>
        selected.includes(a.id) ? { ...a, status: enabled ? '启用' : '禁用' } : a
      ))
      setSelected([])
      setShowBatchMenu(false)
    } catch (err) {
      console.error('批量设置状态失败:', err)
      window.alert('批量设置状态失败，请检查后端服务是否已重启')
    }
  }

  // 批量删除
  const batchDelete = async () => {
    const targets = agents.filter(a => selected.includes(a.id))
    if (!targets.length) return
    if (!window.confirm(`确认删除选中的 ${targets.length} 个智能体？删除后不可恢复。`)) return
    try {
      for (const a of targets) {
        await api.deleteAgent(a.uniqueKey)
      }
      setAgents(prev => prev.filter(a => !selected.includes(a.id)))
      setSelected([])
      setShowBatchMenu(false)
    } catch (err) {
      console.error('批量删除失败:', err)
      window.alert('批量删除失败，请检查后端服务是否已重启')
    }
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={openCreateModal}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            新建Agent
          </Button>
          <div className="relative">
            <Button size="sm" variant="outline" onClick={() => setShowBatchMenu(!showBatchMenu)} className="text-[12px]">
              批量操作
              <ChevronRight className="w-3 h-3 ml-1 rotate-90" />
            </Button>
            {showBatchMenu && (
              <div className="absolute left-0 top-full mt-1 bg-[#1e1e2a] border border-[#2a2a35] rounded-lg shadow-xl z-50 py-1 min-w-[120px]">
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]" onClick={() => batchSetEnabled(true)}>批量启用</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]" onClick={() => batchSetEnabled(false)}>批量禁用</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#f56c6c] hover:bg-red-500/10" onClick={batchDelete}>批量删除</button>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5a5a70]" />
            <Input
              className="w-48 bg-[#1a1a24] border-[#252530] pl-8 text-[12px] h-8"
              placeholder="搜索Agent名称/类型..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-[#5a5a70]">筛选:</span>
        <div className="flex items-center gap-1">
          <span className="text-[#9a9aa4]">状态</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none"
          >
            <option>全部</option>
            <option>启用</option>
            <option>禁用</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[#9a9aa4]">Agent类型</span>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none"
          >
            <option>全部</option>
            <option>主Agent</option>
            <option>子Agent</option>
          </select>
        </div>
        {selected.length > 0 && (
          <span className="text-indigo-400 ml-2">已选 {selected.length} 项</span>
        )}
      </div>

      {/* 表格 */}
      {loading ? (
        <div className="text-center py-12">
          <Loader2 className="w-8 h-8 text-[#5a5a70] mx-auto mb-3 animate-spin" />
          <div className="text-sm text-[#5a5a70]">加载中...</div>
        </div>
      ) : paginated.length > 0 ? (
        <div className="border border-[#252530] rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#1a1a24] border-b border-[#252530]">
                <th className="w-10 px-3 py-2.5 text-left">
                  <input
                    type="checkbox"
                    checked={selected.length === paginated.length && paginated.length > 0}
                    onChange={toggleAll}
                    className="accent-indigo-500"
                  />
                </th>
                <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">Agent名称</th>
                <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">类型</th>
                <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">知识库归属</th>
                <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">工具权限</th>
                <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">状态</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-medium text-[#9a9aa4]">操作</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(a => (
                <tr key={a.id} className={cn(
                  'border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors',
                  selected.includes(a.id) && 'bg-indigo-500/5'
                )}>
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.includes(a.id)}
                      onChange={() => toggleOne(a.id)}
                      className="accent-indigo-500"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Bot className="w-4 h-4 text-indigo-400" />
                      <div>
                        <div className="font-medium text-[#e4e4e9]">
                          {a.alias || a.name}
                          {a.alias && <span className="ml-1.5 text-[11px] text-[#5a5a70] font-normal">{a.name}</span>}
                        </div>
                        <div className="text-[11px] text-[#5a5a70] font-mono">{a.uniqueKey}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <Badge className={cn(
                      'text-[11px] border-0',
                      a.type === '主Agent' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-cyan-500/20 text-cyan-400'
                    )}>
                      {a.type}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-[11px] text-[#9a9aa4]">按 Space 绑定</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {a.tools.map(t => (
                        <span key={t} className="text-[11px] text-[#9a9aa4] bg-[#16161e] px-1.5 py-0.5 rounded">{t}</span>
                      ))}
                      {a.tools.length === 0 && <span className="text-[11px] text-[#3a3a4a]">无</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <Badge className={cn(
                      'text-[11px] border-0',
                      a.status === '启用' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    )}>
                      {a.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className={cn(
                          'text-[12px] px-1.5 py-0.5 rounded transition-colors',
                          a.status === '启用'
                            ? 'text-orange-400 hover:text-orange-300 hover:bg-orange-500/10'
                            : 'text-green-400 hover:text-green-300 hover:bg-green-500/10'
                        )}
                        onClick={() => handleToggleStatus(a)}
                      >
                        {a.status === '启用' ? '禁用' : '启用'}
                      </button>
                      <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors" onClick={() => openEditModal(a)}>编辑</button>
                      <button className="text-[12px] text-[#9a9aa4] hover:text-cyan-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">查看日志</button>
                      <button className="text-[12px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-500/10 transition-colors" onClick={() => setShowDeleteConfirm(a.id)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12">
          <Bot className="w-10 h-10 text-[#2a2a35] mx-auto mb-3" />
          <div className="text-sm text-[#5a5a70] mb-1">暂无Agent配置</div>
          <div className="text-xs text-[#3a3a4a]">点击【新建Agent】创建主Agent和子Agent</div>
        </div>
      )}

      {/* 多 Agent 联动提示 */}
      <div className="flex items-start gap-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3">
        <div className="w-1 h-full min-h-[16px] bg-indigo-500/50 rounded-full mt-0.5" />
        <div className="text-[12px] text-[#9a9aa4] leading-relaxed space-y-1">
          <div><span className="text-indigo-400 font-medium">提示：</span>系统<b className="text-yellow-400">不允许同时启用多个主Agent</b>，新建/编辑时会做表单校验</div>
          <div>修改 Prompt 实时生效，不需要重启服务</div>
          <div>绑定知识库、工具权限修改后实时生效</div>
          <div>删除 Agent 后任务调度将无法使用该 Agent，<b className="text-[#e4e4e9]">历史任务日志保留不删除</b></div>
        </div>
      </div>

      {/* 分页 */}
      {total > 0 && (
        <div className="flex items-center justify-between pt-2">
          <div className="text-[12px] text-[#5a5a70]">
            共 <span className="text-[#9a9aa4] font-medium">{total}</span> 条Agent
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className={cn('px-2.5 py-1 text-[12px] rounded border transition-colors', currentPage === 1 ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
            >
              &lt;
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={cn('w-7 h-7 text-[12px] rounded border transition-colors', currentPage === page ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
              >
                {page}
              </button>
            ))}
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className={cn('px-2.5 py-1 text-[12px] rounded border transition-colors', currentPage === totalPages ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
            >
              &gt;
            </button>
          </div>
        </div>
      )}

      {/* 新建/编辑 Agent 弹窗 */}
      {(showCreateModal || showEditModal) && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => { setShowCreateModal(false); setShowEditModal(null) }}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[560px] shadow-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">
                {showEditModal ? `编辑Agent：${showEditModal.name}` : '新建Agent'}
              </h3>
              <button onClick={() => { setShowCreateModal(false); setShowEditModal(null) }} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>

            {formError && (
              <div className="flex items-center gap-2 text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {formError}
              </div>
            )}

            {/* 基础信息 */}
            <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 mb-4">
              <h4 className="text-[13px] font-medium text-[#e4e4e9] mb-3 flex items-center gap-2">
                <Bot className="w-4 h-4 text-indigo-400" />
                基础信息
              </h4>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">Agent 名称 *</label>
                  <Input
                    className="bg-[#1a1a24] border-[#252530] text-[13px]"
                    placeholder="请输入Agent名称"
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">别名 / 昵称</label>
                  <Input
                    className="bg-[#1a1a24] border-[#252530] text-[13px]"
                    placeholder="对话页展示用（可留空，留空显示原名）"
                    value={formAlias}
                    onChange={e => setFormAlias(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">Agent 唯一标识 *</label>
                  <Input
                    className={cn('bg-[#1a1a24] border-[#252530] text-[13px] font-mono', showEditModal && 'opacity-60 cursor-not-allowed')}
                    placeholder="英文编码，代码调度时使用"
                    value={formKey}
                    onChange={e => setFormKey(e.target.value)}
                    readOnly={!!showEditModal}
                  />
                  <div className="text-[11px] text-[#5a5a70] mt-1">全局唯一，创建后不可修改</div>
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">Agent 类型</label>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="agentType"
                        checked={formType === '主Agent'}
                        onChange={() => setFormType('主Agent')}
                        className="accent-indigo-500"
                      />
                      <span className="text-[13px] text-indigo-400">主Agent</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="agentType"
                        checked={formType === '子Agent'}
                        onChange={() => setFormType('子Agent')}
                        className="accent-cyan-500"
                      />
                      <span className="text-[13px] text-cyan-400">子Agent</span>
                    </label>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">状态</label>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="agentStatus"
                        checked={formStatus === '启用'}
                        onChange={() => setFormStatus('启用')}
                        className="accent-green-500"
                      />
                      <span className="text-[13px] text-green-400">启用</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="agentStatus"
                        checked={formStatus === '禁用'}
                        onChange={() => setFormStatus('禁用')}
                        className="accent-gray-500"
                      />
                      <span className="text-[13px] text-gray-400">禁用</span>
                    </label>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">描述</label>
                  <textarea
                    className="w-full h-14 bg-[#1a1a24] border border-[#252530] rounded-lg p-2.5 text-[13px] text-[#e4e4e9] placeholder-[#5a5a70] resize-none focus:outline-none focus:border-indigo-500/50"
                    placeholder="备注用途"
                    value={formDesc}
                    onChange={e => setFormDesc(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* 系统提示词 */}
            <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 mb-4">
              <h4 className="text-[13px] font-medium text-[#e4e4e9] mb-3 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                系统提示词（System Prompt）
              </h4>
              <textarea
                className="w-full h-28 bg-[#1a1a24] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] placeholder-[#5a5a70] resize-none focus:outline-none focus:border-indigo-500/50"
                placeholder={formType === '主Agent' ? '主Agent的任务调度、拆解、分发指令...' : '子Agent的专项执行指令...'}
                value={formPrompt}
                onChange={e => setFormPrompt(e.target.value)}
              />
              <div className="text-[11px] text-[#5a5a70] mt-1">
                {formType === '主Agent' ? '主Agent的Prompt是任务调度、拆解、分发的指令' : '子Agent是专项执行指令'}
              </div>
            </div>

            {/* 系统角色提示词 */}
            <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-[13px] font-medium text-[#e4e4e9] flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-indigo-400" />
                  系统角色提示词（System Role）
                </h4>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => onNavigate?.('prompts')}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  新建系统角色
                </Button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">选择系统角色提示词（仅已启用可选中）</label>
                  {systemRoleLoading ? (
                    <div className="flex items-center gap-2 text-[12px] text-[#5a5a70] h-9">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      加载中...
                    </div>
                  ) : (
                    <select
                      className="w-full h-9 bg-[#1a1a24] border border-[#252530] rounded-lg px-2 text-[13px] text-[#e4e4e9] focus:outline-none focus:border-indigo-500/50"
                      value={formSystemRoleId}
                      onChange={e => setFormSystemRoleId(e.target.value)}
                    >
                      <option value="">未绑定（默认智能体）</option>
                      {systemRolePrompts.map(p => (
                        <option key={p.id} value={String(p.id)} disabled={!p.enabled}>
                          {p.name}（{p.enabled ? '已启用' : '草稿'}）
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className={cn(
                    'text-[11px] px-1.5 py-0.5 rounded',
                    selectedRole
                      ? selectedRole.enabled ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'
                      : 'bg-[#252530] text-[#9a9aa4]'
                  )}>
                    {selectedRole ? (selectedRole.enabled ? '已启用' : '草稿') : '未绑定'}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={!selectedRole}
                    onClick={() => setShowPromptPreview(selectedRole)}
                  >
                    <Eye className="w-3 h-3 mr-1" />
                    预览
                  </Button>
                </div>
                <div className="text-[11px] text-[#5a5a70] leading-relaxed">
                  {selectedRole
                    ? <>当前绑定：<span className="text-[#cdd3e0]">{selectedRole.name}</span>
                      {!selectedRole.enabled && <span className="text-orange-400">（草稿提示词不可选中，请先在提示词页启用）</span>}
                    </>
                    : '未绑定系统角色，Agent 将使用默认智能体行为'}
                </div>
              </div>
            </div>

            {/* 知识库归属（按 Space 绑定，Agent 不再直接绑定知识库） */}
            <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 mb-4">
              <h4 className="text-[13px] font-medium text-[#e4e4e9] mb-3 flex items-center gap-2">
                <Database className="w-4 h-4 text-indigo-400" />
                知识库归属
              </h4>
              <div className="text-[12px] text-[#9a9aa4] leading-relaxed">
                知识库已改为按空间（Space）绑定：检索时自动限定在当前空间的知识库文档范围内，无需在 Agent 上单独绑定。
                如需为 Agent 补充知识，请将文档上传/入库到对应空间的知识库。
              </div>
            </div>

            {/* 工具权限 */}
            <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 mb-4">
              <h4 className="text-[13px] font-medium text-[#e4e4e9] mb-3 flex items-center gap-2">
                <Wrench className="w-4 h-4 text-indigo-400" />
                工具权限（多选）
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {allTools.map(tool => (
                  <label key={tool} className="flex items-center gap-2 cursor-pointer py-1">
                    <input
                      type="checkbox"
                      checked={formTools.includes(tool)}
                      onChange={() => toggleTool(tool)}
                      className="accent-indigo-500"
                    />
                    <span className="text-[13px] text-[#e4e4e9]">{tool}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { setShowCreateModal(false); setShowEditModal(null) }}>取消</Button>
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleSave}>保存</Button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowDeleteConfirm(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[420px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">确认删除Agent？</h3>
                <p className="text-[12px] text-[#9a9aa4] mt-1">删除后任务调度将无法使用该Agent，历史任务日志保留不删除</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowDeleteConfirm(null)}>取消</Button>
              <Button size="sm" className="bg-red-500 text-white hover:bg-red-600" onClick={handleDelete}>确认删除</Button>
            </div>
          </div>
        </div>
      )}

      {/* 主Agent唯一性校验提示 */}
      {showValidationTip && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowValidationTip(false)}>
          <div className="bg-[#1e1e2a] border border-yellow-500/30 rounded-xl p-6 w-[440px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">保存失败</h3>
              </div>
            </div>
            <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3 mb-4">
              <div className="text-[12px] text-[#9a9aa4] leading-relaxed">
                系统<b className="text-yellow-400">不允许同时启用多个主Agent</b>。请先将已有的主Agent禁用，再启用当前Agent。
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={() => setShowValidationTip(false)}>确定</Button>
            </div>
          </div>
        </div>
      )}
    {/* 系统角色提示词预览抽屉 */}
      {showPromptPreview && (
        <div className="fixed inset-0 z-[120] bg-black/60" onClick={() => setShowPromptPreview(null)}>
          <div
            className="absolute right-0 top-0 h-full w-[420px] bg-[#1e1e2a] border-l border-[#2a2a35] shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9] flex items-center gap-2">
                <Eye className="w-4 h-4 text-indigo-400" />
                系统角色预览
              </h3>
              <button
                onClick={() => setShowPromptPreview(null)}
                className="text-[#5a5a70] hover:text-[#9a9aa4]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-2.5 border-b border-[#252530] flex items-center gap-2">
              <span className="text-[13px] font-medium text-[#e4e4e9]">{showPromptPreview.name}</span>
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded',
                showPromptPreview.enabled ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'
              )}>
                {showPromptPreview.enabled ? '已启用' : '草稿'}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <pre className="text-[12px] text-[#cdd3e0] bg-[#16161e] border border-[#252530] rounded-lg p-3 whitespace-pre-wrap font-mono leading-relaxed">
                {showPromptPreview.content}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
