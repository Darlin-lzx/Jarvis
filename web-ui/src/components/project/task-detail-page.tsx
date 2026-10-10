import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, MessageSquare, Package, RefreshCw, RotateCw, Copy, Download, MoreHorizontal, Pencil, Trash2, Eraser, Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { TaskDetail, TraceEvent, Space, MigrateTaskDetail } from '@/lib/types'
import { TaskStatusBadge } from '@/lib/task-status'
import { agents } from '@/components/chat/agent-tabs'
import type { TaskFilter } from '@/components/layout/sidebar'
import { cn } from '@/lib/utils'
import { TaskBreadcrumb } from './task-breadcrumb'
import { TaskTracePanel } from './task-trace-panel'
import { ArtifactPanel } from '@/components/chat/delivery-panel'
import { StateBoard, StageDrawer } from '@/components/migrate/state-board'
import { DeleteTaskDialog } from './delete-task-dialog'
import { mergeMigrateSnapshot, useMigrateStateSocket } from '@/hooks/use-migrate-state-socket'

/** 长名截断：中间省略，hover 展示完整名称 */
function ellipsis(name: string, max = 16): string {
  if (!name || name.length <= max) return name
  const half = Math.floor((max - 1) / 2)
  return `${name.slice(0, half)}…${name.slice(-half)}`
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 16).replace('T', ' ')
}

export function TaskDetailPage({ taskId, onBack, onSelectConv, onNewConv, onBackToTasks, onCopyTask }: {
  taskId: number
  onBack: () => void
  onSelectConv: (convId: number) => void
  onNewConv: () => void
  /** 面包屑 / 所属路径点击：携带筛选回任务列表 */
  onBackToTasks?: (f: TaskFilter | null) => void
  /** 复制任务：打开新建任务弹窗并预填 */
  onCopyTask?: (ctx: { space?: Space; agentId?: string; name?: string; description?: string; kbIds?: number[] }) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [tab, setTab] = useState<'会话' | '链路日志'>('会话')
  const [traces, setTraces] = useState<TraceEvent[]>([])
  const [moreOpen, setMoreOpen] = useState(false)
  const [descEditOpen, setDescEditOpen] = useState(false)
  const [descText, setDescText] = useState('')
  const [showArtifacts, setShowArtifacts] = useState(true)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deletingTask, setDeletingTask] = useState(false)
  /** 关联的迁移任务详情（用于状态机看板展示） */
  const [migrateDetail, setMigrateDetail] = useState<MigrateTaskDetail | null>(null)
  /** 阶段详情抽屉：当前打开的展示节点下标 */
  const [drawerStage, setDrawerStage] = useState<number | null>(null)
  const [retryingStage, setRetryingStage] = useState<string | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  const load = () => {
    api.getTask(taskId).then(r => { if (r.success) setDetail(r.data ?? null) })
    // 同时加载关联的迁移任务详情（用于状态机看板）
    api.getMigrateTaskByTaskId(taskId).then(r => {
      if (r.success && r.data) setMigrateDetail(r.data as MigrateTaskDetail)
      else setMigrateDetail(null)
    }).catch(() => setMigrateDetail(null))
  }
  const migrateSocket = useMigrateStateSocket(migrateDetail?.task_id, load)
  const liveMigrateDetail = mergeMigrateSnapshot(migrateDetail, migrateSocket.snapshot)
  useEffect(() => { load() }, [taskId])

  // 任务运行中：每 5s 轮询状态，实时刷新卡片
  useEffect(() => {
    if (detail?.status !== 'running') return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [detail?.status])

  // 更多菜单：点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const loadTraces = async () => {
    if (!detail?.sessions?.length) { setTraces([]); return }
    const arr: TraceEvent[] = []
    for (const s of detail.sessions) {
      const r = await api.getTrace(s.id)
      if (r.success) arr.push(...(r.data || []).map(e => ({ ...e, conv_id: s.id, conv_title: s.title })))
    }
    setTraces(arr.sort((a, b) => ((a as any).conv_id ?? 0) - ((b as any).conv_id ?? 0)))
  }
  // 常驻加载（供链路面板使用）：任务轮询返回新 detail 时同步刷新 trace
  useEffect(() => { void loadTraces() }, [detail])

  /* ===== 头部卡片操作 ===== */

  // 重新执行：重置为待执行，重新发起流水线（运行中禁用）
  const rerun = async () => {
    if (!detail) return
    if (!window.confirm(`重新执行任务「${detail.name}」？任务状态将重置为待执行。`)) return
    await api.updateTask(taskId, { status: 'pending' })
    load()
  }

  /** 单节点重试：任务页直接在关联会话中后台执行，无需用户先进入会话。 */
  const doRetryStage = async (stage: string) => {
    if (!liveMigrateDetail || retryingStage) return
    setRetryingStage(stage)
    try {
      const r = await api.retryMigrateTaskStage(liveMigrateDetail.task_id, stage)
      if (!r.success || !r.data?.conv_id) throw new Error(r.error || '该迁移任务没有关联会话，无法重新执行')
      await api.runMigrationStage(r.data.conv_id)
      await load()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setRetryingStage(null)
    }
  }

  // 复制任务：预填名称/描述/空间/主 Agent/知识库
  const copyTask = async () => {
    if (!detail || !onCopyTask) return
    const spaces = (await api.listSpaces().catch(() => ({ data: [] }))).data || []
    const space = spaces.find(x => x.id === detail.space_id)
    const fallbackSpace: Space = { id: detail.space_id, name: detail.space_name || '', subsystems: [] }
    onCopyTask({
      space: space || fallbackSpace,
      agentId: detail.agent_id,
      name: detail.name, description: detail.description, kbIds: detail.kb_ids,
    })
    setMoreOpen(false)
  }

  // 导出全部产物：合并为单个 Markdown 文件下载
  const exportAll = async () => {
    if (!detail?.artifacts?.length) { window.alert('该任务暂无产物可导出'); return }
    const parts: string[] = []
    for (const a of detail.artifacts) {
      const r = await api.getArtifactFile(a.id)
      const name = a.namespace.split('/').slice(2).join('/') || `artifact-${a.id}`
      if (r.success) parts.push(`===== ${name} =====\n${r.data}`)
    }
    if (!parts.length) return
    const blob = new Blob([parts.join('\n\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${detail.name}-产物导出.md`
    a.click()
    URL.revokeObjectURL(url)
    setMoreOpen(false)
  }

  // 编辑任务描述
  const openDescEdit = () => {
    setDescText(detail?.description || '')
    setDescEditOpen(true)
    setMoreOpen(false)
  }
  const saveDesc = async () => {
    if (!detail) return
    await api.updateTask(taskId, { description: descText })
    setDescEditOpen(false)
    load()
  }

  // 清空会话记录（产物保留，仅删除对话）
  const clearSessions = async () => {
    if (!detail) return
    if (!window.confirm(`清空任务「${detail.name}」的会话记录？产物保留，仅删除对话消息。`)) return
    try {
      for (const s of detail.sessions || []) {
        const r = await api.deleteConversation(s.id)
        if (!r.success) {
          window.alert(`会话「${s.title}」删除失败，请稍后重试`)
          return
        }
      }
      setMoreOpen(false)
      await load()
    } catch {
      window.alert('清空会话记录失败，请稍后重试')
    }
  }

  // 删除单个会话（级联清理该会话的产物文件，知识库副本保留）
  const deleteSession = async (s: { id: number; title: string }) => {
    if (!window.confirm(`删除会话「${s.title}」？将同时删除该会话产生的本地产物（知识库已入库副本保留）。此操作不可恢复。`)) return
    const r = await api.deleteConversation(s.id).catch(() => null)
    if (r?.success) {
      load()
    } else {
      window.alert('删除失败，请稍后重试')
    }
  }

  // 删除任务（强确认，级联删除其下会话与产物理，知识库副本保留）
  const requestRemoveTask = () => {
    if (!detail) return
    setMoreOpen(false)
    setDeleteConfirmOpen(true)
  }

  const confirmRemoveTask = async () => {
    if (!detail) return
    setDeletingTask(true)
    await api.deleteTask(taskId)
    setDeletingTask(false)
    setDeleteConfirmOpen(false)
    onBack()
  }

  if (!detail) return <div className="flex-1 flex items-center justify-center text-[13px] text-[#5a5a70]">加载中…</div>

  const agentName = agents.find(a => a.id === detail.agent_id)?.name || detail.agent_id || '—'
  const isRunning = detail.status === 'running'
  const spaceFilter: TaskFilter | null = detail.space_id ? { spaceId: detail.space_id, spaceName: detail.space_name || '' } : null

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* 左侧：任务详情（面包屑/头部卡片/链路面板/会话） */}
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="max-w-3xl mx-auto p-6">
        {/* 面包屑：任务 > 空间 / 任务名（前段可点击回退；最后一级任务名不可点） */}
        <div className="flex items-center gap-1.5 mb-4">
          <button onClick={onBack} className="flex items-center gap-1 text-[12px] text-indigo-400 hover:text-indigo-300 hover:underline underline-offset-4 transition-colors">
            <ArrowLeft className="w-3 h-3" />
          </button>
          <TaskBreadcrumb
            segments={[
              { label: '任务', full: '返回任务列表', onClick: onBack },
              detail.space_name
                ? { label: ellipsis(detail.space_name), full: detail.space_name, onClick: () => onBackToTasks?.(spaceFilter) }
                : { label: '全部空间' },
              { label: ellipsis(detail.name, 24), full: detail.name },
            ]}
          />
        </div>

        {/* 任务头部信息卡片 */}
        <div className="rounded-xl border border-[#252530] bg-[#16161e] p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[17px] font-semibold text-[#e4e4e9] break-all" title={detail.name}>
              {detail.name}
            </h2>
            <TaskStatusBadge status={detail.status} />
          </div>

          {/* 所属路径：点击跳回任务列表并筛选 */}
          <div className="text-[12px] text-[#8b8b9e] mt-1.5">
            所属：
            {detail.space_name && onBackToTasks ? (
              <button className="text-indigo-400 hover:text-indigo-300 hover:underline underline-offset-4" onClick={() => onBackToTasks(spaceFilter)}>
                {detail.space_name}
              </button>
            ) : (detail.space_name || '-')}
          </div>

          {/* 元数据 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[11px] text-[#5a5a70]">
            <span>主智能体：<span className="text-[#9a9aa4]">{agentName}</span></span>
            <span>创建时间：{fmtTime(detail.created_at)}</span>
            <span>最后更新：{detail.status === 'pending' ? '尚未开始执行' : fmtTime(detail.updated_at)}</span>
            <span>会话 {detail.conv_count ?? 0}</span>
            <span>产物 {detail.artifact_count ?? 0}</span>
          </div>

          {/* 右侧操作按钮组 */}
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <button
              onClick={rerun}
              disabled={isRunning}
              title={isRunning ? '任务运行中，暂不可重新执行' : `重新执行「${detail.name}」`}
              className="h-7 px-3 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[12px] flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed hover:from-[#4a6dfa] hover:to-[#6a4af5 transition-all"
            >
              <RotateCw className="w-3.5 h-3.5" />重新执行
            </button>
            <button onClick={copyTask} className="h-7 px-3 rounded-lg bg-[#1e1e28] border border-[#2f2f38] text-[12px] text-[#cdd3e0] hover:border-[#3a3a48] flex items-center gap-1.5">
              <Copy className="w-3.5 h-3.5" />复制任务
            </button>
            <button onClick={exportAll} className="h-7 px-3 rounded-lg bg-[#1e1e28] border border-[#2f2f38] text-[12px] text-[#cdd3e0] hover:border-[#3a3a48] flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" />导出全部产物
            </button>

            {/* ···更多菜单 */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen(o => !o)}
                className="h-7 px-2.5 rounded-lg bg-[#1e1e28] border border-[#2f2f38] text-[12px] text-[#cdd3e0] hover:border-[#3a3a48] flex items-center gap-1"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />更多
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-full mt-1 bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl py-1 min-w-[150px] z-50">
                  <button onClick={openDescEdit} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors">
                    <Pencil className="w-3 h-3" />编辑任务描述
                  </button>
                  <button onClick={clearSessions} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors">
                    <Eraser className="w-3 h-3" />清空会话记录
                  </button>
                  <div className="border-t border-[#2a2a35] my-1" />
                  <button
                    onClick={requestRemoveTask}
                    disabled={isRunning}
                    title={isRunning ? '任务运行中，暂不可删除' : undefined}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3 h-3" />删除任务
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 编辑任务描述弹窗（仅能改描述，空间/主 Agent 不可修改） */}
        {descEditOpen && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center" onClick={() => setDescEditOpen(false)}>
            <div className="bg-[#16161e] border border-[#252530] rounded-2xl w-[460px] p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-[14px] font-semibold flex items-center gap-2"><Pencil className="w-4 h-4 text-indigo-400" />编辑任务描述</h4>
                <button onClick={() => setDescEditOpen(false)} className="text-[#5a5a70] hover:text-white transition-colors"><X className="w-4 h-4" /></button>
              </div>
              <textarea
                value={descText}
                onChange={e => setDescText(e.target.value)}
                rows={4}
                placeholder="填写任务描述…"
                className="w-full bg-[#1a1a24] border border-[#252530] rounded-lg px-3 py-2 text-[12px] text-[#e4e4e9] placeholder:text-[#5a5a70] outline-none focus:border-indigo-500/40 resize-none"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setDescEditOpen(false)} className="h-7 px-3 rounded-lg border border-[#252530] text-[12px] text-[#9a9aa4] hover:text-[#cdd3e0] flex items-center gap-1">
                  <X className="w-3 h-3" />取消
                </button>
                <button onClick={saveDesc} className="h-7 px-3 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[12px] flex items-center gap-1">
                  <Check className="w-3 h-3" />保存
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 状态机看板（有迁移任务时展示状态机，否则展示原始链路面板） */}
        {liveMigrateDetail ? (
          <StateBoard detail={liveMigrateDetail} onOpenStage={setDrawerStage} onRetryStage={doRetryStage} retryingStage={retryingStage} />
        ) : (
          <TaskTracePanel
            traces={traces}
            status={detail.status}
            updatedAt={detail.updated_at}
            traceId={migrateDetail?.trace_id}
            onSelectConv={onSelectConv}
          />
        )}

        <div className="flex items-center gap-2 mt-5 mb-3">
          {(['会话', '链路日志'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('px-3.5 h-8 rounded-lg text-[12px]',
                tab === t ? 'bg-[#5b7cfa] text-white' : 'bg-[#16161e] text-[#8b8b9e] hover:text-[#cdd3e0] border border-[#252530]')}>
              {t}
            </button>
          ))}
          <button onClick={load} className="ml-auto flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors">
            <RefreshCw className="w-3 h-3" />刷新
          </button>
          <button onClick={() => setShowArtifacts(s => !s)} className={cn('h-8 px-3 rounded-lg text-[12px] flex items-center gap-1.5 border',
            showArtifacts ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'bg-[#16161e] text-[#8b8b9e] hover:text-[#cdd3e0] border-[#252530]')}
            title={showArtifacts ? '收起右侧产物面板' : '展开右侧产物面板'}>
            <Package className="w-3.5 h-3.5" />产物面板
          </button>
          <button onClick={onNewConv} className="h-8 px-3 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[12px] flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5" />新建会话
          </button>
        </div>

        {tab === '会话' && (
          <div className="space-y-2">
            {(detail.sessions || []).map(s => (
              <div key={s.id} className="group relative rounded-xl bg-[#16161e] border border-[#252530] hover:border-indigo-500/30 transition-all">
                <button onClick={() => onSelectConv(s.id)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3">
                  <MessageSquare className="w-4 h-4 text-[#5a5a70]" />
                  <span className="text-[13px] flex-1">{s.title}</span>
                  <span className="text-[11px] text-[#5a5a70]">{s.created_at?.slice(0, 16) || ''}</span>
                </button>
                {/* 删除会话入口 */}
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-[#5a5a70] opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                  title="删除该会话"
                  onClick={() => deleteSession(s)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {!detail.sessions?.length && <div className="text-center text-[12px] text-[#5a5a70] py-10">暂无会话</div>}
          </div>
        )}

        {tab === '链路日志' && (
          <div className="space-y-1.5">
            {traces.map((e, i) => (
              <div key={i} className="px-3 py-2 rounded-lg bg-[#0f0f14] border border-[#252530] text-[12px]">
                <span className="text-[#5b7cfa] mr-2">[{e.node}]</span>
                <span className="text-[#9a9aa4] mr-2">{(e as any).conv_title || ''}</span>
                <span className="text-[#cdd3e0]">{typeof e.content === 'string' ? e.content.slice(0, 80) : JSON.stringify(e.content).slice(0, 80)}</span>
              </div>
            ))}
            {traces.length === 0 && <div className="text-center text-[12px] text-[#5a5a70] py-10">暂无日志</div>}
          </div>
        )}
        </div>
      </div>

      <DeleteTaskDialog
        open={deleteConfirmOpen}
        taskName={detail?.name || ''}
        deleting={deletingTask}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={confirmRemoveTask}
      />

      {/* 右侧：产物面板（按任务加载；可收起/展开、拖拽调宽） */}
      {showArtifacts && (
        <ArtifactPanel
          convId={null}
          taskId={detail.id}
          taskName={detail.name}
          space={detail.space_name || ''}
          activeAgent={agentName !== '—' ? agentName : (detail.agent_id || undefined)}
          onClose={() => setShowArtifacts(false)}
        />
      )}

      {/* 阶段详情抽屉（状态机看板点击节点时弹出） */}
      {liveMigrateDetail && drawerStage != null && (
        <StageDrawer detail={liveMigrateDetail} stageIdx={drawerStage} onClose={() => setDrawerStage(null)} />
      )}
    </div>
  )
}
