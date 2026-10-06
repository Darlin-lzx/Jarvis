import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { ChatStep } from '@/hooks/use-chat-stream'
import {
  ChevronRight, ChevronsUpDown, Loader2, CheckCircle2,
  XCircle, RotateCw, Square, PlayCircle, AlertTriangle, X,
  Braces, LogIn, Copy, Check,
} from 'lucide-react'

/* ---- 节点配置 ---- */
interface NodeStyle {
  label: string
  text: string
  border: string
  bg: string
  icon: typeof PlayCircle
}

const NODE_STYLES: Record<string, NodeStyle> = {
  parse: { label: '识别意图', text: 'text-blue-400', border: 'border-blue-500/30', bg: 'bg-blue-500/[0.08]', icon: PlayCircle },
  route: { label: '路由', text: 'text-purple-400', border: 'border-purple-500/30', bg: 'bg-purple-500/[0.08]', icon: ChevronsUpDown },
  skill: { label: '调用技能', text: 'text-amber-400', border: 'border-amber-500/30', bg: 'bg-amber-500/[0.08]', icon: ChevronRight },
  agent: { label: '子 Agent 调用', text: 'text-sky-400', border: 'border-sky-500/30', bg: 'bg-sky-500/[0.08]', icon: PlayCircle },
  artifact: { label: '产物', text: 'text-green-400', border: 'border-green-500/30', bg: 'bg-green-500/[0.08]', icon: CheckCircle2 },
  error: { label: '执行失败', text: 'text-red-400', border: 'border-red-500/30', bg: 'bg-red-500/[0.08]', icon: XCircle },
}

const DURATIONS: Record<string, number> = { parse: 0.12, route: 0.08, skill: 0.16, agent: 0.25, artifact: 0.2, error: 0.05 }

interface ChainNode {
  id: string
  type: string
  label: string
  style: NodeStyle
  duration: number
  /** duration 是否为估算值（历史步骤无真实时间戳时回退估算） */
  estimated: boolean
  state: 'done' | 'running' | 'failed' | 'retrying'
  detail: string
  raw: Record<string, unknown> | string
}

/** 步骤是否携带真实时间戳（本次流式运行产生的步骤才有） */
function hasRealTiming(steps: ChatStep[]): boolean {
  return steps.length > 0 && steps.every(s => typeof s.ts === 'number')
}

function buildNodes(steps: ChatStep[], running: boolean): ChainNode[] {
  if (steps.length === 0 && running) {
    steps = [{ type: 'parse', content: {} }]
  }
  const failedIdx = steps.findIndex(s => s.type === 'error')
  const lastIdx = steps.length - 1
  const realTiming = hasRealTiming(steps)
  return steps.map((s, i) => {
    const cfg = NODE_STYLES[s.type] || { label: s.type, text: 'text-[#5a5a70]', border: 'border-[#252530]', bg: 'bg-[#16161e]', icon: PlayCircle }
    let state: ChainNode['state'] = 'done'
    if (s.type === 'error') state = 'failed'
    else if (running && i === lastIdx && failedIdx === -1) state = 'running'
    else if (running && failedIdx !== -1 && i < failedIdx) state = 'done'
    else if (running && failedIdx !== -1 && i > failedIdx) state = 'done'
    // 真实耗时：当前节点 ts − 上一节点 ts（SSE 事件到达间隔）；历史步骤回退按类型估算
    const duration = realTiming
      ? ((s.ts as number) - (i > 0 ? (steps[i - 1].ts as number) : 0)) / 1000
      : (DURATIONS[s.type] ?? 0.1)
    return {
      id: `${s.type}-${i}`,
      type: s.type,
      label: cfg.label,
      style: cfg,
      duration,
      estimated: !realTiming,
      state,
      detail: parseDetail(s),
      raw: s.content,
    }
  })
}

function parseDetail(s: ChatStep): string {
  const c = typeof s.content === 'object' ? s.content : {}
  if (s.type === 'parse' && c.intent) return `意图: ${c.intent as string}`
  if (s.type === 'route' && c.agent_id) return `${c.agent_id as string}`
  if (s.type === 'skill' && (c.skill_id || c.skill_name)) return `skill: ${(c.skill_name || c.skill_id) as string}`
  if (s.type === 'agent' && c.agent_name) return `${c.dispatcher_name ? `由 ${c.dispatcher_name} 调度 · ` : ''}${c.agent_name as string}`
  if (s.type === 'error' && typeof s.content === 'string') return s.content
  return ''
}

/** 真实耗时直接累加；估算耗时叠加基础调度耗时（标注 ≈） */
export function computeTotalTime(nodes: { duration: number; estimated?: boolean }[]): number {
  const sum = nodes.reduce((acc, n) => acc + n.duration, 0)
  return nodes.some(n => n.estimated) ? 10.5 + sum : sum
}

/** 总耗时：步骤带真实时间戳时取最后节点 ts（真实值），否则按类型估算 */
export function computeStepTotal(steps: ChatStep[]): number {
  if (hasRealTiming(steps)) return (steps[steps.length - 1].ts as number) / 1000
  return 10.5 + steps.reduce((s, st) => s + (DURATIONS[st.type] ?? 0.1), 0)
}

/** 总耗时是否为估算值（决定 UI 是否显示 ≈ 前缀） */
export function isEstimatedTotal(steps: ChatStep[]): boolean {
  return !hasRealTiming(steps)
}

interface ChatStepPanelProps {
  steps: ChatStep[]
  running: boolean
  collapsed: boolean
  onToggle: () => void
  onStop: () => void
  /** 节点被点击，默认展示详情抽屉 */
}

export function ChatStepPanel({ steps, running, collapsed, onToggle, onStop }: ChatStepPanelProps) {
  const [nodes, setNodes] = useState<ChainNode[]>([])
  const [detailNode, setDetailNode] = useState<ChainNode | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setNodes(buildNodes(steps, running))
  }, [steps, running])

  const hasError = nodes.some(n => n.state === 'failed' || n.state === 'retrying')
  const executingIdx = nodes.findIndex(n => n.state === 'running' || n.state === 'retrying')

  /* 重试失败节点（模拟） */
  const handleRetry = (idx: number) => {
    setNodes(prev => prev.map((n, i) => (i === idx ? { ...n, state: 'retrying' as const } : n)))
    setTimeout(() => {
      setNodes(prev => prev.map((n, i) => (i === idx ? { ...n, state: 'done' as const, label: n.type === 'error' ? '已重试' : n.label } : n)))
    }, 1500)
  }

  const copyNodeLog = async (node: ChainNode) => {
    const text = [
      `[节点] ${node.label}`,
      `[耗时] ${node.duration}s`,
      `[详情] ${node.detail}`,
      `[入参/出参] ${JSON.stringify(node.raw, null, 2)}`,
    ].join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const statusText = hasError ? '执行失败' : running ? '执行中' : '已完成'
  const statusColor = hasError ? 'text-red-400' : running ? 'text-blue-400' : 'text-green-400'

  /* ========== 折叠态：仅一行（流式回复期间不显示转圈，避免与底部消息区重复） ========== */
  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-5 py-2 border-b border-[#1e1e28] bg-[#0f0f14] hover:bg-white/[0.02] transition-colors text-left cursor-pointer"
        title="点击展开任务执行链路"
      >
        <ActivityIcon running={false} hasError={hasError} />
        <span className="text-[12px] font-medium text-[#cdd3e0]">执行链路</span>
        <span className={cn('text-[12px]', statusColor)}>{statusText}</span>
        <span className="text-[11px] text-[#5a5a70]">{nodes.some(n => n.estimated) ? '≈' : ''}总耗时 {computeTotalTime(nodes).toFixed(1)}s</span>
        {executingIdx >= 0 && !hasError && !running && (
          <span className="flex items-center gap-1 text-[12px] text-blue-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            {nodes[executingIdx]?.label}
          </span>
        )}
        <span className="flex-1" />
        {running && (
          <span className="flex items-center gap-1 text-[11px] text-[#5a5a70]">
            <ChevronRight className="w-3 h-3 rotate-90 text-indigo-400" />
            展开查看链路
          </span>
        )}
      </button>
    )
  }

  /* ========== 展开态 ========== */
  return (
    <div className="px-5 pt-2.5 pb-3 border-b border-[#1e1e28] bg-[#101018]">
      {/* 链路头部 */}
      <div className="flex items-center gap-2 mb-2.5">
        <ActivityIcon running={running} hasError={hasError} />
        <span className="text-[12px] font-semibold text-[#cdd3e0]">执行链路</span>
        <span className={cn('text-[11px]', statusColor)}>{statusText}</span>
        <span className="text-[11px] text-[#5a5a70]">{nodes.some(n => n.estimated) ? '≈' : ''}总耗时 {computeTotalTime(nodes).toFixed(1)}s</span>
        <span className="flex-1" />
        {running && (
          <button
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
            onClick={onStop}
          >
            <Square className="w-2.5 h-2.5" />
            终止任务
          </button>
        )}
        {executingIdx >= 0 && (
          <button
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-[#252530] text-[#9a9aa4] hover:text-indigo-400 transition-colors"
            onClick={onToggle}
          >
            <ChevronsUpDown className="w-3 h-3" />
            折叠链路
          </button>
        )}
      </div>

      {/* 横向节点流程图 */}
      <div className="flex items-center gap-0 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
        {nodes.map((node, i) => {
          const Icon = node.style.icon
          const isLast = i === nodes.length - 1
          return (
            <div key={node.id} className="flex items-center shrink-0">
              {/* 节点卡片 */}
              <div
                className={cn(
                  'rounded-xl border px-3 py-2 min-w-[128px] cursor-pointer transition-all group/node',
                  node.style.border, node.style.bg,
                  node.state === 'running' && 'ring-1 ring-blue-400/60 animate-pulse',
                  node.state === 'retrying' && 'ring-1 ring-amber-400/60 animate-pulse',
                  detailNode?.id === node.id && 'ring-1 ring-indigo-400'
                )}
                onClick={() => setDetailNode(detailNode?.id === node.id ? null : node)}
                title={`${node.label}｜${node.detail || '点击查看节点详情'}`}
              >
                <div className="flex items-center gap-1.5">
                  {node.state === 'running' ? (
                    <Loader2 className={cn('w-3.5 h-3.5 animate-spin', node.style.text)} />
                  ) : node.state === 'retrying' ? (
                    <RotateCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                  ) : node.state === 'failed' ? (
                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                  ) : (
                    <Icon className={cn('w-3.5 h-3.5', node.style.text)} />
                  )}
                  <span className={cn('text-[12px] font-medium', node.style.text)}>{node.label}</span>
                </div>
                <div className="text-[10px] text-[#5a5a70] mt-1 truncate max-w-[120px]">
                  {node.state === 'running' ? '执行中…' : node.state === 'retrying' ? '重试中…' : node.state === 'failed' ? '节点失败' : (node.detail || ' 完成')}
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-[#4a4a5a]">⏱ {node.estimated ? '≈' : ''}{node.duration.toFixed(1)}s</span>
                  {node.state === 'failed' && (
                    <button
                      className={cn(
                        'flex items-center gap-0.5 text-[10px] rounded px-1 py-px border transition-colors',
                        'text-red-400 border-red-500/30 hover:bg-red-500/10'
                      )}
                      onClick={e => { e.stopPropagation(); handleRetry(i) }}
                    >
                      <RotateCw className="w-2.5 h-2.5" />
                      重试
                    </button>
                  )}
                </div>
              </div>
              {!isLast && <ChevronRight className="w-3.5 h-3.5 text-[#3a3a45] mx-1 shrink-0" />}
            </div>
          )
        })}
      </div>

      {/* 失败提示条 */}
      {hasError && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          节点执行失败{nodes.find(n => n.state === 'failed') ? `：${nodes.find(n => n.state === 'failed')?.label}（${nodes.find(n => n.state === 'failed')?.detail || '未知错误'}），点击节点查看详情或重试` : ''}
        </div>
      )}

      {/* ======== 节点详情抽屉（portal） ======== */}
      {detailNode && createPortal(
        <div className="fixed inset-0 z-[85] bg-black/40" onClick={() => setDetailNode(null)}>
          <div
            className="absolute top-0 bottom-0 w-[380px] bg-[#0f0f14] border-l border-[#252530] flex flex-col shadow-2xl"
            style={{ right: 280 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[#252530] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center border', detailNode.style.border, detailNode.style.bg)}>
                  {(() => {
                    const Icon = detailNode.style.icon
                    return <Icon className={cn('w-4 h-4', detailNode.style.text)} />
                  })()}
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-[#e4e4e9]">节点详情</div>
                  <div className={cn('text-[11px]', detailNode.style.text)}>{detailNode.label}</div>
                </div>
              </div>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4] p-1 rounded transition-colors" onClick={() => setDetailNode(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-5 space-y-4">
                {/* 基本信息 */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-[#16161e] border border-[#252530] p-3">
                    <div className="text-[10px] text-[#5a5a70] mb-1">状态</div>
                    <div className={cn('text-[12px] font-medium',
                      detailNode.state === 'failed' ? 'text-red-400' : detailNode.state === 'running' ? 'text-blue-400' : 'text-green-400')}>
                      {detailNode.state === 'failed' ? '执行失败' : detailNode.state === 'running' ? '执行中' : detailNode.state === 'retrying' ? '重试中' : '已完成'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#16161e] border border-[#252530] p-3">
                    <div className="text-[10px] text-[#5a5a70] mb-1">耗时</div>
                    <div className="text-[12px] text-[#cdd3e0] font-medium">{detailNode.estimated ? '≈' : ''}{detailNode.duration.toFixed(1)}s{detailNode.estimated ? '（估算）' : ''}</div>
                  </div>
                </div>

                {/* 入参 / 出参 */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Braces className="w-3.5 h-3.5 text-[#5a5a70]" />
                    <span className="text-[12px] font-medium text-[#9a9aa4]">入参 / 返回结果</span>
                    <button
                      className="ml-auto flex items-center gap-1 text-[10px] text-[#5a5a70] hover:text-indigo-400 transition-colors"
                      onClick={() => copyNodeLog(detailNode)}
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copied ? '已复制' : '复制'}
                    </button>
                  </div>
                  <pre className="text-[11px] font-mono leading-relaxed text-[#cdd3e0] bg-[#12121a] border border-[#252530] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-[240px] overflow-y-auto">
                    {JSON.stringify(detailNode.raw, null, 2)}
                  </pre>
                </div>

                {/* 日志 */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <LogIn className="w-3.5 h-3.5 text-[#5a5a70]" />
                    <span className="text-[12px] font-medium text-[#9a9aa4]">执行日志</span>
                  </div>
                  <div className="text-[11px] font-mono bg-[#12121a] border border-[#252530] rounded-lg p-3 space-y-1 leading-relaxed">
                    {detailNode.state === 'failed' ? (
                      <>
                        <div className="text-red-400">[ERROR] {detailNode.detail || '节点执行异常'}</div>
                        <div className="text-[#5a5a70]">[INFO] 已终止该节点后续依赖</div>
                      </>
                    ) : (
                      <>
                        <div className="text-[#8b8b9e]">[INFO] 节点 {detailNode.label} 开始执行</div>
                        <div className="text-[#8b8b9e]">[INFO] {detailNode.detail ? `路由参数 ${detailNode.detail}` : '等待子 Agent 返回'}</div>
                        <div className="text-green-400">[OK] 节点执行完成，耗时 {detailNode.duration}s</div>
                      </>
                    )}
                  </div>
                </div>

                {/* 失败重试按钮 */}
                {detailNode.state === 'failed' && (
                  <button
                    className="w-full h-9 rounded-lg flex items-center justify-center gap-1.5 text-[12px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                    onClick={() => {
                      const idx = nodes.findIndex(n => n.id === detailNode.id)
                      if (idx >= 0) handleRetry(idx)
                      setDetailNode({ ...detailNode, state: 'retrying' })
                    }}
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    重试该节点（不重启整个会话）
                  </button>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function ActivityIcon({ running, hasError }: { running: boolean; hasError: boolean }) {
  if (hasError) return <XCircle className="w-3.5 h-3.5 text-red-400" />
  if (running) return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
  return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
}