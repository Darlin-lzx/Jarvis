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
  SceneRulesResult, BusiCmptResult, DefSceneResult, DecryptResult,
  WorkflowTemplateResponse, AsyncFlowResult, ProductConfigResult, SoPreBusiLimitResult,
  InstanceUserResult, StaticConfigResult, ProductDriveResult, BusinessInfoResult,
  UpRuleResult,
} from '@/lib/types'
import {
  Activity, CircleAlert, Copy, Layers, MessageSquareText, Search,
} from 'lucide-react'

const FAMILY_CENTER_CODE = 'family_order'
const PRODUCT_CENTER_CODE = 'product_center'
const INSTANCE_CENTER_CODE = 'instance_center'
const PRODUCT_DRIVE_CENTER_CODE = 'product_drive_center'
const WORKFLOW_SCENE = { scene_code: 'workflow_info', scene_name: '工作流信息', render_mode: 'workflow' }
/** 客户订单中心专用：结构化订单信息（17 张 HALL_ORD_* 表） */
const STRUCTURED_SCENE = { scene_code: 'structured_order', scene_name: '结构化订单信息', render_mode: 'structured' }
/** 家庭订单中心专用：异步流程 */
const ASYNC_FLOW_SCENE = { scene_code: 'async_flow', scene_name: '异步流程', render_mode: 'async_flow' }
/** 家庭业务中心专用：产品驱动（角色/策划/产品/终端 四类，待接入真实 SQL） */
const PRODUCT_DRIVE_SCENE = { scene_code: 'product_drive', scene_name: '产品驱动', render_mode: 'product_drive' }
const PRODUCT_DRIVE_CATEGORIES: [string, string][] = [['role', '角色'], ['plan', '策划'], ['product', '产品'], ['terminal', '终端']]
/** 实例中心专用：用户信息（so570{city}.ins_user_{city}，营业库） */
const INSTANCE_USER_SCENE = { scene_code: 'user_info', scene_name: '用户信息', render_mode: 'instance_user' }
/** 实例中心专用：订购信息（占位表名，待接真实 SQL） */
const INSTANCE_ORDER_SCENE = { scene_code: 'instance_order', scene_name: '订购信息', render_mode: 'instance_order' }
/** 产品中心专用：档次配置（up_product_item/特性/关系）+ 策划配置（up_plan），产品库 */
const PRODUCT_CONFIG_SCENE = { scene_code: 'product_config', scene_name: '档次配置', render_mode: 'product_config' }
const PLAN_CONFIG_SCENE = { scene_code: 'plan_config', scene_name: '策划配置', render_mode: 'plan_config' }
/** DEF_RULE.RULE_TYPE 枚举 → 中文含义（7/8/9 按业务口径；27/28 为购物车多规则校验魔法值） */
const RULE_TYPE_NAMES: Record<string, string> = {
  '0': '订单查询·业务查询规则',
  '7': '规则',
  '8': '免填单',
  '9': '补全',
  '10': '营销案引流',
  '11': '进程超时自动操作',
  '12': '特殊沉淀工单',
  '13': '拆单沉淀业务信息',
  '17': '异步工单插入',
  '19': '异常匹配',
  '21': '实时调度规则校验',
  '27': '购物车多规则校验（拆单扩展）',
  '28': '购物车多规则校验（协议单）',
}

/** 调度订单 STATE 枚举 → 中文含义 */
const SCHEDULER_STATE_NAMES: Record<string, string> = {
  '0': '初始化（待调度）',
  '1': '过程中（已下发工作流，处理中）',
  '2': '已完成（竣工）',
  '4': '正在执行定单撤单',
  '5': '挂起',
  '6': '处理异常（可恢复:6→1）',
  '7': '失效（未调度即作废:0→7）',
  '8': '已完成定单撤单（竣工后撤单）',
  '10': '撤单过程中发生异常（可恢复:10→4）',
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
  const stats: Record<string, number> = { 用户: 0, 客户: 0, 策划: 0, 终端: 0 }
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
    return <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
  }
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 z-[1] bg-[#20202c]">
          <tr>
            {renderActions && (
              <th className="sticky left-0 z-[2] whitespace-nowrap border-b border-[#3d3d4a] bg-[#20202c] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">操作</th>
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
            {title}
          </span>
        ) : (
          <span className="text-[12px] font-medium text-[#e4e4e9]">{title}</span>
        )}
        {table && <span className="font-mono text-[10px] text-[#5a5a70]">{table}</span>}
        {datasource && <span className="font-mono text-[10px] text-[#4a6a8a]">@{datasource}</span>}
        {rowCount !== undefined && (
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[#8b8b9e]">{rowCount} 条</span>
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
  { key: 'SEND_TO_IMEP', label: '送 IMEP 报文' },
  { key: 'IMEP_BACK', label: 'IMEP 回单报文' },
  { key: 'SEND_TO_IRMS', label: '送资管报文' },
  { key: 'IRMS_BACK', label: '资管回单报文' },
  { key: 'billing', label: '计费报文' },
  { key: 'stage', label: '阶段性回复' },
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
        {expanded ? '收起' : `查看全文 (${text.length} 字符)`}
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
      setError(response.error || '报文查询失败')
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
            <MessageSquareText className="h-4 w-4 text-indigo-400" />报文查询
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2 text-[11px] text-[#8b8b9e]">
          <label className="space-y-1">
            <span>类型</span>
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
              <span>任务ID</span>
              <Input className={cn(fieldClass, 'w-44')} value={taskId} onChange={e => setTaskId(e.target.value)} />
            </label>
          )}
          {kind !== 'stage' && (
            <label className="space-y-1">
              <span>日期(YYYYMMDD)</span>
              <Input className={cn(fieldClass, 'w-32')} placeholder="默认当天" value={doneDate} onChange={e => setDoneDate(e.target.value)} />
            </label>
          )}
          {kind === 'billing' && (
            <>
              <label className="space-y-1">
                <span>客户订单ID</span>
                <Input className={cn(fieldClass, 'w-44')} value={custOrderId} onChange={e => setCustOrderId(e.target.value)} />
              </label>
              <label className="space-y-1">
                <span>调度订单ID</span>
                <Input className={cn(fieldClass, 'w-44')} value={keyEleId} onChange={e => setKeyEleId(e.target.value)} />
              </label>
            </>
          )}
          <Button size="sm" className="h-7" disabled={loading} onClick={() => void run()}>
            <Search className="mr-1 h-3 w-3" />{loading ? '查询中' : '查询'}
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
                检测到加密报文，正在解密…
              </div>
            )}
            {result.success ? (
              <div className="max-h-[46vh] overflow-auto rounded-md border border-[#252530]">
                {(decryptedRows ?? result.rows).length === 0 ? (
                  <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
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
                                  <CopyButton text={cell} label="复制报文" />
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
                {result.error || '查询失败'}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 客户订单下单报文：hall_cust_dtl 各行 CUST_DTL_INFO_A~P 拼接，JSON 报文提取 originalData/transformedData */
/** 复制按钮：clipboard API 优先，失败回退 execCommand（iframe 环境） */
function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
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
      <Copy className="h-3 w-3" />{copied ? '已复制' : label}
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
        if (!response.data.success) setError(response.data.error || '报文查询失败')
      } else {
        setError(response.error || '报文查询失败')
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
            sceneId: String(record.sceneId ?? record.scene_id ?? '未知'),
            data: record.data ?? item,
          }
        }
        return { sceneId: '未知', data: item }
      })
    }
    return raw != null ? [{ sceneId: '未知', data: raw }] : []
  }, [result])

  const currentText = useMemo(() => {
    if (!result?.success) return ''
    if (tab === 'full') return prettyContent(result.message) || '（空）'
    if (tab === 'original') {
      return result.original_data != null ? prettyJson(result.original_data) : '未找到原始报文数据'
    }
    const item = transformedList[sceneIdx]
    if (item) return prettyJson(item.data)
    return transformedList.length > 0 ? '请选择 sceneId' : '未找到转换后报文数据'
  }, [result, tab, sceneIdx, transformedList])

  const copyable = !!currentText && !currentText.startsWith('未找到')
    && currentText !== '（空）' && currentText !== '请选择 sceneId'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <MessageSquareText className="h-4 w-4 text-indigo-400" />
            下单报文 · {custOrderId}
          </DialogTitle>
        </DialogHeader>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && (
          <div className="space-y-2" data-customer-message-result>
            <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-[#5a5a70]">
              <span className="truncate" title={result.sql}>{result.sql}</span>
              <span className="shrink-0">{result.table_name} · {result.row_count} 行</span>
            </div>
            {result.success && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {([['full', '完整报文'], ['original', '原始报文'], ['transformed', '转换后报文']] as const)
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
                      <option value={-1}>请选择 sceneId</option>
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
          {!loading && copyable && <CopyButton text={currentText} label="复制报文" />}
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
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
        if (!response.data.success) setError(response.data.error || '受理报文查询失败')
      } else {
        setError(response.error || '受理报文查询失败')
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
            受理报文 · 流程实例 {taskFlowInsId}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-4 text-[11px] text-[#8b8b9e]">
          <span>客户订单ID <span className="font-mono text-[#cdd3e0]">{custOrderId}</span></span>
          <span>流程实例ID <span className="font-mono text-[#cdd3e0]">{taskFlowInsId}</span></span>
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-accept-message-result>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            {records.length === 0 && (
              <div className="rounded-md border border-[#252530] px-3 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
            )}
            {records.map((record, index) => (
              <div key={index} className="min-w-0 space-y-2 rounded-md border border-[#252530] bg-[#12121a] p-2.5">
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#8b8b9e]">
                  <span>时间 <span className="font-mono text-[#cdd3e0]">{record.createDate || '—'}</span></span>
                  <span>调用接口 <span className="font-mono text-[#cdd3e0]">{record.callInterface || '—'}</span></span>
                </div>
                {([['请求报文', record.reqMessage], ['响应报文', record.respMessage]] as const).map(([title, text]) => (
                  <div key={title}>
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-[#8b8b9e]">
                      <span>{title}（{text.length} 字符）</span>
                      {text ? <CopyButton text={text} /> : null}
                    </div>
                    <pre className="min-w-0 max-h-[24vh] w-full overflow-auto break-all whitespace-pre-wrap rounded border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#cdd3e0]">
                      {prettyContent(text) || '（空）'}
                    </pre>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
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
  const [result, setResult] = useState<BusiCmptResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !busiCmptId.trim()) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    api.getBusiCmpt({ busi_cmpt_id: busiCmptId.trim() }).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.success) setError(response.data.error || '业务组件查询失败')
      } else {
        setError(response.error || '业务组件查询失败')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, busiCmptId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-cyan-400" />
            业务组件 · {busiCmptId}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          数据源 <span className="font-mono text-[#cdd3e0]">客户订单配置库</span>
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-busi-cmpt-result>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            <div className="max-h-[52vh] overflow-auto rounded-md border border-[#252530]">
              {result.rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
              ) : (
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 bg-[#20202c]">
                    <tr>
                      {result.columns.map((column: string) => (
                        <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row: string[], index: number) => (
                      <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                        {row.map((cell: string, cellIndex: number) => (
                          <td key={cellIndex} className="max-w-[420px] break-all px-2.5 py-1.5 text-[#cdd3e0]">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [result, setResult] = useState<SoPreBusiLimitResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !limitCode.trim()) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    api.getSoPreBusiLimit({ limit_code: limitCode.trim() }).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.success) setError(response.data.error || '业务限制查询失败')
      } else {
        setError(response.error || '业务限制查询失败')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, limitCode])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-amber-400" />
            业务限制 · {limitCode}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          数据源 <span className="font-mono text-[#cdd3e0]">规则配置库</span>
          <span className="ml-2 font-mono text-[10px] text-[#5a5a70]">rule_Cfg.SO_PRE_BUSI_LIMIT</span>
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-so-pre-busi-limit-result>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            <div className="max-h-[52vh] overflow-auto rounded-md border border-[#252530]">
              {result.rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
              ) : (
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 bg-[#20202c]">
                    <tr>
                      {result.columns.map((column: string) => (
                        <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row: string[], index: number) => (
                      <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                        {row.map((cell: string, cellIndex: number) => (
                          <td key={cellIndex} className="max-w-[420px] break-all px-2.5 py-1.5 text-[#cdd3e0]">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [result, setResult] = useState<UpRuleResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !ruleId.trim()) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    api.getUpRule({ rule_id: ruleId.trim() }).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.success) setError(response.data.error || '框架规则定义查询失败')
      } else {
        setError(response.error || '框架规则定义查询失败')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, ruleId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-emerald-400" />
            规则定义 · {ruleId}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          数据源 <span className="font-mono text-[#cdd3e0]">家庭业务配置库</span>
          <span className="ml-2 font-mono text-[10px] text-[#5a5a70]">busicfg.UP_RULE</span>
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-up-rule-result>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            <div className="max-h-[52vh] overflow-auto rounded-md border border-[#252530]">
              {result.rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
              ) : (
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 bg-[#20202c]">
                    <tr>
                      {result.columns.map((column: string) => (
                        <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row: string[], index: number) => (
                      <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                        {row.map((cell: string, cellIndex: number) => (
                          <td key={cellIndex} className="max-w-[420px] break-all px-2.5 py-1.5 text-[#cdd3e0]">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [result, setResult] = useState<BusinessInfoResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !businessId.trim()) return
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    api.getBusinessInfo({ business_id: businessId.trim() }).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.success) setError(response.data.error || '业务信息查询失败')
      } else {
        setError(response.error || '业务信息查询失败')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, businessId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-cyan-400" />
            业务信息 · {businessId}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          数据源 <span className="font-mono text-[#cdd3e0]">产品库</span>
          <span className="ml-2 font-mono text-[10px] text-[#5a5a70]">product.up_business</span>
        </div>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        )}
        {!loading && result && !error && (
          <div className="space-y-2" data-business-info-result>
            <div className="truncate font-mono text-[10px] text-[#5a5a70]" title={result.sql}>{result.sql}</div>
            <div className="max-h-[52vh] overflow-auto rounded-md border border-[#252530]">
              {result.rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
              ) : (
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 bg-[#20202c]">
                    <tr>
                      {result.columns.map((column: string) => (
                        <th key={column} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row: string[], index: number) => (
                      <tr key={index} className="border-b border-[#1d1d26] align-top hover:bg-white/[0.03]">
                        {row.map((cell: string, cellIndex: number) => (
                          <td key={cellIndex} className="max-w-[420px] break-all px-2.5 py-1.5 text-[#cdd3e0]">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 字段解密结果展示：明文 + 原始响应 + 密文信封对照（纯展示，解密由调用方完成后传入） */
function DecryptDialog({
  open, onOpenChange, envelopeText, result, loading,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  envelopeText: string
  result: DecryptResult | null
  loading: boolean
}) {
  const [showCipher, setShowCipher] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <CircleAlert className="h-4 w-4 text-emerald-400" />
            字段解密 · SM4
          </DialogTitle>
        </DialogHeader>
        {loading && <div className="py-6 text-center text-[12px] text-[#8b8b9e]">解密中…</div>}
        {!loading && result && !result.ok && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{result.error || '解密失败'}</div>
        )}
        {!loading && result?.ok && (
          <div className="space-y-2" data-decrypt-result>
            <div className="mb-1 flex items-center justify-between text-[11px] text-[#8b8b9e]">
              <span>明文（{result.plain.length} 字符）</span>
              <CopyButton text={result.plain} label="复制明文" />
            </div>
            <pre className="max-h-[34vh] overflow-auto break-all whitespace-pre-wrap rounded-md border border-emerald-500/30 bg-[#0b0f0c] p-2 font-mono text-[11px] text-emerald-200">
              {prettyContent(result.plain) || '（空）'}
            </pre>
          </div>
        )}
        {!loading && result && !result.ok && result.raw != null && (
          <div>
            <div className="mb-1 text-[11px] text-[#8b8b9e]">解密服务原始响应</div>
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
            {showCipher ? '收起密文' : '查看原始密文信封'}
          </button>
          {showCipher && (
            <pre className="mt-1 max-h-[20vh] overflow-auto break-all whitespace-pre-wrap rounded-md border border-[#252530] bg-[#0b0b10] p-2 font-mono text-[10px] text-[#8b8b9e]">
              {envelopeText}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
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
  const [result, setResult] = useState<ComponentQueryResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !cmptCfgId.trim()) return
    let cancelled = false
    setLoading(true)
    setResult(null)
    const sql = `SELECT * FROM occ_busi_cmpt WHERE cmpt_cfg_id = '${cmptCfgId.trim()}'`
    api.queryDatasource('家庭订单配置库', sql, 100).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setResult({ label: '业务组件', sql, ...response.data })
      } else {
        setResult({ label: '业务组件', sql, ok: false, columns: [], rows: [],
                   row_count: 0, message: response.error || '查询失败' })
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, cmptCfgId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="h-4 w-4 text-emerald-400" />
            业务组件 · {cmptCfgId}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          数据源 <span className="font-mono text-[#cdd3e0]">家庭订单配置库</span>
        </div>
        {loading && <div className="py-8 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
        {!loading && result && (
          <ResultCard title="业务组件（occ_busi_cmpt）" rowCount={result.row_count}>
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
              <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
            ) : (
              <div className="max-h-[420px] overflow-auto">
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
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="max-w-[360px] break-all px-2.5 py-1.5 text-[#cdd3e0]" title={cell}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ResultCard>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      { label: '场景（occ_busi_scene）', sql: `SELECT * FROM occ_busi_scene WHERE scene_cfg_id = '${sceneCfgId.trim()}'` },
      { label: '场景节点（occ_assets_cmpt_rel）', sql: `SELECT * FROM occ_assets_cmpt_rel WHERE scene_cfg_id = '${sceneCfgId.trim()}'` },
    ]
    Promise.all(queries.map(query =>
      api.queryDatasource('家庭订单配置库', query.sql, 100).then(response => {
        if (response.success && response.data) {
          return { label: query.label, sql: query.sql, ...response.data } as ComponentQueryResult
        }
        return { label: query.label, sql: query.sql, ok: false, columns: [], rows: [],
                 row_count: 0, message: response.error || '查询失败' } as ComponentQueryResult
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
            场景配置 · {sceneCfgId}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] text-[#8b8b9e]">
          数据源 <span className="font-mono text-[#cdd3e0]">家庭订单配置库</span>
        </div>
        {loading && <div className="py-8 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
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
              <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
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
                                  title="点击跳转工作流查询"
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
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 订单组件查询页签 */
const ORDER_COMPONENT_TABS: { key: string; label: string }[] = [
  { key: 'transform', label: '数据转换' },
  { key: 'rule', label: '规则适配' },
  { key: 'post_task', label: '后置任务' },
  { key: 'flow_template', label: '流程模版' },
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
      label: '接口适配器（occ_interface_adapter）',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_interface_adapter WHERE interface_code = '{interface_code}'",
    },
    {
      label: '业务组件（occ_busi_cmpt）',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_busi_cmpt WHERE cmpt_cfg_id IN "
           + "(SELECT cmpt_cfg_id FROM occ_interface_adapter WHERE interface_code = '{interface_code}')",
    },
  ],
  rule: [
    {
      label: '规则匹配关系（occ_rule_normal_match_rel）',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_RULE_CHECK' "
           + "AND prim_cond = '{business_id}' AND second_cond = '{interface_code}'",
    },
    {
      label: '业务组件（occ_busi_cmpt）',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_busi_cmpt WHERE cmpt_cfg_id IN "
           + "(SELECT target_id FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_RULE_CHECK' "
           + "AND prim_cond = '{business_id}' AND second_cond = '{interface_code}')",
    },
  ],
  post_task: [
    {
      label: '后置任务匹配（occ_rule_normal_match_rel）',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_ORDITEM_AFTERTASK' "
           + "AND prim_cond = '{business_id}'",
    },
  ],
  flow_template: [
    {
      label: '调度模版匹配（occ_rule_normal_match_rel）',
      datasource: '家庭订单配置库',
      sql: "SELECT * FROM occ_rule_normal_match_rel WHERE match_type = 'MATCH_SCHEDULE_TEMPL' "
           + "AND PRIM_COND = '{interface_code}'",
    },
    {
      label: '调度模版（occ_busi_schedule_template）',
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
      setError(`客户订单信息缺少字段值：${missing.join('、')}，无法查询（请先确认订单查询有结果）`)
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
                 row_count: 0, message: response.error || '查询失败' } as ComponentQueryResult
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
            订单组件 · {orderKey}
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
          {loading && <div className="py-8 text-center text-[12px] text-[#8b8b9e]">查询中…</div>}
          {!loading && !queries && (
            <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
              「{activeTab?.label}」查询配置中——SQL 待接入
            </div>
          )}
          {!loading && queries && results.length === 0 && (
            <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-6 text-center text-[12px] text-red-200">
              {error || '查询失败'}
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
                <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">暂无数据</div>
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
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>关闭</Button>
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
  driveCategory: string
  driveGradeNo: string
  driveOfferNo: string
  decryptedMap: Record<string, string>
}

let analysisSnapshot: Partial<AnalysisSnapshot> = {}

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
  const [liveNode, setLiveNode] = useState<AnalysisNodeResult | null>(
    analysisSnapshot.liveNode ?? null)
  const [selectedScheduler, setSelectedScheduler] = useState(
    analysisSnapshot.selectedScheduler ?? '')
  const [elapsed, setElapsed] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [messageTarget, setMessageTarget] = useState({
    taskId: '', doneDate: '', custOrderId: '', keyEleId: '',
  })
  const [messageOpen, setMessageOpen] = useState(false)
  const [custMsgOpen, setCustMsgOpen] = useState(false)
  const [custMsgOrderId, setCustMsgOrderId] = useState('')
  const [acceptMsgOpen, setAcceptMsgOpen] = useState(false)
  const [acceptMsgTarget, setAcceptMsgTarget] = useState({ custOrderId: '', flowInsId: '' })
  const [defScene, setDefScene] = useState<{ sceneId: string; sceneName: string } | null>(analysisSnapshot.defScene ?? null)
  const [retryTarget, setRetryTarget] = useState<{ taskId: string; custOrderId: string } | null>(null)
  const [busiCmptOpen, setBusiCmptOpen] = useState(false)
  const [busiCmptId, setBusiCmptId] = useState('')
  // 产品中心·限制参数 limit_code 点击 → 业务限制弹窗（规则配置库）
  const [soPreBusiLimitOpen, setSoPreBusiLimitOpen] = useState(false)
  const [soPreBusiLimitCode, setSoPreBusiLimitCode] = useState('')
  // 产品中心·业务关系 relat_product_item_id 点击 → 业务信息弹窗（产品库）
  const [businessInfoOpen, setBusinessInfoOpen] = useState(false)
  const [businessInfoId, setBusinessInfoId] = useState('')
  // 家庭业务中心·框架规则 RULE_ID 点击 → 规则定义弹窗（家庭业务配置库）
  const [upRuleOpen, setUpRuleOpen] = useState(false)
  const [upRuleId, setUpRuleId] = useState('')
  const [decryptOpen, setDecryptOpen] = useState(false)
  // 家庭订单·客户订单信息右上角「组件」入口（数据转换/规则适配/订单项/后置任务/流程模版）
  const [componentsOpen, setComponentsOpen] = useState(false)
  // 家庭订单·调度订单 scene_cfg_id 点击 → 场景配置查询
  const [sceneCfgOpen, setSceneCfgOpen] = useState(false)
  // 家庭订单·工单 busi_cmp_id 点击 → occ_busi_cmpt 组件定义
  const [occCmptOpen, setOccCmptOpen] = useState(false)
  const [occCmptId, setOccCmptId] = useState('')
  const [sceneCfgId, setSceneCfgId] = useState('')
  const [decryptEnvelope, setDecryptEnvelope] = useState('')
  const [decryptResult, setDecryptResult] = useState<DecryptResult | null>(null)
  const [decryptLoading, setDecryptLoading] = useState(false)
  // 已解密的密文信封 → 明文（表格中原位替换展示）
  const [decryptedMap, setDecryptedMap] = useState<Record<string, string>>(analysisSnapshot.decryptedMap ?? {})
  const decryptedMapRef = useRef<Record<string, string>>(analysisSnapshot.decryptedMap ?? {})
  // 产品中心跳转记忆：档次配置 → 策划配置 携带关联编号前的产品编号，切回时还原
  const productKeyMemoRef = useRef('')

  function mergeDecrypted(entries: Record<string, string>) {
    decryptedMapRef.current = { ...decryptedMapRef.current, ...entries }
    setDecryptedMap(decryptedMapRef.current)
  }

  /** 点击 attr_value：已解密 → 直接查看；密文 → 调密码服务解密并替换原值 */
  async function handleDecryptClick(value: string) {
    const cached = decryptedMap[value]
    if (cached !== undefined) {
      setDecryptEnvelope(value)
      setDecryptResult({ ok: true, plain: cached, raw: null, error: '' })
      setDecryptLoading(false)
      setDecryptOpen(true)
      return
    }
    let envelope: { policy: string; cipher: string }
    const text = value.trim()
    try {
      envelope = JSON.parse(text)
    } catch {
      // 库里存的是裸密文（如 0yOIb1|9RR7...），客户端补装信封
      if (!text.includes('{') && text.includes('|')) {
        envelope = { policy: 'SM4', cipher: text }
      } else {
        setDecryptEnvelope(value)
        setDecryptResult({ ok: false, plain: '', raw: null, error: '密文格式无法识别：既不是信封 JSON 也不是裸密文' })
        setDecryptLoading(false)
        setDecryptOpen(true)
        return
      }
    }
    setDecryptEnvelope(value)
    setDecryptResult(null)
    setDecryptLoading(true)
    setDecryptOpen(true)
    const response = await api.decryptValue(envelope)
    setDecryptLoading(false)
    if (response.success && response.data?.ok) {
      setDecryptResult(response.data)
      // 解密成功：原位替换表格中的密文
      const plain = response.data.plain
      mergeDecrypted({ [value]: plain })
    } else if (response.data) {
      setDecryptResult(response.data)
    } else {
      setDecryptResult({ ok: false, plain: '', raw: null, error: response.error || '解密失败' })
    }
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
    const response = await api.decryptValues({ ciphers: pending })
    if (response.success && response.data?.results) {
      const entries: Record<string, string> = {}
      response.data.results.forEach((item, index) => {
        if (item.ok) entries[pending[index]] = item.plain
      })
      mergeDecrypted(entries)
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
      instanceOrderResult, liveNode,
      selectedScheduler, defScene, sceneCode, city,
      queryKind, configSceneId, sceneRules, configScene,
      familyTemplateTag, templateResult, familyConfigTab, staticConfigCode, staticConfigResult,
      productDriveResult, driveCategory, driveGradeNo, driveOfferNo,
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
            ? [INSTANCE_USER_SCENE, INSTANCE_ORDER_SCENE]
          : center.center_code === PRODUCT_CENTER_CODE
            ? [PRODUCT_CONFIG_SCENE, PLAN_CONFIG_SCENE]
            : center.center_code === FAMILY_CENTER_CODE
              ? [...center.scenes, WORKFLOW_SCENE, ASYNC_FLOW_SCENE]
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
      instanceUserResult, instanceOrderResult, liveNode,
      selectedScheduler, defScene, queryKind, configSceneId, sceneRules,
      configScene, familyTemplateTag, templateResult, familyConfigTab,
      staticConfigCode, staticConfigResult, productDriveResult, driveCategory,
      driveGradeNo, driveOfferNo,
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
        setError(response.error || '未配置业务中心')
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
    if (nextScene !== PRODUCT_DRIVE_SCENE.scene_code && !keyValue) return
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
          setError(response.error || '工作流查询失败')
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
          setError(response.error || '异步流程查询失败')
        }
      } else if (nextScene === INSTANCE_USER_SCENE.scene_code) {
        const response = await api.getInstanceUser({ bill_id: keyValue })
        if (response.success && response.data) {
          setInstanceUserResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || '用户信息查询失败')
        }
      } else if (nextScene === PRODUCT_DRIVE_SCENE.scene_code) {
        const grade = driveGradeNo.trim()
        const offer = driveOfferNo.trim()
        if (!grade) {
          setError('请输入档次编号')
          setLoading(false)
          return
        }
        if (driveCategory !== 'role' && !offer) {
          setError('请输入策划编号')
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
          setError(response.error || '产品驱动查询失败')
        }
      } else if (nextScene === INSTANCE_ORDER_SCENE.scene_code) {
        const response = await api.getInstanceOrder({ bill_id: keyValue })
        if (response.success && response.data) {
          setInstanceOrderResult(response.data)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || '订购信息查询失败')
        }
      } else if (nextScene === PRODUCT_CONFIG_SCENE.scene_code) {
        const response = await api.getProductConfig({ product_item_id: keyValue })
        if (response.success && response.data) {
          setProductResult(response.data)
          setProductResultKey(keyValue)
          setElapsed(Math.round(performance.now() - started))
        } else {
          setError(response.error || '档次配置查询失败')
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
          setError(response.error || '策划配置查询失败')
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
          setError(response.error || '结构化订单查询失败')
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
          setError(response.error || '数据查询失败')
        }
      }
    } catch (exception) {
      // 请求异常/网络层失败也要给出提示并复位按钮，避免一直「查询中」
      setError(`请求失败: ${exception instanceof Error ? exception.message : String(exception)}`)
    } finally {
      setLoading(false)
    }
  }

  async function query() {
    if (isDriveScene) {
      const grade = driveGradeNo.trim()
      const offer = driveOfferNo.trim()
      if (!grade) {
        setError('请输入档次编号')
        return
      }
      if (driveCategory !== 'role' && !offer) {
        setError('请输入策划编号')
        return
      }
    } else if (!businessKey.trim()) {
      setError(isProductScene ? (sceneCode === PLAN_CONFIG_SCENE.scene_code ? '请输入产品/策划编号' : '请输入档次编号') : isInstanceScene ? '请输入计费账号' : '请输入业务主键')
      return
    }
    // 产品中心两个结果不清空：按 productResultKey/planResultKey 判定缓存是否仍有效，
    // 编号变了对应 tab 切换时会自动重查；跳转往返（档次↔策划）不丢数据不重查
    setSceneCache({})
    setProductDriveResult(null)
    setWorkflowResult(null)
    setAsyncFlowResult(null)
    setStructuredResult(null)
    setInstanceUserResult(null)
    setInstanceOrderResult(null)
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
      setError('请输入模板编码')
      return
    }
    setLoading(true)
    setError('')
    const started = performance.now()
    const response = await api.getWorkflowTemplate(tag)
    if (response.success && response.data) {
      setTemplateResult(response.data)
      setElapsed(Math.round(performance.now() - started))
    } else {
      setError(response.error || '配置查询失败')
    }
    setLoading(false)
  }

  /** 家庭订单中心配置查询·静态配置：按编码查 bs_para_detail + bs_static_data */
  async function queryStaticConfig() {
    const code = staticConfigCode.trim()
    if (!code) {
      setError('请输入配置编码')
      return
    }
    setLoading(true)
    setError('')
    const started = performance.now()
    const response = await api.getStaticConfig({ code })
    if (response.success && response.data) {
      setStaticConfigResult(response.data)
      setElapsed(Math.round(performance.now() - started))
    } else {
      setError(response.error || '静态配置查询失败')
    }
    setLoading(false)
  }

  /** 配置查询：按场景ID查 场景定义(DEF_SCENE) + 规则定义(DEF_RULE) + 业务组件(DEF_BUSI_CMPT) */
  async function queryConfig(sceneIdOverride?: string) {
    const sceneId = (sceneIdOverride ?? configSceneId).trim()
    if (!sceneId) {
      setError('请输入场景ID')
      return
    }
    setLoading(true)
    setError('')
    setConfigScene(null)
    const started = performance.now()
    const [rulesResponse, sceneResponse] = await Promise.all([
      api.getSceneRules({ scene_id: sceneId }),
      api.getDefScene({ scene_id: sceneId }),
    ])
    if (rulesResponse.success && rulesResponse.data) {
      setSceneRules(rulesResponse.data)
      setElapsed(Math.round(performance.now() - started))
    } else {
      setError(rulesResponse.error || '配置查询失败')
    }
    if (sceneResponse.success && sceneResponse.data?.success) {
      setConfigScene(sceneResponse.data)
    }
    setLoading(false)
  }

  /** 策划配置「关联产品」点击产品编号：下钻查询属性信息（up_item_relat 资费服务关系） */
  async function queryItemRelat(value: string) {
    setError('')
    const response = await api.getItemRelat({ product_item_id: value })
    if (response.success && response.data) {
      setItemRelatResult(response.data)
    } else {
      setError(response.error || '属性信息查询失败')
    }
  }

  /** 策划配置「前项限制」点击 rule_exp（形如 TP1(300937)）：拆分查限制参数 */
  async function queryPreLmtParam(value: string) {
    const match = /^(\w+)\((\d+)\)$/.exec(value.trim())
    if (!match) {
      setError(`rule_exp 格式无法解析: ${value}（期望形如 TP1(300937)）`)
      return
    }
    setError('')
    const response = await api.getPreLmtParam({ limit_code: match[1], param_id: match[2] })
    if (response.success && response.data) {
      setPreLmtParam({ limitCode: match[1], paramId: match[2], result: response.data })
    } else {
      setError(response.error || '限制参数查询失败')
    }
  }

  async function queryLiveWorkOrder(schedulerId: string) {
    setSelectedScheduler(schedulerId)
    setLiveNode(null)
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
      setError(response.error || '工单实时查询失败')
    }
  }

  function openMessage(values: Record<string, string>, schedulerId: string) {
    setMessageTarget({
      taskId: values.task_id || '',
      doneDate: dateKey(values.done_date || values.create_date || ''),
      custOrderId: values.cust_order_id || businessKey.trim(),
      keyEleId: values.key_ele_id || values.scheduler_order_id || schedulerId,
    })
    setMessageOpen(true)
  }

  /** 客户订单行「报文」：按行内 CUST_ORDER_ID 查 hall_cust_dtl 下单报文 */
  const renderCustomerMessageAction = (values: Record<string, string>) => {
    if (!values.cust_order_id) return <span className="text-[10px] text-[#5a5a70]">—</span>
    return (
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
        onClick={() => {
          setCustMsgOrderId(values.cust_order_id)
          setCustMsgOpen(true)
        }}
      >
        <MessageSquareText className="h-3 w-3" />报文
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
          setAcceptMsgTarget({ custOrderId, flowInsId })
          setAcceptMsgOpen(true)
        }}
      >
        <MessageSquareText className="h-3 w-3" />受理报文
      </button>
    )
  }

  /** 工单行「重试」：task_type=5，HALL_TASK.TASK_STATE 与 HALL_TASK_FLOW_INS.handle_type 置 2（写操作，弹确认框） */
  async function executeRetry() {
    if (!retryTarget) return
    const { taskId, custOrderId } = retryTarget
    setRetryTarget(null)
    setError('')
    setNotice('')
    const response = await api.retryHallTask({ cust_order_id: custOrderId, task_id: taskId })
    if (response.success && response.data?.ok) {
      setNotice(`工单 ${taskId} 重试成功：${response.data.message}`)
      await loadScene(sceneCode)  // 刷新工单状态
    } else {
      setError(response.error || response.data?.message || '重试失败')
    }
  }

  const renderRetryAction = (values: Record<string, string>) => {
    if (String(values.task_type) !== '5') return <span className="text-[10px] text-[#5a5a70]">—</span>
    if (!values.task_id) return <span className="text-[10px] text-[#5a5a70]">—</span>
    return (
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-rose-500/40 bg-rose-500/10 px-1.5 text-[10px] text-rose-300 hover:bg-rose-500/20"
        onClick={() => {
          const custOrderId = values.cust_order_id || businessKey.trim()
          if (values.task_id && custOrderId) setRetryTarget({ taskId: values.task_id, custOrderId })
        }}
      >
        <Activity className="h-3 w-3" />重试
      </button>
    )
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
      <button
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
        onClick={() => openMessage(values, schedulerId)}
      >
        <MessageSquareText className="h-3 w-3" />报文
      </button>
    )
  }

  return (
    <div className="space-y-3" data-analysis-panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">数据查询</h2>
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
                  {item.center_name}
                </button>
              ))}
            </div>
          )}
          {(
            <div className="flex items-center gap-1 rounded-md border border-[#3a3a4a] bg-white/[0.03] p-0.5" data-query-kind-tabs>
              {([['order', '订单查询'], ['config', '配置查询']] as const).map(([kind, label]) => (
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
        {elapsed > 0 && <span className="text-[11px] text-[#5a5a70]">总耗时 {elapsed} ms</span>}
      </div>

      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        {queryKind === 'config' && centerCode === 'family_order' ? (
          <div className="flex flex-wrap items-end gap-3" data-config-form>
            {/* 配置查询子 tab：模板版本 / 静态配置 */}
            <div className="flex items-center gap-1 self-center rounded-md border border-[#3a3a4a] bg-white/[0.03] p-0.5" data-family-config-tabs>
              {([['template', '模板版本'], ['static', '静态配置']] as const).map(([tab, label]) => (
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
                  <span>配置编码</span>
                  <Input
                    className="h-8 w-[280px] bg-[#0f0f14] text-[12px]"
                    value={staticConfigCode}
                    onChange={event => setStaticConfigCode(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && void queryStaticConfig()}
                  />
                </label>
                <span className="text-[10px] text-[#5a5a70]">按编码查 bs_para_detail / bs_static_data（家庭订单配置库）</span>
                <Button size="sm" className="h-8" disabled={loading} onClick={() => void queryStaticConfig()}>
                  <Search className="mr-1 h-3.5 w-3.5" />
                  {loading ? `查询中 ${loadingSeconds}s` : '查询'}
                </Button>
              </>
            ) : (
              <>
                <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                  <span>模板编码</span>
                  <Input
                    className="h-8 w-[240px] bg-[#0f0f14] text-[12px]"
                    value={familyTemplateTag}
                    onChange={event => setFamilyTemplateTag(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && void queryFamilyTemplate()}
                  />
                </label>
                <span className="text-[10px] text-[#5a5a70]">按模板编码查版本（工作流配置库）</span>
                <Button size="sm" className="h-8" disabled={loading} onClick={() => void queryFamilyTemplate()}>
                  <Search className="mr-1 h-3.5 w-3.5" />
                  {loading ? `查询中 ${loadingSeconds}s` : '查询'}
                </Button>
              </>
            )}
          </div>
        ) : queryKind === 'config' && centerCode === 'hall_center' ? (
          <div className="flex flex-wrap items-end gap-3" data-config-form>
            <label className="space-y-1 text-[11px] text-[#8b8b9e]">
              <span>场景ID</span>
              <Input
                className="h-8 w-[200px] bg-[#0f0f14] text-[12px]"
                value={configSceneId}
                onChange={event => setConfigSceneId(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void queryConfig()}
              />
            </label>
            <span className="text-[10px] text-[#5a5a70]">按场景ID查 场景定义 + 规则定义 + 场景单元关系（客户订单配置库）</span>
            <Button size="sm" className="h-8" disabled={loading} onClick={() => void queryConfig()}>
              <Search className="mr-1 h-3.5 w-3.5" />
              {loading ? `查询中 ${loadingSeconds}s` : '查询'}
            </Button>
          </div>
        ) : (
        <div className="flex flex-wrap items-end gap-3">
          {isDriveScene ? (
            <>
              <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                <span>档次编号</span>
                <Input
                  className="h-8 w-[220px] bg-[#0f0f14] text-[12px]"
                  value={driveGradeNo}
                  onChange={event => setDriveGradeNo(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && void query()}
                />
              </label>
              <label className="space-y-1 text-[11px] text-[#8b8b9e]">
                <span>策划编号</span>
                <Input
                  className="h-8 w-[220px] bg-[#0f0f14] text-[12px]"
                  value={driveOfferNo}
                  onChange={event => setDriveOfferNo(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && void query()}
                />
              </label>
            </>
          ) : (
            <label className="space-y-1 text-[11px] text-[#8b8b9e]">
              <span>{isProductScene ? (sceneCode === PLAN_CONFIG_SCENE.scene_code ? '产品/策划编号' : '档次编号') : isInstanceScene ? '计费账号' : '业务主键'}</span>
              <Input
                className="h-8 w-[280px] bg-[#0f0f14] text-[12px]"
                value={businessKey}
                onChange={event => setBusinessKey(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void query()}
              />
            </label>
          )}
          {!(isProductScene || isInstanceScene || isDriveScene) && (
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>地市</span>
            <Input
              className="h-8 w-[72px] bg-[#0f0f14] text-[12px]"
              value={city}
              onChange={event => setCity(event.target.value)}
            />
          </label>
          )}
          {!(isProductScene || isInstanceScene || isDriveScene) && (
          <div className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>数据类型</span>
            <div className="flex h-8 items-center overflow-hidden rounded-md border border-[#252530]" data-transit-toggle>
              <button
                className={cn('h-8 px-3 text-[11px]', inTransit ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5')}
                onClick={() => setInTransit(true)}
              >
                在途
              </button>
              <button
                className={cn('h-8 px-3 text-[11px]', !inTransit ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5')}
                onClick={() => setInTransit(false)}
              >
                历史
              </button>
            </div>
          </div>
          )}
          {!(isProductScene || isInstanceScene || isDriveScene) && !inTransit && (
            <label className="space-y-1 text-[11px] text-[#8b8b9e]">
              <span>历史月份</span>
              <Input
                type="month"
                className="h-8 w-[140px] bg-[#0f0f14] text-[12px]"
                value={historyMonth}
                onChange={event => setHistoryMonth(event.target.value)}
              />
            </label>
          )}
          <Button size="sm" className="h-8" disabled={loading} onClick={() => void query()}>
            <Search className="mr-1 h-3.5 w-3.5" />
            {loading ? `查询中 ${loadingSeconds}s` : '查询'}
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
          「{center?.center_name}」查询配置中——场景/SQL 待接入（查询条件：业务主键 {businessKey.trim() || '—'}）
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
                  setSceneCode(scene.scene_code)
                  // 产品中心结果按查询时的编号缓存：编号一致直接展示，不一致才重查
                  const cached = scene.scene_code === WORKFLOW_SCENE.scene_code
                    ? workflowResult
                    : scene.scene_code === ASYNC_FLOW_SCENE.scene_code
                      ? asyncFlowResult
                      : scene.scene_code === STRUCTURED_SCENE.scene_code
                        ? structuredResult
                        : scene.scene_code === INSTANCE_USER_SCENE.scene_code
                          ? instanceUserResult
                        : scene.scene_code === PRODUCT_DRIVE_SCENE.scene_code
                          ? productDriveResult
                        : scene.scene_code === INSTANCE_ORDER_SCENE.scene_code
                          ? instanceOrderResult
                        : scene.scene_code === PRODUCT_CONFIG_SCENE.scene_code
                          ? (productResult && productResultKey === effectiveKey ? productResult : null)
                          : scene.scene_code === PLAN_CONFIG_SCENE.scene_code
                            ? (planResult && planResultKey === effectiveKey ? planResult : null)
                            : sceneCache[scene.scene_code]
                  // 已有数据直接展示（点「查询」按钮才刷新），切 tab 不清空/不重查
                  if (!cached) void loadScene(scene.scene_code, effectiveKey)
                }}
              >
                {scene.scene_name}
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
                    datasource="家庭订单配置库"
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
                    输入配置编码后查询静态配置（bs_para_detail / bs_static_data，家庭订单配置库）
                  </div>
                )
              ) : templateResult ? (
                <ResultCard
                  title="工作流模板版本"
                  table="vm_template_version"
                  datasource="工作流配置库"
                  rowCount={templateResult.versions.length}
                >
                  {templateResult.versions.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[12px] text-[#8b8b9e]">该模板编码无版本记录</div>
                  ) : (
                    <div className="max-h-[420px] overflow-auto">
                      <table className="w-full border-collapse text-left text-[11px]">
                        <thead className="sticky top-0 z-[1] bg-[#20202c]">
                          <tr>
                            {['版本ID', '模板编码', '序号', '创建人', '创建时间', '生效日期', '失效日期', '状态', '修改说明'].map(title => (
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
                                  {version.is_expired ? '已失效' : '生效中'}
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
                  输入模板编码后查询工作流模板版本（数据源：工作流配置库）
                </div>
              )}
            </div>
          ) : queryKind === 'config' && centerCode === 'hall_center' ? (
            <div className="space-y-3" data-config-results>
              {configScene && (
                <NodeCard
                  result={{
                    node_code: 'def_scene',
                    node_name: '场景定义',
                    table_name: 'DEF_SCENE',
                    datasource_name: '客户订单配置库',
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
                    datasource_name: '客户订单配置库',
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
                        setBusiCmptId(value)
                        setBusiCmptOpen(true)
                      }}
                    />
                  )}
                />
                )
              })() : null}
              {sceneRules?.unit_rel ? (
                <NodeCard
                  hint="点击 BUSI_CMPT_ID 查看业务组件"
                  result={{
                    node_code: 'scene_unit_rel',
                    node_name: sceneRules.unit_rel.node_name,
                    table_name: sceneRules.unit_rel.sql?.match(/FROM (\S+)/)?.[1] ?? '',
                    datasource_name: '客户订单配置库',
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
                        setBusiCmptId(value)
                        setBusiCmptOpen(true)
                      }}
                    />
                  )}
                />
              ) : null}
              {!sceneRules && !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  输入场景ID 后查询（数据源：客户订单配置库）
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
                  hint={block.name === '框架规则' ? '点击 RULE_ID 查看规则定义' : undefined}
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
                        setUpRuleId(value)
                        setUpRuleOpen(true)
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  {`查询产品驱动·${PRODUCT_DRIVE_CATEGORIES.find(([code]) => code === driveCategory)?.[1] ?? ''}（待接入，表名/条件确认中）`}
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
                  datasource="营业库"
                  hint={block.name === '用户信息' ? 'cust_type=1 自动查个人客户，family_cust_id 非空自动查家庭客户' : undefined}
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
                  输入计费账号后查询用户信息（ins_user / cm_indiv_customer / cm_family_customer，营业库）
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
                  datasource="营业库"
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
                  输入计费账号后查询订购信息（营业库）
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
                  datasource="产品库"
                  hint={block.name === '产品关系' ? '点击 关联产品编号 跳转策划配置查询'
                    : block.name === '业务关系' ? '点击 relat_product_item_id 查看业务信息' : undefined}
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
                        setBusinessInfoId(value)
                        setBusinessInfoOpen(true)
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  输入档次编号后查询档次配置（先校验 up_offer.offer_type = OFFER_VAS_BIND，非档次报错；产品库）
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
                  datasource="产品库"
                  hint={block.name === '关联产品' ? '点击 关联产品编号 查询属性信息'
                    : block.name === '前项限制' ? '点击 rule_exp 查询限制参数'
                    : block.name === '业务关系' ? '点击 relat_product_item_id 查看业务信息' : undefined}
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
                        setBusinessInfoId(value)
                        setBusinessInfoOpen(true)
                      }}
                    />
                  ) : (
                    <QueryResultTable columns={block.columns} rows={block.rows} />
                  )}
                </ResultCard>
              )) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  输入产品/策划编号后查询策划配置（up_product_item / up_item_feature / UP_OFFER_PRE_LIMIT / up_plan_prod_rel，产品库）
                </div>
              )}
              {itemRelatResult && (
                <div className="space-y-3" data-item-relat-results>
                  <div className="flex items-center gap-2 px-1 text-[11px] text-[#8b8b9e]">
                    <Layers className="h-3.5 w-3.5 text-purple-300" />
                    <span>属性信息 · 产品编号 <span className="font-mono text-[#cdd3e0]">{itemRelatResult.product_item_id}</span></span>
                    <button
                      className="ml-auto text-[10px] text-[#5a5a70] hover:text-[#cdd3e0]"
                      onClick={() => setItemRelatResult(null)}
                    >收起</button>
                  </div>
                  {itemRelatResult.results.map(block => (
                    <ResultCard
                      key={block.name}
                      title={block.name}
                      rowCount={block.row_count}
                      table={block.table_name}
                      datasource="产品库"
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
                    <span>限制参数 · <span className="font-mono text-[#cdd3e0]">{preLmtParam.limitCode}({preLmtParam.paramId})</span></span>
                    <button
                      className="ml-auto text-[10px] text-[#5a5a70] hover:text-[#cdd3e0]"
                      onClick={() => setPreLmtParam(null)}
                    >收起</button>
                  </div>
                  {preLmtParam.result.results.map(block => (
                    <ResultCard
                      key={block.name}
                      title={block.name}
                      rowCount={block.row_count}
                      table={block.table_name}
                      datasource="产品库"
                      hint={block.name === '限制参数' ? '点击 limit_code 查看业务限制' : undefined}
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
                            setSoPreBusiLimitCode(value)
                            setSoPreBusiLimitOpen(true)
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
          ) : sceneCode === ASYNC_FLOW_SCENE.scene_code ? (
            <div className="space-y-3" data-async-flow-results>
              {asyncFlowResult ? (
                <NodeCard
                  result={{
                    node_code: 'async_flow',
                    node_name: '异步流程',
                    table_name: asyncFlowResult.table_name,
                    datasource_name: '家庭订单库',
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
                    ? '在途无记录，已自动回退历史表'
                    : asyncFlowResult.row_count === 0 && (asyncFlowResult.checked_tables?.length ?? 0) > 1
                      ? `在途及近${(asyncFlowResult.checked_tables?.length ?? 1) - 1}个月历史表均无记录`
                      : undefined}
                />
              ) : !loading && (
                <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
                  输入家庭订单号后查询异步流程（ord_async_method_deal_task_order，处理完成移历史后自动回退查历史表）
                </div>
              )}
            </div>
          ) : sceneCode === WORKFLOW_SCENE.scene_code ? (
            <div className="space-y-3" data-workflow-results>
              {workflowResult ? workflowResult.results.map((block: AnalysisQueryBlock) => (
                <ResultCard
                  key={block.name}
                  title={block.name}
                  rowCount={block.row_count}
                  table={block.sql?.match(/FROM (\S+)/)?.[1]}
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
                  输入业务主键后查询；RBoss 调度订单ID 自动取自「订单信息」结果
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
                    datasource_name: '客户订单库',
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
                  输入业务主键后查询结构化订单信息（17 张 HALL_ORD_* 表并行）
                </div>
              )}
            </div>
          ) : sceneResult ? (
            <div className="space-y-3" data-scene-results>
              {centerCode === 'hall_center' && defScene && (
                <div className="flex items-center gap-2.5 rounded-lg border border-amber-400/60 bg-amber-400/15 px-3.5 py-2 shadow-[0_0_12px_rgba(251,191,36,0.15)]"
                  data-def-scene-badge>
                  <Layers className="h-4 w-4 shrink-0 text-amber-300" />
                  <span className="text-[11px] text-amber-200/80">场景</span>
                  <span className="text-[14px] font-bold text-amber-300">{defScene.sceneName || '（未取到场景名）'}</span>
                  {/* 点击场景编号 → 跳转配置查询并自动带入该场景ID */}
                  <button
                    className="ml-auto shrink-0 rounded border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-200 hover:bg-amber-300/20 hover:text-amber-100"
                    title="点击跳转配置查询"
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
                      hint={node.node_code === 'scheduler_order' ? '点击行实时查询工单' : undefined}
                      action={node.node_code === 'cust_order' && centerCode === 'family_order' ? (
                        <button
                          className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-indigo-500/40 bg-indigo-500/10 px-2 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
                          disabled={!businessKey.trim()}
                          onClick={() => setComponentsOpen(true)}
                        >
                          <Layers className="h-3 w-3" />组件
                        </button>
                      ) : undefined}
                      headerExtra={stats ? (
                        <div className="flex items-center gap-1.5 border-b border-[#252530] px-3 py-1.5 text-[10px] text-[#8b8b9e]">
                          订单项统计：
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
                          renderActions={renderRetryAction}
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
                              setBusiCmptId(value)
                              setBusiCmptOpen(true)
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
                            setSceneCfgId(value)
                            setSceneCfgOpen(true)
                          }}
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
                    result={liveNode ? { ...liveNode, node_name: `${liveNode.node_name} · 实时` } : work}
                    hint={liveNode ? `调度订单 ${selectedScheduler}` : undefined}
                    tableOverride={(
                      <QueryResultTable
                        columns={work.columns}
                        rows={work.rows}
                        renderActions={renderMessageAction(liveNode ? selectedScheduler : '')}
                        clickableColumns={['busi_cmp_id']}
                        onCellClick={(_, value) => {
                          setOccCmptId(value)
                          setOccCmptOpen(true)
                        }}
                      />
                    )}
                  />
                )
              })()}
            </div>
          ) : !loading && (
            <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
              请输入业务主键后查询
            </div>
          )}
        </>
      )}

      <MessageDialog
        key={messageOpen ? 'open' : 'closed'}
        open={messageOpen}
        onOpenChange={setMessageOpen}
        target={messageTarget}
        context={{ city, inTransit, historyMonth }}
      />

      <CustomerOrderMessageDialog
        open={custMsgOpen}
        onOpenChange={setCustMsgOpen}
        custOrderId={custMsgOrderId}
        city={city}
        inTransit={inTransit}
        historyMonth={historyMonth}
      />

      <AcceptMessageDialog
        open={acceptMsgOpen}
        onOpenChange={setAcceptMsgOpen}
        custOrderId={acceptMsgTarget.custOrderId}
        taskFlowInsId={acceptMsgTarget.flowInsId}
      />

      <BusiCmptDialog
        open={busiCmptOpen}
        onOpenChange={setBusiCmptOpen}
        busiCmptId={busiCmptId}
      />

      <DecryptDialog
        open={decryptOpen}
        onOpenChange={setDecryptOpen}
        envelopeText={decryptEnvelope}
        result={decryptResult}
        loading={decryptLoading}
      />

      <OccBusiCmptDialog
        open={occCmptOpen}
        onOpenChange={setOccCmptOpen}
        cmptCfgId={occCmptId}
      />

      <SoPreBusiLimitDialog
        open={soPreBusiLimitOpen}
        onOpenChange={setSoPreBusiLimitOpen}
        limitCode={soPreBusiLimitCode}
      />

      <BusinessInfoDialog
        open={businessInfoOpen}
        onOpenChange={setBusinessInfoOpen}
        businessId={businessInfoId}
      />

      <UpRuleDialog
        open={upRuleOpen}
        onOpenChange={setUpRuleOpen}
        ruleId={upRuleId}
      />


      <SceneConfigDialog
        open={sceneCfgOpen}
        onOpenChange={setSceneCfgOpen}
        sceneCfgId={sceneCfgId}
        onQueryWorkflow={onQueryWorkflow}
      />

      <OrderComponentsDialog
        open={componentsOpen}
        onOpenChange={setComponentsOpen}
        orderKey={businessKey.trim()}
        params={(() => {
          const node = sceneCache['order_info']?.nodes.find(item => item.node_code === 'cust_order')
          if (!node || node.rows.length === 0) return {}
          return rowValues(node.columns, node.rows[0])
        })()}
        onQueryWorkflow={onQueryWorkflow}
      />

      {/* 工单重试确认（写操作） */}
      <Dialog open={retryTarget !== null} onOpenChange={open => { if (!open) setRetryTarget(null) }}>
        <DialogContent className="max-w-md gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <Activity className="h-4 w-4 text-rose-400" />工单重试
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-[12px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#8b8b9e]">工单ID</span>
              <span className="font-mono text-[#cdd3e0]">{retryTarget?.taskId}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#8b8b9e]">客户订单ID</span>
              <span className="font-mono text-[#cdd3e0]">{retryTarget?.custOrderId}</span>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              确认后将执行 UPDATE HALL_TASK SET TASK_STATE = 2 与 UPDATE HALL_TASK_FLOW_INS SET handle_type = 2（在途表），该操作不可撤销。
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => setRetryTarget(null)}>取消</Button>
            <Button size="sm" className="h-8 bg-rose-600 text-white hover:bg-rose-500" onClick={() => void executeRetry()}>
              <Activity className="mr-1 h-3.5 w-3.5" />确认重试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
