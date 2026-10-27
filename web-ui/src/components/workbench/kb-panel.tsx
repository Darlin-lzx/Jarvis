import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { KBDocument, KnowledgeBaseInfo, KnowledgeSearchHit } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  Database, FileText, Layers, Search, Settings,
  Upload, Trash2, RefreshCw, Plus, Search as SearchIcon,
  FileText as FileIcon, Eye, Edit3, Ban,
  CheckCircle, ToggleLeft, Link2, Sliders, Cpu, Shield,
  ArrowRight, ArrowDown, Sparkles, ChevronRight
} from 'lucide-react'

type Tab = 'list' | 'docs' | 'chunks' | 'search' | 'settings'

const BUSINESS_DOMAINS = [
  { value: 'db_migrate', label: '跨工程迭代' },
  { value: 'sql_audit', label: 'SQL 审计' },
  { value: 'code_change', label: '跨工程改造' },
  { value: 'db_inspect', label: '数据库巡检' },
]

const KNOWLEDGE_TYPES = [
  { value: 'rules', label: '规则库' },
  { value: 'cases', label: '案例库' },
  { value: 'doc', label: '实施文档' },
  { value: 'ops', label: '运维手册' },
]

const CONFIDENCE_OPTIONS = [
  { value: 'verified', label: '已验证' },
  { value: 'human_authority', label: '人工权威' },
  { value: 'pending_review', label: '待复核' },
  { value: 'model_generated', label: '模型生成' },
]

const CONFIDENCE_LABEL: Record<string, string> = Object.fromEntries(
  CONFIDENCE_OPTIONS.map(item => [item.value, item.label])
)

interface KnowledgeUploadMeta {
  kb_type: string
  businessDomain: string
  target_db: string
  stage: string
  object_type: string
  confidence: string
  source_ref: string
}

const DEFAULT_UPLOAD_META: KnowledgeUploadMeta = {
  kb_type: 'doc', businessDomain: 'db_migrate', target_db: '',
  stage: '', object_type: '', confidence: 'verified', source_ref: '',
}

const subTabs: {
  id: Tab
  label: string
  icon: React.ElementType
  color: string
  actions: { label: string; icon: React.ElementType; color?: string }[]
}[] = [
  {
    id: 'list',
    label: '知识库列表',
    icon: Database,
    color: '#3b82f6',
    actions: [
      { label: '创建知识库', icon: Plus },
      { label: '启用/禁用', icon: ToggleLeft },
      { label: '绑定Agent', icon: Link2, color: '#22c55e' },
    ],
  },
  {
    id: 'docs',
    label: '文档管理',
    icon: FileText,
    color: '#f59e0b',
    actions: [
      { label: '上传文档', icon: Upload },
      { label: '新建文本', icon: FileIcon },
      { label: '重新解析', icon: RefreshCw },
    ],
  },
  {
    id: 'chunks',
    label: '分段管理',
    icon: Layers,
    color: '#8b5cf6',
    actions: [
      { label: '查看Chunk', icon: Eye },
      { label: '编辑分段', icon: Edit3 },
      { label: '禁用分段', icon: Ban },
    ],
  },
  {
    id: 'search',
    label: '检索测试',
    icon: Search,
    color: '#06b6d4',
    actions: [
      { label: '输入Query', icon: SearchIcon },
      { label: '查看召回结果', icon: Eye },
      { label: '调试阈值', icon: Sliders },
    ],
  },
  {
    id: 'settings',
    label: '知识库设置',
    icon: Settings,
    color: '#6366f1',
    actions: [
      { label: '分块参数', icon: Sliders },
      { label: '向量模型', icon: Cpu },
      { label: '权限配置', icon: Shield },
    ],
  },
]

export function KBPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('list')
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [kbs, setKbs] = useState<KnowledgeBaseInfo[]>([])
  const [selectedKb, setSelectedKb] = useState<number | ''>('')
  const [searchQ, setSearchQ] = useState('')
  const [showVectorInfo, setShowVectorInfo] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadMeta, setUploadMeta] = useState<KnowledgeUploadMeta>(DEFAULT_UPLOAD_META)

  const load = async () => {
    const r = await api.listDocuments(undefined, undefined, selectedKb || undefined)
    if (r.success) setDocs((r.data as KBDocument[]) || [])
  }
  useEffect(() => { api.listKbs().then(r => { if (r.success) setKbs((r.data as KnowledgeBaseInfo[]) || []) }).catch(() => {}) }, [])
  useEffect(() => { load() }, [selectedKb])

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    const r = await api.uploadDocument(file, {
      kb_id: selectedKb || undefined,
      kb_type: uploadMeta.kb_type,
      business_domain: uploadMeta.businessDomain,
      target_db: uploadMeta.target_db,
      stage: uploadMeta.stage,
      object_type: uploadMeta.object_type,
      confidence: uploadMeta.confidence,
      source: 'human',
      source_ref: uploadMeta.source_ref,
    })
    if (r.success) {
      if (fileRef.current) fileRef.current.value = ''
      load()
      const d = r.data as { embed_error?: string } | null
      if (d?.embed_error) alert('文档已保存，但向量化失败（embedding 服务暂不可用），可稍后在文档详情中重解析。')
    }
    else alert('上传失败: ' + (r.detail || '未知错误'))
  }
  const handleDelete = async (id: number) => {
    if (!confirm('删除该文档？')) return
    await api.deleteDocument(id)
    load()
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252530]">
        <h1 className="text-lg font-semibold text-[#e4e4e9]">知识库管理</h1>
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#5a5a70]" />
          <Input
            className="w-56 bg-[#16161e] border-[#252530] pl-9 text-[13px]"
            placeholder="搜索知识库..."
          />
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：子页面卡片 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-5 gap-4 mb-6">
            {subTabs.map(tab => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'bg-[#16161e] border rounded-xl p-4 text-left transition-all',
                    isActive
                      ? 'border-indigo-500/50 ring-1 ring-indigo-500/20'
                      : 'border-[#252530] hover:border-[#3a3a45]'
                  )}
                >
                  {/* 标题 */}
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      className="w-6 h-6 rounded flex items-center justify-center"
                      style={{ backgroundColor: tab.color + '20' }}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: tab.color }} />
                    </div>
                    <span className="text-[13px] font-medium text-[#e4e4e9]">{tab.label}</span>
                  </div>

                  {/* 图标 */}
                  <div className="flex justify-center mb-3">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center"
                      style={{ backgroundColor: tab.color + '15' }}
                    >
                      <Icon className="w-6 h-6" style={{ color: tab.color }} />
                    </div>
                  </div>

                  {/* 操作项 */}
                  <div className="space-y-1.5">
                    {tab.actions.map((action, i) => {
                      const AIcon = action.icon
                      return (
                        <div
                          key={i}
                          className={cn(
                            'flex items-center gap-1.5 text-[12px] px-2 py-1 rounded',
                            action.color
                              ? 'bg-green-500/10 text-green-400'
                              : 'text-[#9a9aa4]'
                          )}
                        >
                          <AIcon className="w-3 h-3" />
                          <span>{action.label}</span>
                        </div>
                      )
                    })}
                  </div>
                </button>
              )
            })}
          </div>

          {/* 当前选中子页面内容 */}
          <div className="bg-[#16161e] border border-[#252530] rounded-xl p-6">
            {activeTab === 'list' && <KBListContent docCount={docs.length} onGoDocs={() => setActiveTab('docs')} />}
            {activeTab === 'docs' && (
              <DocsContent
                docs={docs}
                kbs={kbs}
                selectedKb={selectedKb}
                onKbChange={setSelectedKb}
                fileRef={fileRef}
                uploadMeta={uploadMeta}
                setUploadMeta={setUploadMeta}
                onUpload={handleUpload}
                onDelete={handleDelete}
                onRefresh={load}
                onGoList={() => setActiveTab('list')}
              />
            )}
            {activeTab === 'chunks' && <ChunksContent docs={docs} />}
            {activeTab === 'search' && (
              <SearchContent
                searchQ={searchQ}
                setSearchQ={setSearchQ}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsContent
                onGoList={() => setActiveTab('list')}
              />
            )}
          </div>
        </div>

        {/* 右侧：数据与联动（交互式流转导航面板） */}
        <div className="w-64 border-l border-[#252530] bg-[#0f0f14] p-5 flex-shrink-0 overflow-y-auto">
          <h3 className="text-[14px] font-semibold text-[#e4e4e9] mb-4">数据与联动</h3>

          {/* 状态指示器 */}
          <div className="mb-4 p-2.5 bg-[#16161e] border border-[#252530] rounded-lg">
            <div className="text-[11px] text-[#5a5a70] mb-2">当前文档状态</div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-[12px] text-green-400 font-medium">已入库</span>
            </div>
          </div>

          <div className="flex flex-col items-center">
            {/* 原始文档（不可点击） */}
            <div className="group flex flex-col items-center cursor-default">
              <div className="w-12 h-12 rounded-xl bg-[#16161e] border border-[#252530] flex items-center justify-center mb-2 transition-all group-hover:border-[#3a3a4a]">
                <FileText className="w-6 h-6 text-[#5a5a70]" />
              </div>
              <span className="text-[12px] text-[#9a9aa4]">原始文档</span>
              <span className="text-[10px] text-[#3a3a4a] mt-0.5">不可点击</span>
            </div>

            <ArrowDown className="w-4 h-4 text-[#3a3a4a] my-2" />

            {/* 分段Chunk（可点击） */}
            <button
              className="group flex flex-col items-center transition-all hover:scale-105"
              onClick={() => setActiveTab('chunks')}
              title="查看、编辑文档的文本分段"
            >
              <div className="w-12 h-12 rounded-xl bg-[#16161e] border border-[#252530] flex items-center justify-center mb-2 transition-all group-hover:border-purple-500/50 group-hover:bg-purple-500/10">
                <Layers className="w-6 h-6 text-[#5a5a70] group-hover:text-purple-400 transition-colors" />
              </div>
              <span className="text-[12px] text-[#9a9aa4] group-hover:text-purple-400 transition-colors">分段Chunk</span>
              <span className="text-[10px] text-[#3a3a4a] mt-0.5">可点击 → 跳转Chunk管理页</span>
            </button>

            <div className="flex items-center gap-4 my-2">
              <ArrowDown className="w-4 h-4 text-[#3a3a4a]" />
              <ArrowRight className="w-4 h-4 text-[#3a3a4a]" />
            </div>

            <div className="flex items-center gap-8 w-full justify-center">
              {/* 向量库索引（可点击，弹出信息） */}
              <button
                className="group flex flex-col items-center transition-all hover:scale-105"
                onClick={() => setShowVectorInfo(true)}
                title="查看向量入库状态"
              >
                <div className="w-12 h-12 rounded-xl bg-[#16161e] border border-[#252530] flex items-center justify-center mb-2 transition-all group-hover:border-blue-500/50 group-hover:bg-blue-500/10">
                  <Database className="w-6 h-6 text-[#5a5a70] group-hover:text-blue-400 transition-colors" />
                </div>
                <span className="text-[12px] text-[#9a9aa4] text-center group-hover:text-blue-400 transition-colors">向量库索引</span>
                <span className="text-[10px] text-[#3a3a4a] mt-0.5">点击弹出向量信息</span>
              </button>

              {/* Agent检索调用（可点击，跳转检索测试） */}
              <button
                className="group flex flex-col items-center transition-all hover:scale-105"
                onClick={() => setActiveTab('search')}
                title="进入 RAG 测试面板，模拟 Agent 检索效果"
              >
                <div className="w-12 h-12 rounded-xl bg-[#16161e] border border-[#252530] flex items-center justify-center mb-2 transition-all group-hover:border-cyan-500/50 group-hover:bg-cyan-500/10">
                  <Sparkles className="w-6 h-6 text-[#5a5a70] group-hover:text-cyan-400 transition-colors" />
                </div>
                <span className="text-[12px] text-[#9a9aa4] text-center group-hover:text-cyan-400 transition-colors">Agent<br/>检索调用</span>
                <span className="text-[10px] text-[#3a3a4a] mt-0.5">可点击 → 跳转检索测试页</span>
              </button>
            </div>
          </div>

          {/* 流程说明 */}
          <div className="mt-8 space-y-3">
            <div className="text-[11px] text-[#5a5a70] leading-relaxed">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                <span>文档上传后自动分块并向量化</span>
              </div>
            </div>
            <div className="text-[11px] text-[#5a5a70] leading-relaxed">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                <span>分块结果存入 FAISS 向量库</span>
              </div>
            </div>
            <div className="text-[11px] text-[#5a5a70] leading-relaxed">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                <span>Agent 执行时通过 RAG 检索相关知识</span>
              </div>
            </div>
            <div className="text-[11px] text-[#5a5a70] leading-relaxed">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                <span>知识图谱提供多维度推理辅助</span>
              </div>
            </div>
          </div>

          {/* 向量信息弹窗 */}
          {showVectorInfo && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowVectorInfo(false)}>
              <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9] mb-4">向量库信息</h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center py-2 border-b border-[#252530]">
                    <span className="text-[12px] text-[#9a9aa4]">向量库名称</span>
                    <span className="text-[12px] text-[#e4e4e9] font-mono">backend_dev</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-[#252530]">
                    <span className="text-[12px] text-[#9a9aa4]">向量数量</span>
                    <span className="text-[12px] text-[#e4e4e9]">346</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-[#252530]">
                    <span className="text-[12px] text-[#9a9aa4]">Embedding 模型</span>
                    <span className="text-[12px] text-[#e4e4e9]">text-embedding-v3</span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-[12px] text-[#9a9aa4]">存储引擎</span>
                    <span className="text-[12px] text-[#e4e4e9]">FAISS</span>
                  </div>
                </div>
                <div className="mt-5 flex justify-end">
                  <Button size="sm" onClick={() => setShowVectorInfo(false)}>关闭</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---- 知识库列表内容 ---- */
interface KBItem {
  id: number
  name: string
  agentNames: string[]
  desc: string
  docs: number
  chunks: number
  status: '启用' | '禁用'
  created: string
}

function toKBItem(kb: KnowledgeBaseInfo): KBItem {
  return {
    id: kb.id,
    name: kb.name,
    agentNames: kb.bound_agent_names || [],
    desc: kb.description || '',
    docs: kb.doc_count || 0,
    chunks: kb.chunk_count || 0,
    status: kb.enabled === false ? '禁用' as const : '启用' as const,
    created: kb.created_at ? kb.created_at.split('T')[0] : '',
  }
}

function KBListContent({ onGoDocs }: { docCount: number; onGoDocs: () => void }) {
  const [mockKBs, setMockKBs] = useState<KBItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<number[]>([])
  const [statusFilter, setStatusFilter] = useState('全部')
  const [searchQ, setSearchQ] = useState('')
  const [showBatchMenu, setShowBatchMenu] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKBName, setNewKBName] = useState('')
  const [newKBDesc, setNewKBDesc] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<number | null>(null)

  // 加载真实知识库数据
  const loadKBs = () => {
    api.listKbs().then(r => {
      if (r.success) {
        const items: KBItem[] = (r.data || []).map(toKBItem)
        setMockKBs(items)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { loadKBs() }, [])

  const filtered = mockKBs.filter(kb => {
    if (statusFilter !== '全部' && kb.status !== statusFilter) return false
    if (searchQ && !kb.name.includes(searchQ)
      && !kb.agentNames.some(name => name.includes(searchQ))) return false
    return true
  })

  const total = filtered.length
  const totalPages = Math.ceil(total / pageSize)
  const paginated = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const toggleAll = () => {
    setSelected(selected.length === filtered.length ? [] : filtered.map(k => k.id))
  }
  const toggleOne = (id: number) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const toggleKBStatus = (id: number) => {
    setMockKBs(prev => prev.map(kb =>
      kb.id === id ? { ...kb, status: kb.status === '启用' ? '禁用' as const : '启用' as const } : kb
    ))
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">知识库列表</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={() => setShowCreateModal(true)}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            新建知识库
          </Button>
          <div className="relative">
            <Button size="sm" variant="outline" onClick={() => setShowBatchMenu(!showBatchMenu)} className="text-[12px]">
              批量操作
              <ChevronRight className="w-3 h-3 ml-1 rotate-90" />
            </Button>
            {showBatchMenu && (
              <div className="absolute right-0 top-full mt-1 bg-[#1e1e2a] border border-[#2a2a35] rounded-lg shadow-xl z-50 py-1 min-w-[120px]">
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]">批量启用</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]">批量禁用</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#f56c6c] hover:bg-red-500/10">批量删除</button>
              </div>
            )}
          </div>
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5a5a70]" />
            <Input
              className="w-44 bg-[#1a1a24] border-[#252530] pl-8 text-[12px] h-8"
              placeholder="按名称/标识搜索..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-[#5a5a70]">筛选:</span>
        <div className="flex items-center gap-1">
          <span className="text-[#9a9aa4]">状态</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none"
          >
            <option>全部</option>
            <option>启用</option>
            <option>禁用</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[#9a9aa4]">创建时间范围</span>
          <input type="date" className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none" />
          <span className="text-[#5a5a70]">~</span>
          <input type="date" className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none" />
        </div>
        {selected.length > 0 && (
          <span className="text-indigo-400 ml-2">已选 {selected.length} 项</span>
        )}
      </div>

      {/* 表格 */}
      <div className="border border-[#252530] rounded-lg overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-sm text-[#5a5a70]">加载中...</div>
        ) : (
          <>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#1a1a24] border-b border-[#252530]">
                  <th className="w-10 px-3 py-2.5 text-left">
                    <input
                      type="checkbox"
                      checked={selected.length === paginated.length && paginated.length > 0}
                      onChange={toggleAll}
                      className="accent-indigo-500"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">知识库名称</th>
                  <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">绑定智能体</th>
                  <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">文档数量</th>
                  <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">片段总数</th>
                  <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">状态</th>
                  <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">创建时间</th>
                  <th className="px-3 py-2.5 text-right text-[12px] font-medium text-[#9a9aa4]">操作</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(kb => (
              <tr key={kb.id} className={cn(
                'border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors',
                selected.includes(kb.id) && 'bg-indigo-500/5'
              )}>
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.includes(kb.id)}
                    onChange={() => toggleOne(kb.id)}
                    className="accent-indigo-500"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <button
                    className="flex items-center gap-2 hover:text-indigo-400 transition-colors text-left"
                    onClick={onGoDocs}
                  >
                    <Database className="w-4 h-4 text-indigo-400" />
                    <span className="font-medium text-[#e4e4e9]">{kb.name}</span>
                  </button>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1">
                    {kb.agentNames.length ? kb.agentNames.map(name => (
                      <span key={name} className="text-[11px] text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded">
                        {name}
                      </span>
                    )) : <span className="text-[12px] text-[#5a5a70]">未绑定</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center text-[#e4e4e9]">{kb.docs}</td>
                <td className="px-3 py-2.5 text-center text-[#e4e4e9]">{kb.chunks}</td>
                <td className="px-3 py-2.5 text-center">
                  <Badge className={cn('text-[11px] border-0', kb.status === '启用' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400')}>
                    {kb.status}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 text-[#9a9aa4]">{kb.created}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors" onClick={onGoDocs}>查看文档</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">编辑</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-cyan-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">检索测试</button>
                    <button
                      className={cn(
                        'text-[12px] px-1.5 py-0.5 rounded transition-colors',
                        kb.status === '启用'
                          ? 'text-gray-400 hover:text-yellow-400 hover:bg-yellow-500/10'
                          : 'text-green-400 hover:text-green-300 hover:bg-green-500/10'
                      )}
                      onClick={() => toggleKBStatus(kb.id)}
                    >
                      {kb.status === '启用' ? '禁用' : '启用'}
                    </button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-500/10 transition-colors" onClick={() => setShowDeleteConfirm(kb.id)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {paginated.length === 0 && (
          <div className="text-center py-8 text-sm text-[#5a5a70]">无匹配结果</div>
        )}
          </>
        )}
      </div>

      {/* 多 Agent 系统关联提示 */}
      <div className="flex items-start gap-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3">
        <div className="w-1 h-full min-h-[16px] bg-indigo-500/50 rounded-full mt-0.5" />
        <div className="text-[12px] text-[#9a9aa4] leading-relaxed">
          <span className="text-indigo-400 font-medium">提示：</span>
          子 Agent 在配置时，可以绑定知识库唯一标识，仅允许检索绑定的知识库，实现知识隔离。
        </div>
      </div>

      {/* 分页组件 */}
      {total > 0 && (
        <div className="flex items-center justify-between pt-2">
          <div className="text-[12px] text-[#5a5a70]">
            共 <span className="text-[#9a9aa4] font-medium">{total}</span> 条
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className={cn(
                'px-2.5 py-1 text-[12px] rounded border transition-colors',
                currentPage === 1
                  ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed'
                  : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400'
              )}
            >
              上一页
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={cn(
                  'w-7 h-7 text-[12px] rounded border transition-colors',
                  currentPage === page
                    ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400'
                    : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400'
                )}
              >
                {page}
              </button>
            ))}
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className={cn(
                'px-2.5 py-1 text-[12px] rounded border transition-colors',
                currentPage === totalPages
                  ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed'
                  : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400'
              )}
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowDeleteConfirm(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">确认删除知识库？</h3>
                <p className="text-[12px] text-[#9a9aa4] mt-1">删除后所有文档、chunk、向量数据将全部清除，不可恢复</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowDeleteConfirm(null)}>取消</Button>
              <Button size="sm" className="bg-red-500 text-white hover:bg-red-600"
                onClick={() => {
                  if (showDeleteConfirm === null) return
                  api.deleteKb(showDeleteConfirm).then(r => {
                    if (r.success) {
                      setShowDeleteConfirm(null)
                      // 重新加载列表
                      loadKBs()
                    }
                  })
                }}>确认删除</Button>
            </div>
          </div>
        </div>
      )}

      {/* 新建知识库弹窗 */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowCreateModal(false)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[480px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">新建知识库</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">知识库名称 *</label>
                <Input
                  className="bg-[#16161e] border-[#252530] text-[13px]"
                  placeholder="请输入知识库名称"
                  value={newKBName}
                  onChange={e => setNewKBName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">描述</label>
                <textarea
                  className="w-full h-16 bg-[#16161e] border border-[#252530] rounded-lg p-2.5 text-[13px] text-[#e4e4e9] placeholder-[#5a5a70] resize-none focus:outline-none focus:border-indigo-500/50"
                  placeholder="知识库描述（可选）"
                  value={newKBDesc}
                  onChange={e => setNewKBDesc(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowCreateModal(false)}>取消</Button>
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white"
                onClick={() => {
                  if (!newKBName.trim()) return
                  api.createKb({ name: newKBName.trim(), description: newKBDesc.trim() }).then(r => {
                    if (r.success) {
                      setShowCreateModal(false)
                      setNewKBName('')
                      setNewKBDesc('')
                      // 重新加载列表
                      loadKBs()
                    }
                  })
                }}>创建</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- 文档管理内容 ---- */
type DocStatus = '待解析' | '解析中' | '已入库' | '解析失败'

interface DocRow {
  id: number
  name: string
  type: string
  chunks: number
  status: DocStatus
  updated: string
  business_domain: string
  kb_type: string
  confidence: string
  review_required: boolean
  source_ref: string
}

function DocsContent({
  fileRef, onUpload, onGoList, docs: realDocs, uploadMeta, setUploadMeta,
  kbs, selectedKb, onKbChange, onDelete
}: {
  docs: KBDocument[]
  kbs: KnowledgeBaseInfo[]
  selectedKb: number | ''
  onKbChange: (kb: number | '') => void
  fileRef: React.RefObject<HTMLInputElement | null>
  uploadMeta: KnowledgeUploadMeta
  setUploadMeta: React.Dispatch<React.SetStateAction<KnowledgeUploadMeta>>
  onUpload: () => void
  onDelete: (id: number) => void
  onRefresh: () => void
  onGoList: () => void
}) {
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [showNewText, setShowNewText] = useState(false)
  const [showBatchMenu, setShowBatchMenu] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('全部')
  const [typeFilter, setTypeFilter] = useState('全部')
  const [selected, setSelected] = useState<number[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<number | null>(null)
  const [showPreview, setShowPreview] = useState<DocRow | null>(null)
  const [selectedFileName, setSelectedFileName] = useState('')
  const [newTextTitle, setNewTextTitle] = useState('')
  const [newTextContent, setNewTextContent] = useState('')

  // 将真实文档转换为 DocRow 格式
  const docRows: DocRow[] = realDocs.map(d => ({
    id: d.id,
    name: d.name,
    type: d.source_type || 'txt',
    chunks: d.chunk_count || 0,
    status: d.enabled ? '已入库' as const : '待解析' as const,
    updated: d.created_at ? d.created_at.split('T')[0] : '',
    business_domain: d.business_domain || 'db_migrate',
    kb_type: d.kb_type || 'doc',
    confidence: d.confidence || 'verified',
    review_required: d.review_required || false,
    source_ref: d.source_ref || '',
  }))

  const filtered = docRows.filter(d => {
    if (statusFilter !== '全部' && d.status !== statusFilter) return false
    if (typeFilter !== '全部' && d.type !== typeFilter) return false
    if (searchQ && !d.name.toLowerCase().includes(searchQ.toLowerCase())) return false
    return true
  })

  const total = filtered.length
  const totalPages = Math.ceil(total / pageSize)
  const paginated = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const toggleAll = () => {
    setSelected(selected.length === paginated.length ? [] : paginated.map(d => d.id))
  }
  const toggleOne = (id: number) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const statusColor = (s: DocStatus) => {
    switch (s) {
      case '待解析': return 'bg-gray-500/20 text-gray-400'
      case '解析中': return 'bg-blue-500/20 text-blue-400'
      case '已入库': return 'bg-green-500/20 text-green-400'
      case '解析失败': return 'bg-red-500/20 text-red-400'
    }
  }

  return (
    <div className="space-y-4">
      {/* 面包屑 */}
      <div className="flex items-center gap-2 text-[12px] text-[#5a5a70]">
        <span>知识库列表</span>
        <ChevronRight className="w-3 h-3" />
        <span>后端开发库</span>
        <ChevronRight className="w-3 h-3" />
        <span className="text-[#e4e4e9]">文档管理</span>
      </div>

      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="text-[12px]" onClick={onGoList}>
            <ChevronRight className="w-3 h-3 mr-1 rotate-180" />
            返回知识库列表
          </Button>
          <select
            value={selectedKb}
            onChange={e => onKbChange(e.target.value ? Number(e.target.value) : '')}
            className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1.5 text-[12px] text-[#e4e4e9] focus:outline-none"
            title="选择知识库：文档将归入所选知识库，绑定该知识库的智能体专属检索"
          >
            <option value="">全部知识库文档</option>
            {kbs.map(kb => (
              <option key={kb.id} value={kb.id}>{kb.name}</option>
            ))}
          </select>
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={() => setShowUploadModal(true)}>
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            上传文档
          </Button>
          <Button size="sm" variant="outline" className="text-[12px]" onClick={() => setShowNewText(true)}>
            <FileIcon className="w-3.5 h-3.5 mr-1" />
            新建文本文档
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button size="sm" variant="outline" onClick={() => setShowBatchMenu(!showBatchMenu)} className="text-[12px]">
              批量操作
              <ChevronRight className="w-3 h-3 ml-1 rotate-90" />
            </Button>
            {showBatchMenu && (
              <div className="absolute right-0 top-full mt-1 bg-[#1e1e2a] border border-[#2a2a35] rounded-lg shadow-xl z-50 py-1 min-w-[140px]">
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]">批量重新解析</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#f56c6c] hover:bg-red-500/10">批量删除</button>
              </div>
            )}
          </div>
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5a5a70]" />
            <Input
              className="w-44 bg-[#1a1a24] border-[#252530] pl-8 text-[12px] h-8"
              placeholder="搜索文档名称..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-[#5a5a70]">筛选:</span>
        <div className="flex items-center gap-1">
          <span className="text-[#9a9aa4]">状态</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none"
          >
            <option>全部</option>
            <option>待解析</option>
            <option>解析中</option>
            <option>已入库</option>
            <option>解析失败</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[#9a9aa4]">文件类型</span>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="bg-[#1a1a24] border border-[#252530] rounded px-2 py-1 text-[12px] text-[#e4e4e9] focus:outline-none"
          >
            <option>全部</option>
            <option>md</option>
            <option>pdf</option>
            <option>txt</option>
            <option>docx</option>
          </select>
        </div>
        {selected.length > 0 && (
          <span className="text-indigo-400 ml-2">已选 {selected.length} 项</span>
        )}
      </div>

      {/* 表格 */}
      <div className="border border-[#252530] rounded-lg overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-[#1a1a24] border-b border-[#252530]">
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={selected.length === paginated.length && paginated.length > 0}
                  onChange={toggleAll}
                  className="accent-indigo-500"
                />
              </th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">文档名称</th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">分类</th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">可信度</th>
              <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">类型</th>
              <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">片段数</th>
              <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">状态</th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">更新时间</th>
              <th className="px-3 py-2.5 text-right text-[12px] font-medium text-[#9a9aa4]">操作</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(d => (
              <tr key={d.id} className={cn(
                'border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors',
                selected.includes(d.id) && 'bg-indigo-500/5'
              )}>
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.includes(d.id)}
                    onChange={() => toggleOne(d.id)}
                    className="accent-indigo-500"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    <Badge className="text-[10px] border-0 bg-indigo-500/15 text-indigo-300">
                      {BUSINESS_DOMAINS.find(x => x.value === d.business_domain)?.label || d.business_domain}
                    </Badge>
                    <Badge className="text-[10px] border-0 bg-cyan-500/15 text-cyan-300">
                      {KNOWLEDGE_TYPES.find(x => x.value === d.kb_type)?.label || d.kb_type}
                    </Badge>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <Badge className={cn('text-[10px] border-0',
                      d.confidence === 'model_generated' || d.confidence === 'pending_review'
                        ? 'bg-yellow-500/15 text-yellow-300'
                        : 'bg-green-500/15 text-green-300')}>
                      {CONFIDENCE_LABEL[d.confidence] || d.confidence}
                    </Badge>
                    {d.review_required && (
                      <Badge className="text-[10px] border-0 bg-red-500/15 text-red-300">待复核</Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <button
                    className="flex items-center gap-2 hover:text-indigo-400 transition-colors text-left"
                    onClick={() => {}}
                  >
                    <FileText className="w-4 h-4 text-indigo-400" />
                    <span className="font-medium text-[#e4e4e9]">{d.name}</span>
                  </button>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <code className="text-[12px] text-[#9a9aa4] bg-[#16161e] px-1.5 py-0.5 rounded">{d.type}</code>
                </td>
                <td className="px-3 py-2.5 text-center text-[#e4e4e9]">{d.chunks}</td>
                <td className="px-3 py-2.5 text-center">
                  <Badge className={cn('text-[11px] border-0', statusColor(d.status))}>
                    {d.status}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 text-[#9a9aa4]">{d.updated}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors" onClick={() => setShowPreview(d)}>预览</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">分段</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors">重解析</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-500/10 transition-colors" onClick={() => setShowDeleteConfirm(d.id)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {paginated.length === 0 && (
          <div className="text-center py-8">
            <FileIcon className="w-8 h-8 text-[#2a2a35] mx-auto mb-2" />
            <div className="text-sm text-[#5a5a70] mb-1">当前知识库暂无文档</div>
            <div className="text-xs text-[#3a3a4a]">点击【上传文档】或【新建文本文档】添加资料</div>
          </div>
        )}
      </div>

      {/* 多 Agent 联动提示 */}
      <div className="flex items-start gap-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3">
        <div className="w-1 h-full min-h-[16px] bg-indigo-500/50 rounded-full mt-0.5" />
        <div className="text-[12px] text-[#9a9aa4] leading-relaxed space-y-1">
          <div><span className="text-indigo-400 font-medium">提示：</span>文档只有状态为<b className="text-green-400">已入库</b>的时候，对应的 chunk 向量才会被检索，Agent 才能读到这份文档内容</div>
          <div>如果文档解析失败，Agent 检索不到这份文档里的任何信息</div>
          <div>修改文档之后，必须<b className="text-indigo-400">【重解析】</b>，向量库才会同步更新</div>
        </div>
      </div>

      {/* 分页 */}
      {total > 0 && (
        <div className="flex items-center justify-between pt-2">
          <div className="text-[12px] text-[#5a5a70]">
            共 <span className="text-[#9a9aa4] font-medium">{total}</span> 条文档
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className={cn('px-2.5 py-1 text-[12px] rounded border transition-colors', currentPage === 1 ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
            >
              &lt;
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={cn('w-7 h-7 text-[12px] rounded border transition-colors', currentPage === page ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
              >
                {page}
              </button>
            ))}
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className={cn('px-2.5 py-1 text-[12px] rounded border transition-colors', currentPage === totalPages ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
            >
              &gt;
            </button>
          </div>
        </div>
      )}

      {/* 上传文档弹窗 */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowUploadModal(false)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[480px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">上传文档</h3>
              <button onClick={() => setShowUploadModal(false)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            {/* 拖拽上传区 */}
            <div className="border-2 border-dashed border-[#2a2a35] rounded-lg p-6 text-center hover:border-indigo-500/30 transition-colors mb-4">
              <Upload className="w-6 h-6 text-[#3a3a4a] mx-auto mb-2" />
              <div className="text-sm text-[#9a9aa4] mb-1">拖拽文件到这里，或点击选择文件</div>
              <div className="text-xs text-[#5a5a70]">支持：PDF、MD、TXT、DOCX</div>
              <input
                type="file"
                ref={fileRef}
                accept=".md,.sql,.txt,.pdf,.docx"
                className="hidden"
                onChange={e => setSelectedFileName(e.target.files?.[0]?.name || '')}
              />
              <Button
                size="sm"
                className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white mt-3"
                onClick={() => fileRef.current?.click()}
              >
                选择文件
              </Button>
            </div>
            <div className="space-y-3 mb-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">业务域</label>
                  <select
                    className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9]"
                    value={uploadMeta.businessDomain}
                    onChange={e => setUploadMeta({ ...uploadMeta, businessDomain: e.target.value })}
                  >
                    {BUSINESS_DOMAINS.map(item => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">知识类型</label>
                  <select
                    className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9]"
                    value={uploadMeta.kb_type}
                    onChange={e => setUploadMeta({ ...uploadMeta, kb_type: e.target.value })}
                  >
                    {KNOWLEDGE_TYPES.map(item => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">目标库</label>
                  <Input value={uploadMeta.target_db} placeholder="dm"
                    onChange={e => setUploadMeta({ ...uploadMeta, target_db: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">阶段</label>
                  <Input value={uploadMeta.stage} placeholder="transform"
                    onChange={e => setUploadMeta({ ...uploadMeta, stage: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">对象</label>
                  <Input value={uploadMeta.object_type} placeholder="function"
                    onChange={e => setUploadMeta({ ...uploadMeta, object_type: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">可信度</label>
                  <select
                    className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9]"
                    value={uploadMeta.confidence}
                    onChange={e => setUploadMeta({ ...uploadMeta, confidence: e.target.value })}
                  >
                    {CONFIDENCE_OPTIONS.map(item => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#9a9aa4] block mb-1.5">来源标识</label>
                  <Input value={uploadMeta.source_ref} placeholder="规则编号 / 人工录入人"
                    onChange={e => setUploadMeta({ ...uploadMeta, source_ref: e.target.value })} />
                </div>
              </div>
            </div>
            {/* 文件列表 */}
            {selectedFileName && (
              <div className="space-y-1 mb-4">
                <div className="text-xs text-[#5a5a70] mb-1">文件列表：</div>
                <div className="text-[13px] text-[#9a9aa4] bg-[#16161e] rounded px-3 py-1.5 flex items-center justify-between">
                  <span>{selectedFileName}</span>
                  <span className="text-[11px] text-[#5a5a70]">待上传</span>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { setShowUploadModal(false); setSelectedFileName('') }}>取消</Button>
              <Button
                size="sm"
                className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white"
                onClick={() => {
                  const f = fileRef.current?.files?.[0]
                  if (!f) { alert('请先选择文件'); return }
                  onUpload()
                  setSelectedFileName('')
                }}
              >确认上传</Button>
            </div>
          </div>
        </div>
      )}

      {/* 新建文本文档弹窗 */}
      {showNewText && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowNewText(false)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[480px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">新建文本文档</h3>
              <button onClick={() => setShowNewText(false)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">文档名称 *</label>
                <Input
                  className="bg-[#16161e] border-[#252530] text-[13px]"
                  placeholder="请输入文档名称"
                  value={newTextTitle}
                  onChange={e => setNewTextTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">文档内容 *</label>
                <textarea
                  className="w-full h-48 bg-[#16161e] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] placeholder-[#5a5a70] resize-none focus:outline-none focus:border-indigo-500/50"
                  placeholder="粘贴文本内容..."
                  value={newTextContent}
                  onChange={e => setNewTextContent(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowNewText(false)}>取消</Button>
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white">创建文档</Button>
            </div>
          </div>
        </div>
      )}

      {/* 预览弹窗 */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowPreview(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[560px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">预览：{showPreview.name}</h3>
              <button onClick={() => setShowPreview(null)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 max-h-[400px] overflow-y-auto">
              <p className="text-[13px] text-[#9a9aa4] leading-relaxed whitespace-pre-wrap">
                这里是提取后的纯文本内容（不是原文件，是提取出来给 RAG 用的文本，方便校验提取效果）。{'\n\n'}
                文档名称：{showPreview.name}{'\n'}
                文件类型：{showPreview.type}{'\n'}
                片段数量：{showPreview.chunks}{'\n'}
                状态：{showPreview.status}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowDeleteConfirm(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">确认删除文档？</h3>
                <p className="text-[12px] text-[#9a9aa4] mt-1">文档以及对应的所有分段、向量数据会被删除，不可恢复</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowDeleteConfirm(null)}>取消</Button>
              <Button size="sm" className="bg-red-500 text-white hover:bg-red-600"
                onClick={() => {
                  if (showDeleteConfirm === null) return
                  onDelete(showDeleteConfirm)
                  setShowDeleteConfirm(null)
                }}>确认删除</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- 分段管理内容 ---- */
type ChunkStatus = '启用' | '禁用'

interface ChunkRow {
  id: string
  content: string
  metadata: string
  status: ChunkStatus
}

function ChunksContent({ docs }: { docs: KBDocument[] }) {
  const [docId, setDocId] = useState<number | null>(null)
  const [chunks, setChunks] = useState<ChunkRow[]>([])
  const [loadingChunks, setLoadingChunks] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [showBatchMenu, setShowBatchMenu] = useState(false)
  const [showEditModal, setShowEditModal] = useState<ChunkRow | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showRechunkConfirm, setShowRechunkConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState<ChunkRow | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editMetadata, setEditMetadata] = useState('')
  const [addContent, setAddContent] = useState('')
  const [addMetadata, setAddMetadata] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)

  // 默认选中第一个文档
  useEffect(() => {
    if (docId == null && docs.length > 0) setDocId(docs[0].id)
    if (docId != null && docs.length > 0 && !docs.some(d => d.id === docId)) setDocId(docs[0].id)
  }, [docs, docId])

  // 加载真实 Chunk 数据（来自 FAISS 索引 metadata，按 doc_id 过滤）
  useEffect(() => {
    if (docId == null) { setChunks([]); return }
    let mounted = true
    setLoadingChunks(true)
    api.getDocChunks(docId).then(r => {
      if (!mounted) return
      if (r.success) {
        setChunks((r.data || []).map(c => ({
          id: c.chunk_id,
          content: c.content,
          metadata: `chunk_index: ${c.chunk_index} · ${c.chars} 字符`,
          status: '启用' as const,
        })))
      } else {
        setChunks([])
      }
      setLoadingChunks(false)
    }).catch(() => { if (mounted) { setChunks([]); setLoadingChunks(false) } })
    return () => { mounted = false }
  }, [docId])

  const filtered = chunks.filter(c => {
    if (searchQ && !c.content.toLowerCase().includes(searchQ.toLowerCase())) return false
    return true
  })

  const total = filtered.length
  const totalPages = Math.ceil(total / pageSize)
  const paginated = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const toggleAll = () => {
    setSelected(selected.length === paginated.length ? [] : paginated.map(c => c.id))
  }
  const toggleOne = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  return (
    <div className="space-y-4">
      {/* 面包屑 */}
      <div className="flex items-center gap-2 text-[12px] text-[#5a5a70]">
        <span>知识库列表</span>
        <ChevronRight className="w-3 h-3" />
        <span>后端开发库</span>
        <ChevronRight className="w-3 h-3" />
        <span>文档管理</span>
        <ChevronRight className="w-3 h-3" />
        <span className="text-[#e4e4e9]">{docs.find(d => d.id === docId)?.name || '未选择文档'}（Chunk 分段管理）</span>
      </div>

      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="text-[12px]">
            <ChevronRight className="w-3 h-3 mr-1 rotate-180" />
            返回文档列表
          </Button>
          <select
            value={docId ?? ''}
            onChange={e => setDocId(Number(e.target.value))}
            className="h-8 bg-[#16161e] border border-[#252530] rounded-md px-2 text-[12px] text-[#cdd3e0] focus:outline-none focus:border-indigo-500/50"
          >
            {docs.length === 0 && <option value="">暂无文档</option>}
            {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <Button size="sm" variant="outline" className="text-[12px]" onClick={() => setShowRechunkConfirm(true)}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            自动重新分段
          </Button>
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={() => setShowAddModal(true)}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            新增分段
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button size="sm" variant="outline" onClick={() => setShowBatchMenu(!showBatchMenu)} className="text-[12px]">
              批量操作
              <ChevronRight className="w-3 h-3 ml-1 rotate-90" />
            </Button>
            {showBatchMenu && (
              <div className="absolute right-0 top-full mt-1 bg-[#1e1e2a] border border-[#2a2a35] rounded-lg shadow-xl z-50 py-1 min-w-[140px]">
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]">批量启用</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#9a9aa4] hover:bg-white/[0.05] hover:text-[#e4e4e9]">批量禁用</button>
                <button className="w-full text-left px-3 py-2 text-[12px] text-[#f56c6c] hover:bg-red-500/10">批量删除</button>
              </div>
            )}
          </div>
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5a5a70]" />
            <Input
              className="w-44 bg-[#1a1a24] border-[#252530] pl-8 text-[12px] h-8"
              placeholder="搜索Chunk内容..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 表格 */}
      <div className="border border-[#252530] rounded-lg overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-[#1a1a24] border-b border-[#252530]">
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={selected.length === paginated.length && paginated.length > 0}
                  onChange={toggleAll}
                  className="accent-indigo-500"
                />
              </th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">ChunkID</th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">内容预览</th>
              <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">元数据</th>
              <th className="px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">状态</th>
              <th className="px-3 py-2.5 text-right text-[12px] font-medium text-[#9a9aa4]">操作</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(c => (
              <tr key={c.id} className={cn(
                'border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors',
                selected.includes(c.id) && 'bg-indigo-500/5'
              )}>
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={() => toggleOne(c.id)}
                    className="accent-indigo-500"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <code className="text-[12px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded font-mono">{c.id}</code>
                </td>
                <td className="px-3 py-2.5">
                  <p className="text-[13px] text-[#9a9aa4] line-clamp-2 max-w-[400px]">{c.content}</p>
                </td>
                <td className="px-3 py-2.5">
                  <code className="text-[11px] text-[#5a5a70] bg-[#16161e] px-1.5 py-0.5 rounded">{c.metadata}</code>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <Badge className={cn('text-[11px] border-0', c.status === '启用' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400')}>
                    {c.status}
                  </Badge>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors" onClick={() => setShowPreview(c)}>预览</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-indigo-400 px-1.5 py-0.5 rounded hover:bg-white/[0.05] transition-colors" onClick={() => { setShowEditModal(c); setEditContent(c.content); setEditMetadata(c.metadata) }}>编辑</button>
                    <button className="text-[12px] text-[#9a9aa4] hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-500/10 transition-colors" onClick={() => setShowDeleteConfirm(c.id)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {paginated.length === 0 && (
          <div className="text-center py-8">
            <Layers className="w-8 h-8 text-[#2a2a35] mx-auto mb-2" />
            <div className="text-sm text-[#5a5a70] mb-1">{loadingChunks ? '正在加载分段…' : '当前文档暂无分段'}</div>
            <div className="text-xs text-[#3a3a4a]">{loadingChunks ? '' : '上传文档解析入库后将自动生成Chunk片段'}</div>
          </div>
        )}
      </div>

      {/* 多 Agent 联动提示 */}
      <div className="flex items-start gap-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3">
        <div className="w-1 h-full min-h-[16px] bg-indigo-500/50 rounded-full mt-0.5" />
        <div className="text-[12px] text-[#9a9aa4] leading-relaxed space-y-1">
          <div><span className="text-indigo-400 font-medium">提示：</span>Agent 检索只会召回<b className="text-green-400">状态 = 启用</b>的 Chunk</div>
          <div>元数据会随同 chunk 内容一起返回给 Agent，Agent 可以在回答中标注引用来源文档、页码</div>
          <div>如果某些段落有错误信息，可以直接禁用，不用删除整个文档</div>
        </div>
      </div>

      {/* 分页 */}
      {total > 0 && (
        <div className="flex items-center justify-between pt-2">
          <div className="text-[12px] text-[#5a5a70]">
            共 <span className="text-[#9a9aa4] font-medium">{total}</span> 条Chunk
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className={cn('px-2.5 py-1 text-[12px] rounded border transition-colors', currentPage === 1 ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
            >
              &lt;
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={cn('w-7 h-7 text-[12px] rounded border transition-colors', currentPage === page ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
              >
                {page}
              </button>
            ))}
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className={cn('px-2.5 py-1 text-[12px] rounded border transition-colors', currentPage === totalPages ? 'border-[#252530] text-[#3a3a4a] cursor-not-allowed' : 'border-[#252530] text-[#9a9aa4] hover:border-indigo-500/50 hover:text-indigo-400')}
            >
              &gt;
            </button>
          </div>
        </div>
      )}

      {/* 编辑 Chunk 弹窗 */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowEditModal(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[560px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">编辑分段 {showEditModal.id}</h3>
              <button onClick={() => setShowEditModal(null)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">文本内容：</label>
                <textarea
                  className="w-full h-32 bg-[#16161e] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] resize-none focus:outline-none focus:border-indigo-500/50"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">元数据（JSON）：</label>
                <textarea
                  className="w-full h-20 bg-[#16161e] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] font-mono resize-none focus:outline-none focus:border-indigo-500/50"
                  value={editMetadata}
                  onChange={e => setEditMetadata(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowEditModal(null)}>取消</Button>
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white">保存</Button>
            </div>
          </div>
        </div>
      )}

      {/* 新增分段弹窗 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowAddModal(false)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[560px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">新增分段</h3>
              <button onClick={() => setShowAddModal(false)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">文本内容 *</label>
                <textarea
                  className="w-full h-32 bg-[#16161e] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] resize-none focus:outline-none focus:border-indigo-500/50"
                  placeholder="输入Chunk内容..."
                  value={addContent}
                  onChange={e => setAddContent(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-[#9a9aa4] block mb-1.5">元数据（JSON）</label>
                <textarea
                  className="w-full h-20 bg-[#16161e] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] font-mono resize-none focus:outline-none focus:border-indigo-500/50"
                  placeholder='{"page":1,"chapter":"简介"}'
                  value={addMetadata}
                  onChange={e => setAddMetadata(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowAddModal(false)}>取消</Button>
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white">创建</Button>
            </div>
          </div>
        </div>
      )}

      {/* 自动重新分段确认弹窗 */}
      {showRechunkConfirm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowRechunkConfirm(false)}>
          <div className="bg-[#1e1e2a] border border-yellow-500/30 rounded-xl p-6 w-[480px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">确认自动重新分段？</h3>
                <p className="text-[12px] text-[#9a9aa4] mt-1">将根据当前知识库的分块大小、重叠值，对文档全文重新切分 Chunk</p>
              </div>
            </div>
            <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3 mb-4">
              <div className="text-[12px] text-yellow-400 leading-relaxed">
                ⚠️ <b>高危操作：</b>原有手动编辑的 Chunk 会丢失！重新分段完成后自动向量化。
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowRechunkConfirm(false)}>取消</Button>
              <Button size="sm" className="bg-yellow-500 text-black hover:bg-yellow-600">确认重新分段</Button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowDeleteConfirm(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">确认删除分段？</h3>
                <p className="text-[12px] text-[#9a9aa4] mt-1">删除该分段和对应的向量记录，不可恢复</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button size="sm" variant="outline" onClick={() => setShowDeleteConfirm(null)}>取消</Button>
              <Button size="sm" className="bg-red-500 text-white hover:bg-red-600">确认删除</Button>
            </div>
          </div>
        </div>
      )}

      {/* 预览弹窗 */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowPreview(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[560px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">预览：{showPreview.id}</h3>
              <button onClick={() => setShowPreview(null)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-[#5a5a70] block mb-1.5">完整文本：</label>
                <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 max-h-[200px] overflow-y-auto">
                  <p className="text-[13px] text-[#9a9aa4] leading-relaxed whitespace-pre-wrap">{showPreview.content}</p>
                </div>
              </div>
              <div>
                <label className="text-xs text-[#5a5a70] block mb-1.5">元数据：</label>
                <div className="bg-[#16161e] border border-[#252530] rounded-lg p-3">
                  <code className="text-[12px] text-indigo-400 font-mono">{showPreview.metadata}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- 检索测试内容 ---- */
interface SearchResultRow {
  index: number
  hit: KnowledgeSearchHit
}

function SearchContent({
  searchQ, setSearchQ
}: {
  searchQ: string
  setSearchQ: (v: string) => void
}) {
  const [kbOptions, setKbOptions] = useState<{ id: number; name: string }[]>([])
  const [selectedKB, setSelectedKB] = useState<number | null>(null)
  const [topK, setTopK] = useState(3)
  const [threshold, setThreshold] = useState(0.35)
  const [businessDomain, setBusinessDomain] = useState('db_migrate')
  const [knowledgeType, setKnowledgeType] = useState('')
  const [targetDb, setTargetDb] = useState('')
  const [stage, setStage] = useState('')
  const [objectType, setObjectType] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [results, setResults] = useState<SearchResultRow[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [searchTime, setSearchTime] = useState(0)
  const [showPreview, setShowPreview] = useState<SearchResultRow | null>(null)

  // 检索测试与 Agent 授权使用同一批独立知识库
  useEffect(() => {
    api.listKbs().then(r => {
      if (r.success) {
        const opts = (r.data || []).map(kb => ({ id: kb.id, name: kb.name }))
        setKbOptions(opts)
        if (opts.length > 0) setSelectedKB(prev => prev ?? opts[0].id)
      }
    }).catch(() => {})
  }, [])

  const handleSearch = () => {
    if (!searchQ.trim() || searching) return
    setSearching(true)
    setSearchError('')
    const t0 = performance.now()
    api.searchKnowledge({
      query: searchQ.trim(),
      top_k: Math.max(topK * 2, 10),
      kb_id: selectedKB ?? undefined,
      kb_types: knowledgeType ? [knowledgeType] : undefined,
      business_domain: businessDomain,
      target_db: targetDb,
      stage,
      object_type: objectType,
      candidate_k: 20,
      min_similarity: threshold,
    }).then(r => {
      const elapsed = Math.round(performance.now() - t0)
      if (r.success) {
        setResults((r.data?.results || []).slice(0, topK).map((hit, i) => ({ index: i + 1, hit })))
        setSearchTime(Math.round(r.data?.elapsed_ms ?? elapsed))
      } else {
        setResults([])
        setSearchError(r.error || r.detail || '检索失败，请检查 Embedding 服务')
      }
      setSearchTime(elapsed)
      setSearching(false)
      setHasSearched(true)
    }).catch(() => {
      setSearchTime(Math.round(performance.now() - t0))
      setResults([])
      setSearchError('检索请求失败，请检查后端服务')
      setSearching(false)
      setHasSearched(true)
    })
  }

  const feedbackKnowledge = async (row: SearchResultRow, feedback: 'positive' | 'negative') => {
    const reason = feedback === 'negative'
      ? window.prompt('请输入不适用原因（可选）') || ''
      : ''
    const r = await api.feedbackKnowledge(row.hit.doc_id, feedback, reason)
    if (!r.success) return
    setResults(prev => prev.map(item => item.index === row.index ? {
      ...item,
      hit: {
        ...item.hit,
        confidence: r.data!.confidence,
        confidence_score: r.data!.confidence === 'model_generated' ? 0.4
          : r.data!.confidence === 'pending_review' ? 0.6 : 1.0,
        negative_feedback_count: r.data!.negative_feedback_count,
        review_required: r.data!.review_required,
        needs_review: r.data!.review_required
          || ['pending_review', 'model_generated'].includes(r.data!.confidence),
      },
    } : item))
  }

  return (
    <div className="space-y-4">
      {/* 面包屑 */}
      <div className="flex items-center gap-2 text-[12px] text-[#5a5a70]">
        <span>知识库列表</span>
        <ChevronRight className="w-3 h-3" />
        <span className="text-[#e4e4e9]">检索测试</span>
      </div>

      {/* 查询配置区域 */}
      <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-4">
        <div className="flex items-center gap-2 mb-4">
          <Search className="w-4 h-4 text-cyan-400" />
          <h3 className="text-[14px] font-semibold text-[#e4e4e9]">知识库检索测试面板</h3>
        </div>

        <div className="space-y-3">
          {/* 知识库选择 */}
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">知识库空间选择</label>
            <select
              value={selectedKB ?? ''}
              onChange={e => setSelectedKB(Number(e.target.value))}
              className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9] focus:outline-none focus:border-cyan-500/50"
            >
              {kbOptions.length === 0 && <option value="">暂无知识库空间</option>}
              {kbOptions.map(sp => (
                <option key={sp.id} value={sp.id}>{sp.name}（space_id={sp.id}）</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">业务域</label>
              <select
                value={businessDomain}
                onChange={e => setBusinessDomain(e.target.value)}
                className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9]"
              >
                {BUSINESS_DOMAINS.map(item => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">知识类型</label>
              <select
                value={knowledgeType}
                onChange={e => setKnowledgeType(e.target.value)}
                className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9]"
              >
                <option value="">全部类型</option>
                {KNOWLEDGE_TYPES.map(item => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">目标库</label>
              <Input value={targetDb} placeholder="dm"
                onChange={e => setTargetDb(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">阶段</label>
              <Input value={stage} placeholder="transform"
                onChange={e => setStage(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">对象类型</label>
              <Input value={objectType} placeholder="function"
                onChange={e => setObjectType(e.target.value)} />
            </div>
          </div>

          {/* Query输入框 */}
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">Query 输入框</label>
            <textarea
              className="w-full h-20 bg-[#16161e] border border-[#252530] rounded-lg p-3 text-[13px] text-[#e4e4e9] placeholder-[#5a5a70] resize-none focus:outline-none focus:border-cyan-500/50"
              placeholder="请输入测试问题，模拟Agent检索请求&#10;示例：Java类命名规范是什么？"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSearch()}
            />
          </div>

          {/* TopK + 相似度阈值 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">TopK（返回片段数量）</label>
              <Input
                type="number"
                min={1}
                max={10}
                className="bg-[#16161e] border-[#252530] text-[13px]"
                value={topK}
                onChange={e => setTopK(parseInt(e.target.value) || 3)}
              />
            </div>
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">余弦相似度阈值</label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="bg-[#16161e] border-[#252530] text-[13px]"
                value={threshold}
                onChange={e => setThreshold(parseFloat(e.target.value) || 0.70)}
              />
            </div>
          </div>

          {/* 调试提示 */}
          <div className="flex items-start gap-2 bg-cyan-500/5 border border-cyan-500/20 rounded-lg p-2.5">
            <div className="text-[11px] text-[#9a9aa4] leading-relaxed">
              <span className="text-cyan-400 font-medium">调试技巧：</span>阈值调高，召回更严格，结果变少；阈值调低，召回更多，但容易混入无关内容。
            </div>
          </div>

          {/* 执行检索按钮 */}
          <div className="flex justify-center pt-1">
            <Button
              size="sm"
              className="bg-gradient-to-br from-[#06b6d4] to-[#0891b2] text-white px-8"
              onClick={handleSearch}
              disabled={searching}
            >
              {searching ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  检索中...
                </>
              ) : (
                <>
                  <Search className="w-3.5 h-3.5 mr-1.5" />
                  执行检索
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* 检索结果区域 */}
      {hasSearched && (
        <>
          {/* 错误提示 */}
          {searchError && (
            <div className="bg-red-500/5 border border-red-500/25 rounded-lg px-4 py-2.5 text-[12px] text-red-400">
              {searchError}
            </div>
          )}
          {/* 检索耗时 */}
          <div className="bg-[#1a1a24] border border-[#252530] rounded-lg px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-[#9a9aa4]">检索结果</span>
              <Badge className="text-[11px] bg-cyan-500/20 text-cyan-400 border-0">{results.length} 条</Badge>
            </div>
            <span className="text-[12px] text-[#5a5a70]">检索耗时：<span className="text-cyan-400 font-medium">{searchTime}ms</span></span>
          </div>

          {/* 结果表格 */}
          <div className="border border-[#252530] rounded-lg overflow-x-auto">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead>
                <tr className="bg-[#1a1a24] border-b border-[#252530]">
                  <th className="w-14 px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">序号</th>
                  <th className="w-20 px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">融合分</th>
                  <th className="w-20 px-3 py-2.5 text-center text-[12px] font-medium text-[#9a9aa4]">相似度</th>
                  <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">Chunk 内容预览</th>
                  <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">可信度</th>
                  <th className="px-3 py-2.5 text-left text-[12px] font-medium text-[#9a9aa4]">来源与维度</th>
                  <th className="px-3 py-2.5 text-right text-[12px] font-medium text-[#9a9aa4]">反馈</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.index} className="border-b border-[#252530] last:border-0 hover:bg-white/[0.02] transition-colors">
                    <td className="px-3 py-2.5 text-center text-[#e4e4e9] font-medium">{r.index}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={cn(
                        'text-[13px] font-semibold',
                        r.hit.fused_score >= 0.85 ? 'text-green-400' : r.hit.fused_score >= 0.70 ? 'text-cyan-400' : 'text-yellow-400'
                      )}>
                        {r.hit.fused_score.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center text-[#9a9aa4]">
                      {r.hit.similarity.toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        className="text-[13px] text-[#9a9aa4] line-clamp-2 max-w-[400px] text-left hover:text-cyan-400 transition-colors"
                        onClick={() => setShowPreview(r)}
                      >
                        {r.hit.content}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge className={cn('text-[10px] border-0',
                        r.hit.needs_review ? 'bg-yellow-500/15 text-yellow-300' : 'bg-green-500/15 text-green-300')}>
                        {CONFIDENCE_LABEL[r.hit.confidence] || r.hit.confidence}
                      </Badge>
                      {r.hit.match_type === 'exact' && (
                        <Badge className="text-[10px] border-0 bg-blue-500/15 text-blue-300">精确命中</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="space-y-1 text-[11px] text-[#9a9aa4]">
                      <div>{r.hit.doc_name} · {r.hit.chunk_id}</div>
                      <div>
                        {BUSINESS_DOMAINS.find(x => x.value === r.hit.business_domain)?.label || r.hit.business_domain}
                        {' / '}
                        {KNOWLEDGE_TYPES.find(x => x.value === r.hit.kb_type)?.label || r.hit.kb_type}
                      </div>
                      <div className="text-[#5a5a70]">
                        {[r.hit.target_db, r.hit.stage, r.hit.object_type].filter(Boolean).join(' / ') || '未设置维度'}
                        {r.hit.source_ref ? ` · ${r.hit.source_ref}` : ''}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-1">
                      <button
                        className="rounded px-1.5 py-0.5 text-[11px] text-[#9a9aa4] hover:bg-green-500/10 hover:text-green-300"
                        onClick={() => feedbackKnowledge(r, 'positive')}
                        title="确认有效"
                      >有效</button>
                      <button
                        className="rounded px-1.5 py-0.5 text-[11px] text-[#9a9aa4] hover:bg-red-500/10 hover:text-red-300"
                        onClick={() => feedbackKnowledge(r, 'negative')}
                        title="标记为不适用"
                      >无效</button>
                    </div>
                  </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {results.length === 0 && (
              <div className="text-center py-8">
                <Search className="w-8 h-8 text-[#2a2a35] mx-auto mb-2" />
                <div className="text-sm text-[#5a5a70] mb-1">未检索到符合条件的片段</div>
                <div className="text-xs text-[#3a3a4a]">可尝试调低相似度阈值，或修改查询语句</div>
              </div>
            )}
          </div>
        </>
      )}

      {/* 初始空状态（未搜索过） */}
      {!hasSearched && (
        <div className="text-center py-12">
          <Search className="w-10 h-10 text-[#2a2a35] mx-auto mb-3" />
          <div className="text-sm text-[#5a5a70] mb-1">输入查询内容，测试知识库召回效果</div>
          <div className="text-xs text-[#3a3a4a]">检索结果将展示匹配的 Chunk 及相似度分数</div>
        </div>
      )}

      {/* 多 Agent 联动提示 */}
      <div className="flex items-start gap-2 bg-cyan-500/5 border border-cyan-500/20 rounded-lg p-3">
        <div className="w-1 h-full min-h-[16px] bg-cyan-500/50 rounded-full mt-0.5" />
        <div className="text-[12px] text-[#9a9aa4] leading-relaxed space-y-1">
          <div><span className="text-cyan-400 font-medium">提示：</span>本页面检索接口与 Agent 调用 RAG 工具使用<b className="text-cyan-400">同一个底层检索 API</b></div>
          <div>这里测出的召回效果，就是 Agent 实际拿到的召回结果</div>
          <div>检索只读取<b className="text-green-400">启用状态</b>的 Chunk，禁用的 Chunk 不会被召回</div>
          <div>反馈会更新文档可信度；其余操作仅用于调试，不修改 Chunk 文本</div>
        </div>
      </div>

      {/* Chunk 预览弹窗 */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowPreview(null)}>
          <div className="bg-[#1e1e2a] border border-[#2a2a35] rounded-xl p-6 w-[560px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">Chunk 详情（序号 {showPreview.index}）</h3>
              <button onClick={() => setShowPreview(null)} className="text-[#5a5a70] hover:text-[#9a9aa4] text-lg">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-[#5a5a70] block mb-1.5">融合分 / 相似度：</label>
                <span className={cn(
                  'text-[14px] font-semibold',
                  showPreview.hit.fused_score >= 0.85 ? 'text-green-400' : showPreview.hit.fused_score >= 0.70 ? 'text-cyan-400' : 'text-yellow-400'
                )}>
                  {showPreview.hit.fused_score.toFixed(2)} / {showPreview.hit.similarity.toFixed(2)}
                </span>
              </div>
              <div>
                <label className="text-xs text-[#5a5a70] block mb-1.5">完整文本：</label>
                <div className="bg-[#16161e] border border-[#252530] rounded-lg p-4 max-h-[200px] overflow-y-auto">
                  <p className="text-[13px] text-[#9a9aa4] leading-relaxed whitespace-pre-wrap">{showPreview.hit.content}</p>
                </div>
              </div>
              <div>
                <label className="text-xs text-[#5a5a70] block mb-1.5">来源元数据：</label>
                <div className="bg-[#16161e] border border-[#252530] rounded-lg p-3">
                  <div className="space-y-1 text-[13px] text-[#9a9aa4]">
                    <div>{showPreview.hit.doc_name} · {showPreview.hit.chunk_id}</div>
                    <div className="text-[12px] text-[#9a9aa4]">
                      业务域 {showPreview.hit.business_domain} · 知识类型 {showPreview.hit.kb_type}
                    </div>
                    <div className="text-[12px] text-[#9a9aa4]">
                      维度 {[showPreview.hit.target_db, showPreview.hit.stage, showPreview.hit.object_type].filter(Boolean).join(' / ') || '未设置'}
                    </div>
                    <div className="text-[12px] text-[#9a9aa4]">
                      来源 {showPreview.hit.source}{showPreview.hit.source_ref ? ` · ${showPreview.hit.source_ref}` : ''}
                    </div>
                    <div className="text-[12px] text-[#9a9aa4]">
                      可信度 {CONFIDENCE_LABEL[showPreview.hit.confidence] || showPreview.hit.confidence}
                      （{showPreview.hit.confidence_score.toFixed(1)}） · 域匹配 {showPreview.hit.domain_match.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- 知识库设置内容 ---- */
function SettingsContent({
  onGoList
}: {
  onGoList: () => void
}) {
  const [kbName, setKbName] = useState('后端开发库')
  const [kbDesc, setKbDesc] = useState('存放Java后端开发规范、接口、数据库设计文档')
  const [kbStatus, setKbStatus] = useState<'启用' | '禁用'>('启用')
  const [chunkSize, setChunkSize] = useState(512)
  const [overlapSize, setOverlapSize] = useState(100)
  const [embeddingModel, setEmbeddingModel] = useState('text-embedding-v3')
  const [defaultTopK, setDefaultTopK] = useState(3)
  const [defaultThreshold, setDefaultThreshold] = useState(0.70)
  const [agentPermissions, setAgentPermissions] = useState<string[]>(['main_agent', 'code_agent_01'])
  const [enableVersioning, setEnableVersioning] = useState(false)
  const [autoRevectorize, setAutoRevectorize] = useState(false)
  const [showSaveSuccess, setShowSaveSuccess] = useState(false)
  const [showChunkParamTip, setShowChunkParamTip] = useState(false)

  // 动态 Agent 列表（从接口获取）
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string; description: string }>>([])

  // 用 ref 记录初始分块参数，用于检测是否修改过
  const initialChunkParams = useRef({ chunkSize: 512, overlapSize: 100 })
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 加载启用的 Agent 列表
  useEffect(() => {
    api.listAgents().then(r => {
      if (r.success) {
        const agents = (r.data as any[] || []).filter((a: any) => a.enabled !== false)
        setAvailableAgents(agents.map((a: any) => ({
          id: a.id || a.agent_id,
          name: a.name,
          description: a.description || '',
        })))
      }
    }).catch(() => {
      // 接口失败时使用默认数据
      setAvailableAgents([
        { id: 'main_agent', name: '主调度Agent', description: '负责任务拆解、子Agent调度、结果汇总' },
        { id: 'code_agent_01', name: 'CodeAgent', description: '负责Java代码生成、DDL、接口开发' },
        { id: 'requirement_agent', name: 'RequirementAgent', description: '负责需求分析、需求文档梳理' },
        { id: 'doc_agent', name: 'DocAgent', description: '负责文档编写、产品手册生成' },
      ])
    })
  }, [])

  const toggleAgent = (id: string) => {
    setAgentPermissions(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // 清理 timer，防止组件卸载后内存泄漏
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  const handleSave = () => {
    // 检查分块参数是否被修改（与初始值比较）
    const chunkParamsChanged =
      chunkSize !== initialChunkParams.current.chunkSize ||
      overlapSize !== initialChunkParams.current.overlapSize

    if (chunkParamsChanged) {
      setShowChunkParamTip(true)
    } else {
      setShowSaveSuccess(true)
      // 清理之前的 timer
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
      saveTimerRef.current = setTimeout(() => setShowSaveSuccess(false), 2000)
    }
  }

  const handleChunkParamTipConfirm = () => {
    setShowChunkParamTip(false)
    // 更新初始值，这样下次保存时不会重复弹窗
    initialChunkParams.current = { chunkSize, overlapSize }
    setShowSaveSuccess(true)
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = setTimeout(() => setShowSaveSuccess(false), 2000)
  }

  return (
    <div className="space-y-4">
      {/* 面包屑 */}
      <div className="flex items-center gap-2 text-[12px] text-[#5a5a70]">
        <span>知识库列表</span>
        <ChevronRight className="w-3 h-3" />
        <span>后端开发库</span>
        <ChevronRight className="w-3 h-3" />
        <span className="text-[#e4e4e9]">知识库设置</span>
      </div>

      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="outline" className="text-[12px]" onClick={onGoList}>
          <ChevronRight className="w-3 h-3 mr-1 rotate-180" />
          返回知识库列表
        </Button>
        <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleSave}>
          保存设置
        </Button>
      </div>

      {/* 基础信息 */}
      <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-4">
        <h3 className="text-[13px] font-medium text-[#e4e4e9] mb-4 flex items-center gap-2">
          <Database className="w-4 h-4 text-indigo-400" />
          基础信息
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">知识库名称</label>
            <Input
              className="bg-[#16161e] border-[#252530] text-[13px]"
              value={kbName}
              onChange={e => setKbName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">唯一标识</label>
            <div className="bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#5a5a70] font-mono">
              backend_dev
              <span className="ml-2 text-[11px] text-[#3a3a4a]">（创建后不可修改）</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">描述</label>
            <textarea
              className="w-full h-16 bg-[#16161e] border border-[#252530] rounded-lg p-2.5 text-[13px] text-[#e4e4e9] placeholder-[#5a5a70] resize-none focus:outline-none focus:border-indigo-500/50"
              value={kbDesc}
              onChange={e => setKbDesc(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">状态</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="kbStatus"
                  checked={kbStatus === '启用'}
                  onChange={() => setKbStatus('启用')}
                  className="accent-green-500"
                />
                <span className="text-[13px] text-green-400">启用</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="kbStatus"
                  checked={kbStatus === '禁用'}
                  onChange={() => setKbStatus('禁用')}
                  className="accent-gray-500"
                />
                <span className="text-[13px] text-gray-400">禁用</span>
              </label>
            </div>
            {kbStatus === '禁用' && (
              <div className="text-[11px] text-[#5a5a70] mt-1">禁用后所有 Agent 不能检索该知识库，管理员仍可维护文档和 Chunk</div>
            )}
          </div>
        </div>
      </div>

      {/* 分块默认参数 */}
      <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-4">
        <h3 className="text-[13px] font-medium text-[#e4e4e9] mb-4 flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-400" />
          分块默认参数
        </h3>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">Chunk 大小（字符）</label>
              <Input
                type="number"
                className="bg-[#16161e] border-[#252530] text-[13px]"
                value={chunkSize}
                onChange={e => setChunkSize(parseInt(e.target.value) || 512)}
              />
            </div>
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">重叠长度（字符）</label>
              <Input
                type="number"
                className="bg-[#16161e] border-[#252530] text-[13px]"
                value={overlapSize}
                onChange={e => setOverlapSize(parseInt(e.target.value) || 100)}
              />
            </div>
          </div>
          <div className="text-[11px] text-[#5a5a70] leading-relaxed">
            新建文档上传时，默认使用这套参数自动切分 Chunk；<b className="text-yellow-400">修改这里不会自动更新已上传文档的 Chunk</b>
          </div>
        </div>
      </div>

      {/* 向量与检索默认参数 */}
      <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-4">
        <h3 className="text-[13px] font-medium text-[#e4e4e9] mb-4 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-indigo-400" />
          向量与检索默认参数
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[#9a9aa4] block mb-1.5">Embedding 模型</label>
            <select
              className="w-full bg-[#16161e] border border-[#252530] rounded-lg px-3 py-2 text-[13px] text-[#e4e4e9] focus:outline-none focus:border-indigo-500/50"
              value={embeddingModel}
              onChange={e => setEmbeddingModel(e.target.value)}
            >
              <option>text-embedding-v3</option>
              <option>text-embedding-ada-002</option>
              <option>text-embedding-3-small</option>
              <option>text-embedding-3-large</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">默认 TopK</label>
              <Input
                type="number"
                min={1}
                max={10}
                className="bg-[#16161e] border-[#252530] text-[13px]"
                value={defaultTopK}
                onChange={e => setDefaultTopK(parseInt(e.target.value) || 3)}
              />
            </div>
            <div>
              <label className="text-xs text-[#9a9aa4] block mb-1.5">默认相似度阈值</label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="bg-[#16161e] border-[#252530] text-[13px]"
                value={defaultThreshold}
                onChange={e => setDefaultThreshold(parseFloat(e.target.value) || 0.70)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Agent 访问权限 */}
      <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[13px] font-medium text-[#e4e4e9] flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-400" />
            Agent 访问权限（多选）
          </h3>
          {availableAgents.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setAgentPermissions(availableAgents.map(a => a.id))}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                全选
              </button>
              <span className="text-[#3a3a4a]">|</span>
              <button
                onClick={() => setAgentPermissions([])}
                className="text-[11px] text-[#9a9aa4] hover:text-[#e4e4e9] transition-colors"
              >
                取消全选
              </button>
            </div>
          )}
        </div>
        <div className="max-h-[160px] overflow-y-auto border border-[#252530] rounded-lg p-3 space-y-2">
          {availableAgents.length === 0 ? (
            <div className="text-[12px] text-[#5a5a70] text-center py-4">暂无启用的 Agent</div>
          ) : (
            availableAgents.map(agent => (
              <label key={agent.id} className="flex items-center gap-2 cursor-pointer py-1.5 hover:bg-white/[0.02] rounded px-2 -mx-2 transition-colors">
                <input
                  type="checkbox"
                  checked={agentPermissions.includes(agent.id)}
                  onChange={() => toggleAgent(agent.id)}
                  className="accent-indigo-500"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-[#e4e4e9] font-medium">{agent.name}</span>
                  {agent.description && (
                    <span className="text-[11px] text-[#5a5a70] ml-2">（{agent.description}）</span>
                  )}
                </div>
              </label>
            ))
          )}
        </div>
        <div className="text-[11px] text-[#5a5a70] mt-3 leading-relaxed">
          勾选后，对应 Agent 执行任务时可以选择绑定该知识库进行 RAG 检索；不勾选则 Agent 无法读取该知识库，实现知识隔离。
        </div>
      </div>

      {/* 高级设置 */}
      <div className="bg-[#1a1a24] border border-[#252530] rounded-lg p-4">
        <h3 className="text-[13px] font-medium text-[#e4e4e9] mb-4 flex items-center gap-2">
          <Settings className="w-4 h-4 text-indigo-400" />
          高级设置
        </h3>
        <div className="space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableVersioning}
              onChange={() => setEnableVersioning(!enableVersioning)}
              className="accent-indigo-500"
            />
            <div>
              <span className="text-[13px] text-[#e4e4e9]">开启文档版本管理</span>
              <div className="text-[11px] text-[#5a5a70]">每次修改文档会保留历史版本，支持回滚</div>
            </div>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRevectorize}
              onChange={() => setAutoRevectorize(!autoRevectorize)}
              className="accent-indigo-500"
            />
            <div>
              <span className="text-[13px] text-[#e4e4e9]">自动定时重新向量化</span>
              <div className="text-[11px] text-[#5a5a70]">不推荐，开销较大，会消耗大量 token 与算力</div>
            </div>
          </label>
        </div>
      </div>

      {/* 多 Agent 联动提示 */}
      <div className="flex items-start gap-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3">
        <div className="w-1 h-full min-h-[16px] bg-indigo-500/50 rounded-full mt-0.5" />
        <div className="text-[12px] text-[#9a9aa4] leading-relaxed space-y-1">
          <div><span className="text-indigo-400 font-medium">提示：</span>修改分块参数 / Embedding 模型，<b className="text-yellow-400">只对后续新上传文档生效</b>；存量文档需手动执行【重解析】</div>
          <div>修改 Agent 访问权限、切换启用/禁用状态，<b className="text-green-400">实时生效</b></div>
        </div>
      </div>

      {/* 保存成功提示 */}
      {showSaveSuccess && (
        <div className="fixed top-4 right-4 bg-green-500/20 border border-green-500/40 rounded-lg px-4 py-3 z-[200] flex items-center gap-2 shadow-xl">
          <CheckCircle className="w-4 h-4 text-green-400" />
          <span className="text-[13px] text-green-400">配置保存成功</span>
        </div>
      )}

      {/* 分块参数修改提示弹窗 */}
      {showChunkParamTip && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={() => setShowChunkParamTip(false)}>
          <div className="bg-[#1e1e2a] border border-yellow-500/30 rounded-xl p-6 w-[440px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center">
                <Settings className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-[#e4e4e9]">提示</h3>
              </div>
            </div>
            <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3 mb-4">
              <div className="text-[12px] text-[#9a9aa4] leading-relaxed">
                分块参数已修改，<b className="text-yellow-400">仅对新上传文档生效</b>。<br />
                已有文档需要手动执行<b className="text-indigo-400">【重解析】</b>才能应用新参数。
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleChunkParamTipConfirm}>确定</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
