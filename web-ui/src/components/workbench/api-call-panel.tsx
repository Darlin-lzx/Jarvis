import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { ApiCallResult } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Braces, Copy, Globe, Play, Server } from 'lucide-react'

/** 接口调用模式：page=页面接口（JSON + mainAcct/token），gateway=中台接口（XML + 网关鉴权头） */
type ApiMode = 'page' | 'gateway'

/** 页面接口服务地址默认值（CSF 网关前缀，可在页面修改并记忆） */
const PAGE_BASE_URL_DEFAULT = 'http://8080-code-server-linzx5-adfbxj.ideserver.fsp.zj.chinamobile.com:32415/csf/'

/** 页面接口编码内置候选（历史记录之外的示例） */
const PAGE_CODE_SAMPLES = [
  'digitalFamily_IGoodsDetailsCSV_qryGoodsDetails',
  'digitalFamily_IBroadChangeCSV_groupChangeInit',
]

/** 页面接口示例请求体（套餐变更受理） */
const PAGE_BODY_SAMPLE = '{"busiType":"packageChange","billId":19532010278}'

/** 中台接口示例请求体（ESB XML 报文） */
const GATEWAY_BODY_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<REQ_PARAM>
    <PUB_INFO>
        <SYS_OP_ID>20099390</SYS_OP_ID>
        <SYS_PASSWORD>985b64fb937f6c66f51a4c3d1ccc5e06</SYS_PASSWORD>
        <OP_ID>20099390</OP_ID>
        <OP_ORG_ID>0</OP_ORG_ID>
    </PUB_INFO>
    <BUSI_INFO>
        <CUST_ORDER_ID></CUST_ORDER_ID>
        <BILL_ID>19532010036</BILL_ID>
        <REGION_CODE>574</REGION_CODE>
        <COUNTY_CODE></COUNTY_CODE>
        <COUNTY_NAME>滨江区</COUNTY_NAME>
        <DOOR_LOCK_FLAG>1</DOOR_LOCK_FLAG>
        <REMARK></REMARK>
        <DEVICE_LIST>
            <DEVICE_INFO>
                <BRAND></BRAND>
                <DEVICE_CATEGORY></DEVICE_CATEGORY>
                <DEVICE_MODEL>14189333</DEVICE_MODEL>
                <IMEI>7854796210</IMEI>
                <SELLING_PRICE></SELLING_PRICE>
                <TERMINAL_NAME>德施曼人脸智能锁c</TERMINAL_NAME>
                <TERMINAL_ORD_ID></TERMINAL_ORD_ID>
            </DEVICE_INFO>
        </DEVICE_LIST>
    </BUSI_INFO>
</REQ_PARAM>`

/** 两种模式各自的请求头字段（含默认值），全部由页面输入 */
const MODE_HEADERS: Record<ApiMode, Record<string, string>> = {
  page: { mainAcct: '', token: '' },
  gateway: {
    accessToken: '', apiCode: '', apiVersion: '1.0.0',
    appCode: '', format: 'http+xml', operatorId: '',
  },
}

/** 模式切换项：value / 文案 / 图标 */
const MODE_TABS: [ApiMode, string, typeof Globe][] = [
  ['page', '页面接口', Globe],
  ['gateway', '中台接口', Server],
]

/** 读取某个模式下 localStorage 记忆的值（URL/请求体/请求头），无记忆时用兜底值 */
function loadStored(mode: ApiMode, key: string, fallback: string): string {
  try {
    const value = localStorage.getItem(`api-call:${mode}:${key}`)
    return value !== null ? value : fallback
  } catch { return fallback }
}

/** 把本次填写的 URL/请求体/请求头写入 localStorage，下次进页面直接复用 */
function saveStored(mode: ApiMode, values: Record<string, string>) {
  try {
    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(`api-call:${mode}:${key}`, value)
    }
  } catch { /* localStorage 不可用时忽略 */ }
}

/** 接口编码下拉候选：历史发送记录（最新在前）+ 内置示例，去重合并 */
function loadCodeOptions(): string[] {
  let used: string[] = []
  try {
    const raw = localStorage.getItem('api-call:page:codes')
    used = raw ? (JSON.parse(raw) as string[]) : []
  } catch { used = [] }
  const merged: string[] = []
  for (const item of [...used, ...PAGE_CODE_SAMPLES]) {
    if (typeof item === 'string' && item && !merged.includes(item)) merged.push(item)
  }
  return merged
}

/** 记录一次发送用过的接口编码（去重、最新在前、上限 50 条），返回刷新后的候选列表 */
function recordCodeUsage(code: string): string[] {
  let used: string[] = []
  try {
    const raw = localStorage.getItem('api-call:page:codes')
    used = raw ? (JSON.parse(raw) as string[]) : []
  } catch { used = [] }
  const next = [code, ...used.filter(item => item !== code)].slice(0, 50)
  try { localStorage.setItem('api-call:page:codes', JSON.stringify(next)) } catch { /* 忽略 */ }
  return next
}

/** 页面接口完整地址：编码框直接填 http 开头地址则原样使用，否则按 服务地址 + 编码 拼接 */
function composePageUrl(base: string, code: string): string {
  const trimmedCode = code.trim()
  if (/^https?:\/\//i.test(trimmedCode)) return trimmedCode
  const trimmedBase = base.trim()
  if (!trimmedBase || !trimmedCode) return ''
  return trimmedBase.endsWith('/') || trimmedCode.startsWith('/')
    ? trimmedBase + trimmedCode
    : `${trimmedBase}/${trimmedCode}`
}

/** 响应体展示：JSON 尝试格式化缩进，失败按原文展示 */
function formatBody(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

/** 接口调用调试：页面接口 / 中台接口的手工调用面板（Postman 式左请求右响应布局）。
 * 请求经后端 /api/api-call 代理转发，规避浏览器 CORS 限制。 */
export function ApiCallPanel() {
  // 每种模式独立记忆 URL / 请求体 / 请求头，切换模式互不覆盖。
  // 页面接口拆成 服务地址 + 接口编码 两段；旧版整段 URL 记忆迁移到编码框（编码框兼容完整地址）。
  const [mode, setMode] = useState<ApiMode>('page')
  const [pageBaseUrl, setPageBaseUrl] = useState(() => loadStored('page', 'baseUrl', PAGE_BASE_URL_DEFAULT))
  const [pageCode, setPageCode] = useState(() => {
    const legacyUrl = loadStored('page', 'url', '')
    return legacyUrl.startsWith('http') ? legacyUrl : loadStored('page', 'code', '')
  })
  const [codeOptions, setCodeOptions] = useState<string[]>(() => loadCodeOptions())
  const [pageBody, setPageBody] = useState(() => loadStored('page', 'body', PAGE_BODY_SAMPLE))
  const [gatewayUrl, setGatewayUrl] = useState(() => loadStored('gateway', 'url', ''))
  const [gatewayBody, setGatewayBody] = useState(() => loadStored('gateway', 'body', GATEWAY_BODY_SAMPLE))
  const [pageHeaders, setPageHeaders] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const [key, fallback] of Object.entries(MODE_HEADERS.page)) {
      initial[key] = loadStored('page', key, fallback)
    }
    return initial
  })
  const [gatewayHeaders, setGatewayHeaders] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const [key, fallback] of Object.entries(MODE_HEADERS.gateway)) {
      initial[key] = loadStored('gateway', key, fallback)
    }
    return initial
  })
  const [timeoutSeconds, setTimeoutSeconds] = useState(30)
  const [result, setResult] = useState<ApiCallResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const [copiedCurl, setCopiedCurl] = useState(false)
  const [copiedBody, setCopiedBody] = useState(false)
  const startedRef = useRef(0)

  // 页面接口：完整地址由 服务地址 + 接码 实时拼出；中台接口：直接用整段 URL
  const currentUrl = mode === 'page' ? composePageUrl(pageBaseUrl, pageCode) : gatewayUrl
  const currentBody = mode === 'page' ? pageBody : gatewayBody
  const currentHeaders = mode === 'page' ? pageHeaders : gatewayHeaders
  const contentType = mode === 'page' ? 'application/json' : 'application/xml'

  // 请求中每秒计时：目标地址不可达/网络黑洞时页面能看到等待了多久
  useEffect(() => {
    if (!loading) return
    setLoadingSeconds(0)
    const timer = setInterval(() => setLoadingSeconds(seconds => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [loading])

  /** 更新当前模式的某个请求头字段 */
  function updateHeader(name: string, value: string) {
    if (mode === 'page') {
      setPageHeaders(headers => ({ ...headers, [name]: value }))
    } else {
      setGatewayHeaders(headers => ({ ...headers, [name]: value }))
    }
  }

  /** 按当前表单内容还原 curl 命令，方便贴到终端/文档复现 */
  function buildCurl(): string {
    const lines = [
      'curl --request POST \\',
      `  --url ${currentUrl.trim()} \\`,
      `  --header 'Content-Type: ${contentType}' \\`,
    ]
    for (const [name, value] of Object.entries(currentHeaders)) {
      if (value.trim()) lines.push(`  --header '${name}: ${value}' \\`)
    }
    // shell 单引号转义：' → '\''
    const escaped = currentBody.replaceAll("'", `'\\''`)
    lines.push(`  --data '${escaped}'`)
    return lines.join('\n')
  }

  async function copyCurl() {
    // HTTP 非安全上下文下 clipboard API 不存在，失败时提示手动复制
    try {
      await navigator.clipboard.writeText(buildCurl())
      setCopiedCurl(true)
      setTimeout(() => setCopiedCurl(false), 1500)
    } catch {
      setError('复制失败（浏览器不支持剪贴板 API），请手动选择文本复制')
    }
  }

  async function copyBody() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.body)
      setCopiedBody(true)
      setTimeout(() => setCopiedBody(false), 1500)
    } catch {
      setError('复制失败（浏览器不支持剪贴板 API），请手动选择文本复制')
    }
  }

  /** Ctrl/Cmd + Enter 快捷发送（URL 输入框与请求体通用） */
  function handleShortcutKey(event: { metaKey: boolean; ctrlKey: boolean; key: string; preventDefault: () => void }) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void send()
    }
  }

  async function send() {
    const url = currentUrl.trim()
    if (!url) {
      // 页面接口缺失时区分缺服务地址还是缺编码，提示更精准
      setError(mode === 'page'
        ? (pageCode.trim() ? '请填写服务地址' : '请填写接口编码')
        : '请输入接口 URL')
      return
    }
    if (!currentBody.trim()) {
      setError('请输入请求体')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    setCopiedBody(false)
    startedRef.current = performance.now()
    // 记住本次填写内容；页面接口额外把用过的编码记入下拉候选
    if (mode === 'page') {
      saveStored('page', { baseUrl: pageBaseUrl, code: pageCode, body: pageBody, ...pageHeaders })
      const code = pageCode.trim()
      if (code && !/^https?:\/\//i.test(code)) setCodeOptions(recordCodeUsage(code))
    } else {
      saveStored('gateway', { url: gatewayUrl, body: gatewayBody, ...gatewayHeaders })
    }
    // 组装当前模式的请求参数（kind 决定后端用哪套请求头）
    const payload = mode === 'page'
      ? { kind: 'page' as const, url, body: currentBody,
          main_acct: pageHeaders.mainAcct, token: pageHeaders.token,
          timeout: timeoutSeconds }
      : { kind: 'gateway' as const, url, body: currentBody,
          access_token: gatewayHeaders.accessToken, api_code: gatewayHeaders.apiCode,
          api_version: gatewayHeaders.apiVersion, app_code: gatewayHeaders.appCode,
          format: gatewayHeaders.format, operator_id: gatewayHeaders.operatorId,
          timeout: timeoutSeconds }
    try {
      const response = await api.callInterface(payload)
      if (response.success && response.data && response.data.ok) {
        setResult(response.data)
      } else if (response.success && response.data) {
        // 网络层失败（连不上/超时），后端已返回 ok=false
        setError(response.data.message || '请求失败')
      } else {
        setError(response.error || '请求失败')
      }
    } catch (e) {
      setError(`请求失败: ${e}`)
    } finally {
      // 网络异常/非 JSON 响应时也必须复位，否则按钮永久卡在「发送中 Ns」
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3" data-api-call-panel>
      {/* 标题行：名称 + 模式切换（页面接口 / 中台接口各自记忆配置） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">接口调用</h2>
          <span className="rounded border border-[#3a3a45] bg-white/5 px-1.5 py-0.5 text-[10px] text-[#8b8b9e]">
            页面接口 JSON · 中台接口 XML · 后端代理转发
          </span>
        </div>
        <div className="flex items-center rounded-lg border border-[#252530] bg-[#0f0f14] p-0.5">
          {MODE_TABS.map(([item, label, Icon]) => (
            <button key={item} data-mode-tab={item}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] transition-colors',
                mode === item
                  ? 'bg-indigo-500/15 font-medium text-indigo-300'
                  : 'text-[#8b8b9e] hover:text-[#cdd3e0]'
              )}
              onClick={() => setMode(item)}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 主体：左请求 / 右响应（窄屏自动上下堆叠） */}
      <div className="grid grid-cols-1 items-stretch gap-3 xl:grid-cols-2">
        {/* —— 左列：请求 —— */}
        <div className="flex flex-col rounded-xl border border-[#252530] bg-[#16161e]">
          {/* URL 区：页面接口 = 服务地址 + 接口编码（可输可选）；中台接口 = 整段地址 */}
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2 px-3 pt-3">
            <span className="shrink-0 rounded-md bg-indigo-500/15 px-2 py-1 font-mono text-[11px] font-semibold text-indigo-300">
              POST
            </span>
            {mode === 'page' ? (
              <>
                <Input
                  className="h-9 font-mono text-[12px]"
                  placeholder="服务地址（CSF 网关前缀）"
                  value={pageBaseUrl}
                  data-api-base-url
                  onChange={event => setPageBaseUrl(event.target.value)}
                  onKeyDown={handleShortcutKey}
                />
                <span />
                <Input
                  className="h-9 font-mono text-[12px]"
                  placeholder="接口编码，如 digitalFamily_IGoodsDetailsCSV_qryGoodsDetails"
                  value={pageCode}
                  data-api-code
                  list="page-code-options"
                  onChange={event => setPageCode(event.target.value)}
                  onKeyDown={handleShortcutKey}
                />
              </>
            ) : (
              <Input
                className="h-9 font-mono text-[12px]"
                placeholder="http://aifgwzt-qatest.yw.zj.chinamobile.com:2333/http"
                value={gatewayUrl}
                data-api-url
                onChange={event => setGatewayUrl(event.target.value)}
                onKeyDown={handleShortcutKey}
              />
            )}
          </div>
          {/* 接口编码下拉候选：历史记录 + 内置示例（原生 datalist，支持自由输入） */}
          {mode === 'page' && (
            <>
              <datalist id="page-code-options">
                {codeOptions.map(item => <option key={item} value={item} />)}
              </datalist>
              <div className="break-all px-3 pt-1.5 font-mono text-[10px] text-[#5a5a70]" data-api-full-url>
                完整地址：{currentUrl || '（填写接口编码后自动拼接）'}
              </div>
            </>
          )}

          {/* 请求头：名称固定宽对齐 + 值输入，字段集随模式切换 */}
          <div className="mx-3 mt-3 rounded-lg border border-[#252530]/70 bg-[#0f0f14] p-2.5" data-api-headers>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-[#8b8b9e]">请求头</span>
              <span className="rounded border border-[#3a3a45] bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[#8b8b9e]">
                Content-Type: {contentType}
              </span>
            </div>
            <div className="space-y-1.5">
              {Object.entries(currentHeaders).map(([name, value]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-[100px] shrink-0 truncate font-mono text-[11px] text-[#8b8b9e]" title={name}>
                    {name}
                  </span>
                  <Input
                    className="h-7 flex-1 font-mono text-[12px]"
                    value={value}
                    data-api-header={name}
                    onChange={event => updateHeader(name, event.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 请求体：JSON 模式提供一键格式化 */}
          <div className="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-[#8b8b9e]">
                请求体<span className="ml-1.5 font-normal text-[#5a5a70]">{mode === 'page' ? 'JSON' : 'XML'}</span>
              </span>
              {mode === 'page' && (
                <button
                  className="flex items-center gap-1 text-[10px] text-[#8b8b9e] hover:text-indigo-300"
                  data-api-format
                  onClick={() => {
                    try {
                      setPageBody(JSON.stringify(JSON.parse(pageBody), null, 2))
                    } catch { /* 非法 JSON 保持原文 */ }
                  }}>
                  <Braces className="h-3 w-3" />格式化 JSON
                </button>
              )}
            </div>
            <textarea
              className="min-h-[200px] w-full flex-1 resize-none rounded-md border border-[#252530] bg-[#0f0f14] p-2.5 font-mono text-[12px] leading-relaxed text-[#cdd3e0] outline-none focus:border-[#4a4a5c]"
              placeholder={mode === 'page'
                ? '{"busiType":"packageChange","billId":19532010278}'
                : '<?xml version="1.0" encoding="UTF-8"?>\n<REQ_PARAM>…</REQ_PARAM>'}
              value={currentBody}
              data-api-body
              onChange={event => (mode === 'page'
                ? setPageBody(event.target.value)
                : setGatewayBody(event.target.value))}
              onKeyDown={handleShortcutKey}
            />
          </div>

          {/* 底部操作行：超时 + 快捷键提示 + 复制 cURL + 发送 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#252530] px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <label className="flex items-center gap-1 text-[11px] text-[#8b8b9e]">
                超时
                <select
                  className="h-7 rounded-md border border-[#252530] bg-[#0f0f14] px-1.5 text-[11px] text-[#cdd3e0]"
                  value={timeoutSeconds}
                  onChange={event => setTimeoutSeconds(Number(event.target.value))}
                >
                  {[10, 30, 60, 120].map(value => <option key={value} value={value}>{value}s</option>)}
                </select>
              </label>
              <span className="text-[10px] text-[#5a5a70]">Ctrl / Cmd + Enter 快捷发送</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => void copyCurl()}>
                <Copy className="mr-1 h-3 w-3" />{copiedCurl ? '已复制' : '复制 cURL'}
              </Button>
              <Button size="sm" className="h-8" disabled={loading} onClick={() => void send()}>
                <Play className="mr-1 h-3.5 w-3.5" />
                {loading ? `发送中 ${loadingSeconds}s` : '发送'}
              </Button>
            </div>
          </div>
        </div>

        {/* —— 右列：响应 —— */}
        <div className="flex min-h-0 flex-col rounded-xl border border-[#252530] bg-[#16161e]" data-api-result>
          {/* 响应状态栏：状态码 + 耗时 + 复制 */}
          <div className="flex items-center justify-between border-b border-[#252530] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-[#8b8b9e]">响应</span>
              {result && (
                <>
                  <span className={cn(
                    'rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold',
                    result.status >= 200 && result.status < 300
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-red-500/15 text-red-300'
                  )}>
                    HTTP {result.status}
                  </span>
                  <span className="text-[11px] text-[#8b8b9e]">耗时 {result.elapsed_ms} ms</span>
                </>
              )}
            </div>
            {result && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void copyBody()}>
                <Copy className="mr-1 h-3 w-3" />{copiedBody ? '已复制' : '复制响应'}
              </Button>
            )}
          </div>

          {result ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <details className="rounded-lg border border-[#252530]/70 bg-[#0f0f14] px-3 py-1.5">
                <summary className="cursor-pointer select-none text-[11px] text-[#8b8b9e]">
                  响应头（{Object.keys(result.response_headers).length}）
                </summary>
                <div className="mt-1.5 space-y-0.5 break-all font-mono text-[10px] text-[#cdd3e0]">
                  {Object.entries(result.response_headers).map(([name, value]) => (
                    <div key={name}><span className="text-[#5a5a70]">{name}:</span> {value}</div>
                  ))}
                </div>
              </details>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[#252530] bg-[#0f0f14] p-3 font-mono text-[12px] leading-relaxed text-[#cdd3e0]">
                {formatBody(result.body) || '（空响应）'}
              </pre>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-[#5a5a70]" data-api-empty>
              <Globe className="h-8 w-8 opacity-40" />
              <span className="text-[12px]">填写接口地址后点击「发送」查看响应</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" data-api-error>
          {error}
        </div>
      )}
    </div>
  )
}
