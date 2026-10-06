import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { BizTask, Conversation, Datasource, Space, SpaceSubsystem } from '@/lib/types'
import type { NewTaskContext } from '@/components/project/new-task-dialog'
import { TaskStatusBadge } from '@/lib/task-status'
import {
  ArrowLeft, ChevronRight, Database, FileText, FolderKanban, FolderOpen,
  Loader2, MessageSquare, Package, Plus, Save, Settings, Trash2, Upload, X,
  BookOpen, Plug, Download, CircleDot,
} from 'lucide-react'

const IMPORT_DOC_TYPES = '.md,.sql,.txt,.pdf'

type TabKey = 'overview' | 'tasks' | 'convs' | 'artifacts' | 'docs' | 'datasources'

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'overview', label: '总览', hint: '本子系统概览' },
  { key: 'tasks', label: '任务', hint: '仅展示绑定本子系统的任务' },
  { key: 'convs', label: '会话', hint: '仅展示绑定本子系统的会话' },
  { key: 'artifacts', label: '产物', hint: '仅展示绑定本子系统的产物' },
  { key: 'docs', label: '知识库', hint: '仅展示绑定本子系统的知识库文档' },
  { key: 'datasources', label: '数据源', hint: '本子系统绑定的数据库数据源' },
]

interface SubSystemDetailPageProps {
  spaceId: number
  spaceName: string
  subId: number
  onBack: () => void
  onOpenTask?: (t: BizTask) => void
  onNewTask?: (ctx?: NewTaskContext) => void
  onOpenConv?: (id: number) => void
  /** 任务增删后通知父组件刷新侧边栏计数 */
  onTaskChanged?: () => void
}

interface Stats { task_count: number; conv_count: number; artifact_count: number; doc_count: number; ds_count: number }

const emptyStats: Stats = { task_count: 0, conv_count: 0, artifact_count: 0, doc_count: 0, ds_count: 0 }

export function SubSystemDetailPage({ spaceId, spaceName, subId, onBack, onOpenTask, onNewTask, onOpenConv, onTaskChanged }: SubSystemDetailPageProps) {
  const [activeSubId, setActiveSubId] = useState(subId)
  const [space, setSpace] = useState<Space | null>(null)
  const [subs, setSubs] = useState<SpaceSubsystem[]>([])
  const [current, setCurrent] = useState<SpaceSubsystem | null>(null)
  const [stats, setStats] = useState<Stats>(emptyStats)
  const [tab, setTab] = useState<TabKey>('overview')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tab 列表数据
  const [tasks, setTasks] = useState<BizTask[]>([])
  const [convs, setConvs] = useState<Conversation[]>([])
  const [arts, setArts] = useState<BizArtifact[]>([])
  const [docs, setDocs] = useState<KBDoc[]>([])
  const [dss, setDss] = useState<Datasource[]>([])
  const [loading, setLoading] = useState<string>('')

  // 弹窗
  const [editOpen, setEditOpen] = useState(false)
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [addDsOpen, setAddDsOpen] = useState(false)
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null)
  const docInputRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }

  const refreshBase = useCallback(() => {
    api.getSpace(spaceId).then(r => {
      if (!r.success || !r.data) return
      const sp = r.data
      setSpace(sp)
      setSubs(sp.subsystems || [])
      const cur = (sp.subsystems || []).find(s => s.id === activeSubId) || null
      setCurrent(cur)
      if (!cur) onBack()
    }).catch(() => onBack())
  }, [spaceId, activeSubId, onBack])

  const refreshStats = useCallback(() => {
    api.subsystemStats(spaceId, activeSubId).then(r => {
      if (r.success && r.data) {
        setStats({
          task_count: r.data.task_count,
          conv_count: r.data.conv_count,
          artifact_count: r.data.artifact_count,
          doc_count: r.data.doc_count,
          ds_count: r.data.ds_count,
        })
      }
    }).catch(() => {})
  }, [spaceId, activeSubId])

  useEffect(() => { refreshBase(); refreshStats() }, [refreshBase, refreshStats])

  // 切换子系统：重置数据与 Tab
  const switchSub = (id: number) => {
    if (id === activeSubId) return
    setActiveSubId(id)
    setTab('overview')
    setTasks([]); setConvs([]); setArts([]); setDocs([]); setDss([])
  }

  // 懒加载 Tab 数据（切换时拉取）
  useEffect(() => {
    if (tab === 'overview') return
    setLoading(tab)
    const done = () => { setLoading(''); refreshStats() }
    if (tab === 'tasks') {
      api.listTasks(spaceId, undefined, activeSubId).then(r => { if (r.success) setTasks(r.data || []) }).finally(done)
    } else if (tab === 'convs') {
      api.listConversations({ space_id: spaceId, sub_system_id: activeSubId }).then(r => { if (r.success) setConvs(r.data || []) }).finally(done)
    } else if (tab === 'artifacts') {
      api.listArtifacts(undefined, undefined, { space_id: spaceId, sub_system_id: activeSubId }).then(r => { if (r.success) setArts(r.data || []) }).finally(done)
    } else if (tab === 'docs') {
      api.listDocuments(spaceId, activeSubId).then(r => { if (r.success) setDocs(r.data || []) }).finally(done)
    } else if (tab === 'datasources') {
      api.listDatasources(spaceId, activeSubId).then(r => { if (r.success) setDss(r.data || []) }).finally(done)
    }
  }, [tab, spaceId, activeSubId, refreshStats])

  // 指标卡
  const metricCards = [
    { key: 'tasks' as TabKey, label: '任务', value: stats.task_count, icon: Package, tint: 'text-indigo-400 bg-indigo-500/10' },
    { key: 'convs' as TabKey, label: '会话', value: stats.conv_count, icon: MessageSquare, tint: 'text-cyan-400 bg-cyan-500/10' },
    { key: 'artifacts' as TabKey, label: '产物', value: stats.artifact_count, icon: FileText, tint: 'text-amber-400 bg-amber-500/10' },
    { key: 'docs' as TabKey, label: '知识库文档', value: stats.doc_count, icon: BookOpen, tint: 'text-blue-400 bg-blue-500/10' },
  ]

  const handleCreateConv = () => {
    api.createConversation(`[${current?.name || ''}] 新会话`, { space_id: spaceId, sub_system_id: activeSubId }).then(r => {
      if (r.success && r.data) onOpenConv?.(r.data.id)
    }).catch(() => showToast('创建会话失败'))
  }

  const handleNewTask = () => {
    if (space && current) onNewTask?.({ space, subId: current.id, lockSpace: true })
  }

  const handleDeleteSub = () => {
    if (!window.confirm(`确定删除子系统「${current?.name}」？仅空子系统（无任务/会话/产物）可删除。`)) return
    api.deleteSubsystem(spaceId, activeSubId).then(r => {
      if (r.success) { showToast('子系统已删除'); onBack() }
      else showToast(r.message || '删除失败：子系统非空或已被引用')
    }).catch(() => showToast('删除失败'))
  }

  const handleDeleteTask = (t: BizTask) => {
    if (!window.confirm(`删除任务「${t.name}」？将级联删除其下全部会话与产物（知识库已入库副本保留）。此操作不可恢复。`)) return
    api.deleteTask(t.id).then(r => {
      if (r.success) { showToast('任务已删除'); setTasks(prev => prev.filter(x => x.id !== t.id)); refreshStats(); onTaskChanged?.() }
    }).catch(() => showToast('删除失败'))
  }

  const handleDeleteConv = (c: Conversation) => {
    if (!window.confirm(`删除会话「${c.title}」？`)) return
    api.deleteConversation(c.id).then(r => {
      if (r.success) { showToast('会话已删除'); setConvs(prev => prev.filter(x => x.id !== c.id)); refreshStats() }
    })
  }

  const handleDeleteDoc = (d: KBDoc) => {
    if (!window.confirm(`删除文档「${d.name}」？`)) return
    api.deleteDocument(d.id).then(r => {
      if (r.success) { showToast('文档已删除'); setDocs(prev => prev.filter(x => x.id !== d.id)); refreshStats() }
    })
  }

  const handleDeleteDs = (d: Datasource) => {
    if (!window.confirm(`删除数据源「${d.name}」？`)) return
    api.deleteDatasource(d.name).then(r => {
      if (r.success) { showToast('数据源已删除'); setDss(prev => prev.filter(x => x.name !== d.name)); refreshStats() }
    })
  }

  const handleTestDs = (d: Datasource) => {
    api.testDatasource(d.name).then(r => {
      const data = r.data as { tables?: unknown[]; message?: string } | undefined
      showToast(r.success ? `连接正常，已探查到 ${data?.tables?.length ?? 0} 个对象` : (r.message || '连接失败'))
    })
  }

  const handleUploadDoc = (f: File) => {
    api.uploadDocument(f, { space_id: spaceId, sub_system_id: subId }).then(r => {
      if (r.success) { showToast(`文档已上传：切分 ${r.data?.chunks ?? 0} 个 chunk`); setTab('docs'); setLoading('docs') }
      else showToast(r.message || '上传失败')
    })
  }

  const previewFile = (a: BizArtifact) => {
    api.getArtifactFile(a.id).then(r => {
      const content = (r as unknown as { content?: string }).content ?? ''
      setPreview({ name: a.object_name || a.namespace, content })
    })
  }

  const switchTo = (t: TabKey) => {
    setTab(t)
    if (t !== 'overview' && t === 'docs' && !docs.length) setLoading(t)
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
      {/* ======== 左侧子系统导航 ======== */}
      <aside className="w-56 shrink-0 border-r border-[#1e1e28] bg-[#0f0f14] flex flex-col min-h-0">
        <div className="px-4 py-3.5 border-b border-[#1e1e28]">
          <button
            className="flex items-center gap-1.5 text-[12px] text-[#9a9aa4] hover:text-indigo-400 transition-colors"
            onClick={onBack}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="truncate">{spaceName}</span>
          </button>
          <div className="text-[11px] text-[#5a5a70] mt-1.5 pl-6">空间内子系统</div>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {subs.map(s => (
            <button
              key={s.id}
              onClick={() => switchSub(s.id)}
              title={s.description || s.name}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12px] transition-colors',
                s.id === current?.id
                  ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                  : 'text-[#9a9aa4] hover:bg-white/[0.04] border border-transparent'
              )}
            >
              <CircleDot className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {s.name}
                <span className="text-[10px] text-[#5a5a70] ml-1">· {s.tags?.join(' / ') || ''}</span>
              </span>
            </button>
          ))}
          {subs.length === 0 && <div className="px-3 py-4 text-[11px] text-[#5a5a70] text-center">本空间暂无子系统</div>}
        </div>
        <div className="p-2 border-t border-[#1e1e28]">
          <button
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg border border-dashed border-[#2a2a35] text-[12px] text-[#8b8b9e] hover:text-indigo-400 hover:border-indigo-500/40 transition-colors"
            onClick={() => setAddSubOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" />新增子系统
          </button>
        </div>
      </aside>

      {/* ======== 主内容区 ======== */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="p-6 max-w-[1200px] mx-auto space-y-4">
          {/* 面包屑 + 操作栏 */}
          <div className="flex items-center gap-2 text-[12px]">
            <button onClick={onBack} className="text-[#5a5a70] hover:text-indigo-400 transition-colors">首页</button>
            <ChevronRight className="w-3 h-3 text-[#3a3a4a]" />
            <button onClick={onBack} className="flex items-center gap-1 text-[#9a9aa4] hover:text-indigo-400 transition-colors">
              <FolderOpen className="w-3 h-3" />{spaceName}
            </button>
            <ChevronRight className="w-3 h-3 text-[#3a3a4a]" />
            <span className="text-indigo-400">{current?.name || ''}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 text-[12px] border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-indigo-500/40" onClick={() => setEditOpen(true)}>
                <Settings className="w-3 h-3 mr-1" />编辑子系统
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[12px] border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-indigo-500/40" onClick={() => showToast('子系统权限继承空间权限，RBAC 本期预留')}>
                <Plug className="w-3 h-3 mr-1" />权限管理
              </Button>
              <Button
                size="sm" variant="outline"
                className={cn('h-7 text-[12px] border-[#252530] hover:border-red-500/50 hover:text-red-400',
                  (stats.task_count + stats.conv_count + stats.artifact_count) > 0 ? 'text-[#5a5a70] cursor-not-allowed' : 'text-[#9a9aa4]')}
                onClick={handleDeleteSub}
                title={stats.task_count + stats.conv_count + stats.artifact_count > 0 ? '仅空子系统可删除（无任务/会话/产物）' : '删除子系统'}
              >
                <Trash2 className="w-3 h-3 mr-1" />删除
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[12px] border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-indigo-500/40" onClick={onBack}>
                <ArrowLeft className="w-3 h-3 mr-1" />返回空间列表
              </Button>
            </div>
          </div>

          {/* 子系统基础卡 */}
          <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-5">
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-xl bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center shrink-0">
                <FolderKanban className="w-5 h-5 text-indigo-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-[16px] font-semibold text-[#e4e4e9]">{current?.name || '子系统'}</h2>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">子系统</span>
                  {current?.tags && current.tags.length > 0 && (
                    <span className="flex items-center gap-1">
                      {current.tags.map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[#26262d] text-[#9a9aa4]">#{t}</span>)}
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-[#8b8b9e] mt-1.5">{current?.description || '暂无描述'}</p>
                <div className="flex items-center gap-3 text-[11px] text-[#5a5a70] mt-2">
                  <span>负责人：{current?.owner || '未分配'}</span>
                  {current?.created_at && <span>创建于 {new Date(current.created_at).toLocaleDateString('zh-CN')}</span>}
                  <span>资源自动过滤：仅本空间 + 本子系统</span>
                </div>
              </div>
            </div>
          </div>

          {/* Tab 标签 */}
          <div className="flex items-center gap-1">
            {TABS.map(t => (
              <button
                key={t.key}
                className={cn(
                  'h-8 px-3.5 rounded-lg text-[12px] transition-colors',
                  tab === t.key
                    ? 'bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white'
                    : 'bg-[#16161e] border border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0]'
                )}
                onClick={() => switchTo(t.key)}
              >
                {t.label}
              </button>
            ))}
            <span className="text-[11px] text-[#5a5a70] ml-auto">{TABS.find(t => t.key === tab)?.hint}</span>
          </div>

          {/* ======== 内容区 ======== */}
          {loading && (
            <div className="flex items-center gap-2 text-[12px] text-[#8b8b9e]">
              <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />加载中…
            </div>
          )}

          {tab === 'overview' && (
            <OverView
              statCards={metricCards}
              onSwitch={switchTo}
              space={space}
              current={current}
              onNewTask={handleNewTask}
              onCreateConv={handleCreateConv}
              onUpload={() => docInputRef.current?.click()}
              convCount={convs.length}
              taskCount={tasks.length}
            />
          )}

          {tab === 'tasks' && (
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-[13px] font-semibold text-[#e4e4e9]">任务列表</div>
                <Button size="sm" className="h-7 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleNewTask}>
                  <Plus className="w-3.5 h-3.5 mr-1" />新建任务（预填本子系统）
                </Button>
              </div>
              {tasks.length === 0 ? (
                <EmptyState icon={Package} title="本子系统暂无任务" desc="点击上方「新建任务」，空间与子系统已自动预填" action={handleNewTask} actionLabel="新建任务" />
              ) : (
                <Card>
                  <div className="grid grid-cols-[1fr_90px_80px_80px_90px_120px] gap-2 px-3 py-2 text-[11px] text-[#5a5a70] border-b border-[#252530]">
                    <span>任务名称</span><span>状态</span><span>创建人</span><span>会话</span><span>产物</span><span className="text-right">操作</span>
                  </div>
                  {tasks.map(t => (
                    <div key={t.id} className="grid grid-cols-[1fr_90px_80px_80px_90px_120px] gap-2 items-center px-3 py-2.5 border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <div className="min-w-0">
                        <div className="text-[12px] text-[#cdd3e0] truncate">{t.name}</div>
                        <div className="text-[10px] text-[#5a5a70]">{t.created_at ? new Date(t.created_at).toLocaleString('zh-CN') : ''}</div>
                      </div>
                      <div><TaskStatusBadge status={t.status} /></div>
                      <span className="text-[11px] text-[#8b8b9e]">{t.creator || '-'}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{t.conv_count ?? 0}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{t.artifact_count ?? 0}</span>
                      <div className="flex items-center gap-1 justify-end">
                        <OpBtn label="详情" onClick={() => onOpenTask?.(t)} />
                        <OpBtn label="删除" danger onClick={() => handleDeleteTask(t)} />
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          )}

          {tab === 'convs' && (
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-[13px] font-semibold text-[#e4e4e9]">会话列表</div>
                <Button size="sm" className="h-7 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleCreateConv}>
                  <MessageSquare className="w-3.5 h-3.5 mr-1" />新建会话
                </Button>
              </div>
              {convs.length === 0 ? (
                <EmptyState icon={MessageSquare} title="本子系统暂无会话" desc="新建会话将自动带入空间与子系统归属" action={handleCreateConv} actionLabel="新建会话" />
              ) : (
                <Card>
                  <div className="grid grid-cols-[1fr_90px_150px_60px_110px] gap-2 px-3 py-2 text-[11px] text-[#5a5a70] border-b border-[#252530]">
                    <span>会话名称</span><span>来源</span><span>创建时间</span><span>产物</span><span className="text-right">操作</span>
                  </div>
                  {convs.map(c => (
                    <div key={c.id} className="grid grid-cols-[1fr_90px_150px_60px_110px] gap-2 items-center px-3 py-2.5 border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <span className="text-[12px] text-[#cdd3e0] truncate">{c.title}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{c.task_id ? '任务内会话' : '独立会话'}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{c.created_at ? new Date(c.created_at).toLocaleString('zh-CN') : '-'}</span>
                      <span className="text-[11px] text-[#8b8b9e]">-</span>
                      <div className="flex items-center gap-1 justify-end">
                        <OpBtn label="打开" primary onClick={() => onOpenConv?.(c.id)} />
                        <OpBtn label="删除" danger onClick={() => handleDeleteConv(c)} />
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          )}

          {tab === 'artifacts' && (
            <section>
              {arts.length === 0 ? (
                <EmptyState icon={FileText} title="本子系统暂无产物" desc="会话中生成的报告 / SQL 脚本入库后自动出现在这里" />
              ) : (
                <Card>
                  <div className="grid grid-cols-[1fr_80px_150px_110px] gap-2 px-3 py-2 text-[11px] text-[#5a5a70] border-b border-[#252530]">
                    <span>产物名称</span><span>类型</span><span>创建时间</span><span className="text-right">操作</span>
                  </div>
                  {arts.map(a => (
                    <div key={a.id} className="grid grid-cols-[1fr_80px_150px_110px] gap-2 items-center px-3 py-2.5 border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <div className="min-w-0">
                        <div className="text-[12px] text-[#cdd3e0] truncate">{a.object_name || a.namespace}</div>
                        <div className="text-[10px] text-[#5a5a70] truncate">{a.namespace}</div>
                      </div>
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded w-fit', a.type === 'sql' ? 'text-green-400 bg-green-500/15' : 'text-blue-400 bg-blue-500/15')}>{a.type}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{a.created_at ? new Date(a.created_at).toLocaleString('zh-CN') : '-'}</span>
                      <div className="flex items-center gap-1 justify-end">
                        <OpBtn label="预览" onClick={() => previewFile(a)} />
                        <a href={`/api/artifacts/${a.id}/file`} download className="flex items-center gap-1 text-[11px] px-1.5 py-1 rounded-md text-[#9a9aa4] hover:text-indigo-400 hover:bg-white/[0.04] transition-colors">
                          <Download className="w-3 h-3" />下载
                        </a>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          )}

          {tab === 'docs' && (
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-[13px] font-semibold text-[#e4e4e9]">知识库文档（绑定本子系统，自动隔离）</div>
                <Button size="sm" className="h-7 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={() => docInputRef.current?.click()}>
                  <Upload className="w-3.5 h-3.5 mr-1" />上传文档（自动绑定本子系统）
                </Button>
              </div>
              <input ref={docInputRef} type="file" accept={IMPORT_DOC_TYPES} className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadDoc(f); e.target.value = '' }} />
              {docs.length === 0 ? (
                <EmptyState icon={BookOpen} title="本子系统暂无知识库文档" desc="上传文档后将进行 chunk 分段与向量入库，自动绑定本子系统" action={() => docInputRef.current?.click()} actionLabel="上传文档" />
              ) : (
                <Card>
                  <div className="grid grid-cols-[1fr_90px_100px_120px_60px] gap-2 px-3 py-2 text-[11px] text-[#5a5a70] border-b border-[#252530]">
                    <span>文档名称</span><span>类型</span><span>chunk 数</span><span>上传时间</span><span className="text-right">操作</span>
                  </div>
                  {docs.map(d => (
                    <div key={d.id} className="grid grid-cols-[1fr_90px_100px_120px_60px] gap-2 items-center px-3 py-2.5 border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <span className="text-[12px] text-[#cdd3e0] truncate">{d.name}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{d.source_type}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{d.chunk_count}</span>
                      <span className="text-[11px] text-[#8b8b9e]">{d.created_at ? new Date(d.created_at).toLocaleString('zh-CN') : '-'}</span>
                      <div className="flex justify-end"><OpBtn label="删除" danger onClick={() => handleDeleteDoc(d)} /></div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          )}

          {tab === 'datasources' && (
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-[13px] font-semibold text-[#e4e4e9]">数据源（源库 / 目标国产库）</div>
                <Button size="sm" className="h-7 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={() => setAddDsOpen(true)}>
                  <Database className="w-3.5 h-3.5 mr-1" />添加数据源
                </Button>
              </div>
              {dss.length === 0 ? (
                <EmptyState icon={Database} title="未配置数据源" desc="配置后 Agent 可对本子系统库表做数据探查与只读查询" action={() => setAddDsOpen(true)} actionLabel="添加数据源" />
              ) : (
                <Card>
                  {dss.map(d => (
                    <div key={d.name} className="flex items-center gap-3 px-3 py-3 border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <Database className="w-4 h-4 text-green-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] text-[#cdd3e0]">{d.name}</span>
                          <span className={cn('w-1.5 h-1.5 rounded-full', d.enabled ? 'bg-green-400' : 'bg-[#4a4a5a]')} />
                          <span className="text-[10px] text-[#5a5a70]">{d.enabled ? '已启用' : '已停用'}</span>
                        </div>
                        <div className="text-[11px] text-[#5a5a70] mt-0.5">类型 {d.kind} · {d.location || '（未配置连接信息）'}{d.username ? ` · ${d.username}@` : ''}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <OpBtn label="测试" onClick={() => handleTestDs(d)} />
                        <OpBtn label="编辑" onClick={() => setAddDsOpen(true)} />
                        <OpBtn label="删除" danger onClick={() => handleDeleteDs(d)} />
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          )}
        </div>
      </div>

      {/* ======== 弹窗 ======== */}
      {editOpen && current && (
        <SubEditModal
          sub={current}
          onClose={() => setEditOpen(false)}
          onSave={(name, desc, owner, tags) => {
            api.updateSubsystem(spaceId, activeSubId, { name, description: desc, owner, tags }).then(r => {
              if (r.success) { showToast('子系统已更新'); refreshBase() }
              else showToast(r.message || '保存失败')
            })
            setEditOpen(false)
          }}
        />
      )}

      {addSubOpen && (
        <SubAddModal
          spaceId={spaceId}
          onClose={() => setAddSubOpen(false)}
          onDone={(name) => { showToast(`子系统「${name}」已创建`); refreshBase() }}
        />
      )}

      {addDsOpen && (
        <DsAddModal
          spaceId={spaceId}
          subId={activeSubId}
          onClose={() => setAddDsOpen(false)}
          onDone={(name) => { showToast(`数据源「${name}」已添加`); setTab('datasources'); setLoading('datasources') }}
        />
      )}

      {preview && (
        <PreviewModal data={preview} onClose={() => setPreview(null)} />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] px-4 py-2 rounded-lg bg-[#1a1a24] border border-indigo-500/40 text-[12px] text-[#cdd3e0] shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}

/* ======== 概览 Tab ======== */
function OverView({ statCards, onSwitch, space, current, onNewTask, onCreateConv, onUpload, convCount, taskCount }: {
  statCards: { key: TabKey; label: string; value: number; icon: React.ComponentType<{ className?: string }>; tint: string }[]
  onSwitch: (t: TabKey) => void
  space: Space | null
  current: SpaceSubsystem | null
  onNewTask: () => void
  onCreateConv: () => void
  onUpload: () => void
  convCount: number
  taskCount: number
}) {
  const recentConvs = Math.min(convCount, 5)
  return (
    <div className="space-y-4">
      {/* 指标卡（点击切换对应 Tab） */}
      <div className="grid grid-cols-4 gap-3">
        {statCards.map(c => {
          const Icon = c.icon
          return (
            <button
              key={c.key}
              onClick={() => onSwitch(c.key)}
              className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4 text-left hover:border-indigo-500/40 hover:bg-indigo-500/5 transition-all group"
            >
              <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center mb-2.5', c.tint)}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="text-[24px] font-bold text-[#e4e4e9] leading-none">{c.value}</div>
              <div className="text-[11px] text-[#5a5a70] mt-1.5 group-hover:text-indigo-400 transition-colors">{c.label} ›</div>
            </button>
          )
        })}
      </div>

      {/* 快捷操作 */}
      <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
        <div className="text-[13px] font-semibold text-[#e4e4e9] mb-3">快捷操作</div>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] border bg-indigo-500/10 border-indigo-500/25 text-indigo-400 hover:bg-indigo-500/20 transition-colors" onClick={onNewTask}>
            <Plus className="w-3.5 h-3.5" />新建任务（预填本子系统）
          </button>
          <button className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] border bg-cyan-500/10 border-cyan-500/25 text-cyan-400 hover:bg-cyan-500/20 transition-colors" onClick={onCreateConv}>
            <MessageSquare className="w-3.5 h-3.5" />新建会话
          </button>
          <button className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] border bg-amber-500/10 border-amber-500/25 text-amber-400 hover:bg-amber-500/20 transition-colors" onClick={onUpload}>
            <Upload className="w-3.5 h-3.5" />上传知识库文档（自动绑定本子系统）
          </button>
          <span className="text-[11px] text-[#5a5a70] ml-auto">新建资源默认归属：{space?.name || ''} / {current?.name || ''}</span>
        </div>
      </div>

      {/* 最近动态 */}
      <div className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4">
        <div className="text-[13px] font-semibold text-[#e4e4e9] mb-3">本子系统最近动态</div>
        <div className="space-y-2">
          {recentConvs === 0 && taskCount === 0 && (
            <div className="py-6 text-center text-[12px] text-[#5a5a70]">暂无动态。创建任务或会话后，操作记录会显示在这里。</div>
          )}
          {Array.from({ length: recentConvs }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 text-[12px] text-[#9a9aa4]">
              <MessageSquare className="w-3.5 h-3.5 text-cyan-400/70 shrink-0" />
              <span className="truncate">创建了对话会话</span>
            </div>
          ))}
          {Array.from({ length: Math.min(taskCount, 5) }).map((_, i) => (
            <div key={`t${i}`} className="flex items-center gap-2 text-[12px] text-[#9a9aa4]">
              <Package className="w-3.5 h-3.5 text-indigo-400/70 shrink-0" />
              <span className="truncate">新建了业务任务</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ======== 通用小组件 ======== */
function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-[#252530] bg-[#1d1d22] divide-y divide-[#252530]">{children}</div>
}

function OpBtn({ label, onClick, danger, primary }: { label: string; onClick?: () => void; danger?: boolean; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-1.5 py-1 rounded-md text-[11px] transition-colors',
        danger ? 'text-[#9a9aa4] hover:text-red-400 hover:bg-red-500/10'
          : primary ? 'text-indigo-400 hover:text-indigo-300' : 'text-[#9a9aa4] hover:text-indigo-400 hover:bg-white/[0.04]'
      )}
    >
      {label}
    </button>
  )
}

function EmptyState({ icon: Icon, title, desc, action, actionLabel }: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  action?: () => void
  actionLabel?: string
}) {
  return (
    <div className="rounded-xl border border-[#252530] bg-[#1d1d22] py-10 flex flex-col items-center gap-2">
      <Icon className="w-6 h-6 text-[#3a3a4a]" />
      <div className="text-[13px] text-[#cdd3e0]">{title}</div>
      <div className="text-[11px] text-[#5a5a70] text-center max-w-sm">{desc}</div>
      {action && actionLabel && (
        <Button size="sm" className="mt-2 h-7 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={action}>
          <Plus className="w-3.5 h-3.5 mr-1" />{actionLabel}
        </Button>
      )}
    </div>
  )
}

/* ======== 编辑子系统弹窗 ======== */
function SubEditModal({ sub, onClose, onSave }: {
  sub: SpaceSubsystem
  onClose: () => void
  onSave: (name: string, desc: string, owner: string, tags: string[]) => void
}) {
  const [name, setName] = useState(sub.name)
  const [desc, setDesc] = useState(sub.description || '')
  const [owner, setOwner] = useState(sub.owner || '')
  const [tags, setTags] = useState((sub.tags || []).join(', '))
  return (
    <Modal title="编辑子系统" onClose={onClose}>
      <Field label="子系统名称">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label="描述">
        <Textarea className="min-h-[60px] text-[12px] bg-[#16161e] border-[#252530] p-2" value={desc} onChange={e => setDesc(e.target.value)} />
      </Field>
      <Field label="负责人">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={owner} onChange={e => setOwner(e.target.value)} />
      </Field>
      <Field label="标签（逗号分隔）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={tags} onChange={e => setTags(e.target.value)} />
      </Field>
      <ModalFooter onClose={onClose} onOk={() => name.trim() && onSave(name.trim(), desc.trim(), owner.trim(), tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))} okLabel="保存" />
    </Modal>
  )
}

/* ======== 新增子系统弹窗 ======== */
function SubAddModal({ spaceId, onClose, onDone }: {
  spaceId: number
  onClose: () => void
  onDone: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [owner, setOwner] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = () => {
    if (!name.trim() || busy) return
    setBusy(true)
    api.createSubsystem(spaceId, {
      name: name.trim(), description: desc.trim(), owner: owner.trim(),
      tags: tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
    }).then(r => { if (r.success && r.data) onDone(r.data.name) }).finally(() => setBusy(false))
  }
  return (
    <Modal title="新增子系统" onClose={onClose}>
      <Field label="子系统名称（必填）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" placeholder="如：营业系统" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      </Field>
      <Field label="描述">
        <Textarea className="min-h-[60px] text-[12px] bg-[#16161e] border-[#252530] p-2" placeholder="子系统职责说明" value={desc} onChange={e => setDesc(e.target.value)} />
      </Field>
      <Field label="负责人">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={owner} onChange={e => setOwner(e.target.value)} />
      </Field>
      <Field label="标签（逗号分隔）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={tags} onChange={e => setTags(e.target.value)} />
      </Field>
      <ModalFooter onClose={onClose} onOk={submit} okLabel="创建" disabled={!name.trim() || busy} />
    </Modal>
  )
}

/* ======== 添加数据源弹窗 ======== */
function DsAddModal({ spaceId, subId, onClose, onDone }: {
  spaceId: number
  subId: number
  onClose: () => void
  onDone: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('sqlite')
  const [location, setLocation] = useState('')
  const [username, setUsername] = useState('')
  const [dsn, setDsn] = useState('')
  const [busy, setBusy] = useState(false)
  const kinds = ['sqlite', 'mysql', 'postgresql', 'oracle', 'dm', 'kingbase', 'gaussdb']
  const submit = () => {
    if (!name.trim() || busy) return
    setBusy(true)
    api.createDatasource({ name: name.trim(), kind, location: location.trim(), username: username.trim(), dsn: dsn.trim(), enabled: true, space_id: spaceId, sub_system_id: subId })
      .then(r => { if (r.success && r.data) onDone(r.data.name) })
      .finally(() => setBusy(false))
  }
  return (
    <Modal title="添加数据源（自动绑定本子系统）" onClose={onClose}>
      <Field label="数据源名称（别名）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" placeholder="如：src_oracle / tgt_dm" value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label="数据库类型">
        <select className="h-8 w-full rounded-md text-[12px] bg-[#16161e] border border-[#252530] px-2 text-[#cdd3e0]" value={kind} onChange={e => setKind(e.target.value)}>
          {kinds.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </Field>
      <Field label="连接位置（host:port/db 或文件路径）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={location} onChange={e => setLocation(e.target.value)} />
      </Field>
      <Field label="用户名（可选）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={username} onChange={e => setUsername(e.target.value)} />
      </Field>
      <Field label="完整连接串 DSN（可选）">
        <Input className="h-8 text-[12px] bg-[#16161e] border-[#252530]" value={dsn} onChange={e => setDsn(e.target.value)} />
      </Field>
      <ModalFooter onClose={onClose} onOk={submit} okLabel="创建" disabled={!name.trim() || busy} />
    </Modal>
  )
}

/* ======== 产物预览弹窗 ======== */
function PreviewModal({ data, onClose }: { data: { name: string; content: string }; onClose: () => void }) {
  return (
    <Modal title={data.name} onClose={onClose} wide>
      <pre className="max-h-[420px] overflow-auto rounded-lg bg-[#0f0f14] border border-[#252530] p-4 text-[12px] text-[#cdd3e0] whitespace-pre-wrap break-words">{data.content || '（空文件）'}</pre>
      <ModalFooter onClose={onClose} okLabel="关闭" onOk={onClose} />
    </Modal>
  )
}

/* ======== 通用弹窗/DOM ======== */
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className={cn('bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl flex flex-col', wide ? 'w-[640px]' : 'w-[440px]')} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
          <h3 className="text-[14px] font-semibold text-[#e4e4e9] flex items-center gap-2">{title}</h3>
          <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">{children}</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-[#8b8b9e] mb-1 block">{label}</label>
      {children}
    </div>
  )
}

function ModalFooter({ onClose, onOk, okLabel, disabled }: { onClose: () => void; onOk: () => void; okLabel: string; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35] -mx-5 -mb-5 mt-1">
      <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05]" onClick={onClose}>取消</button>
      <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={onOk} disabled={disabled}>
        <Save className="w-3.5 h-3.5 mr-1.5" />{okLabel}
      </Button>
    </div>
  )
}

/* 轻量文档/产物类型（后端返回的扁平字段） */
interface KBDoc { id: number; name: string; source_type: string; chunk_count: number; enabled: boolean; space_id?: number | null; sub_system_id?: number | null; created_at?: string }
interface BizArtifact { id: number; namespace: string; object_name?: string; type: string; created_at?: string }