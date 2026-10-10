import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, Bot, BookOpen, FolderPlus, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { BizTask, Space } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface NewTaskContext {
  lockSpace?: boolean | undefined   // 场景 C：空间详情页锁定
  space?: Space | undefined         // 场景 B/C 预选空间
  agentId?: string | undefined      // 场景 B 当前 Agent / 复制任务
  convId?: number | undefined       // 场景 B 来源会话（创建并进入会话）
  name?: string | undefined         // 复制任务：预填任务名称
  description?: string | undefined  // 复制任务：预填描述
  kbIds?: number[] | undefined      // 复制任务：预填知识库
}

interface Props {
  open: boolean
  onClose: () => void
  context?: NewTaskContext
  agents?: { id: string; name: string }[]
  onCreate: (task: BizTask, enterSession?: boolean) => void
}

export function NewTaskDialog({ open, onClose, context, agents = [], onCreate }: Props) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [agentId, setAgentId] = useState(context?.agentId || '')
  const [kbIds, setKbIds] = useState<number[]>([])
  const [kbs, setKbs] = useState<{ id: number; name: string }[]>([])
  const [advOpen, setAdvOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 真实主 Agent 列表（任务主智能体必须是主 Agent）
  const [mainAgents, setMainAgents] = useState<{ id: string; name: string }[]>([])

  const lockSpace = !!context?.lockSpace

  useEffect(() => {
    if (!open) return
    setSaving(false)
    setError(null)
    api.listSpaces().then(r => {
      if (!r.success) return
      setSpaces(r.data || [])
      if (context?.space) {
        setSpaceId(context.space.id)
      } else {
        // 场景 A：无默认值，必须手动选择空间
        setSpaceId(null)
      }
    })
    // 复制任务 / 场景 B：预填名称、描述、主 Agent、知识库（无上下文则清空）
    setName(context?.name ?? '')
    setDesc(context?.description ?? '')
    setAgentId(context?.agentId ?? '')
    setKbIds(context?.kbIds ?? [])
    api.listAgents().then(r => {
      if (r.success) {
        const mains = (r.data || []).filter(a => (a.enabled !== false) && (a.agent_type === '主Agent' || a.agent_type === '总控智能体'))
        setMainAgents(mains.map(a => ({ id: a.id || a.agent_id || '', name: a.name })))
      }
    }).catch(() => {})
    api.listDocuments().then(r => { if (r.success) setKbs((r.data || []) as { id: number; name: string }[]) })
    if (context?.convId) {
      api.getConversation(context.convId).then(r => {
        if (r.success && r.data && r.data.space_id) {
          setSpaceId(r.data.space_id)
        }
      })
    }
  }, [open, context?.space?.id])

  // 可用的主 Agent 选项（优先真实主 Agent；其次外部传入的主/总控 Agent）
  const agentOptions = useMemo(() => {
    if (mainAgents.length > 0) return mainAgents
    return agents.filter(a => /主|总控/.test(a.name)).map(a => ({ id: a.id, name: a.name }))
  }, [mainAgents, agents])

  const submit = async (enterSession: boolean) => {
    if (!spaceId) return
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const r = await api.createTask({
        space_id: spaceId,
        name: name.trim(), description: desc, kb_ids: kbIds, agent_id: agentId,
      })
      if (r.success && r.data) onCreate(r.data, enterSession)
      else {
        setError(r.error || r.detail || '任务创建失败，请稍后重试')
        setSaving(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '任务创建失败，请稍后重试')
      setSaving(false)
    }
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div className="bg-[#16161e] border border-[#252530] rounded-2xl w-[520px] max-h-[86vh] overflow-auto p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[15px] font-semibold flex items-center gap-2"><FolderPlus className="w-4 h-4 text-indigo-400" />新建任务</h3>
          <button onClick={onClose} className="text-[#5a5a70] hover:text-white transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-[12px] text-[#9a9aa4] mb-1.5 block">空间 <span className="text-red-400">*</span></label>
            <select
              value={spaceId ?? ''}
              disabled={lockSpace}
              onChange={e => setSpaceId(Number(e.target.value) || null)}
              className={cn('w-full h-9 rounded-lg bg-[#0f0f14] border border-[#252530] px-3 text-[13px]',
                lockSpace ? 'text-[#6a6a7a] cursor-not-allowed' : 'text-[#e4e4e9]')}
            >
              {lockSpace ? <option value={spaceId ?? ''}>{context?.space?.name}</option> : <option value="">请选择空间…</option>}
              {!lockSpace && spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {lockSpace && <p className="text-[11px] text-[#5a5a70] mt-1">所属空间创建后不可修改</p>}
          </div>

          <div>
            <label className="text-[12px] text-[#9a9aa4] mb-1.5 block">任务名称 <span className="text-red-400">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="如：营业系统全量 DDL 迁移"
              className="w-full h-9 rounded-lg bg-[#0f0f14] border border-[#252530] px-3 text-[13px] placeholder:text-[#5a5a70]" />
          </div>

          <div>
            <label className="text-[12px] text-[#9a9aa4] mb-1.5 block">任务描述（可选）</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="任务目标、范围…"
              className="w-full rounded-lg bg-[#0f0f14] border border-[#252530] px-3 py-2 text-[13px] placeholder:text-[#5a5a70]" />
          </div>

          <div className="border border-[#252530] rounded-xl overflow-hidden">
            <button onClick={() => setAdvOpen(!advOpen)} className="w-full flex items-center justify-between px-3 py-2.5 text-[12px] text-[#9a9aa4] hover:text-[#cdd3e0]">
              <span className="flex items-center gap-1.5"><Settings2 className="w-3.5 h-3.5" />高级设置（默认继承空间知识库与当前 Agent）</span>
              <span>{advOpen ? '−' : '+'}</span>
            </button>
            {advOpen && (
              <div className="px-3 pb-3 space-y-3">
                <div>
                  <label className="text-[11px] text-[#5a5a70] block mb-1"><BookOpen className="inline w-3 h-3 mr-1" />关联知识库</label>
                  <div className="max-h-24 overflow-auto space-y-1">
                    {kbs.map(k => (
                      <label key={k.id} className="flex items-center gap-2 text-[12px] text-[#cdd3e0] cursor-pointer">
                        <input type="checkbox" checked={kbIds.includes(k.id)}
                          onChange={e => setKbIds(prev => e.target.checked ? [...prev, k.id] : prev.filter(x => x !== k.id))} />
                        {k.name}
                      </label>
                    ))}
                    {kbs.length === 0 && <span className="text-[11px] text-[#5a5a70]">（知识库为空，默认继承空间）</span>}
                  </div>
                </div>
                <div>
                  <label className="text-[11px] text-[#5a5a70] block mb-1"><Bot className="inline w-3 h-3 mr-1" />主智能体（主 Agent）</label>
                  <select value={agentId} onChange={e => setAgentId(e.target.value)}
                    className="w-full h-8 rounded-lg bg-[#0f0f14] border border-[#252530] px-2 text-[12px]">
                    <option value="">默认主 Agent</option>
                    {agentOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <p className="text-[10px] text-[#5a5a70] mt-0.5">任务主智能体必须为主 Agent，不能选择子 Agent</p>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2.5 pt-2">
            <button onClick={() => submit(false)}
              disabled={!spaceId || !name.trim() || saving}
              className="flex-1 h-9 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[13px] disabled:opacity-40">
              {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : '创建任务'}
            </button>
            <button onClick={() => submit(true)}
              disabled={!spaceId || !name.trim() || saving}
              className="flex-1 h-9 rounded-lg bg-[#1e1e28] border border-[#2f2f38] text-[13px] text-[#cdd3e0] hover:border-indigo-500/40 disabled:opacity-40">
              创建并进入会话
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
