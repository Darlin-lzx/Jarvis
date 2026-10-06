import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { Datasource } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  Search, Plus, Trash2, X, AlertTriangle,
  CheckCircle2, Circle, Loader2, Send,
  Settings, Zap, Power, Clock, Database,
} from 'lucide-react'

type TypeFilter = '全部' | 'Oracle' | 'MySQL' | 'PostgreSQL'
type StatusFilter = '全部' | '已启用' | '已停用' | '连接异常'

interface DrawerForm {
  name: string
  kind: string
  host: string
  port: string
  database: string
  username: string
  password: string
  timeout: string
  description: string
  tags: string
}

const emptyForm: DrawerForm = {
  name: '', kind: 'Oracle', host: '', port: '', database: '',
  username: '', password: '', timeout: '60', description: '', tags: '',
}

const DB_KINDS = ['Oracle', 'MySQL', 'PostgreSQL']

export function DatasourcesPanel() {
  const [datasources, setDatasources] = useState<Datasource[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('全部')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('全部')

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingDs, setEditingDs] = useState<Datasource | null>(null)
  const [form, setForm] = useState<DrawerForm>(emptyForm)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testingConn, setTestingConn] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Datasource | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api.listDatasources()
    if (r.success) {
      setDatasources((r.data as Datasource[]) || [])
      setLoadError('')
    } else {
      // 接口失败不再静默回退 mock，明确提示错误（避免评委/用户误以为数据真实）
      setDatasources([])
      setLoadError(r.error || r.detail || '加载数据源失败，请检查后端服务')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = datasources.filter(d => {
    const matchSearch = !searchQ || d.name.toLowerCase().includes(searchQ.toLowerCase()) || (d.location || '').toLowerCase().includes(searchQ.toLowerCase())
    const matchType = typeFilter === '全部' || (d.kind || '').toLowerCase() === typeFilter.toLowerCase()
    let matchStatus = true
    if (statusFilter === '已启用') matchStatus = d.enabled && d.health_ok !== false
    else if (statusFilter === '已停用') matchStatus = !d.enabled
    else if (statusFilter === '连接异常') matchStatus = d.health_ok === false
    return matchSearch && matchType && matchStatus
  })

  const openAdd = () => {
    setEditingDs(null)
    setForm(emptyForm)
    setFormErrors({})
    setTestResult(null)
    setDrawerOpen(true)
  }

  const openEdit = (ds: Datasource) => {
    setEditingDs(ds)
    const [host, port] = (ds.location || '').split(':')
    setForm({
      name: ds.name,
      kind: ds.kind,
      host: host || '',
      port: port || '',
      database: '',
      username: ds.username || '',
      password: '',
      timeout: String(ds.timeout || 60),
      description: ds.description || '',
      tags: (ds.tags || []).join(', '),
    })
    setFormErrors({})
    setTestResult(null)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setEditingDs(null)
  }

  const handleSave = async () => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = '请输入数据源名称'
    if (!form.host.trim()) errors.host = '请输入主机地址'
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    const location = form.port ? `${form.host}:${form.port}` : form.host
    const payload = {
      name: form.name.trim(),
      kind: form.kind.toLowerCase(),
      location,
      username: form.username.trim(),
      password: form.password.trim(),
      dsn: '',
      timeout: Number(form.timeout) || 60,
      description: form.description.trim(),
      tags: form.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
    }

    let ok = false
    if (editingDs) {
      const r = await api.updateDatasource(editingDs.name, payload)
      ok = r.success
    } else {
      const r = await api.createDatasource(payload)
      ok = r.success
    }

    if (ok) {
      closeDrawer()
      load()
    } else {
      alert('保存失败')
    }
    setSaving(false)
  }

  const handleTestConnection = async () => {
    if (!editingDs) return
    setTestingConn(true)
    setTestResult(null)
    const r = await api.testDatasource(editingDs.name)
    setTestingConn(false)
    setTestResult(r.success
      ? { ok: true, msg: JSON.stringify(r.data, null, 2) || '连接成功' }
      : { ok: false, msg: r.detail || '连接失败' }
    )
  }

  const handleToggle = async (ds: Datasource) => {
    const r = await api.toggleDatasource(ds.name, !ds.enabled)
    if (r.success) load()
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const r = await api.deleteDatasource(deleteTarget.name)
    if (r.success) {
      setDeleteTarget(null)
      load()
    }
  }

  const getStatusBadge = (ds: Datasource) => {
    if (ds.health_ok === false) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">
          <AlertTriangle className="w-3 h-3" />连接异常
        </span>
      )
    }
    if (ds.enabled) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
          <CheckCircle2 className="w-3 h-3" />已启用
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400">
        <Circle className="w-3 h-3" />已停用
      </span>
    )
  }

  const getKindBadgeColor = (kind: string) => {
    const colors: Record<string, string> = {
      oracle: 'bg-red-500/15 text-red-400',
      mysql: 'bg-blue-500/15 text-blue-400',
      postgresql: 'bg-indigo-500/15 text-indigo-400',
      'sql server': 'bg-purple-500/15 text-purple-400',
      dm: 'bg-purple-500/15 text-purple-400',
    }
    return colors[kind.toLowerCase()] || 'bg-[#26262d] text-[#9a9aa4]'
  }

  /* 后端 kind 存小写方言名（oracle/mysql/...），展示时映射为友好名称 */
  const KIND_LABELS: Record<string, string> = {
    oracle: 'Oracle', mysql: 'MySQL', postgresql: 'PostgreSQL',
    sqlite: 'SQLite', dm: '达梦', kingbase: '金仓', gaussdb: 'GaussDB',
    'sql server': 'SQL Server',
  }
  const kindLabel = (kind: string) => KIND_LABELS[(kind || '').toLowerCase()] || kind

  const typeTabs: TypeFilter[] = ['全部', 'Oracle', 'MySQL', 'PostgreSQL']
  const statusTabs: StatusFilter[] = ['全部', '已启用', '已停用', '连接异常']

  return (
    <div className="relative">
      {/* ---- 顶部标题栏 ---- */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">数据源</h2>
        <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90" onClick={openAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          新增数据源
        </Button>
      </div>

      {/* ---- 加载失败提示（不回退假数据） ---- */}
      {loadError && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-[12px] text-red-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {loadError}
          <button className="ml-auto underline hover:no-underline" onClick={load}>重试</button>
        </div>
      )}

      {/* ---- 搜索 + 类型筛选 + 状态筛选 ---- */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
          <Input
            className="h-8 pl-8 pr-3 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
            placeholder="搜索数据源名称 / 主机地址"
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
        <div className="flex items-center gap-1">
          {statusTabs.map(tab => (
            <button
              key={tab}
              className={cn(
                'h-7 px-3 rounded-md text-[12px] transition-colors',
                statusFilter === tab
                  ? 'bg-[#5b7cfa] text-white'
                  : 'bg-[#16161e] text-[#8b8b9e] hover:text-[#cdd3e0] border border-[#252530]'
              )}
              onClick={() => setStatusFilter(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* ---- 卡片列表 ---- */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-[#5a5a70] animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-12 h-12 rounded-xl bg-[#1a1a24] border border-[#252530] flex items-center justify-center mb-3">
            <Database className="w-6 h-6 text-[#3a3a4a]" />
          </div>
          <p className="text-[13px] text-[#5a5a70] mb-1">暂无数据源</p>
          <p className="text-[11px] text-[#3a3a4a]">点击【新增数据源】添加第一个数据源</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(ds => (
            <div
              key={ds.name}
              className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4 hover:border-[#3a3a45] transition-colors"
            >
              {/* 第一行：名称 + 类型 + 地址 + 状态 */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2.5">
                  <Database className="w-4 h-4 text-[#8b8b9e]" />
                  <span className="text-[14px] font-semibold text-[#e4e4e9]">{ds.name}</span>
                  <Badge variant="outline" className={cn('text-[11px] border-0', getKindBadgeColor(ds.kind))}>
                    {kindLabel(ds.kind)}
                  </Badge>
                  <span className="text-[12px] text-[#5a5a70] font-mono">{ds.location}</span>
                  {getStatusBadge(ds)}
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0]" onClick={() => openEdit(ds)}>
                    <Settings className="w-3 h-3 mr-1" />配置
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0]" onClick={async () => {
                    setTestResult(null)
                    const r = await api.testDatasource(ds.name)
                    setTestResult(r.success
                      ? { ok: true, msg: '可达' }
                      : { ok: false, msg: r.detail || '不可达' }
                    )
                  }}>
                    <Zap className="w-3 h-3 mr-1" />测试连接
                  </Button>
                  <Button size="sm" variant="ghost" className={cn('h-7 text-[11px]', ds.enabled ? 'text-yellow-400 hover:text-yellow-300' : 'text-green-400 hover:text-green-300')} onClick={() => handleToggle(ds)}>
                    <Power className="w-3 h-3 mr-1" />{ds.enabled ? '停用' : '启用'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px] text-red-400 hover:text-red-300" onClick={() => setDeleteTarget(ds)}>
                    <Trash2 className="w-3 h-3 mr-1" />删除
                  </Button>
                </div>
              </div>

              {/* 描述 */}
              {ds.description && (
                <p className="text-[12px] text-[#8b8b9e] mb-2">{ds.description}</p>
              )}

              {/* 标签 */}
              {ds.tags && ds.tags.length > 0 && (
                <div className="flex items-center gap-1.5 mb-2.5">
                  {ds.tags.map((tag, i) => (
                    <span key={i} className="text-[11px] px-2 py-0.5 rounded bg-[#26262d] text-[#9a9aa4] border border-[#2f2f38]">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* 底部统计 */}
              <div className="flex items-center gap-4 text-[11px] text-[#5a5a70]">
                {ds.last_synced_at && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />最近同步：{ds.last_synced_at}
                  </span>
                )}
                {ds.table_count != null && (
                  <span className="inline-flex items-center gap-1">
                    <Database className="w-3 h-3" />表数量：{ds.table_count}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 测试结果 */}
      {testResult && (
        <div className={cn(
          'mt-3 rounded-lg border p-3 text-[12px]',
          testResult.ok
            ? 'bg-green-500/10 border-green-500/20 text-green-400'
            : 'bg-red-500/10 border-red-500/20 text-red-400'
        )}>
          {testResult.ok ? '✅' : ''} {testResult.msg}
        </div>
      )}

      {/* ---- 右侧抽屉：新增 / 编辑 ---- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={closeDrawer}>
          <div
            className="w-[420px] h-full bg-[#1a1a24] border-l border-[#252530] flex flex-col shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* 抽屉头部 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#252530]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9]">
                {editingDs ? '编辑数据源' : '新增数据源'}
              </h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={closeDrawer}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 抽屉表单 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 数据源名称 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">数据源名称 <span className="text-red-400">*</span></label>
                <Input
                  className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a]', formErrors.name ? 'border-red-500/50' : 'border-[#252530]')}
                  placeholder="例如：浙江移动营业库"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
                {formErrors.name && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.name}</p>}
              </div>

              {/* 类型 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">类型</label>
                <Select value={form.kind} onValueChange={v => setForm({ ...form, kind: v })}>
                  <SelectTrigger className="h-8 text-[12px] bg-[#16161e] border-[#252530]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DB_KINDS.map(k => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* 主机端口 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">主机端口 <span className="text-red-400">*</span></label>
                <div className="flex gap-2">
                  <Input
                    className={cn('flex-1 h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a] font-mono', formErrors.host ? 'border-red-500/50' : 'border-[#252530]')}
                    placeholder="10.0.12.21"
                    value={form.host}
                    onChange={e => setForm({ ...form, host: e.target.value })}
                  />
                  <Input
                    className="w-24 h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a] font-mono"
                    placeholder="1521"
                    value={form.port}
                    onChange={e => setForm({ ...form, port: e.target.value })}
                  />
                </div>
                {formErrors.host && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.host}</p>}
              </div>

              {/* 服务名 / 数据库名 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">服务名 / 数据库名</label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a] font-mono"
                  placeholder="ORCL / mydb"
                  value={form.database}
                  onChange={e => setForm({ ...form, database: e.target.value })}
                />
              </div>

              {/* 连接账号 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">连接账号</label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a]"
                  placeholder="username"
                  value={form.username}
                  onChange={e => setForm({ ...form, username: e.target.value })}
                />
              </div>

              {/* 密码 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">密码</label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a]"
                  type="password"
                  placeholder="password"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                />
              </div>

              {/* 超时时间 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">超时时间（s）</label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a]"
                  type="number"
                  placeholder="60"
                  value={form.timeout}
                  onChange={e => setForm({ ...form, timeout: e.target.value })}
                />
              </div>

              {/* 描述 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">描述</label>
                <Textarea
                  className="min-h-[60px] text-[12px] bg-[#16161e] border border-[#252530] p-2 placeholder:text-[#4a4a5a]"
                  placeholder="备注数据源用途"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                />
              </div>

              {/* 测试连接（编辑模式下） */}
              {editingDs && (
                <div className="space-y-2">
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
                    <div className={cn(
                      'rounded-lg border p-2.5 text-[11px] break-all',
                      testResult.ok
                        ? 'bg-green-500/10 border-green-500/20 text-green-400'
                        : 'bg-red-500/10 border-red-500/20 text-red-400'
                    )}>
                      {testResult.ok ? '✅ ' : ''}{testResult.msg}
                    </div>
                  )}
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
                {saving ? '保存中...' : '保存并测试'}
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
                <h3 className="text-[14px] font-semibold text-[#e4e4e9]">删除数据源</h3>
              </div>
              <p className="text-[12px] text-[#9a9aa4]">
                是否确认删除数据源《{deleteTarget.name}》？此操作不可恢复。
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
