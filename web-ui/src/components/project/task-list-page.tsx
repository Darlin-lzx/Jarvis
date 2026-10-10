import { useEffect, useRef, useState } from 'react'
import { Plus, FolderKanban, MoreHorizontal, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { BizTask, Space } from '@/lib/types'
import { TaskStatusBadge } from '@/lib/task-status'
import type { TaskFilter } from '@/components/layout/sidebar'
import { TaskBreadcrumb } from './task-breadcrumb'
import { DeleteTaskDialog } from './delete-task-dialog'

/** 长名截断：超长中间省略，hover 展示完整名称 */
function ellipsis(name: string, max = 14): string {
  if (name.length <= max) return name
  const half = Math.floor((max - 1) / 2)
  return `${name.slice(0, half)}…${name.slice(-half)}`
}

export function TaskListPage({ onNewTask, onOpenTask, filter, onFilterChange, onTaskChanged }: {
  onNewTask: () => void
  onOpenTask: (t: BizTask) => void
  filter?: TaskFilter | null
  onFilterChange?: (f: TaskFilter | null) => void
  onTaskChanged?: () => void
}) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<number | undefined>(undefined)
  const [status, setStatus] = useState('')
  const [tasks, setTasks] = useState<BizTask[]>([])
  const [moreFor, setMoreFor] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BizTask | null>(null)
  const [deletingTaskId, setDeletingTaskId] = useState<number | null>(null)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (moreFor == null) return
    const handleClickOutside = (e: MouseEvent) => {
      const root = (e.target as HTMLElement | null)?.closest?.('[data-more-root]') as HTMLElement | null
      if (!root || String(root.dataset.moreRoot) !== String(moreFor)) {
        setMoreFor(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [moreFor])

  const requestRemoveTask = (t: BizTask, e: React.MouseEvent) => {
    e.stopPropagation()
    setMoreFor(null)
    setDeleteTarget(t)
  }

  const confirmRemoveTask = async (t: BizTask) => {
    setDeletingTaskId(t.id)
    const r = await api.deleteTask(t.id).catch(() => null)
    setDeletingTaskId(null)
    if (r?.success) {
      setTasks(prev => prev.filter(x => x.id !== t.id))
      onTaskChanged?.()
    } else {
      window.alert('删除失败，请稍后重试')
      return
    }
    setDeleteTarget(null)
  }

  useEffect(() => {
    if (filter?.spaceId) setSpaceId(filter.spaceId)
  }, [filter?.spaceId])

  useEffect(() => {
    api.listSpaces().then(r => { if (r.success) setSpaces(r.data || []) }).catch(() => {})
  }, [])

  const curSpace = spaces.find(s => s.id === spaceId)

  const load = (sid?: number, st = '') => {
    const seq = ++reqSeq.current
    api.listTasks(sid, st || undefined).then(r => {
      if (r.success && seq === reqSeq.current) setTasks(r.data || [])
    })
  }

  useEffect(() => { load(spaceId, status) }, [spaceId, status])

  const notify = (sid?: number) => {
    if (!onFilterChange) return
    if (sid == null) {
      onFilterChange(null)
      return
    }
    const space = spaces.find(x => x.id === sid)
    onFilterChange({ spaceId: sid, spaceName: space?.name || '' })
  }

  const onSpaceSelect = (v: string) => {
    const sid = v ? Number(v) : undefined
    setSpaceId(sid)
    notify(sid)
  }

  const clearAll = () => {
    setSpaceId(undefined)
    setStatus('')
    notify(undefined)
  }

  const hasFilter = spaceId != null || status !== ''

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[17px] font-semibold flex items-center gap-2"><FolderKanban className="w-5 h-5 text-indigo-400" />任务</h1>
            <p className="text-[12px] text-[#5a5a70] mt-1">任务直接归属空间，创建后所属空间不可修改</p>
          </div>
          <button onClick={onNewTask} className="h-8 px-3 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[12px] flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />新建任务
          </button>
        </div>

        <TaskBreadcrumb
          segments={[
            { label: '任务' },
            curSpace
              ? { label: ellipsis(curSpace.name), full: curSpace.name }
              : { label: '全部空间' },
          ]}
          showClear={hasFilter}
          onClear={clearAll}
        />

        <div className="flex items-center gap-2 mb-4">
          <select value={spaceId ?? ''} onChange={e => onSpaceSelect(e.target.value)}
            className="h-8 rounded-lg bg-[#16161e] border border-[#252530] px-2.5 text-[12px]">
            <option value="">全部空间</option>
            {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={status} onChange={e => setStatus(e.target.value)}
            className="h-8 rounded-lg bg-[#16161e] border border-[#252530] px-2.5 text-[12px]">
            <option value="">全部状态</option>
            <option value="pending">待执行</option>
            <option value="running">执行中</option>
            <option value="done">已完成</option>
            <option value="failed">失败</option>
            <option value="paused">已暂停</option>
          </select>
        </div>

        <div className="space-y-2.5">
          {tasks.map(t => (
            <div key={t.id} className="group relative rounded-xl bg-[#16161e] border border-[#252530] hover:border-indigo-500/30 transition-all">
              <div className="flex items-center">
                <button onClick={() => onOpenTask(t)} className="flex-1 min-w-0 text-left px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] text-[#e4e4e9] flex-1 truncate">{t.name}</span>
                    <TaskStatusBadge status={t.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[#5a5a70]">
                    <span>会话 {t.conv_count ?? 0}</span>
                    <span>产物 {t.artifact_count ?? 0}</span>
                  </div>
                </button>
                <div className="relative shrink-0 mr-3" data-more-root={t.id}>
                  <button
                    className="p-1 rounded-md text-[#5a5a70] opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                    title="删除任务"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMoreFor(moreFor === t.id ? null : t.id)
                    }}
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                  {moreFor === t.id && (
                    <div className="absolute right-0 top-full mt-1 z-50 w-36 bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl py-1">
                      <button
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
                        onClick={ev => requestRemoveTask(t, ev)}
                      >
                        <Trash2 className="w-3 h-3" />删除任务
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {tasks.length === 0 && (
            <div className="text-center text-[12px] text-[#5a5a70] py-14">
              {curSpace
                ? `当前空间「${curSpace.name}」下暂无任务，点击「新建任务」创建`
                : '暂无任务，点击「新建任务」创建'}
            </div>
          )}
        </div>
      </div>

      <DeleteTaskDialog
        open={!!deleteTarget}
        taskName={deleteTarget?.name || ''}
        deleting={deleteTarget ? deletingTaskId === deleteTarget.id : false}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) confirmRemoveTask(deleteTarget)
        }}
      />
    </div>
  )
}
