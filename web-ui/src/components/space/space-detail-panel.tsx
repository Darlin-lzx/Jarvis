import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { BizTask, Conversation, Space, SpaceSubsystem, ArtifactItem as KbArtifact } from '@/lib/types'
import { TaskStatusBadge } from '@/lib/task-status'
import type { NewTaskContext } from '@/components/project/new-task-dialog'
import {
  Settings, UserPlus, MoreHorizontal, FolderPlus, FolderOpen, FileText,
  MessageSquare, Package, BookOpen, Database, Puzzle, Plus, X, ChevronDown,
  ChevronRight, Clock, AlertTriangle, CheckCircle2, Circle, Loader2,
  Calendar, Users, FileCode2, RefreshCw, Download, Archive, Copy,
  ArrowLeft, Trash, Wrench,
} from 'lucide-react'

/* ---- 类型 ---- */
interface SpaceChild { id: string; name: string }
export interface SpaceInfo { id: string; name: string; description: string; tags: string[]; owner: string; createdAt: string; children?: SpaceChild[] }

interface SubSystemCard { id: string; name: string; description: string; owner: string; tags: string[]; taskCount: number; artifactCount: number; real?: boolean; sub?: SpaceSubsystem }
interface TaskItem { id: string; name: string; subSystem: string; status: '进行中' | '已完成' | '失败'; time: string; agent?: string }
interface ConvItem { id: string; title: string; subSystem: string; time: string }
interface ArtifactItem { id: string; name: string; kind: string; subSystem: string; time: string }
interface LogItem { id: string; type: string; content: string; status: '成功' | '失败' | '进行中'; time: string }

/* ---- 工具 ---- */
const fmtTime = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const taskStatusOf = (s: BizTask['status']): TaskItem['status'] =>
  s === 'done' ? '已完成' : s === 'failed' ? '失败' : '进行中'

type MetricDef = { key: string; label: string; value: number; icon: React.ComponentType<{ className?: string }> }

const quickActions = [
  { label: '新建任务', icon: Plus, tint: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' },
  { label: '新建会话', icon: MessageSquare, tint: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' },
  { label: '上传知识库', icon: BookOpen, tint: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  { label: '新建数据源', icon: Database, tint: 'text-green-400 bg-green-500/10 border-green-500/20' },
  { label: '新建智能体', icon: Puzzle, tint: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  { label: '新建技能', icon: Wrench, tint: 'text-pink-400 bg-pink-500/10 border-pink-500/20' },
]

const statusBadge: Record<TaskItem['status'], string> = {
  '进行中': 'text-indigo-400 bg-indigo-500/15',
  '已完成': 'text-green-400 bg-green-500/15',
  '失败': 'text-red-400 bg-red-500/15',
}

const avatarColors = ['#5b7cfa', '#7a5bfa', '#10b981', '#f59e0b', '#ec4899']

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const color = avatarColors[(name.charCodeAt(0) || 0) % avatarColors.length]
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, backgroundColor: color, fontSize: Math.round(size * 0.42) }}
    >
      {name.slice(0, 1)}
    </div>
  )
}

/* ---- 环形进度图 ---- */
function RingChart({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  const R = 62, C = 2 * Math.PI * R
  let acc = 0
  const done = segments.find(s => s.label === '已完成')?.value || 0
  return (
    <div className="flex items-center gap-6">
      <svg width="150" height="150" viewBox="0 0 150 150" className="-rotate-0">
        <circle cx="75" cy="75" r={R} fill="none" stroke="#252530" strokeWidth="14" />
        {segments.map((seg, i) => {
          const frac = seg.value / total
          const el = (
            <circle
              key={i}
              cx="75" cy="75" r={R} fill="none" stroke={seg.color} strokeWidth="14"
              strokeDasharray={`${Math.max(frac * C - 3, 0.5)} ${C}`}
              strokeDashoffset={-acc * C}
              transform="rotate(-90 75 75)"
              strokeLinecap="round"
            />
          )
          acc += frac
          return el
        })}
        <text x="75" y="72" textAnchor="middle" fill="#e4e4e9" fontSize="22" fontWeight="700">{done}</text>
        <text x="75" y="92" textAnchor="middle" fill="#5a5a70" fontSize="11">已完成</text>
      </svg>
      <div className="space-y-2.5">
        {segments.map(seg => (
          <div key={seg.label} className="flex items-center gap-2 text-[12px]">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: seg.color }} />
            <span className="text-[#cdd3e0]">{seg.label}</span>
            <span className="text-[#8b8b9e] ml-auto font-mono">{seg.value}</span>
          </div>
        ))}
        <div className="text-[11px] text-[#5a5a70] pt-1">hover 查看明细·共 {total} 项</div>
      </div>
    </div>
  )
}

/* ---- 空间头部栏 ---- */
function SpaceHeader({ space, onSettings, onInvite, onMore }: {
  space: SpaceInfo; onSettings: () => void; onInvite: () => void; onMore: () => void
}) {
  const { name, description, tags, owner, createdAt } = space
  return (
    <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
            <FolderOpen className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-[17px] font-semibold text-[#e4e4e9]">{name}</h2>
              <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-400 border-indigo-500/20">项目空间</Badge>
            </div>
            <p className="text-[12px] text-[#8b8b9e] mt-1.5">{description}</p>
            <div className="flex items-center flex-wrap gap-1.5 mt-3">
              {tags.map(t => (
                <span key={t} className="text-[11px] px-2 py-0.5 rounded bg-[#26262d] text-[#9a9aa4] border border-[#2f2f38]">#{t}</span>
              ))}
              <span className="inline-flex items-center gap-1 text-[11px] text-[#5a5a70] ml-1">
                <Calendar className="w-3 h-3" />创建时间：{createdAt}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-[#5a5a70]">
                <Users className="w-3 h-3" />负责人：{owner}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" className="h-7 text-[12px] text-[#cdd3e0] border border-[#252530] hover:border-indigo-500/40" onClick={onSettings}>
            <Settings className="w-3.5 h-3.5 mr-1" />设置
          </Button>
          <Button size="sm" className="h-7 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={onInvite}>
            <UserPlus className="w-3.5 h-3.5 mr-1" />邀请成员
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-[#9a9aa4] hover:text-[#cdd3e0]" onClick={onMore} title="更多">
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ---- 指标卡片 ---- */
function MetricCards({ metrics }: { metrics: MetricDef[] }) {
  return (
    <div className="grid grid-cols-6 gap-3">
      {metrics.map(m => {
        const Icon = m.icon
        return (
          <div key={m.key} className="rounded-xl border border-[#252530] bg-[#1d1d22] p-3.5 hover:border-[#3a3a45] transition-colors">
            <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center mb-2.5', metricTint(m.key))}>
              <Icon className="w-4 h-4" />
            </div>
            <div className="text-[22px] font-bold text-[#e4e4e9] leading-none">{m.value}</div>
            <div className="text-[11px] text-[#5a5a70] mt-1">{m.label}</div>
          </div>
        )
      })}
    </div>
  )
}

function metricTint(key: string) {
  const map: Record<string, string> = {
    task: 'text-indigo-400 bg-indigo-500/10',
    conv: 'text-cyan-400 bg-cyan-500/10',
    artifact: 'text-amber-400 bg-amber-500/10',
    doc: 'text-blue-400 bg-blue-500/10',
    ds: 'text-green-400 bg-green-500/10',
    skill: 'text-purple-400 bg-purple-500/10',
  }
  return map[key] || 'bg-white/[0.05]'
}

/* ---- 快捷操作 ---- */
function QuickActions() {
  return (
    <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
      <div className="text-[13px] font-semibold text-[#e4e4e9] mb-3">快捷操作</div>
      <div className="flex items-center gap-2">
        {quickActions.map(a => (
          <button
            key={a.label}
            className={cn('flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] border transition-colors hover:brightness-125', a.tint)}
          >
            <a.icon className="w-3.5 h-3.5" />
            {a.label}
          </button>
        ))}
        <div className="text-[11px] text-[#5a5a70] ml-auto">新建资源默认归属当前空间</div>
      </div>
    </div>
  )
}

/* ---- 最近任务/会话 ---- */
function TaskRow({ t }: { t: TaskItem }) {
  return (
    <div className="flex items-center gap-2 py-2">
      <Package className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-[#cdd3e0] truncate">{t.name}</div>
        <div className="text-[10px] text-[#5a5a70]">{t.subSystem}</div>
      </div>
      <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0', statusBadge[t.status])}>{t.status}</span>
      <span className="text-[10px] text-[#5a5a70] shrink-0">{t.time}</span>
    </div>
  )
}

export function SpaceDetailPage({ space, onNewTask, onOpenTask, onOpenSub }: {
  space: SpaceInfo
  onBack?: () => void
  onNewTask?: (ctx?: NewTaskContext) => void
  onOpenTask?: (t: BizTask) => void
  onOpenSub?: (spaceId: number, spaceName: string, sub: SpaceSubsystem) => void
}) {
  const [spaceInfo, setSpaceInfo] = useState<SpaceInfo>(space)
  const [view, setView] = useState<{ mode: 'overview' } | { mode: 'subsystem'; id: string }>({ mode: 'overview' })

  // 真实空间与资源数据（按名称匹配 api.listSpaces 返回的真实 Space）
  const [realSpace, setRealSpace] = useState<Space | null>(null)
  const [allSpaces, setAllSpaces] = useState<Space[]>([])
  const [realTasks, setRealTasks] = useState<BizTask[]>([])
  const [realConvs, setRealConvs] = useState<Conversation[]>([])
  const [realArts, setRealArts] = useState<KbArtifact[]>([])
  const [kbSpaces, setKbSpaces] = useState<{ id: number; doc_count: number }[]>([])
  const [dsCount, setDsCount] = useState(0)
  const [skillCount, setSkillCount] = useState(0)
  const [activeSubTab, setActiveSubTab] = useState<'任务' | '会话' | '产物'>('任务')

  useEffect(() => {
    let mounted = true
    api.listSpaces().then(r => {
      if (!mounted || !r.success) return
      setAllSpaces(r.data || [])
      setRealSpace((r.data || []).find(s => s.name === space.name) || null)
    }).catch(() => {})
    return () => { mounted = false }
  }, [space.name])

  useEffect(() => {
    if (!realSpace) { setRealTasks([]); setRealConvs([]); setRealArts([]); setDsCount(0); return }
    api.listTasks(realSpace.id).then(r => { if (r.success) setRealTasks(r.data || []) }).catch(() => {})
    api.listConversations({ space_id: realSpace.id }).then(r => { if (r.success) setRealConvs(r.data || []) }).catch(() => {})
    api.listArtifacts(undefined, undefined, { space_id: realSpace.id }).then(r => { if (r.success) setRealArts(r.data || []) }).catch(() => {})
    api.listDatasources(realSpace.id).then(r => { if (r.success) setDsCount((r.data || []).length) }).catch(() => {})
  }, [realSpace])

  // 切到「会话」标签时刷新会话列表（新建会话后无需重进空间页即可看到）
  useEffect(() => {
    if (!realSpace || activeSubTab !== '会话') return
    api.listConversations({ space_id: realSpace.id }).then(r => { if (r.success) setRealConvs(r.data || []) }).catch(() => {})
  }, [realSpace, activeSubTab])

  useEffect(() => {
    api.listKbSpaces().then(r => { if (r.success) setKbSpaces(r.data || []) }).catch(() => {})
    api.listSkills().then(r => { if (r.success) setSkillCount((r.data || []).length) }).catch(() => {})
  }, [])

  // 弹窗/抽屉
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  // 设置抽屉 tab
  const [settingsTab, setSettingsTab] = useState<'基础' | '成员' | '统计' | '智能体' | '高级'>('基础')
  const [showAllConvs, setShowAllConvs] = useState(false)
  const [showAllArts, setShowAllArts] = useState(false)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // 空间切换下拉
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false)
  const spaceMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (spaceMenuRef.current && !spaceMenuRef.current.contains(e.target as Node)) setSpaceMenuOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // 派生：映射为卡片展示结构
  const subNameOf = (id?: number | null) =>
    id == null ? '未分配' : realSpace?.subsystems?.find(s => s.id === id)?.name || '未分配'
  const toTaskItem = (t: BizTask): TaskItem => ({
    id: String(t.id), name: t.name, subSystem: subNameOf(t.sub_system_id),
    status: taskStatusOf(t.status), time: fmtTime(t.created_at), agent: t.agent_id,
  })
  const toConvItem = (c: Conversation): ConvItem => ({
    id: String(c.id), title: c.title,
    subSystem: c.sub_system_name || subNameOf(c.sub_system_id), time: fmtTime(c.created_at),
  })
  const toArtItem = (a: KbArtifact): ArtifactItem => ({
    id: String(a.id), name: a.object_name || a.namespace, kind: a.type || '文件',
    subSystem: subNameOf(a.sub_system_id), time: fmtTime(a.created_at),
  })

  const docCount = (realSpace?.kb_ids || []).reduce((s, kid) => s + (kbSpaces.find(k => k.id === kid)?.doc_count || 0), 0)
  const metrics: MetricDef[] = [
    { key: 'task', label: '任务总数', value: realTasks.length, icon: Package },
    { key: 'conv', label: '会话总数', value: realConvs.length, icon: MessageSquare },
    { key: 'artifact', label: '产物总数', value: realArts.length, icon: FileText },
    { key: 'doc', label: '知识库文档', value: docCount, icon: BookOpen },
    { key: 'ds', label: '数据源数量', value: dsCount, icon: Database },
    { key: 'skill', label: '技能数量', value: skillCount, icon: Puzzle },
  ]

  // 业务子系统卡片（真实子系统）
  const realSubs = realSpace?.subsystems?.length ? realSpace.subsystems : []
  const subCards: SubSystemCard[] = realSubs.map(s => ({
    id: String(s.id), name: s.name, description: s.description || '',
    owner: s.owner || '', tags: s.tags || [],
    taskCount: realTasks.filter(t => t.sub_system_id === s.id).length,
    artifactCount: realArts.filter(a => a.sub_system_id === s.id).length,
    real: true, sub: s,
  }))

  const openSub = (s: SubSystemCard) => {
    if (s.real && s.sub && realSpace && onOpenSub) {
      onOpenSub(realSpace.id, realSpace.name, s.sub)
      return
    }
    setActiveSubTab('任务')
    setView({ mode: 'subsystem', id: s.id })
  }

  /* 子系统视图（真实数据：按空间 + 子系统过滤） */
  if (view.mode === 'subsystem') {
    const sys = subCards.find(s => s.id === view.id)
    const sid = sys?.sub?.id
    const tasks = realTasks.filter(t => sid != null && t.sub_system_id === sid).map(toTaskItem)
    const convs = realConvs.filter(c => sid != null && c.sub_system_id === sid).map(toConvItem)
    const arts = realArts.filter(a => sid != null && a.sub_system_id === sid).map(toArtItem)
    return (
      <SubSystemView
        space={spaceInfo}
        sys={sys || { id: view.id, name: '未知子系统', description: '', owner: '', tags: [], taskCount: 0, artifactCount: 0 }}
        tasks={tasks}
        convs={convs}
        arts={arts}
        docCount={docCount}
        tab={activeSubTab}
        setTab={setActiveSubTab}
        onBack={() => setView({ mode: 'overview' })}
      />
    )
  }

  const allConvs = realConvs.map(toConvItem)
  const allArts = realArts.map(toArtItem)
  const recentTasks = realTasks.slice(0, 5).map(toTaskItem)
  const recentConvs = allConvs.slice(0, 3)
  const recentArts = allArts.slice(0, 4)
  const events: LogItem[] = realArts.slice(0, 6).map(a => ({
    id: String(a.id),
    type: a.kb_doc_id ? '产物入库' : '产物保存',
    content: `${a.object_name || a.namespace}${a.kb_doc_id ? ' 已入库知识库' : ' 已保存至产物库'}`,
    status: '成功' as const,
    time: fmtTime(a.created_at),
  }))
  const migrationSegments = [
    { label: '待评估', value: realTasks.filter(t => t.status === 'pending' || t.status === 'paused').length, color: '#6a6a7a' },
    { label: '转换中', value: realTasks.filter(t => t.status === 'running').length, color: '#f59e0b' },
    { label: '已完成', value: realTasks.filter(t => t.status === 'done').length, color: '#5b7cfa' },
    { label: '失败', value: realTasks.filter(t => t.status === 'failed').length, color: '#ef4444' },
  ]

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-[1400px] mx-auto space-y-4">
        {/* 面包屑 */}
        <Breadcrumb
          spaceName={spaceInfo.name}
          onSwitch={() => setSpaceMenuOpen(!spaceMenuOpen)}
          menuOpen={spaceMenuOpen}
        />
        {spaceMenuOpen && (
          <div ref={spaceMenuRef} className="fixed z-[100] bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl py-1 min-w-[160px]" style={{ top: 96, left: 16 }}>
            {allSpaces.length === 0 && <div className="px-3 py-2 text-[11px] text-[#5a5a70]">暂无空间</div>}
            {allSpaces.map(s => (
              <button
                key={s.id}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors',
                  String(s.id) === spaceInfo.id ? 'bg-indigo-500/10 text-indigo-300' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                )}
                onClick={() => {
                  setSpaceInfo(prev => ({ ...prev, id: String(s.id), name: s.name, description: s.description || prev.description }))
                  setSpaceMenuOpen(false)
                }}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {s.name}
              </button>
            ))}
          </div>
        )}

        {/* 空间头部 */}
        <SpaceHeader
          space={spaceInfo}
          onSettings={() => { setSettingsTab('基础'); setSettingsOpen(true) }}
          onInvite={() => setInviteOpen(true)}
          onMore={() => setMoreOpen(!moreOpen)}
        />
        {moreOpen && (
          <div ref={moreRef} className="fixed z-[100] bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl py-1 min-w-[160px]" style={{ top: 250, right: 24 }}>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors" onClick={() => setMoreOpen(false)}>
              <Archive className="w-3.5 h-3.5" />归档空间
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors" onClick={() => setMoreOpen(false)}>
              <Copy className="w-3.5 h-3.5" />复制空间模板
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors" onClick={() => setMoreOpen(false)}>
              <Download className="w-3.5 h-3.5" />导出空间统计报告
            </button>
          </div>
        )}

        {/* 指标卡片 */}
        <MetricCards metrics={metrics} />

        {/* 快捷操作 */}
        <QuickActions />

        {/* 业务任务（真实数据，场景 C 入口） */}
        <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9]">
              <Package className="w-4 h-4 text-indigo-400" />业务任务
            </div>
            <button
              className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white disabled:opacity-40"
              disabled={!realSpace}
              onClick={() => onNewTask?.(realSpace ? { lockSpace: true, space: realSpace } : undefined)}
              title="进入空间详情页新建任务，空间锁定不可修改"
            >
              <Plus className="w-3.5 h-3.5" />新建任务
            </button>
          </div>
          <div className="divide-y divide-[#252530]">
            {realTasks.length === 0 && (
              <div className="py-6 text-center text-[12px] text-[#5a5a70]">暂无任务，点击「新建任务」创建</div>
            )}
            {realTasks.map(t => (
              <button
                key={t.id}
                className="w-full flex items-center gap-2 py-2 px-1 -mx-1 rounded text-left hover:bg-white/[0.03] transition-colors"
                onClick={() => onOpenTask?.(t)}
              >
                <Package className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] text-[#cdd3e0] truncate">{t.name}</span>
                  <span className="block text-[10px] text-[#5a5a70]">会话 {t.conv_count ?? 0} · 产物 {t.artifact_count ?? 0}</span>
                </span>
                <TaskStatusBadge status={t.status} />
              </button>
            ))}
          </div>
        </div>

        {/* 双栏主体 */}
        <div className="grid grid-cols-2 gap-4">
          {/* 业务子系统 */}
          <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9]">
                <FolderOpen className="w-4 h-4 text-indigo-400" />业务子系统
              </div>
              <button className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors" onClick={() => setAddSubOpen(true)}>
                <Plus className="w-3 h-3" />新增子系统
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {subCards.map(s => (
                <button
                  key={s.id}
                  className="text-left rounded-lg border border-[#252530] bg-[#16161e] p-3 hover:border-indigo-500/30 hover:bg-indigo-500/5 transition-all group"
                  onClick={() => openSub(s)}
                >
                  <div className="flex items-center gap-1.5 mb-2">
                    <FolderOpen className="w-3.5 h-3.5 text-indigo-400/70" />
                    <span className="text-[12px] font-medium text-[#cdd3e0]">{s.name}</span>
                    <ChevronRight className="w-3 h-3 text-[#3a3a4a] ml-auto group-hover:text-indigo-400 transition-colors" />
                  </div>
                  <div className="flex gap-3 text-[11px] text-[#5a5a70]">
                    {s.real ? (
                      <>
                        <span>{s.description || '暂无描述'}</span>
                        {s.owner && <span>· {s.owner}</span>}
                      </>
                    ) : (
                      <>
                        <span>任务：{s.taskCount}</span>
                        <span>产物：{s.artifactCount}</span>
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
            <div className="text-[11px] text-[#5a5a70] mt-2.5">点击子系统卡片进入资源列表</div>
          </div>

          {/* 项目迁移进度 */}
          <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9] mb-3">
              <RefreshCw className="w-4 h-4 text-cyan-400" />项目迁移进度概览
            </div>
            <RingChart segments={migrationSegments} />
            <div className="flex items-center gap-4 text-[11px] text-[#5a5a70] mt-3 pt-3 border-t border-[#252530]">
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-indigo-400" />迁移评估</span>
              <span className="inline-flex items-center gap-1"><Circle className="w-3 h-3 text-amber-400" />DDL 转换</span>
              <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3 text-[#6a6a7a]" />SQL 优化</span>
            </div>
          </div>

          {/* 最近任务 */}
          <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9]">
                <Package className="w-4 h-4 text-indigo-400" />最近任务
              </div>
              <button className="text-[11px] text-indigo-400 hover:text-indigo-300">查看全部任务</button>
            </div>
            <div className="divide-y divide-[#252530]">
              {recentTasks.length === 0 && (
                <div className="py-4 text-center text-[12px] text-[#5a5a70]">暂无任务</div>
              )}
              {recentTasks.map((t, i) => (
                <div key={t.id}>
                  {i === 0 && <div className="h-1" />}
                  <TaskRow t={t} />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-[#252530]">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9] pt-2">
                <MessageSquare className="w-4 h-4 text-cyan-400" />最近会话
              </div>
              <button
                className="text-[11px] text-indigo-400 hover:text-indigo-300 pt-2"
                onClick={() => setShowAllConvs(v => !v)}
              >{showAllConvs ? '收起' : '查看全部会话'}</button>
            </div>
            <div className="divide-y divide-[#252530]">
              {recentConvs.length === 0 && (
                <div className="py-4 text-center text-[12px] text-[#5a5a70]">暂无会话</div>
              )}
              {(showAllConvs ? allConvs : recentConvs).map(c => (
                <div key={c.id} className="flex items-center gap-2 py-2">
                  <MessageSquare className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[#cdd3e0] truncate">{c.title}</div>
                    <div className="text-[10px] text-[#5a5a70]">{c.subSystem}</div>
                  </div>
                  <span className="text-[10px] text-[#5a5a70] shrink-0">{c.time}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 最近产物 */}
          <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9]">
                <FileText className="w-4 h-4 text-amber-400" />最近产物文件
              </div>
              <button
                className="text-[11px] text-indigo-400 hover:text-indigo-300"
                onClick={() => setShowAllArts(v => !v)}
              >{showAllArts ? '收起' : '查看全部产物'}</button>
            </div>
            <div className="divide-y divide-[#252530]">
              {recentArts.length === 0 && (
                <div className="py-4 text-center text-[12px] text-[#5a5a70]">暂无产物</div>
              )}
              {(showAllArts ? allArts : recentArts).map(a => (
                <div key={a.id} className="flex items-center gap-2 py-2">
                  <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[#cdd3e0] truncate">{a.name}</div>
                    <div className="text-[10px] text-[#5a5a70]">{a.subSystem} · {a.kind}</div>
                  </div>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0', a.kind === 'SQL' ? 'text-green-400 bg-green-500/15' : 'text-blue-400 bg-blue-500/15')}>{a.kind}</span>
                  <span className="text-[10px] text-[#5a5a70] shrink-0">{a.time}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 空间动态日志 */}
        <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#e4e4e9] mb-3">
            <FileCode2 className="w-4 h-4 text-purple-400" />空间动态日志
          </div>
          <div className="space-y-0">
            {events.length === 0 && (
              <div className="py-4 text-center text-[12px] text-[#5a5a70]">暂无动态</div>
            )}
            {events.map(l => (
              <div key={l.id} className="flex items-center gap-2 py-1.5 border-b border-[#252530] last:border-0">
                {l.status === '失败' ? (
                  <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                ) : l.status === '进行中' ? (
                  <Loader2 className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />
                ) : (
                  <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                )}
                <span className="text-[11px] w-20 text-[#9a9aa4] shrink-0">{l.type}</span>
                <span className="flex-1 text-[12px] text-[#cdd3e0] truncate min-w-0">{l.content}</span>
                <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0',
                  l.status === '失败' ? 'text-red-400 bg-red-500/15' : l.status === '进行中' ? 'text-indigo-400 bg-indigo-500/15' : 'text-green-400 bg-green-500/15')}>
                  {l.status}
                </span>
                <span className="text-[10px] text-[#5a5a70] shrink-0">{l.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 设置抽屉 */}
        {settingsOpen && (
          <SettingsDrawer
            space={spaceInfo}
            tab={settingsTab}
            setTab={setSettingsTab}
            onClose={() => setSettingsOpen(false)}
            onSave={(name, desc, tags, owner) => { setSpaceInfo(prev => prev ? { ...prev, name, description: desc, tags, owner } : prev); setSettingsOpen(false) }}
            metrics={metrics}
            members={realSpace?.members ?? []}
            realSpaceId={realSpace?.id ?? null}
          enabledAgents={realSpace?.enabled_agents ?? []}
          onSaveAgents={(ids) => {
            if (!realSpace) return
            api.updateSpace(realSpace.id, { enabled_agents: ids }).then(r => {
              if (r.success) { setRealSpace(r.data ?? null); setSettingsOpen(false) }
            }).catch(() => {})
          }}
        />
      )}

      {/* 邀请成员 */}
      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}

      {/* 新增子系统 */}
      {addSubOpen && (
        <AddSubSystemModal
          onClose={() => setAddSubOpen(false)}
          onSave={(data) => {
            if (!realSpace) { setAddSubOpen(false); return }
            api.createSubsystem(realSpace.id, data).then(r => {
              if (r.success && r.data) {
                const created = r.data as SpaceSubsystem
                setRealSpace(prev => prev ? { ...prev, subsystems: [...(prev.subsystems || []), created] } : prev)
              }
              setAddSubOpen(false)
            }).catch(() => {})
          }}
        />
      )}
    </div>
  )
}

/* ---- 面包屑 ---- */
function Breadcrumb({ spaceName, onSwitch, menuOpen }: { spaceName: string; onSwitch: () => void; menuOpen: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-[#9a9aa4]">欢迎回来，admin</span>
      <span className="text-[#3a3a4a]">|</span>
      <span className="text-[#5a5a70]">当前空间：</span>
      <button className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors" onClick={onSwitch}>
        <FolderOpen className="w-3 h-3" />
        {spaceName}
        <ChevronDown className={cn('w-3 h-3 transition-transform', menuOpen && 'rotate-180')} />
      </button>
    </div>
  )
}

/* ---- 子系统视图 ---- */
function SubSystemView({ space, sys, tasks, convs, arts, docCount, tab, setTab, onBack }: {
  space: SpaceInfo; sys: SubSystemCard; tasks: TaskItem[]; convs: ConvItem[]; arts: ArtifactItem[]
  docCount: number
  tab: '任务' | '会话' | '产物'; setTab: (t: '任务' | '会话' | '产物') => void; onBack: () => void
}) {
  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-[1400px] mx-auto space-y-4">
        {/* 面包屑 */}
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-[#9a9aa4]">欢迎回来，admin</span>
          <span className="text-[#3a3a4a]">|</span>
          <span className="text-[#5a5a70]">当前空间：</span>
          <button className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300" onClick={onBack}>
            <FolderOpen className="w-3 h-3" />{space.name}
          </button>
          <ChevronRight className="w-3 h-3 text-[#3a3a4a]" />
          <span className="text-[#cdd3e0]">{sys.name}</span>
        </div>

        {/* 子系统头部 */}
        <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-11 h-11 rounded-xl bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center shrink-0">
                <FolderOpen className="w-5 h-5 text-indigo-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[17px] font-semibold text-[#e4e4e9]">{sys.name}</h2>
                  <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-400 border-indigo-500/20">子系统</Badge>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0]" onClick={onBack}>
                    <ArrowLeft className="w-3 h-3 mr-1" />返回
                  </Button>
                </div>
                <p className="text-[12px] text-[#8b8b9e] mt-1.5">{sys.description}</p>
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {sys.tags.map(t => (
                    <span key={t} className="text-[11px] px-2 py-0.5 rounded bg-[#26262d] text-[#9a9aa4] border border-[#2f2f38]">#{t}</span>
                  ))}
                  <span className="inline-flex items-center gap-1 text-[11px] text-[#5a5a70]"><Users className="w-3 h-3" />负责人：{sys.owner}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 指标 */}
        <div className="grid grid-cols-4 gap-3">
          <MetricMini label="任务" value={tasks.length} icon={Package} tint="text-indigo-400 bg-indigo-500/10" />
          <MetricMini label="会话" value={convs.length} icon={MessageSquare} tint="text-cyan-400 bg-cyan-500/10" />
          <MetricMini label="产物" value={arts.length} icon={FileText} tint="text-amber-400 bg-amber-500/10" />
          <MetricMini label="知识库文档" value={docCount} icon={BookOpen} tint="text-blue-400 bg-blue-500/10" />
        </div>

        {/* Tab 列表 */}
        <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
          <div className="flex items-center gap-1 mb-3">
            {(['任务', '会话', '产物'] as const).map(t => (
              <button
                key={t}
                className={cn(
                  'h-7 px-3 rounded-md text-[12px] transition-colors',
                  tab === t ? 'bg-[#5b7cfa] text-white' : 'bg-[#16161e] text-[#8b8b9e] hover:text-[#cdd3e0] border border-[#252530]'
                )}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
            <span className="text-[11px] text-[#5a5a70] ml-auto">筛选空间「{sys.name}」相关资源</span>
          </div>
          {tab === '任务' && (
            <div className="divide-y divide-[#252530]">
              {tasks.length === 0 && <div className="py-8 text-center text-[12px] text-[#5a5a70]">暂无任务</div>}
              {tasks.map(t => <TaskRow key={t.id} t={t} />)}
            </div>
          )}
          {tab === '会话' && (
            <div className="divide-y divide-[#252530]">
              {convs.length === 0 && <div className="py-8 text-center text-[12px] text-[#5a5a70]">暂无会话</div>}
              {convs.map(c => (
                <div key={c.id} className="flex items-center gap-2 py-2">
                  <MessageSquare className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="flex-1 text-[12px] text-[#cdd3e0] truncate">{c.title}</span>
                  <span className="text-[10px] text-[#5a5a70]">{c.time}</span>
                </div>
              ))}
            </div>
          )}
          {tab === '产物' && (
            <div className="divide-y divide-[#252530]">
              {arts.length === 0 && <div className="py-8 text-center text-[12px] text-[#5a5a70]">暂无产物</div>}
              {arts.map(a => (
                <div key={a.id} className="flex items-center gap-2 py-2">
                  <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="flex-1 text-[12px] text-[#cdd3e0] truncate">{a.name}</span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0', a.kind === 'SQL' ? 'text-green-400 bg-green-500/15' : 'text-blue-400 bg-blue-500/15')}>{a.kind}</span>
                  <span className="text-[10px] text-[#5a5a70]">{a.time}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MetricMini({ label, value, icon: Icon, tint }: { label: string; value: number; icon: React.ComponentType<{ className?: string }>; tint: string }) {
  return (
    <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-3.5">
      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center mb-2.5', tint)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-[20px] font-bold text-[#e4e4e9] leading-none">{value}</div>
      <div className="text-[11px] text-[#5a5a70] mt-1">{label}</div>
    </div>
  )
}

/* ---- 设置抽屉 ---- */
function SettingsDrawer({ space, tab, setTab, onClose, onSave, metrics, members,
  realSpaceId, enabledAgents, onSaveAgents, }: {
  space: SpaceInfo; tab: string; setTab: (t: '基础' | '成员' | '统计' | '智能体' | '高级') => void; onClose: () => void
  onSave: (name: string, desc: string, tags: string[], owner: string) => void
  metrics: MetricDef[]; members: string[]
  realSpaceId?: number | null; enabledAgents?: string[]; onSaveAgents?: (ids: string[]) => void
}) {
  const [name, setName] = useState(space.name)
  const [desc, setDesc] = useState(space.description)
  const [tags, setTags] = useState(space.tags.join(', '))
  const [owner, setOwner] = useState(space.owner)
  // 智能体集群：拉取后端注册（总控 + 专项子 Agent），勾选启用
  const [agentList, setAgentList] = useState<{ id: string; name?: string; description?: string; role?: string; sub_agents?: string[]; builtin?: boolean }[]>([])
  const [enabled, setEnabled] = useState<string[]>(enabledAgents ?? [])
  useEffect(() => {
    api.listAgents().then(r => { if (r.success) setAgentList(r.data || []) }).catch(() => {})
  }, [])
  const commander = agentList.find(a => a.role === 'commander')
  const specialists = agentList.filter(a => a.role !== 'commander')

  const handleSave = () => {
    onSave(name, desc, tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), owner)
    onSaveAgents?.(enabled)
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-[460px] h-full bg-[#1a1a24] border-l border-[#252530] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#252530]">
          <h3 className="text-[14px] font-semibold text-[#e4e4e9]">空间设置</h3>
          <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-1 px-5 py-3 border-b border-[#252530]">
          {(['基础', '成员', '统计', '智能体', '高级'] as const).map(t => (
            <button
              key={t}
              className={cn(
                'h-7 px-3 rounded-md text-[12px] transition-colors',
                tab === t ? 'bg-[#5b7cfa] text-white' : 'bg-[#16161e] text-[#8b8b9e] border border-[#252530]'
              )}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === '基础' && (
            <>
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">空间名称</label>
                <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">项目描述</label>
                <Textarea className="min-h-[70px] text-[12px] bg-[#16161e] border border-[#252530] p-2" value={desc} onChange={e => setDesc(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">标签（逗号分隔）</label>
                <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={tags} onChange={e => setTags(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">负责人</label>
                <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={owner} onChange={e => setOwner(e.target.value)} />
              </div>
            </>
          )}
          {tab === '成员' && (
            <div className="space-y-2">
              {members.length === 0 && <div className="py-6 text-center text-[12px] text-[#5a5a70]">暂无成员数据</div>}
              {members.map(m => (
                <div key={m} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[#16161e] border border-[#252530]">
                  <Avatar name={m} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[#cdd3e0]">{m}</div>
                    <div className="text-[10px] text-[#5a5a70]">成员</div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded text-[#9a9aa4] bg-[#26262d]">成员</span>
                </div>
              ))}
              <div className="text-[11px] text-[#5a5a70] pt-2">子系统权限继承本空间，成员仅可见本空间资源</div>
            </div>
          )}
          {tab === '统计' && (
            <div className="grid grid-cols-2 gap-2">
              {metrics.map(m => (
                <div key={m.key} className="rounded-lg bg-[#16161e] border border-[#252530] p-3 flex items-center justify-between">
                  <span className="text-[12px] text-[#8b8b9e]">{m.label}</span>
                  <span className="text-[16px] font-bold text-[#e4e4e9]">{m.value}</span>
                </div>
              ))}
            </div>
          )}
          {tab === '智能体' && (
            <div className="space-y-3">
              <div className="text-[11px] text-[#5a5a70]">启用后，本空间会话可调用对应智能体；主控 Agent 可编排调度所有启用的专项子 Agent。</div>
              {commander && (
                <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3">
                  <div className="flex items-center gap-2">
                    <Puzzle className="w-4 h-4 text-cyan-400" />
                    <span className="text-[12px] text-cyan-300 font-medium">{commander.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">主调度</span>
                    <span className="ml-auto text-[10px] text-[#5a5a70]">{commander.sub_agents?.length ?? 0} 个子 Agent</span>
                  </div>
                  <div className="text-[11px] text-[#8b8b9e] mt-1.5">{commander.description}</div>
                </div>
              )}
              {specialists.length === 0 && (
                <div className="text-[12px] text-[#5a5a70] py-4 text-center">智能体列表加载中…</div>
              )}
              {specialists.map(a => {
                const on = enabled.includes(a.id)
                return (
                  <label key={a.id} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[#16161e] border border-[#252530] cursor-pointer hover:border-indigo-500/30 transition-colors">
                    <input type="checkbox" checked={on} onChange={() => setEnabled(prev => on ? prev.filter(x => x !== a.id) : [...prev, a.id])} className="accent-[#5b7cfa]" />
                    <span className="flex-1 min-w-0">
                      <span className="text-[12px] text-[#cdd3e0] block">{a.name || a.id}</span>
                      <span className="text-[10px] text-[#5a5a70] line-clamp-2">{a.description}</span>
                    </span>
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0', on ? 'text-green-400 bg-green-500/15' : 'text-[#5a5a70] bg-[#26262d]')}>{on ? '已启用' : '未启用'}</span>
                  </label>
                )
              })}
              {realSpaceId == null && <div className="text-[10px] text-amber-400/80">当前为演示空间，保存仅作用于本地；进入真实空间后可持久化。</div>}
            </div>
          )}
          {tab === '高级' && (
            <div className="space-y-3">
              <button className="w-full flex items-center gap-2.5 p-3 rounded-lg bg-[#16161e] border border-[#252530] text-[12px] text-[#cdd3e0] hover:border-amber-500/30 transition-colors">
                <Archive className="w-4 h-4 text-amber-400" />
                <span className="flex-1 text-left">归档空间<span className="text-[10px] text-[#5a5a70] block">归档后空间不可编辑，可随时恢复</span></span>
                <ChevronRight className="w-3 h-3 text-[#3a3a4a]" />
              </button>
              <button className="w-full flex items-center gap-2.5 p-3 rounded-lg bg-[#16161e] border border-[#252530] text-[12px] text-[#cdd3e0] hover:border-red-500/30 transition-colors">
                <Trash className="w-4 h-4 text-red-400" />
                <span className="flex-1 text-left">删除空间<span className="text-[10px] text-[#5a5a70] block">删除后不可恢复，将清空本空间所有资源</span></span>
                <ChevronRight className="w-3 h-3 text-[#3a3a4a]" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#252530]">
          <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05]" onClick={onClose}>取消</button>
          <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleSave}>保存</Button>
        </div>
      </div>
    </div>
  )
}

/* ---- 邀请成员弹窗 ---- */
function InviteModal({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<{ name: string; role: string }[]>([])
  const [name, setName] = useState('')
  const [role, setRole] = useState('只读')
  const add = () => {
    if (!name.trim()) return
    setUsers(prev => [...prev, { name: name.trim(), role }])
    setName('')
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[440px]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
          <h3 className="text-[14px] font-semibold text-[#e4e4e9] flex items-center gap-2"><UserPlus className="w-4 h-4 text-indigo-400" />邀请成员</h3>
          <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Input className="flex-1 h-8 text-[12px] bg-[#16161e] border-[#252530]" placeholder="输入用户名" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
            <select className="h-8 rounded-md text-[12px] bg-[#16161e] border border-[#252530] px-2 text-[#cdd3e0]" value={role} onChange={e => setRole(e.target.value)}>
              <option>管理员</option><option>编辑</option><option>只读</option>
            </select>
            <Button size="sm" className="h-8 text-[12px] bg-indigo-500 hover:bg-indigo-600 text-white" onClick={add}><Plus className="w-3.5 h-3.5" /></Button>
          </div>
          <div className="space-y-2">
            {users.length === 0 && <div className="py-6 text-center text-[12px] text-[#5a5a70]">尚未邀请成员</div>}
            {users.map((u, i) => (
              <div key={i} className="flex items-center gap-2.5 p-2 rounded-lg bg-[#16161e] border border-[#252530]">
                <Avatar name={u.name} />
                <span className="flex-1 text-[12px] text-[#cdd3e0]">{u.name}</span>
                <span className={cn('text-[10px] px-2 py-0.5 rounded', u.role === '管理员' ? 'text-indigo-400 bg-indigo-500/15' : u.role === '编辑' ? 'text-amber-400 bg-amber-500/15' : 'text-[#9a9aa4] bg-[#26262d]')}>{u.role}</span>
                <button className="text-[#5a5a70] hover:text-red-400" onClick={() => setUsers(prev => prev.filter((_, j) => j !== i))}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
          <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05]" onClick={onClose}>取消</button>
          <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={onClose}>完成</Button>
        </div>
      </div>
    </div>
  )
}

/* ---- 新增子系统弹窗 ---- */
function AddSubSystemModal({ onClose, onSave }: {
  onClose: () => void
  onSave: (d: { name: string; description: string; owner: string; tags: string[]; taskCount: number; artifactCount: number }) => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [owner, setOwner] = useState('')
  const [tags, setTags] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[440px]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
          <h3 className="text-[14px] font-semibold text-[#e4e4e9] flex items-center gap-2"><FolderPlus className="w-4 h-4 text-indigo-400" />新增子系统</h3>
          <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-[11px] text-[#8b8b9e] mb-1 block">子系统名称 <span className="text-red-400">*</span></label>
            <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" placeholder="如：营业系统" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="text-[11px] text-[#8b8b9e] mb-1 block">描述</label>
            <Textarea className="min-h-[60px] text-[12px] bg-[#16161e] border border-[#252530] p-2" placeholder="子系统职责说明" value={desc} onChange={e => setDesc(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-[#8b8b9e] mb-1 block">负责人</label>
              <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={owner} onChange={e => setOwner(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-[#8b8b9e] mb-1 block">标签（逗号分隔）</label>
              <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={tags} onChange={e => setTags(e.target.value)} />
            </div>
          </div>
          <div className="text-[11px] text-[#5a5a70]">子系统仅为资源筛选维度，不做权限隔离，权限继承上层空间。</div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
          <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05]" onClick={onClose}>取消</button>
          <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white"
            onClick={() => {
              if (!name.trim()) return
              onSave({ name: name.trim(), description: desc.trim(), owner: owner.trim() || '未分配', tags: tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), taskCount: 0, artifactCount: 0 })
            }}>
            创建
          </Button>
        </div>
      </div>
    </div>
  )
}
