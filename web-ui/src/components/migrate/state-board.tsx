import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import {
  MIGRATE_STATUS_LABEL,
  type MigrateTaskDetail, type MigrateStatus,
} from '@/lib/types'
import {
  CheckCircle2, XCircle, Circle, Workflow,
  X, Eye, Clock, Braces, FileText, RotateCw, FileSpreadsheet, Play,
} from 'lucide-react'

/* ================= 状态机看板（任务详情头部主入口） ================= */

/** 展示节点：与后端 pipeline 一致的 6 步流程（数据采集→迁移评估→迁移方案→代码改造→迁移验证→完成） */
export const BOARD_STAGES: { keys: MigrateStatus[]; label: string; desc: string }[] = [
  { keys: ['DATA_COLLECTION'], label: '数据采集', desc: '采集源库元数据/表结构/对象清单（小采），并确认源/目标库、容量、停机窗口等参数' },
  { keys: ['ASSESSMENT_RUNNING'], label: '迁移评估', desc: '评估专家（小评）结合规则命中做兼容性风险与工作量评估' },
  { keys: ['SOLUTION_GENERATE'], label: '迁移方案', desc: '方案专家（小方）汇总采集与评估结果，生成国产化迁移落地方案' },
  { keys: ['CODE_MIGRATE'], label: '代码改造', desc: '改造专家（小改）做 JDBC/ORM/存储过程应用代码适配' },
  { keys: ['VERIFY_STAGE'], label: '迁移验证', desc: '验证专家（小测）校验语法与结构一致性' },
  { keys: ['FINISHED'], label: '完成', desc: '生成结构化资产与完整报告' },
]

export function stageIdxOf(status: string): number {
  const i = BOARD_STAGES.findIndex(s => s.keys.includes(status as MigrateStatus))
  return i >= 0 ? i : 0
}

/** ERROR 状态无法直接映射，依据已采集参数推断「最近推进到的阶段」 */
export function effectiveIdx(t: MigrateTaskDetail): number {
  if (t.status === 'ERROR') {
    if (t.source_ds_id && t.source_db_type && t.target_db_type
      && (t.db_business_level || t.db_capacity || t.stop_window)) return stageIdxOf('ASSESSMENT_RUNNING')
    if (t.source_ds_id) return stageIdxOf('DATA_COLLECTION')
    return stageIdxOf('DATA_COLLECTION')
  }
  return stageIdxOf(t.status)
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

/** 状态机横向看板 + 连接线 */
export function StateBoard({ detail, onOpenStage, onAdvance, advancing }: {
  detail: MigrateTaskDetail
  onOpenStage: (i: number) => void
  /** 可选：确定并推进（对话页手动确认闸门互动放此处，由调用方触发 advance API） */
  onAdvance?: () => void
  advancing?: boolean
}) {
  const effIdx = effectiveIdx(detail)
  const errored = detail.status === 'ERROR'
  const lock = detail.exec_lock
  // 执行锁：被其他会话占用 → 只读；空闲 → 可操作
  const lockBusy = !!lock?.locked
  const lockOwner = lock?.owner_user_id || lock?.session_id || '其他会话'
  // 下一阶段：推进按钮的提示文案
  const nextStage = (effIdx >= 0 && effIdx < BOARD_STAGES.length - 1) ? BOARD_STAGES[effIdx + 1] : null
  const canAdvance = !!onAdvance && !!nextStage && !errored && detail.status !== 'FINISHED' && !lockBusy
  return (
    <div className="rounded-lg bg-[#0f0f14] border border-[#1e1e28] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-[#8b8b9e]">任务总状态流转（后端状态机驱动，页面仅展示，用户不可跳转）</span>
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
          ✅ 任务空闲，你可以继续推进迁移流程。
        </div>
      )}

      <div className="flex items-start overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
        {BOARD_STAGES.map((s, i) => {
          const state = errored
            ? (i < effIdx ? 'done' : i === effIdx ? 'error' : 'pending')
            : (i < effIdx ? 'done' : i === effIdx ? 'current' : 'pending')
          return (
            <div key={s.label} className="flex items-start flex-shrink-0">
              <BoardNode idx={i} label={s.label} desc={s.desc} state={state} onOpen={() => onOpenStage(i)} />
              {i < BOARD_STAGES.length - 1 && (
                <div className={cn(
                  'w-3 h-px mt-[26px] flex-shrink-0',
                  state === 'done' || (errored && i <= effIdx && i < BOARD_STAGES.length) ? 'bg-green-500/40' : 'bg-[#23232e]',
                )} />
              )}
            </div>
          )
        })}
      </div>

      {/* 空状态 / 异常状态提示 */}
      {detail.status === 'INIT' && (
        <div className="mt-2 text-[11px] text-[#8b8b9e] bg-[#16161e52] rounded-lg px-3 py-2">
          任务尚未启动：请先选择数据源，发起迁移任务。第一步「数据采集」节点上方高亮即当前可操作阶段。
        </div>
      )}
      {errored && (
        <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 break-all">
          节点 {effectiveIdx(detail) + 1}「{BOARD_STAGES[effectiveIdx(detail)]?.label || '—'}」执行失败{detail.error_msg ? `：${detail.error_msg}` : '，数据库连接可能超时'}。点击右上角【断点续跑】从当前节点继续，不会从头重跑。
        </div>
      )}
      {detail.status === 'FINISHED' && (
        <div className="mt-2 text-[11px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
          迁移评估已完成：结构化资产与报告已生成，可导出资产清单 Excel。
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
                <div className="text-[11px] text-[#8b8b9e]">当前处于「{BOARD_STAGES[effectiveIdx(detail)]?.label || '—'}」阶段，参数与阶段产物已就绪</div>
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

function StatBlock({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="rounded-lg bg-[#0f0f14] border border-[#1e1e28] px-2 py-1.5">
      <div className={cn('text-[16px] font-semibold leading-none mb-0.5', cls)}>{value}</div>
      <div className="text-[9px] text-[#5a5a70]">{label}</div>
    </div>
  )
}

export function StageDrawer({ detail, stageIdx, onClose }: {
  detail: MigrateTaskDetail; stageIdx: number; onClose: () => void
}) {
  const stage = BOARD_STAGES[stageIdx]
  const errored = detail.status === 'ERROR' && effectiveIdx(detail) === stageIdx
  const done = !errored && stageIdx < effectiveIdx(detail)
  const current = !errored && stageIdx === effectiveIdx(detail)
  const assets = detail.assets || []
  const stats = detail.assets_stats || { total: 0, high: 0, medium: 0, low: 0 }

  const doExport = () => {
    const a = document.createElement('a')
    a.href = api.exportMigrateExcel(detail.task_id)
    a.download = `migrate_assets_${detail.task_id}.xlsx`
    a.click()
  }

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
              <div className="text-[11px] text-[#5a5a70]">任务 #{detail.task_id} · 第 {stageIdx + 1}/{BOARD_STAGES.length} 步</div>
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
              <ParamRow label="源数据源" value={detail.source_ds_name || detail.source_ds_id || '未采集'} />
              <ParamRow label="源库类型" value={detail.source_db_type || '未采集'} />
              <ParamRow label="目标国产库" value={detail.target_db_type || '未采集'} />
              <ParamRow label="业务等级" value={detail.db_business_level || '未采集'} />
              <ParamRow label="库容量" value={detail.db_capacity || '未采集'} />
              <ParamRow label="停机窗口" value={detail.stop_window || '未采集'} />
              <ParamRow label="扫描对象数" value={String(detail.object_count || 0)} />
            </div>
          </div>

          {/* 阶段产出物 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <FileText className="w-3.5 h-3.5 text-[#5a5a70]" />
              <span className="text-[12px] font-medium text-[#9a9aa4]">阶段产出物：结构化资产清单</span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => window.open(`#/workspace/migrate`)} title="在迁移面板中预览">
                  <Eye className="w-3 h-3 mr-1" />预览
                </Button>
                <Button size="sm" className="h-6 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white" onClick={doExport} disabled={stats.total === 0}>
                  <FileSpreadsheet className="w-3 h-3 mr-1" />导出
                </Button>
              </div>
            </div>
            {stats.total === 0 ? (
              <div className="text-[11px] text-[#5a5a70] bg-[#12121a] border border-[#252530] rounded-lg px-3 py-3 text-center">
                该阶段尚未产出对象资产。扫描对象后由规则引擎自动生成。
              </div>
            ) : (
              <div className="rounded-lg bg-[#12121a] border border-[#252530] p-3">
                <div className="grid grid-cols-4 gap-2 text-center mb-2">
                  <StatBlock label="总量" value={stats.total} cls="text-[#e4e4e9]" />
                  <StatBlock label="高危" value={stats.high} cls="text-red-400" />
                  <StatBlock label="中危" value={stats.medium} cls="text-yellow-400" />
                  <StatBlock label="低危" value={stats.low} cls="text-green-400" />
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {assets.slice(0, 15).map(a => (
                    <div key={a.id} className="flex items-center gap-2 text-[11px]">
                      <span className="text-[9px] text-[#8b8b9e] w-14 flex-shrink-0">{a.asset_type}</span>
                      <span className="font-mono text-[#cdd3e0] flex-1 truncate">{a.asset_name}</span>
                      <span className={cn('px-1.5 py-0.5 rounded border text-[9px] font-medium flex-shrink-0',
                        a.risk_level === '高' ? 'text-red-400 border-red-500/30 bg-red-500/10'
                          : a.risk_level === '中' ? 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10'
                            : 'text-green-400 border-green-500/30 bg-green-500/10')}>{a.risk_level}</span>
                    </div>
                  ))}
                  {assets.length > 15 && (
                    <div className="text-[10px] text-[#5a5a70] text-center pt-1">…共 {assets.length} 项，详见迁移面板资产清单</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 阶段执行日志 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <RotateCw className="w-3.5 h-3.5 text-[#5a5a70]" />
              <span className="text-[12px] font-medium text-[#9a9aa4]">阶段执行日志</span>
            </div>
            <div className="text-[11px] font-mono bg-[#12121a] border border-[#252530] rounded-lg p-3 space-y-1 leading-relaxed">
              {detail.status === 'INIT' && (
                <div className="text-[#5a5a70]">[INFO] 等待用户选择数据源，任务未开始（数据采集阶段）</div>
              )}
              {stageIdx > 0 && detail.source_ds_name && (
                <div className="text-[#8b8b9e]">[OK] 数据采集 · 已选定源数据源：{detail.source_ds_name}</div>
              )}
              {stageIdx >= 1 && detail.target_db_type && (
                <div className="text-[#8b8b9e]">[OK] 数据采集 · 参数齐备：目标 {detail.target_db_type} / 容量 {detail.db_capacity || '—'}</div>
              )}
              {stageIdx >= 2 && detail.object_count ? (
                <div className="text-[#8b8b9e]">[OK] 数据采集 · 对象扫描完成：共 {detail.object_count} 个对象，规则命中 {stats.total} 项资产</div>
              ) : null}
              {errored && (
                <div className="text-red-400">[ERROR] {detail.error_msg || '节点执行失败，数据库连接超时'}</div>
              )}
              {current && !errored && (
                <div className="text-indigo-300">[RUN] 当前阶段正在执行…</div>
              )}
              {done && stageIdx > 2 && (
                <div className="text-green-400">[OK] 阶段完成，已进入下一阶段</div>
              )}
              {detail.status === 'FINISHED' && done && (
                <div className="text-green-400">[OK] 全部阶段完成，报告已生成</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
