import { useMemo, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, X, Pause, Loader2, MessageSquare, Workflow, Radio, Copy, Download, ClipboardCopy, AlertTriangle, Bot, Wrench, FileJson, Terminal, Activity } from 'lucide-react'
import { api } from '@/lib/api'
import type { TraceEvent, TaskStatus, MigrateFlowNode, TraceLogItem } from '@/lib/types'
import { agents } from '@/components/chat/agent-tabs'
import { cn } from '@/lib/utils'
import { taskStageDefsFromFlow, type TaskFlowStageDef } from '@/components/migrate/flow-stages'

export type FlowStatus = 'pending' | 'running' | 'done' | 'failed' | 'paused'

const STATUS_TEXT: Record<FlowStatus, string> = {
  pending: '未执行', running: '执行中', done: '已完成', failed: '执行失败', paused: '已暂停',
}

const DOT_STATE: Record<FlowStatus, string> = {
  pending: 'border-[#3a3a48] text-[#6a6a7a]',
  done: 'bg-green-500 text-[#0f0f14]',
  running: 'bg-blue-500 text-white',
  failed: 'bg-red-500 text-white',
  paused: 'bg-amber-500 text-white',
}

const agentName = (id: string) => agents.find(a => a.id === id)?.name || id

export interface FlowStage extends TaskFlowStageDef {
  status: FlowStatus
  traces: TraceEvent[]
  startAt?: string
  durationMs?: number
  hidden?: boolean
}

/** 命中规则：优先按真实执行 Agent 归因，再按 trace 节点归到首尾阶段 */
function matchStage(t: TraceEvent, stages: TaskFlowStageDef[]): TaskFlowStageDef | null {
  const aid = t.agent_id || ''
  // 指挥官同时承担入口与汇总，不能把入口事件提前归因到完成节点。
  const byAgent = aid === 'migration_commander'
    ? undefined
    : stages.find(s => s.agentId === aid)
  if (byAgent) return byAgent

  const node = t.node
  if (node === 'parse') return stages[0]
  if (node === 'artifact') return stages[stages.length - 1]
  if (node === 'reply') {
    const err = typeof t.content === 'object' && t.content && (t.content as any).error
    return err ? null : stages[stages.length - 1]
  }

  const c = t.content
  const text = typeof c === 'string' ? c : (c && typeof c === 'object' ? JSON.stringify(c) : '')
  const agentInText = stages.find(s => text.includes(s.agentId))
  if (agentInText) return agentInText
  return stages.find(s => s.keywords.some(k => k && text.includes(k))) || null
}

function fmtDuration(ms?: number): string {
  if (ms == null || ms <= 0) return '—'
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}
function fmtClock(iso?: string): string {
  if (!iso) return '—'
  return iso.slice(0, 16).replace('T', ' ')
}

/**
 * 依据任务状态 + 全部会话 trace 推导链路各阶段状态。
 * 规则：
 *  - 无 trace / 待执行 → 全部灰色空心、虚线
 *  - 命中 trace 的阶段 → 已完成（绿色 ✓）
 *  - error trace / 任务失败 → 最后一个已执行阶段之后首阶段标失败，其后全部未执行（虚线中断）
 *  - 任务执行中 → 最后一个已执行阶段之后首阶段标运行中（蓝色 loading）
 *  - 任务已暂停 → 推演当前阶段标暂停
 *  - 可选中间节点（首尾之间从未触达）→ 动态隐藏，链路自动压缩
 */
function deriveFlow(
  traces: TraceEvent[],
  status: TaskStatus,
  stageDefs: TaskFlowStageDef[],
  updatedAt?: string | null,
): FlowStage[] {
  const stages: FlowStage[] = stageDefs.map(s => ({ ...s, status: 'pending' as FlowStatus, traces: [] }))
  if (traces.length === 0) return stages
  const stageIndex = new Map(stages.map((s, i) => [s.id, i]))

  const hitMap = new Map<string, { traces: TraceEvent[]; firstAt?: string }>()
  const hasError = traces.some(t => t.node === 'error' || (typeof t.content === 'object' && t.content && !!(t.content as any).error))
  const sorted = [...traces].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
    || (a.conv_id || 0) - (b.conv_id || 0)
    || a.id - b.id)

  for (const t of sorted) {
    const st = matchStage(t, stageDefs)
    if (!st) continue
    const hit = hitMap.get(st.id) || { traces: [] as TraceEvent[] }
    hit.traces.push(t)
    if (!hit.firstAt) hit.firstAt = t.created_at
    hitMap.set(st.id, hit)
  }
  if (hitMap.size === 0) return stages

  // 命中时间排序 → 计算每阶段耗时（下一命中时间 - 本阶段首命中时间）
  const hits = [...hitMap.entries()].sort((a, b) => ((a[1].firstAt || '').localeCompare(b[1].firstAt || '')))
  hits.forEach(([sid, hit], i) => {
    const st = stages[stageIndex.get(sid)!]
    st.status = 'done'
    st.traces = hit.traces
    st.startAt = hit.firstAt
    const nextAt = hits[i + 1]?.[1].firstAt
    if (nextAt && hit.firstAt && nextAt > hit.firstAt) {
      st.durationMs = new Date(nextAt).getTime() - new Date(hit.firstAt).getTime()
    } else {
      const end = updatedAt || hit.firstAt
      if (end && hit.firstAt && end > hit.firstAt) st.durationMs = new Date(end).getTime() - new Date(hit.firstAt).getTime()
    }
  })

  const doneIdx = hits.map(([sid]) => stageIndex.get(sid)!).sort((a, b) => a - b)
  const firstIdx = doneIdx[0]
  const lastIdx = doneIdx[doneIdx.length - 1]

  // 当前推演节点：第一个未命中阶段
  const nextCandidate = (from: number) => stages.findIndex((s, i) => i > from && !hitMap.has(s.id) && !s.hidden)

  if (status === 'running') {
    const cur = nextCandidate(lastIdx)
    if (cur !== -1) stages[cur].status = 'running'
  } else if (status === 'paused') {
    const cur = nextCandidate(lastIdx)
    if (cur !== -1) stages[cur].status = 'paused'
  } else if (status === 'failed' || (status === 'done' && hasError)) {
    const cur = nextCandidate(lastIdx)
    // 失败节点：取最后已执行阶段之后的首个节点；若已到末尾则将最后阶段保留，汇总为失败
    const failIdx = cur !== -1 ? cur : Math.min(stages.length - 1, lastIdx)
    stages[failIdx].status = 'failed'
  }

  // 动态隐藏：首尾之间从未触达的可选中间节点
  stages.forEach((s, i) => {
    if (i > firstIdx && i < lastIdx && !hitMap.has(s.id) && s.status === 'pending') {
      s.hidden = true
    }
    if (i < firstIdx && !s.traces.length) {
      // 首命中节点之前的节点保持未执行展示（如需求接收总是要展示）
    }
  })
  // 修复：失败/运行节点不可隐藏
  stages.forEach(s => { if (s.status !== 'pending') s.hidden = false })

  // 标记节点可跳转的会话
  return stages
}

/** 链路连接线状态 */
function lineCls(left: FlowStatus, right: FlowStatus): string {
  if (left === 'done' && right === 'done') return 'bg-green-500/70'
  if (left === 'done' && (right === 'running' || right === 'failed' || right === 'paused')) return 'bg-blue-500/70'
  return 'bg-[#2a2a35] border-t border-dashed border-[#3a3a48]'
}

/* ==================== 节点执行日志抽屉 ==================== */

const STATUS_CLS: Record<FlowStatus, { text: string; bg: string; dot: string }> = {
  pending: { text: 'text-[#8b8b9e]', bg: 'bg-[#1a1a24] border-[#2a2a35]', dot: 'bg-[#3a3a48]' },
  running: { text: 'text-blue-300', bg: 'bg-blue-500/10 border-blue-500/30', dot: 'bg-blue-400 animate-pulse' },
  done: { text: 'text-green-300', bg: 'bg-green-500/10 border-green-500/30', dot: 'bg-green-400' },
  failed: { text: 'text-red-300', bg: 'bg-red-500/10 border-red-500/30', dot: 'bg-red-400' },
  paused: { text: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/30', dot: 'bg-amber-400' },
}

/** trace node → 中文说明 */
const NODE_LABEL: Record<string, string> = {
  parse: '需求解析', route: '智能体路由', skill: '技能调用',
  artifact: '产物写入', agent: '子智能体调用', system: '系统事件',
  error: '错误事件',
}

type LogTab = 'prompt' | 'tools' | 'result' | 'raw'

/** 递归查找 content 中的 token 用量（usage/token_usage/tokens 字段） */
function deepFindTokens(node: unknown): { prompt: number; completion: number; total: number } | null {
  if (node == null) return null
  if (typeof node === 'string') {
    const m = node.match(/total_tokens[^\d]*(\d{1,8})/)
    if (m) return { prompt: 0, completion: 0, total: Number(m[1]) }
    return null
  }
  if (typeof node !== 'object') return null
  const o = node as Record<string, unknown>
  const u = o.usage || o.token_usage || o.tokens
  if (u && typeof u === 'object') {
    const uo = u as Record<string, unknown>
    const prompt = Number(uo.prompt_tokens ?? uo.input_tokens ?? uo.prompt ?? 0) || 0
    const completion = Number(uo.completion_tokens ?? uo.output_tokens ?? uo.completion ?? 0) || 0
    const total = Number(uo.total_tokens ?? (prompt + completion)) || 0
    if (total > 0) return { prompt, completion, total }
  }
  for (const k of Object.keys(o)) {
    const r = deepFindTokens(o[k])
    if (r) return r
  }
  return null
}

/** 提取节点 token 统计（无则返回 null） */
function stageTokens(traces: TraceEvent[]): { prompt: number; completion: number; total: number } | null {
  for (const t of traces) {
    const r = deepFindTokens(t.content)
    if (r) return r
  }
  return null
}

function traceText(t: TraceEvent): string {
  const c = t.content
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') {
    return JSON.stringify(c, null, 2)
  }
  return ''
}

/** 从 trace 中提取用户可见回复（agent/system 节点或 reply 字段） */
function stageReply(stage: FlowStage): string {
  const pick = stage.traces.find(t => t.node === 'agent' || t.node === 'reply' || t.node === 'system')
  if (!pick) return ''
  const c = pick.content
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>
    return String(o.reply || o.text || o.content || o.message || JSON.stringify(o))
  }
  return ''
}

/** 失败摘要：error trace 的内容 */
function stageError(stage: FlowStage): string {
  const e = stage.traces.find(t => t.node === 'error')
  if (!e) return ''
  const c = e.content
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>
    return String(o.error || o.message || o.detail || JSON.stringify(o))
  }
  return ''
}

/** 组装「复制全部日志」文本 */
function buildFullLog(stage: FlowStage): string {
  const lines: string[] = []
  lines.push(`节点日志：${stage.label}`)
  lines.push(`智能体：${agentName(stage.agentId)} ｜ 状态：${STATUS_TEXT[stage.status]}`)
  lines.push(`开始时间：${fmtClock(stage.startAt)} ｜ 耗时：${fmtDuration(stage.durationMs)}`)
  lines.push('')
  lines.push(`—— 原始 trace（${stage.traces.length} 条） ——`)
  for (const t of stage.traces) {
    lines.push(`[${fmtClock(t.created_at)}] [${t.node}]${t.agent_id ? ` (${agentName(t.agent_id)})` : ''}`)
    lines.push(traceText(t))
    lines.push('')
  }
  return lines.join('\n')
}

/** 节点执行日志抽屉：右侧滑出，层级低于产物预览抽屉 */
function NodeLogDrawer({ stage, onClose }: { stage: FlowStage; onClose: () => void }) {
  const [show, setShow] = useState(false)
  const [tab, setTab] = useState<LogTab>('prompt')
  const noData = stage.traces.length === 0
  const failed = stage.status === 'failed'
  const loading = stage.status === 'running'

  // 滑入动画 + ESC 关闭 + 锁定底层滚动
  useEffect(() => {
    const t = requestAnimationFrame(() => setShow(true))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(t)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  // 视为工具调用的事件节点
  const toolTraces = stage.traces.filter(t => t.node === 'skill' || t.node === 'route' || t.node === 'artifact' || t.node === 'agent')
  // 输入上下文：parse + route 事件
  const promptTraces = stage.traces.filter(t => t.node === 'parse' || t.node === 'route' || t.node === 'system')
  const reply = stageReply(stage)
  const errMsg = stageError(stage)
  const tokens = stageTokens(stage.traces)

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(buildFullLog(stage))
    } catch { /* ignore */ }
  }
  const exportLog = () => {
    const payload = {
      stage: stage.label, agent: stage.agentId, status: stage.status,
      start_at: stage.startAt, duration_ms: stage.durationMs,
      traces: stage.traces.map(t => ({ node: t.node, agent_id: t.agent_id, created_at: t.created_at, content: t.content })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `node-${stage.id}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return createPortal(
    <>
      {/* 遮罩：层级低于产物预览抽屉的遮罩（z-[85]） */}
      <div
        className={cn('fixed inset-0 z-[75] bg-black/40 transition-opacity duration-200', show ? 'opacity-100' : 'opacity-0')}
        onClick={onClose}
      />
      {/* 抽屉主体 */}
      <div
        className={cn(
          'fixed top-0 bottom-0 right-0 z-[76] w-[640px] max-w-[90vw] bg-[#0f0f14] border-l border-[#252530] flex flex-col shadow-2xl transition-transform duration-300 ease-out',
          show ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-[#252530] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="text-[14px] font-semibold text-[#e4e4e9] truncate">节点日志：{stage.label}</span>
            {loading && (
              <span className="flex items-center gap-1 text-[10px] text-blue-300 whitespace-nowrap">
                <Loader2 className="w-3 h-3 animate-spin" />执行中
              </span>
            )}
          </div>
          <button
            className="text-[#5a5a70] hover:text-[#e4e4e9] p-1.5 rounded-lg hover:bg-white/[0.05] transition-colors shrink-0"
            title="关闭 (ESC)"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 失败提示条 */}
        {failed && !noData && (
          <div className="px-5 py-2 flex items-center gap-2 bg-red-500/[0.08] border-b border-red-500/20">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-[11px] text-red-300 truncate">{errMsg || `节点「${stage.label}」执行失败`}</span>
          </div>
        )}

        {/* 基础概览卡片（固定顶部） */}
        <div className="px-5 py-3 border-b border-[#252530]">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[11px]">
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="w-3.5 h-3.5 text-[#5a5a70] shrink-0" />
              <span className="text-[#5a5a70] shrink-0">智能体</span>
              <button className="text-[#cdd3e0] truncate hover:text-indigo-300 transition-colors" title="跳转智能体管理页面">
                {agentName(stage.agentId)}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5a70] shrink-0">状态</span>
              <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]', STATUS_CLS[stage.status].bg, STATUS_CLS[stage.status].text)}>
                <span className={cn('w-1.5 h-1.5 rounded-full', STATUS_CLS[stage.status].dot)} />
                {STATUS_TEXT[stage.status]}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5a70] shrink-0">开始时间</span>
              <span className="text-[#cdd3e0]">{fmtClock(stage.startAt)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5a70] shrink-0">耗时</span>
              <span className="text-[#cdd3e0]">{fmtDuration(stage.durationMs)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5a70] shrink-0">输入 token</span>
              <span className="text-[#cdd3e0]">{tokens ? tokens.prompt : '—'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5a70] shrink-0">输出 token</span>
              <span className="text-[#cdd3e0]">{tokens ? tokens.completion : '—'}</span>
            </div>
            <div className="flex items-center gap-2 col-span-2">
              <span className="text-[#5a5a70] shrink-0">总消耗</span>
              <span className="text-[#cdd3e0]">{tokens ? `${tokens.total} token` : '—'}</span>
              <span className="text-[#4a4a5a] text-[10px]">（实际以模型返回为准，日志中未记录时显示 —）</span>
            </div>
          </div>
        </div>

        {/* 标签页 */}
        <div className="px-4 py-2 border-b border-[#252530] flex items-center gap-1">
          {([
            { k: 'prompt', label: '输入 Prompt', Icon: ClipboardCopy },
            { k: 'tools', label: '工具调用记录', Icon: Wrench },
            { k: 'result', label: '模型返回结果', Icon: Bot },
            { k: 'raw', label: '原始日志', Icon: FileJson },
          ] as { k: LogTab; label: string; Icon: typeof Bot }[]).map(({ k, label, Icon }) => (
            <button
              key={k}
              className={cn(
                'flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] transition-colors',
                tab === k ? 'bg-indigo-500/15 text-indigo-300 font-medium' : 'text-[#5a5a70] hover:text-[#cdd3e0] hover:bg-white/[0.04]',
                noData && 'opacity-50 cursor-not-allowed'
              )}
              disabled={noData}
              onClick={() => setTab(k)}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
          {noData && <span className="ml-auto text-[10px] text-[#4a4a5a]">该节点尚未执行，暂无日志</span>}
        </div>

        {/* 标签内容区（独立滚动） */}
        <div className="flex-1 overflow-y-auto">
          {noData ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center">
              <div className="text-[12px] text-[#5a5a70] mb-1">该节点尚未执行，暂无日志</div>
              <div className="text-[10px] text-[#4a4a5a]">任务开始执行后，此处将展示完整的 Agent 调用信息</div>
            </div>
          ) : tab === 'prompt' ? (
            <div className="p-4 space-y-3">
              {promptTraces.length === 0 && (
                <div className="text-[11px] text-[#5a5a70] py-8 text-center">该节点未记录独立 Prompt 上下文（从 trace 事件推断）</div>
              )}
              {promptTraces.map((t, i) => (
                <div key={i} className="rounded-lg border border-[#252530] bg-[#12121a] overflow-hidden">
                  <div className="px-3 py-1.5 bg-[#1a1a24] border-b border-[#252530] flex items-center justify-between">
                    <span className="text-[10px] font-medium text-indigo-400">[{NODE_LABEL[t.node] || t.node}]</span>
                    <span className="text-[10px] text-[#5a5a70]">{fmtClock(t.created_at)}</span>
                  </div>
                  <pre className="p-3 text-[11px] font-mono text-[#cdd3e0] whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{traceText(t)}</pre>
                </div>
              ))}
            </div>
          ) : tab === 'tools' ? (
            <div className="p-4 space-y-3">
              {toolTraces.length === 0 ? (
                <div className="text-[11px] text-[#5a5a70] py-8 text-center">本次节点没有调用任何工具/子智能体</div>
              ) : (
                toolTraces.map((t, i) => (
                  <div key={i} className="rounded-lg border border-[#252530] bg-[#12121a] overflow-hidden">
                    <div className="px-3 py-1.5 bg-[#1a1a24] border-b border-[#252530] flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[10px] text-[#cdd3e0] min-w-0">
                        <Wrench className="w-3 h-3 text-indigo-400 shrink-0" />
                        <span className="truncate">{NODE_LABEL[t.node] || t.node}</span>
                        {t.agent_id && <span className="text-[#8b8b9e] truncate">→ {agentName(t.agent_id)}</span>}
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-[#4a4a5a]">{fmtClock(t.created_at)}</span>
                        <span className={cn('text-[9px] px-1.5 py-px rounded-full', t.node === 'error' ? 'text-red-300 bg-red-500/10' : 'text-green-300 bg-green-500/10')}>
                          {t.node === 'error' ? '失败' : '成功'}
                        </span>
                      </span>
                    </div>
                    <div className="p-3">
                      <div className="text-[10px] text-[#5a5a70] mb-1">入参 / 返回</div>
                      <pre className="text-[11px] font-mono text-[#cdd3e0] whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{traceText(t)}</pre>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : tab === 'result' ? (
            <div className="p-4">
              {reply ? (
                <div className="rounded-lg border border-[#252530] bg-[#12121a] p-4">
                  <div className="text-[10px] text-[#5a5a70] mb-2">Agent 原始输出（不做渲染）</div>
                  <pre className="text-[12px] leading-relaxed text-[#cdd3e0] whitespace-pre-wrap break-all">{reply}</pre>
                </div>
              ) : (
                <div className="text-[11px] text-[#5a5a70] py-8 text-center">该节点暂无模型返回文本</div>
              )}
            </div>
          ) : (
            <div className="p-4">
              <div className="rounded-lg border border-[#252530] bg-[#12121a] overflow-hidden">
                <div className="px-3 py-1.5 bg-[#1a1a24] border-b border-[#252530] flex items-center justify-between">
                  <span className="text-[10px] font-medium text-[#8b8b9e]">完整底层 JSON（供开发排查）</span>
                  <span className="text-[10px] text-[#4a4a5a]">{stage.traces.length} 条事件</span>
                </div>
                <pre className="p-3 text-[10px] font-mono text-[#8b8b9e] whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
{JSON.stringify(stage.traces.map(t => ({
  id: t.id, node: t.node, agent_id: t.agent_id, created_at: t.created_at,
  conv_id: t.conv_id, conv_title: t.conv_title, content: t.content,
})), null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="px-4 py-2.5 border-t border-[#252530] flex items-center gap-2">
          <button
            className="flex items-center gap-1 h-7 px-3 rounded-lg text-[11px] bg-[#16161e] border border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] transition-colors"
            onClick={copyAll}
          >
            <Copy className="w-3 h-3" />复制全部日志
          </button>
          <button
            className="flex items-center gap-1 h-7 px-3 rounded-lg text-[11px] bg-[#16161e] border border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] transition-colors"
            onClick={exportLog}
          >
            <Download className="w-3 h-3" />导出日志
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}

/** 单节点：状态圆圈 + 标签 + hover tooltip + 点击选中 */
function NodeItem({ stage, selected, onClick, onJump, hasJump }: {
  stage: FlowStage
  selected: boolean
  onClick: () => void
  onJump: () => void
  hasJump: boolean
}) {
  return (
    <div className="relative group flex flex-col items-center min-w-[64px] px-1 cursor-pointer select-none" onClick={onClick}>
      {/* hover tooltip 气泡 */}
      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50">
        <div className="w-[180px] bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl px-3 py-2 text-[10px] space-y-1">
          <div className="text-[11px] font-medium text-[#e4e4e9]">{stage.label}</div>
          <div className="text-[#8b8b9e]">执行智能体：<span className="text-[#cdd3e0]">{agentName(stage.agentId)}</span></div>
          <div className="text-[#8b8b9e]">开始时间：<span className="text-[#cdd3e0]">{fmtClock(stage.startAt)}</span></div>
          <div className="text-[#8b8b9e]">耗时：<span className="text-[#cdd3e0]">{fmtDuration(stage.durationMs)}</span></div>
        </div>
      </div>

      {/* 状态圆圈 */}
      <div
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all',
          DOT_STATE[stage.status],
          stage.status === 'pending' && 'bg-[#1a1a24]',
          selected && 'ring-2 ring-indigo-400/70 ring-offset-2 ring-offset-[#16161e]',
        )}
      >
        {stage.status === 'done' && <Check className="w-4 h-4" strokeWidth={3} />}
        {stage.status === 'failed' && <X className="w-4 h-4" strokeWidth={3} />}
        {stage.status === 'paused' && <Pause className="w-3.5 h-3.5 fill-current" />}
        {stage.status === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
        {stage.status === 'pending' && <span className="w-1.5 h-1.5 rounded-full bg-[#3a3a48]" />}
      </div>

      {/* 标签 */}
      <div className="mt-1.5 text-[10px] leading-tight text-center max-w-[64px]">
        <span className={cn(stage.status === 'pending' ? 'text-[#5a5a70]' : 'text-[#e4e4e9]')}>{stage.label}</span>
      </div>
      {stage.status !== 'pending' && selected && (
        <div className="mt-0.5 text-[9px] text-[#5a5a70]">{STATUS_TEXT[stage.status]}</div>
      )}

      {/* 跳转会话角标 */}
      {hasJump && (
        <button
          onClick={e => { e.stopPropagation(); onJump() }}
          title="跳转到对应会话"
          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-indigo-500 text-white flex items-center justify-center hover:bg-indigo-400 transition-colors"
        >
          <MessageSquare className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  )
}

export function TaskTracePanel({ traces, status, updatedAt, traceId, onSelectConv }: {
  traces: TraceEvent[]
  status: TaskStatus
  updatedAt?: string | null
  traceId?: string
  onSelectConv?: (cid: number) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [flow, setFlow] = useState<MigrateFlowNode[] | null>(null)
  const [globalLogs, setGlobalLogs] = useState<TraceLogItem[]>([])

  useEffect(() => {
    let alive = true
    if (!traceId) {
      setGlobalLogs([])
      return
    }
    api.getTraceLogs(traceId).then(r => {
      if (alive && r.success && r.data) setGlobalLogs(r.data)
    }).catch(() => {})
    return () => { alive = false }
  }, [traceId])

  useEffect(() => {
    let alive = true
    api.getMigrateFlow().then(r => {
      if (alive && r.success && r.data) setFlow(r.data as MigrateFlowNode[])
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const stageDefs = useMemo(() => taskStageDefsFromFlow(flow), [flow])
  const stages = useMemo(
    () => deriveFlow(traces, status, stageDefs, updatedAt),
    [traces, status, stageDefs, updatedAt],
  )
  const visible = stages.filter(s => !s.hidden)

  // 自动滚动跟随执行：开启时自动选中当前运行/失败节点
  const autoSelected = useMemo(() => {
    if (!autoFollow) return null
    return stages.find(s => s.status === 'running' || s.status === 'failed')?.id || null
  }, [autoFollow, stages])
  const activeSelected = autoSelected || selected
  const selectedStage = stages.find(s => s.id === activeSelected && !s.hidden) || null

  // 手动点击节点 → 打开日志抽屉（自动滚动跟随只负责高亮，不强制弹出）
  const drawerOpen = selected != null && !!selectedStage

  const jumpToConv = (cid?: number | null) => {
    if (cid != null && onSelectConv) onSelectConv(cid)
  }

  const openNode = (id: string) => {
    // 手动点击节点 = 自由回看历史节点 → 关闭自动跟随，确保抽屉切换到所选节点
    setAutoFollow(false)
    setSelected(prev => (prev === id ? null : id))
  }

  return (
    <div className="rounded-xl border border-[#252530] bg-[#16161e] p-4 mt-4">
      {/* 面板头部 */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-[12px] font-semibold text-[#cdd3e0] flex items-center gap-1.5">
          <Workflow className="w-3.5 h-3.5 text-indigo-400" />
          任务执行链路
          <span className="text-[10px] font-normal text-[#5a5a70]">依据流程编排与会话 trace 推断</span>
        </div>
        <button
          onClick={() => setAutoFollow(f => !f)}
          className={cn(
            'h-6 px-2 rounded-full border text-[10px] flex items-center gap-1 transition-colors',
            autoFollow
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
              : 'border-[#2a2a35] bg-[#1a1a24] text-[#6a6a7a]'
          )}
          title="开启后：任务执行时自动高亮当前节点；关闭后自由回看历史节点"
        >
          <Radio className="w-2.5 h-2.5" />
          自动滚动跟随执行
        </button>
      </div>

      {/* 节点流程图（超过 6 个节点横向滚动） */}
      <div className="overflow-x-auto pb-1 -mx-1 px-1">
        <div className="flex items-center min-w-max">
          {visible.map((s, i) => {
            const prev = visible[i - 1]
            return (
              <div key={s.id} className="flex items-center">
                {prev && (
                  <div className={cn('flex-1 h-px w-8 shrink-0 -mt-5', lineCls(prev.status, s.status))} />
                )}
                <NodeItem
                  stage={s}
                  selected={activeSelected === s.id}
                  onClick={() => openNode(s.id)}
                  onJump={() => jumpToConv(s.traces[0]?.conv_id)}
                  hasJump={!!s.traces[0]?.conv_id}
                />
              </div>
            )
          })}
          {visible.length === 0 && <div className="text-[12px] text-[#5a5a70] py-4 px-2">暂无链路数据</div>}
        </div>
      </div>

      {traceId && (
        <div className="mt-4 rounded-xl border border-[#2a2a35] bg-[#12121a] p-3">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[12px] font-semibold text-[#cdd3e0]">全局追踪</span>
            <button
              onClick={() => navigator.clipboard?.writeText(traceId)}
              className="ml-auto flex items-center gap-1 text-[10px] text-[#6a6a7a] hover:text-[#9a9aa4] transition-colors"
              title="复制 TraceID"
            >
              <Copy className="w-3 h-3" />{traceId}
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
            {globalLogs.length === 0 && (
              <div className="text-[11px] text-[#5a5a70]">暂无全局追踪日志</div>
            )}
            {globalLogs.map(log => (
              <div key={log.id} className="flex items-center gap-2 text-[11px]">
                <span className="w-14 shrink-0 text-blue-300">{log.phase}</span>
                <span className="w-28 truncate text-[#8b8b9e]" title={log.span}>{log.span || '—'}</span>
                <span className={cn('w-12 shrink-0', log.level === 'error' ? 'text-red-400' : 'text-[#6a6a7a]')}>{log.level}</span>
                <span className="w-14 shrink-0 text-right text-[#6a6a7a]">{fmtDuration(log.duration_ms ?? undefined)}</span>
                <span className="flex-1 truncate text-[#cdd3e0]" title={log.message}>{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 节点执行日志抽屉：点击节点 / 跟随运行中节点时从右侧滑出；切换节点直接刷新内容不重开 */}
      {drawerOpen && selectedStage && (
        <NodeLogDrawer
          stage={selectedStage}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
