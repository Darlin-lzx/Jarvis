import { useState, useEffect, useRef } from 'react'
import { Send, X, Database, RefreshCw, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { Datasource } from '@/lib/types'
import { parseOptions } from './ui-form-options'

/**
 * UI_RENDER 结构化指令 → 动态表单渲染。
 *
 * 模型在回复中通过 `<UI_RENDER>{...}</UI_RENDER>` 下发界面指令，后端已剔除重复块并
 * 只保留首个合法 JSON。支持的表单结构：
 *
 * {
 *   "title": "跨工程迭代评估",              // 可选：表单标题
 *   "fields": [                            // 必选：字段列表
 *     { "name": "source_db", "label": "源库", "type": "select", "options": ["Oracle","MySQL"] },
 *     { "name": "target_db", "label": "目标库", "type": "select", "options": ["达梦","OceanBase"] },
 *     { "name": "sql", "label": "SQL 脚本", "type": "textarea", "placeholder": "粘贴 DDL…" },
 *     { "name": "count", "label": "数量", "type": "number", "default": 1 },
 *     { "name": "strict", "label": "严格模式", "type": "checkbox", "default": false }
 *   ],
 *   "submit": "开始评估"                    // 可选：提交按钮文案
 * }
 *
 * 字段 type 支持：text / textarea / number / select / checkbox / radio（其余按 text 处理）。
 * 点击提交后通过 onAction(values) 把收集到的表单值回传（未提供时为本地展示 JSON）。
 *
 * 空状态约定：select/radio 候选为空时，表单展示【暂无数据源】提示 + 「去数据源管理新增」快捷
 * 跳转 + 「刷新数据源选项」按钮；提交按钮同步禁用；窗口重新聚焦（用户从数据源管理页返回）时
 * 自动刷新候选列表。
 */

export interface UiFormProps {
  data: Record<string, unknown>
  onAction?: (values: Record<string, unknown>) => void
}

type FieldSpec = {
  name?: string
  label?: string
  type?: string
  options?: unknown[]
  placeholder?: string
  default?: unknown
}

function fieldType(t: unknown): string {
  const s = typeof t === 'string' ? t.toLowerCase() : ''
  return ['text', 'textarea', 'number', 'select', 'checkbox', 'radio'].includes(s) ? s : 'text'
}

/** 兼容两种指令格式：
 * 1. fields 数组格式（见上方示例）
 * 2. 单组件格式：{ ui_type, component: "radio", options, param_key, title }（指挥官分步采集约定）
 * 单组件格式会被归一化为一个字段，提交时输出 { [param_key]: 值 }。 */
/** 单组件格式（指挥官分步采集约定）里的确认类组件：固定渲染为「是/否」单选，
 * 避免模型下发的任意文本组件让用户手打"确认"等确认词（后端 _CONFIRM_YES/_CONFIRM_BACK 已收录 是/否）。 */
const CONFIRM_COMPS = ['confirm', 'boolean', 'bool', 'yesno', 'yes_no']

function normalize(data: Record<string, unknown>): { fields: FieldSpec[]; submit: string; title: string } {
  const title = typeof data.title === 'string' ? data.title : ''
  const submitText = typeof data.submit === 'string' ? data.submit : '提交'
  const rawFields = (Array.isArray(data.fields) ? data.fields : []) as unknown[]
  const fields = rawFields
    .filter((f): f is FieldSpec => !!f && typeof f === 'object')
    .map(f => ({ ...f, options: parseOptions(f.options) }))
  if (fields.length || typeof data.component !== 'string') {
    return { fields, submit: submitText, title }
  }
  const comp = String(data.component).toLowerCase()
  const typeMap: Record<string, string> = {
    radio: 'radio', select: 'select', dropdown: 'select',
    checkbox: 'checkbox', multiselect: 'checkbox',
    text: 'text', input: 'text', textarea: 'textarea',
    confirm: 'radio', boolean: 'radio', bool: 'radio', yesno: 'radio', yes_no: 'radio',
  }
  const mapped = typeMap[comp]
  if (!mapped) {
    // 模型下发了未约定的 component 类型：按文本输入兜底，但打日志便于发现提示词漂移
    console.warn('[UiForm] 未识别的 component 类型，按文本输入兜底：', data.component)
  }
  const name = typeof data.param_key === 'string' && data.param_key ? data.param_key : 'value'
  // 字段标签：仅用模型显式给出的 label/question；标题已在卡片头部展示，不再复用 title，
  // 避免「确认跨工程迭代任务信息」在同一张表单里出现两次（标题 + 字段标签）
  const label = typeof data.label === 'string' ? data.label
    : typeof data.question === 'string' ? data.question
    : (title ? '' : name)
  let options = parseOptions(data.options)
  if (CONFIRM_COMPS.includes(comp) && options.length === 0) {
    options = ['是', '否']
  }
  return {
    fields: [{
      name, label,
      type: mapped || 'text',
      options,
      placeholder: typeof data.placeholder === 'string' ? data.placeholder : '',
    }],
    submit: submitText,
    title,
  }
}

/** 选项显示文案：兼容字符串与 {label,name,text,title,value,...} 对象形状。
 *  模型有时下发 [{label:"确认", value:"confirm"}] 形状，此前只认 {name} 导致整串 JSON 直接打印。 */
function optionLabel(o: unknown): string {
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (typeof o === 'object') {
    const r = o as Record<string, unknown>
    return String(r.label ?? r.name ?? r.text ?? r.title ?? optionValue(o))
  }
  return String(o)
}

/** 选项提交值：对象优先取 value/id/key，缺省回退为显示文案。提交的纯值（如 "confirm"）
 *  才能命中后端确认词表 _CONFIRM_YES，避免整串 JSON 被当值提交导致状态机不推进。 */
function optionValue(o: unknown): string {
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (typeof o === 'object') {
    const r = o as Record<string, unknown>
    const v = r.value ?? r.id ?? r.key
    return v != null ? String(v) : optionLabel(o)
  }
  return String(o)
}

/** 是否为候选选择类字段（select / radio） */
function isChoiceType(t: string): boolean {
  return t === 'select' || t === 'radio'
}

export function UiForm({ data, onAction }: UiFormProps) {
  const init = normalize(data)
  const submitText = init.submit
  const title = init.title

  const [fields, setFields] = useState<FieldSpec[]>(init.fields)
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const obj: Record<string, unknown> = {}
    for (const f of init.fields) {
      const name = String(f.name ?? '')
      if (!name) continue
      if (fieldType(f.type) === 'checkbox') {
        obj[name] = typeof f.default === 'boolean' ? f.default : false
      } else if (f.default !== undefined && f.default !== null) {
        obj[name] = f.default
      } else if (fieldType(f.type) === 'number') {
        obj[name] = typeof f.default === 'number' ? f.default : ''
      } else {
        obj[name] = ''
      }
    }
    return obj
  })

  const [result, setResult] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /** 存在空候选的选择类字段（无可选项 → 空状态，禁用提交） */
  const hasEmptyOptions = fields.some(f => isChoiceType(fieldType(f.type)) && (f.options || []).length === 0)

  /** 打开「数据源管理」页（新窗口打开，聊天会话保持在当前标签，返回后表单仍在） */
  const openDatasourceManager = () => {
    const base = `${window.location.origin}${window.location.pathname}`
    window.open(`${base}#/workspace/dbs`, '_blank', 'noopener')
  }

  /** 刷新候选：仅填充当前为空的 select/radio 字段（不覆盖模型提供的既有选项） */
  const refreshOptions = () => {
    setRefreshing(true)
    api.listDatasources().then(r => {
      const ds = (r.success ? r.data || [] : []) as Datasource[]
      const names = ds.filter(d => d.enabled !== false).map(d => String(d.name))
      setFields(prev => prev.map(f => {
        if (isChoiceType(fieldType(f.type)) && (f.options || []).length === 0) {
          return { ...f, options: names }
        }
        return f
      }))
    }).catch(() => { /* 静默：保持原状 */ })
      .finally(() => setRefreshing(false))
  }

  // 首次挂载 + 窗口重新聚焦（用户从「数据源管理」页返回）时，若仍存在空候选则自动刷新数据源列表
  const hasEmptyRef = useRef(hasEmptyOptions)
  hasEmptyRef.current = hasEmptyOptions
  const refreshRef = useRef(refreshOptions)
  refreshRef.current = refreshOptions
  const mountedRef = useRef(false)
  useEffect(() => {
    const run = () => {
      if (hasEmptyRef.current) refreshRef.current()
    }
    if (!mountedRef.current) {
      mountedRef.current = true
      run()
    }
    const onFocus = () => run()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  if (init.fields.length === 0 && fields.length === 0) return null

  const setVal = (name: string, v: unknown) => {
    setValues(prev => ({ ...prev, [name]: v }))
    setResult(null)
  }

  const onSubmit = () => {
    if (hasEmptyOptions) return
    const payload = { ...values }
    // 数字字段转数值（空字符串保持为空）
    for (const f of fields) {
      const name = String(f.name ?? '')
      if (fieldType(f.type) === 'number' && payload[name] !== '') {
        const n = Number(payload[name])
        if (!Number.isNaN(n)) payload[name] = n
      }
    }
    if (onAction) onAction(payload)
    else setResult(JSON.stringify(payload, null, 2))
  }

  const inputBase =
    'w-full h-9 rounded-lg bg-[#0f0f14] border border-[#252530] px-3 text-[12.5px] text-[#e4e4e9] placeholder:text-[#5a5a70] focus:outline-none focus:border-indigo-500/50'

  return (
    <div className="rounded-xl border border-indigo-500/20 bg-gradient-to-br from-[#15151f] to-[#11111a] overflow-hidden my-3">
      {title && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#252530] bg-[#171720]">
          <span className="text-[13px] font-semibold text-[#e4e4e9]">{title}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            UI 表单
          </span>
        </div>
      )}
      <div className="p-4 space-y-3">
        {fields.map((f, i) => {
          const name = String(f.name ?? `field_${i}`)
          const label = f.label || ''
          const type = fieldType(f.type)
          const placeholder = typeof f.placeholder === 'string' ? f.placeholder : ''
          const opts = f.options || []
          return (
            <div key={name}>
              {label && (
                <label className="flex items-center gap-1.5 text-[12px] text-[#9a9aa4] mb-1.5">
                  {label}
                </label>
              )}
              {type === 'textarea' ? (
                <textarea
                  className={cn(inputBase, 'h-24 py-2 resize-y')}
                  placeholder={placeholder}
                  value={String(values[name] ?? '')}
                  onChange={e => setVal(name, e.target.value)}
                />
              ) : type === 'radio' ? (
                <div className="space-y-1.5">
                  {opts.length === 0 ? (
                    <div className="text-[12px] text-amber-400/85 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-2 leading-relaxed">
                      【暂无数据源】请在下方「去数据源管理新增」后刷新选择项
                    </div>
                  ) : opts.map((o, j) => {
                    const val = optionValue(o)
                    const lbl = optionLabel(o)
                    return (
                      <label key={j} className="flex items-center gap-2 cursor-pointer rounded-lg px-2.5 py-1.5 hover:bg-[#1a1a24]">
                        <input
                          type="radio"
                          name={name}
                          checked={String(values[name] ?? '') === val}
                          onChange={() => setVal(name, val)}
                          className="w-3.5 h-3.5 accent-indigo-500"
                        />
                        <span className="text-[12.5px] text-[#cdd3e0]">{lbl}</span>
                      </label>
                    )
                  })}
                </div>
              ) : type === 'select' ? (
                <select
                  className={cn(inputBase, 'appearance-none', opts.length === 0 && 'text-[#5a5a70]')}
                  value={String(values[name] ?? '')}
                  onChange={e => setVal(name, e.target.value)}
                  disabled={opts.length === 0}
                >
                  {opts.length === 0 ? (
                    <option value="" disabled>【暂无数据源】</option>
                  ) : (
                    <>
                      <option value="">请选择…</option>
                      {opts.map((o, j) => (
                        <option key={j} value={optionValue(o)}>
                          {optionLabel(o)}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              ) : type === 'checkbox' ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!values[name]}
                    onChange={e => setVal(name, e.target.checked)}
                    className="w-4 h-4 accent-indigo-500"
                  />
                  <span className="text-[12px] text-[#cdd3e0]">启用</span>
                </label>
              ) : (
                <input
                  type={type === 'number' ? 'number' : 'text'}
                  className={inputBase}
                  placeholder={placeholder}
                  value={String(values[name] ?? '')}
                  onChange={e => setVal(name, e.target.value)}
                />
              )}
            </div>
          )
        })}

        {/* 空状态操作区：跳转数据源管理 + 刷新选项 */}
        {hasEmptyOptions && (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={openDatasourceManager}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-dashed border-amber-500/40 text-amber-400 text-[12px] font-medium hover:bg-amber-500/10 transition-colors"
            >
              <Database className="w-3.5 h-3.5" />
              去数据源管理新增
            </button>
            <button
              onClick={refreshOptions}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[#2a2a35] text-[#9a9aa4] text-[12px] font-medium hover:text-[#cdd3e0] hover:bg-white/[0.04] transition-colors disabled:opacity-50"
            >
              {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {refreshing ? '刷新中…' : '刷新数据源选项'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onSubmit}
            disabled={hasEmptyOptions}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-4 rounded-lg text-white text-[12px] font-medium transition-opacity',
              hasEmptyOptions
                ? 'bg-[#2a2a35] text-[#6a6a7a] cursor-not-allowed'
                : 'bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] hover:opacity-90'
            )}
            title={hasEmptyOptions ? '请先新增数据源后再提交' : submitText}
          >
            <Send className="w-3.5 h-3.5" />
            {hasEmptyOptions ? '请先新增数据源' : submitText}
          </button>
          {result && (
            <button
              onClick={() => setResult(null)}
              className="inline-flex items-center gap-1 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4]"
            >
              <X className="w-3 h-3" />
              关闭
            </button>
          )}
        </div>

        {result && (
          <pre className="text-[11px] leading-relaxed bg-[#0f0f14] border border-[#252530] rounded-lg p-3 text-cyan-300/90 overflow-x-auto">
            {result}
          </pre>
        )}
      </div>
    </div>
  )
}
