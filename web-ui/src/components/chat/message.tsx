import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mentionTextRenderer } from './md-highlight'
import { Copy, Check, Bot, Clock, Search, ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import type { ChatStep } from '@/hooks/use-chat-stream'
import { UiForm } from './ui-form'
import { agentDisplayName } from './agent-tabs'
import { parseFileLocation } from '@/lib/file-location'

/* 提取代码块纯文本 */
function extractCodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (typeof node === 'object') {
    const anyNode = node as { props?: { children?: unknown } }
    if (anyNode.props && anyNode.props.children != null) return extractCodeText(anyNode.props.children)
  }
  return ''
}

/* 表单回传参数键 → 中文标签（仅用于用户气泡展示层翻译；发送文本保持原始键顶格，
 * 后端 app.py 的 _TS_PARAM_RE 依赖行首的 source_data_id/task_confirm 等键名解析状态机参数） */
const USER_KEY_LABELS: Record<string, string> = {
  source_data_id: '源数据源',
  target_data_id: '目标数据源',
  source_db: '源数据库',
  target_db: '目标数据库',
  datasource: '数据源',
  task_confirm: '跨工程迭代任务确认',
}

/** 用户消息里常见的提交值（来自 UI 表单对象的 value 字段）翻译为中文显示。
 *  例如 task_confirm：confirm → 跨工程迭代任务确认：确认，避免气泡里出现 "confirm" 这种机器码。 */
const USER_VALUE_LABELS: Record<string, string> = {
  confirm: '确认', yes: '是', no: '否',
  cancel: '取消', modify: '修改', edit: '修改', back: '返回',
  redo: '重新选择', reselect: '重新选择',
}

/** 把用户消息里的 "task_confirm：confirm" 等机器键值对翻译为 "跨工程迭代任务确认：确认"。
 *  支持多行（每行一个 key：value），仅翻译已知 key 与已知 value，未命中原样保留。 */
function prettifyUserEcho(content: string): string {
  return (content || '').replace(/^([A-Za-z][A-Za-z0-9_]*)\s*[:：]\s*(.+)$/gm, (m, k: string, v: string) => {
    const keyLabel = USER_KEY_LABELS[k.toLowerCase()]
    if (!keyLabel) return m
    const vTrim = v.trim()
    const valLabel = USER_VALUE_LABELS[vTrim.toLowerCase()]
    return `${keyLabel}：${valLabel || vTrim}`
  })
}

interface AgentInfo {
  id: string
  name: string
  color?: string
}

interface MessageProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  agentId?: string
  /** 实际展示的 Agent 名称（主 Agent 用选中智能体名，子 Agent 用后端下发的 agent_name） */
  agentName?: string
  /** 子 Agent 溯源：由哪个 Agent 调度发起 */
  dispatcherName?: string
  /** 是否子 Agent 输出消息（蓝色头像样式） */
  isSubAgent?: boolean
  /** 子 Agent 执行失败 */
  error?: boolean
  agents?: AgentInfo[]
  steps?: ChatStep[]
  isStreaming?: boolean
  /** 加载阶段文案（来自当前执行阶段，如"评估专家 执行中…"）；默认"智能体正在生成回复…" */
  loadingText?: string
  /** 结构化 UI 指令（<UI_RENDER> 首个合法 JSON）：非空时在正文上方渲染表单组件 */
  uiData?: Record<string, unknown>
  /** UI 表单提交回调：把表单值回传给会话（未提供时表单仅本地展示） */
  onUiAction?: (values: Record<string, unknown>) => void
  /** 点击正文中的 file/path:line 引用时，把文件位置交给右侧工作区打开 */
  onOpenWorkspaceFile?: (location: { path: string; line?: number }) => void
}

export function Message({ role, content, agentId, agentName, dispatcherName, isSubAgent, error, agents, steps, isStreaming, loadingText, uiData, onUiAction, onOpenWorkspaceFile }: MessageProps) {
  const [copied, setCopied] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [expandedThinking, setExpandedThinking] = useState(true)
  const agent = agents?.find(a => a.id === agentId)

  /* 代码块：一键复制 / 下载 */
  const copyCode = async (codeText: string) => {
    await navigator.clipboard.writeText(codeText)
    setCodeCopied(true)
    setTimeout(() => setCodeCopied(false), 1500)
  }

  const downloadCode = (codeText: string, className?: string) => {
    const lang = (className || '').replace('language-', '')
    const ext = lang === 'sql' ? 'sql' : lang === 'bash' || lang === 'shell' ? 'sh' : 'txt'
    const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `code-block.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (role === 'system') {
    // 系统事件：无头像，灰色弱化文字 + 极浅暗色背景块，不属于任何 Agent 发言
    return (
      <div className="flex justify-center mb-3">
        <div className="inline-flex items-start gap-1.5 max-w-[85%] px-3.5 py-2 rounded-lg bg-[#12121a] border border-[#1e1e28]">
          <span className="text-[11px] text-[#5a5a70] shrink-0 select-none">【系统】</span>
          <span className="text-[12px] text-[#7d7d8e] leading-relaxed whitespace-pre-wrap break-words">{content}</span>
        </div>
      </div>
    )
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 用户消息 - 右上角带标签样式
  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="flex items-center gap-2 bg-[#2a2a35] rounded-2xl rounded-tr-sm px-4 py-2 max-w-[80%]">
          {agent && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
              style={{ backgroundColor: (agent.color || '#6366f1') + '20', color: agent.color || '#6366f1' }}
            >
              <Clock className="w-3 h-3" />
              {agentDisplayName(agent as { name?: string; alias?: string })}
            </span>
          )}
          <span className="text-[14px] text-[#e4e4e9] whitespace-pre-wrap break-words">{prettifyUserEcho(content)}</span>
        </div>
      </div>
    )
  }

  // AI 回复：主 Agent（紫色头像氛围） / 子 Agent（蓝色头像，带调度溯源）
  // 展示名统一以 agent 表（/api/agents 返回的 agents 列表）为准，agentName 仅作后端下发时的优先来源
  const displayName = (isSubAgent
    ? (agentDisplayName(agent as { name?: string; alias?: string } | null) || agentName || '子 Agent')
    : (agentDisplayName(agent as { name?: string; alias?: string } | null) || agentName || '智能体'))
  const headerCls = isSubAgent
    ? 'bg-gradient-to-br from-sky-500 to-blue-600'
    : 'bg-gradient-to-br from-indigo-500 to-purple-600'

  // 防御：正文中若仍残留 <UI_RENDER>/<TASK_STATE> 指令块（正常已被后端剥离），一律隐藏，
  // 避免与下方表单重复展示（一个消息气泡只保留一个 UI 表单）
  const shownContent = (content || '')
    .replace(/<(UI_RENDER|TASK_STATE)>[\s\S]*?<\/(UI_RENDER|TASK_STATE)>/gi, '')
    .replace(/\n{3,}/g, '\n\n')

  return (
    <div className="mb-6">
      {/* 头部信息：头像 + Agent 名称（子 Agent 带调度溯源小字） */}
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-6 h-6 rounded-full ${headerCls} flex items-center justify-center`}>
          <span className="text-[10px] font-bold text-white">
            {(displayName || '智')[0]}
          </span>
        </div>
        <span className="text-[13px] font-semibold text-[#e4e4e9]">{displayName}</span>
        {isSubAgent && dispatcherName && (
          <span className="text-[11px] text-[#6d6d80]">由【{dispatcherName}】调度发起</span>
        )}
        {isSubAgent && error && (
          <span className="text-[11px] text-red-400">执行失败</span>
        )}
      </div>

      {/* 深度思考区域 */}
      {steps && steps.length > 0 && (
        <div className="ml-8 mb-3">
          <button
            className="flex items-center gap-1.5 text-[13px] text-[#e4e4e9] mb-2 hover:text-indigo-400 transition-colors"
            onClick={() => setExpandedThinking(!expandedThinking)}
          >
            {expandedThinking ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            深度思考
          </button>

          {expandedThinking && (
            <div className="space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="text-[12px] text-[#8b8b9e] flex items-center gap-1.5">
                  {step.type === 'parse' && <Search className="w-3 h-3" />}
                  {step.type === 'route' && <Bot className="w-3 h-3" />}
                  {step.type === 'skill' && <Clock className="w-3 h-3" />}
                  <span>
                    {step.type === 'parse' && '识别意图'}
                    {step.type === 'route' && '路由'}
                    {step.type === 'skill' && '调用技能'}
                    {step.type === 'artifact' && '产物'}
                  </span>
                  {typeof step.content === 'object' && step.content && (
                    <span className="text-[#8b8b9e]">
                      {step.type === 'parse' && (step.content as any).intent && ` · 意图: ${(step.content as any).intent}`}
                      {step.type === 'route' && (step.content as any).agent_id && ` · ${(step.content as any).agent_id}`}
                      {step.type === 'skill' && (step.content as any).skill_id && ` · ${(step.content as any).skill_id}`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 加载状态：仅在新回复块还没有任何内容时显示（头像下方转圈）；
          内容开始输出后隐藏，进度由流式内容本身体现，避免转圈一直挂在正文上方。
          loadingText 反映当前实际阶段（如"评估专家 执行中…"），让用户感知到正在干活 */}
      {isStreaming && !(content || '').trim() && (
        <div className="ml-8 mb-3 flex items-center gap-1.5 text-[12px] text-[#8b8b9e]">
          <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />
          {loadingText || '智能体正在生成回复…'}
        </div>
      )}

      {/* 回复内容：普通文本在上，结构化 UI 表单（若有）在下方（与「请从下方选择」文案一致） */}
      <div className="ml-8">
        <div className="prose prose-sm max-w-none text-[14px] text-[#e4e4e9]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              text: mentionTextRenderer,
              code(props: any) {
                const { node, className, children, ...rest } = props
                const text = extractCodeText(children)
                const isBlock = Boolean(className) || text.includes('\n')
                const location = isBlock ? null : parseFileLocation(text)
                if (!location) {
                  return <code {...rest} className={className}>{children}</code>
                }
                return (
                  <button
                    type="button"
                    className="rounded-md border border-cyan-500/20 bg-[#1a1a24] px-1.5 py-0.5 font-mono text-[12.5px] text-cyan-300 transition-colors hover:border-sky-400/40 hover:bg-sky-500/10 hover:text-sky-200"
                    title={location.line ? `${location.path}:${location.line}` : location.path}
                    onClick={() => onOpenWorkspaceFile?.(location)}
                  >
                    {text}
                  </button>
                )
              },
              pre(props: any) {
                const { node, children, ...rest } = props
                const lang = (props?.className || (node?.properties?.className as string | undefined) || '') || ''
                const codeText = extractCodeText(children).replace(/\n$/, '')
                return (
                  <div className="relative group/code my-3">
                    <pre {...rest} className="text-[12.5px] leading-relaxed bg-[#12121a] border border-[#252530] rounded-lg p-4 pt-9 overflow-x-auto">
                      {children}
                    </pre>
                    <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/code:opacity-100 transition-opacity">
                      <button
                        className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a24] border border-[#252530] text-[#9a9aa4] hover:text-cyan-400 transition-colors"
                        onClick={() => downloadCode(codeText, lang)}
                        title="下载代码文件"
                      >
                        <Download className="w-2.5 h-2.5" />
                        下载
                      </button>
                      <button
                        className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a24] border border-[#252530] text-[#9a9aa4] hover:text-indigo-400 transition-colors"
                        onClick={() => copyCode(codeText)}
                        title="复制代码"
                      >
                        {codeCopied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
                        {codeCopied ? '已复制' : '复制'}
                      </button>
                    </div>
                  </div>
                )
              },
            }}
          >
            {shownContent}
          </ReactMarkdown>
        </div>

        {/* UI 表单：置于正文之后（配合「请从下方选择」类引导文案），每个气泡仅渲染一个 */}
        {uiData && Object.keys(uiData).length > 0 && (
          <UiForm data={uiData} onAction={onUiAction} />
        )}

        {/* 底部状态：流式期间显示生成提示；复制按钮移至最右侧 */}
        <div className="flex items-center justify-between gap-2 mt-2.5">
          <div className="flex items-center gap-2 text-[10px] text-[#5a5a70]">
            {isStreaming && <span>生成回复中</span>}
          </div>
          <button
            className="flex items-center gap-1 text-[10px] text-[#5a5a70] hover:text-indigo-400 transition-colors shrink-0"
            onClick={handleCopy}
            title="复制回复内容"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
    </div>
  )
}

const stepConfig: Record<string, { label: string; color: string }> = {
  parse: { label: '识别意图', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  route: { label: '路由', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  skill: { label: '调用技能', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  agent: { label: '子 Agent 调用', color: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  artifact: { label: '产物', color: 'text-green-400 bg-green-500/10 border-green-500/20' },
  error: { label: '错误', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
}

export function StepEvent({ step }: { step: ChatStep }) {
  const config = stepConfig[step.type] || { label: step.type, color: 'text-[#5a5a70] bg-[#16161e] border-[#252530]' }
  const c = typeof step.content === 'object' ? step.content : {}
  let detail = ''
  if (step.type === 'parse' && c.intent) detail = ` · 意图: ${c.intent as string}`
  if (step.type === 'route' && c.agent_id) detail = ` · ${c.agent_id as string}`
  if (step.type === 'skill' && c.skill_id) detail = ` · ${c.skill_id as string}`

  return (
    <div className={`self-start inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md border ${config.color}`}>
      <div className="w-1 h-1 rounded-full bg-current opacity-60" />
      <span className="font-medium">{config.label}</span>
      {detail && <span className="opacity-60">{detail}</span>}
    </div>
  )
}
