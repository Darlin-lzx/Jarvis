import { useState, useEffect, useRef, useCallback } from 'react'
import { Message } from './message'
import { Composer } from './composer'
import { AgentTabs, agents as builtinAgents, type AgentTabStatus } from './agent-tabs'
import { WorkspacePanel } from './workspace-panel'
import type { WorkspaceFileRequest } from './workspace-panel'
import { ConvertToProjectDialog } from './convert-to-project-dialog'
import { AttachTaskDialog } from '@/components/project/attach-task-dialog'
import { useChatStream, stripLeadingJson, type TimelineItem } from '@/hooks/use-chat-stream'
import { api } from '@/lib/api'
import { isFinishedAgentTrace, isVisibleSystemTrace } from '@/lib/trace-filter'
import type { Agent, ArtifactItem, Message as MsgType, TraceEvent, ConversationDetail, Space, SendExtra, SystemEvent, SubAgentEvent, MigrateEvent, MigrateTask, MigrateTaskDetail } from '@/lib/types'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { Sparkles, ChevronRight, ChevronDown, ChevronsUpDown, Link2, Zap, ArrowLeft, Workflow, Play, FileText, CircleAlert } from 'lucide-react'
import { StateBoard, currentStageExecutionDone, effectiveIdx, StageDrawer, useMigrateBoardStages } from '@/components/migrate/state-board'
import { mergeMigrateSnapshot, useMigrateStateSocket } from '@/hooks/use-migrate-state-socket'

interface ChatViewProps {
  convId: number | null
  onConvCreated: (id: number) => void
  onRefreshArtifacts: () => void
  activeAgent: string
  setActiveAgent: (id: string) => void
  quickMode?: boolean
  onModeChange?: (q: boolean) => void
  onConvertToProject?: (spaceId: number) => void | Promise<unknown>
  /** 从任务详情进入会话时提供：点击顶部任务标签返回任务详情页 */
  onBackToTask?: () => void
  /** 后端智能体列表（用于输入框下拉和标签栏） */
  agentList?: Agent[]
  /** 从工作台转入会话时自动执行的首条指令 */
  initialMessage?: string | null
  onInitialMessageConsumed?: () => void
}

interface DisplayItem {
  kind: 'message' | 'system' | 'sub_agent'
  role?: 'user' | 'assistant'
  content?: string
  ts?: number
  agentId?: string
  agentName?: string
  dispatcherName?: string
  error?: boolean
  /** 发送后立即占位的空助手回复：流式期间吸收实时文本，结束后被最终消息替换 */
  pending?: boolean
  /** 结构化 UI 指令（<UI_RENDER> 首个合法 JSON），assistant 消息可能携带 */
  ui?: Record<string, unknown>
  /** 子 Agent 核心产物；有值时正文不直接展示，改为文件入口 */
  artifacts?: ArtifactItem[]
  /** 同一时间内的稳定排序：助手回复 1，产物卡片 2 */
  rank?: number
  seq?: number
}

const examplePrompts = [
  '分析 Oracle 业务库的慢查询并给出优化建议',
  '梳理前端页面展示与布点方案，输出页面展示改动',
  '梳理下单入口与拆单调度规则，输出代码改动清单',
]

const skillGroups = [
  {
    label: '跨工程迭代类',
    skills: ['页面展示', '下单拆单', '订单受理', '规则配置'],
  },
  {
    label: 'SQL & 分析类',
    skills: ['慢查询分析', '执行计划解读', 'SQL优化建议', '索引推荐'],
  },
]

function artifactFileName(item: ArtifactItem) {
  return item.path?.split('/').pop() || item.object_name || `产物 ${item.id}`
}

function timelineToDisplayItems(timeline: TimelineItem[]): DisplayItem[] {
  const finishedAgents = new Set(
    timeline
      .filter(it => it.kind === 'system'
        && isFinishedAgentTrace(it.ev as SystemEvent as unknown as Record<string, unknown>))
      .map(it => (it.ev as SystemEvent).agent_id || '')
  )
  const hasFinishedAgent = finishedAgents.size > 0
  return timeline.flatMap<DisplayItem>(it => {
    if (it.kind === 'system') {
      const ev = it.ev as SystemEvent
      if (ev.event === 'calling_agent') {
        const finished = ev.agent_id
          ? finishedAgents.has(ev.agent_id)
          : hasFinishedAgent
        if (finished) return []
      }
      return [{ kind: 'system' as const, content: ev.message || '', agentId: ev.agent_id }]
    }
    const sa = it.ev as SubAgentEvent
    return [{
      kind: 'sub_agent' as const,
      content: sa.artifacts?.length ? '' : (sa.reply || (sa.error ? `❌ ${sa.error}` : '（无返回内容）')),
      agentId: sa.agent_id,
      agentName: sa.agent_name,
      dispatcherName: sa.dispatcher_name,
      error: !!sa.error,
      artifacts: sa.artifacts || [],
      rank: sa.artifacts?.length ? 2 : undefined,
    }]
  })
}

export function ChatView({ convId, onRefreshArtifacts, activeAgent, setActiveAgent, quickMode = false, onConvertToProject, onBackToTask, agentList, initialMessage, onInitialMessageConsumed }: ChatViewProps) {
  // 使用后端智能体列表，如果未提供则降级为内置列表
  const agents = agentList && agentList.length > 0 ? agentList : builtinAgents
  const selectedWorkspaceAgent = agents.find(item => item.id === activeAgent) as Agent | undefined
  const [items, setItems] = useState<DisplayItem[]>([])
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0)
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceFileRequest | null>(null)
  const pendingMsgRef = useRef<string | null>(null)
  const activeAgentRef = useRef(activeAgent)
  const { streaming, assistantText, steps, timeline, timelineRef, uiRenderRef, migrateState, send, stop } = useChatStream()
  /** 跨工程迭代状态机进度：当前阶段在可编排流程中的位置 */
  const boardStages = useMigrateBoardStages()
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedConvRef = useRef<number | null>(null)
  const initialCommandRef = useRef<string | null>(null)
  const dispatchedCommandRef = useRef<string | null>(null)
  /** 跨工程迭代任务详情（用于状态机看板展示） */
  const [migrateDetail, setMigrateDetail] = useState<MigrateTaskDetail | null>(null)
  const [drawerStage, setDrawerStage] = useState<number | null>(null)
  /** 确定性推进状态机（手动确认闸门）：请求期间禁用按钮 */
  const [advancing, setAdvancing] = useState(false)
  const [retryingStage, setRetryingStage] = useState<string | null>(null)
  /** 阶段推进/流程配置异常的应用内提示 */
  const [advanceNotice, setAdvanceNotice] = useState<string | null>(null)
  /** 状态机看板折叠：对话页默认只显示一行紧凑进度条，点击展开完整看板 */
  const [boardOpen, setBoardOpen] = useState(false)

  // 加载状态机看板：会话关联业务任务时，通过任务反查跨工程迭代任务（任务详情页同一关联链路）
  const refreshMigrateDetail = useCallback(() => {
    if (convId == null) { setMigrateDetail(null); return }
    // 先按会话绑定的业务任务查跨工程迭代任务；查不到时清空（纯对话/未发起迁移）
    api.getConversation(convId).then(cr => {
      const taskId = cr.success && cr.data?.task_id ? cr.data.task_id : null
      if (taskId == null) return
      api.getMigrateTaskByTaskId(taskId).then(r => {
        if (r.success && r.data) setMigrateDetail(r.data as MigrateTaskDetail)
      }).catch(() => {})
    }).catch(() => {})
  }, [convId])
  const migrateSocket = useMigrateStateSocket(migrateDetail?.task_id, refreshMigrateDetail)
  const liveMigrateDetail = mergeMigrateSnapshot(migrateDetail, migrateSocket.snapshot)

  useEffect(() => {
    initialCommandRef.current = initialMessage ?? null
  }, [initialMessage])

  useEffect(() => {
    setWorkspaceRefreshKey(value => value + 1)
    void refreshMigrateDetail()
  }, [refreshMigrateDetail])

  // 当迁移状态事件变化时，加载任务详情（实时推进刷新）
  useEffect(() => {
    const ev = migrateState as MigrateEvent | undefined
    if (!ev?.task_id) return
    api.getMigrateTask(ev.task_id).then(r => {
      if (r.success && r.data) setMigrateDetail(r.data as MigrateTaskDetail)
    }).catch(() => {})
  }, [migrateState])

  /** 确定并推进：手动确认闸门 → 后端状态机校验流转 → 刷新任务详情。
      携带会话 session_id 抢占执行锁，避免与工作台面板的会话锁冲突。 */
  const doAdvance = async () => {
    if (liveMigrateDetail == null) return
    setAdvancing(true)
    const r: { success?: boolean; data?: { task: MigrateTask; from: string; to: string; advanced: boolean; warning?: string }; error?: string } =
      await api.advanceMigrateTask(liveMigrateDetail.task_id, {
        task_confirm: '继续',
        session_id: convId != null ? String(convId) : 'chat',
      }).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data?.task) {
      setMigrateDetail(r.data.task as MigrateTaskDetail)
      if (!r.data.advanced) {
        setAdvanceNotice(r.data.warning || '当前阶段还不能推进：请先补齐本阶段必填信息，或等待当前智能体执行完成。')
      } else {
        if (r.data.warning) setAdvanceNotice(r.data.warning)
        // 状态机只负责跨过确认闸门；下一阶段专家通过会话流执行，且不再重复确认。
        await handleSend('开始迭代', { skip_state_advance: true }, 'jarvis_commander')
      }
    } else {
      setAdvanceNotice(r.error || '状态机推进失败')
    }
    setAdvancing(false)
  }

  /** 单节点重试：先回退状态并复位会话执行态，再由主 Agent 按当前节点重新编排。 */
  const doRetryStage = async (stage: string) => {
    if (liveMigrateDetail == null || retryingStage || advancing) return
    setRetryingStage(stage)
    try {
      const r = await api.retryMigrateTaskStage(
        liveMigrateDetail.task_id,
        stage,
        convId != null ? String(convId) : undefined,
      )
      if (!r.success || !r.data?.task) {
        setAdvanceNotice(r.error || '节点重试失败')
        return
      }
      setMigrateDetail(r.data.task as MigrateTaskDetail)
      await handleSend('开始迭代', { skip_state_advance: true }, 'jarvis_commander')
    } catch (e) {
      setAdvanceNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setRetryingStage(null)
    }
  }

  /** 切换逐级确认开关（DB 配置化）：开=每执行阶段完成停驻等确认，关=一次性编排跑完 */
  const toggleStepConfirm = async () => {
    if (liveMigrateDetail == null) return
    const next = liveMigrateDetail.step_confirm === false
    try {
      const r = await api.setMigrateStepConfirm(liveMigrateDetail.task_id, next)
      if (r.success && r.data) setMigrateDetail(r.data as MigrateTaskDetail)
    } catch { /* 静默 */ }
  }

  /** 切换流程强校验：开=严格顺序；关=允许按用户指派自由选择阶段专家 */
  const toggleStrictFlow = async () => {
    if (liveMigrateDetail == null) return
    const next = liveMigrateDetail.strict_flow !== false ? false : true
    try {
      const r = await api.setMigrateStrictFlow(liveMigrateDetail.task_id, next)
      if (r.success && r.data) setMigrateDetail(r.data as MigrateTaskDetail)
      else setAdvanceNotice(r.error || '流程强校验开关设置失败')
    } catch (e) {
      setAdvanceNotice(String(e))
    }
  }

  const [usedAgents, setUsedAgents] = useState<Set<string>>(new Set())
  const [historyReady, setHistoryReady] = useState(false)

  // 欢迎块：快捷指令 / 技能集折叠状态
  const [showQuickCmd, setShowQuickCmd] = useState(true)
  const [skillSectionOpen, setSkillSectionOpen] = useState(false)

  // 会话归属信息（任务/空间/子系统）
  const [convInfo, setConvInfo] = useState<ConversationDetail | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [spacesForConvert, setSpacesForConvert] = useState<Space[]>([])

  useEffect(() => {
    if (convId == null) { setConvInfo(null); return }
    api.getConversation(convId).then(r => { if (r.success) setConvInfo(r.data ?? null) }).catch(() => {})
  }, [convId])

  // 保持 ref 同步
  useEffect(() => {
    activeAgentRef.current = activeAgent
  }, [activeAgent])

  useEffect(() => {
    if (convId == null) {
      // 会话已删除或未打开：清空聊天区与加载标记，避免残留已删除会话的对话
      loadedConvRef.current = null
      setItems([])
      setMigrateDetail(null)
      return
    }
    if (convId === loadedConvRef.current) return
    const switchingConversation = loadedConvRef.current !== null && loadedConvRef.current !== convId
    loadedConvRef.current = convId
    if (switchingConversation) {
      pendingMsgRef.current = null
    }
    setItems([])
    setHistoryReady(false)
    Promise.all([api.getMessages(convId), api.getTrace(convId)]).then(([mr, tr]) => {
      const msgs = (mr.success ? mr.data : []) as MsgType[]
      const events = (tr.success ? tr.data : []) as TraceEvent[]
      const systemContents = events.map(ev =>
        (typeof ev.content === 'object' ? ev.content : {}) as Record<string, unknown>
      )
      const finishedAgents = new Set(
        systemContents
          .filter(content => isFinishedAgentTrace(content))
          .map(content => content.agent_id as string || '')
      )
      const hasFinishedAgent = finishedAgents.size > 0
      const assistantTimestamps = msgs
        .filter(m => m.role === 'assistant')
        .map(m => new Date(m.created_at || '').getTime())
        .filter(ts => Number.isFinite(ts))
        .sort((a, b) => a - b)
      const combined: DisplayItem[] = []
      for (const m of msgs) {
        if (m.role === 'user' || m.role === 'assistant') {
          combined.push({
            kind: 'message',
            role: m.role,
            content: m.role === 'assistant' ? stripLeadingJson(m.content || '') : m.content,
            // 历史消息的 agent_id 可能为空（旧数据），回退到当前会话的 activeAgent
            agentId: m.role === 'assistant' ? (m.agent_id || activeAgentRef.current) : undefined,
            ui: m.ui_render || undefined,
            ts: new Date(m.created_at || '').getTime(),
          })
        }
      }
      for (const ev of events) {
        const c = (typeof ev.content === 'object' ? ev.content : {}) as Record<string, unknown>
        if (ev.node === 'system') {
          if (!isVisibleSystemTrace(c)) continue
          if (c.event === 'calling_agent') {
            const finished = c.agent_id
              ? finishedAgents.has(c.agent_id as string)
              : hasFinishedAgent
            if (finished) continue
          }
          combined.push({ kind: 'system', content: (c.message as string) || '', ts: new Date(ev.created_at || '').getTime() })
        } else if (ev.node === 'agent') {
          const replyC = (c.reply as string) || ''
          const artifacts = (c.artifacts as ArtifactItem[]) || []
          const traceTs = new Date(ev.created_at || '').getTime()
          const summaryTs = assistantTimestamps.find(ts => ts >= traceTs)
          combined.push({
            kind: 'sub_agent',
            content: artifacts.length ? '' : (replyC || (c.error ? `❌ ${c.error}` : '（无返回内容）')),
            agentId: (c.agent_id as string) || ev.agent_id || undefined,
            agentName: (c.agent_name as string) || undefined,
            dispatcherName: (c.dispatcher_name as string) || undefined,
            error: !!c.error,
            artifacts,
            ts: artifacts.length && summaryTs != null ? summaryTs : traceTs,
            rank: artifacts.length ? 2 : undefined,
          })
        }
      }
      combined.forEach((item, index) => { item.seq = index })
      combined.sort((a, b) =>
        (a.ts || 0) - (b.ts || 0)
        || (a.rank ?? 0) - (b.rank ?? 0)
        || (a.seq ?? 0) - (b.seq ?? 0))
      if (pendingMsgRef.current) {
        const exists = combined.some(d => d.kind === 'message' && d.role === 'user' && d.content === pendingMsgRef.current)
        if (!exists) {
          combined.push({ kind: 'message', role: 'user', content: pendingMsgRef.current })
        }
        pendingMsgRef.current = null
      }
      setItems(combined)
      setHistoryReady(true)
    }).catch(() => {
      if (pendingMsgRef.current) {
        setItems([{ kind: 'message', role: 'user', content: pendingMsgRef.current }])
        pendingMsgRef.current = null
      } else {
        setItems([])
      }
      setHistoryReady(true)
    })
  }, [convId])

  const dispatchInitialCommand = async (message: string) => {
    if (dispatchedCommandRef.current === message) return
    dispatchedCommandRef.current = message
    await handleSend(message)
    onInitialMessageConsumed?.()
  }

  // 初次进入由工作台创建的会话时，等待历史加载完成后自动下达指令
  useEffect(() => {
    const message = initialCommandRef.current
    if (convId == null || !message || !historyReady || loadedConvRef.current !== convId) return
    void dispatchInitialCommand(message)
  }, [convId, initialMessage, historyReady])

  // 自动贴底跟随：依赖需包含 timeline/streaming（流式期间子 Agent 事件与系统事件也会撑高内容）。
  // 用双 rAF 确保 Radix Viewport 内部布局完成后再设置 scrollTop，避免在内容尚未布局时贴底失效。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    return () => cancelAnimationFrame(id)
  }, [items, assistantText, steps, timeline, streaming])

  const handleSend = async (text: string, extra?: SendExtra, agentOverride?: string) => {
    let cid = convId
    const runAgentId = agentOverride || activeAgentRef.current
    setUsedAgents(prev => new Set(prev).add(runAgentId))
    // 用户消息后立即占位一条空回复（带头像）：发送后马上在下方出现新的助手头像 + 转圈，
    // 而不是等首个 Token 返回才出现回复块
    setItems([
      { kind: 'message', role: 'user', content: text },
      { kind: 'message', role: 'assistant', content: '', agentId: runAgentId, pending: true },
    ])

    // 如果 convId 为 null，说明当前不在有效会话中，不应在此处创建新会话
    // （新建任务时应通过 onConvCreated 回调处理）
    if (cid == null) {
      console.warn('handleSend called with null convId - this should not happen in ChatView')
      setItems(prev => prev.filter(i => !(i.kind === 'message' && i.pending)))
      return
    }

    try {
      const fullText = await send(text, cid, runAgentId, extra)
      // 流结束后：移除占位回复条目，把本次运行产生的系统事件 / 子 Agent 输出补入当前会话视图
      // （已由后端写入 trace，刷新后仍会恢复；此处保证流结束后即时可见）
      const committedItems = timelineToDisplayItems(timelineRef.current)
      const runItems = committedItems.filter(it => !(it.kind === 'sub_agent' && it.artifacts?.length))
      const artifactItems = committedItems.filter(it => it.kind === 'sub_agent' && !!it.artifacts?.length)
      setItems(prev => {
        const next: DisplayItem[] = [...prev.filter(i => !(i.kind === 'message' && i.pending)), ...runItems]
        if (fullText) {
          // 携带本轮的 UI 指令（若有）供表单组件渲染
          next.push({
            kind: 'message',
            role: 'assistant',
            content: fullText,
            agentId: activeAgentRef.current,
            ui: uiRenderRef.current || undefined,
          })
        }
        next.push(...artifactItems)
        return next
      })
    } catch (e) {
      console.error('Send failed:', e)
      setItems(prev => [
        ...prev.filter(i => !(i.kind === 'message' && i.pending)),
        { kind: 'message', role: 'assistant', content: `❌ 发送失败：${e instanceof Error ? e.message : String(e)}`, error: true },
      ])
    }
    void refreshMigrateDetail()
    onRefreshArtifacts()
  }

  /** UI 表单提交：把表单值组装为用户消息回传会话 */
  const handleUiAction = (values: Record<string, unknown>) => {
    const text = Object.entries(values)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}：${typeof v === 'boolean' ? (v ? '是' : '否') : String(v)}`)
      .join('\n')
    if (text) handleSend(text)
  }

  /** 从回复中的 path/path:line 引用打开实际工程文件；消息可来自子 Agent，因此按消息 Agent 优先解析。 */
  const handleOpenWorkspaceFile = async (messageAgentId: string | undefined, path: string, line?: number) => {
    const candidates = [
      messageAgentId,
      activeAgent,
      ...agents.map(item => item.id),
    ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index)
    for (const agentId of candidates) {
      const result = await api.agentWorkspaceFile(agentId, path).catch(() => null)
      if (result?.success) {
        setActiveAgent(agentId)
        setWorkspaceOpenRequest({
          agentId, path, line, requestId: Date.now(),
        })
        return
      }
    }
  }

  // 占位的空回复条目：流式期间提到列表末尾（子 Agent / 系统事件在其上方，符合实际时序），
  // 并就地吸收实时文本避免出现两个回复块；非流式期间兜底丢弃可能残留的占位条目
  const liveItems: DisplayItem[] = []
  let pendingItem: DisplayItem | null = null
  for (const it of items) {
    if (it.kind === 'message' && it.pending && it.role === 'assistant') {
      if (streaming) pendingItem = { ...it, content: it.content || assistantText }
      continue
    }
    liveItems.push(it)
  }
  if (streaming && timeline.length > 0) {
    liveItems.push(...timelineToDisplayItems(timeline))
  }
  if (pendingItem) {
    liveItems.push(pendingItem)
  } else if (streaming && assistantText) {
    liveItems.push({ kind: 'message', role: 'assistant', content: assistantText, agentId: activeAgent })
  }

  const showWelcome = convId == null && items.length === 0 && !pendingMsgRef.current

  const hasAnyError = steps.some(s => s.type === 'error')

  // 占位回复的加载文案：反映当前实际阶段（来自时间线最后一条事件或步骤），而非干巴巴的"正在生成回复"
  let loadingHint = ''
  if (streaming) {
    if (timeline.length > 0) {
      const last = timeline[timeline.length - 1]
      if (last.kind === 'system') {
        loadingHint = (last.ev as SystemEvent).message || ''
      } else {
        const sa = last.ev as SubAgentEvent
        loadingHint = sa.agent_name ? `${sa.agent_name} 执行中…` : '子 Agent 执行中…'
      }
    } else if (steps.length > 0) {
      const s = steps[steps.length - 1]
      const stepHint: Record<string, string> = {
        parse: '识别意图…', route: '路由分发…', skill: '调用技能…',
        agent: '调用子 Agent…', artifact: '生成产物…', error: '处理失败',
      }
      loadingHint = stepHint[s.type] || '处理中…'
    }
  }

  // ===== Tab 状态标识 =====
  const tabStatus: Record<string, AgentTabStatus> = {}
  for (const a of agents) {
    if (a.id === activeAgent && hasAnyError) tabStatus[a.id] = 'failed'
    else if (streaming && a.id === activeAgent) tabStatus[a.id] = 'executing'
    else if (usedAgents.has(a.id)) tabStatus[a.id] = 'done'
    else tabStatus[a.id] = 'idle'
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* 智能体标签栏：用户可直接指派，流式期间锁定 */}
      <AgentTabs
        active={activeAgent}
        status={tabStatus}
        agents={agentList}
        onChange={setActiveAgent}
        disabled={streaming}
      />

      {/* 顶部综合信息栏：任务归属 + 迁移进度 一行（智能体标签栏保持不变） */}
      {(convInfo || liveMigrateDetail) && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[#1e1e28] bg-[#11141d]">
          {/* 左：任务/会话归属 */}
          {convInfo && (quickMode ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 whitespace-nowrap">
                <Zap className="w-3 h-3" />快速问答 · 临时会话
              </span>
              <span className="text-[11px] text-[#5a5a70] whitespace-nowrap hidden lg:inline">产物仅本地可用，不入库</span>
              <button
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10 transition-colors whitespace-nowrap"
                onClick={() => {
                  if (spacesForConvert.length === 0) {
                    api.listSpaces().then(r => { if (r.success) setSpacesForConvert(r.data || []) }).catch(() => {})
                  }
                  setConvertOpen(true)
                }}
              >
                <ChevronsUpDown className="w-3 h-3" />转为项目会话
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              {convInfo.task_name ? (
                <button
                  onClick={onBackToTask}
                  disabled={!onBackToTask}
                  title={onBackToTask ? '返回任务详情' : '该会话来源不包含任务详情入口'}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 transition-colors whitespace-nowrap',
                    onBackToTask && 'hover:bg-indigo-500/20 hover:border-indigo-500/40 cursor-pointer'
                  )}
                >
                  <Link2 className="w-3 h-3" />任务：{convInfo.task_name}
                  {onBackToTask && <ArrowLeft className="w-3 h-3" />}
                </button>
              ) : (
                <button onClick={() => setAttachOpen(true)}
                  className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md border border-[#252530] text-[#9a9aa4] hover:text-indigo-400 whitespace-nowrap">
                  <Link2 className="w-3 h-3" />另存为任务
                </button>
              )}
              {convInfo.space_name && (
                <span className="text-[11px] text-[#5a5a70] whitespace-nowrap truncate max-w-[220px]">
                  {convInfo.space_name}
                </span>
              )}
            </div>
          ))}
          {/* 右：迁移进度 + 推进按钮 */}
          {liveMigrateDetail && (
            <div className="flex items-center gap-3 ml-auto min-w-0 shrink-0">
              <button
                className="flex items-center gap-2 min-w-0 text-left group"
                onClick={() => setBoardOpen(o => !o)}
                title={boardOpen ? '收起状态机看板' : '展开状态机看板（8 步流程，点击节点看阶段详情）'}
              >
                <Workflow className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="text-[11px] font-medium text-indigo-300 whitespace-nowrap">
                  {boardStages[effectiveIdx(liveMigrateDetail, boardStages)]?.label || '—'}
                  <span className="text-[#5a5a70] font-normal"> · {effectiveIdx(liveMigrateDetail, boardStages) + 1}/{boardStages.length}</span>
                </span>
                <div className="flex gap-0.5 max-w-[120px] min-w-[50px]">
                  {boardStages.map((s, i) => {
                    const st = liveMigrateDetail.status === 'ERROR'
                      ? (i < effectiveIdx(liveMigrateDetail, boardStages) ? 'done' : i === effectiveIdx(liveMigrateDetail, boardStages) ? 'error' : 'pending')
                      : (i < effectiveIdx(liveMigrateDetail, boardStages) || (
                          i === effectiveIdx(liveMigrateDetail, boardStages)
                          && currentStageExecutionDone(liveMigrateDetail, boardStages)
                        ) ? 'done' : i === effectiveIdx(liveMigrateDetail, boardStages) ? 'current' : 'pending')
                    return (
                      <span key={s.keys[0]} className={cn('h-1.5 flex-1 rounded-full transition-colors',
                        st === 'done' ? 'bg-green-500/70'
                          : st === 'current' ? 'bg-indigo-400'
                            : st === 'error' ? 'bg-red-500'
                              : 'bg-[#23232e]')} />
                    )
                  })}
                </div>
                <ChevronDown className={cn('w-3.5 h-3.5 text-[#5a5a70] shrink-0 transition-transform', boardOpen && 'rotate-180')} />
              </button>
              {(() => {
                const scOn = liveMigrateDetail.step_confirm !== false
                return (
                  <div
                    className="flex items-center gap-1.5 shrink-0"
                    title={scOn
                      ? '逐级确认已开启：每个执行阶段完成后停驻，等你说「继续」再进下一级'
                      : '逐级确认已关闭：确认一次后自动编排跑完所有执行阶段'}
                  >
                    <span className="text-[11px] text-[#9a9aa4]">逐级确认</span>
                    <button
                      className={cn('relative w-7 h-4 rounded-full transition-colors shrink-0', scOn ? 'bg-indigo-500' : 'bg-[#2a2a35]')}
                      onClick={toggleStepConfirm}
                    >
                      <div className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform', scOn ? 'left-3.5' : 'left-0.5')} />
                    </button>
                    <span className={cn('text-[10px] w-4 shrink-0', scOn ? 'text-indigo-400' : 'text-[#5a5a70]')}>{scOn ? '开' : '关'}</span>
                  </div>
                )
              })()}
              {(() => {
                const strictOn = liveMigrateDetail.strict_flow !== false
                return (
                  <div
                    className="flex items-center gap-1.5 shrink-0"
                    title={strictOn
                      ? '流程强校验已开启：只能按页面展示→下单拆单→订单受理→规则配置→客户数据的顺序执行'
                      : '流程强校验已关闭：可直接指派任意阶段专家执行，不强制前序阶段完成'}
                  >
                    <span className="text-[11px] text-[#9a9aa4]">流程强校验</span>
                    <button
                      className={cn('relative w-7 h-4 rounded-full transition-colors shrink-0', strictOn ? 'bg-indigo-500' : 'bg-[#2a2a35]')}
                      onClick={toggleStrictFlow}
                    >
                      <div className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform', strictOn ? 'left-3.5' : 'left-0.5')} />
                    </button>
                    <span className={cn('text-[10px] w-4 shrink-0', strictOn ? 'text-indigo-400' : 'text-[#5a5a70]')}>{strictOn ? '开' : '关'}</span>
                  </div>
                )
              })()}
              {(() => {
                const errored = liveMigrateDetail.status === 'ERROR'
                const lockBusy = !!liveMigrateDetail.exec_lock?.locked
                const nextIdx = effectiveIdx(liveMigrateDetail, boardStages) + 1
                const nextStage = nextIdx < boardStages.length ? boardStages[nextIdx] : null
                const canAdvance = !!nextStage && !errored && liveMigrateDetail.status !== 'FINISHED' && !lockBusy
                if (!canAdvance) return null
                return (
                  <button
                    className="flex items-center gap-1 text-[11px] px-2.5 h-7 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white shrink-0 transition-colors disabled:opacity-50"
                    onClick={doAdvance}
                    disabled={advancing}
                    title="手动确认后由后端状态机校验推进（不可跳转）"
                  >
                    <Play className="w-3 h-3" />{advancing ? '推进中…' : `推进到「${nextStage.label}」`}
                  </button>
                )
              })()}
            </div>
          )}
        </div>
      )}
      {boardOpen && liveMigrateDetail && (
        <div className="px-4 py-2 border-b border-[#1e1e28] bg-[#11141d]">
          <StateBoard detail={liveMigrateDetail} onOpenStage={setDrawerStage} onAdvance={doAdvance} advancing={advancing} onRetryStage={doRetryStage} retryingStage={retryingStage} />
        </div>
      )}

      {/* 快速问答 → 项目会话 */}
      <ConvertToProjectDialog
        open={convertOpen}
        spaces={spacesForConvert}
        onClose={() => setConvertOpen(false)}
        onConfirm={async (sid) => {
          setConvertOpen(false)
          await onConvertToProject?.(sid)
          // 转换成功后刷新会话归属信息（空间名）
          if (convId != null) {
            api.getConversation(convId).then(r => { if (r.success) setConvInfo(r.data ?? null) }).catch(() => {})
          }
        }}
      />

      {advanceNotice && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
          onClick={() => setAdvanceNotice(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="advance-notice-title"
            className="w-full max-w-[380px] overflow-hidden rounded-lg border border-[#2a2a38] bg-[#15151d] shadow-[0_24px_70px_rgba(0,0,0,0.45)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-5 pt-5 pb-4">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-500/25 bg-amber-500/10">
                <CircleAlert className="h-4 w-4 text-amber-400" />
              </span>
              <div className="min-w-0">
                <h3 id="advance-notice-title" className="text-[14px] font-semibold text-[#f0f0f4]">
                  阶段推进提示
                </h3>
                <p className="mt-1.5 text-[12px] leading-5 text-[#a5a5b2]">
                  {advanceNotice}
                </p>
              </div>
            </div>
            <div className="flex justify-end border-t border-[#242430] bg-black/20 px-5 py-3">
              <button
                className="h-8 rounded-md border border-[#31313d] bg-[#1d1d27] px-3 text-[12px] text-[#d8d8e2] transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-indigo-200"
                onClick={() => setAdvanceNotice(null)}
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0">
          <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
            {showWelcome ? (
              <div className="flex flex-col items-center px-8 pt-12 pb-4">
                {/* 标题徽章 */}
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[13px] mb-4">
                  <Sparkles className="w-4 h-4" />
                  跨工程迭代开发多Agent智能编排平台
                </div>
                <p className="text-[13px] text-[#6a6a7a] mb-1">你可以选择下方技能，或者直接输入你的需求</p>

                {/* 快捷指令标题 + 收起 */}
                <div className="w-full max-w-3xl flex items-center gap-2 mb-3 px-1">
                  <span className="text-[12px] text-[#5a5a70]">快捷指令</span>
                  <button
                    className="ml-auto flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                    onClick={() => setShowQuickCmd(!showQuickCmd)}
                    title={showQuickCmd ? '收起快捷指令' : '展开快捷指令'}
                  >
                    {showQuickCmd ? '收起' : '展开'}
                    <ChevronDown className={cn('w-3 h-3 transition-transform', !showQuickCmd && 'rotate-180')} />
                  </button>
                </div>

                {/* 快捷指令卡片（横向 3 列） */}
                {showQuickCmd && (
                  <div className="w-full max-w-3xl grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-8">
                    {examplePrompts.map((prompt, i) => (
                      <button
                        key={i}
                        className="w-full text-left px-3.5 py-3 rounded-xl bg-[#16161e] border border-[#252530] text-[12px] leading-snug text-[#cdd3e0] hover:border-indigo-500/30 hover:bg-indigo-500/5 transition-all flex items-start justify-between gap-2"
                        onClick={() => handleSend(prompt)}
                      >
                        <span className="flex items-start gap-1.5">{prompt}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-[#5a5a70] shrink-0 mt-px" />
                      </button>
                    ))}
                  </div>
                )}

                {/* 技能集（默认折叠，展开后展示两组技能） */}
                <div className="w-full max-w-3xl">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <span className="text-[12px] text-[#5a5a70]">技能集</span>
                    <button
                      className="ml-auto flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                      onClick={() => setSkillSectionOpen(!skillSectionOpen)}
                      title={skillSectionOpen ? '收起技能集' : '展开技能集'}
                    >
                      {skillSectionOpen ? '收起' : '展开'}
                      <ChevronDown className={cn('w-3 h-3 transition-transform', skillSectionOpen && 'rotate-180')} />
                    </button>
                  </div>
                  {skillSectionOpen && (
                    <div className="space-y-5">
                      {skillGroups.map((group, gi) => (
                        <div key={gi}>
                          <div className="text-[12px] text-[#5a5a70] mb-2.5 px-1">{group.label}</div>
                          <div className="flex flex-wrap gap-2">
                            {group.skills.map(skill => (
                              <button
                                key={skill}
                                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] transition-all border bg-[#16161e] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0] hover:border-[#3a3a45]"
                                onClick={() => handleSend(`使用「${skill}」技能帮我处理跨工程迭代任务`)}
                              >
                                {skill}
                                <ChevronDown className="w-3 h-3 opacity-40" />
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // 与输入框（max-w-3xl mx-auto）对齐，避免消息拉满全屏宽而输入框窄一截
              <div className="flex flex-col p-6 max-w-3xl mx-auto w-full">
                {liveItems.map((item, i, arr) => {
                  if (item.kind === 'system') {
                    return <Message key={i} role="system" content={item.content || ''} />
                  }
                  if (item.kind === 'sub_agent') {
                    if (item.artifacts?.length) {
                      return (
                        <div key={i} className="flex flex-col gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2.5">
                          <div className="flex items-center gap-2 text-[12px] text-[#cdd3e0]">
                            <FileText className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                            <span className="font-medium">{item.agentName || '子智能体'}已生成核心产物</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {item.artifacts.map(file => (
                              <span
                                key={file.id}
                                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-indigo-500/25 bg-[#12121a] px-2 py-1 text-[11px] text-indigo-300"
                              >
                                <FileText className="w-3 h-3 shrink-0" />
                                <span className="truncate">{artifactFileName(file)}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )
                    }
                    return (
                      <Message
                        key={i}
                        role="assistant"
                        content={item.content || ''}
                        agentName={item.agentName}
                        dispatcherName={item.dispatcherName}
                        isSubAgent
                        error={item.error}
                        isStreaming={false}
                        onOpenWorkspaceFile={location => handleOpenWorkspaceFile(item.agentId, location.path, location.line)}
                      />
                    )
                  }
                  // 只有最后一条 assistant 消息才显示"正在生成回复"转圈
                  const isLastAssistant = item.role === 'assistant' &&
                    arr.slice(i + 1).every(n => n.role !== 'assistant')
                  return (
                    <Message
                      key={i}
                      role={item.role!}
                      content={item.content || ''}
                      agentId={item.agentId}
                      agents={agents}
                      // 假的 processingTime=11 已移除（后端无真实计量，避免每条都显示"已回复 11s"误导）
                      isStreaming={streaming && isLastAssistant}
                      // 占位加载阶段反映当前实际进度（如"评估专家 执行中…"），让用户感知到正在干活
                      loadingText={streaming && isLastAssistant ? loadingHint : undefined}
                      uiData={item.ui}
                      onUiAction={handleUiAction}
                      onOpenWorkspaceFile={location => handleOpenWorkspaceFile(item.agentId, location.path, location.line)}
                    />
                  )
                })}
              </div>
            )}
          </ScrollArea>

          {/* 输入区：放在聊天列内部，与消息列表（max-w-3xl mx-auto）在同一容器居中。
              原先放在「聊天列 + 产物面板」整体下方居中，导致输入框相对消息区向右偏移半个产物面板宽度 */}
          <div className="w-full bg-[#0f0f14] flex-shrink-0 flex justify-center">
            <Composer onSend={handleSend} onStop={stop} disabled={streaming} activeAgent={activeAgent} convId={convId} spaceId={convInfo?.space_id ?? null} agentList={agentList} currentStage={liveMigrateDetail?.status_label} />
          </div>
        </div>
        <WorkspacePanel
          agent={selectedWorkspaceAgent}
          convId={convId}
          refreshKey={workspaceRefreshKey}
          openFileRequest={workspaceOpenRequest}
          onOpenFileRequestConsumed={() => setWorkspaceOpenRequest(null)}
        />
      </div>
      {attachOpen && (
        <AttachTaskDialog
          open
          onClose={() => setAttachOpen(false)}
          convId={convId}
          spaceId={convInfo?.space_id ?? undefined}
          onAttached={(d) => { setAttachOpen(false); setConvInfo(prev => prev ? { ...prev, task_id: d.task_id, task_name: d.task_name } : prev) }}
        />
      )}
      {/* 阶段详情抽屉（点击状态机节点弹出） */}
      {liveMigrateDetail && drawerStage != null && (
        <StageDrawer detail={liveMigrateDetail} stageIdx={drawerStage} onClose={() => setDrawerStage(null)} />
      )}
    </div>
  )
}
