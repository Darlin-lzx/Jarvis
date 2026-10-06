import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { MCPServer } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  Search, Plus, Trash2, X, AlertTriangle,
  CheckCircle2, Circle, Loader2, Send,
  Settings, Zap, Power, Clock, Wrench, Activity,
} from 'lucide-react'

type StatusFilter = '全部' | '已启用' | '已停用' | '异常'

interface DrawerForm {
  name: string
  kind: string
  command_or_url: string
  description: string
  api_url: string
  api_key: string
  timeout: string
  tags: string
}

const emptyForm: DrawerForm = {
  name: '', kind: 'http', command_or_url: '', description: '',
  api_url: '', api_key: '', timeout: '60', tags: '',
}

export function MCPPanel() {
  const [servers, setServers] = useState<MCPServer[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('全部')

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null)
  const [form, setForm] = useState<DrawerForm>(emptyForm)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testingConn, setTestingConn] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<MCPServer | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api.listMCPServers()
    if (r.success) setServers((r.data as MCPServer[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = servers.filter(s => {
    const matchSearch = !searchQ || s.name.toLowerCase().includes(searchQ.toLowerCase()) || s.command_or_url.toLowerCase().includes(searchQ.toLowerCase())
    let matchStatus = true
    if (statusFilter === '已启用') matchStatus = s.enabled
    else if (statusFilter === '已停用') matchStatus = !s.enabled
    else if (statusFilter === '异常') matchStatus = s.health_ok === false
    return matchSearch && matchStatus
  })

  const openAdd = () => {
    setEditingServer(null)
    setForm(emptyForm)
    setFormErrors({})
    setTestResult(null)
    setDrawerOpen(true)
  }

  const openEdit = (server: MCPServer) => {
    setEditingServer(server)
    setForm({
      name: server.name,
      kind: server.kind,
      command_or_url: server.command_or_url,
      description: server.description || '',
      api_url: server.api_url || '',
      api_key: server.api_key || '',
      timeout: String(server.timeout || 60),
      tags: (server.tags || []).join(', '),
    })
    setFormErrors({})
    setTestResult(null)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setEditingServer(null)
  }

  const handleSave = async () => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = '请输入服务名称'
    if (!form.command_or_url.trim()) errors.command_or_url = '请输入服务地址'
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    const payload = {
      name: form.name.trim(),
      kind: form.kind,
      command_or_url: form.command_or_url.trim(),
      description: form.description.trim(),
      api_url: form.api_url.trim(),
      api_key: form.api_key.trim(),
      timeout: Number(form.timeout) || 60,
      tags: form.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
    }

    let ok = false
    if (editingServer) {
      const r = await api.updateMCPServer(editingServer.id, payload)
      ok = r.success
    } else {
      const r = await api.createMCPServer(payload)
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
    if (!editingServer) return
    setTestingConn(true)
    setTestResult(null)
    const r = await api.testMCPServer(editingServer.id)
    setTestingConn(false)
    setTestResult(r.success
      ? { ok: true, msg: (r.data as { message?: string })?.message || '连接成功' }
      : { ok: false, msg: r.detail || '连接失败' }
    )
  }

  const handleToggle = async (server: MCPServer) => {
    const r = await api.toggleMCPServer(server.id, !server.enabled)
    if (r.success) load()
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const r = await api.deleteMCPServer(deleteTarget.id)
    if (r.success) {
      setDeleteTarget(null)
      load()
    }
  }

  const getStatusBadge = (server: MCPServer) => {
    if (server.health_ok === false) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">
          <AlertTriangle className="w-3 h-3" />异常
        </span>
      )
    }
    if (server.enabled) {
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
    if (kind === 'stdio') return 'bg-blue-500/15 text-blue-400'
    if (kind === 'http') return 'bg-purple-500/15 text-purple-400'
    return 'bg-[#26262d] text-[#9a9aa4]'
  }

  const statusTabs: StatusFilter[] = ['全部', '已启用', '已停用', '异常']

  return (
    <div className="relative">
      {/* ---- 顶部标题栏 ---- */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">MCP 服务</h2>
        <Button className="h-8 text-[12px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90" onClick={openAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          新增 MCP 服务
        </Button>
      </div>

      {/* ---- 搜索 + 状态筛选 ---- */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
          <Input
            className="h-8 pl-8 pr-3 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
            placeholder="搜索服务名称 / 服务地址"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
          />
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
            <Activity className="w-6 h-6 text-[#3a3a4a]" />
          </div>
          <p className="text-[13px] text-[#5a5a70] mb-1">暂无 MCP 服务</p>
          <p className="text-[11px] text-[#3a3a4a]">点击【新增 MCP 服务】添加第一个服务</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(server => (
            <div
              key={server.id}
              className="rounded-xl border border-[#252530] bg-[#1d1d22] p-4 hover:border-[#3a3a45] transition-colors"
            >
              {/* 第一行：名称 + 类型 + 状态 + 地址 + 操作 */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2.5">
                  <span className="text-[14px] font-semibold text-[#e4e4e9]">{server.name}</span>
                  <Badge variant="outline" className={cn('text-[11px] border-0', getKindBadgeColor(server.kind))}>
                    {server.kind}
                  </Badge>
                  {getStatusBadge(server)}
                  <span className="text-[12px] text-[#5a5a70] font-mono">{server.command_or_url}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0]" onClick={() => openEdit(server)}>
                    <Settings className="w-3 h-3 mr-1" />配置
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px] text-[#9a9aa4] hover:text-[#cdd3e0]" onClick={async () => {
                    setTestResult(null)
                    const r = await api.testMCPServer(server.id)
                    setTestResult(r.success
                      ? { ok: true, msg: (r.data as { message?: string })?.message || '可达' }
                      : { ok: false, msg: r.detail || '不可达' }
                    )
                  }}>
                    <Zap className="w-3 h-3 mr-1" />测试连接
                  </Button>
                  <Button size="sm" variant="ghost" className={cn('h-7 text-[11px]', server.enabled ? 'text-yellow-400 hover:text-yellow-300' : 'text-green-400 hover:text-green-300')} onClick={() => handleToggle(server)}>
                    <Power className="w-3 h-3 mr-1" />{server.enabled ? '停用' : '启用'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px] text-red-400 hover:text-red-300" onClick={() => setDeleteTarget(server)}>
                    <Trash2 className="w-3 h-3 mr-1" />删除
                  </Button>
                </div>
              </div>

              {/* 描述 */}
              {server.description && (
                <p className="text-[12px] text-[#8b8b9e] mb-2">{server.description}</p>
              )}

              {/* 标签 */}
              {server.tags && server.tags.length > 0 && (
                <div className="flex items-center gap-1.5 mb-2.5">
                  {server.tags.map((tag, i) => (
                    <span key={i} className="text-[11px] px-2 py-0.5 rounded bg-[#26262d] text-[#9a9aa4] border border-[#2f2f38]">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* 底部统计 */}
              <div className="flex items-center gap-4 text-[11px] text-[#5a5a70]">
                {server.health_checked_at && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />最近健康检查：{server.health_checked_at}
                  </span>
                )}
                {server.tools_count != null && (
                  <span className="inline-flex items-center gap-1">
                    <Wrench className="w-3 h-3" />可用工具：{server.tools_count}个
                  </span>
                )}
                {server.calls_count != null && (
                  <span className="inline-flex items-center gap-1">
                    <Activity className="w-3 h-3" />调用次数：{server.calls_count}次
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
                {editingServer ? '编辑 MCP 服务' : '新增 MCP 服务'}
              </h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={closeDrawer}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 抽屉表单 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 服务名称 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">服务名称 <span className="text-red-400">*</span></label>
                <Input
                  className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a]', formErrors.name ? 'border-red-500/50' : 'border-[#252530]')}
                  placeholder="例如：本地 MCP server"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
                {formErrors.name && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.name}</p>}
              </div>

              {/* 服务类型 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">服务类型</label>
                <Select value={form.kind} onValueChange={v => setForm({ ...form, kind: v })}>
                  <SelectTrigger className="h-8 text-[12px] bg-[#16161e] border-[#252530]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">http</SelectItem>
                    <SelectItem value="stdio">stdio</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 服务地址 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">服务地址 <span className="text-red-400">*</span></label>
                <Input
                  className={cn('h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a] font-mono', formErrors.command_or_url ? 'border-red-500/50' : 'border-[#252530]')}
                  placeholder={form.kind === 'http' ? 'http://localhost:9201' : 'npx @modelcontextprotocol/...'}
                  value={form.command_or_url}
                  onChange={e => setForm({ ...form, command_or_url: e.target.value })}
                />
                {formErrors.command_or_url && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formErrors.command_or_url}</p>}
              </div>

              {/* API 地址 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">API地址</label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a] font-mono"
                  placeholder="http://10.0.12.88:8080/mcp"
                  value={form.api_url}
                  onChange={e => setForm({ ...form, api_url: e.target.value })}
                />
              </div>

              {/* API 密钥 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">API密钥</label>
                <Input
                  className="h-8 text-[12px] bg-[#16161e] border border-[#252530] placeholder:text-[#4a4a5a] font-mono"
                  type="password"
                  placeholder="sk-xxxxxxxxxxxx"
                  value={form.api_key}
                  onChange={e => setForm({ ...form, api_key: e.target.value })}
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
                  placeholder="备注服务用途"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                />
              </div>

              {/* 测试连接（编辑模式下） */}
              {editingServer && (
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
                      {testResult.ok ? '✅' : ''} {testResult.msg}
                    </span>
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
                <h3 className="text-[14px] font-semibold text-[#e4e4e9]">删除 MCP 服务</h3>
              </div>
              <p className="text-[12px] text-[#9a9aa4]">
                是否确认删除服务《{deleteTarget.name}》？此操作不可恢复。
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
