import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { createAgentTabClickHandler } from '@/lib/agent-assignment'
import { agentDisplayName } from '@/lib/agent-display'
import {
  ClipboardCheck, FileText, Code2, MessageSquare, Monitor, BarChart3,
  Loader2, X, Workflow, UserRound,
} from 'lucide-react'

export type AgentTabStatus = 'executing' | 'done' | 'failed' | 'idle'

export const builtinAgentTabs = [
  { id: 'migration_commander', name: '迁移指挥官', role: '总控智能体', desc: '多 Agent 编排调度', icon: Workflow, color: '#22d3ee', version: 'v1.0.0' },
  { id: 'migration_assessor', name: '迁移评估', role: '评估智能体', desc: '迁移兼容性评估', icon: ClipboardCheck, color: '#6366f1', version: 'v2.1.0' },
  { id: 'ddl_converter', name: 'DDL 转换', role: '转换智能体', desc: 'DDL/DML 语法转换', icon: FileText, color: '#8b5cf6', version: 'v1.8.2' },
  { id: 'code_migrator', name: '代码改造', role: '改造智能体', desc: '代码适配改造', icon: Code2, color: '#a855f7', version: 'v2.0.4' },
  { id: 'migration_verifier', name: '智能问答', role: '验证/问答智能体', desc: '迁移验证 与 知识问答', icon: MessageSquare, color: '#06b6d4', version: 'v1.6.0' },
  { id: 'ops_monitor', name: '运维监控', role: '运维智能体', desc: '性能诊断与监控', icon: Monitor, color: '#10b981', version: 'v2.3.0' },
  { id: 'gov_manager', name: '数据治理', role: '治理智能体', desc: '数据质量与合规', icon: BarChart3, color: '#f59e0b', version: 'v1.9.3' },
]

// 兼容旧导入路径；别名优先规则集中在 React-free helper，便于测试与复用。
export { agentDisplayName }

// 兼容旧导出名
export const agents = builtinAgentTabs

// 默认颜色池（用于后端智能体）
const DEFAULT_COLORS = ['#22d3ee', '#6366f1', '#8b5cf6', '#a855f7', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6']

/* ---- 技能分组（单一事实源：welcome-page / composer 共用，共 8 个技能） ---- */
export const skillGroups = [
  {
    label: '迁移改造类',
    skills: [
      { label: '迁移评估', tooltip: '分析源库 Schema，输出国产化迁移评估报告' },
      { label: 'DDL 转换', tooltip: '将原库 DDL 语法，转换成国产数据库兼容版本' },
      { label: '代码改造', tooltip: '分析 JDBC/ORM 代码，输出国产库适配改造建议' },
      { label: '兼容性检查', tooltip: '检查 SQL 语法、数据类型与国产库的兼容性' },
    ],
  },
  {
    label: 'SQL & 分析类',
    skills: [
      { label: '自然语言查数', tooltip: '用自然语言描述需求，自动生成 SQL 查询' },
      { label: '慢查询分析', tooltip: '上传 SQL，分析慢 SQL 问题并给出优化方案' },
      { label: '数据质量评估', tooltip: '对数据源做质量评分（非空率/唯一性/空值率）' },
      { label: 'SQL 优化', tooltip: '分析 SQL 执行计划，给出索引和写法优化建议' },
    ],
  },
]

interface AgentTabsProps {
  active: string
  /** 点击启用智能体后，将其作为下一条消息的指派对象 */
  onChange?: (id: string) => void
  /** 流式输出期间禁止切换，避免当前回复的归属发生变化 */
  disabled?: boolean
  /** 每个技能的执行状态：执行中(蓝) / 已完成(绿) / 失败(红) / 未执行(灰) */
  status?: Record<string, AgentTabStatus>
  /** 标签栏最左侧插槽（如：折叠链路开关） */
  leading?: ReactNode
  /** 外部传入的智能体列表（后端数据），未提供时使用内置列表 */
  agents?: Array<{ id: string; name: string; agent_type?: string; enabled?: boolean }>
}

function statusNode(s: AgentTabStatus | undefined) {
  if (s === 'executing') {
    return <span title="执行中"><Loader2 className="w-3 h-3 text-blue-400 animate-spin" /></span>
  }
  if (s === 'done') {
    return null
  }
  if (s === 'failed') {
    return <span title="执行失败"><X className="w-3 h-3 text-red-400" /></span>
  }
  return null
}

export function AgentTabs({ active, status, leading, agents: externalAgents, onChange, disabled = false }: AgentTabsProps) {
  // 使用外部传入的智能体列表，如果未提供则降级为内置列表；只展示启用状态（enabled 未定义视为启用）
  const rawAgents = externalAgents && externalAgents.length > 0 ? externalAgents : builtinAgentTabs
  const displayAgents = rawAgents.filter(a => (a as { enabled?: boolean }).enabled !== false)

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1e1e28] bg-[#0f0f14]">
      {leading && (
        <div className="mr-1 flex items-center">
          {leading}
        </div>
      )}
      {displayAgents.map((a, idx) => {
        // 内置 agents 有 icon/color/role/desc/version，后端 agents 没有
        const isBuiltin = 'icon' in a
        const color = isBuiltin ? (a as any).color : DEFAULT_COLORS[idx % DEFAULT_COLORS.length]
        const role = isBuiltin ? (a as any).role : (a.agent_type || '智能体')
        const isActive = active === a.id
        const isMainAgent = !isBuiltin && a.agent_type === '主Agent'
        const s = status?.[a.id]
        const handleClick = createAgentTabClickHandler({ id: a.id, onChange, disabled })
        return (
          <div key={a.id} className="relative group">
            <button
              type="button"
              onClick={handleClick}
              disabled={handleClick === undefined}
              aria-pressed={isActive}
              title={handleClick ? '点击指派该智能体执行下一项任务' : '当前状态不可切换智能体'}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border select-none',
                handleClick ? 'cursor-pointer' : 'cursor-not-allowed',
                handleClick && !isActive && 'hover:border-[#3a3a48] hover:text-[#a8a8b8]',
                handleClick === undefined && 'opacity-60',
                isActive
                  ? 'border-transparent text-white shadow-sm'
                  : 'border-[#252530] text-[#6a6a7a]',
                isMainAgent && !isActive && 'border-amber-500/30 text-amber-300/80'
              )}
              style={isActive ? {
                backgroundColor: isMainAgent ? 'rgba(245,158,11,0.15)' : color + '20',
                borderColor: isMainAgent ? 'rgba(245,158,11,0.5)' : color + '40',
                color: isMainAgent ? '#fbbf24' : color
              } : {}}
            >
              {statusNode(s)}
              {isMainAgent && !isActive && <span className="text-[10px] text-amber-400 font-bold">★</span>}
              {/* 智能体头像：彩色圆形 + 人形图标 */}
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-white shrink-0"
                style={{ background: color }}
              >
                <UserRound className="w-3 h-3" />
              </div>
              <span className={cn('font-medium', isMainAgent && !isActive && 'text-amber-300')}>{agentDisplayName(a as { name?: string; alias?: string })}</span>
            </button>
            {/* hover 悬浮卡片：展示该智能体的功能 */}
            <div className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 z-50 w-64 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <div className="rounded-xl bg-[#1a1a24] border border-[#2a2a35] shadow-2xl p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-white shrink-0" style={{ background: color }}>
                    <UserRound className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-white leading-tight">{agentDisplayName(a as { name?: string; alias?: string })}</div>
                    <div className="text-[10px] truncate" style={{ color }}>{role}</div>
                  </div>
                </div>
                <div className="text-[11px] text-[#9a9aa4] leading-relaxed">
                  {isBuiltin ? (a as any).desc : ((a as any).description || '暂无功能描述')}
                </div>
                {isBuiltin && (a as any).version && (
                  <div className="text-[10px] text-[#5a5a70] mt-1.5">版本 {(a as any).version}</div>
                )}
                <div className="text-[9px] text-[#5a5a70] mt-2 border-t border-[#252530] pt-1.5">点击指派该智能体执行下一项任务</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
