import type { MigrateFlowNode, MigrateStatus } from '@/lib/types'

export interface MigrateBoardStage {
  keys: MigrateStatus[]
  label: string
  desc: string
}

export interface TaskFlowStageDef {
  id: string
  label: string
  agentId: string
  keywords: string[]
}

const DEFAULT_FLOW: MigrateFlowNode[] = [
  {
    sort_order: 0, status: 'PAGE_SHOW', label: '页面展示',
    description: '页面展示专家（小前）梳理前端/布点层诉求，输出页面展示与布点方案',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 1, status: 'ORDER_SPLIT', label: '下单拆单',
    description: '下单拆单专家（小订）梳理下单入口与拆单调度规则',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 2, status: 'ORDER_ACCEPT', label: '订单受理',
    description: '订单受理专家（小受）梳理受理工程与工作流/外围系统交互',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 3, status: 'RULE_CHECK', label: '规则配置',
    description: '规则配置专家（小规）梳理业务规则与配置分支',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 4, status: 'CUSTOMER_CHECK', label: '客户数据',
    description: '客户数据专家（小客）梳理客户数据范围与取数逻辑',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 5, status: 'FINISHED', label: '完成',
    description: '任务全部完成，汇总跨工程改动包与报告产物',
    need_confirm: false, required_fields: [], enabled: true,
  },
]

const STAGE_AGENTS: Record<string, string> = {
  PAGE_SHOW: 'boot_agent',
  ORDER_SPLIT: 'customer_order_agent',
  ORDER_ACCEPT: 'family_order_agent',
  RULE_CHECK: 'rule_center_agent',
  CUSTOMER_CHECK: 'customer_center_agent',
  FINISHED: 'jarvis_commander',
}

export function enabledMigrateFlow(flow?: MigrateFlowNode[] | null): MigrateFlowNode[] {
  const nodes = (flow || []).filter(n => n.enabled !== false)
  return nodes.length ? nodes : DEFAULT_FLOW
}

export function boardStagesFromFlow(flow?: MigrateFlowNode[] | null): MigrateBoardStage[] {
  return enabledMigrateFlow(flow).map(n => ({
    keys: [n.status as MigrateStatus],
    label: n.label || n.status,
    desc: n.description || '',
  }))
}

export function taskStageDefsFromFlow(flow?: MigrateFlowNode[] | null): TaskFlowStageDef[] {
  return enabledMigrateFlow(flow).map(n => ({
    id: n.status,
    label: n.label || n.status,
    agentId: STAGE_AGENTS[n.status] || 'jarvis_commander',
    keywords: [n.label || '', n.status],
  }))
}
