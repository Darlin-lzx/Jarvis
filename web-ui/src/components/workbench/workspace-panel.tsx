import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { ArtifactItem, Conversation } from '@/lib/types'
import {
  MessageCircle, FileText, Database, Wrench, Bot, Puzzle,
  ChevronDown, Upload, Workflow,
  CheckCircle2, AlertTriangle, ArrowRight
} from 'lucide-react'

/* ---- 类型 ---- */
interface MetricCard {
  label: string
  value: string | number
  icon: React.ElementType
  color: string
  tab: string
  clickable: boolean
  alert?: boolean
}

interface RecentConv {
  id: number
  title: string
  agentName: string
  updatedAt: string
}

interface RecentArtifact {
  name: string
  sourceSession: string
  createdAt: string
}

interface SystemEvent {
  type: 'success' | 'warning'
  text: string
  time: string
}

const quickActions = [
  { label: '新建对话', icon: MessageCircle, color: 'bg-indigo-500 hover:bg-indigo-600', action: 'new' as const },
  { label: '上传知识库', icon: Upload, color: 'bg-green-500 hover:bg-green-600', tab: 'kb' },
  { label: '新建产物', icon: FileText, color: 'bg-purple-500 hover:bg-purple-600', tab: 'artifacts' },
  { label: '创建智能体', icon: Bot, color: 'bg-cyan-500 hover:bg-cyan-600', tab: 'agents' },
  { label: '新建技能', icon: Wrench, color: 'bg-orange-500 hover:bg-orange-600', tab: 'skills' },
]

function fmtTime(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---- 主组件 ---- */
export function WorkspacePanel({ onTabChange, onNew }: { onTabChange?: (tab: string) => void; onNew?: () => void }) {
  const [space, setSpace] = useState('')
  const [spaceOpen, setSpaceOpen] = useState(false)
  const [spaceOptions, setSpaceOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [metrics, setMetrics] = useState<MetricCard[]>([
    { label: '会话总数', value: '—', icon: MessageCircle, color: 'text-blue-400', tab: 'conversations', clickable: true },
    { label: '产物总数', value: '—', icon: FileText, color: 'text-purple-400', tab: 'artifacts', clickable: true },
    { label: '知识库文档', value: '—', icon: Database, color: 'text-green-400', tab: 'kb', clickable: true },
    { label: '技能数量', value: '—', icon: Wrench, color: 'text-orange-400', tab: 'skills', clickable: true },
    { label: '智能体', value: '—', icon: Bot, color: 'text-indigo-400', tab: 'agents', clickable: true },
    { label: '向量库', value: '…', icon: Puzzle, color: 'text-cyan-400', tab: 'vector', clickable: true },
    { label: '迁移任务', value: '—', icon: Workflow, color: 'text-emerald-400', tab: 'migrate', clickable: true },
  ])
  const [recentConvs, setRecentConvs] = useState<RecentConv[]>([])
  const [recentArts, setRecentArts] = useState<RecentArtifact[]>([])
  const [events, setEvents] = useState<SystemEvent[]>([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [convRes, artRes, kbRes, skillRes, agentRes, spaceRes, vecRes, migRes] = await Promise.all([
        api.listConversations().catch(() => null),
        api.listAllArtifacts().catch(() => null),
        api.listKbSpaces().catch(() => null),
        api.listSkills().catch(() => null),
        api.listAgents().catch(() => null),
        api.listSpaces().catch(() => null),
        api.getVectorStats().catch(() => null),
        api.listMigrateTasks().catch(() => null),
      ])
      if (!alive) return
      const convs = (convRes?.success ? (convRes.data as Conversation[]) : []) || []
      const arts = (artRes?.success ? (artRes.data as ArtifactItem[]) : []) || []
      const kbs = (kbRes?.success ? kbRes.data : []) || []
      const skills = (skillRes?.success ? (skillRes.data as { enabled: boolean }[]) : []) || []
      const agents = (agentRes?.success ? (agentRes.data as unknown[]) : []) || []
      const spaces = (spaceRes?.success ? (spaceRes.data as { id: number; name: string }[]) : []) || []
      const migTasks = (migRes?.success ? (migRes.data as unknown[]) : []) || []
      const vecStatus = vecRes?.success ? vecRes.data?.[0]?.status : undefined
      const docTotal = kbs.reduce((acc, k) => acc + (k.doc_count || 0), 0)

      setMetrics(prev => prev.map(m => {
        switch (m.label) {
          case '会话总数': return { ...m, value: convs.length }
          case '产物总数': return { ...m, value: arts.length }
          case '知识库文档': return { ...m, value: docTotal }
          case '技能数量': return { ...m, value: skills.length }
          case '智能体': return { ...m, value: agents.length }
          case '向量库': return { ...m, value: vecStatus || '无数据', alert: vecStatus === '索引异常' }
          case '迁移任务': return { ...m, value: migTasks.length }
          default: return m
        }
      }))

      // 最近会话（按更新时间倒序取 5）
      setRecentConvs([...convs]
        .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
        .slice(0, 5)
        .map(c => ({
          id: c.id,
          title: c.title,
          agentName: c.agent_id ? `Agent: ${c.agent_id}` : '未指定 Agent',
          updatedAt: fmtTime(c.updated_at),
        })))

      // 最近产物（按创建时间倒序取 5）
      setRecentArts([...arts]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 5)
        .map(a => ({
          name: a.object_name || `产物 #${a.id}`,
          sourceSession: a.namespace || (a.task_id ? `任务 #${a.task_id}` : '未归属'),
          createdAt: fmtTime(a.created_at),
        })))

      // 系统动态：由真实数据推导（产物入库状态 + 知识库文档）
      const evts: SystemEvent[] = arts
        .slice()
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 10)
        .map(a => ({
          type: 'success' as const,
          text: a.kb_doc_id
            ? `产物入库成功：${a.object_name || `产物 #${a.id}`}`
            : `产物已保存：${a.object_name || `产物 #${a.id}`}`,
          time: fmtTime(a.created_at),
        }))
      setEvents(evts)

      if (spaces.length > 0) {
        setSpaceOptions(spaces.map(s => s.name))
        setSpace(prev => prev || spaces[0].name)
      }
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  const handleCardClick = (tab: string) => {
    onTabChange?.(tab)
  }

  return (
    <div className="space-y-5">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">欢迎回来，admin</h2>
          <span className="text-[12px] text-[#5a5a70]">|</span>
          <div className="relative">
            <button
              className="flex items-center gap-1.5 text-[12px] text-[#9a9aa4] hover:text-[#cdd3e0] transition-colors"
              onClick={() => setSpaceOpen(!spaceOpen)}
            >
              当前空间：{space}
              <ChevronDown className="w-3 h-3" />
            </button>
            {spaceOpen && (
              <div className="absolute top-full left-0 mt-1 w-40 bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl z-10 py-1">
                {spaceOptions.map(s => (
                  <button
                    key={s}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-[12px] transition-colors',
                      s === space ? 'text-indigo-400 bg-indigo-500/10' : 'text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05]'
                    )}
                    onClick={() => { setSpace(s); setSpaceOpen(false) }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 核心指标卡片 */}
      <div>
        <h3 className="text-[12px] font-medium text-[#8b8b9e] mb-3">核心指标</h3>
        <div className="grid grid-cols-6 gap-3">
          {metrics.map(m => {
            const Icon = m.icon
            return (
              <button
                key={m.label}
                className={cn(
                  'rounded-xl bg-[#16161e] border border-[#252530] p-4 text-left transition-all hover:border-[#3a3a45] hover:bg-[#1a1a28]',
                  m.alert && 'border-red-500/30',
                  m.clickable && 'cursor-pointer'
                )}
                onClick={() => m.clickable && handleCardClick(m.tab)}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={cn('w-4 h-4', m.color)} />
                  <span className="text-[11px] text-[#8b8b9e]">{m.label}</span>
                </div>
                <div className={cn(
                  'text-[20px] font-semibold',
                  m.alert ? 'text-red-400' : 'text-[#e4e4e9]'
                )}>
                  {m.value}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 快捷操作区 */}
      <div>
        <h3 className="text-[12px] font-medium text-[#8b8b9e] mb-3">快捷操作</h3>
        <div className="flex items-center gap-2">
          {quickActions.map(a => {
            const Icon = a.icon
            return (
              <button
                key={a.label}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] text-white transition-colors cursor-pointer',
                  a.color
                )}
                onClick={() => { if (a.action === 'new') { onNew?.() } else { handleCardClick(a.tab || '') } }}
              >
                <Icon className="w-3.5 h-3.5" />
                {a.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* 双列：最近会话 + 最近产物 */}
      <div className="grid grid-cols-2 gap-4">
        {/* 最近会话 */}
        <div className="rounded-xl bg-[#16161e] border border-[#252530] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-[#e4e4e9]">最近会话</h3>
            <span className="text-[11px] text-[#4a4a5a]">最多5条</span>
          </div>
          <div className="space-y-2">
            {recentConvs.length === 0 ? (
              <p className="text-[12px] text-[#4a4a5a] px-2 py-4 text-center">{loading ? '加载中…' : '暂无会话，点击「新建对话」开始'}</p>
            ) : recentConvs.map(conv => (
              <button
                key={conv.id}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors text-left group"
              >
                <ArrowRight className="w-3 h-3 text-[#4a4a5a] group-hover:text-indigo-400 transition-colors flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] text-[#cdd3e0] truncate">{conv.title}</p>
                  <p className="text-[10px] text-[#5a5a70]">{conv.agentName}</p>
                </div>
                <span className="text-[10px] text-[#4a4a5a] flex-shrink-0">{conv.updatedAt}</span>
              </button>
            ))}
          </div>
          <button
            className="mt-3 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
            onClick={() => handleCardClick('conversations')}
          >
            【查看全部会话】
          </button>
        </div>

        {/* 最近产物 */}
        <div className="rounded-xl bg-[#16161e] border border-[#252530] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-[#e4e4e9]">最近产物</h3>
            <span className="text-[11px] text-[#4a4a5a]">最多5条</span>
          </div>
          <div className="space-y-2">
            {recentArts.length === 0 ? (
              <p className="text-[12px] text-[#4a4a5a] px-2 py-4 text-center">{loading ? '加载中…' : '暂无产物，对话生成后自动保存'}</p>
            ) : recentArts.map(art => (
              <button
                key={art.name}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors text-left group"
              >
                <FileText className="w-3 h-3 text-[#4a4a5a] group-hover:text-purple-400 transition-colors flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] text-[#cdd3e0] truncate">{art.name}</p>
                  <p className="text-[10px] text-[#5a5a70]">{art.sourceSession}</p>
                </div>
                <span className="text-[10px] text-[#4a4a5a] flex-shrink-0">{art.createdAt}</span>
              </button>
            ))}
          </div>
          <button
            className="mt-3 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
            onClick={() => handleCardClick('artifacts')}
          >
            【查看全部产物】
          </button>
        </div>
      </div>

      {/* 系统动态日志 */}
      <div className="rounded-xl bg-[#16161e] border border-[#252530] p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[13px] font-semibold text-[#e4e4e9]">系统动态</h3>
          <span className="text-[11px] text-[#4a4a5a]">最近10条</span>
        </div>
        <div className="space-y-2">
          {events.length === 0 ? (
            <p className="text-[12px] text-[#4a4a5a] px-2 py-4 text-center">{loading ? '加载中…' : '暂无系统动态'}</p>
          ) : events.map((evt, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1.5">
              {evt.type === 'success' ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
              )}
              <span className={cn(
                'text-[12px] flex-1',
                evt.type === 'warning' ? 'text-yellow-400' : 'text-[#9a9aa4]'
              )}>
                {evt.text}
              </span>
              <span className="text-[10px] text-[#4a4a5a] flex-shrink-0 font-mono">{evt.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
