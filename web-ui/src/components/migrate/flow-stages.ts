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
    sort_order: 0, status: 'DATA_COLLECTION', label: '数据采集',
    description: '采集源库元数据/表结构/对象清单（小采），并确认源/目标库、容量、停机窗口等参数',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 1, status: 'ASSESSMENT_RUNNING', label: '迁移评估',
    description: '评估专家（小评）结合规则命中做兼容性风险与工作量评估',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 2, status: 'SOLUTION_GENERATE', label: '迁移方案',
    description: '方案专家（小方）汇总采集与评估结果，生成国产化迁移落地方案',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 3, status: 'CODE_MIGRATE', label: '代码改造',
    description: '改造专家（小改）做 JDBC/ORM/存储过程应用代码适配',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 4, status: 'VERIFY_STAGE', label: '迁移验证',
    description: '验证专家（小测）校验语法与结构一致性',
    need_confirm: true, required_fields: [], enabled: true,
  },
  {
    sort_order: 5, status: 'FINISHED', label: '完成',
    description: '生成结构化资产与完整报告',
    need_confirm: false, required_fields: [], enabled: true,
  },
]

const STAGE_AGENTS: Record<string, string> = {
  DATA_COLLECTION: 'migration_collector',
  ASSESSMENT_RUNNING: 'migration_assessor',
  SOLUTION_GENERATE: 'migration_planner',
  CODE_MIGRATE: 'code_migrator',
  VERIFY_STAGE: 'migration_verifier',
  FINISHED: 'migration_commander',
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
    agentId: STAGE_AGENTS[n.status] || 'migration_commander',
    keywords: [n.label || '', n.status],
  }))
}
