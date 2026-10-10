import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { Conversation as ConvRecord, Agent, TraceEvent, ArtifactItem } from '@/lib/types'
import {
  Search, Plus, Trash2, Archive, MessageCircle,
  X, FileText, ChevronRight, AlertTriangle,
  CheckCircle2, Circle, Loader2, Bot, Zap,
  Database, ExternalLink
} from 'lucide-react'

/* ---- 类型 ---- */
type ConvStatus = '进行中' | '已结束' | '已归档'

interface Conversation {
  id: number
  title: string
  agentName: string
  creator: string
  createdAt: string
  messageCount: number
  status: ConvStatus
}

interface LogEntry {
  type: 'user' | 'agent' | 'rag' | 'artifact' | 'skill'
  text: string
}

/* ---- 状态图标 ---- */
function StatusBadge({ status }: { status: ConvStatus }) {
  if (status === '进行中')
    return <span className="inline-flex items-center gap-1 text-[11px] text-yellow-400"><Loader2 className="w-3 h-3 animate-spin" />进行中</span>
  if (status === '已结束')
    return <span className="inline-flex items-center gap-1 text-[11px] text-green-400"><CheckCircle2 className="w-3 h-3" />已结束</span>
  return <span className="inline-flex items-center gap-1 text-[11px] text-green-500"><Circle className="w-3 h-3 fill-green-500" />已归档</span>
}

/** trace 节点 → 日志条目类型 */
function traceEntryType(node: string): LogEntry['type'] {
  if (node === 'parse' || node === 'route') return 'agent'
  if (node === 'skill') return 'skill'
  if (node === 'artifact') return 'artifact'
  if (node === 'error') return 'agent'
  return 'rag'
}

/* ---- 主组件 ---- */
export function ConversationsPanel() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<ConvStatus | '全部'>('全部')
  const [agentFilter, setAgentFilter] = useState<string>('全部')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // 日志抽屉
  const [logSessionId, setLogSessionId] = useState<number | null>(null)
  const [logTraces, setLogTraces] = useState<TraceEvent[]>([])
  const [logArtifacts, setLogArtifacts] = useState<ArtifactItem[]>([])
  const [logLoading, setLogLoading] = useState(false)

  // 删除弹窗
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)
  const [deleteWithArtifacts, setDeleteWithArtifacts] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // 加载真实会话 + Agent 名称映射
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [convRes, agentRes] = await Promise.all([
        api.listConversations().catch(() => null),
        api.listAgents().catch(() => null),
      ])
      const convs = convRes?.success ? (convRes.data as ConvRecord[]) : []
      const agents = agentRes?.success ? (agentRes.data as Agent[]) : []
      const agentMap = new Map<string, string>(agents.map(a => [a.agent_id || a.id, a.name]))
      const items: Conversation[] = convs.map(c => ({
        id: c.id,
        title: c.title || `会话#${c.id}`,
        agentName: c.agent_id ? (agentMap.get(c.agent_id) || c.agent_id) : '—',
        creator: c.space_name ? c.space_name : '—',
        createdAt: c.created_at ? c.created_at.replace('T', ' ').slice(0, 16) : '',
        messageCount: c.message_count || 0,
        status: '进行中' as const,
      }))
      setConversations(items)
    } catch {
      setConversations([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 筛选
  const filtered = conversations.filter(c => {
    const matchSearch = !searchQ || c.title.toLowerCase().includes(searchQ.toLowerCase()) || String(c.id).includes(searchQ.toLowerCase())
    const matchStatus = statusFilter === '全部' || c.status === statusFilter
    const matchAgent = agentFilter === '全部' || c.agentName === agentFilter
    return matchSearch && matchStatus && matchAgent
  })

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(c => c.id)))
    }
  }

  const handleArchive = (id: number) => {
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, status: '已归档' as const } : c
    ))
  }

  const handleBatchArchive = () => {
    setConversations(prev => prev.map(c =>
      selectedIds.has(c.id) ? { ...c, status: '已归档' as const } : c
    ))
    setSelectedIds(new Set())
  }

  const handleBatchDelete = async () => {
    const targets = conversations.filter(c => selectedIds.has(c.id))
    if (!targets.length) return
    try {
      const results = await Promise.all(
        targets.map(c => api.deleteConversation(c.id).catch(() => null)),
      )
      if (results.some(r => !r || !r.success)) {
        window.alert('部分会话删除失败，已保留原选择，请稍后重试')
        await load()
        return
      }
      setSelectedIds(new Set())
      await load()
    } catch {
      window.alert('批量删除会话失败，请稍后重试')
      await load()
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const cid = deleteTarget.id
    setDeleting(true)
    try {
      const r = await api.deleteConversation(cid)
      if (!r.success) {
        window.alert(r.message || '删除会话失败，请稍后重试')
        setDeleting(false)
        return
      }
      setDeleteTarget(null)
      setDeleteWithArtifacts(false)
      await load()
    } catch {
      window.alert('删除会话失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  const handleRestore = (id: number) => {
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, status: '进行中' as const } : c
    ))
  }

  // 打开日志抽屉：加载真实 trace 与该会话产物
  const openLog = async (id: number) => {
    setLogSessionId(id)
    setLogLoading(true)
    setLogTraces([])
    setLogArtifacts([])
    try {
      const [tr, ar] = await Promise.all([
        api.getTrace(id).catch(() => null),
        api.listArtifacts(id).catch(() => null),
      ])
      setLogTraces(tr?.success ? (tr.data as TraceEvent[]) : [])
      setLogArtifacts(ar?.success ? (ar.data as ArtifactItem[]) : [])
    } finally {
      setLogLoading(false)
    }
  }

  const agentOptions = ['全部', ...Array.from(new Set(conversations.map(c => c.agentName)))]
  const statusOptions: ConvStatus[] = ['进行中', '已结束', '已归档']

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">会话管理</h2>
        <Button className="h-8 text-[12px] bg-indigo-500 hover:bg-indigo-600 text-white">
          <Plus className="w-3.5 h-3.5 mr-1" />
          新建会话
        </Button>
      </div>

      {/* 搜索 + 筛选 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
          <Input
            className="h-8 pl-8 pr-3 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
            placeholder="搜索会话标题/会话ID"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-[#8b8b9e]">
          <span>状态筛选：</span>
          <select
            className="h-7 rounded-md text-[12px] bg-[#16161e] border border-[#252530] px-2 text-[#cdd3e0]"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as ConvStatus | '全部')}
          >
            <option value="全部">全部</option>
            {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-[#8b8b9e]">
          <span>智能体筛选：</span>
          <select
            className="h-7 rounded-md text-[12px] bg-[#16161e] border border-[#252530] px-2 text-[#cdd3e0]"
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
          >
            <option value="全部">全部</option>
            {agentOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {/* 表格 */}
      <div className="rounded-xl border border-[#252530] overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-[13px] text-[#5a5a70]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            加载中...
          </div>
        ) : (
        <>
        <table className="w-full text-[12px] whitespace-nowrap">
          <thead>
            <tr className="bg-[#16161e] border-b border-[#252530]">
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">会话标题</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">会话ID</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">关联智能体</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">创建人</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">创建时间</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">消息轮次</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">状态</th>
              <th className="px-3 py-2.5 text-right text-[#8b8b9e] font-medium sticky right-0 bg-[#16161e] z-10 border-l border-[#252530]">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(conv => (
              <tr key={conv.id} className="border-b border-[#1e1e28] hover:bg-white/[0.02] transition-colors">
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                    checked={selectedIds.has(conv.id)}
                    onChange={() => toggleSelect(conv.id)}
                  />
                </td>
                <td className="px-3 py-2.5 text-[#cdd3e0] font-medium">{conv.title}</td>
                <td className="px-3 py-2.5">
                  <code className="text-[11px] text-[#5a5a70] bg-[#16161e] px-1.5 py-0.5 rounded">{conv.id}</code>
                </td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1 text-[#9a9aa4]">
                    <Bot className="w-3 h-3 text-indigo-400" />
                    {conv.agentName}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-[#9a9aa4]">{conv.creator}</td>
                <td className="px-3 py-2.5 font-mono text-[#5a5a70]">{conv.createdAt}</td>
                <td className="px-3 py-2.5 text-[#9a9aa4]">{conv.messageCount}</td>
                <td className="px-3 py-2.5"><StatusBadge status={conv.status} /></td>
                <td className="px-3 py-2.5 text-right sticky right-0 bg-[#13131a] z-10 border-l border-[#252530]">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      className="text-[11px] px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 hover:text-indigo-200 transition-colors"
                      title="打开对话"
                    >
                      打开对话
                    </button>
                    <span className="text-[#2a2a35]">|</span>
                    <button
                      className="text-[11px] text-[#cdd3e0] hover:text-[#e4e4e9] transition-colors"
                      onClick={() => openLog(conv.id)}
                    >
                      日志
                    </button>
                    <span className="text-[#2a2a35]">|</span>
                    {conv.status === '已归档' ? (
                      <>
                        <button
                          className="text-[11px] text-green-400 hover:text-green-300 transition-colors"
                          onClick={() => handleRestore(conv.id)}
                        >
                          恢复
                        </button>
                        <span className="text-[#2a2a35]">|</span>
                      </>
                    ) : (
                      <>
                        <button
                          className="text-[11px] px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 hover:text-indigo-200 transition-colors"
                          onClick={() => handleArchive(conv.id)}
                        >
                          归档
                        </button>
                        <span className="text-[#2a2a35]">|</span>
                      </>
                    )}
                    <button
                      className="text-[11px] text-red-400 hover:text-red-300 transition-colors"
                      onClick={() => setDeleteTarget(conv)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageCircle className="w-8 h-8 text-[#3a3a4a] mb-2" />
            <p className="text-[13px] text-[#5a5a70] mb-1">暂无会话记录</p>
            <p className="text-[11px] text-[#3a3a4a] mb-3">前往对话页面发起对话，会话会自动展示在这里。</p>
            <button className="text-[12px] text-indigo-400 hover:text-indigo-300 transition-colors">
              【去对话页】
            </button>
          </div>
        )}
        </>
        )}
      </div>

      {/* 底部批量操作栏 */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-[#16161e] border border-[#252530]">
          <span className="text-[12px] text-[#9a9aa4]">已选择 {selectedIds.size} 条会话</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] text-[#9a9aa4] hover:text-indigo-400"
              onClick={handleBatchArchive}
            >
              <Archive className="w-3 h-3 mr-1" />
              批量归档
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] text-[#9a9aa4] hover:text-red-400"
              onClick={handleBatchDelete}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              批量删除
            </Button>
          </div>
        </div>
      )}

      {/* ---- 日志抽屉 ---- */}
      {logSessionId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setLogSessionId(null)}>
          <div className="w-[420px] h-full bg-[#1a1a24] border-l border-[#252530] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* 抽屉标题 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#252530]">
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-[#e4e4e9]">会话日志</h3>
                <code className="text-[11px] text-[#5a5a70] bg-[#16161e] px-1.5 py-0.5 rounded">{logSessionId}</code>
              </div>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setLogSessionId(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* 基础信息 */}
              {(() => {
                const conv = conversations.find(c => c.id === logSessionId)
                if (!conv) return null
                return (
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">基础信息</h4>
                    <div className="space-y-1.5 text-[12px]">
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">会话标题</span>
                        <span className="text-[#cdd3e0]">{conv.title}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">智能体</span>
                        <span className="text-[#cdd3e0]">{conv.agentName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">创建时间</span>
                        <span className="text-[#cdd3e0] font-mono">{conv.createdAt}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">消息轮次</span>
                        <span className="text-[#cdd3e0]">{conv.messageCount} 次</span>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* 执行记录 */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">执行记录（时间线）</h4>
                <div className="space-y-2">
                  {logLoading && <p className="text-[11px] text-[#3a3a4a]">加载中...</p>}
                  {logTraces.map((t, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="mt-0.5">
                        {(() => {
                          const ty = traceEntryType(t.node)
                          if (ty === 'agent') return <Bot className="w-3 h-3 text-indigo-400" />
                          if (ty === 'artifact') return <FileText className="w-3 h-3 text-green-400" />
                          if (ty === 'skill') return <Zap className="w-3 h-3 text-yellow-400" />
                          return <Database className="w-3 h-3 text-cyan-400" />
                        })()}
                      </div>
                      <span className="text-[12px] text-[#9a9aa4] leading-relaxed">
                        <span className="text-[#5a5a70]">[{t.node}] </span>
                        {typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}
                      </span>
                    </div>
                  ))}
                  {!logLoading && logTraces.length === 0 && (
                    <p className="text-[11px] text-[#3a3a4a]">暂无执行记录</p>
                  )}
                </div>
              </div>

              {/* 产物列表 */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">本次会话产物列表</h4>
                <div className="space-y-1.5">
                  {logArtifacts.map((art, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      <ChevronRight className="w-3 h-3 text-[#4a4a5a]" />
                      <FileText className="w-3 h-3 text-[#5a5a70]" />
                      <span className="text-[#cdd3e0]">{(art.object_name || art.namespace).split('/').pop()}</span>
                      <button className="text-[11px] text-indigo-400 hover:text-indigo-300 ml-auto flex items-center gap-0.5">
                        <ExternalLink className="w-2.5 h-2.5" />
                        跳转产物页面
                      </button>
                    </div>
                  ))}
                  {logArtifacts.length === 0 && (
                    <p className="text-[11px] text-[#3a3a4a]">本次会话暂无产物</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- 删除确认弹窗 ---- */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setDeleteTarget(null); setDeleteWithArtifacts(false) }}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[400px]" onClick={e => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <h3 className="text-[14px] font-semibold text-[#e4e4e9]">删除会话</h3>
              </div>
              <p className="text-[12px] text-[#9a9aa4] mb-4">
                是否确认删除会话《{deleteTarget.title}》？
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                  checked={deleteWithArtifacts}
                  onChange={e => setDeleteWithArtifacts(e.target.checked)}
                />
                <span className="text-[12px] text-[#9a9aa4]">同步删除本次会话生成的所有产物</span>
                <span className="text-[11px] text-[#4a4a5a]">（默认不勾选）</span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button
                className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
                onClick={() => { setDeleteTarget(null); setDeleteWithArtifacts(false) }}
              >
                取消
              </button>
              <button
                className="text-[12px] text-white px-4 py-1.5 rounded-md bg-red-500 hover:bg-red-600 transition-colors flex items-center gap-1"
                onClick={handleDelete}
              >
                <Trash2 className="w-3 h-3" />
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
