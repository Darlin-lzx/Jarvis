import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { ArtifactItem, Conversation, Agent } from '@/lib/types'
import {
  FileText, Search, Filter, Trash2,
  Loader2, CheckCircle2, Circle, LayoutList, LayoutGrid,
  ChevronDown, X, MessageSquare, Bot,
  Upload, AlertTriangle
} from 'lucide-react'

/* ---- 类型定义 ---- */
type ArtifactStatus = '已保存' | '已入库'
type ViewMode = 'list' | 'card'
type StatusFilter = '全部' | '已入库' | '仅本地'

interface Artifact {
  id: number
  name: string
  convId: number
  convTitle: string
  agentName: string
  agentId: string
  createdAt: string
  status: ArtifactStatus
  content?: string
}

/* ---- 状态图标 ---- */
function StatusBadge({ status }: { status: ArtifactStatus }) {
  if (status === '已保存') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-[#9a9aa4]">
        <Circle className="w-3 h-3" />
        已保存
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-green-400">
      <CheckCircle2 className="w-3 h-3" />
      已入库
    </span>
  )
}

/* ---- 主组件 ---- */
export function ArtifactsPanel() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('全部')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showStatusDropdown, setShowStatusDropdown] = useState(false)

  // 弹窗状态
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Artifact | null>(null)
  const [importTarget, setImportTarget] = useState<Artifact | null>(null)
  const [showDeleteSync, setShowDeleteSync] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // 加载真实产物数据 + 会话标题 + Agent 名称映射
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [artRes, convRes, agentRes] = await Promise.all([
        api.listAllArtifacts().catch(() => null),
        api.listConversations().catch(() => null),
        api.listAgents().catch(() => null),
      ])
      const art = artRes?.success ? (artRes.data as ArtifactItem[]) : []
      const convs = convRes?.success ? (convRes.data as Conversation[]) : []
      const agents = agentRes?.success ? (agentRes.data as Agent[]) : []
      const convMap = new Map<number, string>(convs.map(c => [c.id, c.title || `会话#${c.id}`]))
      const agentMap = new Map<string, string>(agents.map(a => [a.agent_id || a.id, a.name]))
      const items: Artifact[] = art.map(a => ({
        id: a.id,
        name: (a.object_name || a.namespace || '产物').split('/').pop() || '产物',
        convId: a.conv_id || 0,
        convTitle: a.conv_id ? (convMap.get(a.conv_id) || `会话#${a.conv_id}`) : '—',
        agentName: a.agent_id ? (agentMap.get(a.agent_id) || a.agent_id) : '—',
        agentId: a.agent_id || '',
        createdAt: a.created_at ? a.created_at.replace('T', ' ').slice(0, 16) : '',
        status: a.kb_doc_id ? '已入库' as const : '已保存' as const,
      }))
      setArtifacts(items)
    } catch {
      setArtifacts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 筛选
  const filtered = artifacts.filter(a => {
    const matchSearch = !searchQ || a.name.toLowerCase().includes(searchQ.toLowerCase())
    const matchStatus =
      statusFilter === '全部' ||
      (statusFilter === '已入库' && a.status === '已入库') ||
      (statusFilter === '仅本地' && a.status !== '已入库')
    return matchSearch && matchStatus
  })

  // 全选
  const allSelected = filtered.length > 0 && filtered.every(a => selectedIds.has(a.id))
  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(a => a.id)))
    }
  }

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 批量入库：调用后端真实入库 API
  const batchImport = () => {
    const targets = artifacts.filter(a => selectedIds.has(a.id) && a.status !== '已入库')
    targets.forEach(a => {
      api.importArtifact(a.id, { doc_name: a.name }).then(() => load()).catch(() => load())
    })
    setSelectedIds(new Set())
  }

  // 批量删除
  const batchDelete = () => {
    const targets = artifacts.filter(a => selectedIds.has(a.id))
    targets.forEach(a => {
      api.deleteArtifact(a.id).then(() => load()).catch(() => load())
    })
    setSelectedIds(new Set())
  }

  // 单条删除（支持同步删除知识库文档）
  const handleDelete = async (id: number) => {
    setDeleting(true)
    try {
      await api.deleteArtifact(id)
      await load()
    } catch { /* 忽略 */ } finally {
      setDeleting(false)
      setDeleteTarget(null)
      setShowDeleteSync(false)
    }
  }

  // 预览：获取产物文件内容
  const handlePreview = async (artifact: Artifact) => {
    setPreviewArtifact(artifact)
    setPreviewLoading(true)
    try {
      const r = await api.getArtifactFile(artifact.id)
      const content = (r as unknown as { success?: boolean; content?: string })?.content
      setPreviewArtifact(prev => prev ? { ...prev, content: content || '(空文件)' } : prev)
    } catch {
      setPreviewArtifact(prev => prev ? { ...prev, content: '读取失败' } : prev)
    } finally {
      setPreviewLoading(false)
    }
  }

  const statusOptions: StatusFilter[] = ['全部', '已入库', '仅本地']

  // 入库中 / 删除中操作态
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set())
  const runImport = async (id: number) => {
    setBusyIds(prev => new Set(prev).add(id))
    try {
      await api.importArtifact(id, { doc_name: artifacts.find(a => a.id === id)?.name || undefined })
      await load()
    } finally {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n })
      setImportTarget(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">产物</h2>
        <div className="flex items-center gap-2">
          {/* 搜索 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
            <Input
              className="h-8 pl-8 pr-3 w-48 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
              placeholder="搜索产物名称"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>

          {/* 状态筛选 */}
          <div className="relative">
            <button
              className="h-8 px-3 flex items-center gap-1.5 rounded-md bg-[#16161e] border border-[#252530] text-[12px] text-[#9a9aa4] hover:border-[#3a3a45] transition-colors"
              onClick={() => setShowStatusDropdown(!showStatusDropdown)}
            >
              <Filter className="w-3 h-3" />
              筛选：{statusFilter}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showStatusDropdown && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl py-1 min-w-[120px]">
                {statusOptions.map(opt => (
                  <button
                    key={opt}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-[12px] transition-colors',
                      statusFilter === opt
                        ? 'text-indigo-400 bg-indigo-500/10'
                        : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                    )}
                    onClick={() => { setStatusFilter(opt); setShowStatusDropdown(false) }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 批量操作 */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11px] text-[#9a9aa4] hover:text-indigo-400"
                onClick={batchImport}
              >
                <Upload className="w-3 h-3 mr-1" />
                批量入库
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11px] text-[#9a9aa4] hover:text-red-400"
                onClick={batchDelete}
              >
                <Trash2 className="w-3 h-3 mr-1" />
                批量删除
              </Button>
            </div>
          )}

          {/* 视图切换 */}
          <div className="flex items-center rounded-md border border-[#252530] overflow-hidden">
            <button
              className={cn(
                'p-1.5 transition-colors',
                viewMode === 'list' ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#5a5a70] hover:text-[#9a9aa4]'
              )}
              onClick={() => setViewMode('list')}
              title="列表视图"
            >
              <LayoutList className="w-3.5 h-3.5" />
            </button>
            <button
              className={cn(
                'p-1.5 transition-colors',
                viewMode === 'card' ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#5a5a70] hover:text-[#9a9aa4]'
              )}
              onClick={() => setViewMode('card')}
              title="卡片视图"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 选中计数 */}
      {selectedIds.size > 0 && (
        <div className="text-[11px] text-indigo-400">
          已选中 {selectedIds.size} 项
        </div>
      )}

      {/* 内容区 */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-[13px] text-[#5a5a70]">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          加载中...
        </div>
      ) : filtered.length === 0 ? (
        /* 空状态 */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="w-10 h-10 text-[#2a2a35] mb-3" />
          <p className="text-[13px] text-[#5a5a70] mb-1">暂无产物</p>
          <p className="text-[11px] text-[#3a3a4a] mb-4">
            在智能体对话页面和 Agent 对话，生成的文档会自动出现在这里。
          </p>
          <Button
            variant="outline"
            size="sm"
            className="text-[11px] border-[#252530] text-[#9a9aa4] hover:text-indigo-400 hover:border-indigo-500/40"
          >
            去对话页
          </Button>
        </div>
      ) : viewMode === 'list' ? (
        /* 列表视图 */
        <div className="rounded-lg border border-[#252530] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#252530] bg-[#16161e]">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th className="text-left px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">产物名称</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">来源会话</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">生成Agent</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">生成时间</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">状态</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(artifact => (
                <tr key={artifact.id} className="border-b border-[#1e1e28] hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                      checked={selectedIds.has(artifact.id)}
                      onChange={() => toggleSelect(artifact.id)}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-[#5a5a70] shrink-0" />
                      <span className="text-[12px] text-[#cdd3e0] font-medium">{artifact.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <button className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 transition-colors flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      会话#{artifact.convId}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1 text-[11px] text-[#9a9aa4]">
                      <Bot className="w-3 h-3" />
                      {artifact.agentName}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-[11px] text-[#5a5a70] font-mono">{artifact.createdAt}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={artifact.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                        onClick={() => handlePreview(artifact)}
                      >
                        预览
                      </button>
                      {artifact.status === '已保存' && (
                        <>
                          <button
                            className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                            onClick={() => setImportTarget(artifact)}
                          >
                            {busyIds.has(artifact.id) ? '入库中...' : '入库'}
                          </button>
                          <button
                            className="text-[11px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                            onClick={() => setDeleteTarget(artifact)}
                          >
                            删除
                          </button>
                        </>
                      )}
                      {artifact.status === '已入库' && (
                        <>
                          <button
                            className="text-[11px] text-[#9a9aa4] hover:text-cyan-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                          >
                            查看知识库
                          </button>
                          <button
                            className="text-[11px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                            onClick={() => setDeleteTarget(artifact)}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* 卡片视图 */
        <div className="grid grid-cols-3 gap-3">
          {filtered.map(artifact => (
            <div
              key={artifact.id}
              className="rounded-lg bg-[#16161e] border border-[#252530] p-4 space-y-2.5 hover:border-[#3a3a45] transition-colors"
            >
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#5a5a70] shrink-0" />
                <span className="text-[12px] text-[#cdd3e0] font-medium truncate">{artifact.name}</span>
              </div>
              <div className="text-[11px] text-[#5a5a70]">
                会话#{artifact.convId} | {artifact.agentName}
              </div>
              <div className="text-[11px] text-[#5a5a70] font-mono">
                {artifact.createdAt}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-[#5a5a70]">状态：</span>
                <StatusBadge status={artifact.status} />
              </div>
              <div className="flex items-center gap-1 pt-1 border-t border-[#252530]">
                <button
                  className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                  onClick={() => handlePreview(artifact)}
                >
                  预览
                </button>
                {artifact.status === '已保存' && (
                  <>
                    <button className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">
                      下载
                    </button>
                    <button
                      className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                      onClick={() => setImportTarget(artifact)}
                    >
                      {busyIds.has(artifact.id) ? '入库中...' : '入库'}
                    </button>
                  </>
                )}
                {artifact.status === '已入库' && (
                  <>
                    <button className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">
                      下载
                    </button>
                    <button className="text-[11px] text-[#9a9aa4] hover:text-cyan-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">
                      查看知识库
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部计数 */}
      {filtered.length > 0 && (
        <div className="text-[11px] text-[#4a4a5a]">
          共 {filtered.length} 条产物
        </div>
      )}

      {/* ---- 预览弹窗 ---- */}
      {previewArtifact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPreviewArtifact(null)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[600px] max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#8b8b9e]" />
                <span className="text-[13px] font-semibold text-[#cdd3e0]">预览：{previewArtifact.name}</span>
              </div>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setPreviewArtifact(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {previewLoading ? (
                <div className="flex items-center justify-center py-8 text-[12px] text-[#5a5a70]">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  加载中...
                </div>
              ) : (
                <pre className="text-[12px] text-[#9a9aa4] whitespace-pre-wrap font-sans leading-relaxed">
                  {previewArtifact.content}
                </pre>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-3 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors">
                下载
              </button>
              {previewArtifact.status !== '已入库' && (
                <button
                  className="text-[12px] text-indigo-400 px-3 py-1.5 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
                  onClick={() => { runImport(previewArtifact.id); setPreviewArtifact(null) }}
                >
                  入库
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- 删除确认弹窗 ---- */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setDeleteTarget(null); setShowDeleteSync(false) }}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[420px]" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                </div>
                <div>
                  <h3 className="text-[13px] font-semibold text-[#cdd3e0] mb-1">删除产物</h3>
                  <p className="text-[12px] text-[#9a9aa4]">
                    你是否确认删除产物《{deleteTarget.name}》？
                  </p>
                  <label className="flex items-center gap-2 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                      checked={showDeleteSync}
                      onChange={e => setShowDeleteSync(e.target.checked)}
                    />
                    <span className="text-[11px] text-[#9a9aa4]">
                      同步删除知识库中对应的文档与向量
                    </span>
                  </label>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button
                className="text-[12px] text-[#9a9aa4] px-3 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
                onClick={() => { setDeleteTarget(null); setShowDeleteSync(false) }}
              >
                取消
              </button>
              <button
                className="text-[12px] text-white px-3 py-1.5 rounded-md bg-red-500 hover:bg-red-600 transition-colors"
                onClick={() => handleDelete(deleteTarget.id)}
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 入库弹窗 ---- */}
      {importTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setImportTarget(null)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[420px]" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 space-y-3">
              <h3 className="text-[13px] font-semibold text-[#cdd3e0]">入库产物</h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-20">入库产物：</span>
                  <span className="text-[12px] text-[#cdd3e0]">《{importTarget.name}》</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-20">目标知识库：</span>
                  <code className="text-[12px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded">{importTarget.agentName} 空间</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-20">自动绑定Agent：</span>
                  <span className="text-[12px] text-[#9a9aa4]">{importTarget.agentName}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button
                className="text-[12px] text-[#9a9aa4] px-3 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
                onClick={() => setImportTarget(null)}
              >
                取消
              </button>
              <button
                className="text-[12px] text-white px-3 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 transition-colors"
                onClick={() => runImport(importTarget.id)}
              >
                {busyIds.has(importTarget.id) ? '入库中...' : '确认入库'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
