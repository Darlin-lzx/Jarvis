import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { isCoreArtifact } from '@/lib/artifact-filter'
import type { ArtifactDiff, ArtifactItem, ArtifactVersionItem, Agent } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  FileText, X, Search, Loader2,
  AlertCircle, Download, Pencil, Trash2, MoreHorizontal,
  FileCode, Pin, BookOpen, ArrowUpRight, Copy, Check, FilePlus,
  PanelRightClose, PanelRightOpen,
  ClipboardCheck, CheckCircle2, ListChecks, ShieldCheck,
  History, GitCompareArrows,
} from 'lucide-react'

/* ---- 产物状态 ---- */
type ArtifactStatus = '生成中' | '已保存' | '已入库' | '入库中' | '入库失败'

interface Artifact {
  id: number
  name: string
  status: ArtifactStatus
  source: string
  time: string
  failReason?: string
  /** 后端文件类型：md / sql / txt / json / ... */
  type?: string
  /** 完整 ISO 创建时间（底部元信息用） */
  createdAt?: string
  /** 生成智能体（namespace 中段解析） */
  agent?: string
  /** 迁移阶段（来自数据库 agents.stage，用于按状态机阶段分组展示） */
  stage?: string
  /** 已入库知识库文档 ID（后端回写，NULL=未入库） */
  kbDocId?: number | null
  version?: number
}

interface ArtifactPanelProps {
  convId: number | null
  /** 任务详情页用法：非空时按任务加载全部产物（区别于会话维度） */
  taskId?: number
  taskName?: string
  onClose?: () => void
  space?: string
  subSystem?: string
  activeAgent?: string
  /** 引用产物到对话输入框 */
  onReference?: (name: string) => void
  /** 快速问答模式：禁用入库相关能力 */
  quickMode?: boolean
  /** 聊天区文件卡片发来的预览请求 */
  previewRequest?: ArtifactItem | null
  onPreviewRequestHandled?: () => void
}

/* ISO 时间 → MM-DD HH:mm */
function fmtSlash(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function toArtifact(it: ArtifactItem, stage = '其他', imported = false): Artifact {
  const nsParts = (it.namespace || '').split('/')
  const fileBase = it.path?.split('/').pop()?.replace(/\.[^.]+$/, '') || ''
  const agentId = it.agent_id || nsParts[1] || ''
  return {
    id: it.id,
    name: fileBase || it.object_name || it.namespace || '产物',
    status: imported || it.kb_doc_id ? '已入库' : '已保存',
    source: it.namespace || '',
    time: it.created_at ? fmtSlash(it.created_at) : '',
    type: it.type || '',
    createdAt: it.created_at || '',
    agent: agentId,
    stage,
    kbDocId: it.kb_doc_id ?? null,
    version: it.version,
  }
}

/* 状态样式 */
const statusMeta: Record<ArtifactStatus, { label: string; text: string; bg: string; dot: string }> = {
  '已入库': { label: '已入库', text: 'text-green-400', bg: 'bg-green-500/10 border-green-500/30', dot: 'bg-green-400' },
  '已保存': { label: '待入库', text: 'text-[#9a9aa4]', bg: 'bg-white/[0.04] border-[#2a2a35]', dot: 'bg-[#6b6b80]' },
  '生成中': { label: '生成中', text: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/30', dot: 'bg-blue-400 animate-pulse' },
  '入库中': { label: '入库中', text: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/30', dot: 'bg-yellow-400 animate-pulse' },
  '入库失败': { label: '入库失败', text: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30', dot: 'bg-red-400' },
}

const filters = [
  { key: '全部', label: '全部' },
  { key: '生成中', label: '生成中' },
  { key: '已保存', label: '待入库' },
  { key: '已入库', label: '已入库' },
  { key: '入库失败', label: '入库失败' },
] as const

type FilterKey = (typeof filters)[number]['key']

/* ---- 产物迁移阶段（由生成 Agent 的 stage 决定，DB 配置化；对应状态机阶段） ---- */
const STAGE_META: Record<string, { Icon: any; color: string; bg: string }> = {
  '数据采集': { Icon: ListChecks, color: 'text-sky-400', bg: 'bg-sky-500/10' },
  '迁移评估': { Icon: ClipboardCheck, color: 'text-indigo-400', bg: 'bg-indigo-500/10' },
  '迁移方案': { Icon: FileText, color: 'text-purple-400', bg: 'bg-purple-500/10' },
  '代码改造': { Icon: FileCode, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  '迁移验证': { Icon: CheckCircle2, color: 'text-teal-400', bg: 'bg-teal-500/10' },
  '完成': { Icon: ShieldCheck, color: 'text-green-400', bg: 'bg-green-500/10' },
}
const STAGE_ORDER = ['数据采集', '迁移评估', '迁移方案', '代码改造', '迁移验证', '完成', '其他']

/* 文件类型图标 */
function fileMeta(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'sql') return { Icon: FileCode, color: 'text-cyan-400', bg: 'bg-cyan-500/10' }
  if (ext === 'txt') return { Icon: FileText, color: 'text-[#9a9aa4]', bg: 'bg-white/[0.05]' }
  if (ext === 'json') return { Icon: FileCode, color: 'text-yellow-400', bg: 'bg-yellow-500/10' }
  return { Icon: FileText, color: 'text-indigo-400', bg: 'bg-indigo-500/10' }
}

/* 后端 type → 中文类型标签（底部元信息用） */
function typeLabel(type: string) {
  const t = (type || '').toLowerCase()
  if (t === 'md' || t === 'markdown' || type === '') return 'Markdown 报告'
  if (t === 'sql') return 'SQL 脚本'
  if (t === 'txt') return '纯文本'
  if (t === 'json') return 'JSON 数据'
  if (t === 'xlsx' || t === 'xls' || t === 'csv') return '表格'
  return '代码文件'
}

/* yyyy-MM-dd HH:mm */
function fmtFull(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const SQL_KW = new Set(['SELECT', 'FROM', 'WHERE', 'CREATE', 'TABLE', 'INSERT', 'INTO', 'VALUES', 'PRIMARY', 'KEY', 'BIGINT', 'VARCHAR', 'DECIMAL', 'INT', 'NOT', 'NULL', 'COUNT', 'AND', 'OR', 'ORDER', 'BY', 'GROUP', 'UPDATE', 'SET', 'DELETE', 'INDEX', 'JOIN', 'ON', 'AS', 'DESC', 'ASC', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'CURRENT', 'TIMESTAMP', 'CHAR', 'DATE', 'NUMBER', 'FLOAT'])

/** SQL 高亮：返回行号列 + 高亮行内容的交错数组 */
function renderSqlLines(src: string) {
  const lines = src.split('\n')
  return lines.map((line, i) => {
    let content: React.ReactNode = line
    if (line.trim().startsWith('--')) {
      content = <span className="text-[#5a5a70] italic">{line}</span>
    } else if (line.trim().startsWith('/*')) {
      content = <span className="text-[#5a5a70] italic">{line}</span>
    } else {
      const parts = line.split(/(\b[A-Z][A-Z0-9_]{1,14}\b)/g)
      content = (
        <>
          {parts.map((p, j) => (
            SQL_KW.has(p)
              ? <span key={j} className="text-indigo-400 font-medium">{p}</span>
              : <span key={j}>{p}</span>
          ))}
        </>
      )
    }
    return (
      <div key={i} className="flex">
        <span className="w-10 shrink-0 select-none text-right pr-3 text-[#4a4a5a]">{i + 1}</span>
        <span className="flex-1 whitespace-pre-wrap break-all max-w-[calc(100%-2.5rem)]">{content}</span>
      </div>
    )
  })
}

function diffBlocks(diff: ArtifactDiff | null) {
  if (!diff) return null
  return (
    <div className="border border-[#252530] rounded-lg overflow-hidden bg-[#12121a]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#252530] bg-[#16161e]">
        <div className="text-[11px] text-[#9a9aa4]">v{diff.left_version} → v{diff.right_version}</div>
        <div className="flex gap-2 text-[10px]">
          <span className="text-green-400">+{diff.summary.added}</span>
          <span className="text-red-400">-{diff.summary.removed}</span>
          <span className="text-amber-400">~{diff.summary.changed}</span>
        </div>
      </div>
      <div className="max-h-[360px] overflow-auto">
        {diff.blocks.map((block, index) => (
          <div key={index} className="grid grid-cols-2 border-b border-[#202028] last:border-0">
            <div className={cn('px-3 py-1 font-mono text-[11px] whitespace-pre-wrap break-all', block.kind === 'added' ? 'bg-green-500/5 text-[#4a4a58]' : block.kind === 'removed' || block.kind === 'changed' ? 'bg-red-500/5 text-red-300' : 'text-[#8b8b9e]')}>
              {block.left_start ? `${block.left_start}: ` : ''}{block.left.join('\n') || '—'}
            </div>
            <div className={cn('px-3 py-1 font-mono text-[11px] whitespace-pre-wrap break-all border-l border-[#252530]', block.kind === 'removed' ? 'bg-red-500/5 text-[#4a4a58]' : block.kind === 'added' || block.kind === 'changed' ? 'bg-green-500/5 text-green-300' : 'text-[#8b8b9e]')}>
              {block.right_start ? `${block.right_start}: ` : ''}{block.right.join('\n') || '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Markdown 渲染：标题 / 列表 / 引用 / 表格 / 代码块 / 分隔线 */
function renderMarkdown(src: string) {
  const lines = src.split('\n')
  const out: React.ReactNode[] = []
  let inCode = false
  let codeBuf: string[] = []
  let inTable = false
  let tableRows: string[][] = []
  const flushTable = () => {
    if (!tableRows.length) return
    const cells = tableRows[0]
    out.push(
      <div key={`t${out.length}`} className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {cells.map((c, j) => (
                <th key={j} className="border border-[#252530] bg-[#1a1a24] px-2 py-1 text-left font-semibold text-[#cdd3e0]">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.slice(1).map((row, ri) => (
              <tr key={ri}>
                {row.map((c, j) => (
                  <td key={j} className="border border-[#252530] px-2 py-1 text-[#cdd3e0]">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    tableRows = []
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()
    // 代码块开关
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(
          <pre key={i} className="my-2 bg-[#12121a] border border-[#252530] rounded-lg p-3 overflow-x-auto text-[12px] font-mono leading-relaxed text-[#d4d4dc]">
            {codeBuf.join('\n')}
          </pre>
        )
        codeBuf = []
      }
      inCode = !inCode
      continue
    }
    if (inCode) { codeBuf.push(line); continue }
    // 空行
    if (!line.trim()) { out.push(<div key={i} className="h-2" />); continue }
    // 表格
    const tblMatch = line.match(/^\|(.+)\|$/)
    if (tblMatch) {
      inTable = true
      const cells = tblMatch[1].split('|').map(c => c.trim())
      if (cells.every(c => /^:?-+:?$/.test(c))) continue // 分隔行
      tableRows.push(cells)
      continue
    } else if (inTable) {
      flushTable()
      inTable = false
    }
    // 标题
    const hm = line.match(/^(#{1,4})\s+(.*)$/)
    if (hm) {
      const level = hm[1].length
      const sizes = ['text-[17px] font-semibold', 'text-[15px] font-semibold', 'text-[14px] font-semibold', 'text-[13px] font-semibold']
      out.push(
        <div key={i} className={`${sizes[level - 1]} text-[#e4e4e9] mt-3 mb-1 first:mt-0`}>
          {inlineMd(hm[2])}
        </div>
      )
      continue
    }
    // 引用
    const qm = line.match(/^>\s?(.*)$/)
    if (qm) {
      out.push(
        <div key={i} className="border-l-2 border-indigo-500/50 pl-3 my-1 text-[#9a9aa4] italic">
          {inlineMd(qm[1])}
        </div>
      )
      continue
    }
    // 无序列表
    const um = line.match(/^\s*[-*]\s+(.*)$/)
    if (um) {
      out.push(
        <div key={i} className="flex gap-2 text-[#cdd3e0] leading-relaxed ml-1">
          <span className="text-[#5b7cfa] shrink-0">•</span>
          <span>{inlineMd(um[1])}</span>
        </div>
      )
      continue
    }
    // 有序列表
    const om = line.match(/^\s*\d+[.、]\s+(.*)$/)
    if (om) {
      out.push(
        <div key={i} className="flex gap-2 text-[#cdd3e0] leading-relaxed ml-1">
          <span className="text-[#5b7cfa] shrink-0 font-mono">{om[0].match(/^\s*\d+/)?.[0]}.</span>
          <span>{inlineMd(om[1])}</span>
        </div>
      )
      continue
    }
    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push(<div key={i} className="border-t border-[#252530] my-2" />)
      continue
    }
    out.push(
      <div key={i} className="text-[#cdd3e0] leading-relaxed">{inlineMd(line)}</div>
    )
  }
  if (inCode) {
    out.push(
      <pre key="tail" className="my-2 bg-[#12121a] border border-[#252530] rounded-lg p-3 overflow-x-auto text-[12px] font-mono leading-relaxed text-[#d4d4dc]">
        {codeBuf.join('\n')}
      </pre>
    )
  }
  flushTable()
  return out
}

/** 行内 Markdown：代码片段 / 加粗 / 斜体 */
function inlineMd(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_{1,2}[^_]+_{1,2})/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const raw = m[0]
    if (raw.startsWith('`')) {
      const code = raw.slice(1, -1)
      // 行内代码需避开实际是普通符号的情况
      if (/^--?$/.test(code) || /^[.-]+$/.test(code)) { nodes.push(code); last = m.index + raw.length; continue }
      nodes.push(<code key={k++} className="bg-[#1a1a24] border border-[#252530] rounded px-1 py-px text-[11px] font-mono text-[#e4b857]">{code}</code>)
    } else if (raw.startsWith('**')) {
      nodes.push(<strong key={k++} className="font-semibold text-[#e4e4e9]">{raw.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={k++} className="text-[#bdbdc7] italic">{raw.slice(1, -1)}</em>)
    }
    last = m.index + raw.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function ArtifactPanel({ convId, taskId, taskName, onClose, space = '浙江移动国产化', subSystem = '营业系统', activeAgent, onReference, quickMode = false, previewRequest, onPreviewRequestHandled }: ArtifactPanelProps) {
  const [searchQ, setSearchQ] = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterKey>('全部')
  const [autoImportMap, setAutoImportMap] = useState<Record<number, boolean>>({})
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  // 本地已入库 id 集合：提交入库后保留标记，避免 5s 轮询从后端拉回状态（后端入库尚未实现，前端先落本地）
  const [localImported, setLocalImported] = useState<Set<number>>(new Set())
  const [moreMenu, setMoreMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null)
  const [previewShow, setPreviewShow] = useState(false)
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const [versions, setVersions] = useState<ArtifactVersionItem[]>([])
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [diffLeft, setDiffLeft] = useState<number | null>(null)
  const [diffRight, setDiffRight] = useState<number | null>(null)
  const [diffResult, setDiffResult] = useState<ArtifactDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  // 入库弹窗（预览抽屉内）
  const [importTarget, setImportTarget] = useState<Artifact | null>(null)
  const [importDocName, setImportDocName] = useState('')
  const [importKb, setImportKb] = useState('')
  const [importAgent, setImportAgent] = useState('')
  const [importDesc, setImportDesc] = useState('')
  // 预览抽屉内的更多下拉
  const [previewMore, setPreviewMore] = useState(false)
  const previewMoreRef = useRef<HTMLDivElement>(null)
  const [renameTarget, setRenameTarget] = useState<Artifact | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 面板宽度（拖拽调整，260~480px）
  const [width, setWidth] = useState(280)
  const dragRef = useRef<{ x: number; w: number } | null>(null)
  // 面板折叠态：折叠后收窄为可点击展开的竖条
  // 响应式：窄视口（<1280px）默认折叠，避免 220px 侧边栏 + 360px 面板挤压聊天列
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 1280
  )

  const autoImport = autoImportMap[convId ?? 0] ?? false

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2400)
  }

  // 加载真实产物数据：会话维度（聊天页）或任务维度（任务详情页，5s 轮询实时刷新）
  useEffect(() => {
    setActiveFilter('全部')
    setSearchQ('')
    setArtifacts([])
    if (convId == null && taskId == null) return
    const load = () => {
      const artP = taskId != null ? api.listArtifactsByTask(taskId) : api.listArtifacts(convId ?? undefined)
      // 并行取智能体列表，建立 agent_id → product_type（产物业务类型）映射，按类型分组展示
      const agtP = api.listAgents().catch(() => null)
      Promise.all([artP, agtP]).then(([r, ag]) => {
        if (!r.success) return
        const stageMap = new Map<string, string>()
        if (ag && ag.success) {
          ;(ag.data as Agent[]).forEach(a => stageMap.set(a.id || a.agent_id || '', a.stage || '其他'))
        }
        const items = ((r.data || []) as ArtifactItem[]).filter(isCoreArtifact)
        setArtifacts(items.map(it => {
          const agentId = it.agent_id || (it.namespace || '').split('/')[1] || ''
          return toArtifact(it, stageMap.get(agentId) || '其他', localImported.has(it.id))
        }))
      }).catch(() => setArtifacts([]))
    }
    load()
    // 任务详情页或聊天页均启用 5s 轮询，确保子 Agent 生成的产物实时展示
    if (taskId != null || convId != null) {
      const timer = setInterval(load, 5000)
      return () => clearInterval(timer)
    }
  }, [convId, taskId, localImported])

  useEffect(() => {
    if (!previewRequest) return
    setCollapsed(false)
    const existing = artifacts.find(a => a.id === previewRequest.id)
    openPreview(existing || toArtifact(previewRequest))
    onPreviewRequestHandled?.()
  }, [previewRequest?.id])

  // 关闭更多菜单 / 预览的点击外部处理
  useEffect(() => {
    if (!moreMenu && !previewMore) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return
      if (previewMoreRef.current && previewMoreRef.current.contains(e.target as Node)) return
      setMoreMenu(null)
      setPreviewMore(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreMenu, previewMore])

  const toggleAutoImport = () => {
    if (quickMode) {
      showToast('快速问答模式：产物仅本地保存，不支持入库')
      return
    }
    setAutoImportMap(prev => ({ ...prev, [convId ?? 0]: !autoImport }))
    showToast(autoImport ? '已关闭自动入库' : `已开启，产物将自动入库至【${space}】知识库`)
  }

  const filterList = quickMode ? filters.filter(f => f.key === '全部') : filters

  const filtered = artifacts.filter(a => {
    const matchQ = !searchQ || a.name.toLowerCase().includes(searchQ.toLowerCase())
    const matchF = activeFilter === '全部' || a.status === activeFilter
    return matchQ && matchF
  })

  /* ===== 操作 ===== */
  /** 打开入库弹窗（预览内）：预填知识库/智能体，文档名称可改 */
  const openImportDialog = (artifact: Artifact) => {
    setImportTarget(artifact)
    setImportDocName(artifact.name)
    setImportKb(`【${space}】知识库`)
    setImportAgent(activeAgent || artifact.agent || '当前智能体')
    setImportDesc(importDescDefault(artifact))
  }

  /** 默认描述：本次任务自动生成的 {文件类型} */
  const importDescDefault = (a: Artifact) => {
    const t = typeLabel(a.type || '')
    return `本次任务自动生成的${t}「${a.name}」`
  }

  /** 提交入库：调用后端真实入库（复制到 kb_files → 向量化 → 回写 kb_doc_id） */
  const submitImport = async () => {
    if (!importTarget) return
    const target = importTarget
    const docName = importDocName.trim() || target.name
    setImportTarget(null)
    setArtifacts(prev => prev.map(a => a.id === target.id ? { ...a, name: docName, status: '入库中' as const, failReason: undefined } : a))
    setPreviewArtifact(prev => prev && prev.id === target.id ? { ...prev, name: docName, status: '入库中' as const } : prev)
    showToast('入库中：切片、向量化…')
    try {
      const r = await api.importArtifact(target.id, { doc_name: docName, description: importDesc })
      if (!r.success) throw new Error(r.error || '入库失败')
      setLocalImported(prev => { const n = new Set(prev); n.add(target.id); return n })
      setArtifacts(prev => prev.map(a => a.id === target.id ? { ...a, name: docName, status: '已入库' as const, kbDocId: r.data?.doc_id ?? null } : a))
      setPreviewArtifact(prev => prev && prev.id === target.id ? { ...prev, name: docName, status: '已入库' as const, kbDocId: r.data?.doc_id ?? null } : prev)
      showToast(`「${r.data?.name || docName}」已入库至【${space}】知识库（${r.data?.chunks ?? 0} 个分块）`)
    } catch (e) {
      const msg = (e as Error)?.message || '入库失败，请重试'
      setArtifacts(prev => prev.map(a => a.id === target.id ? { ...a, status: '入库失败' as const, failReason: msg } : a))
      setPreviewArtifact(prev => prev && prev.id === target.id ? { ...prev, status: '入库失败' as const } : prev)
      showToast(msg)
    }
  }

  const handleRetry = (id: number) => {
    setArtifacts(prev => prev.map(a => a.id === id ? { ...a, status: '入库中' as const, failReason: undefined } : a))
    const target = artifacts.find(a => a.id === id)
    if (!target) return
    api.importArtifact(id, { doc_name: target.name })
      .then(r => {
        if (!r.success) throw new Error(r.error || '入库失败')
        setLocalImported(prev => { const n = new Set(prev); n.add(id); return n })
        setArtifacts(prev => prev.map(a => a.id === id ? { ...a, status: '已入库' as const, kbDocId: r.data?.doc_id ?? null } : a))
        showToast('入库成功')
      })
      .catch((e) => {
        const msg = (e as Error)?.message || '入库失败，请重试'
        setArtifacts(prev => prev.map(a => a.id === id ? { ...a, status: '入库失败' as const, failReason: msg } : a))
        showToast(msg)
      })
  }

  const handleRemove = async (id: number) => {
    setMoreMenu(null)
    const target = artifacts.find(a => a.id === id)
    if (target && !window.confirm(`删除产物「${target.name}」？仅删除产物文件与记录；若已入库知识库，知识库文档保留不受影响。`)) return
    setArtifacts(prev => prev.filter(a => a.id !== id))
    if (previewArtifact?.id === id) setPreviewArtifact(null)
    try { await api.deleteArtifact(id); showToast('产物已删除') } catch { showToast('删除失败') }
  }

  const handlePin = (id: number) => {
    setArtifacts(prev => {
      const target = prev.find(a => a.id === id)
      if (!target) return prev
      return [target, ...prev.filter(a => a.id !== id)]
    })
    setMoreMenu(null)
    showToast('已置顶')
  }

  const openMoreMenu = (e: React.MouseEvent, artifact: Artifact) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMoreMenu({ id: artifact.id, x: rect.right, y: rect.bottom })
  }

  // 打开预览：从后端拉取产物真实内容
  const openPreview = (artifact: Artifact) => {
    setPreviewArtifact(artifact)
    setPreviewShow(true)
    setPreviewContent('')
    setPreviewLoading(true)
    setPreviewError(false)
    setVersions([])
    setSelectedVersion(artifact.version ?? null)
    setDiffLeft(null)
    setDiffRight(null)
    setDiffResult(null)
    setMoreMenu(null)
    api.getArtifactFile(artifact.id).then(r => {
      const content = (r as unknown as { content?: string }).content ?? ''
      setPreviewContent(content)
      setPreviewLoading(false)
    }).catch(() => {
      setPreviewLoading(false)
      setPreviewError(true)
    })
    api.listArtifactVersions(artifact.id).then(r => {
      const rows = r.data || []
      setVersions(rows)
      const current = rows.find(v => v.version === artifact.version) ||
        rows.find(v => v.id === artifact.id) ||
        rows[rows.length - 1]
      if (current?.version != null) {
        setSelectedVersion(current.version)
        if (rows.length >= 2) {
          setDiffLeft(rows[rows.length - 2].version ?? null)
          setDiffRight(rows[rows.length - 1].version ?? null)
        }
      }
    }).catch(() => setVersions([]))
  }

  const switchVersion = (version: number) => {
    if (!previewArtifact) return
    setSelectedVersion(version)
    setPreviewLoading(true)
    setPreviewError(false)
    api.getArtifactVersion(previewArtifact.id, version).then(r => {
      setPreviewContent(r.data?.content ?? '')
      setPreviewLoading(false)
    }).catch(() => {
      setPreviewLoading(false)
      setPreviewError(true)
    })
  }

  const compareVersions = () => {
    if (!previewArtifact || diffLeft == null || diffRight == null || diffLeft === diffRight) return
    setDiffLoading(true)
    api.diffArtifact(previewArtifact.id, diffLeft, diffRight).then(r => {
      setDiffResult(r.data || null)
      setDiffLoading(false)
    }).catch(() => {
      setDiffResult(null)
      setDiffLoading(false)
      showToast('差异对比失败')
    })
  }

  // ESC 关闭预览抽屉 + 锁定底层滚动
  useEffect(() => {
    if (!previewArtifact) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewArtifact(null) }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [previewArtifact])

  // 复制全文
  const copyPreview = async () => {
    if (!previewContent) { showToast('文档暂无内容'); return }
    try {
      await navigator.clipboard.writeText(previewContent)
      showToast('复制成功')
    } catch { showToast('复制失败') }
  }

  const handleDownload = (artifact: Artifact) => {
    // xlsx 必须保留原生二进制；其他文本产物也统一从后端原文件下载。
    const extension = artifact.type ? `.${artifact.type}` : ''
    const filename = artifact.name.includes('.') ? artifact.name : `${artifact.name}${extension}`
    const a = document.createElement('a')
    a.href = `/api/artifacts/${artifact.id}/download`
    a.download = filename
    a.click()
    setMoreMenu(null)
    showToast(`已下载「${artifact.name}」`)
  }

  const confirmRename = async () => {
    if (!renameTarget) return
    const name = renameVal.trim()
    if (!name) return
    try { await api.renameArtifact(renameTarget.id, name) } catch { /* 以本地更新兜底 */ }
    setArtifacts(prev => prev.map(a => a.id === renameTarget.id ? { ...a, name } : a))
    setPreviewArtifact(prev => prev && prev.id === renameTarget.id ? { ...prev, name } : prev)
    setRenameTarget(null)
    showToast('已重命名')
  }

  // 拖拽调整面板宽度（左侧边缘把手）
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { x: e.clientX, w: width }
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return
      setWidth(Math.min(480, Math.max(260, dragRef.current.w + (dragRef.current.x - ev.clientX))))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 快速问答模式：临时产物不入库，统一标记为「本地」，不再出现 待入库/已入库/入库失败 状态
  const meta = (a: Artifact) => {
    const m = statusMeta[a.status]
    if (!quickMode) return m
    if (a.status === '生成中') return statusMeta['生成中']
    return { label: '本地', text: 'text-[#9a9aa4]', bg: 'bg-white/[0.04] border-[#2a2a35]', dot: 'bg-[#6b6b80]' }
  }
  const fileOf = (a: Artifact) => fileMeta(a.name)

  // 折叠态：收窄为竖条，点击展开
  if (collapsed) {
    return (
      <aside className="bg-[#0f0f14] border-l border-[#252530] flex flex-col items-center shrink-0 w-9 py-3 gap-2">
        <button
          className="text-[#8b8b9e] hover:text-indigo-400 transition-colors p-1 rounded-md hover:bg-white/[0.04]"
          onClick={() => setCollapsed(false)}
          title="展开产物列表"
        >
          <PanelRightOpen className="w-4 h-4" />
        </button>
        <button
          className="flex flex-col items-center gap-1.5 py-2 text-[#9a9aa4] hover:text-[#cdd3e0] transition-colors"
          onClick={() => setCollapsed(false)}
          title="展开产物列表"
        >
          <span className="text-[11px] tracking-widest" style={{ writingMode: 'vertical-rl' }}>
            产物列表{artifacts.length > 0 ? ` · ${artifacts.length}` : ''}
          </span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="bg-[#0f0f14] border-l border-[#252530] flex flex-col shrink-0 relative" style={{ width }}>
      {/* 拖拽手柄：调整面板宽度 */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500/30 active:bg-indigo-500/50 transition-colors z-10"
        onMouseDown={onDragStart}
        title="拖拽调整面板宽度"
      />
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#252530] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-[#8b8b9e]" />
          <span className="text-[13px] font-semibold text-[#cdd3e0]">产物列表</span>
          {taskName && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 whitespace-nowrap">
              归属任务：{taskName}
            </span>
          )}
          <span className="text-[11px] text-[#5a5a70] bg-[#16161e] border border-[#252530] rounded-full px-1.5 py-px">
            {artifacts.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {onClose && (
            <button className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors" onClick={onClose}>
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
            onClick={() => setCollapsed(true)}
            title="收起面板"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {/* 搜索 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
            <input
              className="w-full h-7 pl-8 pr-3 rounded-md bg-[#16161e] border border-[#252530] text-[12px] text-[#cdd3e0] placeholder:text-[#4a4a5a] focus:outline-none focus:border-indigo-500/40 transition-colors"
              placeholder="搜索产物..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>

          {/* 自动入库开关（快速问答模式置灰锁定） */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5">
              <span className={cn('text-[11px]', quickMode ? 'text-[#3a3a4a]' : 'text-[#9a9aa4]')}>自动入库</span>
              <button
                className={cn(
                  'relative w-7 h-4 rounded-full transition-colors',
                  quickMode ? 'bg-[#2a2a35] cursor-not-allowed opacity-60' : (autoImport ? 'bg-indigo-500' : 'bg-[#2a2a35]')
                )}
                onClick={toggleAutoImport}
                title={quickMode ? '快速问答模式：产物不可入库' : '产物生成后自动入库至当前空间知识库'}
              >
                <div className={cn(
                  'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform',
                  autoImport ? 'left-3.5' : 'left-0.5'
                )} />
              </button>
              <span className={cn('text-[10px] transition-colors', quickMode ? 'text-[#5a5a70]' : (autoImport ? 'text-indigo-400' : 'text-[#5a5a70]'))}>
                {quickMode ? '不可用' : (autoImport ? '已开启' : '已关闭')}
              </span>
            </div>
          </div>
          {quickMode ? (
            <div className="text-[10px] text-amber-400/80 px-1 -mt-1 leading-relaxed">
              快速问答模式：产物仅本地会话可用，支持预览与下载，不入库、不绑定任务
            </div>
          ) : (
          <div className="text-[10px] text-[#5a5a70] px-1 -mt-1 leading-relaxed">
            开启后，产物生成自动入库至
            <button
              className="mx-0.5 text-indigo-400 hover:underline"
              onClick={() => showToast(`产物归属：${space} / ${subSystem} / ${activeAgent ?? '当前智能体'}`)}
              title="点击查看产物归属"
            >
              【{space}】
            </button>
            知识库，绑定当前智能体
          </div>
          )}

          {/* 状态筛选 */}
          <div className="flex gap-1 px-0.5">
            {filterList.map(f => (
              <button
                key={f.key}
                className={cn(
                  'flex-1 text-center text-[11px] py-1 rounded-md transition-colors',
                  activeFilter === f.key
                    ? 'bg-indigo-500/15 text-indigo-400 font-medium'
                    : 'text-[#5a5a70] hover:text-[#9a9aa4] hover:bg-white/[0.04]'
                )}
                onClick={() => setActiveFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* 分隔线 */}
          <div className="border-t border-[#252530]" />

          {/* 空状态 */}
          {artifacts.length === 0 ? (
            <div className="text-center py-10 px-2">
              <FileText className="w-9 h-9 text-[#2a2a35] mx-auto mb-3" />
              <p className="text-[13px] text-[#9a9aa4] font-medium mb-1">暂无产物</p>
              <p className="text-[11px] text-[#5a5a70] leading-relaxed mb-3">
                任务执行完成后，报告、脚本等产物会自动展示在这里
              </p>
              <div className="text-[10px] text-[#4a4a5a] bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2">
                小提示：开启「自动入库」，生成文件自动存入当前空间知识库
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8">
              <Search className="w-6 h-6 text-[#2a2a35] mx-auto mb-2" />
              <p className="text-[12px] text-[#5a5a70]">未找到匹配的产物</p>
            </div>
          ) : (
            /* 产物列表：按业务类型分组（Agent 生成的产物归到对应类型下） */
            <div className="space-y-3">
              {(() => {
                const groups = STAGE_ORDER
                  .map(pt => ({ pt, items: filtered.filter(a => (a.stage || '其他') === pt) }))
                  .filter(g => g.items.length > 0)
                return groups.map(g => {
                  const gMeta = STAGE_META[g.pt] || { Icon: FileText, color: 'text-[#9a9aa4]', bg: 'bg-white/[0.05]' }
                  const GIcon = gMeta.Icon
                  return (
                    <div key={g.pt}>
                      <div className="flex items-center gap-1.5 px-1 pb-1">
                        <span className={cn('w-4 h-4 rounded flex items-center justify-center shrink-0', gMeta.bg)}>
                          <GIcon className={cn('w-2.5 h-2.5', gMeta.color)} />
                        </span>
                        <span className="text-[11px] font-semibold text-[#9a9aa4]">{g.pt}</span>
                        <span className="text-[10px] text-[#4a4a5a]">{g.items.length}</span>
                        <div className="flex-1 border-t border-[#252530]" />
                      </div>
                      <div className="space-y-2">
                        {g.items.map(artifact => {
                const m = meta(artifact)
                const fi = fileOf(artifact)
                return (
                  <div key={artifact.id} className="group relative rounded-lg bg-[#16161e] border border-[#252530] p-3 space-y-2">
                    {/* 第一行：图标 + 名称 + 更多 */}
                    <div className="flex items-center gap-2">
                      <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', fi.bg)}>
                        <fi.Icon className={cn('w-3.5 h-3.5', fi.color)} />
                      </div>
                      <span className="text-[12px] text-[#cdd3e0] font-medium truncate flex-1" title={artifact.name}>
                        {artifact.name}
                      </span>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-[#5a5a70] hover:text-[#e4e4e9] p-0.5 rounded transition-all"
                        title="更多操作"
                        onClick={e => openMoreMenu(e, artifact)}
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* 第二行：状态 + 来源 + 时间 */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] whitespace-nowrap', m.bg, m.text)}>
                        {artifact.status === '生成中' || artifact.status === '入库中' ? (
                          <Loader2 className={cn('w-2.5 h-2.5 animate-spin', m.text)} />
                        ) : (
                          <span className={cn('w-1.5 h-1.5 rounded-full', m.dot)} />
                        )}
                        {m.label}
                      </span>
                      <span className="text-[10px] text-[#5a5a70] shrink-0">来自</span>
                      <span className="text-[10px] text-[#8b8b9e] truncate" title={artifact.source}>{artifact.source}</span>
                      <span className="text-[10px] text-[#4a4a5a] shrink-0">· {artifact.time}</span>
                    </div>

                    {/* 入库失败原因（快速问答模式不出现） */}
                    {artifact.status === '入库失败' && artifact.failReason && !quickMode && (
                      <div className="flex items-center gap-1 text-[10px] text-red-400/90">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        <span className="truncate" title={artifact.failReason}>{artifact.failReason}</span>
                      </div>
                    )}

                    {/* 第三行：操作按钮 */}
                    <div className="flex items-center gap-1 pt-0.5">
                      <button
                        className="text-[11px] text-indigo-400 hover:text-indigo-300 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                        onClick={() => openPreview(artifact)}
                      >
                        预览
                      </button>

                      {artifact.status === '已保存' && !quickMode && (
                        <button
                          className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                          onClick={() => openImportDialog(artifact)}
                          title="上传至知识库并做切片向量化"
                        >
                          入库
                        </button>
                      )}

                      {artifact.status === '已入库' && !quickMode && (
                        <button
                          className="flex items-center gap-0.5 text-[11px] text-[#9a9aa4] hover:text-cyan-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                          onClick={() => showToast(`已跳转至知识库文档：${artifact.name}`)}
                          title="跳转到知识库文档详情页"
                        >
                          查看知识库
                          <ArrowUpRight className="w-2.5 h-2.5" />
                        </button>
                      )}

                      {artifact.status === '入库失败' && !quickMode && (
                        <>
                          <button
                            className="text-[11px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                            onClick={() => handleRetry(artifact.id)}
                          >
                            重试入库
                          </button>
                          <button
                            className="text-[11px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors"
                            onClick={() => handleRemove(artifact.id)}
                          >
                            删除
                          </button>
                        </>
                      )}

                      {artifact.status === '生成中' && (
                        <span className="text-[10px] text-[#5a5a70]">{quickMode ? '生成中…' : '生成完成后可入库'}</span>
                      )}

                      {artifact.status === '入库中' && !quickMode && (
                        <span className="flex items-center gap-1 text-[10px] text-yellow-400">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          正在写入知识库…
                        </span>
                      )}
                    </div>
                  </div>
                )
                })}
              </div>
                </div>
              )
                })}
                )()}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* ======== Portal：更多操作菜单 ======== */}
      {moreMenu && createPortal(
        <div
          ref={menuRef}
          className="w-28 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl py-1 overflow-hidden"
          style={{ position: 'fixed', left: moreMenu.x - 112, top: moreMenu.y + 4, zIndex: 95 }}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
            onClick={() => { const a = artifacts.find(x => x.id === moreMenu.id); if (a) { setRenameTarget(a); setRenameVal(a.name) } setMoreMenu(null) }}
          >
            <Pencil className="w-3 h-3 text-[#5a5a70]" />重命名
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
            onClick={() => { const a = artifacts.find(x => x.id === moreMenu.id); if (a) handleDownload(a) }}
          >
            <Download className="w-3 h-3 text-[#5a5a70]" />下载
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
            onClick={() => handlePin(moreMenu.id)}
          >
            <Pin className="w-3 h-3 text-[#5a5a70]" />置顶
          </button>
          <div className="border-t border-[#252530]" />
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
            onClick={() => handleRemove(moreMenu.id)}
          >
            <Trash2 className="w-3 h-3" />删除
          </button>
        </div>,
        document.body
      )}

      {/* ======== Portal：预览抽屉（右侧叠加层，盖住产物面板一部分） ======== */}
      {previewArtifact && createPortal(
        <>
          {/* 遮罩：点击外部关闭；锁定底层滚动由 openPreview 的 effect 处理 */}
          <div
            className={cn('fixed inset-0 z-[85] bg-black/45 transition-opacity duration-200', previewShow ? 'opacity-100' : 'opacity-0')}
            onClick={() => setPreviewArtifact(null)}
          />
          {/* 抽屉主体：固定 720px，从右侧滑入，叠加在产物面板之上 */}
          <div
            className={cn(
              'fixed top-0 bottom-0 right-0 z-[86] w-[720px] bg-[#0f0f14] border-l border-[#252530] flex flex-col shadow-2xl transition-transform duration-300 ease-out',
              previewShow ? 'translate-x-0' : 'translate-x-full'
            )}
          >
            {/* 头部：图标 + 名称（超长截断，hover 看全名）+ 状态 */}
            <div className="px-5 py-4 border-b border-[#252530] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {(() => {
                  const fi = fileMeta(previewArtifact.name)
                  return (
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', fi.bg)}>
                      <fi.Icon className={cn('w-4 h-4', fi.color)} />
                    </div>
                  )
                })()}
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-[#e4e4e9] truncate max-w-[480px]" title={previewArtifact.name}>
                    {previewArtifact.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={cn('inline-flex items-center gap-1 px-1.5 py-px rounded-full border text-[10px]', statusMeta[previewArtifact.status].bg, statusMeta[previewArtifact.status].text)}>
                      {quickMode && previewArtifact.status !== '生成中' ? '本地' : statusMeta[previewArtifact.status].label}
                    </span>
                    <span className="text-[10px] text-[#5a5a70] truncate">{previewArtifact.source}</span>
                  </div>
                </div>
              </div>
              <button
                className="text-[#5a5a70] hover:text-[#e4e4e9] p-1.5 rounded-lg hover:bg-white/[0.05] transition-colors shrink-0"
                title="关闭预览 (ESC)"
                onClick={() => setPreviewArtifact(null)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 顶部操作栏：复制全文 / 下载 / 入库 / 更多 */}
            <div className="px-4 py-2 border-b border-[#252530] flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[12px] px-2.5 bg-[#16161e] border border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9]"
                onClick={copyPreview}
                title="一键复制预览区全部内容"
              >
                <Copy className="w-3 h-3 mr-1" />
                复制全文
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[12px] px-2.5 bg-[#16161e] border border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9]"
                onClick={() => handleDownload(previewArtifact)}
              >
                <Download className="w-3 h-3 mr-1" />
                下载
              </Button>
              {!quickMode && (
                previewArtifact.status !== '已入库' ? (
                  <Button
                    size="sm"
                    className="h-7 text-[12px] px-3 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90"
                    onClick={() => openImportDialog(previewArtifact)}
                    disabled={previewArtifact.status === '生成中' || previewArtifact.status === '入库中'}
                    title="上传至知识库并做切片向量化"
                  >
                    <BookOpen className="w-3 h-3 mr-1" />
                    {previewArtifact.status === '入库中' ? '入库中…' : '入库'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 text-[12px] px-3 bg-[#16161e] border border-[#252530] text-[#5a5a70] cursor-not-allowed"
                    disabled
                    title="已入库，不可重复入库"
                  >
                    <Check className="w-3 h-3 mr-1" />
                    已入库
                  </Button>
                )
              )}
              {onReference && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[12px] px-2.5 bg-[#16161e] border border-[#252530] text-[#9a9aa4] hover:text-indigo-400"
                  onClick={() => {
                    onReference(previewArtifact.name)
                    setPreviewArtifact(null)
                    showToast(`已引用「${previewArtifact.name}」到对话输入框`)
                  }}
                >
                  <ArrowUpRight className="w-3 h-3 mr-1" />
                  引用到对话
                </Button>
              )}
              <div className="ml-auto relative" ref={previewMoreRef}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[12px] px-2 bg-[#16161e] border border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9]"
                  onClick={() => setPreviewMore(v => !v)}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                  更多
                </Button>
                {previewMore && (
                  <div className="absolute right-0 top-8 w-32 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl py-1 z-10">
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                      onClick={() => {
                        setRenameTarget(previewArtifact)
                        setRenameVal(previewArtifact.name)
                        setPreviewMore(false)
                      }}
                    >
                      <Pencil className="w-3 h-3 text-[#5a5a70]" />重命名产物
                    </button>
                    <div className="border-t border-[#252530]" />
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
                      onClick={() => { setPreviewMore(false); handleRemove(previewArtifact.id) }}
                    >
                      <Trash2 className="w-3 h-3" />删除产物
                    </button>
                  </div>
                )}
              </div>
            </div>

            {versions.length > 0 && (
              <div className="px-4 py-2 border-b border-[#252530] bg-[#12121a]">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-[#9a9aa4]">
                    <History className="w-3.5 h-3.5 text-blue-400" />
                    版本历史
                  </div>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {versions.map(version => (
                      <button
                        key={`${version.id}-${version.version}`}
                        onClick={() => version.version != null && switchVersion(version.version)}
                        className={cn(
                          'h-6 px-2 rounded-full border text-[10px] whitespace-nowrap transition-colors',
                          selectedVersion === version.version
                            ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                            : 'border-[#2a2a35] bg-[#16161e] text-[#8b8b9e] hover:text-[#cdd3e0]'
                        )}
                      >
                        v{version.version ?? 1}
                      </button>
                    ))}
                  </div>
                </div>
                {versions.length >= 2 && (
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex items-center gap-1 text-[11px] font-semibold text-[#9a9aa4]">
                      <GitCompareArrows className="w-3.5 h-3.5 text-amber-400" />
                      差异对比
                    </div>
                    <select
                      value={diffLeft ?? undefined}
                      onChange={e => setDiffLeft(Number(e.target.value))}
                      className="h-6 rounded-md border border-[#2a2a35] bg-[#16161e] px-1.5 text-[10px] text-[#cdd3e0] outline-none"
                    >
                      {versions.map(version => (
                        <option key={`left-${version.version}`} value={version.version ?? 1}>v{version.version ?? 1}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-[#5a5a70]">→</span>
                    <select
                      value={diffRight ?? undefined}
                      onChange={e => setDiffRight(Number(e.target.value))}
                      className="h-6 rounded-md border border-[#2a2a35] bg-[#16161e] px-1.5 text-[10px] text-[#cdd3e0] outline-none"
                    >
                      {versions.map(version => (
                        <option key={`right-${version.version}`} value={version.version ?? 1}>v{version.version ?? 1}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      className="h-6 px-2 text-[10px] bg-[#16161e] border border-[#2a2a35] text-[#9a9aa4] hover:text-[#e4e4e9]"
                      disabled={diffLoading || diffLeft == null || diffRight == null || diffLeft === diffRight}
                      onClick={compareVersions}
                    >
                      {diffLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitCompareArrows className="w-3 h-3" />}
                      对比
                    </Button>
                  </div>
                )}
                {diffResult && <div className="mt-3">{diffBlocks(diffResult)}</div>}
              </div>
            )}

            {/* 预览内容区（独立滚动） */}
            <div className="flex-1 overflow-y-auto">
              <div className="p-6">
                {previewLoading ? (
                  <div className="flex items-center justify-center py-20 text-[12px] text-[#5a5a70]">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />文档加载中...
                  </div>
                ) : previewError ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <AlertCircle className="w-6 h-6 text-[#3a3a4a] mb-2" />
                    <div className="text-[12px] text-[#5a5a70]">文件解析失败，请下载到本地查看</div>
                  </div>
                ) : !previewContent.trim() ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <FileText className="w-6 h-6 text-[#3a3a4a] mb-2" />
                    <div className="text-[12px] text-[#5a5a70]">文档暂无内容</div>
                  </div>
                ) : previewArtifact.type === 'sql' || previewArtifact.name.toLowerCase().endsWith('.sql') ? (
                  <div className="text-[12px] font-mono bg-[#12121a] border border-[#252530] rounded-lg p-3 overflow-x-auto leading-relaxed">
                    {renderSqlLines(previewContent)}
                  </div>
                ) : previewArtifact.type === 'txt' || previewArtifact.type === 'json' ? (
                  <pre className="text-[12px] font-mono bg-[#12121a] border border-[#252530] rounded-lg p-4 overflow-x-auto leading-relaxed text-[#cdd3e0] whitespace-pre-wrap break-all">{previewContent}</pre>
                ) : (
                  <div className="text-[13px] bg-[#12121a] border border-[#252530] rounded-lg p-5 min-h-[300px]">
                    {renderMarkdown(previewContent)}
                  </div>
                )}
              </div>
            </div>

            {/* 底部元信息栏（固定，只读，用于溯源） */}
            <div className="px-5 py-3 border-t border-[#252530] bg-[#12121a]">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="text-[#5a5a70]">生成智能体</span>
                  <span className="text-[#8b8b9e]" title={previewArtifact.agent}>{previewArtifact.agent || activeAgent || '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[#5a5a70]">创建时间</span>
                  <span className="text-[#8b8b9e]">{fmtFull(previewArtifact.createdAt) || previewArtifact.time}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[#5a5a70]">文件类型</span>
                  <span className="text-[#8b8b9e]">{typeLabel(previewArtifact.type || '')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[#5a5a70]">入库状态</span>
                  <span className={cn('inline-flex items-center gap-1 px-1.5 py-px rounded-full border text-[10px]', statusMeta[previewArtifact.status].bg, statusMeta[previewArtifact.status].text)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', statusMeta[previewArtifact.status].dot)} />
                    {quickMode && previewArtifact.status !== '生成中' ? '本地' : statusMeta[previewArtifact.status].label}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}

      {/* ======== Portal：重命名弹窗 ======== */}
      {renameTarget && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50">
          <div className="w-[320px] bg-[#16161e] border border-[#252530] rounded-xl shadow-2xl p-4">
            <div className="text-[13px] font-semibold text-[#e4e4e9] mb-3">重命名产物</div>
            <input
              autoFocus
              className="w-full h-9 px-3 rounded-lg bg-[#1a1a24] border border-[#252530] text-[13px] text-[#e4e4e9] placeholder:text-[#4a4a5a] focus:outline-none focus:border-indigo-500/40 transition-colors"
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmRename() }}
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button
                size="sm"
                variant="outline"
                className="text-[12px] h-8 border-[#252530] text-[#9a9aa4]"
                onClick={() => setRenameTarget(null)}
              >
                取消
              </Button>
              <Button
                size="sm"
                className="text-[12px] h-8 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90"
                onClick={confirmRename}
                disabled={!renameVal.trim()}
              >
                确认
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ======== Portal：入库弹窗（预览内点击【入库】弹出） ======== */}
      {importTarget && createPortal(
        <div className="fixed inset-0 z-[92] flex items-center justify-center bg-black/50" onClick={() => setImportTarget(null)}>
          <div className="w-[440px] bg-[#16161e] border border-[#252530] rounded-xl shadow-2xl p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-indigo-400" />
                <span className="text-[13px] font-semibold text-[#e4e4e9]">文档入库到知识库</span>
              </div>
              <button className="text-[#5a5a70] hover:text-[#e4e4e9] p-1 rounded transition-colors" onClick={() => setImportTarget(null)}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="space-y-3.5">
              {/* 文档名称（可修改） */}
              <div>
                <label className="block text-[11px] text-[#5a5a70] mb-1">文档名称（可修改）</label>
                <input
                  className="w-full h-9 px-3 rounded-lg bg-[#1a1a24] border border-[#252530] text-[12px] text-[#e4e4e9] placeholder:text-[#4a4a5a] focus:outline-none focus:border-indigo-500/40 transition-colors"
                  value={importDocName}
                  onChange={e => setImportDocName(e.target.value)}
                />
              </div>

              {/* 目标知识库（默认预填当前空间知识库） */}
              <div>
                <label className="block text-[11px] text-[#5a5a70] mb-1">目标知识库</label>
                <div className="h-9 px-3 rounded-lg bg-[#0f0f14] border border-[#252530] text-[12px] text-[#cdd3e0] flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <BookOpen className="w-3 h-3 text-indigo-400" />
                    {importKb}
                  </span>
                  <span className="text-[10px] text-[#4a4a5a]">当前空间</span>
                </div>
              </div>

              {/* 绑定智能体（默认主 Agent） */}
              <div>
                <label className="block text-[11px] text-[#5a5a70] mb-1">绑定智能体</label>
                <div className="h-9 px-3 rounded-lg bg-[#0f0f14] border border-[#252530] text-[12px] text-[#cdd3e0] flex items-center justify-between">
                  <span>{importAgent || '当前智能体'}</span>
                  <span className="text-[10px] text-[#4a4a5a]">自动绑定</span>
                </div>
              </div>

              {/* 分段设置 */}
              <div>
                <label className="block text-[11px] text-[#5a5a70] mb-1">文档分段（Chunk）设置</label>
                <div className="flex items-center gap-2 py-1">
                  <span className="inline-flex items-center gap-1 text-[11px] text-[#cdd3e0]">
                    <FilePlus className="w-3 h-3 text-indigo-400" />
                    使用默认分段规则
                  </span>
                  <span className="text-[10px] text-[#5a5a70]">（自动切片并向量化）</span>
                </div>
              </div>

              {/* 描述（选填） */}
              <div>
                <label className="block text-[11px] text-[#5a5a70] mb-1">描述（选填）</label>
                <textarea
                  className="w-full h-16 px-3 py-2 rounded-lg bg-[#1a1a24] border border-[#252530] text-[12px] text-[#e4e4e9] placeholder:text-[#4a4a5a] focus:outline-none focus:border-indigo-500/40 transition-colors resize-none"
                  value={importDesc}
                  onChange={e => setImportDesc(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <Button
                size="sm"
                variant="outline"
                className="text-[12px] h-8 border-[#252530] text-[#9a9aa4]"
                onClick={() => setImportTarget(null)}
              >
                取消
              </Button>
              <Button
                size="sm"
                className="text-[12px] h-8 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90"
                onClick={submitImport}
                disabled={!importDocName.trim()}
              >
                <BookOpen className="w-3 h-3 mr-1" />
                确认入库
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ======== Toast ======== */}
      {toast && (
        <div className="fixed top-4 z-[96] px-4 py-2 rounded-lg bg-[#1a1a24] border border-indigo-500/40 text-[12px] text-[#cdd3e0] shadow-xl max-w-[280px]"
          style={{ right: width + 10 }}>
          {toast}
        </div>
      )}
    </aside>
  )
}
