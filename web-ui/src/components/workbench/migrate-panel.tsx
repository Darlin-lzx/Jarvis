import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import {
  MIGRATE_STATUS_LABEL,
  type MigrateTask, type MigrateTaskDetail,
} from '@/lib/types'
import {
  RefreshCw, Database, Play, Trash2,
  Workflow, RotateCw,
} from 'lucide-react'
import { StateBoard, effectiveIdx, StageDrawer, useMigrateBoardStages } from '@/components/migrate/state-board'
import { FlowBoard } from '@/components/migrate/flow-board'

/* ---- 主面板 ---- */
export function MigratePanel() {
  const [tasks, setTasks] = useState<MigrateTask[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [detail, setDetail] = useState<MigrateTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [message, setMessage] = useState('')
  /** 阶段详情抽屉：当前打开的展示节点下标 */
  const [drawerStage, setDrawerStage] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    const r = await api.listMigrateTasks(statusFilter ? { status: statusFilter } : {}).catch(() => ({ success: false, data: undefined }))
    if (r.success && r.data) {
      setTasks(r.data as MigrateTask[])
      if (r.data.length > 0 && (activeId == null || !r.data.some(t => t.task_id === activeId))) {
        setActiveId(r.data[0].task_id)
      } else if (r.data.length === 0) {
        setActiveId(null); setDetail(null)
      }
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [statusFilter])

  useEffect(() => {
    if (activeId == null) { setDetail(null); setDrawerStage(null); return }
    setBusy(true)
    api.getMigrateTask(activeId).then(r => {
      if (r.success && r.data) setDetail(r.data as MigrateTaskDetail)
    }).catch(() => setDetail(null)).finally(() => setBusy(false))
  }, [activeId])

  // 执行锁：被其他会话占用 / 任务已完成 → 只读，禁用状态变更按钮
  const lockBusy = detail ? (!!detail.exec_lock?.locked || !!detail.exec_lock?.readonly) : false
  const doAdvance = async (params: Record<string, unknown>) => {
    if (activeId == null) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: { from: string; to: string; advanced: boolean; warning?: string }; error?: string } =
      await api.advanceMigrateTask(activeId, params).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) {
      setMessage(`状态机推进：${r.data.from} → ${r.data.to}${r.data.warning ? `，⚠️ ${r.data.warning}` : ''}`)
      const fresh = await api.getMigrateTask(activeId).catch(() => null)
      if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
      load()
    } else {
      setMessage(r.error || '推进失败')
    }
    setBusy(false)
  }

  /** 断点续跑：仅 ERROR 亮起；不从头重跑，恢复到可继续阶段 */
  const doResume = async () => {
    if (activeId == null) return
    if (!window.confirm('从当前异常节点继续执行？已采集参数与产物保留，不会从头重跑。')) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: MigrateTask; error?: string } =
      await api.resumeMigrateTask(activeId).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) setMessage(`断点续跑成功：已恢复到「${r.data.status_label || r.data.status}」，可继续推进`)
    else setMessage(r.error || '断点续跑失败')
    const fresh = await api.getMigrateTask(activeId).catch(() => null)
    if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
    load()
    setBusy(false)
  }

  /** 重置任务：状态回 INIT，清空参数与产物（二次确认） */
  const doReset = async () => {
    if (activeId == null) return
    if (!window.confirm('确定重置该跨工程迭代任务？状态将回到「页面展示」，已采集参数与已生成产物全部清空。此操作不可恢复！')) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: MigrateTask; error?: string } =
      await api.resetMigrateTask(activeId).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) setMessage('任务已重置：回到 INIT「页面展示」，可重新发起跨工程迭代')
    else setMessage(r.error || '重置失败')
    const fresh = await api.getMigrateTask(activeId).catch(() => null)
    if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
    load()
    setBusy(false)
  }

  const doDelete = async () => {
    if (activeId == null) return
    if (!confirm('确认删除该跨工程迭代任务及其产物？')) return
    await api.deleteMigrateTask(activeId)
    setActiveId(null); setDetail(null); load()
  }

  const boardStages = useMigrateBoardStages()
  const flowIdx = detail ? effectiveIdx(detail, boardStages) : -1
  const nextStatus = detail && flowIdx >= 0 && flowIdx < boardStages.length - 1
    ? boardStages[flowIdx + 1].keys[0]
    : null

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Workflow className="w-4 h-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">跨工程迭代编排（领域状态机）</h2>
          <span className="text-[11px] text-[#8b8b9e]">流程由后端硬编码控制，LLM 只负责对话与内容生成，无权跳转节点</span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="h-7 w-36 text-[11px] bg-[#16161e] border-[#252530]"
            placeholder="状态筛选（如 ORDER_SPLIT）"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          />
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={load}><RefreshCw className="w-3 h-3 mr-1" />刷新</Button>
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-[12px] text-indigo-200">{message}</div>
      )}

      {/* 跨工程迭代任务列表 */}
      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#e4e4e9]"><Database className="w-3.5 h-3.5 text-indigo-400" />跨工程迭代任务列表</div>
          <span className="text-[10px] text-[#4a4a5a]">{loading ? '加载中…' : `${tasks.length} 个任务`}</span>
        </div>
        {tasks.length === 0 && !loading ? (
          <div className="text-[12px] text-[#8b8b9e] py-3 text-center">暂无迭代任务。到会话中开启「跨工程/迭代开发」对话，状态机会自动创建任务。</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {tasks.map(t => (
              <button
                key={t.task_id}
                className={cn(
                  'rounded-lg border border-[#252530] bg-[#0f0f14] px-3 py-2 text-left hover:border-indigo-500/40 transition-colors',
                  activeId === t.task_id && 'border-indigo-500/60 bg-indigo-500/[0.06]',
                )}
                onClick={() => setActiveId(t.task_id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-[#e4e4e9] truncate">#{t.task_id} {t.task_name}</span>
                  <span className={cn(
                    'text-[10px] flex-shrink-0',
                    t.status === 'FINISHED' ? 'text-green-400' : t.status === 'ERROR' ? 'text-red-400' : 'text-indigo-300',
                  )}>{t.status_label || t.status}</span>
                </div>
                <div className="text-[10px] text-[#8b8b9e] mt-1 truncate">
                  {t.business_scene || '未选业务场景'} ｜ {t.order_source || '-'} ｜ {t.accept_system || '-'}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 任务详情：头部 + 状态机看板 + 详情 */}
      {detail && (
        <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3 space-y-3">
          {/* 任务头部：名称 | 状态 | 重置/断点续跑 */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-[#e4e4e9]">任务 #{detail.task_id} · {detail.task_name}</span>
              <span className={cn(
                'px-2 py-0.5 rounded-full border text-[10px] font-medium',
                detail.status === 'FINISHED' ? 'text-green-400 border-green-500/30 bg-green-500/10'
                  : detail.status === 'ERROR' ? 'text-red-400 border-red-500/30 bg-red-500/10'
                    : 'text-indigo-300 border-indigo-500/30 bg-indigo-500/10',
              )}>{detail.status_label || detail.status}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* 断点续跑：仅 ERROR 亮起；被锁占用时仍允许抢占 */}
              {detail.status === 'ERROR' && (
                <Button size="sm" className="h-7 text-[11px] bg-red-600 hover:bg-red-500 text-white" onClick={doResume} disabled={busy} title="任务异常中断支持断点续跑，从当前节点继续，不从头重跑">
                  <RotateCw className="w-3 h-3 mr-1" />断点续跑
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-7 text-[11px] text-amber-400 hover:text-white hover:border-amber-500/40" onClick={doReset} disabled={busy || lockBusy} title="重置整个任务：状态回 INIT，清空已采集参数与产物（二次确认）">
                <RotateCw className="w-3 h-3 mr-1" />重置任务
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px] text-red-400 hover:text-white hover:border-red-500/40" onClick={doDelete} title="删除任务">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </div>

          {/* 状态机看板（任务总状态流转，主入口） */}
          <StateBoard detail={detail} onOpenStage={setDrawerStage} />

          {/* 参数信息 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <Info label="前端任务" value={detail.frontend_task || '—'} />
            <Info label="业务场景" value={detail.business_scene || '—'} />
            <Info label="订单来源" value={detail.order_source || '—'} />
            <Info label="拆单规则" value={detail.split_rule || '—'} />
            <Info label="受理系统" value={detail.accept_system || '—'} />
            <Info label="工作流场景" value={detail.workflow_scene || '—'} />
            <Info label="规则配置" value={detail.rule_config || '—'} />
            <Info label="配置分支" value={detail.config_branch || '—'} />
            <Info label="客户范围" value={detail.customer_scope || '—'} />
            <Info label="数据范围" value={detail.data_range || '—'} />
          </div>

          {/* 操作按钮：被锁占有时全部状态变更按钮置灰（只读） */}
          <div className="flex items-center gap-2 flex-wrap">
            {lockBusy && (
              <span className="text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-2.5 py-1.5">
                ⚠️ 任务执行中（操作人：{detail.exec_lock?.owner_user_id || detail.exec_lock?.session_id || '其他会话'}）｜只读模式，状态变更按钮已禁用
              </span>
            )}
            {nextStatus && (
              <Button size="sm" className="h-7 text-[11px]" onClick={() => doAdvance({ task_confirm: '继续' })} disabled={busy || lockBusy}>
                <Play className="w-3 h-3 mr-1" />确认并推进到 {MIGRATE_STATUS_LABEL[nextStatus]}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 任务流程静态表（页面可编排，状态机按此表驱动） */}
      <FlowBoard />

      {/* 阶段详情抽屉 */}
      {detail && drawerStage != null && (
        <StageDrawer detail={detail} stageIdx={drawerStage} onClose={() => setDrawerStage(null)} />
      )}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#1e1e28] bg-[#0f0f14] px-2.5 py-1.5">
      <div className="text-[9px] text-[#5a5a70]">{label}</div>
      <div className="text-[11.5px] text-[#d8d8e5] truncate mt-0.5" title={value}>{value}</div>
    </div>
  )
}
