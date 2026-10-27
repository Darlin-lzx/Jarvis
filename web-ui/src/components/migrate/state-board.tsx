import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { MigrateFlowNode } from '@/lib/types'
import {
  MIGRATE_STATUS_LABEL,
  type MigrateTaskDetail, type MigrateStatus,
} from '@/lib/types'
import { boardStagesFromFlow, type MigrateBoardStage } from './flow-stages'
import {
  CheckCircle2, XCircle, Circle, Workflow,
  X, Eye, Clock, Braces, FileText, RotateCw, Play,
} from 'lucide-react'

/* ================= 状态机看板（任务详情头部主入口） ================= */

const DEFAULT_BOARD_STAGES = boardStagesFromFlow()

/** 任务页/对话页共用：始终读取后端可编排流程，避免展示链路与执行链路分叉 */
export function useMigrateBoardStages(): MigrateBoardStage[] {
  const [flow, setFlow] = useState<MigrateFlowNode[] | null>(null)
  useEffect(() => {
    let alive = true
    api.getMigrateFlow().then(r => {
      if (alive && r.success && r.data) setFlow(r.data as MigrateFlowNode[])
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  return useMemo(() => boardStagesFromFlow(flow), [flow])
}

export function stageIdxOf(status: string, stages: MigrateBoardStage[] = DEFAULT_BOARD_STAGES): number {
  const i = stages.findIndex(s => s.keys.includes(status as MigrateStatus))
  return i >= 0 ? i : 0
}

/** ERROR 状态无法直接映射，依据已采集参数推断「最近推进到的阶段」 */
export function effectiveIdx(t: MigrateTaskDetail, stages: MigrateBoardStage[] = DEFAULT_BOARD_STAGES): number {
  if (t.status === 'ERROR') {
    if ((t.business_scene || t.frontend_task)
      && (t.order_source || t.split_rule)
      && (t.accept_system || t.workflow_scene)) return stageIdxOf('RULE_CHECK', stages)
    if (t.business_scene || t.frontend_task) return stageIdxOf('ORDER_SPLIT', stages)
    return stageIdxOf('PAGE_SHOW', stages)
  }
  return stageIdxOf(t.status, stages)
}

/** 阶段执行完成不等于已推进：等待用户确认时，当前节点也应显示完成。 */
export function currentStageExecutionDone(
  t: MigrateTaskDetail,
  stages: MigrateBoardStage[] = DEFAULT_BOARD_STAGES,
): boolean {
  if (t.status === 'ERROR') return false
  if (t.status === 'FINISHED') return true
  if (!t.current_step) return false
  if (t.step_status !== 'done' && t.step_status !== 'waiting_confirm') return false
  return effectiveIdx(t, stages) === stageIdxOf(t.current_step, stages)
}

/** 单个状态机节点：✅ 已完成 / ⭕ 当前(蓝) / ○ 未执行(灰) / ❌ 异常(红) */
export function BoardNode({ idx, label, desc, state, onOpen }: {
  idx: number; label: string; desc: string
  state: 'done' | 'current' | 'pending' | 'error'
  onOpen: () => void
}) {
  const clickable = state !== 'pending'
  const tip = `阶段 ${idx + 1}：${label}\n${desc}\n${state === 'pending' ? '未执行（流程由后端状态机控制，不可跳转）' : '点击查看该阶段详情'}`
  return (
    <div className="flex flex-col items-center gap-1.5 flex-shrink-0 group">
      <button
        disabled={!clickable}
        title={tip}
        onClick={onOpen}
        className={cn(
          'flex flex-col items-center gap-1 rounded-lg px-3 py-2 border transition-all min-w-[86px]',
          state === 'pending' && 'border-[#23232e] bg-[#101016] opacity-50 cursor-not-allowed',
          state === 'done' && 'border-green-500/30 bg-green-500/[0.06] cursor-pointer hover:border-green-500/60 hover:bg-green-500/10',
          state === 'current' && 'border-indigo-500/60 bg-indigo-500/[0.08] cursor-pointer shadow-[0_0_14px_rgba(99,102,241,0.25)]',
          state === 'error' && 'border-red-500/50 bg-red-500/[0.08] cursor-pointer shadow-[0_0_14px_rgba(239,68,68,0.25)]',
        )}
      >
        <span className="flex items-center gap-1">
          {state === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
          {state === 'current' && <span className="w-2.5 h-2.5 rounded-full bg-indigo-400 animate-pulse" />}
          {state === 'error' && <XCircle className="w-3.5 h-3.5 text-red-400" />}
          {state === 'pending' && <Circle className="w-3 h-3 text-[#4a4a5a]" />}
          <span className={cn(
            'text-[10.5px] font-medium whitespace-nowrap',
            state === 'done' && 'text-green-300',
            state === 'current' && 'text-indigo-300',
            state === 'error' && 'text-red-300',
            state === 'pending' && 'text-[#4a4a5a]',
          )}>{label}</span>
        </span>
        <span className={cn(
          'text-[9px] leading-3 text-center max-w-[78px] line-clamp-2',
          state === 'pending' ? 'text-[#3a3a48]' : state === 'error' ? 'text-red-400/70' : 'text-[#5a5a70]',
        )}>{desc}</span>
      </button>
      {state === 'error' && (
        <span className="text-[9px] text-red-400 whitespace-nowrap">异常中断</span>
      )}
    </div>
  )
}

function RetryNodeButton({ label, onRetry, retrying, disabled }: {
  label: string
  onRetry: () => void
  retrying?: boolean
  disabled?: boolean
}) {
  return (
    <button
      onClick={onRetry}
      disabled={retrying || disabled}
      title={`重新执行「${label}」`}
      className={cn(
        'flex items-center justify-center w-5 h-5 rounded-md border transition-colors',
        retrying || disabled
          ? 'border-[#23232e] bg-[#101016] text-[#3a3a48] cursor-not-allowed'
          : 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:border-indigo-400/60 hover:bg-indigo-500/20',
      )}
    >
      <RotateCw className={cn('w-3 h-3', retrying && 'animate-spin')} />
    </button>
  )
}

/** 状态机横向看板 + 连接线 */
export function StateBoard({ detail, onOpenStage, onAdvance, advancing, onRetryStage, retryingStage }: {
  detail: MigrateTaskDetail
  onOpenStage: (i: number) => void
  /** 可选：确定并推进（对话页手动确认闸门互动放此处，由调用方触发 advance API） */
  onAdvance?: () => void
  advancing?: boolean
  /** 可选：单节点重试（对话页/任务详情页由调用方触发重试 API 与后续 Agent 执行） */
  onRetryStage?: (stage: string) => void
  retryingStage?: string | null
}) {
  const stages = useMigrateBoardStages()
  const effIdx = effectiveIdx(detail, stages)
  const errored = detail.status === 'ERROR'
  const lock = detail.exec_lock
  // 执行锁：被其他会话占用 → 只读；空闲 → 可操作
  const lockBusy = !!lock?.locked
  const lockOwner = lock?.owner_user_id || lock?.session_id || '其他会话'
  // 下一阶段：推进按钮的提示文案
  const nextStage = (effIdx >= 0 && effIdx < stages.length - 1) ? stages[effIdx + 1] : null
  const activeStageDone = currentStageExecutionDone(detail, stages)
  return (
    <div className="rounded-lg bg-[#0f0f14] border border-[#1e1e28] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-[#8b8b9e]">任务总状态流转（后端流程编排驱动，页面仅展示，用户不可跳转）</span>
        <span className={cn(
          'text-[10px] font-medium',
          errored ? 'text-red-400' : detail.status === 'FINISHED' ? 'text-green-400' : 'text-indigo-300',
        )}>
          {detail.status_label || MIGRATE_STATUS_LABEL[detail.status] || detail.status}
        </span>
      </div>

      {/* 执行锁状态提示（多会话互斥） */}
      {lock?.readonly ? (
        <div className="mb-2 text-[11px] text-[#8b8b9e] bg-[#16161e52] border border-[#252530] rounded-lg px-3 py-1.5">
          🔒 任务已全部完成（FINISHED），所有会话只读，仅可查看产物。
        </div>
      ) : lockBusy ? (
        <div className="mb-2 text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-1.5">
          ⚠️ 任务执行中，操作人：{lockOwner}｜只读模式 —— 当前可查看资产/报告/问答，但不能触发状态变更动作。
        </div>
      ) : (
        <div className="mb-2 text-[11px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-1.5">
          ✅ 任务空闲，你可以继续推进跨工程迭代流程。
        </div>
      )}

      <div className="flex items-start overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
        {stages.map((s, i) => {
          const state = errored
            ? (i < effIdx ? 'done' : i === effIdx ? 'error' : 'pending')
            : (i < effIdx ? 'done' : i === effIdx && activeStageDone ? 'done' : i === effIdx ? 'current' : 'pending')
          const showRetry = !!onRetryStage && !s.keys.includes('FINISHED')
          return (
            <div key={s.keys[0]} className="flex items-start flex-shrink-0">
              <div className="flex flex-col items-center gap-1">
                <BoardNode idx={i} label={s.label} desc={s.desc} state={state} onOpen={() => onOpenStage(i)} />
                {showRetry && (
                  <RetryNodeButton
                    label={s.label}
                    onRetry={() => onRetryStage?.(s.keys[0])}
                    retrying={retryingStage === s.keys[0]}
                    disabled={lockBusy || !!retryingStage}
                  />
                )}
              </div>
              {i < stages.length - 1 && (
                <div className={cn(
                  'w-3 h-px mt-[26px] flex-shrink-0',
                  state === 'done' || (errored && i <= effIdx && i < stages.length) ? 'bg-green-500/40' : 'bg-[#23232e]',
                )} />
              )}
            </div>
          )
        })}
      </div>

      {/* 空状态 / 异常状态提示 */}
      {detail.status === 'INIT' && (
        <div className="mt-2 text-[11px] text-[#8b8b9e] bg-[#16161e52] rounded-lg px-3 py-2">
          任务尚未启动：请先补充业务场景与前端任务，发起跨工程迭代。第一步「页面展示」节点上方高亮即当前可操作阶段。
        </div>
      )}
      {errored && (
        <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 break-all">
          节点 {effIdx + 1}「{stages[effIdx]?.label || '—'}」执行失败{detail.error_msg ? `：${detail.error_msg}` : '，数据库连接可能超时'}。点击右上角【断点续跑】从当前节点继续，不会从头重跑。
        </div>
      )}
      {detail.status === 'FINISHED' && (
        <div className="mt-2 text-[11px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
          任务已完成：跨工程改动包与各阶段报告已生成，可在产物面板中查看。
        </div>
      )}

      {/* 确定并推进（手动确认闸门：仅调用方传入 onAdvance 时展示） */}
      {onAdvance && (
        <div className="mt-2 border-t border-[#252530] pt-2">
          {errored ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-red-400">任务异常中断，请先在上方点击【断点续跑】恢复后再推进。</span>
            </div>
          ) : detail.status === 'FINISHED' ? (
            <div className="text-[11px] text-[#5a5a70]">任务已完成，全局只读，无推进闸门。</div>
          ) : lockBusy ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-yellow-400">任务执行中（操作人：{lockOwner}），处于只读模式，推进按钮已禁用。</span>
            </div>
          ) : nextStage ? (
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] text-[#8b8b9e]">当前处于「{stages[effIdx]?.label || '—'}」阶段，参数与阶段产物已就绪</div>
                <div className="text-[10px] text-[#5a5a70]">确认后将进入下一阶段（由后端状态机校验，不可跳转）</div>
              </div>
              <Button size="sm" className="h-8 text-[11px] shrink-0 bg-indigo-600 hover:bg-indigo-500 text-white" onClick={onAdvance} disabled={advancing}>
                <Play className="w-3.5 h-3.5 mr-1" />{advancing ? '推进中…' : `确定并推进到「${nextStage.label}」`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* ================= 阶段详情抽屉 ================= */

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-[#5a5a70]">{label}</span>
      <span className="text-[#cdd3e0] truncate pl-3" title={value}>{value}</span>
    </div>
  )
}


export function StageDrawer({ detail, stageIdx, onClose }: {
  detail: MigrateTaskDetail; stageIdx: number; onClose: () => void
}) {
  const stages = useMigrateBoardStages()
  const stage = stages[stageIdx]
  const effIdx = effectiveIdx(detail, stages)
  const errored = detail.status === 'ERROR' && effIdx === stageIdx
  const done = !errored && stageIdx < effIdx
  const current = !errored && stageIdx === effIdx
  if (!stage) return null


  return createPortal(
    <div className="fixed inset-0 z-[85] bg-black/40" onClick={onClose}>
      <div
        className="absolute top-0 bottom-0 right-0 w-[400px] bg-[#0f0f14] border-l border-[#252530] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[#252530] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center border',
              errored ? 'border-red-500/40 bg-red-500/10' : 'border-indigo-500/40 bg-indigo-500/10',
            )}>
              {errored ? <XCircle className="w-4 h-4 text-red-400" /> : done ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Workflow className="w-4 h-4 text-indigo-400" />}
            </span>
            <div>
              <div className="text-[13px] font-semibold text-[#e4e4e9]">阶段详情：{stage.label}</div>
              <div className="text-[11px] text-[#5a5a70]">任务 #{detail.task_id} · 第 {stageIdx + 1}/{stages.length} 步</div>
            </div>
          </div>
          <button className="text-[#5a5a70] hover:text-[#9a9aa4] p-1 rounded transition-colors" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 状态与时间 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[#16161e] border border-[#252530] p-3">
              <div className="text-[10px] text-[#5a5a70] mb-1">阶段状态</div>
              <div className={cn('text-[12px] font-medium',
                errored ? 'text-red-400' : current ? 'text-indigo-300' : done ? 'text-green-400' : 'text-[#5a5a70]')}>
                {errored ? '执行失败' : current ? '执行中' : done ? '已完成' : '未执行'}
              </div>
            </div>
            <div className="rounded-lg bg-[#16161e] border border-[#252530] p-3">
              <div className="text-[10px] text-[#5a5a70] mb-1">任务执行时间</div>
              <div className="text-[11px] text-[#cdd3e0] leading-snug">
                <div className="flex items-center gap-1"><Clock className="w-3 h-3 text-[#5a5a70]" />{(detail.created_at || '').slice(0, 16) || '—'}</div>
                <div className="flex items-center gap-1 mt-0.5"><Clock className="w-3 h-3 text-[#5a5a70]" />{(detail.updated_at || '').slice(0, 16) || '—'}</div>
              </div>
            </div>
          </div>

          {/* 阶段入参 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Braces className="w-3.5 h-3.5 text-[#5a5a70]" />
              <span className="text-[12px] font-medium text-[#9a9aa4]">阶段入参（本次任务已采集参数）</span>
            </div>
            <div className="rounded-lg bg-[#12121a] border border-[#252530] divide-y divide-[#1e1e28] text-[11.5px]">
              <ParamRow label="前端任务" value={detail.frontend_task || '未采集'} />
              <ParamRow label="业务场景" value={detail.business_scene || '未采集'} />
              <ParamRow label="订单来源" value={detail.order_source || '未采集'} />
              <ParamRow label="拆单规则" value={detail.split_rule || '未采集'} />
              <ParamRow label="受理系统" value={detail.accept_system || '未采集'} />
              <ParamRow label="工作流场景" value={detail.workflow_scene || '未采集'} />
              <ParamRow label="规则配置" value={detail.rule_config || '未采集'} />
              <ParamRow label="配置分支" value={detail.config_branch || '未采集'} />
              <ParamRow label="客户范围" value={detail.customer_scope || '未采集'} />
              <ParamRow label="数据范围" value={detail.data_range || '未采集'} />
            </div>
          </div>

          {/* 阶段产出物 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <FileText className="w-3.5 h-3.5 text-[#5a5a70]" />
              <span className="text-[12px] font-medium text-[#9a9aa4]">阶段产出物</span>
              <div className="ml-auto">
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => window.open(`#/workspace/migrate`)} title="在迭代面板中预览">
                  <Eye className="w-3 h-3 mr-1" />预览
                </Button>
              </div>
            </div>
            <div className="text-[11px] text-[#5a5a70] bg-[#12121a] border border-[#252530] rounded-lg px-3 py-3 text-center">
              该阶段完成后由对应业务域 Agent 生成代码改动清单报告（页面展示/下单拆单/订单受理/规则配置/客户数据），
              产物自动入库当前空间与子系统知识库，可在产物面板中查看。
            </div>
          </div>

          {/* 阶段执行日志 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <RotateCw className="w-3.5 h-3.5 text-[#5a5a70]" />
              <span className="text-[12px] font-medium text-[#9a9aa4]">阶段执行日志</span>
            </div>
            <div className="text-[11px] font-mono bg-[#12121a] border border-[#252530] rounded-lg p-3 space-y-1 leading-relaxed">
              {detail.status === 'INIT' && (
                <div className="text-[#5a5a70]">[INFO] 等待用户补充业务场景与前端任务，任务未开始（页面展示阶段）</div>
              )}
              {stageIdx > stageIdxOf('PAGE_SHOW', stages) && detail.business_scene && (
                <div className="text-[#8b8b9e]">[OK] 页面展示 · 已确认业务场景：{detail.business_scene}</div>
              )}
              {stageIdx > stageIdxOf('PAGE_SHOW', stages) && detail.frontend_task && (
                <div className="text-[#8b8b9e]">[OK] 页面展示 · 前端任务已明确：{detail.frontend_task}</div>
              )}
              {stageIdx > stageIdxOf('ORDER_SPLIT', stages) && detail.order_source && (
                <div className="text-[#8b8b9e]">[OK] 下单拆单 · 订单来源：{detail.order_source} / 拆单规则：{detail.split_rule || '—'}</div>
              )}
              {errored && (
                <div className="text-red-400">[ERROR] {detail.error_msg || '节点执行失败'}</div>
              )}
              {current && !errored && (
                <div className="text-indigo-300">[RUN] 当前阶段正在执行…</div>
              )}
              {done && stageIdx > 0 && (
                <div className="text-green-400">[OK] 阶段完成，已进入下一阶段</div>
              )}
              {detail.status === 'FINISHED' && done && (
                <div className="text-green-400">[OK] 全部阶段完成，跨工程改动包与报告已生成</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
