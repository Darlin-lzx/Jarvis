import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, FolderKanban, MoreHorizontal, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { BizTask, Space } from '@/lib/types'
import { TaskStatusBadge } from '@/lib/task-status'
import type { TaskFilter } from '@/components/layout/sidebar'
import { TaskBreadcrumb } from './task-breadcrumb'

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
  /** 顶部下拉手动修改筛选 → 回传 App → 左侧导航高亮同步（双向联动） */
  onFilterChange?: (f: TaskFilter | null) => void
  /** 任务增删后通知父组件刷新侧边栏计数 */
  onTaskChanged?: () => void
}) {
  const [spaces, setSpaces] = useState<Space[]>([])
  // 空间筛选（跟随左侧点击，也可手动切换）
  const [spaceId, setSpaceId] = useState<number | undefined>(undefined)
  // 子系统筛选（跟随左侧点击，也可手动切换；undefined=空间全部任务）
  const [subId, setSubId] = useState<number | undefined>(undefined)
  const [status, setStatus] = useState('')
  const [tasks, setTasks] = useState<BizTask[]>([])
  const [moreFor, setMoreFor] = useState<number | null>(null)
  const reqSeq = useRef(0)

  // 点击外部关闭更多菜单：仅当点击落在「当前打开菜单所在卡片」之外才关闭
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

  // 删除任务：二次确认 → 后端级联删除其下会话与产物理
  const removeTask = async (t: BizTask, e: React.MouseEvent) => {
    e.stopPropagation()
    setMoreFor(null)
    if (!window.confirm(`删除任务「${t.name}」？将级联删除其下全部会话与产物（知识库已入库副本保留）。此操作不可恢复。`)) return
    const r = await api.deleteTask(t.id).catch(() => null)
    if (r?.success) {
      setTasks(prev => prev.filter(x => x.id !== t.id))
      onTaskChanged?.()
    } else {
      window.alert('删除失败，请稍后重试')
    }
  }

  // 左侧点击空间/子系统 → 同步筛选（仅在外部传入时覆盖）
  useEffect(() => {
    if (filter?.spaceId) setSpaceId(filter.spaceId)
    if (filter?.subId) setSubId(filter.subId)
    else if (filter?.spaceId) setSubId(undefined)
  }, [filter?.spaceId, filter?.subId])

  // 空间数据（含子系统 task_count 角标），与侧边栏一致
  useEffect(() => {
    api.listSpaces().then(r => { if (r.success) setSpaces(r.data || []) }).catch(() => {})
  }, [])

  // 当前空间对象（获取子系统和名称）
  const curSpace = useMemo(() => spaces.find(s => s.id === spaceId), [spaces, spaceId])

  // 切换空间后清空子系统筛选（仅当空间已加载且子系统中确实不存在时）
  useEffect(() => {
    if (spaceId && subId && curSpace) {
      const sub = curSpace.subsystems.find(x => x.id === subId)
      if (!sub) setSubId(undefined)
    }
  }, [spaceId, curSpace?.subsystems, subId, curSpace])

  // 竞态守卫：仅采纳最后一次请求结果，避免全量请求后返回覆盖筛选结果
  const load = (sid?: number, ssid?: number, st = '') => {
    const seq = ++reqSeq.current
    api.listTasks(sid, st || undefined, ssid).then(r => {
      if (r.success && seq === reqSeq.current) setTasks(r.data || [])
    })
  }

  useEffect(() => { load(spaceId, subId, status) }, [spaceId, subId, status])

  /* ===== 双向联动：顶部下拉手动筛选 → 回传 App（左侧高亮同步） ===== */
  const notify = (sid?: number, ssid?: number, ssname?: string) => {
    if (!onFilterChange) return
    if (sid == null) { onFilterChange(null); return }
    const s = spaces.find(x => x.id === sid)
    onFilterChange({ spaceId: sid, spaceName: s?.name || '', ...(ssid != null ? { subId: ssid, subName: ssname || '' } : {}) })
  }

  // 手动切换空间：清空子系统，切为「该空间 / 全部子系统」视图
  const onSpaceSelect = (v: string) => {
    const sid = v ? Number(v) : undefined
    setSpaceId(sid)
    setSubId(undefined)
    notify(sid)
  }

  // 手动切换子系统：保持空间，切为「空间 / 子系统」视图
  const onSubSelect = (v: string) => {
    if (spaceId == null) { setSubId(undefined); return }
    const ssid = v ? Number(v) : undefined
    setSubId(ssid)
    notify(spaceId, ssid, v ? (curSpace?.subsystems.find(s => s.id === ssid)?.name) : undefined)
  }

  // 面包屑点空间名：回到父空间视图（子系统 = 全部子系统）
  const toSpaceView = () => {
    if (spaceId == null) return
    setSubId(undefined)
    notify(spaceId)
  }

  // 清除筛选：回到全部空间 / 全部子系统 / 全部状态
  const clearAll = () => {
    setSpaceId(undefined)
    setSubId(undefined)
    setStatus('')
    notify(undefined)
  }

  // 当前筛选展示（选中子系统名）
  const activeSub = useMemo(
    () => curSpace?.subsystems.find(x => x.id === subId),
    [curSpace, subId],
  )
  const hasFilter = spaceId != null || subId != null || status !== ''

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[17px] font-semibold flex items-center gap-2"><FolderKanban className="w-5 h-5 text-indigo-400" />任务</h1>
            <p className="text-[12px] text-[#5a5a70] mt-1">任务强绑定空间，创建后所属空间不可修改</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onNewTask} className="h-8 px-3 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[12px] flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" />新建任务
            </button>
          </div>
        </div>

        {/* 面包屑：任务 > 空间 / 子系统 [清除筛选]（与左侧导航联动） */}
        <TaskBreadcrumb
          segments={[
            { label: '任务' },
            curSpace
              ? { label: ellipsis(curSpace.name), full: curSpace.name, onClick: toSpaceView }
              : { label: '全部空间' },
            activeSub
              ? { label: ellipsis(activeSub.name, 12), full: activeSub.name }
              : { label: '全部子系统' },
          ]}
          showClear={hasFilter}
          onClear={clearAll}
        />

        {/* 筛选栏（顶部下拉 与 左侧导航点击 双向联动） */}
        <div className="flex items-center gap-2 mb-4">
          <select value={spaceId ?? ''} onChange={e => onSpaceSelect(e.target.value)}
            className="h-8 rounded-lg bg-[#16161e] border border-[#252530] px-2.5 text-[12px]">
            <option value="">全部空间</option>
            {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={subId ?? ''} disabled={!curSpace}
            onChange={e => onSubSelect(e.target.value)}
            className="h-8 rounded-lg bg-[#16161e] border border-[#252530] px-2.5 text-[12px] disabled:opacity-40">
            <option value="">全部子系统</option>
            {curSpace?.subsystems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={status} onChange={e => { setStatus(e.target.value) }}
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
          {tasks.map(t => {
            const sub = curSpace?.subsystems.find(x => x.id === t.sub_system_id)
            return (
              <div key={t.id} className="group relative rounded-xl bg-[#16161e] border border-[#252530] hover:border-indigo-500/30 transition-all">
                <div className="flex items-center">
                  <button onClick={() => onOpenTask(t)} className="flex-1 min-w-0 text-left px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] text-[#e4e4e9] flex-1 truncate">{t.name}</span>
                      <TaskStatusBadge status={t.status} />
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[#5a5a70]">
                      <span>会话 {t.conv_count ?? 0}</span><span>产物 {t.artifact_count ?? 0}</span>
                      {sub && <span className="inline-flex items-center gap-1 text-[10px] text-[#8b8b9e] bg-white/[0.04] rounded px-1.5 py-px">所属子系统：{sub.name}</span>}
                    </div>
                  </button>
                  {/* 更多操作（删除任务）：与打开按钮为兄弟节点，避免 button 嵌套；按钮与菜单同容器，点击菜单不触发外部关闭 */}
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
                          onClick={ev => removeTask(t, ev)}
                        >
                          <Trash2 className="w-3 h-3" />删除任务
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {tasks.length === 0 && (
            <div className="text-center text-[12px] text-[#5a5a70] py-14">
              {activeSub ? `当前子系统「${activeSub.name}」暂无任务，点击「新建任务」创建`
                : curSpace ? `当前空间「${curSpace.name}」下暂无任务，点击「新建任务」创建`
                  : '暂无任务，点击「新建任务」创建'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}