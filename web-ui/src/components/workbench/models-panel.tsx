import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  Search, Plus, Trash2, X, AlertTriangle,
  CheckCircle2, Circle, Bot, Loader2, Send, ChevronRight
} from 'lucide-react'
import { api } from '@/lib/api'
import type { ModelDef } from '@/lib/types'

/* ---- 类型 ---- */
type ModelType = 'LLM' | 'Embedding'
type ModelProvider = 'API接口' | '本地部署' | 'MCP模型'
type ModelStatus = '已启用' | '已停用'

const typeOptions: ModelType[] = ['LLM', 'Embedding']
const providerOptions: ModelProvider[] = ['API接口', '本地部署', 'MCP模型']
const statusOptions: ModelStatus[] = ['已启用', '已停用']

/* ---- 主组件（数据来自后端 /api/models 持久化，模型管理菜单与对话模型下拉共用同一份数据） ---- */
export function ModelsPanel() {
  const [models, setModels] = useState<ModelDef[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<ModelStatus | '全部'>('全部')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // 添加/编辑弹窗
  const [showForm, setShowForm] = useState(false)
  const [editingModel, setEditingModel] = useState<ModelDef | null>(null)
  const [savingForm, setSavingForm] = useState(false)
  const [form, setForm] = useState({
    name: '', modelId: '', type: 'LLM' as ModelType, provider: 'API接口' as ModelProvider,
    apiUrl: '', apiKey: '', version: '', timeout: '60', maxTokens: '4096', description: '',
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [testingConn, setTestingConn] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // 详情抽屉
  const [detailModel, setDetailModel] = useState<ModelDef | null>(null)

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<ModelDef | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadModels = () => {
    setLoading(true)
    api.listModels().then(r => {
      if (r.success) setModels(r.data || [])
    }).catch(() => {}).finally(() => setLoading(false))
  }

  // 挂载与切换回该面板时刷新（与对话下拉共享同一份持久化数据）
  useEffect(() => { loadModels() }, [])

  // 筛选
  const filtered = models.filter(m => {
    const matchSearch = !searchQ || m.name.toLowerCase().includes(searchQ.toLowerCase()) || m.model_id.toLowerCase().includes(searchQ.toLowerCase())
    const matchStatus = statusFilter === '全部' || m.status === statusFilter
    return matchSearch && matchStatus
  })

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(filtered.map(m => m.id)))
  }

  const openAdd = () => {
    setEditingModel(null)
    setForm({ name: '', modelId: '', type: 'LLM', provider: 'API接口', apiUrl: '', apiKey: '', version: '', timeout: '60', maxTokens: '4096', description: '' })
    setFormErrors({})
    setTestResult(null)
    setShowForm(true)
  }

  const openEdit = (model: ModelDef) => {
    setEditingModel(model)
    setForm({
      name: model.name, modelId: model.model_id, type: model.type, provider: model.provider,
      apiUrl: model.api_url || '', apiKey: model.api_key || '', version: model.version || '',
      timeout: String(model.timeout ?? 60), maxTokens: String(model.max_tokens ?? 4096),
      description: model.description || '',
    })
    setFormErrors({})
    setTestResult(null)
    setShowForm(true)
  }

  const handleFormSave = async () => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = '请输入模型名称'
    if (!form.modelId.trim()) errors.modelId = '请输入模型标识'
    if (!form.apiUrl.trim() && form.provider !== '本地部署') errors.apiUrl = '请输入API地址'
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSavingForm(true)
    const payload = {
      name: form.name.trim(), type: form.type, provider: form.provider,
      api_url: form.apiUrl.trim(), api_key: form.apiKey.trim(),
      version: form.version.trim(), timeout: Number(form.timeout) || 60,
      max_tokens: Number(form.maxTokens) || 4096, description: form.description.trim(),
    }
    const r = editingModel
      ? await api.updateModel(editingModel.id, payload)
      : await api.createModel({ ...payload, model_id: form.modelId.trim(), status: '已启用' })
    setSavingForm(false)
    if (r.success) {
      setShowForm(false)
      loadModels()
    }
  }

  const handleTestConnection = async () => {
    if (!form.apiUrl.trim() || !form.modelId.trim()) {
      setTestResult({ ok: false, msg: '请先填写 API 地址与模型标识' })
      return
    }
    setTestingConn(true)
    setTestResult(null)
    // 已保存模型按 id 测试（可命中最新落库配置），否则按表单配置直测
    const r = editingModel
      ? await api.testModel(editingModel.id)
      : await api.testModelConfig({
          type: form.type,
          model_id: form.modelId.trim(),
          api_url: form.apiUrl.trim(),
          api_key: form.apiKey.trim() || undefined,
          timeout: Number(form.timeout) || 30,
        })
    setTestingConn(false)
    if (r.success && r.data) {
      setTestResult({ ok: r.data.ok, msg: r.data.message })
    } else {
      setTestResult({ ok: false, msg: r.error || r.detail || '测试请求失败，请检查后端服务' })
    }
  }

  const handleToggleStatus = async (id: number) => {
    const m = models.find(x => x.id === id)
    if (!m) return
    const enabled = m.status !== '已启用'
    const r = await api.toggleModel(id, enabled)
    if (r.success) {
      setModels(prev => prev.map(x => x.id === id ? { ...x, status: enabled ? ('已启用' as const) : ('已停用' as const) } : x))
    }
  }

  const handleBatchEnable = async () => {
    await Promise.all([...selectedIds].map(id => api.toggleModel(id, true)))
    loadModels()
    setSelectedIds(new Set())
  }

  const handleBatchDisable = async () => {
    await Promise.all([...selectedIds].map(id => api.toggleModel(id, false)))
    loadModels()
    setSelectedIds(new Set())
  }

  const handleBatchDelete = async () => {
    await Promise.all([...selectedIds].map(id => api.deleteModel(id)))
    loadModels()
    setSelectedIds(new Set())
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    const r = await api.deleteModel(deleteTarget.id)
    setDeleting(false)
    if (r.success) {
      setDeleteTarget(null)
      loadModels()
    }
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">模型管理</h2>
        <Button className="h-8 text-[12px] bg-indigo-500 hover:bg-indigo-600 text-white" onClick={openAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          添加模型
        </Button>
      </div>

      {/* 搜索 + 筛选 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
          <Input
            className="h-8 pl-8 pr-3 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
            placeholder="搜索模型名称/标识"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-[#8b8b9e]">
          <span>状态筛选：</span>
          <select
            className="h-7 rounded-md text-[12px] bg-[#16161e] border border-[#252530] px-2 text-[#cdd3e0]"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as ModelStatus | '全部')}
          >
            <option value="全部">全部</option>
            {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* 表格 */}
      <div className="rounded-xl border border-[#252530] overflow-hidden">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[#16161e] border-b border-[#252530]">
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">模型名称</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">模型标识</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">类型</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">接入方式</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">状态</th>
              <th className="px-3 py-2.5 text-left text-[#8b8b9e] font-medium">创建时间</th>
              <th className="px-3 py-2.5 text-right text-[#8b8b9e] font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && models.length === 0 && (
              <tr><td colSpan={8} className="py-14 text-center text-[12px] text-[#5a5a70]">加载模型配置…</td></tr>
            )}
            {!loading && filtered.map(model => (
              <tr key={model.id} className="border-b border-[#1e1e28] hover:bg-white/[0.02] transition-colors">
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500"
                    checked={selectedIds.has(model.id)}
                    onChange={() => toggleSelect(model.id)}
                  />
                </td>
                <td className="px-3 py-2.5 text-[#cdd3e0] font-medium">{model.name}</td>
                <td className="px-3 py-2.5">
                  <code className="text-[11px] text-[#5a5a70] bg-[#16161e] px-1.5 py-0.5 rounded">{model.model_id}</code>
                </td>
                <td className="px-3 py-2.5">
                  <span className={cn(
                    'text-[11px] px-2 py-0.5 rounded',
                    model.type === 'LLM' ? 'bg-indigo-500/15 text-indigo-400' : 'bg-cyan-500/15 text-cyan-400'
                  )}>
                    {model.type}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-[#9a9aa4]">{model.provider}</td>
                <td className="px-3 py-2.5">
                  {model.status === '已启用' ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-green-400">
                      <CheckCircle2 className="w-3 h-3" />已启用
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-yellow-400">
                      <Circle className="w-3 h-3" />已停用
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-[#5a5a70]">{(model.created_at || '').slice(0, 10)}</td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors" onClick={() => setDetailModel(model)}>查看</button>
                    <span className="text-[#2a2a35]">|</span>
                    <button className="text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0] transition-colors" onClick={() => openEdit(model)}>编辑</button>
                    <span className="text-[#2a2a35]">|</span>
                    <button
                      className={cn(
                        'text-[11px] transition-colors',
                        model.status === '已启用' ? 'text-yellow-400 hover:text-yellow-300' : 'text-green-400 hover:text-green-300'
                      )}
                      onClick={() => handleToggleStatus(model.id)}
                    >
                      {model.status === '已启用' ? '停用' : '启用'}
                    </button>
                    <span className="text-[#2a2a35]">|</span>
                    <button className="text-[11px] text-red-400 hover:text-red-300 transition-colors" onClick={() => setDeleteTarget(model)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Bot className="w-8 h-8 text-[#3a3a4a] mb-2" />
            <p className="text-[13px] text-[#5a5a70] mb-1">暂无模型配置</p>
            <p className="text-[11px] text-[#3a3a4a]">点击【添加模型】接入大模型或Embedding向量模型</p>
          </div>
        )}
      </div>

      {/* 底部批量操作栏 */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-[#16161e] border border-[#252530]">
          <span className="text-[12px] text-[#9a9aa4]">已选择 {selectedIds.size} 条模型</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-[11px] text-[#9a9aa4] hover:text-green-400" onClick={handleBatchEnable}>批量启用</Button>
            <Button variant="ghost" size="sm" className="h-7 text-[11px] text-[#9a9aa4] hover:text-yellow-400" onClick={handleBatchDisable}>批量停用</Button>
            <Button variant="ghost" size="sm" className="h-7 text-[11px] text-[#9a9aa4] hover:text-red-400" onClick={handleBatchDelete}>批量删除</Button>
          </div>
        </div>
      )}

      {/* ---- 添加/编辑模型弹窗 ---- */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowForm(false)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[520px] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9]">{editingModel ? '编辑模型' : '添加模型'}</h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setShowForm(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 模型名称 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">模型名称 <span className="text-red-400">*</span></label>
                <Input className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a]', formErrors.name ? 'border-red-500/50' : 'border-[#2a2a35]')} placeholder="例如：通义千问4" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                {formErrors.name && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.name}</p>}
              </div>

              {/* 模型标识 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">模型标识 <span className="text-red-400">*</span></label>
                <Input
                  className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a] font-mono', formErrors.modelId ? 'border-red-500/50' : 'border-[#2a2a35]')}
                  placeholder="唯一英文ID，如 qwen4"
                  value={form.modelId}
                  onChange={e => setForm({ ...form, modelId: e.target.value })}
                  disabled={!!editingModel}
                />
                {editingModel && <p className="text-[10px] text-[#4a4a5a] mt-1">模型标识创建后不可修改</p>}
                {formErrors.modelId && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.modelId}</p>}
              </div>

              {/* 类型 + 接入方式 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] text-[#8b8b9e] mb-1 block">模型类型</label>
                  <select className="h-8 w-full rounded-md text-[12px] bg-[#16161e] border border-[#2a2a35] px-2 text-[#cdd3e0]" value={form.type} onChange={e => setForm({ ...form, type: e.target.value as ModelType })}>
                    {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-[#8b8b9e] mb-1 block">接入方式</label>
                  <select className="h-8 w-full rounded-md text-[12px] bg-[#16161e] border border-[#2a2a35] px-2 text-[#cdd3e0]" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value as ModelProvider })}>
                    {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              {/* API地址 */}
              {form.provider !== '本地部署' && (
                <div>
                  <label className="text-[11px] text-[#8b8b9e] mb-1 block">API地址 <span className="text-red-400">*</span></label>
                  <Input className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a] font-mono', formErrors.apiUrl ? 'border-red-500/50' : 'border-[#2a2a35]')} placeholder="https://api.example.com/v1" value={form.apiUrl} onChange={e => setForm({ ...form, apiUrl: e.target.value })} />
                  {formErrors.apiUrl && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.apiUrl}</p>}
                </div>
              )}

              {/* API密钥 */}
              {form.provider !== '本地部署' && (
                <div>
                  <label className="text-[11px] text-[#8b8b9e] mb-1 block">API密钥</label>
                  <Input className="h-8 text-[12px] bg-[#16161e] border border-[#2a2a35] placeholder:text-[#4a4a5a] font-mono" type="password" placeholder="sk-xxxxxxxxxxxx" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
                </div>
              )}

              {/* 模型版本 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">模型版本</label>
                <Input className="h-8 text-[12px] bg-[#16161e] border border-[#2a2a35] placeholder:text-[#4a4a5a]" placeholder="例如：v1.0" value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} />
              </div>

              {/* 超时 + Token */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] text-[#8b8b9e] mb-1 block">超时时间（s）</label>
                  <Input className="h-8 text-[12px] bg-[#16161e] border border-[#2a2a35] placeholder:text-[#4a4a5a]" type="number" placeholder="60" value={form.timeout} onChange={e => setForm({ ...form, timeout: e.target.value })} />
                </div>
                <div>
                  <label className="text-[11px] text-[#8b8b9e] mb-1 block">最大上下文Token</label>
                  <Input className="h-8 text-[12px] bg-[#16161e] border border-[#2a2a35] placeholder:text-[#4a4a5a]" type="number" placeholder="4096" value={form.maxTokens} onChange={e => setForm({ ...form, maxTokens: e.target.value })} />
                </div>
              </div>

              {/* 描述 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">描述</label>
                <Textarea className="min-h-[50px] text-[12px] bg-[#16161e] border border-[#2a2a35] p-2 placeholder:text-[#4a4a5a]" placeholder="备注用途" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              </div>

              {/* 测试连接 */}
              <div className="flex items-center gap-3">
                <button
                  className={cn(
                    'h-7 px-3 flex items-center gap-1.5 rounded-md text-[11px] transition-colors',
                    testingConn ? 'bg-[#252530] text-[#5a5a70]' : 'bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25'
                  )}
                  onClick={handleTestConnection}
                  disabled={testingConn}
                >
                  {testingConn ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {testingConn ? '测试中...' : '测试连接'}
                </button>
                {testResult && (
                  <span className={cn('text-[11px]', testResult.ok ? 'text-green-400' : 'text-red-400')}>
                    {testResult.msg}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors" onClick={() => setShowForm(false)}>取消</button>
              <button className={cn('text-[12px] text-white px-4 py-1.5 rounded-md transition-colors flex items-center gap-1', savingForm ? 'bg-[#2a2a35]' : 'bg-indigo-500 hover:bg-indigo-600')} onClick={handleFormSave} disabled={savingForm}>
                {savingForm && <Loader2 className="w-3 h-3 animate-spin" />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 模型详情抽屉 ---- */}
      {detailModel && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setDetailModel(null)}>
          <div className="w-[420px] h-full bg-[#1a1a24] border-l border-[#252530] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#252530]">
              <h3 className="text-[13px] font-semibold text-[#e4e4e9]">模型详情：{detailModel.name}</h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setDetailModel(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* 基础信息 */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">基础信息</h4>
                <div className="space-y-1.5 text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="text-[#5a5a70] w-16">模型名称</span>
                    <span className="text-[#cdd3e0]">{detailModel.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#5a5a70] w-16">标识</span>
                    <code className="text-[11px] text-[#5a5a70] bg-[#16161e] px-1.5 py-0.5 rounded">{detailModel.model_id}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#5a5a70] w-16">类型</span>
                    <span className={cn('text-[11px] px-2 py-0.5 rounded', detailModel.type === 'LLM' ? 'bg-indigo-500/15 text-indigo-400' : 'bg-cyan-500/15 text-cyan-400')}>{detailModel.type}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#5a5a70] w-16">状态</span>
                    {detailModel.status === '已启用' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-green-400"><CheckCircle2 className="w-3 h-3" />已启用</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-yellow-400"><Circle className="w-3 h-3" />已停用</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#5a5a70] w-16">接入方式</span>
                    <span className="text-[#cdd3e0]">{detailModel.provider}</span>
                  </div>
                  {detailModel.api_url && (
                    <div className="flex items-center gap-2">
                      <span className="text-[#5a5a70] w-16">API地址</span>
                      <span className="text-[#cdd3e0] font-mono text-[11px] truncate">{detailModel.api_url}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 调用统计 */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">调用统计（最近7天）</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-[#16161e] border border-[#252530] p-3 text-center">
                    <p className="text-[18px] font-semibold text-[#e4e4e9]">{detailModel.total_calls ?? 0}</p>
                    <p className="text-[10px] text-[#5a5a70] mt-0.5">总调用次数</p>
                  </div>
                  <div className="rounded-lg bg-[#16161e] border border-[#252530] p-3 text-center">
                    <p className="text-[18px] font-semibold text-red-400">{detailModel.fail_count ?? 0}</p>
                    <p className="text-[10px] text-[#5a5a70] mt-0.5">失败次数</p>
                  </div>
                </div>
              </div>

              {/* 被引用智能体 */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">被引用智能体列表</h4>
                {(detailModel.used_by_agents || []).length > 0 ? (
                  <div className="space-y-1.5">
                    {(detailModel.used_by_agents || []).map(a => (
                      <div key={a} className="flex items-center gap-2 text-[12px]">
                        <ChevronRight className="w-3 h-3 text-[#4a4a5a]" />
                        <Bot className="w-3 h-3 text-indigo-400" />
                        <span className="text-[#cdd3e0]">{a}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-[#3a3a4a]">暂无智能体引用此模型</p>
                )}
              </div>

              {/* 快速测试 */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-medium text-[#8b8b9e] uppercase tracking-wider">快速测试</h4>
                <Textarea className="min-h-[60px] text-[12px] bg-[#16161e] border border-[#252530] p-2 placeholder:text-[#4a4a5a] font-mono" placeholder="输入prompt，直接调用模型验证..." />
                <button className="h-7 px-3 flex items-center gap-1.5 rounded-md bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 text-[11px] transition-colors">
                  <Send className="w-3 h-3" />
                  发送测试
                </button>
              </div>
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
                <h3 className="text-[14px] font-semibold text-[#e4e4e9]">删除模型</h3>
              </div>
              <p className="text-[12px] text-[#9a9aa4] mb-2">
                是否确认删除模型《{deleteTarget.name}》？
              </p>
              {(deleteTarget.used_by_agents || []).length > 0 && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 mb-2">
                  <p className="text-[11px] text-red-400">
                    该模型已被以下智能体引用，删除前请先解绑：
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(deleteTarget.used_by_agents || []).map(a => (
                      <span key={a} className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">{a}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors" onClick={() => setDeleteTarget(null)}>取消</button>
              <button
                className={cn(
                  'text-[12px] text-white px-4 py-1.5 rounded-md transition-colors flex items-center gap-1',
                  (deleteTarget.used_by_agents || []).length > 0 || deleting ? 'bg-[#2a2a35] text-[#5a5a70] cursor-not-allowed' : 'bg-red-500 hover:bg-red-600'
                )}
                onClick={handleDelete}
                disabled={(deleteTarget.used_by_agents || []).length > 0 || deleting}
              >
                {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
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