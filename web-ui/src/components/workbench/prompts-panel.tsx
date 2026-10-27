import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { Prompt, PromptType } from '@/lib/types'
import {
  Search, Plus, Pencil, Save, FileText, X, AlertCircle, Loader2, Users, Trash2, Power
} from 'lucide-react'

const TYPE_LABELS: Record<PromptType, string> = {
  system_role: '系统角色',
  task_instruction: '任务指令',
  domain: '领域专用',
}

type FilterKey = 'all' | PromptType

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'system_role', label: '系统角色' },
  { key: 'task_instruction', label: '任务指令' },
  { key: 'domain', label: '领域专用' },
]

const TYPE_OPTIONS: PromptType[] = ['system_role', 'task_instruction', 'domain']

interface BoundAgentRow {
  agent_id: string
  name: string
  enabled: boolean
}

export function PromptsPanel() {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // 新建
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    type: 'system_role' as PromptType,
    content: '',
    enabled: true,
  })
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({})

  // 绑定 Agent 抽屉
  const [boundDrawer, setBoundDrawer] = useState<{ id: number; name: string } | null>(null)
  const [boundAgents, setBoundAgents] = useState<BoundAgentRow[]>([])
  const [boundLoading, setBoundLoading] = useState(false)
  const [boundError, setBoundError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.listPrompts()
      if (r.success) {
        setPrompts(r.data || [])
        setLoadError('')
      } else {
        setLoadError(r.detail || r.error || '加载失败')
      }
    } catch (err) {
      setLoadError(String(err) || '加载失败')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // 通知条自动消失
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(t)
  }, [notice])

  const selected = prompts.find(p => p.id === selectedId) || null

  const filtered = prompts.filter(p => {
    const matchSearch = !searchQ || p.name.toLowerCase().includes(searchQ.toLowerCase())
    const matchType = filter === 'all' || p.type === filter
    return matchSearch && matchType
  })

  const openBoundDrawer = async (p: Prompt) => {
    setBoundDrawer({ id: p.id, name: p.name })
    setBoundAgents([])
    setBoundError('')
    setBoundLoading(true)
    const r = await api.promptBoundAgents(p.id)
    if (r.success) setBoundAgents(r.data || [])
    else setBoundError(r.detail || r.error || '加载绑定列表失败')
    setBoundLoading(false)
  }

  const handleEdit = () => {
    if (!selected) return
    setEditContent(selected.content)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditContent('')
  }

  const handleSave = async () => {
    if (!selected) return
    setBusy(true)
    const r = await api.updatePrompt(selected.id, { content: editContent })
    setBusy(false)
    if (r.success) {
      setIsEditing(false)
      setNotice({ kind: 'success', text: '保存成功' })
      await load()
    } else {
      setNotice({ kind: 'error', text: r.detail || r.error || '保存失败' })
    }
  }

  const handleToggleEnabled = async () => {
    if (!selected) return
    setBusy(true)
    const r = await api.updatePrompt(selected.id, { enabled: !selected.enabled })
    setBusy(false)
    if (r.success) {
      setNotice({ kind: 'success', text: selected.enabled ? '已切换为草稿' : '已启用' })
      await load()
    } else {
      setNotice({ kind: 'error', text: r.detail || r.error || '操作失败' })
    }
  }

  const handleDelete = async () => {
    if (!selected) return
    setBusy(true)
    const r = await api.deletePrompt(selected.id)
    setBusy(false)
    if (r.success) {
      setNotice({ kind: 'success', text: `已删除「${selected.name}」` })
      setSelectedId(null)
      setIsEditing(false)
      await load()
    } else {
      // 后端绑定保护（400）等错误信息展示给用户
      setNotice({ kind: 'error', text: r.detail || r.error || '删除失败' })
    }
  }

  const handleCreate = async () => {
    const errors: Record<string, string> = {}
    if (!createForm.name.trim()) errors.name = '请输入提示词名称'
    if (!createForm.content.trim()) errors.content = '请输入提示词内容'
    setCreateErrors(errors)
    if (Object.keys(errors).length > 0) return

    setCreating(true)
    const r = await api.createPrompt({
      name: createForm.name.trim(),
      type: createForm.type,
      content: createForm.content.trim(),
      enabled: createForm.enabled,
    })
    setCreating(false)
    if (r.success) {
      setNotice({ kind: 'success', text: '创建成功' })
      setShowCreate(false)
      setCreateErrors({})
      setCreateForm({ name: '', type: createForm.type, content: '', enabled: true })
      await load()
      if (r.data && typeof r.data.id === 'number') setSelectedId(r.data.id)
    } else {
      setCreateErrors(prev => ({ ...prev, form: r.detail || r.error || '创建失败' }))
    }
  }

  const openCreate = () => {
    setCreateErrors({})
    setShowCreate(true)
  }

  const filteredEmpty = !loading && filtered.length === 0

  return (
    <div className="flex h-[calc(100vh-140px)] gap-4 relative">
      {/* 全局通知条 */}
      {notice && (
        <div
          className={cn(
            'absolute left-1/2 -translate-x-1/2 top-0 z-[60] px-4 py-2 rounded-lg border text-[12px] shadow-xl flex items-center gap-2',
            notice.kind === 'success'
              ? 'bg-green-500/15 border-green-500/40 text-green-400'
              : 'bg-red-500/15 border-red-500/40 text-red-400'
          )}
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {notice.text}
        </div>
      )}

      {/* 左侧列表 */}
      <div className="w-[380px] shrink-0 flex flex-col bg-[#16161e] border border-[#252530] rounded-xl overflow-hidden">
        {/* 搜索 */}
        <div className="p-3 border-b border-[#252530]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
            <Input
              className="h-8 pl-8 pr-3 w-full text-[12px] bg-[#1e1e28] border-[#2a2a35] placeholder:text-[#4a4a5a]"
              placeholder="搜索提示词名称"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        </div>

        {/* 类型筛选 */}
        <div className="px-3 py-2 border-b border-[#252530] flex items-center gap-1.5 flex-wrap">
          {FILTERS.map(opt => (
            <button
              key={opt.key}
              className={cn(
                'px-2.5 py-1 rounded-md text-[11px] transition-colors',
                filter === opt.key
                  ? 'bg-indigo-500 text-white'
                  : 'text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05]'
              )}
              onClick={() => setFilter(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {loading ? (
            <div className="text-center py-12">
              <Loader2 className="w-8 h-8 text-[#5a5a70] mx-auto mb-3 animate-spin" />
              <div className="text-[12px] text-[#5a5a70]">加载中...</div>
            </div>
          ) : loadError ? (
            <div className="text-center py-12 text-[12px] text-red-400 flex flex-col items-center gap-2">
              <AlertCircle className="w-6 h-6" />
              {loadError}
            </div>
          ) : filteredEmpty ? (
            <div className="text-center py-12">
              <FileText className="w-8 h-8 text-[#2a2a35] mx-auto mb-3" />
              <div className="text-[12px] text-[#5a5a70]">暂无提示词</div>
            </div>
          ) : (
            filtered.map(prompt => (
              <div
                key={prompt.id}
                className={cn(
                  'w-full text-left p-3 rounded-lg border transition-all duration-150 cursor-pointer',
                  selectedId === prompt.id
                    ? 'bg-indigo-500/10 border-indigo-500/30'
                    : 'bg-[#1e1e28] border-[#252530] hover:border-[#3a3a45]'
                )}
                onClick={() => { setSelectedId(prompt.id); setIsEditing(false) }}
              >
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <h4 className="text-[13px] font-medium text-[#cdd3e0] leading-tight">{prompt.name}</h4>
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded ml-2 shrink-0',
                    prompt.enabled
                      ? 'bg-indigo-500/20 text-indigo-400'
                      : 'bg-orange-500/20 text-orange-400'
                  )}>
                    {prompt.enabled ? '已启用' : '草稿'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {prompt.type && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#252530] text-[#9a9aa4]">
                      {TYPE_LABELS[prompt.type] || prompt.type}
                    </span>
                  )}
                  {prompt.type === 'system_role' && (
                    <button
                      className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 border border-indigo-500/25 hover:bg-indigo-500/25 inline-flex items-center gap-1 transition-colors"
                      onClick={e => { e.stopPropagation(); openBoundDrawer(prompt) }}
                      title="查看已绑定的Agent"
                    >
                      <Users className="w-2.5 h-2.5" />
                      已绑定 {prompt.bound_agent_count ?? 0} 个 Agent
                    </button>
                  )}
                </div>
                <div className="mt-2 text-[10px] text-[#4a4a5a]">
                  {prompt.updated_at || ''}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部新建按钮 */}
        <div className="p-3 border-t border-[#252530]">
          <Button className="w-full h-8 text-[12px] bg-indigo-500 hover:bg-indigo-600 text-white" onClick={openCreate}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            新建提示词
          </Button>
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 bg-[#16161e] border border-[#252530] rounded-xl overflow-hidden flex flex-col">
        {selected ? (
          <>
            {/* 标题栏 */}
            <div className="px-5 py-3 border-b border-[#252530] flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-[15px] font-semibold text-[#e4e4e9] truncate">{selected.name}</h2>
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                  selected.enabled
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-orange-500/20 text-orange-400'
                )}>
                  {selected.enabled ? '已启用' : '草稿'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] text-[#9a9aa4] hover:text-indigo-400"
                      onClick={handleCancelEdit}
                      disabled={busy}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 text-[11px] bg-green-500 hover:bg-green-600 text-white"
                      onClick={handleSave}
                      disabled={busy}
                    >
                      <Save className="w-3 h-3 mr-1" />
                      保存
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] text-[#9a9aa4] hover:text-indigo-400"
                      onClick={handleToggleEnabled}
                      disabled={busy}
                    >
                      <Power className={cn('w-3 h-3 mr-1', selected.enabled ? 'text-green-400' : 'text-[#5a5a70]')} />
                      {selected.enabled ? '禁用' : '启用'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] text-[#9a9aa4] hover:text-indigo-400"
                      onClick={handleEdit}
                      disabled={busy}
                    >
                      <Pencil className="w-3 h-3 mr-1" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] text-[#f56c6c] hover:bg-red-500/10"
                      onClick={handleDelete}
                      disabled={busy}
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      删除
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* 元数据网格 */}
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-16 shrink-0">名称</span>
                  <span className="text-[12px] text-[#cdd3e0]">{selected.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-16 shrink-0">类型</span>
                  <span className="text-[12px] text-indigo-400">
                    {selected.type ? TYPE_LABELS[selected.type] || selected.type : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-16 shrink-0">状态</span>
                  <span className="text-[12px] text-[#cdd3e0]">{selected.enabled ? '已启用' : '草稿'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#5a5a70] w-16 shrink-0">更新时间</span>
                  <span className="text-[12px] text-[#9a9aa4] font-mono">{selected.updated_at || '—'}</span>
                </div>
                {selected.type === 'system_role' && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[#5a5a70] w-16 shrink-0">绑定Agent</span>
                    <button
                      className="text-[12px] text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1"
                      onClick={() => openBoundDrawer(selected)}
                    >
                      <Users className="w-3 h-3" />
                      已绑定 {selected.bound_agent_count ?? 0} 个 Agent
                    </button>
                  </div>
                )}
              </div>

              {/* 提示词内容 */}
              <div>
                <h3 className="text-[12px] font-semibold text-[#8b8b9e] mb-2 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />
                  提示词内容
                </h3>
                {isEditing ? (
                  <Textarea
                    className="w-full min-h-[200px] bg-[#1e1e28] border-[#2a2a35] text-[12px] text-[#cdd3e0] font-mono p-3 rounded-lg focus:border-indigo-500/40"
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                  />
                ) : (
                  <div className="w-full min-h-[200px] bg-[#1e1e28] border border-[#2a2a35] text-[12px] text-[#cdd3e0] font-mono p-3 rounded-lg whitespace-pre-wrap">
                    {selected.content}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          /* 空状态 */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FileText className="w-10 h-10 text-[#2a2a35] mx-auto mb-3" />
              <p className="text-[13px] text-[#5a5a70]">选择一个提示词查看详情</p>
            </div>
          </div>
        )}
      </div>

      {/* ---- 新建提示词弹窗 ---- */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreate(false)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9]">新建提示词</h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setShowCreate(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 表单 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {createErrors.form && (
                <div className="flex items-center gap-2 text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {createErrors.form}
                </div>
              )}

              {/* 名称 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">
                  提示词名称 <span className="text-red-400">*</span>
                </label>
                <Input
                  className={cn(
                    'h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a]',
                    createErrors.name ? 'border-red-500/50' : 'border-[#2a2a35]'
                  )}
                  placeholder="例如：页面展示角色提示词"
                  value={createForm.name}
                  onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
                />
                {createErrors.name && (
                  <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />{createErrors.name}
                  </p>
                )}
              </div>

              {/* 类型 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">类型</label>
                <div className="flex items-center gap-1.5">
                  {TYPE_OPTIONS.map(t => (
                    <button
                      key={t}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[11px] transition-colors',
                        createForm.type === t
                          ? 'bg-indigo-500 text-white'
                          : 'bg-[#16161e] text-[#9a9aa4] border border-[#2a2a35] hover:border-[#3a3a45]'
                      )}
                      onClick={() => setCreateForm({ ...createForm, type: t })}
                    >
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

              {/* 初始启用状态 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">初始状态</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createForm.enabled}
                    onChange={e => setCreateForm({ ...createForm, enabled: e.target.checked })}
                    className="accent-indigo-500"
                  />
                  <span className="text-[12px] text-[#cdd3e0]">创建后立即启用</span>
                </label>
              </div>

              {/* 提示词内容 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">
                  提示词内容 <span className="text-red-400">*</span>
                </label>
                <Textarea
                  className={cn(
                    'min-h-[160px] text-[12px] bg-[#16161e] border font-mono p-3 placeholder:text-[#4a4a5a]',
                    createErrors.content ? 'border-red-500/50' : 'border-[#2a2a35]'
                  )}
                  placeholder="输入提示词内容，支持使用 {变量名} 作为动态参数..."
                  value={createForm.content}
                  onChange={e => setCreateForm({ ...createForm, content: e.target.value })}
                />
                {createErrors.content && (
                  <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />{createErrors.content}
                  </p>
                )}
              </div>
            </div>

            {/* 底部按钮 */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button
                className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
                onClick={() => setShowCreate(false)}
              >
                取消
              </button>
              <button
                className={cn(
                  'text-[12px] text-white px-4 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 transition-colors inline-flex items-center gap-1.5',
                  creating && 'opacity-60 pointer-events-none'
                )}
                onClick={handleCreate}
              >
                {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 绑定 Agent 抽屉 ---- */}
      {boundDrawer && (
        <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setBoundDrawer(null)}>
          <div
            className="absolute right-0 top-0 h-full w-[360px] bg-[#1e1e28] border-l border-[#2a2a35] shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9] flex items-center gap-2">
                <Users className="w-4 h-4 text-indigo-400" />
                已绑定 Agent
              </h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setBoundDrawer(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-2.5 border-b border-[#252530] text-[12px] text-[#cdd3e0]">
              <span className="text-[#5a5a70]">提示词：</span>
              {boundDrawer.name}
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {boundLoading ? (
                <div className="text-center py-10">
                  <Loader2 className="w-6 h-6 text-[#5a5a70] mx-auto mb-3 animate-spin" />
                  <div className="text-[12px] text-[#5a5a70]">加载中...</div>
                </div>
              ) : boundError ? (
                <div className="text-center py-10 text-[12px] text-red-400 flex flex-col items-center gap-2">
                  <AlertCircle className="w-5 h-5" />
                  {boundError}
                </div>
              ) : boundAgents.length === 0 ? (
                <div className="text-center py-10">
                  <Users className="w-8 h-8 text-[#2a2a35] mx-auto mb-3" />
                  <div className="text-[12px] text-[#5a5a70]">暂无 Agent 绑定该系统角色</div>
                </div>
              ) : (
                boundAgents.map(a => (
                  <div key={a.agent_id} className="flex items-center justify-between bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-[#e4e4e9] truncate">{a.name}</div>
                      <div className="text-[11px] text-[#5a5a70] font-mono truncate">{a.agent_id}</div>
                    </div>
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                      a.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    )}>
                      {a.enabled ? '已启用' : '已禁用'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}