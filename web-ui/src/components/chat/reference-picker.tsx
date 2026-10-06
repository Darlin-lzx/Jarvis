import { useState, useEffect, useRef } from 'react'
import {
  Bot, Hammer, BookOpen, MessageSquare, FolderKanban, Link,
  Check, X, Search, Loader2, Database,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ChatReference, ChatReferenceType } from '@/lib/types'

/** 单个可选条目（id 必须可作引用 id；sub 为辅助说明） */
interface RefItem {
  id: string | number
  name: string
  sub?: string
}

interface ReferencePickerProps {
  open: boolean
  onClose: () => void
  /** 确认后回调引用列表（已按 类型+id 去重） */
  onConfirm: (refs: ChatReference[]) => void
  convId?: number | null
  spaceId?: number | null
}

const TABS: { key: ChatReferenceType; label: string; icon: typeof Bot }[] = [
  { key: 'agent', label: '智能体', icon: Bot },
  { key: 'skill', label: '技能', icon: Hammer },
  { key: 'kb_doc', label: '知识库文档', icon: BookOpen },
  { key: 'history', label: '历史消息', icon: MessageSquare },
  { key: 'artifact', label: '产物', icon: FolderKanban },
  { key: 'kg', label: '知识图谱', icon: Link },
]

const NEEDS_CONV: ChatReferenceType[] = ['history', 'artifact']

function truncate(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function refKey(r: Pick<ChatReference, 'type' | 'id'>): string {
  return `${r.type}:${r.id}`
}

export function ReferencePicker({ open, onClose, onConfirm, convId, spaceId }: ReferencePickerProps) {
  const [activeTab, setActiveTab] = useState<ChatReferenceType>('agent')
  const [items, setItems] = useState<RefItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ChatReference[]>([])
  const [kgQuery, setKgQuery] = useState('')
  const cacheRef = useRef<Map<ChatReferenceType, RefItem[]>>(new Map())
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 打开时重置状态
  useEffect(() => {
    if (!open) return
    setActiveTab('agent')
    setKgQuery('')
    setSelected([])
  }, [open])

  // 非 kg 页签：按需加载（带缓存；history/artifact 依赖 convId，新建会话前不可用）
  useEffect(() => {
    if (!open || activeTab === 'kg') return
    let alive = true

    if (NEEDS_CONV.includes(activeTab) && convId == null) {
      setItems([])
      setError('新建会话后可以引用历史消息 / 产物')
      setLoading(false)
      return () => { alive = false }
    }

    const cached = cacheRef.current.get(activeTab)
    if (cached) {
      setItems(cached)
      setError('')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    const load = async (): Promise<RefItem[]> => {
      switch (activeTab) {
        case 'agent': {
          const r = await api.listAgents()
          return (r.success ? r.data || [] : []).filter(a => a.enabled !== false).map(a => ({
            id: a.agent_id ?? a.id, name: a.name, sub: a.description,
          }))
        }
        case 'skill': {
          const r = await api.listSkills()
          return (r.success ? r.data || [] : []).filter(s => s.enabled !== false).map(s => ({
            id: s.skill_id, name: s.name, sub: s.description,
          }))
        }
        case 'kb_doc': {
          const r = await api.listDocuments(spaceId ?? undefined, undefined)
          return (r.success ? r.data || [] : []).map(d => ({ id: d.id, name: d.name }))
        }
        case 'history': {
          if (convId == null) throw new Error('新建会话后可用')
          const r = await api.getMessages(convId)
          return (r.success ? r.data || [] : []).map(m => ({
            id: m.id,
            name: `${m.role === 'user' ? '用户' : 'AI'}：${truncate(m.content, 30)}`,
            sub: m.created_at ? `创建于 ${m.created_at.slice(0, 10)}` : m.role,
          }))
        }
        case 'artifact': {
          if (convId == null) throw new Error('新建会话后可用')
          const r = await api.listArtifacts(convId ?? undefined)
          return (r.success ? r.data || [] : []).map(a => ({
            id: a.id, name: truncate(a.object_name || `产物#${a.id}`, 40), sub: a.type || '产物',
          }))
        }
        default:
          return []
      }
    }
    load().then(list => {
      if (!alive) return
      cacheRef.current.set(activeTab, list)
      setItems(list)
      setLoading(false)
    }).catch((e: unknown) => {
      if (!alive) return
      setItems([])
      setError(e instanceof Error ? e.message : '加载失败')
      setLoading(false)
    })
    return () => { alive = false }
  }, [open, activeTab, convId, spaceId])

  // kg 页签：输入关键词防抖查询；q 为空显示空态
  useEffect(() => {
    if (!open || activeTab !== 'kg') return
    const q = kgQuery.trim()
    if (!q) {
      setItems([])
      setError('')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const r = await api.kgEntities(q)
        if (!r.success) {
          setItems([])
          setError(r.detail || r.error || '加载失败')
        } else {
          setItems((r.data || []).map(e => ({ id: e.name, name: e.name, sub: e.etype || '实体' })))
        }
      } catch {
        setItems([])
        setError('加载失败，请稍后重试')
      }
      setLoading(false)
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [open, activeTab, kgQuery])

  const toggle = (it: RefItem) => {
    setSelected(prev => {
      const key = refKey({ type: activeTab, id: it.id })
      return prev.some(p => refKey(p) === key)
        ? prev.filter(p => refKey(p) !== key)
        : [...prev, { type: activeTab, id: it.id, name: it.name }]
    })
  }

  const isSelected = (it: RefItem) => selected.some(p => refKey(p) === refKey({ type: activeTab, id: it.id }))

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[560px] max-w-full bg-[#16161e] border border-[#252530] rounded-2xl shadow-2xl flex flex-col max-h-[78vh]">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#252530] shrink-0">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-indigo-400" />
            <span className="text-[14px] font-semibold text-[#e4e4e9]">引用资源</span>
            <span className="text-[11px] text-[#5a5a70]">多选引用将注入对话上下文</span>
          </div>
          <button className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors" onClick={onClose} title="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 页签 */}
        <div className="flex items-center gap-1 px-4 pt-3 pb-2 shrink-0 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon
            const active = activeTab === t.key
            const needsConv = NEEDS_CONV.includes(t.key)
            return (
              <button
                key={t.key}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border transition-colors whitespace-nowrap',
                  active
                    ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400'
                    : 'border-transparent text-[#8b8b9e] hover:text-[#cdd3e0] hover:bg-white/[0.05]'
                )}
                onClick={() => setActiveTab(t.key)}
                title={needsConv && convId == null ? '新建会话后可用' : t.label}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {needsConv && convId == null && <span className="text-[10px] text-amber-400/80">需会话</span>}
              </button>
            )
          })}
        </div>

        {/* kg 搜索框 */}
        {activeTab === 'kg' && (
          <div className="px-4 pb-2 shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5a5a70]" />
              <input
                className="w-full h-9 pl-9 pr-4 rounded-lg bg-[#1a1a24] border border-[#252530] text-[13px] text-[#cdd3e0] placeholder:text-[#5a5a70] focus:outline-none focus:border-indigo-500/40"
                placeholder="输入关键词检索知识图谱实体…"
                value={kgQuery}
                onChange={e => setKgQuery(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* 列表区 */}
        <div className="flex-1 min-h-0 px-4 py-2 overflow-y-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-[#5a5a70]">
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
              <span className="text-[12px]">加载中…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-10 gap-1.5 text-center px-6">
              <span className="text-[12px] text-[#8b8b9e]">{error}</span>
              {activeTab === 'history' || activeTab === 'artifact' ? (
                <span className="text-[11px] text-[#5a5a70]">创建或切换到一个会话后即可引用</span>
              ) : null}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-1">
              <span className="text-[12px] text-[#8b8b9e]">
                {activeTab === 'kg' ? (kgQuery.trim() ? '未匹配到实体，换个关键词试试' : '输入关键词检索知识图谱实体') : '暂无可选资源'}
              </span>
            </div>
          ) : (
            <div className="space-y-1">
              {items.map(it => {
                const on = isSelected(it)
                return (
                  <button
                    key={refKey({ type: activeTab, id: it.id })}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-colors text-left',
                      on ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-[#1a1a24] border-[#252530] hover:border-[#3a3a45]'
                    )}
                    onClick={() => toggle(it)}
                  >
                    <span className={cn(
                      'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                      on ? 'bg-indigo-500 border-indigo-500' : 'border-[#3a3a45]'
                    )}>
                      {on && <Check className="w-3 h-3 text-white" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-[#cdd3e0] truncate">{it.name}</div>
                      {it.sub && <div className="text-[11px] text-[#5a5a70] truncate">{it.sub}</div>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#252530] shrink-0">
          {selected.length > 0 ? (
            <div className="flex items-center gap-1.5 text-[12px] text-[#8b8b9e]">
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-500/20 text-indigo-400 text-[11px] font-medium">
                {selected.length}
              </span>
              已选 {selected.length} 项
            </div>
          ) : <span className="text-[12px] text-[#5a5a70]">未选择引用</span>}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="text-[12px] h-8 border-[#252530] text-[#9a9aa4]"
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="text-[12px] h-8 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90"
              disabled={selected.length === 0}
              onClick={() => { onConfirm(selected); onClose() }}
            >
              插入引用{selected.length > 0 ? `(${selected.length})` : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}