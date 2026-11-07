import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type {
  AnalysisCenterInfo, AnalysisMessageResult, AnalysisNodeResult,
  AnalysisQueryBlock, AnalysisSceneResult, AnalysisWorkflowResult,
  CustomerOrderMessageResult, AcceptMessageResult, StructuredOrderInfoResult,
  ApiResponse, SceneRulesResult, DefSceneResult, DecryptResult,
  WorkflowTemplateResponse, AsyncFlowResult, ProductConfigResult,
  InstanceUserResult, StaticConfigResult, ProductDriveResult,
  FamilyOtherResult, RuleBusiResult, SoBusiPrintResult,
} from '@/lib/types'
import {
  Activity, CircleAlert, Copy, Layers, Link2, MessageSquareText, Printer, Search,
} from 'lucide-react'

const FAMILY_CENTER_CODE = 'family_order'
const PRODUCT_CENTER_CODE = 'product_center'
const INSTANCE_CENTER_CODE = 'instance_center'
const PRODUCT_DRIVE_CENTER_CODE = 'product_drive_center'
const RULE_CENTER_CODE = 'rule_center'
const WORKFLOW_SCENE = { scene_code: 'workflow_info', scene_name: 'Workflow Info', render_mode: 'workflow' }
/** 客户订单中心专用：结构化订单信息（17 张 HALL_ORD_* 表） */
const STRUCTURED_SCENE = { scene_code: 'structured_order', scene_name: 'Structured Order Info', render_mode: 'structured' }
/** 家庭订单中心专用：异步流程 */
const ASYNC_FLOW_SCENE = { scene_code: 'async_flow', scene_name: 'Async Flows', render_mode: 'async_flow' }
/** 工作流引擎 state 枚举 → 中文（vm_wf_order/vm_wf_rboss/vm_task_rboss 等；未匹配的值原样展示） */
const WORKFLOW_STATE_NAMES: Record<string, string> = {
  '1': 'Not schedulable',
  '2': 'Schedulable',
  '3': 'Completed',
  '4': 'Terminated',
  '5': 'Manual handling',
  '6': 'Rolled back',
  '7': 'Waiting for external event',
  '8': 'Expired',
  '9': 'Waiting for dispatch',
  '21': 'Replied to flow engine',
  '99': 'System error',
}

/** 家庭订单中心专用：其他（待接入真实 SQL） */
const OTHER_SCENE = { scene_code: 'family_other', scene_name: 'Other', render_mode: 'family_other' }
/** 家庭业务中心专用：产品驱动（角色/策划/产品/终端 四类，待接入真实 SQL） */
const PRODUCT_DRIVE_SCENE = { scene_code: 'product_drive', scene_name: 'Product Drive', render_mode: 'product_drive' }
/** 规则中心专用：业务规则（业务编码联查 BUSI_REL→INSTANCE→TEMPLATE 及因子构造链，规则配置库） */
const RULE_BUSI_SCENE = { scene_code: 'rule_busi', scene_name: 'Business Rules', render_mode: 'rule_busi' }
const PRODUCT_DRIVE_CATEGORIES: [string, string][] = [['role', 'Role'], ['plan', 'Plan'], ['product', 'Product'], ['terminal', 'Terminal']]
/** 实例中心专用：用户信息（so570{city}.ins_user_{city}，营业库） */
const INSTANCE_USER_SCENE = { scene_code: 'user_info', scene_name: 'User Info', render_mode: 'instance_user' }
/** 实例中心专用：订购信息（占位表名，待接真实 SQL） */
const INSTANCE_ORDER_SCENE = { scene_code: 'instance_order', scene_name: 'Subscriptions', render_mode: 'instance_order' }
/** 实例中心专用：终端信息（按计费账号级联 user_id 查 ins_device_{city}，营业库） */
const INSTANCE_TERMINAL_SCENE = { scene_code: 'terminal_info', scene_name: 'Terminal', render_mode: 'instance_terminal' }
/** 产品中心专用：档次配置（up_product_item/特性/关系）+ 策划配置（up_plan），产品库 */
const PRODUCT_CONFIG_SCENE = { scene_code: 'product_config', scene_name: 'Offer Config', render_mode: 'product_config' }
const PLAN_CONFIG_SCENE = { scene_code: 'plan_config', scene_name: 'Plan Config', render_mode: 'plan_config' }
/** DEF_RULE.RULE_TYPE 枚举 → 中文含义（7/8/9 按业务口径；27/28 为购物车多规则校验魔法值） */
const RULE_TYPE_NAMES: Record<string, string> = {
  '0': 'Order query rule',
  '7': 'Rule',
  '8': 'No-receipt print',
  '9': 'Completion',
  '10': 'Marketing funnel',
  '11': 'Timeout auto-action',
  '12': 'Special deposit ticket',
  '13': 'Split deposit info',
  '17': 'Async ticket insert',
  '19': 'Exception matching',
  '21': 'Realtime scheduling check',
  '27': 'Cart multi-rule check (split)',
  '28': 'Cart multi-rule check (protocol)',
}

/** 调度订单 STATE 枚举 → 中文含义 */
const SCHEDULER_STATE_NAMES: Record<string, string> = {
  '0': 'Initialized (pending)',
  '1': 'In progress (dispatched)',
  '2': 'Completed',
  '4': 'Cancelling order',
  '5': 'Suspended',
  '6': 'Error (recoverable 6→1)',
  '7': 'Voided (0→7)',
  '8': 'Cancelled (after completion)',
  '10': 'Cancel error (recoverable 10→4)',
}

const CARD_COLORS: Record<string, string> = {
  blue: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  orange: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  red: 'border-red-500/40 bg-red-500/10 text-red-300',
  purple: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
  cyan: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
}

function rowValues(columns: string[], row: string[]) {
  const map: Record<string, string> = {}
  columns.forEach((column, index) => {
    map[column.toLowerCase()] = String(row[index] ?? '')
  })
  return map
}

/** done_date / create_date → YYYYMMDD（日表名用），解析失败返回空由后端兜底当天 */
function dateKey(value: string) {
  const match = /(\d{4})[-/年.]?(\d{1,2})[-/月.]?(\d{1,2})/.exec(value || '')
  if (!match) return ''
  return `${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`
}

function itemTypeStats(result: AnalysisNodeResult) {
  const candidates = ['order_item_type', 'busi_order_type', 'item_type', 'order_type']
  const column = candidates.find(name =>
    result.columns.some(item => item.toLowerCase() === name))
  if (!column) return null
  const index = result.columns.findIndex(item => item.toLowerCase() === column)
  const stats: Record<string, number> = { User: 0, Customer: 0, Plan: 0, Terminal: 0 }
  for (const row of result.rows) {
    const value = String(row[index] ?? '')
    for (const key of Object.keys(stats)) {
      if (value.includes(key)) stats[key] += 1
    }
  }
  return stats
}

function QueryResultTable({
  columns, rows, onRowClick, selectedValue, renderActions,
  clickableColumns, onCellClick, clickableValue,
}: {
  columns: string[]
  rows: string[][]
  onRowClick?: (values: Record<string, string>) => void
  selectedValue?: string
  renderActions?: (values: Record<string, string>) => ReactNode
  /** 可点击的列（小写列名）；命中列的值渲染为链接样式，点击回调 (列名, 值) */
  clickableColumns?: string[]
  onCellClick?: (column: string, value: string) => void
  /** 自定义可点击值判定；缺省为 纯数字/逗号分隔多值（0 除外） */
  clickableValue?: (value: string) => boolean
}) {
  const defaultClickable = (value: string) => /^\d+(,\d+)*$/.test(value) && value !== '0'
  const isClickable = (column: string, value: string) =>
    !!clickableColumns?.includes(column.toLowerCase())
    && !!onCellClick && (clickableValue ?? defaultClickable)(value)
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
  }
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 z-[1] bg-[#20202c]">
          <tr>
            {renderActions && (
              <th className="sticky left-0 z-[2] whitespace-nowrap border-b border-[#3d3d4a] bg-[#20202c] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">Actions</th>
            )}
            {columns.map(column => (
              <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const values = rowValues(columns, row)
            const isSelected = selectedValue !== undefined
              && (values.scheduler_order_id === selectedValue || values.task_id === selectedValue)
            return (
              <tr
                key={index}
                className={cn(
                  'border-b border-[#1d1d26] hover:bg-white/[0.03]',
                  onRowClick && 'cursor-pointer',
                  isSelected && 'bg-indigo-500/10',
                )}
                onClick={onRowClick ? () => onRowClick(values) : undefined}
              >
                {renderActions && (
                  <td className="sticky left-0 z-[1] whitespace-nowrap bg-[#16161e] px-2.5 py-1.5" onClick={event => event.stopPropagation()}>
                    {renderActions(values)}
                  </td>
                )}
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="max-w-[280px] truncate whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]"
                    title={cell}
                  >
                    {isClickable(columns[cellIndex] ?? '', String(cell).trim()) ? (
                      <button
                        className="font-medium text-cyan-300 underline decoration-cyan-400/60 decoration-dotted underline-offset-2 hover:text-cyan-200 hover:decoration-solid"
                        onClick={event => {
                          event.stopPropagation()
                          onCellClick?.(columns[cellIndex], String(cell).trim())
                        }}
                      >
                        {cell}
                      </button>
                    ) : cell}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


/** ---------- 后端来源名称的英文展示映射 ----------
 * 后端结果块名/数据源名/中心场景名是中文数据键（比较、查找逻辑都依赖原文），
 * 仅在渲染时映射为英文显示；未命中的键原样展示。 */
const BLOCK_NAME_EN: Record<string, string> = {
  '订单信息': 'Order Info',
  '业务订单信息': 'Business Order Info',
  '客户订单信息': 'Customer Order Info',
  '客户信息': 'Customer Info',
  '工单信息': 'Work Orders',
  '订单属性': 'Order Attributes',
  '策划订单项': 'Offer Order Items',
  '订单项': 'Order Items',
  '工作流订单': 'Workflow Orders',
  'RBoss工作流': 'RBoss Workflow',
  '调度订单信息': 'Schedule Order Info',
  '流程实例信息': 'Flow Instance Info',
  '用户信息': 'User Info',
  '个人客户信息': 'Individual Customer',
  '家庭客户信息': 'Family Customer',
  '订购信息': 'Subscriptions',
  '终端信息': 'Terminals',
  '路由锁网': 'Router Lock Net',
  'WiFi组网': 'Wi-Fi Grouping',
  '消息': 'Messages',
  '属性信息': 'Attribute Info',
  '关联产品': 'Related Products',
  '前项限制': 'Pre-Limits',
  '业务关系': 'Business Relations',
  '产品关系': 'Product Relations',
  '产品': 'Products',
  '档次信息': 'Offer Info',
  '框架规则': 'Framework Rules',
  '框架匹配': 'Framework Matches',
  '框架属性': 'Framework Attributes',
  '限制参数': 'Pre-Limit Params',
  '角色信息': 'Role Info',
  '业务组件': 'Business Components',
  '场景定义': 'Scene Definitions',
  '规则定义': 'Rule Definitions',
  '场景单元关系': 'Scene Unit Relations',
  '异步流程': 'Async Flows',
  '设备策划关系': 'Device Offer Relations',
  '规则': 'Rules',
}
const DS_NAME_EN: Record<string, string> = {
  '家庭订单库': 'Family Order DB',
  '家庭订单配置库': 'Family Order Config DB',
  '家庭业务配置库': 'Family Biz Config DB',
  '营业库': 'Billing DB',
  '产品库': 'Product DB',
  '规则配置库': 'Rule Config DB',
  '客户订单配置库': 'Customer Order Config DB',
  '客户订单库': 'Customer Order DB',
  '工作流配置库': 'Workflow Config DB',
  '工作流订单库': 'Workflow Order DB',
}
const CENTER_NAME_EN: Record<string, string> = {
  hall_center: 'Customer Orders',
  family_order: 'Family Orders',
  instance_center: 'Instances',
  product_drive_center: 'Family Business',
  product_center: 'Products',
  rule_center: 'Rules',
}
const SCENE_NAME_EN: Record<string, string> = {
  order_info: 'Order Info',
  order_attr: 'Order Attributes',
  order_items: 'Order Items',
  workflow_info: 'Workflow Info',
  structured_order: 'Structured Order Info',
  async_flow: 'Async Flows',
  family_other: 'Other',
  product_drive: 'Product Drive',
  rule_busi: 'Business Rules',
  user_info: 'User Info',
  instance_order: 'Subscriptions',
  terminal_info: 'Terminal',
  product_config: 'Offer Config',
  plan_config: 'Plan Config',
  scene_rule: 'Config Query',
  static_config: 'Static Config',
  template_version: 'Template Versions',
}
const blockNameEn = (name?: string) => (name ? BLOCK_NAME_EN[name] ?? name : '')
const dsEn = (name?: string) => (name ? DS_NAME_EN[name] ?? name : '')
const centerNameEn = (c?: { center_code?: string; center_name?: string } | null) =>
  (c ? CENTER_NAME_EN[c.center_code ?? ''] ?? c.center_name ?? '' : '')
const sceneNameEn = (sc?: { scene_code?: string; scene_name?: string } | null) =>
  (sc ? SCENE_NAME_EN[sc.scene_code ?? ''] ?? sc.scene_name ?? '' : '')

function ResultCard({
  title, badge, table, datasource, rowCount, hint, action, children,
}: {
  title: string
  badge?: string
  table?: string
  datasource?: string
  rowCount?: number
  hint?: string
  /** 卡片头部右侧操作区（按钮等） */
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#252530] bg-[#16161e]" data-result-card>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#252530] px-3 py-2">
        {badge ? (
          <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px]',
            CARD_COLORS[badge] ?? CARD_COLORS.blue)}>
            {blockNameEn(title)}
          </span>
        ) : (
          <span className="text-[12px] font-medium text-[#e4e4e9]">{blockNameEn(title)}</span>
        )}
        {table && <span className="font-mono text-[10px] text-[#5a5a70]">{table}</span>}
        {datasource && <span className="font-mono text-[10px] text-[#4a6a8a]">@{dsEn(datasource)}</span>}
        {rowCount !== undefined && (
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[#8b8b9e]">{rowCount} rows</span>
        )}
        {(hint || action) && (
          <div className="ml-auto flex items-center gap-2">
            {hint && <span className="text-[10px] text-[#5a5a70]">{hint}</span>}
            {action}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

function NodeCard({
  result, hint, headerExtra, tableOverride, action,
}: {
  result: AnalysisNodeResult
  hint?: string
  headerExtra?: ReactNode
  tableOverride?: ReactNode
  action?: ReactNode
}) {
  return (
    <ResultCard
      title={result.node_name}
      badge={result.color}
      table={result.table_name}
      datasource={result.datasource_name}
      rowCount={result.row_count}
      hint={hint}
      action={action}
    >
      {!result.success && result.error ? (
        <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{result.error}
        </div>
      ) : (
        <>
          {headerExtra}
          {tableOverride ?? <QueryResultTable columns={result.columns} rows={result.rows} />}
        </>
      )}
    </ResultCard>
  )
}

const MESSAGE_KINDS = [
  { key: 'SEND_TO_IMEP', label: 'To IMEP message' },
  { key: 'IMEP_BACK', label: 'IMEP receipt message' },
  { key: 'SEND_TO_IRMS', label: 'To IRMS message' },
  { key: 'IRMS_BACK', label: 'IRMS receipt message' },
  { key: 'billing', label: 'Billing message' },
  { key: 'stage', label: 'Stage reply' },
] as const

type MessageKind = typeof MESSAGE_KINDS[number]['key']

function prettyContent(text: string) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return trimmed
    }
  }
  if (trimmed.startsWith('<')) {
    return trimmed.replace(/></g, '>\n<')
  }
  return trimmed
}

function MessageContentCell({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  if (text.length <= 160) return <span>{text}</span>
  return (
    <span>
      <button
        className="text-[10px] text-indigo-300 hover:underline"
        onClick={event => {
          event.stopPropagation()
          setExpanded(value => !value)
        }}
      >
        {expanded ? 'Collapse' : `View full text (${text.length} chars)`}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-[280px] w-[520px] max-w-full overflow-auto break-all whitespace-pre-wrap rounded border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#cdd3e0]">
          {prettyContent(text)}
        </pre>
      )}
    </span>
  )
}

function MessageDialog({
  open, onOpenChange, target, context,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: { taskId: string; doneDate: string; custOrderId: string; keyEleId: string }
  context: { city: string; inTransit: boolean; historyMonth: string }
}) {
  const [kind, setKind] = useState<MessageKind>('SEND_TO_IMEP')
  const [taskId, setTaskId] = useState(target.taskId)
  const [doneDate, setDoneDate] = useState(target.doneDate)
  const [custOrderId, setCustOrderId] = useState(target.custOrderId)
  const [keyEleId, setKeyEleId] = useState(target.keyEleId)
  const [result, setResult] = useState<AnalysisMessageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    setLoading(true)
    setError('')
    const common = {
      city_code: context.city,
      in_transit: context.inTransit ? 'yes' : 'no',
      history_month: context.inTransit ? '' : context.historyMonth,
    }
    let response
    if (kind === 'billing') {
      response = await api.getAnalysisMessage('billing-message', {
        ...common, cust_order_id: custOrderId, key_ele_id: keyEleId, done_date: doneDate,
      })
    } else if (kind === 'stage') {
      response = await api.getAnalysisMessage('stage-reply', { ...common, task_id: taskId })
    } else {
      response = await api.getAnalysisMessage('wired-message', {
        ...common, task_id: taskId, done_date: doneDate, message_type: kind,
      })
    }
    if (response.success && response.data) {
      setResult(response.data)
    } else {
      setResult(null)
      setError(response.error || 'Message query failed')
    }
    setLoading(false)
  }

  const fieldClass = 'h-7 bg-[#0f0f14] text-[11px]'
  const [decryptedRows, setDecryptedRows] = useState<string[][] | null>(null)
  const [decrypting, setDecrypting] = useState(false)

  // msg_content 为 SM4 密文时自动批量解密，表格直接展示明文
  useEffect(() => {
    setDecryptedRows(null)
    if (!result?.success || result.rows.length === 0) return
    const idx = result.columns.findIndex(column => column.toLowerCase() === 'msg_content')
    if (idx < 0) return
    const ciphers = [...new Set(result.rows
      .map(row => String(row[idx] ?? '').trim())
      .filter(value => value.length > 40 && !value.startsWith('{') && !value.startsWith('[')))]
    if (ciphers.length === 0) return
    let cancelled = false
    setDecrypting(true)
    api.decryptValues({ ciphers }).then(response => {
      if (cancelled) return
      if (response.success && response.data?.results) {
        const map: Record<string, string> = {}
        response.data.results.forEach((item, index) => {
          if (item.ok) map[ciphers[index]] = item.plain
        })
        if (Object.keys(map).length > 0) {
          setDecryptedRows(result.rows.map(row => {
            const original = String(row[idx] ?? '').trim()
            return map[original] !== undefined
              ? [...row.slice(0, idx), map[original], ...row.slice(idx + 1)]
              : row
          }))
        }
      }
      setDecrypting(false)
    })
    return () => { cancelled = true }
  }, [result])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <MessageSquareText className="h-4 w-4 text-indigo-400" />Message Query
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2 text-[11px] text-[#8b8b9e]">
          <label className="space-y-1">
            <span>Type</span>
            <select
              className="h-7 rounded-md border border-[#252530] bg-[#0f0f14] px-2 text-[12px] text-[#cdd3e0]"
              value={kind}
              onChange={event => setKind(event.target.value as MessageKind)}
            >
              {MESSAGE_KINDS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          {kind !== 'billing' && (
            <label className="space-y-1">
              <span>Task ID</span>
              <Input className={cn(fieldClass, 'w-44')} value={taskId} onChange={e => setTaskId(e.target.value)} />
            </label>
          )}
          {kind !== 'stage' && (
            <label className="space-y-1">
              <span>Date (YYYYMMDD)</span>
              <Input className={cn(fieldClass, 'w-32')} placeholder="Defaults to today" value={doneDate} onChange={e => setDoneDate(e.target.value)} />
            </label>
          )}
          {kind === 'billing' && (
            <>
              <label className="space-y-1">
                <span>Customer Order ID</span>
                <Input className={cn(fieldClass, 'w-44')} value={custOrderId} onChange={e => setCustOrderId(e.target.value)} />
              </label>
              <label className="space-y-1">
                <span>Schedule Order ID</span>
                <Input className={cn(fieldClass, 'w-44')} value={keyEleId} onChange={e => setKeyEleId(e.target.value)} />
              </label>
            </>
          )}
          <Button size="sm" className="h-7" disabled={loading} onClick={() => void run()}>
            <Search className="mr-1 h-3 w-3" />{loading ? 'Querying' : 'Query'}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {result && (
          <div className="space-y-2" data-message-result>
            {result.sql && <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>}
            {decrypting && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200">
                Encrypted message detected, decrypting…
              </div>
            )}
            {result.success ? (
              <div className="max-h-[46vh] overflow-auto rounded-md border border-[#252530]">
                {(decryptedRows ?? result.rows).length === 0 ? (
                  <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
                ) : (
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="sticky top-0 bg-[#20202c]">
                      <tr>
                        {result.columns.map(column => (
                          <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(decryptedRows ?? result.rows).map((row, index) => (
                        <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex} className="max-w-[420px] break-all px-2.5 py-1.5 text-[#cdd3e0]">
                              {cell.length > 160 ? (
                                <div className="space-y-1">
                                  <MessageContentCell text={cell} />
                                  <CopyButton text={cell} label="Copy message" />
                                </div>
                              ) : cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
                {result.error || 'Query failed'}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 客户订单下单报文：hall_cust_dtl 各行 CUST_DTL_INFO_A~P 拼接，JSON 报文提取 originalData/transformedData */
/** 复制按钮：clipboard API 优先，失败回退 execCommand（iframe 环境） */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-[#3a3a45] bg-white/5 px-1.5 text-[10px] text-[#9a9aa4] hover:text-[#cdd3e0]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const textarea = document.createElement('textarea')
          textarea.value = text
          document.body.appendChild(textarea)
          textarea.select()
          document.execCommand('copy')
          textarea.remove()
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      <Copy className="h-3 w-3" />{copied ? 'Copied' : label}
    </button>
  )
}

/** 对象/字符串 → 美化 JSON；字符串可解析则解析后美化，否则原样返回 */
function prettyJson(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

type MessageTab = 'full' | 'original' | 'transformed'

function CustomerOrderMessageDialog({
  open, onOpenChange, custOrderId, city, inTransit, historyMonth,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  custOrderId: string
  city: string
  inTransit: boolean
  historyMonth: string
}) {
  const [result, setResult] = useState<CustomerOrderMessageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<MessageTab>('full')
  const [sceneIdx, setSceneIdx] = useState(-1)

  useEffect(() => {
    if (!open || !custOrderId.trim()) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    setTab('full')
    setSceneIdx(-1)
    api.getCustomerOrderMessage({
      cust_order_id: custOrderId.trim(),
      city_code: city,
      in_transit: inTransit ? 'yes' : 'no',
      history_month: inTransit ? '' : historyMonth,
    }).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.success) setError(response.data.error || 'Message query failed')
      } else {
        setError(response.error || 'Message query failed')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, custOrderId, city, inTransit, historyMonth])

  // 转换后报文为按 sceneId 分组的数组（与 Nexus 一致）
  const transformedList = useMemo(() => {
    const raw = result?.transformed_data
    if (Array.isArray(raw)) {
      return raw.map((item: unknown) => {
        if (typeof item === 'object' && item !== null) {
          const record = item as Record<string, unknown>
          return {
            sceneId: String(record.sceneId ?? record.scene_id ?? 'Unknown'),
            data: record.data ?? item,
          }
        }
        return { sceneId: 'Unknown', data: item }
      })
    }
    return raw != null ? [{ sceneId: 'Unknown', data: raw }] : []
  }, [result])

  const currentText = useMemo(() => {
    if (!result?.success) return ''
    if (tab === 'full') return prettyContent(result.message) || '(empty)'
    if (tab === 'original') {
      return result.original_data != null ? prettyJson(result.original_data) : 'Original message not found'
    }
    const item = transformedList[sceneIdx]
    if (item) return prettyJson(item.data)
    return transformedList.length > 0 ? 'Select a sceneId' : 'Transformed message not found'
  }, [result, tab, sceneIdx, transformedList])

  const copyable = !!currentText && !currentText.startsWith('Not found')
    && currentText !== '(empty)' && currentText !== 'Select a sceneId'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <MessageSquareText className="h-4 w-4 text-indigo-400" />
            Order Message · {custOrderId}
          </DialogTitle>
        </DialogHeader>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">Querying…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && (
          <div className="space-y-2" data-customer-message-result>
            <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-[#5a5a70]">
              <span className="truncate" title={result.sql}>{result.sql}</span>
              <span className="shrink-0">{result.table_name} · {result.row_count} rows</span>
            </div>
            {result.success && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {([['full', 'Full Message'], ['original', 'Original'], ['transformed', 'Transformed']] as const)
                    .map(([key, label]) => (
                      <button
                        key={key}
                        className={cn('rounded px-2.5 py-1 text-[11px]',
                          tab === key
                            ? 'bg-indigo-500/20 text-indigo-300'
                            : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]')}
                        onClick={() => {
                          setTab(key)
                          if (key !== 'transformed') setSceneIdx(-1)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  {tab === 'transformed' && transformedList.length > 0 && (
                    <select
                      className="h-7 rounded-md border border-[#252530] bg-[#0f0f14] px-2 text-[12px] text-[#cdd3e0]"
                      value={sceneIdx}
                      onChange={event => setSceneIdx(Number(event.target.value))}
                    >
                      <option value={-1}>Select a sceneId</option>
                      {transformedList.map((item, index) => (
                        <option key={index} value={index}>{item.sceneId}</option>
                      ))}
                    </select>
                  )}
                </div>
                <pre className="max-h-[34vh] overflow-auto break-all whitespace-pre-wrap rounded-md border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#cdd3e0]">
                  {currentText}
                </pre>
              </>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          {!loading && copyable && <CopyButton text={currentText} label="Copy message" />}
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 流程实例受理报文：HALL_ORDER_BUSI_LOG 最近一条，展示 调用接口/时间 + 请求/响应报文 */
function AcceptMessageDialog({
  open, onOpenChange, custOrderId, taskFlowInsId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  custOrderId: string
  taskFlowInsId: string
}) {
  const [result, setResult] = useState<AcceptMessageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !custOrderId.trim() || !taskFlowInsId.trim()) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    api.getAcceptMessage({
      cust_order_id: custOrderId.trim(),
      task_flow_ins_id: taskFlowInsId.trim(),
    }).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.success) setError(response.data.error || 'Accept message query failed')
      } else {
        setError(response.error || 'Accept message query failed')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, custOrderId, taskFlowInsId])

  const records = (result?.rows ?? []).map(row => {
    const values = rowValues(result?.columns ?? [], row)
    return {
      createDate: values.create_date || '',
      callInterface: values.call_interface || '',
      reqMessage: values.req_message || '',
      respMessage: values.resp_message || '',
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <MessageSquareText className="h-4 w-4 text-amber-400" />
            Accept Message · Flow Instance {taskFlowInsId}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-4 text-[11px] text-[#8b8b9e]">
          <span>Customer Order ID <span className="font-mono text-[#cdd3e0]">{custOrderId}</span></span>
          <span>Flow Instance ID <span className="font-mono text-[#cdd3e0]">{taskFlowInsId}</span></span>
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">Querying…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-accept-message-result>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            {records.length === 0 && (
              <div className="rounded-md border border-[#252530] px-3 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
            )}
            {records.map((record, index) => (
              <div key={index} className="min-w-0 space-y-2 rounded-md border border-[#252530] bg-[#12121a] p-2.5">
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#8b8b9e]">
                  <span>Time <span className="font-mono text-[#cdd3e0]">{record.createDate || '—'}</span></span>
                  <span>Interface <span className="font-mono text-[#cdd3e0]">{record.callInterface || '—'}</span></span>
                </div>
                {([['Request', record.reqMessage], ['Response', record.respMessage]] as const).map(([title, text]) => (
                  <div key={title}>
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-[#8b8b9e]">
                      <span>{title}({text.length} chars)</span>
                      {text ? <CopyButton text={text} /> : null}
                    </div>
                    <pre className="min-w-0 max-h-[24vh] w-full overflow-auto break-all whitespace-pre-wrap rounded border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#cdd3e0]">
                      {prettyContent(text) || '(empty)'}
                    </pre>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 通用查询结果表：列行展示（break-all 换行），空数据展示占位 */
function DialogResultTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (rows.length === 0) {
    return <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
  }
  return (
    <table className="w-full border-collapse text-left text-[11px]">
      <thead className="sticky top-0 bg-[#20202c]">
        <tr>
          {columns.map((column: string) => (
            <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row: string[], index: number) => (
          <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
            {row.map((cell: string, cellIndex: number) => (
              <td key={cellIndex} className="max-w-[420px] break-all px-2.5 py-1.5 text-[#cdd3e0]">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 查询结果弹窗的通用数据形态：各业务接口结果的最小公共字段 */
interface DialogResultData {
  columns: string[]
  rows: string[][]
  success?: boolean
  error?: string
  sql?: string
  table_name?: string
}

/**
 * 通用查询结果弹窗：业务弹窗（服务属性/消息/规则定义等）的同构骨架收敛于此。
 * open 时执行 fetch（返回 null 表示参数未齐，不发起请求），cancelled 守卫防止
 * 快速开关/换目标时的过期响应覆盖；loading/error/空态与表格样式统一。
 * fetch 每次渲染都是新闭包，经 ref 取最新值，effect 只随 open 触发。
 */
function QueryResultDialog<T extends DialogResultData>({
  open, onOpenChange, title, icon, datasourceLabel, tableName, errorText, fetch, renderTable, testId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 标题（含动态 ID 部分，如 业务组件 · 300937） */
  title: string
  icon: ReactNode
  datasourceLabel: string
  /** 表名补充说明；缺省按 result.table_name 展示，返回空串则整段隐藏 */
  tableName?: (result: T | null) => string
  /** 查询失败兜底文案 */
  errorText: string
  /** open 且参数齐备时发起的请求；返回 null 表示参数未齐 */
  fetch: (() => Promise<ApiResponse<T>>) | null
  /** 自定义表格渲染（如免填单的报文复制列）；缺省用标准列行表格 */
  renderTable?: (result: T) => ReactNode
  /** 测试锚点 data-testid */
  testId?: string
}) {
  const [result, setResult] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const fetchRef = useRef(fetch)
  fetchRef.current = fetch

  useEffect(() => {
    const request = open ? fetchRef.current : null
    if (!request) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    request().then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (response.data.success === false) setError(response.data.error || errorText)
      } else {
        setError(response.error || errorText)
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, errorText])

  const tableNameText = tableName ? tableName(result) : (result?.table_name ?? '')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            {icon}
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          Data Source <span className="font-mono text-[#cdd3e0]">{datasourceLabel}</span>
          {tableNameText && <span className="ml-2 font-mono text-[10px] text-[#5a5a70]">{tableNameText}</span>}
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">Querying…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-testid={testId}>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            <div className="max-h-[52vh] overflow-auto rounded-md border border-[#252530]">
              {renderTable
                ? renderTable(result)
                : <DialogResultTable columns={result.columns} rows={result.rows} />}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 业务组件定义：DEF_BUSI_CMPT 按 BUSI_CMPT_ID 查询结果（规则定义中点击 BUSI_CMPT_ID/RESULT 弹出） */
function BusiCmptDialog({
  open, onOpenChange, busiCmptId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busiCmptId: string
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Business Component · ${busiCmptId}`}
      icon={<Layers className="h-4 w-4 text-cyan-400" />}
      datasourceLabel="Customer Order Config DB"
      errorText="Business component query failed"
      testId="busi-cmpt-result"
      fetch={open && busiCmptId.trim()
        ? () => api.getBusiCmpt({ busi_cmpt_id: busiCmptId.trim() })
        : null}
    />
  )
}

/** 报文原始列（内容不展示，按此顺序拼接后供「复制」按钮复制全文） */
const SO_BUSI_PRINT_INFO_COLUMNS = ['info_data', 'info_data_1', 'info_data_2', 'info_data_3',
  'info_data_4', 'info_data_5', 'info_data_6']

/** 按创建时间倒序排列（YYYY-MM-DD HH:MM:SS 格式字符串可直接比较；
 * 无 create_date 列时保持查询原序） */
function sortSoBusiPrintRows(rows: string[][], columns: string[]): string[][] {
  const idx = columns.findIndex(column => column.toLowerCase() === 'create_date')
  if (idx < 0) return rows
  return [...rows].sort((a, b) => String(b[idx] ?? '').localeCompare(String(a[idx] ?? '')))
}

/** 免填单结果表：按 create_date 倒序；报文原始 7 列内容隐藏，
 * 「报文」列固定在行首，提供拼接全文复制按钮 */
function SoBusiPrintTable({ result, copiedIndex, onCopied }: {
  result: SoBusiPrintResult
  copiedIndex: number
  onCopied: (index: number) => void
}) {
  if (result.rows.length === 0) {
    return <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
  }
  const sortedRows = sortSoBusiPrintRows(result.rows, result.columns)
  const lowerColumns = result.columns.map(column => column.toLowerCase())
  const printIndexes = SO_BUSI_PRINT_INFO_COLUMNS
    .map(name => lowerColumns.indexOf(name))
    .filter(index => index >= 0)
  const visibleIndexes = result.columns
    .map((_, index) => index)
    .filter(index => !printIndexes.includes(index))
  const rowText = (row: string[]) =>
    printIndexes.map(index => String(row[index] ?? '')).join('')
  return (
    <div className="max-h-[60vh] overflow-auto rounded-md border border-[#252530]">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 bg-[#20202c]">
          <tr>
            <th className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">Message</th>
            {visibleIndexes.map(index => (
              <th key={index} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">
                {result.columns[index]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, rowIndex) => (
            // 排序会打乱原索引，key 用首列值 + 索引复合，避免排序后 DOM 复用错位
            <tr key={`${String(row[0] ?? '')}-${rowIndex}`} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
              <td className="px-2.5 py-1.5">
                <Button size="sm" variant="outline" className="h-7 text-[11px]"
                  data-so-busi-print-copy
                  onClick={async () => {
                    await navigator.clipboard.writeText(rowText(row))
                    onCopied(rowIndex)
                    setTimeout(() => onCopied(-1), 1500)
                  }}>
                  <Copy className="mr-1 h-3 w-3" />{copiedIndex === rowIndex ? 'Copied' : 'Copy'}
                </Button>
              </td>
              {visibleIndexes.map(cellIndex => (
                <td key={cellIndex} className="max-w-[300px] break-all px-2.5 py-1.5 text-[#cdd3e0]">
                  {String(row[cellIndex] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 免填单：so570{city}.SO_BUSI_PRINT_{city}_{YYYYMM} 按计费账号查询（营业库），
 * 月份取客户订单 CREATE_DATE 年月；协议单（task_type=3）「免填单」点击弹出 */
function SoBusiPrintDialog({
  open, onOpenChange, billId, createDate, city,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  billId: string
  createDate: string
  city: string
}) {
  // 最近一次复制成功的行号（按钮短暂显示「已复制」）
  const [copiedIndex, setCopiedIndex] = useState(-1)
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`No-Receipt · ${billId}`}
      icon={<Printer className="h-4 w-4 text-sky-400" />}
      datasourceLabel="Billing DB"
      errorText="No-receipt query failed"
      testId="so-busi-print-result"
      fetch={open && billId.trim() && createDate.trim()
        ? () => api.getSoBusiPrint({ bill_id: billId.trim(), create_date: createDate.trim(), city_code: city })
        : null}
      renderTable={(result: SoBusiPrintResult) => (
        <SoBusiPrintTable result={result} copiedIndex={copiedIndex} onCopied={setCopiedIndex} />
      )}
    />
  )
}

/** 服务属性：so570{city}.ins_srv_attr_{city} 按订购实例ID查询未过期（实例中心「订购信息」点击弹出） */
function InstanceSrvAttrDialog({
  open, onOpenChange, offerInstId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  offerInstId: string
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Srv Attributes · ${offerInstId}`}
      icon={<Layers className="h-4 w-4 text-cyan-400" />}
      datasourceLabel="Billing DB"
      tableName={result => result?.table_name ?? 'so570574.ins_srv_attr_574'}
      errorText="Srv attribute query failed"
      testId="instance-srv-attr-result"
      fetch={open && offerInstId.trim()
        ? () => api.getInstanceSrvAttr({ offer_inst_id: offerInstId.trim() })
        : null}
    />
  )
}

/** 消息：aiorder.com_consume_ex 按 key_ele_id=task_id 查询（工单信息行「消息」按钮弹出） */
function ConsumeExDialog({
  open, onOpenChange, taskId, context,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskId: string
  context: { city: string; inTransit: boolean; historyMonth: string }
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Messages · Task ${taskId}`}
      icon={<MessageSquareText className="h-4 w-4 text-cyan-400" />}
      datasourceLabel="Family Order DB"
      tableName={result => result?.table_name ?? 'aiorder.com_consume_ex'}
      errorText="Message query failed"
      testId="consume-ex-result"
      fetch={open && taskId.trim()
        ? () => api.getConsumeEx({
            task_id: taskId.trim(), city_code: context.city,
            in_transit: context.inTransit ? 'yes' : 'no',
            history_month: context.inTransit ? '' : context.historyMonth,
          })
        : null}
    />
  )
}

/** 关联服务属性：aiorder.ord_srv_attr_{city} 按客户订单+策划订单查询（家庭订单库），
 * 策划订单项行「关联」按钮点击弹出；在途/历史跟随页面当前模式 */
function OfferSrvAttrDialog({
  open, onOpenChange, customerOrderId, offerOrderId, context,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customerOrderId: string
  offerOrderId: string
  context: { city: string; inTransit: boolean; historyMonth: string }
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Linked Srv Attributes · ${offerOrderId}`}
      icon={<Link2 className="h-4 w-4 text-emerald-400" />}
      datasourceLabel="Family Order DB"
      tableName={result => result?.table_name ?? 'aiorder.ord_srv_attr'}
      errorText="Linked srv attribute query failed"
      testId="offer-srv-attr-result"
      fetch={open && customerOrderId.trim() && offerOrderId.trim()
        ? () => api.getOfferSrvAttr({
            customer_order_id: customerOrderId.trim(),
            offer_order_id: offerOrderId.trim(),
            city_code: context.city,
            in_transit: context.inTransit ? 'yes' : 'no',
            history_month: context.inTransit ? '' : context.historyMonth,
          })
        : null}
    />
  )
}

/** 业务限制：rule_Cfg.SO_PRE_BUSI_LIMIT 按限制编码查询（策划配置「限制参数」点击 limit_code 弹出） */
function SoPreBusiLimitDialog({
  open, onOpenChange, limitCode,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  limitCode: string
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Pre-Limit · ${limitCode}`}
      icon={<Layers className="h-4 w-4 text-amber-400" />}
      datasourceLabel="Rule Config DB"
      tableName={() => 'rule_Cfg.SO_PRE_BUSI_LIMIT'}
      errorText="Pre-limit query failed"
      testId="so-pre-busi-limit-result"
      fetch={open && limitCode.trim()
        ? () => api.getSoPreBusiLimit({ limit_code: limitCode.trim() })
        : null}
    />
  )
}

/** 框架规则定义：busicfg.UP_RULE 按规则ID查询（产品驱动「框架规则」点击弹出） */
function UpRuleDialog({
  open, onOpenChange, ruleId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ruleId: string
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Rule Definition · ${ruleId}`}
      icon={<Layers className="h-4 w-4 text-emerald-400" />}
      datasourceLabel="Family Biz Config DB"
      tableName={() => 'busicfg.UP_RULE'}
      errorText="Rule definition query failed"
      testId="up-rule-result"
      fetch={open && ruleId.trim()
        ? () => api.getUpRule({ rule_id: ruleId.trim() })
        : null}
    />
  )
}

/** 业务信息：product.up_business 按业务ID查询（档次/策划配置「业务关系」点击弹出） */
function BusinessInfoDialog({
  open, onOpenChange, businessId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  businessId: string
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Business Info · ${businessId}`}
      icon={<Layers className="h-4 w-4 text-cyan-400" />}
      datasourceLabel="Product DB"
      tableName={() => 'product.up_business'}
      errorText="Business info query failed"
      testId="business-info-result"
      fetch={open && businessId.trim()
        ? () => api.getBusinessInfo({ business_id: businessId.trim() })
        : null}
    />
  )
}

/** 字段解密弹窗：open 后自取数——缓存明文直接展示，否则解析密文信封调密码服务。
 * 解密成功经 onDecrypted 通知调用方回写缓存（表格原位替换明文）。 */
function DecryptDialog({
  open, onOpenChange, envelopeText, cachedPlain, onDecrypted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  envelopeText: string
  /** 解密缓存命中时携带的明文；缺省表示需要调密码服务 */
  cachedPlain?: string
  onDecrypted?: (plain: string) => void
}) {
  const [result, setResult] = useState<DecryptResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showCipher, setShowCipher] = useState(false)

  useEffect(() => {
    if (!open) return
    setShowCipher(false)
    if (cachedPlain !== undefined) {
      setResult({ ok: true, plain: cachedPlain, raw: null, error: '' })
      setLoading(false)
      return
    }
    // 信封解析：JSON 信封优先；库里存的裸密文（如 0yOIb1|9RR7...）客户端补装信封
    let envelope: { policy: string; cipher: string }
    const text = envelopeText.trim()
    try {
      envelope = JSON.parse(text)
    } catch {
      if (!text.includes('{') && text.includes('|')) {
        envelope = { policy: 'SM4', cipher: text }
      } else {
        setResult({ ok: false, plain: '', raw: null, error: 'Unrecognized cipher: neither envelope JSON nor raw cipher' })
        setLoading(false)
        return
      }
    }
    let cancelled = false
    setLoading(true)
    setResult(null)
    api.decryptValue(envelope).then(response => {
      if (cancelled) return
      if (response.success && response.data?.ok) {
        setResult(response.data)
        onDecrypted?.(response.data.plain)
      } else if (response.data) {
        setResult(response.data)
      } else {
        setResult({ ok: false, plain: '', raw: null, error: response.error || 'Decrypt failed' })
      }
    }).catch(e => {
      if (!cancelled) setResult({ ok: false, plain: '', raw: null, error: `Decrypt request failed: ${e}` })
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, envelopeText, cachedPlain])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <CircleAlert className="h-4 w-4 text-emerald-400" />
            Field Decrypt · SM4
          </DialogTitle>
        </DialogHeader>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">Decrypting…</div>}
        {!loading && result && !result.ok && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{result.error || 'Decrypt failed'}</div>
        )}
        {!loading && result?.ok && (
          <div className="space-y-2" data-decrypt-result>
            <div className="mb-1 flex items-center justify-between text-[11px] text-[#8b8b9e]">
              <span>Plain text ({result.plain.length} chars)</span>
              <CopyButton text={result.plain} label="Copy plain text" />
            </div>
            <pre className="max-h-[34vh] overflow-auto break-all whitespace-pre-wrap rounded-md border border-emerald-500/30 bg-[#0b0f0c] p-2 font-mono text-[11px] text-emerald-200">
              {prettyContent(result.plain) || '(empty)'}
            </pre>
          </div>
        )}
        {!loading && result && !result.ok && result.raw != null && (
          <div>
            <div className="mb-1 text-[11px] text-[#8b8b9e]">Raw decrypt service response</div>
            <pre className="max-h-[24vh] overflow-auto break-all whitespace-pre-wrap rounded-md border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#cdd3e0]">
              {typeof result.raw === 'string' ? result.raw : JSON.stringify(result.raw, null, 2)}
            </pre>
          </div>
        )}
        <div>
          <button
            className="text-[11px] text-[#8b8b9e] hover:text-[#cdd3e0] hover:underline"
            onClick={() => setShowCipher(value => !value)}
          >
            {showCipher ? 'Hide cipher' : 'View raw cipher envelope'}
          </button>
          {showCipher && (
            <pre className="mt-1 max-h-[20vh] overflow-auto break-all whitespace-pre-wrap rounded-md border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#8b8b9e]">
              {envelopeText}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 业务组件定义（occ_busi_cmpt 按 cmpt_cfg_id，家庭订单配置库）——工单信息 busi_cmp_id 点击 */
function OccBusiCmptDialog({
  open, onOpenChange, cmptCfgId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cmptCfgId: string
}) {
  return (
    <QueryResultDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Business Component · ${cmptCfgId}`}
      icon={<Layers className="h-4 w-4 text-emerald-400" />}
      datasourceLabel="Family Order Config DB"
      tableName={() => 'occ_busi_cmpt'}
      errorText="Query failed"
      fetch={open && cmptCfgId.trim()
        ? async () => {
            // 只读通道直查（配置库无专用端点），把 queryDatasource 的 ok/message
            // 适配为通用弹窗的 success/error 形态
            const sql = `SELECT * FROM occ_busi_cmpt WHERE cmpt_cfg_id = '${cmptCfgId.trim()}'`
            const response = await api.queryDatasource('家庭订单配置库', sql, 100)
            if (response.success && response.data) {
              return { success: true, data: {
                columns: response.data.columns, rows: response.data.rows,
                success: response.data.ok, error: response.data.message, sql,
              } }
            }
            return { success: false, error: response.error || 'Query failed' }
          }
        : null}
    />
  )
}

/** 场景配置：调度订单 scene_cfg_id 点击 → 查 场景(occ_busi_scene) + 场景节点(occ_assets_cmpt_rel) */
function SceneConfigDialog({
  open, onOpenChange, sceneCfgId, onQueryWorkflow,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sceneCfgId: string
  /** 点击 workflow_template：跳转工作流菜单并按编码查询 */
  onQueryWorkflow?: (tag: string) => void
}) {
  const [results, setResults] = useState<ComponentQueryResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !sceneCfgId.trim()) return
    let cancelled = false
    setLoading(true)
    setResults([])
    const queries = [
      { label: 'Scene (occ_busi_scene)', sql: `SELECT * FROM occ_busi_scene WHERE scene_cfg_id = '${sceneCfgId.trim()}'` },
      { label: 'Scene Nodes (occ_assets_cmpt_rel)', sql: `SELECT * FROM occ_assets_cmpt_rel WHERE scene_cfg_id = '${sceneCfgId.trim()}'` },
    ]
    Promise.all(queries.map(query =>
      api.queryDatasource('家庭订单配置库', query.sql, 100).then(response => {
        if (response.success && response.data) {
          return { label: query.label, sql: query.sql, ...response.data } as ComponentQueryResult
        }
        return { label: query.label, sql: query.sql, ok: false, columns: [], rows: [],
                 row_count: 0, message: response.error || 'Query failed' } as ComponentQueryResult
      }),
    )).then(list => {
      if (cancelled) return
      setResults(list)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, sceneCfgId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-cyan-400" />
            Scene Config · {sceneCfgId}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          Data Source <span className="font-mono text-[#cdd3e0]">Family Order Config DB</span>
        </div>
        {loading && <div className="py-8 text-center text-[12px] text-[#8b8b9e]">Querying…</div>}
        {!loading && results.map(result => (
          <ResultCard key={result.label} title={result.label} rowCount={result.row_count}>
            <div className="border-b border-[#252530] bg-[#0d0d14] px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="mt-[1px] shrink-0 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-300">SQL</span>
                <code className="break-all font-mono text-[10.5px] leading-relaxed text-[#9db4dd]" title={result.sql}>{result.sql}</code>
              </div>
            </div>
            {!result.ok ? (
              <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{result.message}
              </div>
            ) : result.rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
            ) : (
              <div className="max-h-[320px] overflow-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 z-[1] bg-[#20202c]">
                    <tr>
                      {result.columns.map(column => (
                        <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                        {row.map((cell, cellIndex) => {
                          const column = result.columns[cellIndex]?.toLowerCase() ?? ''
                          const clickable = column === 'workflow_template'
                            && !!String(cell).trim() && !!onQueryWorkflow
                          return (
                            <td key={cellIndex} className="max-w-[360px] break-all px-2.5 py-1.5 text-[#cdd3e0]" title={cell}>
                              {clickable ? (
                                <button
                                  className="break-all text-left font-medium text-cyan-300 underline decoration-cyan-400/60 decoration-dotted underline-offset-2 hover:text-cyan-200 hover:decoration-solid"
                                  title="Open in workflow query"
                                  onClick={() => onQueryWorkflow?.(String(cell).trim())}
                                >
                                  {cell}
                                </button>
                              ) : cell}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ResultCard>
        ))}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 订单组件查询页签 */
const ORDER_COMPONENT_TABS: { key: string; label: string }[] = [
  { key: 'transform', label: 'Transform' },
  { key: 'rule', label: 'Rule Adapt' },
  { key: 'post_task', label: 'Post Tasks' },
  { key: 'flow_template', label: 'Flow Templates' },
]

/**
 * 各页签的查询配置（label + 数据源 + SQL 模板），未配置的页签显示占位。
 * 数据转换：occ_interface_adapter ↔ occ_busi_cmpt 按 interface_code 关联，
 * 拆成两张表分别展示（接口编码暂用固定值，待确认是否按订单动态取）。
 */
// SQL 模板占位符：{interface_code}/{business_id} 取自客户订单信息行
const ORDER_COMPONENT_QUERIES: Record<string, { label: string; datasource: string; sql: string }[]> = {
  transform: [
    {
      label: 'Adapter (occ_interface_adapter)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_interface_adapter WHERE interface_code = '{interface_code}'",
    },
    {
      label: 'Business Components (occ_busi_cmpt)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_busi_cmpt WHERE cmpt_cfg_id IN "
           + "(SELECT cmpt_cfg_id FROM occ_interface_adapter WHERE interface_code = '{interface_code}')",
    },
  ],
  rule: [
    {
      label: 'Rule Match (occ_rule_normal_match_rel)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_RULE_CHECK' "
           + "AND prim_cond = '{business_id}' AND second_cond = '{interface_code}'",
    },
    {
      label: 'Business Components (occ_busi_cmpt)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_busi_cmpt WHERE cmpt_cfg_id IN "
           + "(SELECT target_id FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_RULE_CHECK' "
           + "AND prim_cond = '{business_id}' AND second_cond = '{interface_code}')",
    },
  ],
  post_task: [
    {
      label: 'Post Task Match (occ_rule_normal_match_rel)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_ORDITEM_AFTERTASK' "
           + "AND prim_cond = '{business_id}'",
    },
  ],
  flow_template: [
    {
      label: 'Schedule Match (occ_rule_normal_match_rel)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_SCHEDULE_TEMPL' "
           + "AND PRIM_COND = '{interface_code}'",
    },
    {
      label: 'Schedule Template (occ_busi_schedule_template)',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_busi_schedule_template WHERE tmeplate_id IN "
           + "(SELECT target_id FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_SCHEDULE_TEMPL' "
           + "AND PRIM_COND = '{interface_code}')",
    },
  ],
}

interface ComponentQueryResult {
  label: string
  ok: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  message: string
  sql: string
}

/** 订单组件查询：客户订单信息卡片右上角入口，按页签查询 数据转换/规则适配/订单项/后置任务/流程模版 */
function OrderComponentsDialog({
  open, onOpenChange, orderKey, params, onQueryWorkflow,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderKey: string
  /** 模板占位符取值（来自客户订单信息行）：interface_code / business_id */
  params: Record<string, string>
  /** 点击 workflow_code：跳转工作流菜单并按编码查询 */
  onQueryWorkflow?: (tag: string) => void
}) {
  const [tab, setTab] = useState(ORDER_COMPONENT_TABS[0].key)
  const [results, setResults] = useState<ComponentQueryResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setResults([])
    setError('')
    const templates = ORDER_COMPONENT_QUERIES[tab]
    if (!templates) return
    // 占位符替换；条件字段缺失时报错不查询（避免空值全表）
    const missing = [...new Set(templates.flatMap(query =>
      [...query.sql.matchAll(/\{(\w+)\}/g)]
        .map(match => match[1])
        .filter(name => !params[name]?.trim())))]
    if (missing.length > 0) {
      setError(`Customer order missing fields: ${missing.join(", ")} — cannot query (run order query first)`)
      return
    }
    const queries = templates.map(query => ({
      ...query,
      sql: query.sql.replace(/\{(\w+)\}/g, (_, name) => params[name].trim()),
    }))
    let cancelled = false
    setLoading(true)
    Promise.all(queries.map(query =>
      api.queryDatasource(query.datasource, query.sql, 100).then(response => {
        if (response.success && response.data) {
          return { label: query.label, sql: query.sql, ...response.data } as ComponentQueryResult
        }
        return { label: query.label, sql: query.sql, ok: false, columns: [], rows: [],
                 row_count: 0, message: response.error || 'Query failed' } as ComponentQueryResult
      }),
    )).then(list => {
      if (cancelled) return
      setResults(list)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, tab])

  const activeTab = ORDER_COMPONENT_TABS.find(item => item.key === tab)
  const queries = ORDER_COMPONENT_QUERIES[tab]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-indigo-400" />
            Order Components · {orderKey}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5" data-component-tabs>
          {ORDER_COMPONENT_TABS.map(item => (
            <button
              key={item.key}
              className={cn('rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                tab === item.key
                  ? 'border-indigo-400/60 bg-indigo-500/25 text-indigo-200'
                  : 'border-[#3a3a4a] bg-white/[0.04] text-[#c9c9da] hover:bg-white/[0.08] hover:text-[#e8e8f2]')}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="min-h-[140px] space-y-3" data-component-content>
          {loading && <div className="py-8 text-center text-[12px] text-[#8b8b9e]">Querying…</div>}
          {!loading && !queries && (
            <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
              "{activeTab?.label}" query not wired yet (SQL pending)
            </div>
          )}
          {!loading && queries && results.length === 0 && (
            <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-6 text-center text-[12px] text-red-200">
              {error || 'Query failed'}
            </div>
          )}
          {!loading && results.map(result => (
            <ResultCard key={result.label} title={result.label} rowCount={result.row_count}>
              <div className="border-b border-[#252530] bg-[#0d0d14] px-3 py-2">
                <div className="flex items-start gap-2">
                  <span className="mt-[1px] shrink-0 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-300">SQL</span>
                  <code className="break-all font-mono text-[10.5px] leading-relaxed text-[#9db4dd]" title={result.sql}>{result.sql}</code>
                </div>
              </div>
              {!result.ok ? (
                <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{result.message}
                </div>
              ) : result.rows.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">No data</div>
              ) : (
                <div className="max-h-[320px] overflow-auto">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="sticky top-0 z-[1] bg-[#20202c]">
                      <tr>
                        {result.columns.map(column => (
                          <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, index) => (
                        <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                          {row.map((cell, cellIndex) => {
                            const column = result.columns[cellIndex]?.toLowerCase() ?? ''
                            const clickable = column === 'workflow_code'
                              && !!String(cell).trim() && !!onQueryWorkflow
                            return (
                              <td key={cellIndex} className="max-w-[360px] break-all px-2.5 py-1.5 text-[#cdd3e0]" title={cell}>
                                {clickable ? (
                                  <button
                                    className="break-all text-left font-medium text-cyan-300 underline decoration-cyan-400/60 decoration-dotted underline-offset-2 hover:text-cyan-200 hover:decoration-solid"
                                    onClick={() => onQueryWorkflow?.(String(cell).trim())}
                                  >
                                    {cell}
                                  </button>
                                ) : cell}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ResultCard>
          ))}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 模块级快照：切到其他菜单（组件卸载）再回来时恢复查询条件与结果，不清空 */
interface PreLmtParamState {
  limitCode: string
  paramId: string
  result: ProductConfigResult
}

interface AnalysisSnapshot {
  centers: AnalysisCenterInfo[]
  centerCode: string
  businessKey: string
  city: string
  inTransit: boolean
  historyMonth: string
  sceneCode: string
  sceneCache: Record<string, AnalysisSceneResult>
  workflowResult: AnalysisWorkflowResult | null
  asyncFlowResult: AsyncFlowResult | null
  structuredResult: StructuredOrderInfoResult | null
  productResult: ProductConfigResult | null
  productResultKey: string
  planResult: ProductConfigResult | null
  planResultKey: string
  itemRelatResult: ProductConfigResult | null
  preLmtParam: PreLmtParamState | null
  instanceUserResult: InstanceUserResult | null
  instanceOrderResult: InstanceUserResult | null
  instanceTerminalResult: InstanceUserResult | null
  familyOtherResult: FamilyOtherResult | null
  liveNode: AnalysisNodeResult | null
  selectedScheduler: string
  defScene: { sceneId: string; sceneName: string } | null
  queryKind: 'order' | 'config'
  configSceneId: string
  sceneRules: SceneRulesResult | null
  configScene: DefSceneResult | null
  familyTemplateTag: string
  templateResult: WorkflowTemplateResponse | null
  familyConfigTab: 'template' | 'static'
  staticConfigCode: string
  staticConfigResult: StaticConfigResult | null
  productDriveResult: ProductDriveResult | null
  ruleBusiResult: RuleBusiResult | null
  driveCategory: string
  driveGradeNo: string
  driveOfferNo: string
  decryptedMap: Record<string, string>
}

let analysisSnapshot: Partial<AnalysisSnapshot> = {}

/**
 * 退出登录时清空查询快照。模块级快照用于切 tab/切中心后恢复查询结果（产品语义，
 * 见组件初始化与同步 effect），但绝不能跨用户残留——其中含上一账号查过的
 * 订单号与解密明文，登出（不整页刷新的 SPA）必须整体清空。
 */
export function resetAnalysisSnapshot() {
  analysisSnapshot = {}
  for (const key of Object.keys(businessKeyByCenter)) delete businessKeyByCenter[key]
}

/** 分析页弹窗目标联合：此前 open + target 的成对 state（16 组 30 个 useState）
 * 收敛为单一判别联合，一次只弹一个窗。
 * 打开 = setActiveDialog({kind, ...目标})；关闭 = setActiveDialog(null)。 */
type ActiveDialog =
  | { kind: 'message'; target: { taskId: string; doneDate: string; custOrderId: string; keyEleId: string } }
  | { kind: 'custMessage'; custOrderId: string }
  | { kind: 'acceptMessage'; custOrderId: string; flowInsId: string }
  | { kind: 'soBusiPrint'; billId: string; createDate: string }
  | { kind: 'busiCmpt'; id: string }
  | { kind: 'soPreBusiLimit'; code: string }
  | { kind: 'businessInfo'; id: string }
  | { kind: 'upRule'; id: string }
  | { kind: 'consumeEx'; taskId: string }
  | { kind: 'offerSrvAttr'; customerOrderId: string; offerOrderId: string }
  | { kind: 'srvAttr'; offerInstId: string }
  | { kind: 'decrypt'; envelope: string; cachedPlain?: string }
  | { kind: 'sceneCfg'; id: string }
  | { kind: 'occCmpt'; id: string }
  | { kind: 'components' }
  | { kind: 'retry'; taskId: string; custOrderId: string }
  | null

// 历史月份默认当月（YYYY-MM，与 <input type="month"> 取值一致）
function currentMonthValue() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// 业务主键按中心独立记忆：客户订单号与家庭订单号含义不同，切换中心互不影响
const businessKeyByCenter: Record<string, string> = {}

export function AnalysisPanel({ onQueryWorkflow }: {
  /** 跳转到工作流菜单并按模板编码查询（订单组件 workflow_code 点击用） */
  onQueryWorkflow?: (tag: string) => void
} = {}) {
  const [centers, setCenters] = useState<AnalysisCenterInfo[]>(analysisSnapshot.centers ?? [])
  const [centerCode, setCenterCode] = useState(analysisSnapshot.centerCode ?? '')
  const [businessKey, setBusinessKey] = useState(businessKeyByCenter[analysisSnapshot.centerCode ?? ''] ?? '')
  // 规则中心·业务规则：规则编码（与业务编码二选一查询）
  const [ruleCode, setRuleCode] = useState('')
  const [city, setCity] = useState(analysisSnapshot.city ?? '574')
  const [inTransit, setInTransit] = useState(analysisSnapshot.inTransit ?? true)
  const [historyMonth, setHistoryMonth] = useState(analysisSnapshot.historyMonth ?? currentMonthValue())
  const [sceneCode, setSceneCode] = useState(analysisSnapshot.sceneCode ?? '')
  const [sceneCache, setSceneCache] = useState<Record<string, AnalysisSceneResult>>(
    analysisSnapshot.sceneCache ?? {})
  const [asyncFlowResult, setAsyncFlowResult] = useState<AsyncFlowResult | null>(analysisSnapshot.asyncFlowResult ?? null)
  const [workflowResult, setWorkflowResult] = useState<AnalysisWorkflowResult | null>(
    analysisSnapshot.workflowResult ?? null)
  const [structuredResult, setStructuredResult] = useState<StructuredOrderInfoResult | null>(
    analysisSnapshot.structuredResult ?? null)
  const [productResult, setProductResult] = useState<ProductConfigResult | null>(
    analysisSnapshot.productResult ?? null)
  const [productResultKey, setProductResultKey] = useState(analysisSnapshot.productResultKey ?? '')
  const [planResult, setPlanResult] = useState<ProductConfigResult | null>(
    analysisSnapshot.planResult ?? null)
  const [planResultKey, setPlanResultKey] = useState(analysisSnapshot.planResultKey ?? '')
  const [itemRelatResult, setItemRelatResult] = useState<ProductConfigResult | null>(
    analysisSnapshot.itemRelatResult ?? null)
  const [preLmtParam, setPreLmtParam] = useState<PreLmtParamState | null>(
    analysisSnapshot.preLmtParam ?? null)
  const [instanceUserResult, setInstanceUserResult] = useState<InstanceUserResult | null>(
    analysisSnapshot.instanceUserResult ?? null)
  const [instanceOrderResult, setInstanceOrderResult] = useState<InstanceUserResult | null>(
    analysisSnapshot.instanceOrderResult ?? null)
  const [instanceTerminalResult, setInstanceTerminalResult] = useState<InstanceUserResult | null>(
    analysisSnapshot.instanceTerminalResult ?? null)
  const [familyOtherResult, setFamilyOtherResult] = useState<FamilyOtherResult | null>(
    analysisSnapshot.familyOtherResult ?? null)
  const [liveNode, setLiveNode] = useState<AnalysisNodeResult | null>(
    analysisSnapshot.liveNode ?? null)
  const [selectedScheduler, setSelectedScheduler] = useState(
    analysisSnapshot.selectedScheduler ?? '')
  const [elapsed, setElapsed] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // 弹窗目标统一收敛（见 ActiveDialog）：open/target 成对 state 全部并入
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null)
  const closeDialog = () => setActiveDialog(null)
  const [defScene, setDefScene] = useState<{ sceneId: string; sceneName: string } | null>(analysisSnapshot.defScene ?? null)
  // 已解密的密文信封 → 明文（表格中原位替换展示）
  const [decryptedMap, setDecryptedMap] = useState<Record<string, string>>(analysisSnapshot.decryptedMap ?? {})
  const decryptedMapRef = useRef<Record<string, string>>(analysisSnapshot.decryptedMap ?? {})
  // 产品中心跳转记忆：档次配置 → 策划配置 携带关联编号前的产品编号，切回时还原
  const productKeyMemoRef = useRef('')

  function mergeDecrypted(entries: Record<string, string>) {
    decryptedMapRef.current = { ...decryptedMapRef.current, ...entries }
    setDecryptedMap(decryptedMapRef.current)
  }

  /** 点击 attr_value：解密取数/信封解析已内聚到 DecryptDialog，这里只负责打开弹窗。
   * 缓存命中时直接带明文，未命中由弹窗自行调密码服务，成功后经 onDecrypted 回写。 */
  function handleDecryptClick(value: string) {
    setActiveDialog({
      kind: 'decrypt', envelope: value,
      cachedPlain: decryptedMapRef.current[value],
    })
  }

  /** 客户订单属性自动解密：查询后批量解密 attr_value 密文，表格直接展示明文 */
  async function autoDecryptAttrValues(nodes: AnalysisNodeResult[]) {
    const node = nodes.find(item => item.node_code === 'cust_attr')
    if (!node) return
    const idx = node.columns.findIndex(col => col.toLowerCase() === 'attr_value')
    if (idx < 0) return
    const pending = [...new Set(node.rows
      .map(row => String(row[idx] ?? '').trim())
      .filter(value => !value.includes('{') && value.includes('|') && value.length > 20)
      .filter(value => decryptedMapRef.current[value] === undefined))]
    if (pending.length === 0) return
    try {
      const response = await api.decryptValues({ ciphers: pending })
      if (response.success && response.data?.results) {
        const entries: Record<string, string> = {}
        response.data.results.forEach((item, index) => {
          if (item.ok) entries[pending[index]] = item.plain
        })
        mergeDecrypted(entries)
      }
    } catch {
      // 自动解密属辅助增强：失败静默跳过，表格仍展示原密文
    }
  }
  // 客户订单中心两级查询：订单查询（按客户订单号）/ 配置查询（按场景ID/规则ID）
  const [queryKind, setQueryKind] = useState<'order' | 'config'>(analysisSnapshot.queryKind ?? 'order')
  const [configSceneId, setConfigSceneId] = useState(analysisSnapshot.configSceneId ?? '')
  const [sceneRules, setSceneRules] = useState<SceneRulesResult | null>(analysisSnapshot.sceneRules ?? null)
  const [configScene, setConfigScene] = useState<DefSceneResult | null>(analysisSnapshot.configScene ?? null)
  // 家庭订单中心配置查询：工作流模板版本（工作流配置库 vm_template_version）
  const [familyTemplateTag, setFamilyTemplateTag] = useState(analysisSnapshot.familyTemplateTag ?? '')
  const [templateResult, setTemplateResult] = useState<WorkflowTemplateResponse | null>(analysisSnapshot.templateResult ?? null)
  const [familyConfigTab, setFamilyConfigTab] = useState<'template' | 'static'>(analysisSnapshot.familyConfigTab ?? 'template')
  const [staticConfigCode, setStaticConfigCode] = useState(analysisSnapshot.staticConfigCode ?? '')
  const [staticConfigResult, setStaticConfigResult] = useState<StaticConfigResult | null>(analysisSnapshot.staticConfigResult ?? null)
  const [productDriveResult, setProductDriveResult] = useState<ProductDriveResult | null>(analysisSnapshot.productDriveResult ?? null)
  const [ruleBusiResult, setRuleBusiResult] = useState<RuleBusiResult | null>(analysisSnapshot.ruleBusiResult ?? null)
  const [driveCategory, setDriveCategory] = useState(analysisSnapshot.driveCategory ?? 'role')
  const [driveGradeNo, setDriveGradeNo] = useState(analysisSnapshot.driveGradeNo ?? '')
  const [driveOfferNo, setDriveOfferNo] = useState(analysisSnapshot.driveOfferNo ?? '')
  // 跨中心跳转后自动查询的触发标记（等中心/主键 state 生效后再执行 query）
  const [pendingQuery, setPendingQuery] = useState(false)

  useEffect(() => {
    if (!pendingQuery) return
    setPendingQuery(false)
    void query()
  }, [pendingQuery])

  /** 切换业务中心：暂存当前中心结果状态，还原目标中心（首次进入用默认值） */
  function switchCenter(targetCode: string) {
    if (targetCode === centerCode) return
    const target = centers.find(item => item.center_code === targetCode)
    if (!target) return
    centerMemoryRef.current[centerCode] = {
      sceneCache, workflowResult, asyncFlowResult, structuredResult, productResult, productResultKey,
      planResult, planResultKey, itemRelatResult, preLmtParam, instanceUserResult,
      instanceOrderResult, instanceTerminalResult, familyOtherResult, liveNode,
      selectedScheduler, defScene, sceneCode, city,
      queryKind, configSceneId, sceneRules, configScene,
      familyTemplateTag, templateResult, familyConfigTab, staticConfigCode, staticConfigResult,
      productDriveResult, driveCategory, driveGradeNo, driveOfferNo,
      ruleBusiResult,
    }
    // 业务主键按中心切换（各自记忆，互不影响）
    businessKeyByCenter[centerCode] = businessKey
    const memory = centerMemoryRef.current[targetCode]
    setCenterCode(targetCode)
    setBusinessKey(businessKeyByCenter[targetCode] ?? '')
    setCity(memory?.city ?? (target.default_city || '574'))
    setSceneCode(memory?.sceneCode ?? (target.scenes[0]?.scene_code ?? ''))
    setSceneCache(memory?.sceneCache ?? {})
    setWorkflowResult(memory?.workflowResult ?? null)
    setAsyncFlowResult(memory?.asyncFlowResult ?? null)
    setStructuredResult(memory?.structuredResult ?? null)
    setProductResult(memory?.productResult ?? null)
    setProductResultKey(memory?.productResultKey ?? '')
    setPlanResult(memory?.planResult ?? null)
    setPlanResultKey(memory?.planResultKey ?? '')
    setItemRelatResult(memory?.itemRelatResult ?? null)
    setPreLmtParam(memory?.preLmtParam ?? null)
    setInstanceUserResult(memory?.instanceUserResult ?? null)
    setInstanceOrderResult(memory?.instanceOrderResult ?? null)
    setInstanceTerminalResult(memory?.instanceTerminalResult ?? null)
    setFamilyOtherResult(memory?.familyOtherResult ?? null)
    setLiveNode(memory?.liveNode ?? null)
    setSelectedScheduler(memory?.selectedScheduler ?? '')
    setDefScene(memory?.defScene ?? null)
    setQueryKind(memory?.queryKind ?? 'order')
    setConfigSceneId(memory?.configSceneId ?? '')
    setSceneRules(memory?.sceneRules ?? null)
    setConfigScene(memory?.configScene ?? null)
    setFamilyTemplateTag(memory?.familyTemplateTag ?? '')
    setTemplateResult(memory?.templateResult ?? null)
    setFamilyConfigTab(memory?.familyConfigTab ?? 'template')
    setStaticConfigCode(memory?.staticConfigCode ?? '')
    setStaticConfigResult(memory?.staticConfigResult ?? null)
    setProductDriveResult(memory?.productDriveResult ?? null)
    setRuleBusiResult(memory?.ruleBusiResult ?? null)
    setDriveCategory(memory?.driveCategory ?? 'role')
    setDriveGradeNo(memory?.driveGradeNo ?? '')
    setDriveOfferNo(memory?.driveOfferNo ?? '')
  }

  // 各业务中心的查询结果记忆：切换中心时暂存/还原，避免来回切换丢数据重查
  const centerMemoryRef = useRef<Record<string, {
    sceneCache: Record<string, AnalysisSceneResult>
    workflowResult: AnalysisWorkflowResult | null
    asyncFlowResult: AsyncFlowResult | null
    structuredResult: StructuredOrderInfoResult | null
    productResult: ProductConfigResult | null
    productResultKey: string
    planResult: ProductConfigResult | null
    planResultKey: string
    itemRelatResult: ProductConfigResult | null
    preLmtParam: PreLmtParamState | null
    instanceUserResult: InstanceUserResult | null
    instanceOrderResult: InstanceUserResult | null
    instanceTerminalResult: InstanceUserResult | null
    familyOtherResult: FamilyOtherResult | null
    liveNode: AnalysisNodeResult | null
    selectedScheduler: string
    defScene: { sceneId: string; sceneName: string } | null
    sceneCode: string
    city: string
    queryKind: 'order' | 'config'
    configSceneId: string
    sceneRules: SceneRulesResult | null
    configScene: DefSceneResult | null
    familyTemplateTag: string
    templateResult: WorkflowTemplateResponse | null
    familyConfigTab: 'template' | 'static'
    staticConfigCode: string
    staticConfigResult: StaticConfigResult | null
    productDriveResult: ProductDriveResult | null
    ruleBusiResult: RuleBusiResult | null
    driveCategory: string
    driveGradeNo: string
    driveOfferNo: string
  }>>({})

  const center = centers.find(item => item.center_code === centerCode) ?? null
  // 专用场景：家庭订单中心末尾追加「工作流信息」「异步流程」；
  // 客户订单中心在「订单信息」后插入「结构化订单信息」；
  // 产品中心只有「产品配置」（product.up_product_item，产品库）；
  // scene_rule（配置查询）已移入「配置查询」独立入口，不再作为并列 tab（此处过滤兜底）
  const scenes = useMemo(
    () => center
      ? (center.center_code === 'hall_center'
          ? center.scenes
              .filter(scene => scene.scene_code !== 'scene_rule')
              .flatMap(scene =>
                scene.scene_code === 'order_info' ? [scene, STRUCTURED_SCENE] : [scene])
          : center.center_code === PRODUCT_DRIVE_CENTER_CODE
            ? [PRODUCT_DRIVE_SCENE]
          : center.center_code === INSTANCE_CENTER_CODE
            ? [INSTANCE_USER_SCENE, INSTANCE_ORDER_SCENE, INSTANCE_TERMINAL_SCENE]
          : center.center_code === PRODUCT_CENTER_CODE
            ? [PRODUCT_CONFIG_SCENE, PLAN_CONFIG_SCENE]
          : center.center_code === RULE_CENTER_CODE
            ? [RULE_BUSI_SCENE]
          : center.center_code === FAMILY_CENTER_CODE
              ? [...center.scenes, WORKFLOW_SCENE, ASYNC_FLOW_SCENE, OTHER_SCENE]
              : center.scenes)
      : [],
    [center],
  )
  const sceneResult = sceneCache[sceneCode] ?? null
  // 产品中心场景（档次配置/策划配置）：固定查询，无地市/在途历史之分
  const isProductScene = centerCode === PRODUCT_CENTER_CODE
  // 实例中心场景（用户信息）：仅计费账号，无地市/在途历史之分
  const isInstanceScene = centerCode === INSTANCE_CENTER_CODE
  // 家庭业务中心场景（产品驱动）：仅业务主键，无地市/在途历史之分
  const isDriveScene = centerCode === PRODUCT_DRIVE_CENTER_CODE
  // 规则中心场景（业务规则）：仅业务编码，无地市/在途历史之分
  const isRuleScene = centerCode === RULE_CENTER_CODE

  // 当前中心不含该场景时回退到首个场景（修正旧快照残留的 workflow_info）
  useEffect(() => {
    if (scenes.length > 0 && !scenes.some(scene => scene.scene_code === sceneCode)) {
      setSceneCode(scenes[0].scene_code)
    }
  }, [scenes, sceneCode])

  useEffect(() => {
    businessKeyByCenter[centerCode] = businessKey
    analysisSnapshot = {
      centers, centerCode, businessKey, city, inTransit, historyMonth,
      sceneCode, sceneCache, workflowResult, asyncFlowResult, structuredResult,
      productResult, productResultKey, planResult, planResultKey, itemRelatResult, preLmtParam,
      instanceUserResult, instanceOrderResult, instanceTerminalResult, familyOtherResult, liveNode,
      selectedScheduler, defScene, queryKind, configSceneId, sceneRules,
      configScene, familyTemplateTag, templateResult, familyConfigTab,
      staticConfigCode, staticConfigResult, productDriveResult, driveCategory,
      driveGradeNo, driveOfferNo, ruleBusiResult,
      decryptedMap: decryptedMapRef.current,
    }
  })

  // 查询中每秒计时：库不可达/网络黑洞时页面能看到等待了多久，而不是无限转圈
  useEffect(() => {
    if (!loading) return
    setLoadingSeconds(0)
    const timer = setInterval(() => setLoadingSeconds(seconds => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [loading])

  useEffect(() => {
    if (analysisSnapshot.centers && analysisSnapshot.centers.length > 0) return  // 快照已有配置，无需重拉
    api.listAnalysisCenters().then(response => {
      if (response.success && response.data && response.data.length > 0) {
        setCenters(response.data)
        setCenterCode(response.data[0].center_code)
        setCity(response.data[0].default_city || '574')
        setSceneCode(response.data[0].scenes[0]?.scene_code ?? '')
      } else {
        setError(response.error || 'No analysis centers configured')
      }
    })
  }, [])

  function schedulerIdsFromCache() {
    const node = sceneCache.order_info?.nodes.find(item => item.node_code === 'scheduler_order')
    if (!node) return ''
    return node.rows
      .map(row => rowValues(node.columns, row).scheduler_order_id)
      .filter(Boolean)
      .join(',')
  }

  async function loadScene(nextScene: string, keyOverride?: string) {
    const keyValue = (keyOverride ?? businessKey).trim()
    if (!centerCode || !nextScene) return
    if (nextScene !== PRODUCT_DRIVE_SCENE.scene_code && nextScene !== RULE_BUSI_SCENE.scene_code && !keyValue) return
    setLoading(true)
    setError('')
    const started = performance.now()
    try {
      if (nextScene === WORKFLOW_SCENE.scene_code) {
        const response = await api.getAnalysisWorkflow({
          order_id: keyValue,
          scheduler_ids: schedulerIdsFromCache(),
          city_code: city,
          in_transit: inTransit ? 'yes' : 'no',
          history_month: inTransit ? '' : historyMonth,
        })
        if (response.success && response.data) {
          setWorkflowResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Workflow query failed')
        }
      } else if (nextScene === ASYNC_FLOW_SCENE.scene_code) {
        const response = await api.getAsyncFlow({
          order_id: keyValue,
          city_code: city,
          in_transit: inTransit ? 'yes' : 'no',
          history_month: inTransit ? '' : historyMonth,
        })
        if (response.success && response.data) {
          setAsyncFlowResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Async flow query failed')
        }
      } else if (nextScene === INSTANCE_USER_SCENE.scene_code) {
        const response = await api.getInstanceUser({ bill_id: keyValue })
        if (response.success && response.data) {
          setInstanceUserResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'User info query failed')
        }
      } else if (nextScene === OTHER_SCENE.scene_code) {
        const response = await api.getFamilyOther({
          business_key: keyValue, city_code: city,
          in_transit: inTransit ? 'yes' : 'no', history_month: inTransit ? '' : historyMonth,
        })
        if (response.success && response.data) {
          setFamilyOtherResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Other info query failed')
        }
      } else if (nextScene === PRODUCT_DRIVE_SCENE.scene_code) {
        const grade = driveGradeNo.trim()
        const offer = driveOfferNo.trim()
        if (!grade) {
          setError('Enter an offer ID')
          setLoading(false)
          return
        }
        if (driveCategory !== 'role' && !offer) {
          setError('Enter a plan ID')
          setLoading(false)
          return
        }
        const response = await api.getProductDrive({
          product_item_id: grade, offer_id: offer, category: driveCategory,
        })
        if (response.success && response.data) {
          setProductDriveResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Product drive query failed')
        }
      } else if (nextScene === INSTANCE_ORDER_SCENE.scene_code) {
        const response = await api.getInstanceOrder({ bill_id: keyValue })
        if (response.success && response.data) {
          setInstanceOrderResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Subscription query failed')
        }
      } else if (nextScene === INSTANCE_TERMINAL_SCENE.scene_code) {
        const response = await api.getInstanceTerminal({ bill_id: keyValue })
        if (response.success && response.data) {
          setInstanceTerminalResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Terminal query failed')
        }
      } else if (nextScene === RULE_BUSI_SCENE.scene_code) {
        const response = await api.getRuleBusiRules({
          busi_code: businessKey.trim(), rule_code: ruleCode.trim(),
        })
        if (response.success && response.data) {
          setRuleBusiResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Business rule query failed')
        }
      } else if (nextScene === PRODUCT_CONFIG_SCENE.scene_code) {
        const response = await api.getProductConfig({ product_item_id: keyValue })
        if (response.success && response.data) {
          setProductResult(response.data)
          setProductResultKey(keyValue)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Offer config query failed')
        }
      } else if (nextScene === PLAN_CONFIG_SCENE.scene_code) {
        const response = await api.getPlanConfig({ product_item_id: keyValue })
        if (response.success && response.data) {
          setPlanResult(response.data)
          setPlanResultKey(keyValue)
          setItemRelatResult(null)
          setPreLmtParam(null)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Plan config query failed')
        }
      } else if (nextScene === STRUCTURED_SCENE.scene_code) {
        const response = await api.getStructuredOrderInfo({
          cust_order_id: keyValue,
          city_code: city,
          in_transit: inTransit ? 'yes' : 'no',
          history_month: inTransit ? '' : historyMonth,
        })
        if (response.success && response.data) {
          setStructuredResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || 'Structured order query failed')
        }
      } else {
        const response = await api.queryAnalysisScene(centerCode, {
          scene_code: nextScene,
          business_key: keyValue,
          city_code: city,
          in_transit: inTransit,
          history_month: inTransit ? '' : historyMonth,
        })
        if (response.success && response.data) {
          const data = response.data
          setSceneCache(cache => ({ ...cache, [nextScene]: data }))
          setElapsed(Math.round(performance.now() - started))
          if (centerCode === 'hall_center') loadDefSceneFromNodes(data.nodes)
          // 客户订单属性：自动批量解密 attr_value，表格直接展示明文
          if (centerCode === 'family_order') void autoDecryptAttrValues(data.nodes)
        } else {
          setError(response.error || 'Data query failed')
        }
      }
    } catch (exception) {
      // 请求异常/网络层失败也要给出提示并复位按钮，避免一直「查询中」
      setError(`Request failed: ${exception instanceof Error ? exception.message : String(exception)}`)
    } finally {
      setLoading(false)
    }
  }

  async function query() {
    if (isDriveScene) {
      const grade = driveGradeNo.trim()
      const offer = driveOfferNo.trim()
      if (!grade) {
        setError('Enter an offer ID')
        return
      }
      if (driveCategory !== 'role' && !offer) {
        setError('Enter a plan ID')
        return
      }
    } else if (isRuleScene) {
      // 规则中心·业务规则：业务编码 / 规则编码 二选一
      if (!businessKey.trim() && !ruleCode.trim()) {
        setError('Enter a business code or rule code')
        return
      }
    } else if (!businessKey.trim()) {
      setError(isProductScene ? (sceneCode === PLAN_CONFIG_SCENE.scene_code ? 'Enter a product/plan ID' : 'Enter an offer ID') : isInstanceScene ? 'Enter a billing account' : 'Enter a business key')
      return
    }
    // 产品中心两个结果不清空：按 productResultKey/planResultKey 判定缓存是否仍有效，
    // 编号变了对应 tab 切换时会自动重查；跳转往返（档次↔策划）不丢数据不重查
    setSceneCache({})
    setProductDriveResult(null)
    setRuleBusiResult(null)
    setWorkflowResult(null)
    setAsyncFlowResult(null)
    setStructuredResult(null)
    setInstanceUserResult(null)
    setInstanceOrderResult(null)
    setFamilyOtherResult(null)
    setLiveNode(null)
    setSelectedScheduler('')
    setNotice('')
    setDefScene(null)
    decryptedMapRef.current = {}
    setDecryptedMap({})
    await loadScene(sceneCode)
  }

  /** 家庭订单中心配置查询：按模板编码查 工作流配置库 vm_template_version 版本 */
  async function queryFamilyTemplate() {
    const tag = familyTemplateTag.trim()
    if (!tag) {
      setError('Enter a template code')
      return
    }
    setLoading(true)
    setError('')
    const started = performance.now()
    try {
      const response = await api.getWorkflowTemplate(tag)
      if (response.success && response.data) {
        setTemplateResult(response.data)
        setElapsed(Math.round(performance.now() - started))
      } else {
        setError(response.error || 'Config query failed')
      }
    } catch (e) {
      setError(`Config query request failed: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  /** 家庭订单中心配置查询·静态配置：按编码查 bs_para_detail + bs_static_data */
  async function queryStaticConfig() {
    const code = staticConfigCode.trim()
    if (!code) {
      setError('Enter a config code')
      return
    }
    setLoading(true)
    setError('')
    const started = performance.now()
    try {
      const response = await api.getStaticConfig({ code })
      if (response.success && response.data) {
        setStaticConfigResult(response.data)
        setElapsed(Math.round(performance.now() - started))
      } else {
        setError(response.error || 'Static config query failed')
      }
    } catch (e) {
      setError(`Static config query request failed: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  /** 配置查询：按场景ID查 场景定义(DEF_SCENE) + 规则定义(DEF_RULE) + 业务组件(DEF_BUSI_CMPT) */
  async function queryConfig(sceneIdOverride?: string) {
    const sceneId = (sceneIdOverride ?? configSceneId).trim()
    if (!sceneId) {
      setError('Enter a scene ID')
      return
    }
    setLoading(true)
    setError('')
    setConfigScene(null)
    const started = performance.now()
    try {
      const [rulesResponse, sceneResponse] = await Promise.all([
        api.getSceneRules({ scene_id: sceneId }),
        api.getDefScene({ scene_id: sceneId }),
      ])
      if (rulesResponse.success && rulesResponse.data) {
        setSceneRules(rulesResponse.data)
        setElapsed(Math.round(performance.now() - started))
      } else {
        setError(rulesResponse.error || 'Config query failed')
      }
      if (sceneResponse.success && sceneResponse.data?.success) {
        setConfigScene(sceneResponse.data)
      }
    } catch (e) {
      setError(`Config query request failed: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  /** 策划配置「关联产品」点击产品编号：下钻查询属性信息（up_item_relat 资费服务关系） */
  async function queryItemRelat(value: string) {
    setError('')
    try {
      const response = await api.getItemRelat({ product_item_id: value })
      if (response.success && response.data) {
        setItemRelatResult(response.data)
      } else {
        setError(response.error || 'Attribute info query failed')
      }
    } catch (e) {
      setError(`Attribute info query request failed: ${e}`)
    }
  }

  /** 策划配置「前项限制」点击 rule_exp（形如 TP1(300937)）：拆分查限制参数 */
  async function queryPreLmtParam(value: string) {
    const match = /^(\w+)\((\d+)\)$/.exec(value.trim())
    if (!match) {
      setError(`Cannot parse rule_exp: ${value} (expected like TP1(300937))`)
      return
    }
    setError('')
    try {
      const response = await api.getPreLmtParam({ limit_code: match[1], param_id: match[2] })
      if (response.success && response.data) {
        setPreLmtParam({ limitCode: match[1], paramId: match[2], result: response.data })
      } else {
        setError(response.error || 'Pre-limit query failed')
      }
    } catch (e) {
      setError(`Pre-limit query request failed: ${e}`)
    }
  }

  async function queryLiveWorkOrder(schedulerId: string) {
    setSelectedScheduler(schedulerId)
    setLiveNode(null)
    try {
      const response = await api.queryAnalysisNode(centerCode, {
        scene_code: 'order_info',
        node_code: 'work_order',
        value: schedulerId,
        city_code: city,
        in_transit: inTransit,
        history_month: inTransit ? '' : historyMonth,
      })
      if (response.success && response.data) {
        setLiveNode(response.data)
      } else {
        setError(response.error || 'Live ticket query failed')
      }
    } catch (e) {
      setError(`Live ticket query request failed: ${e}`)
    }
  }

  function openMessage(values: Record<string, string>, schedulerId: string) {
    setActiveDialog({
      kind: 'message',
      target: {
        taskId: values.task_id || '',
        doneDate: dateKey(values.done_date || values.create_date || ''),
        custOrderId: values.cust_order_id || businessKey.trim(),
        keyEleId: values.key_ele_id || values.scheduler_order_id || schedulerId,
      },
    })
  }

  /** 客户订单行「报文」：按行内 CUST_ORDER_ID 查 hall_cust_dtl 下单报文 */
  const renderCustomerMessageAction = (values: Record<string, string>) => {
    if (!values.cust_order_id) return <span className="text-[10px] text-[#5a5a70]">—</span>
    return (
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
        onClick={() => {
          setActiveDialog({ kind: 'custMessage', custOrderId: values.cust_order_id })
        }}
      >
        <MessageSquareText className="h-3 w-3" />Message
      </button>
    )
  }

  /** 流程实例行「受理报文」：按行内 流程实例ID(+客户订单ID) 查 HALL_ORDER_BUSI_LOG；
   *  scene_id 20000002/20000005 的流程实例无受理报文，不显示按钮 */
  const renderAcceptMessageAction = (values: Record<string, string>) => {
    const flowInsId = values.task_flow_ins_id
    const custOrderId = values.cust_order_id || businessKey.trim()
    if (!flowInsId || !custOrderId
      || values.scene_id === '20000002' || values.scene_id === '20000005') {
      return <span className="text-[10px] text-[#5a5a70]">—</span>
    }
    return (
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-300 hover:bg-amber-500/20"
        onClick={() => {
          setActiveDialog({ kind: 'acceptMessage', custOrderId, flowInsId })
        }}
      >
        <MessageSquareText className="h-3 w-3" />Accept Msg
      </button>
    )
  }

  /** 工单行「重试」：task_type=5，HALL_TASK.TASK_STATE 与 HALL_TASK_FLOW_INS.handle_type 置 2（写操作，弹确认框） */
  async function executeRetry(taskId: string, custOrderId: string) {
    setActiveDialog(null)
    setError('')
    setNotice('')
    const response = await api.retryHallTask({ cust_order_id: custOrderId, task_id: taskId })
    if (response.success && response.data?.ok) {
      setNotice(`Ticket ${taskId} retried: ${response.data.message}`)
      await loadScene(sceneCode)  // 刷新工单状态
    } else {
      setError(response.error || response.data?.message || 'Retry failed')
    }
  }

  const renderRetryAction = (values: Record<string, string>) => {
    // 重试只写在途表（HALL_TASK / HALL_TASK_FLOW_INS），历史模式不提供入口
    if (!inTransit) return null
    if (String(values.task_type) !== '5') return null
    if (!values.task_id) return null
    return (
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-rose-500/40 bg-rose-500/10 px-1.5 text-[10px] text-rose-300 hover:bg-rose-500/20"
        onClick={() => {
          const custOrderId = values.cust_order_id || businessKey.trim()
          if (values.task_id && custOrderId) {
            setActiveDialog({ kind: 'retry', taskId: values.task_id, custOrderId })
          }
        }}
      >
        <Activity className="h-3 w-3" />Retry
      </button>
    )
  }

  /** 协议单（task_type=3）「免填单」：按客户订单 BILL_ID + 创建月份查 SO_BUSI_PRINT（营业库） */
  const renderSoBusiPrintAction = (values: Record<string, string>) => {
    if (String(values.task_type) !== '3') return null
    return (
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-sky-500/40 bg-sky-500/10 px-1.5 text-[10px] text-sky-300 hover:bg-sky-500/20"
        data-so-busi-print-action
        onClick={() => {
          // bill_id / create_date 取自客户订单信息(hall_cust)结果行，工单行只提供 task_type 判定
          const custNode = sceneCache[sceneCode]?.nodes.find(node => node.node_code === 'cust_order')
          const row = custNode && custNode.rows.length > 0 ? rowValues(custNode.columns, custNode.rows[0]) : null
          const billId = String(row?.bill_id ?? '').trim()
          const createDate = String(row?.create_date ?? '').trim()
          if (!billId || !createDate) {
            setError('Customer order missing BILL_ID or create date — cannot query no-receipt')
            return
          }
          setActiveDialog({ kind: 'soBusiPrint', billId, createDate })
        }}
      >
        <Printer className="h-3 w-3" />No-Receipt
      </button>
    )
  }

  /** 策划订单项行「关联」：按行内 customer_order_id + offer_order_id 查 ord_srv_attr（家庭订单库） */
  const renderPlanSrvAttrAction = (values: Record<string, string>) => (
    <button
      className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
      data-offer-srv-attr-action
      onClick={() => {
        const customerOrderId = String(values.customer_order_id ?? '').trim()
        const offerOrderId = String(values.offer_order_id ?? '').trim()
        if (!customerOrderId || !offerOrderId) {
          setError('Row missing customer_order_id / offer_order_id — cannot query linked srv attributes')
          return
        }
        setActiveDialog({ kind: 'offerSrvAttr', customerOrderId, offerOrderId })
      }}
    >
      <Link2 className="h-3 w-3" />Link
    </button>
  )

  /** 工单行操作列：重试（task_type=5，在途）+ 免填单（task_type=3） */
  const renderTaskOrderActions = (values: Record<string, string>) => {
    const retry = renderRetryAction(values)
    const print = renderSoBusiPrintAction(values)
    if (!retry && !print) return <span className="text-[10px] text-[#5a5a70]">—</span>
    return <span className="flex items-center gap-1">{retry}{print}</span>
  }

  /** 工单信息(task_type=5)提取有效 scene_id → 查 DEF_SCENE 展示场景名 */
  function loadDefSceneFromNodes(nodes: AnalysisNodeResult[]) {
    setDefScene(null)
    const taskNode = nodes.find(node => node.node_code === 'task_order')
    if (!taskNode) return
    const values = taskNode.rows.map(row => rowValues(taskNode.columns, row))
    const hit = values.find(item => String(item.task_type) === '5'
      && item.scene_id && item.scene_id !== '20000002' && item.scene_id !== '20000005')
    if (!hit) return
    const sceneId = hit.scene_id
    api.getDefScene({ scene_id: sceneId }).then(response => {
      if (response.success && response.data?.success) {
        setDefScene({ sceneId, sceneName: response.data.scene_name || '' })
      }
    })
  }

  const renderMessageAction = (schedulerId: string) => (values: Record<string, string>) => {
    if (!values.task_id) return <span className="text-[10px] text-[#5a5a70]">—</span>
    return (
      <div className="flex items-center gap-1">
        <button
          className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
          onClick={() => openMessage(values, schedulerId)}
        >
          <MessageSquareText className="h-3 w-3" />Message
        </button>
        <button
          className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 text-[10px] text-cyan-300 hover:bg-cyan-500/20"
          onClick={() => {
            setActiveDialog({ kind: 'consumeEx', taskId: values.task_id })
          }}
        >
          <MessageSquareText className="h-3 w-3" />Messages
        </button>
      </div>
    )
  }

  // 当前激活的弹窗（null=无）；尾部挂载区按 dlg.kind 条件渲染
  const dlg = activeDialog

  return (
    <div className="space-y-3" data-analysis-panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">Data Query</h2>
          {centers.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border border-[#252530] p-0.5" data-center-tabs>
              {centers.map(item => (
                <button
                  key={item.center_code}
                  className={cn(
                    'rounded px-2.5 py-1 text-[11px]',
                    item.center_code === centerCode
                      ? 'bg-indigo-500/20 text-indigo-300'
                      : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
                  )}
                  onClick={() => switchCenter(item.center_code)}
                >
                  {centerNameEn(item)}
                </button>
              ))}
            </div>
          )}
          {/* 订单/配置两级 tab 仅对有配置表单的中心（家庭订单/客户订单）显示：
              其余中心点「配置查询」只会回落渲染订单表单，误导用户以为功能异常 */}
          {['family_order', 'hall_center'].includes(centerCode) && (
            <div className="flex items-center gap-1 rounded-md border border-[#3a3a4a] bg-white/[0.03] p-0.5" data-query-kind-tabs>
              {([['order', 'Order Query'], ['config', 'Config Query']] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  className={cn(
                    'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                    queryKind === kind
                      ? 'bg-indigo-500/25 text-indigo-200'
                      : 'text-[#9a9aad] hover:bg-white/5 hover:text-[#cdd3e0]',
                  )}
                  onClick={() => {
                    setQueryKind(kind)
                    setError('')
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {elapsed > 0 && <span className="text-[11px] text-[#5a5a70]">Total {elapsed} ms</span>}
      </div>

      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        {queryKind === 'config' && centerCode === 'family_order' ? (
          <div className="flex flex-wrap items-end gap-3" data-config-form>
            {/* 配置查询子 tab：模板版本 / 静态配置 */}
            <div className="flex items-center gap-1 self-center rounded-md border border-[#3a3a4a] bg-white/[0.03] p-0.5" data-family-config-tabs>
              {([['template', 'Template Versions'], ['static', 'Static Config']] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  className={cn('rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                    familyConfigTab === tab ? 'bg-indigo-500/25 text-indigo-200' : 'text-[#9a9aad] hover:bg-white/5 hover:text-[#cdd3e0]')}
                  onClick={() => { setFamilyConfigTab(tab); setError('') }}
                >
                  {label}
                </button>
              ))}
            </div>
            {familyConfigTab === 'static' ? (
              <>
                <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                  <span>Config Code</span>
                  <Input
                    className="h-8 w-[280px] max-w-full bg-[#0f0f14] text-[12px]"
                    value={staticConfigCode}
                    onChange={event => setStaticConfigCode(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && void queryStaticConfig()}
                  />
                </label>
                <span className="text-[10px] text-[#5a5a70]">Look up bs_para_detail / bs_static_data by code (Family Order Config DB)</span>
                <Button size="sm" className="h-8" disabled={loading} onClick={() => void queryStaticConfig()}>
                  <Search className="mr-1 h-3.5 w-3.5" />
                  {loading ? `Querying ${loadingSeconds}s` : '查询'}
                </Button>
              </>
            ) : (
              <>
                <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                  <span>Template Code</span>
                  <Input
                    className="h-8 w-[240px] max-w-full bg-[#0f0f14] text-[12px]"
                    value={familyTemplateTag}
                    onChange={event => setFamilyTemplateTag(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && void queryFamilyTemplate()}
                  />
                </label>
                <span className="text-[10px] text-[#5a5a70]">Template versions by code (Workflow Config DB)</span>
                <Button size="sm" className="h-8" disabled={loading} onClick={() => void queryFamilyTemplate()}>
                  <Search className="mr-1 h-3.5 w-3.5" />
                  {loading ? `Querying ${loadingSeconds}s` : '查询'}
                </Button>
              </>
            )}
          </div>
        ) : queryKind === 'config' && centerCode === 'hall_center' ? (
          <div className="flex flex-wrap items-end gap-3" data-config-form>
            <label className="space-y-1 text-[11px] text-[#8b8b9e]">
              <span>Scene ID</span>
              <Input
                className="h-8 w-[200px] max-w-full bg-[#0f0f14] text-[12px]"
                value={configSceneId}
                onChange={event => setConfigSceneId(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void queryConfig()}
              />
            </label>
            <span className="text-[10px] text-[#5a5a70]">Scene definitions + rule definitions + scene unit relations by scene ID (Customer Order Config DB)</span>
            <Button size="sm" className="h-8" disabled={loading} onClick={() => void queryConfig()}>
              <Search className="mr-1 h-3.5 w-3.5" />
              {loading ? `Querying ${loadingSeconds}s` : '查询'}
            </Button>
          </div>
        ) : (
        <div className="flex flex-wrap items-end gap-3">
          {isDriveScene ? (
            <>
              <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                <span>Offer ID</span>
                <Input
                  className="h-8 w-[220px] max-w-full bg-[#0f0f14] text-[12px]"
                  value={driveGradeNo}
                  onChange={event => setDriveGradeNo(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && void query()}
                />
              </label>
              <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                <span>Plan ID</span>
                <Input
                  className="h-8 w-[220px] max-w-full bg-[#0f0f14] text-[12px]"
                  value={driveOfferNo}
                  onChange={event => setDriveOfferNo(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && void query()}
                />
              </label>
            </>
          ) : isRuleScene ? (
            <>
              <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                <span>Business Code</span>
                <Input
                  className="h-8 w-[280px] max-w-full bg-[#0f0f14] text-[12px]"
                  value={businessKey}
                  onChange={event => setBusinessKey(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && void query()}
                />
              </label>
              <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                <span>Rule Code</span>
                <Input
                  className="h-8 w-[220px] max-w-full bg-[#0f0f14] text-[12px]"
                  value={ruleCode}
                  onChange={event => setRuleCode(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && void query()}
                />
              </label>
            </>
          ) : (
            <label className="space-y-1 text-[11px] text-[#8b8b9e]">
              <span>{isProductScene ? (sceneCode === PLAN_CONFIG_SCENE.scene_code ? 'Product/Plan ID' : 'Offer ID') : isInstanceScene ? 'Billing Account' : 'Business Key'}</span>
              <Input
                className="h-8 w-[280px] max-w-full bg-[#0f0f14] text-[12px]"
                value={businessKey}
                onChange={event => setBusinessKey(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void query()}
              />
            </label>
          )}
          {!(isProductScene || isInstanceScene || isDriveScene || isRuleScene) && (
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>City</span>
            <Input
              className="h-8 w-[72px] max-w-full bg-[#0f0f14] text-[12px]"
              value={city}
              onChange={event => setCity(event.target.value)}
            />
          </label>
          )}
          {!(isProductScene || isInstanceScene || isDriveScene || isRuleScene) && (
          <div className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>Data Type</span>
            <div className="flex h-8 items-center overflow-hidden rounded-md border border-[#252530]" data-transit-toggle>
              <button
                className={cn('h-8 px-3 text-[11px]', inTransit ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5')}
                onClick={() => setInTransit(true)}
              >
                In-Transit
              </button>
              <button
                className={cn('h-8 px-3 text-[11px]', !inTransit ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5')}
                onClick={() => setInTransit(false)}
              >
                History
              </button>
            </div>
          </div>
          )}
          {!(isProductScene || isInstanceScene || isDriveScene) && !inTransit && (
            <label className="space-y-1 text-[11px] text-[#8b8b9e]">
              <span>History Month</span>
              <Input
                type="month"
                className="h-8 w-[140px] max-w-full bg-[#0f0f14] text-[12px]"
                value={historyMonth}
                onChange={event => setHistoryMonth(event.target.value)}
              />
            </label>
          )}
          <Button size="sm" className="h-8" disabled={loading} onClick={() => void query()}>
            <Search className="mr-1 h-3.5 w-3.5" />
            {loading ? `Querying ${loadingSeconds}s` : '查询'}
          </Button>
        </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />{error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">
          <Activity className="h-3.5 w-3.5 shrink-0" />{notice}
        </div>
      )}

      {centerCode !== '' && scenes.length === 0 && !loading && (
        <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]" data-pending-center-placeholder>
          Query not wired for "{centerNameEn(center)}" — scenario/SQL pending (key: {businessKey.trim() || '—'})
        </div>
      )}

      {scenes.length > 0 && (
        <>
          {queryKind === 'order' && (
          <div className="flex flex-wrap items-center gap-1.5" data-scene-tabs>
            {scenes.map(scene => (
              <button
                key={scene.scene_code}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                  scene.scene_code === sceneCode
                    ? 'border-indigo-400/60 bg-indigo-500/25 text-indigo-200 shadow-[0_0_10px_rgba(99,102,241,0.25)]'
                    : 'border-[#3a3a4a] bg-white/[0.04] text-[#c9c9da] hover:border-[#4a4a5c] hover:bg-white/[0.08] hover:text-[#e8e8f2]',
                )}
                onClick={() => {
                  // 产品中心：从策划配置切回档次配置时，还原跳转前的产品编号
                  let effectiveKey = businessKey.trim()
                  if (centerCode === PRODUCT_CENTER_CODE
                    && scene.scene_code === PRODUCT_CONFIG_SCENE.scene_code
                    && productKeyMemoRef.current) {
                    effectiveKey = productKeyMemoRef.current
                    productKeyMemoRef.current = ''
                    setBusinessKey(effectiveKey)
                  }
                  // 切场景即离开当前视图：清掉实时工单下钻（只在订单信息里有意义）
                  if (scene.scene_code !== sceneCode) {
                    setLiveNode(null)
                    setSelectedScheduler('')
                  }
                  setSceneCode(scene.scene_code)
                  // 产品中心结果按查询时的编号缓存：编号一致直接展示，不一致才重查
                  const cached = scene.scene_code === WORKFLOW_SCENE.scene_code
                    ? workflowResult
                    : scene.scene_code === ASYNC_FLOW_SCENE.scene_code
                      ? asyncFlowResult
                      : scene.scene_code === STRUCTURED_SCENE.scene_code
                        ? structuredResult
                        : scene.scene_code === OTHER_SCENE.scene_code
                          ? familyOtherResult
                        : scene.scene_code === INSTANCE_USER_SCENE.scene_code
                          ? instanceUserResult
                        : scene.scene_code === PRODUCT_DRIVE_SCENE.scene_code
                          ? productDriveResult
                        : scene.scene_code === INSTANCE_ORDER_SCENE.scene_code
                          ? instanceOrderResult
                        : scene.scene_code === INSTANCE_TERMINAL_SCENE.scene_code
                          ? instanceTerminalResult
                        : scene.scene_code === PRODUCT_CONFIG_SCENE.scene_code
                          ? (productResult && productResultKey === effectiveKey ? productResult : null)
                          : scene.scene_code === PLAN_CONFIG_SCENE.scene_code
                            ? (planResult && planResultKey === effectiveKey ? planResult : null)
                            : sceneCache[scene.scene_code]
                  // 已有数据直接展示（点「查询」按钮才刷新），切 tab 不清空/不重查
                  if (!cached) void loadScene(scene.scene_code, effectiveKey)
                }}
              >
                {sceneNameEn(scene)}
              </button>
            ))}
          </div>
          )}

          {queryKind === 'config' && centerCode === 'family_order' ? (
            <div className="space-y-3" data-config-results>
              {familyConfigTab === 'static' ? (
                staticConfigResult ? staticConfigResult.results.map(block => (
                  <ResultCard
                    key={block.name}
                    title={block.name}
                    rowCount={block.row_count}
                    table={block.table_name}
                    datasource="Family Order Config DB"
                  >
                    {!block.success && block.error ? (
                      <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                      </div>
                    ) : (
                      <QueryResultTable columns={block.columns} rows={block.rows} />
                    )}
                  </ResultCard>
                )) : !loading && (
                  <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                    Enter a config code to query static config (bs_para_detail / bs_static_data, Family Order Config DB)
                  </div>
                )
              ) : templateResult ? (
                <ResultCard
                  title="Workflow Template Versions"
                  table="vm_template_version"
                  datasource="Workflow Config DB"
                  rowCount={templateResult.versions.length}
                >
                  {templateResult.versions.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">No versions for this template code</div>
                  ) : (
                    <div className="max-h-[420px] overflow-auto">
                      <table className="w-full border-collapse text-left text-[11px]">
                        <thead className="sticky top-0 z-[1] bg-[#20202c]">
                          <tr>
                            {['Version ID', 'Template Code', 'Seq', 'Created By', 'Created At', 'Effective From', 'Expires At', 'Status', 'Change Note'].map(title => (
                              <th key={title} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{title}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {templateResult.versions.map(version => (
                            <tr key={version.template_version_id} className="border-b border-[#1d1d26] hover:bg-white/[0.03]">
                              <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[#cdd3e0]">{version.template_version_id}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[#cdd3e0]">{version.template_tag}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]">{version.order_num ?? '—'}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]">{version.create_staff_id ?? '—'}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]">{version.create_date ?? '—'}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]">{version.valid_date ?? '—'}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]">{version.expire_date ?? '—'}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5">
                                <span className={cn('rounded border px-1.5 py-0.5 text-[10px]',
                                  version.is_expired
                                    ? 'border-[#3a3a45] bg-white/5 text-[#8b8b9e]'
                                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300')}>
                                  {version.is_expired ? 'Expired' : 'Active'}
                                </span>
                              </td>
                              <td className="max-w-[280px] truncate px-2.5 py-1.5 text-[#cdd3e0]" title={version.modify_desc ?? ''}>{version.modify_desc ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </ResultCard>
              ) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a template code to query workflow template versions (Workflow Config DB)
                </div>
              )}
            </div>
          ) : queryKind === 'config' && centerCode === 'hall_center' ? (
            <div className="space-y-3" data-config-results>
              {configScene && (
                <NodeCard
                  result={{
                    node_code: 'def_scene',
                    node_name: 'Scene Definitions',
                    table_name: 'DEF_SCENE',
                    datasource_name: 'Customer Order Config DB',
                    color: 'purple',
                    parent_node_code: '',
                    parent_field: '',
                    query_field: 'SCENE_ID',
                    success: configScene.success,
                    columns: configScene.columns,
                    rows: configScene.rows,
                    row_count: configScene.row_count,
                    error: configScene.error,
                    sql: configScene.sql,
                  }}
                />
              )}
              {sceneRules ? (() => {
                const part = sceneRules.rule
                const ruleRows = part.rows.map(row => {
                  // 规则定义表：RULE_TYPE 数值后附中文含义（枚举对齐 Nexus 常量表）
                  const idx = part.columns.findIndex(col => col.toLowerCase() === 'rule_type')
                  if (idx < 0 || idx >= row.length) return row
                  const cn = RULE_TYPE_NAMES[String(row[idx]).trim()]
                  return cn ? [...row.slice(0, idx), `${row[idx]}：${cn}`, ...row.slice(idx + 1)] : row
                })
                return (
                <NodeCard
                  key={part.node_name}
                  result={{
                    node_code: part.node_name,
                    node_name: part.node_name,
                    table_name: part.sql?.match(/FROM (\S+)/)?.[1] ?? '',
                    datasource_name: 'Customer Order Config DB',
                    color: 'blue',
                    parent_node_code: '',
                    parent_field: '',
                    query_field: '',
                    success: part.success,
                    columns: part.columns,
                    rows: ruleRows,
                    row_count: part.row_count,
                    error: part.error,
                    sql: part.sql ?? '',
                  }}
                  tableOverride={(
                    /* busi_cmpt_id / result 的值可点击 → 按点击值查 DEF_BUSI_CMPT */
                    <QueryResultTable
                      columns={part.columns}
                      rows={ruleRows}
                      clickableColumns={['busi_cmpt_id', 'result']}
                      onCellClick={(_, value) => {
                        setActiveDialog({ kind: 'busiCmpt', id: value })
                      }}
                    />
                  )}
                />
                )
              })() : null}
              {sceneRules?.unit_rel ? (
                <NodeCard
                  hint="Click BUSI_CMPT_ID to view business components"
                  result={{
                    node_code: 'scene_unit_rel',
                    node_name: sceneRules.unit_rel.node_name,
                    table_name: sceneRules.unit_rel.sql?.match(/FROM (\S+)/)?.[1] ?? '',
                    datasource_name: 'Customer Order Config DB',
                    color: 'amber',
                    parent_node_code: '',
                    parent_field: '',
                    query_field: 'SCENE_ID',
                    success: sceneRules.unit_rel.success,
                    columns: sceneRules.unit_rel.columns,
                    rows: sceneRules.unit_rel.rows,
                    row_count: sceneRules.unit_rel.row_count,
                    error: sceneRules.unit_rel.error,
                    sql: sceneRules.unit_rel.sql ?? '',
                  }}
                  tableOverride={(
                    /* busi_cmpt_id 值可点击 → 按点击值查 DEF_BUSI_CMPT */
                    <QueryResultTable
                      columns={sceneRules.unit_rel.columns}
                      rows={sceneRules.unit_rel.rows}
                      clickableColumns={['busi_cmpt_id']}
                      onCellClick={(_, value) => {
                        setActiveDialog({ kind: 'busiCmpt', id: value })
                      }}
                    />
                  )}
                />
              ) : null}
              {!sceneRules && !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a scene ID to query (Customer Order Config DB)
                </div>
              )}
            </div>
          ) : sceneCode === PRODUCT_DRIVE_SCENE.scene_code ? (
            <div className="space-y-3" data-product-drive-results>
              <div className="flex flex-wrap items-center gap-1.5" data-drive-category-tabs>
                {PRODUCT_DRIVE_CATEGORIES.map(([code, label]) => (
                  <button
                    key={code}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                      driveCategory === code
                        ? 'border-indigo-400/60 bg-indigo-500/25 text-indigo-200 shadow-[0_0_10px_rgba(99,102,241,0.25)]'
                        : 'border-[#3a3a4a] bg-white/[0.04] text-[#c9c9da] hover:border-[#4a4a5c] hover:bg-white/[0.08] hover:text-[#e8e8f2]',
                    )}
                    onClick={() => {
                      if (driveCategory === code) return
                      setDriveCategory(code)
                      setProductDriveResult(null)
                      setError('')
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {productDriveResult ? productDriveResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource={block.datasource ?? '产品库'}
                  hint={block.name === '框架规则' ? 'Click RULE_ID to view rule definition' : undefined}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : block.name === '框架规则' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['rule_id']}
                      onCellClick={(_, value) => {
                        setActiveDialog({ kind: 'upRule', id: value })
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  {`Product Drive · ${PRODUCT_DRIVE_CATEGORIES.find(([code]) => code === driveCategory)?.[1] ?? ''} (pending — table/conditions TBD)`}
                </div>
              )}
            </div>
          ) : sceneCode === INSTANCE_USER_SCENE.scene_code ? (
            <div className="space-y-3" data-instance-user-results>
              {instanceUserResult ? instanceUserResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource="Billing DB"
                  hint={block.name === '用户信息' ? 'cust_type=1 auto-queries individual customer; non-empty family_cust_id auto-queries family customer' : undefined}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a billing account to query user info (ins_user / cm_indiv_customer / cm_family_customer, Billing DB)
                </div>
              )}
            </div>
          ) : sceneCode === INSTANCE_ORDER_SCENE.scene_code ? (
            <div className="space-y-3" data-instance-order-results>
              {instanceOrderResult ? instanceOrderResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource="Billing DB"
                  hint={block.name === '订购信息' ? 'Click offer_inst_id to view srv attributes' : undefined}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : block.name === '订购信息' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['offer_inst_id']}
                      onCellClick={(_, value) => {
                        setActiveDialog({ kind: 'srvAttr', offerInstId: value })
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a billing account to query subscriptions (Billing DB)
                </div>
              )}
            </div>
          ) : sceneCode === INSTANCE_TERMINAL_SCENE.scene_code ? (
            <div className="space-y-3" data-instance-terminal-results>
              {instanceTerminalResult ? instanceTerminalResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource="Billing DB"
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a billing account to query terminals (Billing DB)
                </div>
              )}
            </div>
          ) : sceneCode === PRODUCT_CONFIG_SCENE.scene_code ? (
            <div className="space-y-3" data-product-config-results>
              {productResult ? productResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource="Product DB"
                  hint={block.name === '产品关系' ? 'Click related product ID to open plan config query'
                    : block.name === '业务关系' ? 'Click relat_product_item_id to view business info' : undefined}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : block.name === '产品关系' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['relat_product_item_id']}
                      onCellClick={(_, value) => {
                        // 携带关联产品编号跳转策划配置并自动查询；记住原编号供切回时还原
                        productKeyMemoRef.current = businessKey
                        setBusinessKey(value)
                        setSceneCode(PLAN_CONFIG_SCENE.scene_code)
                        setPendingQuery(true)
                      }}
                    />
                  ) : block.name === '业务关系' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['relat_product_item_id']}
                      onCellClick={(_, value) => {
                        setActiveDialog({ kind: 'businessInfo', id: value })
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter an offer ID to query offer config (validates up_offer.offer_type = OFFER_VAS_BIND first; Product DB)
                </div>
              )}
            </div>
          ) : sceneCode === PLAN_CONFIG_SCENE.scene_code ? (
            <div className="space-y-3" data-plan-config-results>
              {planResult ? planResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource="Product DB"
                  hint={block.name === '关联产品' ? 'Click related product ID to query attribute info'
                    : block.name === '前项限制' ? 'Click rule_exp to query pre-limit params'
                    : block.name === '业务关系' ? 'Click relat_product_item_id to view business info' : undefined}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : block.name === '关联产品' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['relat_product_item_id']}
                      onCellClick={(_, value) => void queryItemRelat(value)}
                    />
                  ) : block.name === '前项限制' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['rule_exp']}
                      clickableValue={value => /^(\w+)\(\d+\)$/.test(value.trim())}
                      onCellClick={(_, value) => void queryPreLmtParam(value)}
                    />
                  ) : block.name === '业务关系' ? (
                    <QueryResultTable
                      columns={block.columns}
                      rows={block.rows}
                      clickableColumns={['relat_product_item_id']}
                      onCellClick={(_, value) => {
                        setActiveDialog({ kind: 'businessInfo', id: value })
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a product/plan ID to query plan config (up_product_item / up_item_feature / UP_OFFER_PRE_LIMIT / up_plan_prod_rel, Product DB)
                </div>
              )}
              {itemRelatResult && (
                <div className="space-y-3" data-item-relat-results>
                  <div className="flex items-center gap-2 px-1 text-[11px] text-[#8b8b9e]">
                    <Layers className="h-3.5 w-3.5 text-purple-300" />
                    <span>Attribute Info · Product <span className="font-mono text-[#cdd3e0]">{itemRelatResult.product_item_id}</span></span>
                    <button
                      className="ml-auto text-[10px] text-[#5a5a70] hover:text-[#cdd3e0]"
                      onClick={() => setItemRelatResult(null)}
                    >Collapse</button>
                  </div>
                  {itemRelatResult.results.map(block => (
                    <ResultCard
                      key={block.name}
                      title={block.name}
                      rowCount={block.row_count}
                      table={block.table_name}
                      datasource="Product DB"
                    >
                      {!block.success && block.error ? (
                        <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                        </div>
                      ) : (
                        <QueryResultTable columns={block.columns} rows={block.rows} />
                      )}
                    </ResultCard>
                  ))}
                </div>
              )}
              {preLmtParam && (
                <div className="space-y-3" data-pre-lmt-param-results>
                  <div className="flex items-center gap-2 px-1 text-[11px] text-[#8b8b9e]">
                    <Layers className="h-3.5 w-3.5 text-purple-300" />
                    <span>Pre-Limit · <span className="font-mono text-[#cdd3e0]">{preLmtParam.limitCode}({preLmtParam.paramId})</span></span>
                    <button
                      className="ml-auto text-[10px] text-[#5a5a70] hover:text-[#cdd3e0]"
                      onClick={() => setPreLmtParam(null)}
                    >Collapse</button>
                  </div>
                  {preLmtParam.result.results.map(block => (
                    <ResultCard
                      key={block.name}
                      title={block.name}
                      rowCount={block.row_count}
                      table={block.table_name}
                      datasource="Product DB"
                      hint={block.name === '限制参数' ? 'Click limit_code to view pre-limit details' : undefined}
                    >
                      {!block.success && block.error ? (
                        <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                        </div>
                      ) : block.name === '限制参数' ? (
                        <QueryResultTable
                          columns={block.columns}
                          rows={block.rows}
                          clickableColumns={['limit_code']}
                          onCellClick={(_, value) => {
                            setActiveDialog({ kind: 'soPreBusiLimit', code: value })
                          }}
                        />
                      ) : (
                        <QueryResultTable columns={block.columns} rows={block.rows} />
                      )}
                    </ResultCard>
                  ))}
                </div>
              )}
            </div>
          ) : sceneCode === OTHER_SCENE.scene_code ? (
            <div className="space-y-3" data-family-other-results>
              {familyOtherResult ? familyOtherResult.results.map(block => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.table_name}
                  datasource={block.datasource ?? '家庭订单库'}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a business key to query other info (ord_router_lock_net, Family Order DB)
                </div>
              )}
            </div>
          ) : sceneCode === ASYNC_FLOW_SCENE.scene_code ? (
            <div className="space-y-3" data-async-flow-results>
              {asyncFlowResult ? (
                <NodeCard
                  result={{
                    node_code: 'async_flow',
                    node_name: 'Async Flows',
                    table_name: asyncFlowResult.table_name,
                    datasource_name: 'Family Order DB',
                    color: 'cyan',
                    parent_node_code: '',
                    parent_field: '',
                    query_field: 'cust_order_id',
                    success: asyncFlowResult.success,
                    columns: asyncFlowResult.columns,
                    rows: asyncFlowResult.rows,
                    row_count: asyncFlowResult.row_count,
                    error: asyncFlowResult.error,
                    sql: asyncFlowResult.sql,
                  }}
                  hint={asyncFlowResult.history_fallback
                    ? 'No in-transit rows; fell back to history table'
                    : asyncFlowResult.row_count === 0 && (asyncFlowResult.checked_tables?.length ?? 0) > 1
                      ? `No rows in in-transit or last ${(asyncFlowResult.checked_tables?.length ?? 1) - 1} month(s) history tables`
                      : undefined}
                />
              ) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a family order ID to query async flows (ord_async_method_deal_task_order; auto-falls back to history after completion)
                </div>
              )}
            </div>
          ) : sceneCode === WORKFLOW_SCENE.scene_code ? (
            <div className="space-y-3" data-workflow-results>
              {workflowResult ? workflowResult.results.map((block: AnalysisQueryBlock) => {
                // state 列枚举值追加中文（格式 值：含义；未匹配的值原样展示）
                const stateIdx = block.columns.findIndex(col => col.toLowerCase() === 'state')
                const rows = stateIdx < 0 ? block.rows : block.rows.map(row => {
                  const raw = String(row[stateIdx] ?? '').trim()
                  const cn = WORKFLOW_STATE_NAMES[raw]
                  return cn ? [...row.slice(0, stateIdx), `${raw}：${cn}`, ...row.slice(stateIdx + 1)] : row
                })
                const tagClickable = (block.name === '工作流订单' || block.name === 'RBoss工作流')
                return (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.sql?.match(/FROM (\S+)/)?.[1]}
                  hint={tagClickable ? 'Click template_tag to open workflow query' : undefined}
                >
                  {!block.success && block.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{block.error}
                    </div>
                  ) : (
                    <QueryResultTable
                      columns={block.columns}
                      rows={rows}
                      clickableColumns={tagClickable ? ['template_tag'] : []}
                      clickableValue={tagClickable ? (value) => !!value.trim() : undefined}
                      onCellClick={tagClickable ? (_, value) => onQueryWorkflow?.(value.trim()) : undefined}
                    />
                  )}
                </ResultCard>
                )
              }) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a business key; RBoss schedule order ID auto-fills from Order Info results
                </div>
              )}
            </div>
          ) : sceneCode === STRUCTURED_SCENE.scene_code ? (
            <div className="space-y-3" data-structured-results>
              {structuredResult ? structuredResult.tables.map(table => (
                <NodeCard
                  key={table.table_name}
                  result={{
                    node_code: table.table_name,
                    node_name: table.label,
                    table_name: table.table_name,
                    datasource_name: 'Customer Order DB',
                    color: 'cyan',
                    parent_node_code: '',
                    parent_field: '',
                    query_field: 'CUST_ORDER_ID',
                    success: table.success,
                    columns: table.columns,
                    rows: table.rows,
                    row_count: table.row_count,
                    error: table.error,
                    sql: table.sql,
                  }}
                />
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a business key to query structured order info (17 HALL_ORD_* tables in parallel)
                </div>
              )}
            </div>
          ) : sceneCode === RULE_BUSI_SCENE.scene_code ? (
            <div className="space-y-3" data-rule-busi-results>
              {ruleBusiResult ? (
                <ResultCard
                  title="Business Rule Details"
                  rowCount={ruleBusiResult.row_count}
                  table={ruleBusiResult.table_name}
                  datasource="Rule Config DB"
                >
                  {!ruleBusiResult.success && ruleBusiResult.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{ruleBusiResult.error}
                    </div>
                  ) : (
                    <QueryResultTable columns={ruleBusiResult.columns} rows={ruleBusiResult.rows} />
                  )}
                </ResultCard>
              ) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  Enter a business code or rule code to query business rule details (joins instance/template/factor chain, Rule Config DB)
                </div>
              )}
            </div>
          ) : sceneResult ? (
            <div className="space-y-3" data-scene-results>
              {centerCode === 'hall_center' && defScene && (
                <div className="flex items-center gap-2.5 rounded-lg border border-amber-400/60 bg-amber-400/15 px-3.5 py-2 shadow-[0_0_12px_rgba(251,191,36,0.15)]"
                  data-def-scene-badge>
                  <Layers className="h-4 w-4 shrink-0 text-amber-300" />
                  <span className="text-[11px] text-amber-200/80">Scene</span>
                  <span className="text-[14px] font-bold text-amber-300">{defScene.sceneName || '(no scene name)'}</span>
                  {/* 点击场景编号 → 跳转配置查询并自动带入该场景ID */}
                  <button
                    className="ml-auto shrink-0 rounded border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-200 hover:bg-amber-300/20 hover:text-amber-100"
                    title="Open config query"
                    onClick={() => {
                      setQueryKind('config')
                      setConfigSceneId(defScene.sceneId)
                      void queryConfig(defScene.sceneId)
                    }}
                  >
                    SCENE_ID {defScene.sceneId} ↦
                  </button>
                </div>
              )}
              {sceneResult.nodes
                .filter(node => node.node_code !== 'work_order')
                .map(node => {
                  const stats = node.node_code === 'busi_order' ? itemTypeStats(node) : null
                  return (
                    <NodeCard
                      key={node.node_code}
                      result={node}
                      hint={node.node_code === 'scheduler_order' ? 'Click row for live ticket query' : undefined}
                      action={node.node_code === 'cust_order' && centerCode === 'family_order' ? (
                        <button
                          className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-indigo-500/40 bg-indigo-500/10 px-2 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
                          disabled={!businessKey.trim()}
                          onClick={() => setActiveDialog({ kind: 'components' })}
                        >
                          <Layers className="h-3 w-3" />Components
                        </button>
                      ) : undefined}
                      headerExtra={stats ? (
                        <div className="flex items-center gap-1.5 border-b border-[#252530] px-3 py-1.5 text-[10px] text-[#8b8b9e]">
                          Order item stats:
                          {Object.entries(stats).map(([key, count]) => (
                            <span key={key} className={cn('rounded border px-1.5 py-0.5',
                              count > 0 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-[#252530] text-[#5a5a70]')}>
                              {key} {count}
                            </span>
                          ))}
                        </div>
                      ) : undefined}
                      tableOverride={node.node_code === 'cust_order' && centerCode === 'hall_center' ? (
                        <QueryResultTable
                          columns={node.columns}
                          rows={node.rows}
                          renderActions={renderCustomerMessageAction}
                        />
                      ) : node.node_code === 'task_order' && centerCode === 'hall_center' ? (
                        <QueryResultTable
                          columns={node.columns}
                          rows={node.rows}
                          renderActions={renderTaskOrderActions}
                        />
                      ) : node.node_code === 'flowins_order' && centerCode === 'hall_center' ? (
                        <QueryResultTable
                          columns={node.columns}
                          rows={node.rows}
                          renderActions={renderAcceptMessageAction}
                          clickableColumns={['ext_done_code', 'busi_cmpt_id']}
                          onCellClick={(column, value) => {
                            if (column.toLowerCase() === 'busi_cmpt_id') {
                              // BUSI_CMPT_ID → 查 DEF_BUSI_CMPT 组件定义（支持逗号分隔多值 IN 查询）
                              setActiveDialog({ kind: 'busiCmpt', id: value })
                              return
                            }
                            // EXT_DONE_CODE → 跳转家庭订单中心，值作为业务主键自动查询
                            switchCenter('family_order')
                            setQueryKind('order')
                            setBusinessKey(value)
                            setPendingQuery(true)
                          }}
                        />
                      ) : node.node_code === 'cust_attr' && centerCode === 'family_order' ? (
                        /* 客户订单属性：attr_value 密文信封可点击解密，明文原位替换展示 */
                        (() => {
                          const attrIdx = node.columns.findIndex(col => col.toLowerCase() === 'attr_value')
                          // 解密缓存的键统一为 trim 后的密文（点击传值 trim，行值可能带尾部空格）
                          const attrRows = attrIdx >= 0
                            ? node.rows.map(row => {
                                const decrypted = decryptedMap[String(row[attrIdx] ?? '').trim()]
                                return decrypted !== undefined
                                  ? [...row.slice(0, attrIdx), decrypted, ...row.slice(attrIdx + 1)]
                                  : row
                              })
                            : node.rows
                          return (
                            <QueryResultTable
                              columns={node.columns}
                              rows={attrRows}
                              clickableColumns={attrIdx >= 0 ? ['attr_value'] : []}
                              clickableValue={value =>
                                decryptedMap[value] !== undefined
                                || (value.includes('"policy"') && value.includes('"cipher"'))
                                // 裸密文：无花括号、含 | 分隔、长度足够
                                || (!value.includes('{') && value.includes('|') && value.length > 20)}
                              onCellClick={(_, value) => {
                                // 已解密的展示值不再是原始信封，用原始行值（trim 对齐）定位缓存键
                                const original = node.rows.find(row =>
                                  String(row[attrIdx] ?? '').trim() === value
                                  || decryptedMap[String(row[attrIdx] ?? '').trim()] === value)
                                void handleDecryptClick(original ? String(original[attrIdx]).trim() : value)
                              }}
                            />
                          )
                        })()
                      ) : node.node_code === 'scheduler_order' && centerCode === 'family_order' ? (
                        <QueryResultTable
                          columns={node.columns}
                          rows={node.rows.map(row => {
                            // STATE 数值后附中文含义
                            const idx = node.columns.findIndex(col => col.toLowerCase() === 'state')
                            if (idx < 0 || idx >= row.length) return row
                            const cn = SCHEDULER_STATE_NAMES[String(row[idx]).trim()]
                            return cn ? [...row.slice(0, idx), `${row[idx]}：${cn}`, ...row.slice(idx + 1)] : row
                          })}
                          selectedValue={selectedScheduler}
                          onRowClick={values => {
                            if (values.scheduler_order_id) void queryLiveWorkOrder(values.scheduler_order_id)
                          }}
                          clickableColumns={['scene_cfg_id']}
                          onCellClick={(_, value) => {
                            setActiveDialog({ kind: 'sceneCfg', id: value })
                          }}
                        />
                      ) : node.node_code === 'plan' && centerCode === 'family_order' ? (
                        /* 策划订单项：行操作「关联」查服务属性（ord_srv_attr，家庭订单库） */
                        <QueryResultTable
                          columns={node.columns}
                          rows={node.rows}
                          renderActions={renderPlanSrvAttrAction}
                        />
                      ) : undefined}
                    />
                  )
                })}
              {(() => {
                const baseWork = sceneResult.nodes.find(node => node.node_code === 'work_order')
                const work = liveNode ?? baseWork
                if (!work) return null
                return (
                  <NodeCard
                    result={liveNode ? { ...liveNode, node_name: `${liveNode.node_name} · Live` } : work}
                    hint={liveNode ? `Schedule order ${selectedScheduler}` : undefined}
                    tableOverride={(
                      <QueryResultTable
                        columns={work.columns}
                        rows={work.rows}
                        renderActions={renderMessageAction(liveNode ? selectedScheduler : '')}
                        clickableColumns={['busi_cmp_id']}
                        onCellClick={(_, value) => {
                          setActiveDialog({ kind: 'occCmpt', id: value })
                        }}
                      />
                    )}
                  />
                )
              })()}
            </div>
          ) : !loading && (
            <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
              Enter a business key to query
            </div>
          )}
        </>
      )}

      {/* 弹窗按 activeDialog 条件挂载：一次只弹一个；目标变化即新实例（state 初值即目标，无需 key hack） */}
      {dlg?.kind === 'message' && (
        <MessageDialog
          open
          onOpenChange={closeDialog}
          target={dlg.target}
          context={{ city, inTransit, historyMonth }}
        />
      )}

      {dlg?.kind === 'custMessage' && (
        <CustomerOrderMessageDialog
          open
          onOpenChange={closeDialog}
          custOrderId={dlg.custOrderId}
          city={city}
          inTransit={inTransit}
          historyMonth={historyMonth}
        />
      )}

      {dlg?.kind === 'acceptMessage' && (
        <AcceptMessageDialog
          open
          onOpenChange={closeDialog}
          custOrderId={dlg.custOrderId}
          taskFlowInsId={dlg.flowInsId}
        />
      )}

      {dlg?.kind === 'busiCmpt' && (
        <BusiCmptDialog open onOpenChange={closeDialog} busiCmptId={dlg.id} />
      )}

      {dlg?.kind === 'soBusiPrint' && (
        <SoBusiPrintDialog
          open
          onOpenChange={closeDialog}
          billId={dlg.billId}
          createDate={dlg.createDate}
          city={city}
        />
      )}

      {dlg?.kind === 'decrypt' && (
        <DecryptDialog
          open
          onOpenChange={closeDialog}
          envelopeText={dlg.envelope}
          cachedPlain={dlg.cachedPlain}
          onDecrypted={plain => mergeDecrypted({ [dlg.envelope]: plain })}
        />
      )}

      {dlg?.kind === 'occCmpt' && (
        <OccBusiCmptDialog open onOpenChange={closeDialog} cmptCfgId={dlg.id} />
      )}

      {dlg?.kind === 'soPreBusiLimit' && (
        <SoPreBusiLimitDialog open onOpenChange={closeDialog} limitCode={dlg.code} />
      )}

      {dlg?.kind === 'businessInfo' && (
        <BusinessInfoDialog open onOpenChange={closeDialog} businessId={dlg.id} />
      )}

      {dlg?.kind === 'upRule' && (
        <UpRuleDialog open onOpenChange={closeDialog} ruleId={dlg.id} />
      )}

      {dlg?.kind === 'consumeEx' && (
        <ConsumeExDialog
          open
          onOpenChange={closeDialog}
          taskId={dlg.taskId}
          context={{ city, inTransit, historyMonth }}
        />
      )}

      {dlg?.kind === 'offerSrvAttr' && (
        <OfferSrvAttrDialog
          open
          onOpenChange={closeDialog}
          customerOrderId={dlg.customerOrderId}
          offerOrderId={dlg.offerOrderId}
          context={{ city, inTransit, historyMonth }}
        />
      )}

      {dlg?.kind === 'srvAttr' && (
        <InstanceSrvAttrDialog open onOpenChange={closeDialog} offerInstId={dlg.offerInstId} />
      )}

      {dlg?.kind === 'sceneCfg' && (
        <SceneConfigDialog
          open
          onOpenChange={closeDialog}
          sceneCfgId={dlg.id}
          onQueryWorkflow={onQueryWorkflow}
        />
      )}

      {dlg?.kind === 'components' && (
        <OrderComponentsDialog
          open
          onOpenChange={closeDialog}
          orderKey={businessKey.trim()}
          params={(() => {
            const node = sceneCache['order_info']?.nodes.find(item => item.node_code === 'cust_order')
            if (!node || node.rows.length === 0) return {}
            return rowValues(node.columns, node.rows[0])
          })()}
          onQueryWorkflow={onQueryWorkflow}
        />
      )}

      {/* 工单重试确认（写操作） */}
      {dlg?.kind === 'retry' && (
        <Dialog open onOpenChange={open => { if (!open) closeDialog() }}>
          <DialogContent className="max-w-md gap-3">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[15px]">
                <Activity className="h-4 w-4 text-rose-400" />Ticket Retry
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-[12px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#8b8b9e]">Ticket ID</span>
                <span className="font-mono text-[#cdd3e0]">{dlg.taskId}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#8b8b9e]">Customer Order ID</span>
                <span className="font-mono text-[#cdd3e0]">{dlg.custOrderId}</span>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Will run UPDATE HALL_TASK SET TASK_STATE = 2 and UPDATE HALL_TASK_FLOW_INS SET handle_type = 2 on the in-transit tables. This cannot be undone.
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button size="sm" variant="outline" className="h-8" onClick={closeDialog}>Cancel</Button>
              <Button size="sm" className="h-8 bg-rose-600 text-white hover:bg-rose-500"
                onClick={() => void executeRetry(dlg.taskId, dlg.custOrderId)}>
                <Activity className="mr-1 h-3.5 w-3.5" />Confirm Retry
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
