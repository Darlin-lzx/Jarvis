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
  { id: 'jarvis_commander', name: '贾维斯', role: '总控智能体', desc: '跨工程迭代总调度与多 Agent 编排', icon: Workflow, color: '#22d3ee', version: 'v1.0.0' },
  { id: 'boot_agent', name: '页面展示', role: '业务域智能体', desc: '前端/布点层诉求梳理（小前）', icon: ClipboardCheck, color: '#6366f1', version: 'v2.1.0' },
  { id: 'customer_order_agent', name: '下单拆单', role: '业务域智能体', desc: '下单入口与拆单调度规则（小订）', icon: FileText, color: '#8b5cf6', version: 'v1.8.2' },
  { id: 'family_order_agent', name: '订单受理', role: '业务域智能体', desc: '订单受理与工作流交互（小受）', icon: Code2, color: '#a855f7', version: 'v2.0.4' },
  { id: 'rule_center_agent', name: '规则配置', role: '业务域智能体', desc: '业务规则与配置分支（小规）', icon: Monitor, color: '#06b6d4', version: 'v1.6.0' },
  { id: 'customer_center_agent', name: '客户数据', role: '业务域智能体', desc: '客户数据范围与取数逻辑（小客）', icon: BarChart3, color: '#10b981', version: 'v2.3.0' },
  { id: 'nl2sql_qa', name: '离线问答', role: '问答智能体', desc: '跨工程开发与代码理解知识问答', icon: MessageSquare, color: '#f59e0b', version: 'v1.9.3' },
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
    label: '跨工程迭代类',
    skills: [
      { label: '页面展示', tooltip: '梳理前端/布点层诉求，输出页面展示与布点方案' },
      { label: '下单拆单', tooltip: '梳理下单入口与拆单调度规则，输出代码改动清单' },
      { label: '订单受理', tooltip: '梳理受理工程与工作流交互，输出代码改动清单' },
      { label: '规则配置', tooltip: '梳理业务规则与配置分支，输出代码改动清单' },
    ],
  },
  {
    label: '代码 & 分析类',
    skills: [
      { label: '代码理解', tooltip: '分析接口/调用链/字段，理解跨工程代码结构' },
      { label: '改动清单生成', tooltip: '根据业务场景生成跨工程代码改动清单' },
      { label: '客户数据梳理', tooltip: '梳理客户数据范围与取数逻辑' },
      { label: '离线知识问答', tooltip: '结合离线知识库回答跨工程开发与代码理解问题' },
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
