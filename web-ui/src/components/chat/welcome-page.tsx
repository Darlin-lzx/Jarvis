import { useState, useRef, useEffect, useMemo } from 'react'
import {
  ArrowUp, Plus, X, ChevronDown, Bot, User, Copy, Check,
  AtSign, Paperclip, Sparkles, Hammer,
  MessageSquare, ChevronRight, PanelRightClose, PanelRightOpen,
  Loader2, CheckCircle2, Clock, Database, Brain, BookOpen,
  Plug, Send, Settings,
  Save, Trash2, ScrollText, Pencil, Upload, Cpu,
  FolderKanban, Link2, ClipboardPaste, FileUp, Eye, Zap,
} from 'lucide-react'
import { MdRender, isGuidanceMessage } from './md-highlight'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useChatStream, stripLeadingJson } from '@/hooks/use-chat-stream'
import { api } from '@/lib/api'
import { agents as builtinAgents, skillGroups } from './agent-tabs'
import { ArtifactPanel } from './delivery-panel'
import { ReferencePicker } from './reference-picker'
import { ConvertToProjectDialog } from './convert-to-project-dialog'
import { NewTaskDialog } from '@/components/project/new-task-dialog'
import { AttachTaskDialog } from '@/components/project/attach-task-dialog'
import { cn } from '@/lib/utils'
import type { ConversationDetail, Space, ChatReference, AttachmentItem } from '@/lib/types'

/* ---- 欢迎卡片示例 ---- */
const examplePrompts = [
  '帮我把营业系统的页面展示与布点方案梳理出来',
  '分析这条 SQL 慢查询，给出优化方案',
  '做跨工程迭代评估，评估业务改造工作量',
]

/* ---- 任务链路步骤类型 ---- */
interface TaskStep {
  label: string
  status: 'done' | 'running' | 'pending'
  detail?: string
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  taskChain?: TaskStep[]
}

interface ConversationItem {
  id: number
  title: string
}

/* ---- 资源配置相关类型 ---- */
interface DataSource {
  id: string
  name: string
  connected: boolean
}

interface AgentItem {
  id: string
  name: string
  selected: boolean
}

interface KbItem {
  id: string
  name: string
  selected: boolean
}

interface McpService {
  id: string
  name: string
  enabled: boolean
}

type ConfigStep = 'select' | 'config' | 'confirm'

import type { Agent } from '@/lib/types'

interface WelcomePageProps {
  onConvCreated?: (id: number) => void
  activeAgent?: string
  setActiveAgent?: (id: string) => void
  quickMode?: boolean
  onModeChange?: (q: boolean) => void
  onConvertToProject?: (spaceId: number) => void | Promise<unknown>
  /** 后端智能体列表（用于下拉选择） */
  agentList?: Agent[]
}

export function WelcomePage({ onConvCreated, activeAgent, setActiveAgent, quickMode = false, onModeChange, onConvertToProject, agentList }: WelcomePageProps) {
  // 使用后端智能体列表，如果未提供则降级为内置列表
  const agents = agentList && agentList.length > 0 ? agentList : builtinAgents
  const activeAgentInfo = agents.find(a => a.id === activeAgent) as Agent | undefined
  const [showModeDrp, setShowModeDrp] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [spacesForConvert, setSpacesForConvert] = useState<Space[]>([])
  const openConvertDialog = () => {
    if (spacesForConvert.length === 0) {
      api.listSpaces().then(r => { if (r.success) setSpacesForConvert(r.data || []) }).catch(() => {})
    }
    setConvertOpen(true)
  }
  const [input, setInput] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [convId, setConvId] = useState<number | null>(null)
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [convInfo, setConvInfo] = useState<ConversationDetail | null>(null)
  const [allSpaces, setAllSpaces] = useState<Space[]>([])
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [showConvDropdown, setShowConvDropdown] = useState(false)
  // 会话下拉菜单视图：ops=操作项 / list=会话列表（「切换会话列表」进入）
  const [convMenuView, setConvMenuView] = useState<'ops' | 'list'>('ops')
  const [showRightPanel, setShowRightPanel] = useState(true)
  const [expandedChains, setExpandedChains] = useState<Set<number>>(new Set())
  const [taskSteps, setTaskSteps] = useState<TaskStep[]>([])
  const { streaming, assistantText, send, stop } = useChatStream()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)
  const [introCollapsed, setIntroCollapsed] = useState<Set<number>>(new Set())
  const convDropdownRef = useRef<HTMLDivElement>(null)

  // 资源配置状态
  const [configStep, setConfigStep] = useState<ConfigStep>('select')
  const [dataSources, setDataSources] = useState<DataSource[]>([])
  const [configAgents, setConfigAgents] = useState<AgentItem[]>([])
  const [configKbs, setConfigKbs] = useState<KbItem[]>([])
  const [configMcps, setConfigMcps] = useState<McpService[]>([])
  const [taskDescription, setTaskDescription] = useState('')
  const [mcpEnabled, setMcpEnabled] = useState(true)

  // ===== 对话头部栏状态 =====
  const [space, setSpace] = useState('浙江移动跨工程')
  const [convName, setConvName] = useState('未命名会话')
  const [editingConvName, setEditingConvName] = useState(false)
  const [showSpaceDrp, setShowSpaceDrp] = useState(false)
  const spaceDrpRef = useRef<HTMLDivElement>(null)

  // ===== 快速示例折叠 =====
  const [showExamples, setShowExamples] = useState(true)

  // ===== 技能区折叠（技能集整体默认收起，组内可再各自折叠） =====
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [skillSectionOpen, setSkillSectionOpen] = useState(false)

  // ===== 底部技能下拉记忆（localStorage 持久化，与 Composer 共用 key） =====
  const [lastSkill, setLastSkill] = useState<string>(() => {
    try { return localStorage.getItem('last_skill') || '' } catch { return '' }
  })

  // ===== 输入框增强 =====
  const [showAgentDrp, setShowAgentDrp] = useState(false)
  const [showSkillDrp, setShowSkillDrp] = useState(false)
  const agentDrpRef = useRef<HTMLDivElement>(null)
  const skillDrpRef = useRef<HTMLDivElement>(null)
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [showModelDrp, setShowModelDrp] = useState(false)
  const modelDrpRef = useRef<HTMLDivElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([])
  const [showRefPicker, setShowRefPicker] = useState(false)
  const [references, setReferences] = useState<ChatReference[]>([])
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState('')

  // ===== 产物联动 =====
  const [savedArtifacts, setSavedArtifacts] = useState<Set<number>>(new Set())

  // ===== Toast / 保存状态 =====
  const [toast, setToast] = useState('')
  const [convSaved, setConvSaved] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 加载会话列表
  useEffect(() => {
    api.listConversations().then(r => {
      if (r.success) {
        setConversations((r.data as any[]) || [])
      }
    }).catch(() => {})
  }, [])

  // 加载全量空间（用于按会话 space_id 匹配真实空间）
  useEffect(() => {
    api.listSpaces().then(r => {
      if (!r.success) return
      const list = (r.data || []) as Space[]
      setAllSpaces(list)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 配置资源向导：加载真实数据源 / 智能体 / 知识库文档 / MCP 服务（不再使用写死测试数据）
  useEffect(() => {
    api.listDatasources().then(r => {
      if (r.success) {
        const list = r.data || []
        setDataSources(list.filter(d => d.enabled).map(d => ({ id: String(d.id ?? d.name), name: d.name, connected: !!d.health_ok })))
      }
    }).catch(() => {})
    api.listAgents().then(r => {
      if (r.success) {
        const list = r.data || []
        setConfigAgents(list.filter(a => a.enabled).map(a => ({ id: a.agent_id ?? a.id, name: a.name, selected: false })))
      }
    }).catch(() => {})
    api.listDocuments().then(r => {
      if (r.success) {
        const list = r.data || []
        setConfigKbs(list.map(d => ({ id: String(d.id), name: d.name || `文档${d.id}`, selected: false })))
      }
    }).catch(() => {})
    api.listMCPServers().then(r => {
      if (r.success) {
        const list = r.data || []
        setConfigMcps(list.filter(m => m.enabled).map(m => ({ id: String(m.id), name: m.name, enabled: true })))
        setMcpEnabled(list.some(m => m.enabled))
      }
    }).catch(() => {})
    // 模型下拉：仅展示「模型管理」中已启用的 LLM 模型
    api.listModels({ type: 'LLM', enabled: true }).then(r => {
      if (!r.success) return
      const list = (r.data || [])
        .map(m => m.name || m.model_id)
        .filter((v): v is string => !!v)
      setModels(list)
      setModel(prev => list.includes(prev) ? prev : (list[0] || ''))
    }).catch(() => {})
  }, [])

  // 会话归属信息（任务/空间）
  useEffect(() => {
    if (convId == null) { setConvInfo(null); return }
    api.getConversation(convId).then(r => { if (r.success) setConvInfo(r.data ?? null) }).catch(() => {})
  }, [convId])

  const realSpace = useMemo(() => {
    if (convInfo?.space_id) return allSpaces.find(s => s.id === convInfo.space_id) || null
    // 全新对话：按顶部选中的空间名称匹配真实空间（场景 B 自动带入）
    return allSpaces.find(s => s.name === space) || null
  }, [allSpaces, convInfo?.space_id, space])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, assistantText, taskSteps])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (convDropdownRef.current && !convDropdownRef.current.contains(event.target as Node)) {
        setShowConvDropdown(false)
      }
      if (spaceDrpRef.current && !spaceDrpRef.current.contains(event.target as Node)) {
        setShowSpaceDrp(false)
      }
      if (modelDrpRef.current && !modelDrpRef.current.contains(event.target as Node)) {
        setShowModelDrp(false)
      }
      if (agentDrpRef.current && !agentDrpRef.current.contains(event.target as Node)) {
        setShowAgentDrp(false)
      }
      if (skillDrpRef.current && !skillDrpRef.current.contains(event.target as Node)) {
        setShowSkillDrp(false)
      }
    }
    if (showConvDropdown || showSpaceDrp || showModelDrp || showAgentDrp || showSkillDrp) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showConvDropdown, showSpaceDrp, showModelDrp, showAgentDrp, showSkillDrp])

  const handleSend = async () => {
    if (!input.trim() && selectedTags.length === 0 && uploadedFiles.length === 0 && references.length === 0 && attachments.length === 0) return
    const text = input.trim()
    setInput('')
    setSelectedTags([])
    setReferences([])

    const fileRefs = uploadedFiles.map(f => `文件:${f}`)
    const skillPrefix = lastSkill ? [`技能：${lastSkill}`] : []
    const prefix = [...skillPrefix, ...selectedTags, ...fileRefs].join(', ')
    const fullText = prefix ? `[${prefix}] ${text}` : text

    setTaskSteps([
      { label: '主 Agent 正在解析需求', status: 'running' },
      { label: '正在调用 RAG 检索知识库', status: 'pending' },
      { label: '调度子 Agent 执行任务', status: 'pending' },
    ])

    setMessages(prev => [...prev, { role: 'user', content: fullText }])

    let cid = convId
    let justCreated = false
    if (cid == null) {
      try {
        const r = await api.createConversation(text.slice(0, 20))
        if (r.success && r.data) {
          cid = r.data.id
          setConvId(cid)
          justCreated = true
          const listR = await api.listConversations()
          if (listR.success) setConversations((listR.data as any[]) || [])
        }
      } catch (e) {
        console.error('Failed to create conversation:', e)
      }
    }

    let agentId = activeAgent
    const mentionMatch = text.match(/@(\S+)/)
    if (mentionMatch) {
      const mentionedName = mentionMatch[1]
      const matchedAgent = agents.find(a => a.name === mentionedName)
      if (matchedAgent) {
        agentId = matchedAgent.id
      }
    }

    let reply: string | null = null
    try {
      reply = await send(text, cid, agentId, {
        references: references.length > 0 ? references : undefined,
        attachment_ids: attachments.length > 0 ? attachments.map(a => a.id) : undefined,
      })
    } catch (e) {
      console.error('Send failed:', e)
      showToast('发送失败：' + (e instanceof Error ? e.message : String(e)))
    }

    // 新会话：发送完成后再通知父组件切换视图（确保 ChatView 加载时后端已有消息）
    if (justCreated && cid != null) {
      onConvCreated?.(cid)
    }

    setTaskSteps(prev => prev.map(s => ({ ...s, status: 'done' as const })))

    if (reply) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: reply,
        taskChain: [
          { label: '主 Agent：拆解任务，调度 CodeAgent', status: 'done' },
          { label: '页面展示Agent：梳理前端布点，调用 RAG 检索知识库', status: 'done', detail: '跨工程迭代开发' },
          { label: '输出结果', status: 'done' },
        ],
      }])
    }
    setTaskSteps([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleQuickScenario = (label: string) => {
    if (quickMode) {
      showToast('当前是快速问答模式，无法加载项目知识库与数据源，请切换至项目会话使用该能力')
      return
    }
    setConfigStep('config')
    setTaskDescription(`帮我完成「${label}」任务。`)
  }

  // 底部技能下拉：选中即记忆（与 Composer 共用 localStorage key 'last_skill'）
  const selectSkill = (skill: string) => {
    setLastSkill(skill)
    try { localStorage.setItem('last_skill', skill) } catch { /* 忽略隐私模式异常 */ }
    setShowSkillDrp(false)
  }

  const removeTag = (tag: string) => {
    setSelectedTags(prev => prev.filter(t => t !== tag))
  }

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 快捷引导按钮：一键填充需求到底部输入框
  const quickFill = (tpl: string) => {
    setInput(tpl)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // 引导消息收起 / 展开介绍
  const toggleIntro = (i: number) => {
    setIntroCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const handleNewConversation = () => {
    setMessages([])
    setConvId(null)
    setTaskSteps([])
    setInput('')
    setSelectedTags([])
    setConfigStep('select')
    setTaskDescription('')
    setConvName('未命名会话')
    setEditingConvName(false)
    setUploadedFiles([])
    setAttachments([])
    setReferences([])
    setSkillSectionOpen(false)
  }

  /* ===== 头部栏操作 ===== */
  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2400)
  }

  const handleSwitchSpace = (name: string) => {
    if (name === space) return
    setSpace(name)
    setShowSpaceDrp(false)
    handleNewConversation()
    showToast(`已切换到「${name}」空间，所有对话与产物将归属该空间`)
  }

  const commitConvName = () => {
    setEditingConvName(false)
    if (!convName.trim()) setConvName('未命名会话')
  }

  const handleSaveConversation = () => {
    setConvSaved(true)
    showToast(`会话「${convName}」已保存，将同步入库「${space}」空间知识库`)
    setTimeout(() => setConvSaved(false), 2000)
  }

  const handleClearConversation = () => {
    if (messages.length === 0) {
      showToast('当前会话还没有内容')
      return
    }
    setMessages([])
    setTaskSteps([])
    showToast('对话已清空')
  }

  /* ===== 技能区折叠 / 上传 / 产物 ===== */
  const toggleGroup = (label: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const openFilePicker = () => {
    setUploadNote('')
    uploadInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    setUploading(true)
    setUploadNote('')
    api.uploadChatAttachments(files, {
      conv_id: convId,
      space_id: convInfo?.space_id ?? realSpace?.id ?? null,
      auto_import: false,
    })
      .then(r => {
        const list = r.data || []
        const ok = list.filter(i => !i.error)
        const bad = list.filter(i => i.error)
        if (ok.length > 0) {
          setUploadedFiles(prev => [...prev, ...ok.map(i => i.name)])
          setAttachments(prev => [...prev, ...ok.map(i => ({
            id: i.id, name: i.name, file_type: i.file_type, object_name: i.object_name, text_len: i.text_len,
          }))])
        }
        if (bad.length > 0 && ok.length > 0) {
          setUploadNote(`部分文件处理失败：${bad.map(i => `${i.name}（${i.error}）`).join('；')}`)
        } else if (bad.length > 0) {
          setUploadNote(r.detail || '全部文件处理失败，请检查文件类型（支持 .sql/.ddl/.docx/.md/.txt/.xlsx/.pdf）')
        } else if (ok.length > 0) {
          showToast(`已上传 ${ok.length} 个附件，Agent 将自动读取`)
        }
      })
      .catch(() => setUploadNote('上传失败，请稍后重试'))
      .finally(() => setUploading(false))
  }

  const removeAttachment = (id: number) => {
    const target = attachments.find(a => a.id === id)
    setAttachments(prev => prev.filter(a => a.id !== id))
    if (target) setUploadedFiles(prev => prev.filter(f => f !== target.name))
  }

  const toggleArtifactSave = (i: number) => {
    setSavedArtifacts(prev => {
      const next = new Set(prev)
      if (next.has(i)) { next.delete(i); return next }
      next.add(i)
      showToast('产物已保存，将自动入库当前空间知识库并绑定当前智能体')
      return next
    })
  }

  const handleSwitchConversation = (conv: ConversationItem) => {
    setConvId(conv.id)
    setShowConvDropdown(false)
    api.getMessages(conv.id).then(r => {
      if (r.success) {
        const msgs = (r.data as any[]) || []
        setMessages(msgs.map((m: any) => ({
          role: m.role as 'user' | 'assistant',
          content: m.role === 'assistant' ? stripLeadingJson(m.content || '') : (m.content || ''),
        })))
      }
    }).catch(() => {})
  }

  const toggleChain = (idx: number) => {
    setExpandedChains(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  /** 会话下拉：重命名当前会话（进入头部文件名编辑态） */
  const startRenameConv = () => {
    setShowConvDropdown(false)
    setEditingConvName(true)
    // 编辑态输入框聚焦（等待渲染完成）
    requestAnimationFrame(() => {
      const el = document.getElementById('conv-name-input') as HTMLInputElement | null
      el?.focus()
      el?.select()
    })
  }

  /** 会话下拉：删除当前会话（删除后重置为欢迎态） */
  const handleDeleteCurrent = () => {
    setShowConvDropdown(false)
    const cid = convId
    const doReset = () => {
      setMessages([])
      setTaskSteps([])
      setConvId(null)
      setConvName('未命名会话')
      setEditingConvName(false)
      api.listConversations().then(r => {
        if (r.success) setConversations((r.data as any[]) || [])
      }).catch(() => {})
    }
    if (cid == null) {
      showToast('当前会话尚未创建，已直接新建会话')
      doReset()
      return
    }
    api.deleteConversation(cid).then(r => {
      if (r.success) {
        showToast('当前会话已删除')
        doReset()
      } else {
        showToast('删除失败，请稍后重试')
      }
    }).catch(() => showToast('删除失败，请稍后重试'))
  }

  const toggleAgent = (id: string) => {
    setConfigAgents(prev => prev.map(a => a.id === id ? { ...a, selected: !a.selected } : a))
  }

  const toggleKb = (id: string) => {
    setConfigKbs(prev => prev.map(k => k.id === id ? { ...k, selected: !k.selected } : k))
  }

  const toggleMcpService = (id: string) => {
    setConfigMcps(prev => prev.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m))
  }

  const handleCreateTask = async () => {
    const text = taskDescription.trim() || input.trim()
    if (!text) return

    setInput('')
    setConfigStep('select')
    setReferences([])

    setTaskSteps([
      { label: '主 Agent 正在解析需求', status: 'running' },
      { label: '正在调用 RAG 检索知识库', status: 'pending' },
      { label: '调度子 Agent 执行任务', status: 'pending' },
    ])

    setMessages(prev => [...prev, { role: 'user', content: text }])

    let cid = convId
    let justCreated = false
    if (cid == null) {
      try {
        const r = await api.createConversation(text.slice(0, 20))
        if (r.success && r.data) {
          cid = r.data.id
          setConvId(cid)
          justCreated = true
          const listR = await api.listConversations()
          if (listR.success) setConversations((listR.data as any[]) || [])
        }
      } catch (e) {
        console.error('Failed to create conversation:', e)
      }
    }

    let reply: string | null = null
    try {
      reply = await send(text, cid, activeAgent, {
        references: references.length > 0 ? references : undefined,
        attachment_ids: attachments.length > 0 ? attachments.map(a => a.id) : undefined,
      })
    } catch (e) {
      console.error('Send failed:', e)
      showToast('发送失败：' + (e instanceof Error ? e.message : String(e)))
    }

    // 新会话创建 + 发送完成后，再通知父组件切换视图（确保 ChatView 加载时后端已有消息）
    if (justCreated && cid != null) {
      onConvCreated?.(cid)
    }

    setTaskSteps(prev => prev.map(s => ({ ...s, status: 'done' as const })))

    if (reply) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: reply,
        taskChain: [
          { label: '主 Agent：拆解任务，调度子 Agent', status: 'done' },
          { label: '子 Agent：执行任务，调用 RAG 检索知识库', status: 'done' },
          { label: '输出结果', status: 'done' },
        ],
      }])
    }
    setTaskSteps([])
  }

  const showWelcome = messages.length === 0 && !streaming && taskSteps.length === 0

  const stepItems = [
    { key: 'select' as ConfigStep, label: '选择场景' },
    { key: 'config' as ConfigStep, label: '配置资源' },
    { key: 'confirm' as ConfigStep, label: '确认创建' },
  ]

  const stepIndex = stepItems.findIndex(s => s.key === configStep)

  // 根据当前空间动态推荐示例
  const examples = space === '开通系统'
    ? ['帮我把营业系统的页面展示与布点方案梳理出来', '梳理下单拆单规则并输出代码改动清单', '梳理订单受理与工作流交互']
    : space === '账务系统'
      ? ['梳理客户数据范围与取数逻辑', '梳理业务规则与配置分支', '做跨工程迭代评估，评估业务改造工作量']
      : examplePrompts

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ======== 顶部对话头部栏 ======== */}
      <div className="px-6 py-2.5 border-b border-[#1e1e28] bg-[#0f0f14]">
        <div className="flex items-center justify-between gap-4">
          {/* 左侧：标题 + 空间 / 会话名 */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 pr-4 border-r border-[#252530] shrink-0 relative">
              <Bot className="w-4 h-4 text-indigo-400" />
              <span className="text-[14px] font-semibold text-[#e4e4e9] whitespace-nowrap">
                {activeAgentInfo ? (activeAgentInfo.alias || activeAgentInfo.name) : '智能体'}
              </span>
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap',
                quickMode ? 'text-amber-400 bg-amber-500/10 border border-amber-500/20' : 'text-indigo-400 bg-indigo-500/10 border border-indigo-500/20'
              )}>
                {quickMode ? '快速问答' : '项目会话'}
              </span>
              <button
                className="flex items-center gap-0.5 text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                onClick={() => setShowModeDrp(!showModeDrp)}
                title="切换会话模式"
              >
                <ChevronDown className={cn('w-3 h-3 transition-transform', showModeDrp && 'rotate-180')} />
              </button>
              {showModeDrp && (
                <div className="absolute left-0 top-full mt-1.5 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-44 py-1.5">
                  <div className="px-3 pb-1.5 text-[11px] text-[#5a5a70]">会话模式</div>
                  <button
                    className={cn('w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors', !quickMode ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]')}
                    onClick={() => { onModeChange?.(false); setShowModeDrp(false) }}
                  >
                    项目会话
                  </button>
                  <button
                    className={cn('w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors', quickMode ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]')}
                    onClick={() => { onModeChange?.(true); setShowModeDrp(false) }}
                  >
                    快速问答
                  </button>
                </div>
              )}
            </div>

            {/* 空间选择 —— 切换空间自动刷新页面（仅项目会话模式）；悬浮提示可跳转空间详情页 */}
            {!quickMode && (<div className="relative shrink-0" ref={spaceDrpRef}>
              <button
                className="flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] text-[#9a9aa4] hover:text-[#e4e4e9] hover:bg-white/[0.03] transition-colors whitespace-nowrap"
                onClick={() => setShowSpaceDrp(!showSpaceDrp)}
                title="点击跳转到对应空间详情页"
              >
                <FolderKanban className="w-3.5 h-3.5 text-[#5a5a70]" />
                <span>空间：<span className="text-[#cdd3e0]">{space}</span></span>
                <ChevronDown className={cn('w-3 h-3 text-[#5a5a70] transition-transform', showSpaceDrp && 'rotate-180')} />
              </button>
              {showSpaceDrp && (
                <div className="absolute left-0 top-full mt-1.5 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-48 py-1.5 overflow-hidden">
                  <div className="px-3 pb-1.5 text-[11px] text-[#5a5a70]">切换空间将刷新页面</div>
                  {allSpaces.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-[#5a5a70]">暂无可用空间</div>
                  ) : allSpaces.map(s => (
                    <button
                      key={s.id}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors',
                        s.name === space ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                      )}
                      onClick={() => handleSwitchSpace(s.name)}
                    >
                      {s.name === space && <Check className="w-3.5 h-3.5" />}
                      <span className={s.name === space ? '' : 'pl-[22px]'}>{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>)}

            {/* 任务归属标签（仅任务内会话展示） */}
            {!quickMode && (convInfo?.task_id ? (
              <div className="flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] text-indigo-400 whitespace-nowrap shrink-0" title={`任务：${convInfo.task_name}`}>
                <Link2 className="w-3 h-3" />任务：{convInfo.task_name}
              </div>
            ) : null)}
            {quickMode && (
              <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 text-[12px] text-amber-400 whitespace-nowrap shrink-0">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                快速问答 · 临时会话
                {convId != null && (
                  <button
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-[11px] text-amber-300 hover:bg-amber-500/25 transition-colors"
                    onClick={openConvertDialog}
                    title="转为项目会话：绑定空间后解锁产物入库与空间知识库/数据源"
                  >
                    转为项目会话
                    <ChevronRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}

            {/* 会话名称 —— 作为上下文信息项展示，可点击重命名（改名后实时更新到「会话名称：xxx」） */}
            <div className="flex items-center gap-1.5 min-w-0 shrink-0">
              {editingConvName ? (
                <input
                  id="conv-name-input"
                  autoFocus
                  className="h-7 w-44 px-2.5 rounded-lg bg-[#1a1a24] border border-indigo-500/40 text-[12px] text-[#e4e4e9] focus:outline-none"
                  value={convName}
                  onChange={e => setConvName(e.target.value)}
                  onBlur={commitConvName}
                  onKeyDown={e => { if (e.key === 'Enter') commitConvName() }}
                />
              ) : (
                <button
                  className="flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] text-[#9a9aa4] hover:text-[#e4e4e9] hover:bg-white/[0.03] transition-colors whitespace-nowrap"
                  onClick={() => setEditingConvName(true)}
                  title="点击编辑会话名称"
                >
                  <MessageSquare className="w-3.5 h-3.5 text-[#5a5a70]" />
                  <span>会话名称：</span>
                  <span className="max-w-[140px] truncate text-[#cdd3e0]">{convName || '未命名会话'}</span>
                  <Pencil className="w-3 h-3 text-[#5a5a70]" />
                </button>
              )}
            </div>
          </div>

          {/* 右侧操作：会话下拉 + 高频操作 */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* ▾会话 下拉：新建会话 / 切换会话列表 / 重命名当前会话 / 删除当前会话 */}
            <div className="relative" ref={convDropdownRef}>
              <Button
                size="sm"
                variant="outline"
                className="text-[12px] h-7 border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-indigo-500/40"
                onClick={() => { setShowConvDropdown(!showConvDropdown); if (!showConvDropdown) setConvMenuView('ops') }}
              >
                会话
                <ChevronDown className={cn("w-3 h-3 ml-1 transition-transform", showConvDropdown && "rotate-180")} />
              </Button>
              {showConvDropdown && (
                <div className="absolute right-0 top-full mt-1 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-60 overflow-hidden">
                  {convMenuView === 'ops' ? (
                    <>
                      {/* 新建会话 */}
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                        onClick={() => { setShowConvDropdown(false); handleNewConversation() }}
                      >
                        <Plus className="w-3.5 h-3.5 text-indigo-400" />
                        新建会话
                      </button>
                      {/* 切换会话列表 */}
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                        onClick={() => setConvMenuView('list')}
                      >
                        <MessageSquare className="w-3.5 h-3.5 text-[#5a5a70]" />
                        切换会话列表
                        <ChevronRight className="w-3 h-3 ml-auto text-[#5a5a70]" />
                      </button>
                      {/* 重命名当前会话 */}
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                        onClick={startRenameConv}
                      >
                        <Pencil className="w-3.5 h-3.5 text-[#5a5a70]" />
                        重命名当前会话
                      </button>
                      {/* 删除当前会话 */}
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] hover:text-red-400 transition-colors"
                        onClick={handleDeleteCurrent}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-[#5a5a70]" />
                        删除当前会话
                      </button>
                      {/* 次级入口：新建任务 / 另存为任务（不占顶部空间） */}
                      {!quickMode && !convInfo?.task_id && (
                        <div className="border-t border-[#252530] mt-0.5 pt-0.5">
                          <button
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9] transition-colors"
                            onClick={() => { setShowConvDropdown(false); setNewTaskOpen(true) }}
                            title="从对话页新建任务（自动带入当前空间）"
                          >
                            <FolderKanban className="w-3.5 h-3.5 text-[#5a5a70]" />
                            新建任务
                          </button>
                          {convInfo && (
                            <button
                              className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9] transition-colors"
                              onClick={() => { setShowConvDropdown(false); setAttachOpen(true) }}
                              title="把当前独立会话转为任务内会话"
                            >
                              <Link2 className="w-3.5 h-3.5 text-[#5a5a70]" />
                              另存为任务
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {/* 会话列表视图（由「切换会话列表」进入） */}
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9] transition-colors border-b border-[#252530]"
                        onClick={() => setConvMenuView('ops')}
                      >
                        <ChevronDown className="w-3.5 h-3.5 rotate-90 text-[#5a5a70]" />
                        返回操作
                      </button>
                      {conversations.length === 0 ? (
                        <div className="px-3 py-4 text-[12px] text-[#5a5a70] text-center">暂无历史会话</div>
                      ) : (
                        <div className="max-h-56 overflow-y-auto">
                          {conversations.map(conv => (
                            <button
                              key={conv.id}
                              className={cn(
                                'w-full text-left px-3 py-2.5 text-[12px] transition-colors border-b border-[#252530] last:border-0',
                                conv.id === convId ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                              )}
                              onClick={() => { setShowConvDropdown(false); handleSwitchConversation(conv) }}
                            >
                              <div className="flex items-center gap-2">
                                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">{conv.title || `会话 #${conv.id}`}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="text-[12px] h-7 border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-indigo-500/40"
              onClick={handleSaveConversation}
              title="保存会话并入库"
            >
              <Save className={cn('w-3 h-3 mr-1', convSaved && 'text-green-400')} />
              {convSaved ? '已保存' : '保存会话'}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="text-[12px] h-7 border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-red-500/50 hover:text-red-400"
              onClick={handleClearConversation}
              title="清空当前对话"
            >
              <Trash2 className="w-3 h-3 mr-1" />
              清空对话
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="text-[12px] h-7 border-[#252530] text-[#9a9aa4] hover:text-[#e4e4e9] hover:border-indigo-500/40"
              onClick={() => showToast('会话日志功能接入中')}
              title="查看会话日志"
            >
              <ScrollText className="w-3 h-3 mr-1" />
              会话日志
            </Button>

            <div className="w-px h-4 bg-[#252530] mx-1" />

            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-[#5a5a70] hover:text-[#9a9aa4]"
              onClick={() => setShowRightPanel(!showRightPanel)}
              title={showRightPanel ? '收起右侧产物面板' : '展开右侧产物面板'}
            >
              {showRightPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* 中间主区域 */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* 消息区域 */}
          <div className="flex-1 min-h-0 overflow-y-auto" ref={scrollRef}>
            {showWelcome ? (
              configStep === 'select' ? (
                /* ======== 欢迎态（截图1） ======== */
                <div className="flex flex-col items-center px-8 pt-12 pb-4">
                  <p className="text-[13px] text-[#6a6a7a] mb-1">你可以选择下方技能，或者直接输入你的需求</p>

                  {/* 空状态提示：模式说明（快速问答 / 项目会话）+ 上传小提示 */}
                  {quickMode ? (
                    <div className="flex flex-col items-center gap-1.5 mb-5">
                      <div className="flex items-center gap-1.5 text-[12px] text-amber-300/80">
                        <Zap className="w-3.5 h-3.5 text-amber-400" />
                        快速问答模式 ·
                        <span className="text-[#5a5a70]">临时会话：产物仅本地可用，不支持入库、不可绑定任务、无法访问项目知识库与数据源</span>
                      </div>
                      <button
                        className="flex items-center gap-1.5 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                        onClick={openFilePicker}
                        title="上传代码 / 工程文件"
                      >
                        <Upload className="w-3 h-3" />
                        小提示：上传代码 / 工程结构文件进行跨工程分析（快速问答下仅限文件分析）
                      </button>
                    </div>
                  ) : (
                  <div className="flex flex-col items-center gap-1.5 mb-5">
                    <div className="flex items-center gap-1.5 text-[11px] text-[#6a6a7a]">
                      <FolderKanban className="w-3.5 h-3.5 text-indigo-400/70" />
                      当前空间：<span className="text-indigo-400/80 font-medium">{space}</span>
                      <span className="text-[#4a4a5a]">｜ 所有对话、生成产物都会归属在此空间，产物自动入库知识库</span>
                    </div>
                    <button
                      className="flex items-center gap-1.5 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                      onClick={openFilePicker}
                      title="上传代码 / 工程文件"
                    >
                      <Upload className="w-3 h-3" />
                      小提示：上传代码 / 工程结构文件，智能体可以直接做页面展示与改动梳理
                    </button>
                  </div>
                  )}

                  {/* 快捷指令标题 + 收起 */}
                  <div className="w-full max-w-3xl flex items-center gap-2 mb-3 px-1">
                    <span className="text-[12px] text-[#5a5a70]">快捷指令</span>
                    <button
                      className="ml-auto flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                      onClick={() => setShowExamples(!showExamples)}
                      title={showExamples ? '收起快捷指令' : '展开快捷指令'}
                    >
                      {showExamples ? '收起' : '展开'}
                      <ChevronDown className={cn('w-3 h-3 transition-transform', !showExamples && 'rotate-180')} />
                    </button>
                  </div>

                  {/* 快捷指令卡片（横向 3 列） */}
                  {showExamples && (
                  <div className="w-full max-w-3xl grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-8">
                    {examples.map((prompt, i) => (
                      <button
                        key={i}
                        className="w-full text-left px-3.5 py-3 rounded-xl bg-[#16161e] border border-[#252530] text-[12px] leading-snug text-[#cdd3e0] hover:border-indigo-500/30 hover:bg-indigo-500/5 transition-all flex items-start justify-between gap-2"
                        onClick={() => { setInput(prompt); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }}
                      >
                        <span className="flex items-start gap-1.5">
                          <span className="text-indigo-400 shrink-0 mt-px">•</span>
                          {prompt}
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-[#5a5a70] shrink-0 mt-px" />
                      </button>
                    ))}
                  </div>
                  )}

                  {/* 技能按钮分组：技能集默认折叠，展开后展示两组技能 */}
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
                      <div className="space-y-4">
                        {skillGroups.map((group, gi) => {
                          const collapsed = collapsedGroups.has(group.label)
                          return (
                            <div key={gi}>
                              <div className="flex items-center justify-between mb-2.5 px-1">
                                <div className="text-[12px] text-[#5a5a70]">{group.label}</div>
                                <button
                                  className="flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                                  onClick={() => toggleGroup(group.label)}
                                >
                                  {collapsed ? '展开' : '收起'}
                                  <ChevronDown className={cn('w-3 h-3 transition-transform', !collapsed && 'rotate-180')} />
                                </button>
                              </div>
                              {!collapsed && (
                                <div className="flex flex-wrap gap-2">
                                  {group.skills.map(skill => (
                                    <span key={skill.label} className="relative group">
                                      <button
                                        className={cn(
                                          'flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] transition-all border',
                                          selectedTags.includes(skill.label)
                                            ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                                            : 'bg-[#16161e] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0] hover:border-[#3a3a45]'
                                        )}
                                        onClick={() => handleQuickScenario(skill.label)}
                                      >
                                        {skill.label}
                                        <ChevronDown className="w-3 h-3 opacity-40" />
                                      </button>
                                      <div className="pointer-events-none invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute top-full left-0 mt-1.5 z-30 px-3 py-1.5 rounded-lg bg-[#1a1a24] border border-[#252530] text-[11px] text-[#9a9aa4] shadow-xl whitespace-nowrap">
                                        {skill.tooltip}
                                      </div>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* ======== 配置资源态（截图2） ======== */
                <div className="flex flex-col px-6 pt-6 pb-4 max-w-3xl mx-auto w-full">
                  {/* 步骤条 */}
                  <div className="flex items-center justify-center gap-0 mb-8">
                    {stepItems.map((step, i) => (
                      <div key={step.key} className="flex items-center">
                        <button
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] transition-colors',
                            i === stepIndex
                              ? 'text-indigo-400 font-medium'
                              : i < stepIndex
                                ? 'text-green-400'
                                : 'text-[#5a5a70]'
                          )}
                          onClick={() => i <= stepIndex && setConfigStep(step.key)}
                        >
                          {i < stepIndex ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <span className={cn(
                              'w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-medium border',
                              i === stepIndex
                                ? 'border-indigo-500 bg-indigo-500/15 text-indigo-400'
                                : 'border-[#2a2a35] text-[#5a5a70]'
                            )}>
                              {i + 1}
                            </span>
                          )}
                          {step.label}
                        </button>
                        {i < stepItems.length - 1 && (
                          <div className={cn(
                            'w-8 h-px mx-1',
                            i < stepIndex ? 'bg-green-500/40' : 'bg-[#2a2a35]'
                          )} />
                        )}
                      </div>
                    ))}
                  </div>

                  {/* 配置任务资源 */}
                  <div className="space-y-4">
                    <h3 className="text-[14px] font-semibold text-[#e4e4e9] flex items-center gap-2">
                      <Settings className="w-4 h-4 text-indigo-400" />
                      配置任务资源
                    </h3>

                    {/* 数据源 */}
                    <div className="rounded-xl border border-[#252530] bg-[#16161e] p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Database className="w-4 h-4 text-[#8b8b9e]" />
                        <span className="text-[13px] font-medium text-[#cdd3e0]">数据源</span>
                      </div>
                      <div className="space-y-2">
                        {dataSources.map(ds => (
                          <div key={ds.id} className="flex items-center justify-between">
                            <select className="flex-1 h-9 px-3 rounded-lg bg-[#1a1a24] border border-[#252530] text-[13px] text-[#cdd3e0] focus:outline-none focus:border-indigo-500/40 appearance-none cursor-pointer">
                              <option>{ds.name}</option>
                            </select>
                            {ds.connected && (
                              <span className="ml-3 inline-flex items-center gap-1 text-[11px] text-green-400 bg-green-500/10 px-2.5 py-1 rounded-full">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                已连通
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 智能体 */}
                    <div className="rounded-xl border border-[#252530] bg-[#16161e] p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Brain className="w-4 h-4 text-[#8b8b9e]" />
                        <span className="text-[13px] font-medium text-[#cdd3e0]">智能体</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {configAgents.map(agent => (
                          <button
                            key={agent.id}
                            className={cn(
                              'px-3.5 py-1.5 rounded-lg text-[12px] transition-all border',
                              agent.selected
                                ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                                : 'bg-[#1a1a24] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0] hover:border-[#3a3a45]'
                            )}
                            onClick={() => toggleAgent(agent.id)}
                          >
                            {agent.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 快速问答提示：知识库与数据源不可用 */}
                    {quickMode && (
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-[12px] text-amber-300/90">
                        <div className="text-[13px] font-medium mb-1 flex items-center gap-1.5">
                          <Zap className="w-4 h-4 text-amber-400" />快速问答模式
                        </div>
                        当前为临时问答：无法加载项目知识库与数据源，涉及该能力的技能将受限；请切换到「项目会话」使用完整能力。
                      </div>
                    )}

                    {/* 知识库（仅项目会话模式） */}
                    {!quickMode && (<div className="rounded-xl border border-[#252530] bg-[#16161e] p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <BookOpen className="w-4 h-4 text-[#8b8b9e]" />
                        <span className="text-[13px] font-medium text-[#cdd3e0]">知识库</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {configKbs.map(kb => (
                          <button
                            key={kb.id}
                            className={cn(
                              'px-3.5 py-1.5 rounded-lg text-[12px] transition-all border',
                              kb.selected
                                ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                                : 'bg-[#1a1a24] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0] hover:border-[#3a3a45]'
                            )}
                            onClick={() => toggleKb(kb.id)}
                          >
                            {kb.name}
                          </button>
                        ))}
                      </div>
                    </div>)}

                    {/* MCP 服务（仅项目会话模式） */}
                    {!quickMode && (<div className="rounded-xl border border-[#252530] bg-[#16161e] p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Plug className="w-4 h-4 text-[#8b8b9e]" />
                          <span className="text-[13px] font-medium text-[#cdd3e0]">MCP服务</span>
                        </div>
                        <button
                          className={cn(
                            'relative w-9 h-5 rounded-full transition-colors',
                            mcpEnabled ? 'bg-green-500' : 'bg-[#2a2a35]'
                          )}
                          onClick={() => setMcpEnabled(!mcpEnabled)}
                        >
                          <div className={cn(
                            'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
                            mcpEnabled ? 'left-4.5' : 'left-0.5'
                          )} />
                        </button>
                      </div>
                      {mcpEnabled && (
                        <div className="flex flex-wrap gap-2">
                          {configMcps.map(mcp => (
                            <button
                              key={mcp.id}
                              className={cn(
                                'px-3.5 py-1.5 rounded-lg text-[12px] transition-all border',
                                mcp.enabled
                                  ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                                  : 'bg-[#1a1a24] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0] hover:border-[#3a3a45]'
                              )}
                              onClick={() => toggleMcpService(mcp.id)}
                            >
                              {mcp.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>)}
                  </div>

                  {/* 任务描述 */}
                  <div className="mt-6">
                    <h3 className="text-[14px] font-semibold text-[#e4e4e9] mb-3 flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-indigo-400" />
                      今天你想做什么？
                    </h3>
                    <Textarea
                      className="w-full min-h-[100px] bg-[#16161e] border border-[#252530] rounded-xl text-[13px] text-[#cdd3e0] placeholder:text-[#4a4a5a] p-4 resize-none focus:outline-none focus:border-indigo-500/40 transition-colors"
                      placeholder="描述你的任务需求，例如：梳理营业系统前端页面展示与布点方案，并生成跨工程改动报告。"
                      value={taskDescription}
                      onChange={e => setTaskDescription(e.target.value)}
                    />
                  </div>

                  {/* 创建任务按钮 */}
                  <div className="flex justify-end mt-4 mb-4">
                    <Button
                      className="h-9 px-6 text-[13px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90"
                      onClick={handleCreateTask}
                      disabled={!taskDescription.trim() && !input.trim()}
                    >
                      <Send className="w-4 h-4 mr-1.5" />
                      创建任务
                    </Button>
                  </div>
                </div>
              )
            ) : (
              /* ======== 对话消息 ======== */
              <div className="flex flex-col p-6 max-w-3xl mx-auto w-full">
                {taskSteps.length > 0 && (
                  <div className="mb-6 p-4 rounded-lg bg-[#16161e] border border-indigo-500/20">
                    <div className="flex items-center gap-2 mb-3">
                      <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                      <span className="text-[13px] font-medium text-[#e4e4e9]">任务执行中</span>
                    </div>
                    <div className="space-y-2">
                      {taskSteps.map((step, i) => (
                        <div key={i} className="flex items-center gap-2 text-[12px]">
                          {step.status === 'done' ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          ) : step.status === 'running' ? (
                            <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
                          ) : (
                            <Clock className="w-3.5 h-3.5 text-[#5a5a70] shrink-0" />
                          )}
                          <span className={cn(
                            step.status === 'done' ? 'text-green-400' :
                            step.status === 'running' ? 'text-indigo-400' : 'text-[#8b8b9e]'
                          )}>
                            {step.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((msg, i) => (
                  <div key={i} className={`flex gap-3 mb-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-br from-indigo-500 to-purple-600'
                        : 'bg-[#1e1e28] border border-[#252530]'
                    }`}>
                      {msg.role === 'user' ? (
                        <User className="w-3.5 h-3.5 text-white" />
                      ) : (
                        <Bot className="w-3.5 h-3.5 text-indigo-400" />
                      )}
                    </div>

                    <div className={`relative group max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {msg.role === 'assistant' && isGuidanceMessage(msg.content) ? (
                        <>
                          <div className="px-4 py-3 bg-[#16161e] border border-indigo-500/25 text-[#d4d4dc] rounded-2xl rounded-tl-sm">
                            {introCollapsed.has(i) ? (
                              <div className="flex items-center gap-2 text-[12px] text-[#9a9aa4] py-1">
                                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                                能力介绍已收起，需要时可点击下方「展开介绍」查看。
                              </div>
                            ) : (
                              <MdRender content={msg.content} />
                            )}
                          </div>

                          <div className="mt-2 space-y-2">
                            <button
                              className="flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-indigo-400 transition-colors"
                              onClick={() => toggleIntro(i)}
                            >
                              {introCollapsed.has(i) ? '展开介绍' : '收起介绍'}
                              <ChevronDown className={cn('w-3 h-3 transition-transform', !introCollapsed.has(i) && 'rotate-180')} />
                            </button>

                            {/* 快捷引导按钮：一键填充需求到底部输入框 */}
                            <div className="flex flex-wrap gap-2">
                              <button
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] border bg-[#1a1a24] border-[#2a2a35] text-[#9a9aa4] hover:text-indigo-400 hover:border-indigo-500/40 transition-colors"
                                onClick={() => quickFill('请帮我分析下面这段 JDBC 代码的跨工程改造，并输出改造建议：\n\n[请在此粘贴你的 JDBC / MyBatis 代码]')}
                              >
                                <ClipboardPaste className="w-3 h-3" />
                                粘贴 JDBC 代码
                              </button>
                              <button
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] border bg-[#1a1a24] border-[#2a2a35] text-[#9a9aa4] hover:text-indigo-400 hover:border-indigo-500/40 transition-colors"
                                onClick={() => openFilePicker()}
                                title="上传代码 / 工程文件"
                              >
                                <FileUp className="w-3 h-3" />
                                上传 SQL 脚本文件
                              </button>
                              <button
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] border bg-[#1a1a24] border-[#2a2a35] text-[#9a9aa4] hover:text-indigo-400 hover:border-indigo-500/40 transition-colors"
                                onClick={() => quickFill('参考示例：请梳理本系统跨工程页面展示与下单拆单的代码改动点，输出改动清单与涉及文件。\n\n[代码/工程资料可粘贴在此]')}
                              >
                                <Eye className="w-3 h-3" />
                                查看改造示例
                              </button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className={`px-4 py-3 text-[13px] leading-relaxed ${
                            msg.role === 'user'
                              ? 'bg-gradient-to-br from-indigo-500 to-indigo-600 text-white rounded-2xl rounded-tr-sm'
                              : 'bg-[#16161e] border border-[#252530] text-[#d4d4dc] rounded-2xl rounded-tl-sm'
                          }`}>
                            {msg.role === 'assistant' ? (
                              <MdRender content={msg.content} />
                            ) : (
                              <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                            )}
                          </div>
                        </>
                      )}

                      {msg.role === 'assistant' && msg.taskChain && msg.taskChain.length > 0 && (
                        <div className="mt-2">
                          <button
                            className="flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-indigo-400 transition-colors"
                            onClick={() => toggleChain(i)}
                          >
                            <ChevronDown className={cn('w-3 h-3 transition-transform', expandedChains.has(i) && 'rotate-180')} />
                            任务执行详情
                          </button>
                          {expandedChains.has(i) && (
                            <div className="mt-1.5 p-3 rounded-lg bg-[#12121a] border border-[#252530] text-[12px]">
                              {msg.taskChain.map((step, si) => (
                                <div key={si} className="flex items-start gap-2 py-1">
                                  {step.status === 'done' ? (
                                    <CheckCircle2 className="w-3 h-3 text-green-400 mt-0.5 shrink-0" />
                                  ) : (
                                    <Clock className="w-3 h-3 text-[#5a5a70] mt-0.5 shrink-0" />
                                  )}
                                  <div>
                                    <span className="text-[#9a9aa4]">{step.label}</span>
                                    {step.detail && (
                                      <span className="text-[#5a5a70] ml-1">「{step.detail}」</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {msg.role === 'assistant' && !isGuidanceMessage(msg.content) && (
                        <div className="absolute -bottom-6 left-0 opacity-0 group-hover:opacity-100 flex items-center gap-3 transition-opacity py-0.5">
                          <button
                            className="flex items-center gap-1 text-[10px] text-[#5a5a70] hover:text-indigo-400 transition-colors"
                            onClick={() => handleCopy(msg.content)}
                          >
                            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                            {copied ? '已复制' : '复制'}
                          </button>
                          <button
                            className={cn(
                              'flex items-center gap-1 text-[10px] transition-colors',
                              savedArtifacts.has(i)
                                ? 'text-green-400'
                                : 'text-[#5a5a70] hover:text-indigo-400'
                            )}
                            onClick={() => toggleArtifactSave(i)}
                            title="保存到右侧产物面板并入库当前空间知识库"
                          >
                            <Save className="w-3 h-3" />
                            {savedArtifacts.has(i) ? '已保存产物' : '保存产物'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {streaming && (
                  <div className="flex gap-3 mb-4">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-[#1e1e28] border border-[#252530]">
                      <Bot className="w-3.5 h-3.5 text-indigo-400" />
                    </div>
                    <div className="max-w-[75%]">
                      {assistantText ? (
                        <div className="px-4 py-3 text-[13px] leading-relaxed bg-[#16161e] border border-[#252530] text-[#d4d4dc] rounded-2xl rounded-tl-sm">
                          <MdRender content={assistantText} />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-[#8b8b9e] bg-[#16161e] border border-[#252530] rounded-2xl rounded-tl-sm">
                          <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
                          正在调度子 Agent 分析 SQL，生成页面展示报告…
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部输入框 */}
          <div className="w-full p-3 border-t border-[#1e1e28] bg-[#0f0f14] flex-shrink-0 flex justify-center">
            <div className="w-full max-w-[42rem] mx-auto">
              <div className="relative bg-[#16161e] border border-[#252530] rounded-xl focus-within:border-indigo-500/40 transition-colors">
                {/* 隐藏文件上传 */}
                <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleFileChange} accept=".sql,.ddl,.docx,.md,.txt,.xlsx,.pdf" />

                {selectedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                    {selectedTags.map(tag => (
                      <div
                        key={tag}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#2a2a35] text-[#cdd3e0] text-[12px]"
                      >
                        <span>{tag}</span>
                        <button
                          className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                          onClick={() => removeTag(tag)}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {(references.length > 0 || attachments.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                    {references.map(r => (
                      <div
                        key={`${r.type}:${r.id}`}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#2a2a35] text-[#cdd3e0] text-[12px]"
                      >
                        <AtSign className="w-3 h-3 text-indigo-400" />
                        <span className="max-w-[140px] truncate">{r.name}</span>
                        <button
                          className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                          onClick={() => setReferences(prev => prev.filter(p => `${p.type}:${p.id}` !== `${r.type}:${r.id}`))}
                          title="移除引用"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {attachments.map(a => (
                      <div
                        key={a.id}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-[#cdd3e0] text-[12px]"
                      >
                        <Paperclip className="w-3 h-3 text-indigo-400" />
                        <span className="max-w-[140px] truncate">{a.name}</span>
                        <span className="text-[10px] text-[#5a5a70]">.{a.file_type}</span>
                        <button
                          className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                          onClick={() => removeAttachment(a.id)}
                          title="移除附件"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {uploadNote && (
                  <div className="px-4 pt-2 text-[11px] text-red-400/90">{uploadNote}</div>
                )}

                <Textarea
                  ref={inputRef}
                  className="bg-transparent border-0 text-[#e4e4e9] placeholder:text-[#4a4a5a] text-[14px] min-h-[60px] max-h-[120px] resize-none pl-4 pr-4 py-4 focus-visible:ring-0 focus-visible:ring-offset-0"
                  placeholder="今天帮你做些什么？"
                  value={input}
                  onChange={e => {
                    setInput(e.target.value)
                    if (e.target.value.endsWith('@')) {
                      setShowRefPicker(true)
                    }
                  }}
                  onKeyDown={handleKeyDown}
                />

                {/* 底部工具栏（所有按钮平铺） */}
                <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
                  {/* 左侧：@ 引用 + 上传 + 智能体 + 技能 + 模型切换 */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    {/* @ 引用 / + 上传 */}
                    <button
                      className="flex items-center justify-center h-7 w-7 rounded-lg text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                      onClick={() => setShowRefPicker(true)}
                      title="@ 引用资源"
                    >
                      <AtSign className="w-4 h-4" />
                    </button>
                    <button
                      className="flex items-center justify-center h-7 w-7 rounded-lg text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors disabled:opacity-60"
                      onClick={openFilePicker}
                      disabled={uploading}
                      title={uploading ? '上传中…' : '上传附件（.sql/.ddl/.docx/.md/.txt/.xlsx/.pdf）'}
                    >
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    </button>
                    <div className="w-px h-4 bg-[#2a2a35] mx-1" />

                    {/* 智能体下拉：联动 activeAgent */}
                    <div className="relative" ref={agentDrpRef}>
                      <button
                        className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                        onClick={() => setShowAgentDrp(!showAgentDrp)}
                        title="切换当前对话使用的智能体"
                      >
                        <Bot className="w-3 h-3 text-indigo-400 shrink-0" />
                        <span className="max-w-[96px] truncate">{agents.find(a => a.id === activeAgent)?.name ?? '智能体'}</span>
                        <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', showAgentDrp && 'rotate-180')} />
                      </button>
                      {showAgentDrp && (
                        <div className="absolute left-0 bottom-full mb-1 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-44 py-1.5 overflow-hidden">
                          <div className="px-3 pb-1 text-[11px] text-[#5a5a70]">内置智能体</div>
                          {agents.slice(0, 2).map(a => (
                            <button
                              key={a.id}
                              className={cn(
                                'w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors',
                                a.id === activeAgent ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                              )}
                              onClick={() => { setActiveAgent?.(a.id); setShowAgentDrp(false) }}
                            >
                              <span className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0" style={{ backgroundColor: (a.color || '#6366f1') + '20', color: a.color || '#6366f1' }}>
                                {a.name[0]}
                              </span>
                              <span className="truncate">{a.name}</span>
                            </button>
                          ))}
                          <div className="px-3 pt-1.5 pb-1 text-[11px] text-[#5a5a70] border-t border-[#252530]">企业专属智能体</div>
                          {agents.slice(2).map(a => (
                            <button
                              key={a.id}
                              className={cn(
                                'w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors',
                                a.id === activeAgent ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                              )}
                              onClick={() => { setActiveAgent?.(a.id); setShowAgentDrp(false) }}
                            >
                              <span className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0" style={{ backgroundColor: (a.color || '#6366f1') + '20', color: a.color || '#6366f1' }}>
                                {a.name[0]}
                              </span>
                              <span className="truncate">{a.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 技能下拉：localStorage 记忆 */}
                    <div className="relative" ref={skillDrpRef}>
                      <button
                        className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                        onClick={() => setShowSkillDrp(!showSkillDrp)}
                        title="选择技能，发送消息时自动带入技能上下文"
                      >
                        <Hammer className="w-3 h-3 text-indigo-400 shrink-0" />
                        <span className={cn('max-w-[96px] truncate', !lastSkill && 'text-[#5a5a70]')}>{lastSkill || '技能'}</span>
                        <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', showSkillDrp && 'rotate-180')} />
                      </button>
                      {showSkillDrp && (
                        <div className="absolute left-0 bottom-full mb-1 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-52 py-1.5 overflow-hidden">
                          {skillGroups.map(g => (
                            <div key={g.label}>
                              <div className="px-3 pt-1.5 pb-1 text-[11px] text-[#5a5a70]">{g.label}</div>
                              {g.skills.map(s => (
                                <button
                                  key={s.label}
                                  className={cn(
                                    'w-full text-left px-3 py-2 text-[12px] transition-colors',
                                    lastSkill === s.label ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                                  )}
                                  onClick={() => selectSkill(s.label)}
                                >
                                  {s.label}
                                </button>
                              ))}
                            </div>
                          ))}
                          {lastSkill && (
                            <button
                              className="w-full text-left px-3 pt-2 pb-1.5 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] border-t border-[#252530] transition-colors"
                              onClick={() => selectSkill('')}
                            >
                              清除技能
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 模型切换下拉 */}
                    <div className="relative" ref={modelDrpRef}>
                    <button
                      className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                      onClick={() => setShowModelDrp(!showModelDrp)}
                      title="切换本次对话使用的模型"
                    >
                      <Cpu className="w-3 h-3 text-indigo-400" />
                      {model}
                      <ChevronDown className={cn('w-3 h-3 transition-transform', showModelDrp && 'rotate-180')} />
                    </button>
                    {showModelDrp && (
                      <div className="absolute left-0 bottom-full mb-1 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-48 py-1 overflow-hidden">
                        {models.length === 0 ? (
                          <div className="px-3 py-2 text-[11px] text-[#5a5a70]">无可用模型</div>
                        ) : models.map(m => (
                          <button
                            key={m}
                            className={cn(
                              'w-full text-left px-3 py-2 text-[12px] transition-colors',
                              m === model ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                            )}
                            onClick={() => { setModel(m); setShowModelDrp(false) }}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {streaming ? (
                      <Button
                        size="icon"
                        className="h-8 w-8 rounded-full bg-red-500/80 text-white hover:bg-red-500 p-0"
                        onClick={stop}
                        title="中止生成"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="1" />
                        </svg>
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        className={`h-8 w-8 rounded-full ${
                          input.trim() || selectedTags.length > 0 || uploadedFiles.length > 0 || references.length > 0 || attachments.length > 0
                            ? 'bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white'
                            : 'bg-[#2a2a35] text-[#4a4a5a]'
                        }`}
                        disabled={!input.trim() && selectedTags.length === 0 && uploadedFiles.length === 0 && references.length === 0 && attachments.length === 0}
                        onClick={handleSend}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-1.5 text-center text-[10px] text-[#5a5a70]">
                内容由 AI 生成，请核实重要信息
              </div>
            </div>
          </div>
        </div>

        {/* 右侧面板：产物面板 */}
        {showRightPanel && (
          <ArtifactPanel
            convId={convId}
            onClose={() => setShowRightPanel(false)}
            space={space}
            activeAgent={activeAgent}
            quickMode={quickMode}
            onReference={name => {
               setInput(prev => prev + `@${name} `)
               showToast(`已引用「${name}」到对话，可继续让 Agent 迭代`)
             }}
          />
        )}
      </div>

      {/* @ 引用资源选择器 */}
      <ReferencePicker
        open={showRefPicker}
        onClose={() => setShowRefPicker(false)}
        onConfirm={refs => {
          if (refs.length === 0) return
          setReferences(prev => {
            const merged = [...prev]
            for (const r of refs) {
              const key = `${r.type}:${r.id}`
              if (!merged.some(p => `${p.type}:${p.id}` === key)) merged.push(r)
            }
            return merged
          })
          setInput(prev => prev + refs.map(r => `@${r.name}`).join(' ') + ' ')
        }}
        convId={convId}
        spaceId={convInfo?.space_id ?? realSpace?.id ?? null}
      />

      {/* ======== Toast ======== */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] px-4 py-2 rounded-lg bg-[#1a1a24] border border-indigo-500/40 text-[12px] text-[#cdd3e0] shadow-xl">
          {toast}
        </div>
      )}

      {/* ======== 快速问答 → 项目会话 ======== */}
      <ConvertToProjectDialog
        open={convertOpen}
        spaces={spacesForConvert}
        onClose={() => setConvertOpen(false)}
        onConfirm={async (spaceId) => {
          if (!convId) return
          await onConvertToProject?.(spaceId)
          setConvertOpen(false)
          showToast('已转为项目会话，产物入库与空间知识库/数据源能力已解锁')
        }}
      />

      {/* ======== 新建任务（场景 B / A） ======== */}
      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        context={realSpace
          ? { space: realSpace, agentId: activeAgent, convId: convId ?? undefined }
          : undefined}
        agents={agents}
        onCreate={(task, enterSession) => {
          setNewTaskOpen(false)
          if (enterSession) {
            if (convId != null) {
              // 挂载到当前会话
              api.attachTask(convId, { task_id: task.id }).then(() => {
                api.getConversation(convId).then(r => { if (r.success) setConvInfo(r.data ?? null) })
              }).catch(() => {})
            } else {
              // 全新对话：创建任务内会话并进入
              api.createConversation(task.name, {
                space_id: task.space_id, task_id: task.id,
              }).then(r => { if (r.success && r.data) onConvCreated?.(r.data.id) }).catch(() => {})
            }
          }
        }}
      />

      {/* ======== 另存为任务 ======== */}
      {attachOpen && (
        <AttachTaskDialog
          open
          onClose={() => setAttachOpen(false)}
          convId={convId}
          spaceId={convInfo?.space_id ?? undefined}
          onAttached={(d) => {
            setAttachOpen(false)
            setConvInfo(prev => prev ? { ...prev, task_id: d.task_id, task_name: d.task_name } : prev)
          }}
        />
      )}
    </div>
  )
}
