import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { Skill } from '@/lib/types'
import {
  Search, Plus, Settings, Play, Trash2,
  CheckCircle2, AlertCircle, Circle,
  X, Save, AlertTriangle, Loader2
} from 'lucide-react'

/* ---- 类型 ---- */
type SkillKind = '全部' | '技能链' | '脚本' | '基础'
type SkillStatus = '已启用' | '已停用'

interface SkillCard {
  id: number
  skillId: string
  name: string
  description: string
  kind: Exclude<SkillKind, '全部'>
  tags: string[]
  status: SkillStatus
  content: string
  script?: string
  chain?: string[]
}

const kindOptions: SkillKind[] = ['全部', '技能链', '脚本', '基础']
const statusOptions: SkillStatus[] = ['已启用', '已停用']

/** 由真实技能数据推导展示类型：技能链 / 脚本 / 基础 */
function deriveKind(s: Skill): Exclude<SkillKind, '全部'> {
  if (s.chain && s.chain.length > 0) return '技能链'
  if (s.script) return '脚本'
  return '基础'
}

function toCard(s: Skill): SkillCard {
  const kind = deriveKind(s)
  const tags = [
    ...(s.chain && s.chain.length > 0 ? [`链:${s.chain.length}步`] : []),
    ...(s.script ? [`脚本:${s.script}`] : []),
  ]
  return {
    id: s.id ?? 0,
    skillId: s.skill_id,
    name: s.name,
    description: s.description || '',
    kind,
    tags,
    status: s.enabled ? '已启用' : '已停用',
    content: s.content || '',
    script: s.script,
    chain: s.chain,
  }
}

/* ---- 状态图标 ---- */
function StatusDot({ status }: { status: SkillStatus }) {
  if (status === '已启用') return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
  return <Circle className="w-3.5 h-3.5 text-[#5a5a70]" />
}

function StatusText({ status }: { status: SkillStatus }) {
  if (status === '已启用') return <span className="text-[11px] text-green-400">已启用</span>
  return <span className="text-[11px] text-[#8b8b9e]">已停用</span>
}

/* ---- 主组件 ---- */
export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillCard[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [kindFilter, setKindFilter] = useState<SkillKind>('全部')
  const [searchQ, setSearchQ] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [acting, setActing] = useState(false)

  // 配置弹窗
  const [configSkill, setConfigSkill] = useState<SkillCard | null>(null)
  const [configForm, setConfigForm] = useState({ name: '', description: '', status: '已启用' as SkillStatus })
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    setLoadError('')
    const r = await api.listSkills().catch(e => ({ success: false, error: String(e), data: undefined as Skill[] | undefined }))
    if (r.success) setSkills(((r.data as Skill[]) || []).map(toCard))
    else setLoadError((r as { error?: string }).error || '加载技能列表失败')
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // 筛选
  const filtered = skills.filter(s => {
    const matchKind = kindFilter === '全部' || s.kind === kindFilter
    const matchSearch = !searchQ || s.name.toLowerCase().includes(searchQ.toLowerCase())
    return matchKind && matchSearch
  })

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const batchToggle = async (enabled: boolean) => {
    setActing(true)
    await Promise.all(
      skills.filter(s => selectedIds.has(s.id))
        .map(s => api.toggleSkill(s.skillId, enabled).catch(() => null))
    )
    setSelectedIds(new Set())
    await load()
    setActing(false)
  }

  const handleDelete = async (card: SkillCard) => {
    if (!window.confirm(`确认删除技能「${card.name}」？`)) return
    const r = await api.deleteSkill(card.skillId).catch(() => ({ success: false }))
    if (r.success) setSkills(prev => prev.filter(s => s.id !== card.id))
    else window.alert('删除失败，请重试')
  }

  const handleTest = async (card: SkillCard) => {
    window.alert(`正在执行技能「${card.name}」…`)
    const r = await api.runSkill(card.skillId).catch(e => ({ success: false, error: String(e), data: undefined as unknown }))
    if (r.success) {
      const d = ((r.data || {}) as { stdout?: string; stderr?: string; output?: string })
      const out = d.output || d.stdout || ''
      const err = d.stderr || ''
      window.alert(`执行完成：\n${out.slice(0, 800)}${err ? `\n[stderr] ${err.slice(0, 400)}` : ''}`)
    } else {
      window.alert(`执行失败：${r.error || '未知错误'}`)
    }
  }

  const openConfig = (skill: SkillCard) => {
    setConfigSkill(skill)
    setConfigForm({ name: skill.name, description: skill.description, status: skill.status })
    setConfigErrors({})
  }

  const handleConfigSave = async () => {
    if (!configSkill) return
    const errors: Record<string, string> = {}
    if (!configForm.name.trim()) errors.name = '请输入技能名称'
    setConfigErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    const upd = await api.updateSkill(configSkill.skillId, {
      name: configForm.name.trim(),
      description: configForm.description.trim(),
      content: configSkill.content,
    }).catch(() => ({ success: false }))
    if (upd.success && configForm.status !== configSkill.status) {
      await api.toggleSkill(configSkill.skillId, configForm.status === '已启用').catch(() => null)
    }
    setSaving(false)
    if (upd.success) {
      setConfigSkill(null)
      await load()
    } else {
      window.alert('保存失败，请重试')
    }
  }

  // 统计
  const enabledCount = skills.filter(s => s.status === '已启用').length
  const disabledCount = skills.length - enabledCount

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">技能</h2>
        <Button className="h-8 text-[12px] bg-indigo-500 hover:bg-indigo-600 text-white">
          <Plus className="w-3.5 h-3.5 mr-1" />
          新建技能
        </Button>
      </div>

      {/* 类型标签 + 筛选 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {kindOptions.map(opt => (
            <button
              key={opt}
              className={cn(
                'px-3 py-1.5 rounded-md text-[12px] transition-colors',
                kindFilter === opt
                  ? 'bg-indigo-500 text-white'
                  : 'text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05]'
              )}
              onClick={() => setKindFilter(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
            <Input
              className="h-8 pl-8 pr-3 w-44 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
              placeholder="搜索技能名称..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 加载失败 */}
      {loadError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[12px] text-red-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {loadError}
          <button className="ml-auto underline hover:no-underline" onClick={load}>重试</button>
        </div>
      )}

      {/* 卡片网格 */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-[#5a5a70] animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Settings className="w-10 h-10 text-[#2a2a35] mb-3" />
          <p className="text-[13px] text-[#5a5a70] mb-1">暂无技能</p>
          <p className="text-[11px] text-[#3a3a4a]">技能以 SKILL.md 形式存储在 skills/ 目录，可通过后端创建</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filtered.map(skill => (
            <div
              key={skill.id}
              className={cn(
                'rounded-xl bg-[#16161e] border transition-colors p-4 flex flex-col',
                selectedIds.has(skill.id)
                  ? 'border-indigo-500/40'
                  : 'border-[#252530] hover:border-[#3a3a45]'
              )}
            >
              {/* 标题行 */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="rounded border-[#2a2a35] bg-[#1e1e28] accent-indigo-500 mt-0.5"
                    checked={selectedIds.has(skill.id)}
                    onChange={() => toggleSelect(skill.id)}
                  />
                  <h3 className="text-[14px] font-semibold text-[#e4e4e9]">{skill.name}</h3>
                </div>
              </div>

              {/* 标识 */}
              <p className="text-[10px] text-[#4a4a5a] font-mono mb-2">{skill.skillId}</p>

              {/* 描述 */}
              <p className="text-[12px] text-[#5a5a70] mb-3 leading-snug line-clamp-2">{skill.description || '（无描述）'}</p>

              {/* 标签 */}
              <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                {skill.tags.map(tag => (
                  <span key={tag} className="text-[11px] px-2 py-0.5 rounded bg-[#252530] text-[#9a9aa4]">
                    {tag}
                  </span>
                ))}
              </div>

              {/* 状态 */}
              <div className="flex items-center gap-1.5 mb-3">
                <StatusDot status={skill.status} />
                <StatusText status={skill.status} />
              </div>

              {/* 类型（底部） */}
              <div className="flex items-center gap-4 mt-auto pt-3 border-t border-[#252530] mb-3">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-[#5a5a70]">类型</span>
                  <span className="text-[11px] text-[#9a9aa4]">{skill.kind}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Play className="w-3 h-3 text-[#4a4a5a]" />
                  <span className="text-[11px] text-[#5a5a70]">链</span>
                  <span className="text-[11px] text-[#9a9aa4]">{skill.chain && skill.chain.length > 0 ? `${skill.chain.length} 步` : '—'}</span>
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-2">
                <button
                  className="flex-1 h-7 flex items-center justify-center gap-1 rounded-md bg-[#252530] text-[11px] text-[#9a9aa4] hover:text-indigo-400 hover:bg-[#2a2a35] transition-colors"
                  onClick={() => openConfig(skill)}
                >
                  <Settings className="w-3 h-3" />
                  配置
                </button>
                <button
                  className="flex-1 h-7 flex items-center justify-center gap-1 rounded-md bg-[#252530] text-[11px] text-[#9a9aa4] hover:text-indigo-400 hover:bg-[#2a2a35] transition-colors"
                  onClick={() => handleTest(skill)}
                >
                  <Play className="w-3 h-3" />
                  测试
                </button>
                <button
                  className="flex-1 h-7 flex items-center justify-center gap-1 rounded-md bg-[#252530] text-[11px] text-[#9a9aa4] hover:text-red-400 hover:bg-[#2a2a35] transition-colors"
                  onClick={() => handleDelete(skill)}
                >
                  <Trash2 className="w-3 h-3" />
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部批量管理栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-[#16161e] border border-[#252530]">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-[11px] text-green-400">
            <CheckCircle2 className="w-3 h-3" />
            已启用 {enabledCount}
          </span>
          <span className="text-[#2a2a35]">|</span>
          <span className="inline-flex items-center gap-1 text-[11px] text-[#8b8b9e]">
            <AlertCircle className="w-3 h-3" />
            已停用 {disabledCount}
          </span>
        </div>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={acting}
              className="h-7 text-[11px] text-[#9a9aa4] hover:text-green-400"
              onClick={() => batchToggle(true)}
            >
              批量启用
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={acting}
              className="h-7 text-[11px] text-[#9a9aa4] hover:text-orange-400"
              onClick={() => batchToggle(false)}
            >
              批量停用
            </Button>
          </div>
        )}
      </div>

      {/* ---- 配置弹窗 ---- */}
      {configSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfigSkill(null)}>
          <div className="bg-[#1e1e28] border border-[#2a2a35] rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a35]">
              <h3 className="text-[14px] font-semibold text-[#e4e4e9]">配置技能：{configSkill.name}</h3>
              <button className="text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setConfigSkill(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 表单 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 技能名称 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">
                  技能名称 <span className="text-red-400">*</span>
                </label>
                <Input
                  className={cn(
                    'h-8 text-[12px] bg-[#16161e] border placeholder:text-[#4a4a5a]',
                    configErrors.name ? 'border-red-500/50' : 'border-[#2a2a35]'
                  )}
                  value={configForm.name}
                  onChange={e => setConfigForm({ ...configForm, name: e.target.value })}
                />
                {configErrors.name && (
                  <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />{configErrors.name}
                  </p>
                )}
              </div>

              {/* 标识（只读） */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">技能标识</label>
                <Input
                  className="h-8 text-[12px] bg-[#12121a] border border-[#2a2a35] font-mono text-[#8b8b9e]"
                  value={configSkill.skillId}
                  disabled
                />
              </div>

              {/* 描述 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">描述</label>
                <Textarea
                  className="min-h-[60px] text-[12px] bg-[#16161e] border border-[#2a2a35] p-2 placeholder:text-[#4a4a5a]"
                  value={configForm.description}
                  onChange={e => setConfigForm({ ...configForm, description: e.target.value })}
                />
              </div>

              {/* 状态 */}
              <div>
                <label className="text-[11px] text-[#8b8b9e] mb-1 block">状态</label>
                <div className="flex items-center gap-1.5">
                  {statusOptions.map(s => (
                    <button
                      key={s}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[11px] transition-colors',
                        configForm.status === s
                          ? s === '已启用' ? 'bg-green-500 text-white' : 'bg-[#252530] text-white'
                          : 'bg-[#16161e] text-[#9a9aa4] border border-[#2a2a35] hover:border-[#3a3a45]'
                      )}
                      onClick={() => setConfigForm({ ...configForm, status: s })}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#2a2a35]">
              <button
                className="text-[12px] text-[#9a9aa4] px-4 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
                onClick={() => setConfigSkill(null)}
              >
                取消
              </button>
              <button
                className="text-[12px] text-white px-4 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 transition-colors flex items-center gap-1"
                disabled={saving}
                onClick={handleConfigSave}
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
