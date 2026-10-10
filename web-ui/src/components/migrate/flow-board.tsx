import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import type { MigrateFlowNode } from '@/lib/types'
import { MIGRATE_STATUS_FLOW, MIGRATE_STATUS_LABEL } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  Workflow, ArrowUp, ArrowDown, Plus, Trash2, RotateCw,
  Save, ToggleLeft, ToggleRight, ShieldCheck, Eye, EyeOff,
  UserRound,
} from 'lucide-react'

/**
 * 任务流程静态表编排面板：
 * - 展示状态机流程节点（顺序 = 流转顺序）；
 * - 支持上移/下移调整顺序、增删节点、开关「确认闸门」与「启用」；
 * - 保存后后端状态机按此表驱动流转（页面编排即真实生效）。
 */
const STAGE_AGENT_META: Record<string, { agentId: string; alias: string; role: string }> = {
  'DATA_COLLECTION': { agentId: 'migration_collector', alias: '小采', role: '数据采集' },
  'ASSESSMENT_RUNNING': { agentId: 'migration_assessor', alias: '小评', role: '迁移评估' },
  'SOLUTION_GENERATE': { agentId: 'migration_planner', alias: '小方', role: '迁移方案' },
  'CODE_MIGRATE': { agentId: 'code_migrator', alias: '小改', role: '代码改造' },
  'VERIFY_STAGE': { agentId: 'migration_verifier', alias: '小测', role: '迁移验证' },
}

export function FlowBoard() {
  const [nodes, setNodes] = useState<MigrateFlowNode[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const load = () => {
    setLoading(true)
    api.getMigrateFlow().then(r => {
      if (r.success && r.data) setNodes(r.data as MigrateFlowNode[])
    }).catch(() => {}).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  // 可新增的状态：流程表中尚未加入的标准状态
  const available = useMemo(() => {
    const used = new Set(nodes.map(n => n.status))
    return MIGRATE_STATUS_FLOW.filter(s => !used.has(s))
  }, [nodes])

  const move = (idx: number, dir: -1 | 1) => {
    setNodes(prev => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next.map((n, i) => ({ ...n, sort_order: i }))
    })
  }

  const patch = (idx: number, p: Partial<MigrateFlowNode>) => {
    setNodes(prev => prev.map((n, i) => (i === idx ? { ...n, ...p } : n)))
  }

  const addNode = (status: string) => {
    setNodes(prev => [...prev, {
      id: null, sort_order: prev.length, status,
      label: MIGRATE_STATUS_LABEL[status as keyof typeof MIGRATE_STATUS_LABEL] || status,
      description: '', need_confirm: true, required_fields: [], enabled: true,
    }])
  }

  const remove = (idx: number) => {
    if (nodes.length <= 1) { setMessage('至少保留一个流程节点'); return }
    if (!window.confirm(`从流程中移除节点「${nodes[idx].label}」？移除后状态机将不再经过该阶段（存量任务因仍在执行该阶段将停驻）。`)) return
    setNodes(prev => prev.filter((_, i) => i !== idx).map((n, i) => ({ ...n, sort_order: i })))
  }

  const save = async () => {
    if (nodes.length === 0) { setMessage('流程不能为空'); return }
    setSaving(true); setMessage('')
    const r: { success?: boolean; data?: MigrateFlowNode[]; error?: string } =
      await api.saveMigrateFlow(nodes.map(n => ({
        status: n.status, label: n.label, description: n.description,
        need_confirm: n.need_confirm, enabled: n.enabled,
      }))).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) {
      setNodes(r.data as MigrateFlowNode[])
      setMessage('✅ 流程编排已保存，后端状态机将按新编排流转')
    } else {
      setMessage('保存失败：' + (r.error || '未知错误'))
    }
    setSaving(false)
  }

  const reset = async () => {
    if (!window.confirm('恢复默认流程？将清空当前编排记录。')) return
    setMessage('')
    const r: { success?: boolean; data?: MigrateFlowNode[]; error?: string } =
      await api.resetMigrateFlow().catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) {
      setNodes(r.data as MigrateFlowNode[])
      setMessage('✅ 已恢复默认流程')
    } else {
      setMessage('恢复失败：' + (r.error || '未知错误'))
    }
  }

  return (
    <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
      {/* 头部 */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <Workflow className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-[12px] font-medium text-[#e4e4e9]">任务流程静态表（可编排）</span>
          <span className="text-[10px] text-[#5a5a70]">顺序 = 流转顺序；闸门开启 = 需用户确认；关闭 = 跳过该节点</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={reset} className="h-6 px-2 rounded-md border border-[#252530] bg-[#0f0f14] text-[10px] text-[#8b8b9e] hover:text-[#cdd3e0] flex items-center gap-1">
            <RotateCw className="w-3 h-3" />恢复默认
          </button>
          <button onClick={save} disabled={saving || loading} className="h-6 px-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] flex items-center gap-1 disabled:opacity-50">
            <Save className="w-3 h-3" />{saving ? '保存中…' : '保存编排'}
          </button>
        </div>
      </div>

      {message && <div className="mb-2 text-[11px] text-indigo-200 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-1.5">{message}</div>}

      {/* 节点列表 */}
      {loading ? (
        <div className="text-[11px] text-[#5a5a70] py-4 text-center">加载中…</div>
      ) : (
        <div className="space-y-1.5">
          {nodes.map((n, idx) => (
            <div key={`${n.status}-${idx}`} className={cn(
              'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]',
              n.enabled ? 'border-[#2a2a35] bg-[#0f0f14]' : 'border-[#1e1e28] bg-[#0c0c11] opacity-60')}
            >
              {/* 排序按钮 */}
              <div className="flex flex-col gap-0.5">
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-0.5 rounded text-[#5a5a70] hover:text-[#cdd3e0] disabled:opacity-30" title="上移">
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === nodes.length - 1} className="p-0.5 rounded text-[#5a5a70] hover:text-[#cdd3e0] disabled:opacity-30" title="下移">
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>
              {/* 序号 + 状态 */}
              <span className="text-[#5a5a70] w-5 text-right flex-shrink-0">{idx + 1}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#1a1a24] border border-[#252530] text-[#8b8b9e] font-mono flex-shrink-0">{n.status}</span>
              {(() => {
                const stageAgent = STAGE_AGENT_META[n.status]
                if (!stageAgent) return null
                return (
                  <span
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-500/20 bg-indigo-500/10 text-[9px] text-indigo-300 flex-shrink-0"
                    title={`图节点：${stageAgent.agentId}（${stageAgent.role}）`}
                  >
                    <UserRound className="w-2.5 h-2.5" />
                    {stageAgent.alias}
                  </span>
                )
              })()}
              {/* 节点名 / 说明（可编辑） */}
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <input value={n.label}
                  onChange={e => patch(idx, { label: e.target.value })}
                  className="w-24 bg-transparent text-[#e4e4e9] outline-none border-b border-transparent focus:border-indigo-500/40 text-[11px]"
                  title="节点名称（可编辑）" />
                <input value={n.description}
                  onChange={e => patch(idx, { description: e.target.value })}
                  className="flex-1 min-w-0 bg-transparent text-[#8b8b9e] outline-none border-b border-transparent focus:border-indigo-500/40 text-[10px] truncate"
                  placeholder="节点说明（可编辑）" />
              </div>
              {/* 确认闸门 */}
              <button onClick={() => patch(idx, { need_confirm: !n.need_confirm })}
                className={cn('flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md border flex-shrink-0 transition-colors',
                  n.need_confirm ? 'border-amber-500/30 text-amber-300' : 'border-[#252530] text-[#5a5a70]')}
                title="确认闸门：开启=推进到下一节点前需用户显式确认；关闭=自动推进">
                {n.need_confirm ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                {n.need_confirm ? '需确认' : '自动'}
              </button>
              {/* 启用 */}
              <button onClick={() => patch(idx, { enabled: !n.enabled })}
                className={cn('flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md border flex-shrink-0 transition-colors',
                  n.enabled ? 'border-green-500/30 text-green-400' : 'border-[#252530] text-[#5a5a70]')}
                title="启用/停用：关闭后状态机跳过该节点">
                {n.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                {n.enabled ? '启用' : '停用'}
              </button>
              {/* 删除 */}
              <button onClick={() => remove(idx)} className="p-1 rounded text-[#5a5a70] hover:text-red-400 hover:bg-red-500/10 flex-shrink-0" title="从流程移除">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 新增节点 */}
      <div className="mt-2 flex items-center gap-2">
        <Plus className="w-3 h-3 text-[#5a5a70]" />
        <span className="text-[10px] text-[#5a5a70]">新增节点：</span>
        {available.length === 0 ? (
          <span className="text-[10px] text-[#3a3a48]">所有标准状态已在流程中</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {available.map(s => (
              <button key={s} onClick={() => addNode(s)}
                className="px-2 py-0.5 rounded border border-[#252530] bg-[#0f0f14] text-[10px] text-[#8b8b9e] hover:border-indigo-500/40 hover:text-indigo-300 transition-colors">
                {MIGRATE_STATUS_LABEL[s as keyof typeof MIGRATE_STATUS_LABEL] || s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#5a5a70]">
        <ShieldCheck className="w-3 h-3" />
        编排说明：新增节点仅从标准状态选择；首个节点建议保留「数据采集」（migration_collector，别名小采）。移除进行中的节点会让存量任务停驻该阶段。
      </div>
    </div>
  )
}
