import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Template } from '@/lib/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Search, Plus, Trash2, X, AlertTriangle,
  Loader2, Send, Copy, Pencil,
  FileText, MessageSquare, Eye,
  Tag, Globe, Lock,
} from 'lucide-react'

type TypeFilter = '全部' | '任务模板' | '会话模板'
type ScopeTab = '我的模板' | '系统公共模板'

interface DrawerForm {
  name: string
  type: 'task' | 'conversation'
  description: string
  tags: string
  is_public: boolean
  // 任务模板
  default_name: string
  skill: string
  datasource_ids: string[]
  agent_ids: string[]
  kb_ids: string[]
  mcp_ids: string[]
  auto_import: boolean
  // 会话模板
  prompt: string
}

const emptyForm: DrawerForm = {
  name: '', type: 'task', description: '', tags: '', is_public: false,
  default_name: '', skill: '', datasource_ids: [], agent_ids: [], kb_ids: [], mcp_ids: [], auto_import: true,
  prompt: '',
}

export function TemplatePanel() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQ, setSearchQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('全部')
  const [scopeTab, setScopeTab] = useState<ScopeTab>('我的模板')

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [form, setForm] = useState<DrawerForm>(emptyForm)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null)

  // Preview
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null)

  const load = async () => {
    setLoading(true)
    const typeParam = typeFilter === '全部' ? undefined : typeFilter === '任务模板' ? 'task' : 'conversation'
    const r = await api.listTemplates(typeParam)
    if (r.success) setTemplates((r.data as Template[]) || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = templates.filter(t => {
    const matchSearch = !searchQ || t.name.toLowerCase().includes(searchQ.toLowerCase()) || (t.description || '').toLowerCase().includes(searchQ.toLowerCase())
    const matchType = typeFilter === '全部' || (typeFilter === '任务模板' ? t.type === 'task' : t.type === 'conversation')
    const matchScope = scopeTab === '我的模板' ? !t.is_public : t.is_public
    return matchSearch && matchType && matchScope
  })

  const openAdd = () => {
    setEditingTemplate(null)
    setForm(emptyForm)
    setFormErrors({})
    setDrawerOpen(true)
  }

  const openEdit = (template: Template) => {
    setEditingTemplate(template)
    setForm({
      name: template.name,
      type: template.type,
      description: template.description || '',
      tags: (template.tags || []).join(', '),
      is_public: template.is_public,
      default_name: template.default_name || '',
      skill: template.skill || '',
      datasource_ids: template.datasource_ids || [],
      agent_ids: template.agent_ids || [],
      kb_ids: template.kb_ids || [],
      mcp_ids: template.mcp_ids || [],
      auto_import: template.auto_import ?? true,
      prompt: template.prompt || '',
    })
    setFormErrors({})
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setEditingTemplate(null)
  }

  const handleSave = async () => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = '请输入模板名称'
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    const payload = {
      name: form.name.trim(),
      type: form.type,
      description: form.description.trim(),
      tags: form.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
      is_public: form.is_public,
      default_name: form.default_name.trim(),
      skill: form.skill,
      datasource_ids: form.datasource_ids,
      agent_ids: form.agent_ids,
      kb_ids: form.kb_ids,
      mcp_ids: form.mcp_ids,
      auto_import: form.auto_import,
      prompt: form.prompt.trim(),
    }

    let ok = false
    if (editingTemplate) {
      const r = await api.updateTemplate(editingTemplate.id, payload)
      ok = r.success
    } else {
      const r = await api.createTemplate(payload)
      ok = r.success
    }

    if (ok) {
      closeDrawer()
      await load()
    }
    setSaving(false)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const r = await api.deleteTemplate(deleteTarget.id)
    if (r.success) { setDeleteTarget(null); load() }
  }

  const handleDuplicate = async (template: Template) => {
    const r = await api.duplicateTemplate(template.id)
    if (r.success) load()
  }

  const handleUseTemplate = (template: Template) => {
    // TODO: 跳转到新建任务/会话页面，自动填充模板配置
    console.log('使用模板:', template)
    alert(`使用模板「${template.name}」，跳转到新建任务页面（待实现路由联动）`)
  }

  const getTypeIcon = (type: string) => {
    if (type === 'task') return <FileText className="w-4 h-4 text-indigo-400" />
    return <MessageSquare className="w-4 h-4 text-cyan-400" />
  }

  const getTypeLabel = (type: string) => {
    return type === 'task' ? '任务模板' : '会话模板'
  }

  const getTypeBadgeColor = (type: string) => {
    return type === 'task' ? 'bg-indigo-500/15 text-indigo-400' : 'bg-cyan-500/15 text-cyan-400'
  }

  const typeTabs: TypeFilter[] = ['全部', '任务模板', '会话模板']
  const scopeTabs: ScopeTab[] = ['我的模板', '系统公共模板']

  return (
    <div className="relative">
      {/* ---- 顶部标题栏 ---- */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">模板中心</h2>
        <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90" onClick={openAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          创建模板
        </Button>
      </div>

      {/* ---- 搜索 + 类型筛选 ---- */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
          <Input
            className="h-8 pl-8 pr-3 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
            placeholder="搜索模板名称"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1">
          {typeTabs.map(tab => (
            <button
              key={tab}
              className={cn(
                'h-7 px-3 rounded-md text-[12px] transition-colors',
                typeFilter === tab
                  ? 'bg-[#5b7cfa] text-white'
                  : 'bg-[#16161e] text-[#8b8b9e] hover:text-[#cdd3e0] border border-[#252530]'
              )}
              onClick={() => setTypeFilter(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* ---- 卡片网格列表 ---- */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-[#5a5a70] animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-12 h-12 rounded-xl bg-[#1a1a24] border border-[#252530] flex items-center justify-center mb-3">
            <FileText className="w-6 h-6 text-[#3a3a4a]" />
          </div>
          <p className="text-[13px] text-[#5a5a70] mb-1">暂无模板</p>
          <p className="text-[11px] text-[#3a3a4a]">点击【创建模板】添加第一个模板</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {filtered.map(template => (
            <div
              key={template.id}
              className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4 hover:border-[#3a3a45] transition-colors flex flex-col"
            >
              {/* 名称 + 类型 */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  {getTypeIcon(template.type)}
                  <span className="text-[13px] font-semibold text-[#e4e4e9]">{template.name}</span>
                </div>
                <Badge variant="outline" className={cn('text-[10px] border-0 shrink-0', getTypeBadgeColor(template.type))}>
                  {getTypeLabel(template.type)}
                </Badge>
              </div>

              {/* 描述 */}
              {template.description && (
                <p className="text-[11px] text-[#8b8b9e] mb-2 line-clamp-2 flex-1">{template.description}</p>
              )}

              {/* 标签 */}
              {template.tags && template.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mb-3">
                  {template.tags.map((tag, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[#26262d] text-[#9a9aa4] border border-[#2f2f38]">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              {/* 可见性 */}
              <div className="flex items-center gap-1.5 mb-3">
                {template.is_public ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-[#5a5a70]">
                    <Globe className="w-3 h-3" />公共模板
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] text-[#5a5a70]">
                    <Lock className="w-3 h-3" />个人模板
                  </span>
                )}
                {template.creator && (
                  <span className="text-[10px] text-[#3a3a4a]">· {template.creator}</span>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-1 pt-2 border-t border-[#252530]">
                <Button size="sm" variant="ghost" className="h-6 text-[11px] text-indigo-400 hover:text-indigo-300 px-2" onClick={() => handleUseTemplate(template)}>
                  使用模板
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] px-2" onClick={() => openEdit(template)}>
                  <Pencil className="w-3 h-3 mr-0.5" />编辑
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] px-2" onClick={() => handleDuplicate(template)}>
                  <Copy className="w-3 h-3 mr-0.5" />复制
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] px-2" onClick={() => setPreviewTemplate(template)}>
                  <Eye className="w-3 h-3 mr-0.5" />预览
                </Button>
                {!template.is_public && (
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] text-red-400 hover:text-red-300 px-2 ml-auto" onClick={() => setDeleteTarget(template)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- 底部标签切换 ---- */}
      <div className="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-[#252530]">
        {scopeTabs.map(tab => (
          <button
            key={tab}
            className={cn(
              'text-[12px] px-3 py-1.5 rounded-md transition-colors',
              scopeTab === tab
                ? 'bg-[#5b7cfa]/15 text-indigo-400'
                : 'text-[#5a5a70] hover:text-[#9a9aa4]'
            )}
            onClick={() => setScopeTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ---- 右侧抽屉：创建 / 编辑模板 ---- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={closeDrawer}>
          <div
            className="w-[460px] h-full bg-[#1a1a24] border-l border-[#252530] flex flex-col shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* 抽屉头部 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#252530]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9]">
                {editingTemplate ? '编辑模板' : '创建模板'}
              </h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={closeDrawer}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 抽屉表单 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 模板名称 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">模板名称 <span className="text-red-400">*</span></label>
                <Input
                  className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a]', formErrors.name ? 'border-red-500/50' : 'border-[#252530]')}
                  placeholder="例如：跨工程页面展示改动模板"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
                {formErrors.name && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.name}</p>}
              </div>

              {/* 模板类型 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">模板类型</label>
                <Select value={form.type} onValueChange={v => setForm({ ...form, type: v as 'task' | 'conversation' })}>
                  <SelectTrigger className="h-8 text-[12px] bg-[#16161e] border-[#252530]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="task">任务模板</SelectItem>
                    <SelectItem value="conversation">会话模板</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 描述 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">描述</label>
                <Textarea
                  className="min-h-[60px] text-[12px] bg-[#16161e] border border-[#252530] p-2 placeholder:text-[#4a4a5a]"
                  placeholder="说明适用场景"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                />
              </div>

              {/* 标签 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 flex items-center gap-1">
                  <Tag className="w-3 h-3" /> 标签
                </label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a]"
                  placeholder="如 页面展示、下单拆单、订单受理（逗号分隔）"
                  value={form.tags}
                  onChange={e => setForm({ ...form, tags: e.target.value })}
                />
              </div>

              {/* 是否公开 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {form.is_public ? <Globe className="w-3.5 h-3.5 text-[#8b8b9e]" /> : <Lock className="w-3.5 h-3.5 text-[#8b8b9e]" />}
                  <span className="text-[11px] text-[#8b8b9e]">{form.is_public ? '公共模板（本空间所有人可用）' : '个人模板（仅自己可见）'}</span>
                </div>
                <button
                  className={cn(
                    'relative w-9 h-5 rounded-full transition-colors',
                    form.is_public ? 'bg-indigo-500' : 'bg-[#2a2a35]'
                  )}
                  onClick={() => setForm({ ...form, is_public: !form.is_public })}
                >
                  <div className={cn(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
                    form.is_public ? 'left-[18px]' : 'left-0.5'
                  )} />
                </button>
              </div>

              {/* 任务模板配置 */}
              {form.type === 'task' && (
                <div className="space-y-3 pt-2 border-t border-[#252530]">
                  <p className="text-[11px] text-[#5a5a70] font-medium">任务模板配置</p>

                  <div>
                    <label className="text-[11px] text-[#8b8b9e] mb-1 block">默认任务名称</label>
                    <Input
                      className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a]"
                      placeholder="预设任务名称"
                      value={form.default_name}
                      onChange={e => setForm({ ...form, default_name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-[#8b8b9e] mb-1 block">预设技能</label>
                    <Input
                      className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a]"
                      placeholder="如：页面展示"
                      value={form.skill}
                      onChange={e => setForm({ ...form, skill: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-[#8b8b9e] mb-1 block">绑定数据源</label>
                    <div className="flex flex-wrap gap-1.5">
                      {['前端工程', '订单中心'].map(ds => (
                        <button
                          key={ds}
                          className={cn(
                            'px-2.5 py-1 rounded text-[11px] transition-all border',
                            form.datasource_ids.includes(ds)
                              ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                              : 'bg-[#16161e] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0]'
                          )}
                          onClick={() => {
                            const ids = form.datasource_ids.includes(ds)
                              ? form.datasource_ids.filter(id => id !== ds)
                              : [...form.datasource_ids, ds]
                            setForm({ ...form, datasource_ids: ids })
                          }}
                        >
                          {ds}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] text-[#8b8b9e] mb-1 block">绑定智能体</label>
                    <div className="flex flex-wrap gap-1.5">
                      {['页面展示Agent', '下单拆单Agent'].map(a => (
                        <button
                          key={a}
                          className={cn(
                            'px-2.5 py-1 rounded text-[11px] transition-all border',
                            form.agent_ids.includes(a)
                              ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                              : 'bg-[#16161e] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0]'
                          )}
                          onClick={() => {
                            const ids = form.agent_ids.includes(a)
                              ? form.agent_ids.filter(id => id !== a)
                              : [...form.agent_ids, a]
                            setForm({ ...form, agent_ids: ids })
                          }}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] text-[#8b8b9e] mb-1 block">绑定知识库</label>
                    <div className="flex flex-wrap gap-1.5">
                      {['跨工程迁移知识库', '历史评估案例'].map(kb => (
                        <button
                          key={kb}
                          className={cn(
                            'px-2.5 py-1 rounded text-[11px] transition-all border',
                            form.kb_ids.includes(kb)
                              ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                              : 'bg-[#16161e] border-[#252530] text-[#8b8b9e] hover:text-[#cdd3e0]'
                          )}
                          onClick={() => {
                            const ids = form.kb_ids.includes(kb)
                              ? form.kb_ids.filter(id => id !== kb)
                              : [...form.kb_ids, kb]
                            setForm({ ...form, kb_ids: ids })
                          }}
                        >
                          {kb}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[#8b8b9e]">产物自动入库</span>
                    <button
                      className={cn(
                        'relative w-9 h-5 rounded-full transition-colors',
                        form.auto_import ? 'bg-green-500' : 'bg-[#2a2a35]'
                      )}
                      onClick={() => setForm({ ...form, auto_import: !form.auto_import })}
                    >
                      <div className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
                        form.auto_import ? 'left-[18px]' : 'left-0.5'
                      )} />
                    </button>
                  </div>
                </div>
              )}

              {/* 会话模板配置 */}
              {form.type === 'conversation' && (
                <div className="space-y-3 pt-2 border-t border-[#252530]">
                  <p className="text-[11px] text-[#5a5a70] font-medium">会话模板配置</p>

                  <div>
                    <label className="text-[11px] text-[#8b8b9e] mb-1 block">预设提示词</label>
                    <Textarea
                      className="min-h-[80px] text-[12px] bg-[#16161e] border border-[#252530] p-2 placeholder:text-[#4a4a5a]"
                      placeholder="预设对话开场提示词"
                      value={form.prompt}
                      onChange={e => setForm({ ...form, prompt: e.target.value })}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 抽屉底部按钮 */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#252530]">
              <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors" onClick={closeDrawer}>
                取消
              </button>
              <Button
                className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <><Send className="w-3.5 h-3.5 mr-1" /></>}
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 预览弹窗 ---- */}
      {previewTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPreviewTemplate(null)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {getTypeIcon(previewTemplate.type)}
                  <h3 className="text-[14px] font-semibold text-[#e4e4e9]">{previewTemplate.name}</h3>
                  <Badge variant="outline" className={cn('text-[10px] border-0', getTypeBadgeColor(previewTemplate.type))}>
                    {getTypeLabel(previewTemplate.type)}
                  </Badge>
                </div>
                <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setPreviewTemplate(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>

              {previewTemplate.description && (
                <p className="text-[12px] text-[#9a9aa4] mb-4">{previewTemplate.description}</p>
              )}

              {previewTemplate.tags && previewTemplate.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {previewTemplate.tags.map((tag, i) => (
                    <span key={i} className="text-[11px] px-2 py-0.5 rounded bg-[#26262d] text-[#9a9aa4] border border-[#2f2f38]">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="space-y-2 text-[12px]">
                {previewTemplate.type === 'task' && (
                  <>
                    {previewTemplate.skill && (
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">预设技能：</span>
                        <span className="text-[#cdd3e0]">{previewTemplate.skill}</span>
                      </div>
                    )}
                    {previewTemplate.datasource_ids && previewTemplate.datasource_ids.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">数据源：</span>
                        <span className="text-[#cdd3e0]">{previewTemplate.datasource_ids.join('、')}</span>
                      </div>
                    )}
                    {previewTemplate.agent_ids && previewTemplate.agent_ids.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">智能体：</span>
                        <span className="text-[#cdd3e0]">{previewTemplate.agent_ids.join('、')}</span>
                      </div>
                    )}
                    {previewTemplate.kb_ids && previewTemplate.kb_ids.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[#5a5a70] w-16">知识库：</span>
                        <span className="text-[#cdd3e0]">{previewTemplate.kb_ids.join('、')}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-[#5a5a70] w-16">自动入库：</span>
                      <span className={previewTemplate.auto_import ? 'text-green-400' : 'text-[#5a5a70]'}>
                        {previewTemplate.auto_import ? '开启' : '关闭'}
                      </span>
                    </div>
                  </>
                )}
                {previewTemplate.type === 'conversation' && previewTemplate.prompt && (
                  <div>
                    <span className="text-[#5a5a70]">预设提示词：</span>
                    <p className="text-[#cdd3e0] mt-1 p-2 rounded bg-[#16161e] border border-[#252530]">{previewTemplate.prompt}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors" onClick={() => setPreviewTemplate(null)}>
                关闭
              </button>
              <Button
                className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white"
                onClick={() => { setPreviewTemplate(null); handleUseTemplate(previewTemplate) }}
              >
                使用此模板
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 删除确认弹窗 ---- */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setDeleteTarget(null)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[400px]" onClick={e => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <h3 className="text-[14px] font-semibold text-[#e4e4e9]">删除模板</h3>
              </div>
              <p className="text-[12px] text-[#9a9aa4]">
                是否确认删除模板《{deleteTarget.name}》？此操作不可恢复。
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                className="text-[12px] text-white px-4 py-1.5 rounded-md bg-red-500 hover:bg-red-600 transition-colors flex items-center gap-1"
                onClick={handleDelete}
              >
                <Trash2 className="w-3 h-3" />
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
