import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import type { Datasource, SqlLibraryEntry } from '@/lib/types'
import { Download, Play, Copy, Terminal, FileCode, Pencil } from 'lucide-react'

interface SqlResult {
  ok: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  message: string
}

/** 数据源绑定 SQL 文件里的示例初始内容（新建时预填） */
const NEW_LIBRARY_TEMPLATE = '-- name: 示例查询\nSELECT 1 FROM dual\n'

function toCsv(columns: string[], rows: string[][]) {
  const escape = (value: string) => `"${String(value ?? '').replaceAll('"', '""')}"`
  return [columns.map(escape).join(','), ...rows.map(row => row.map(escape).join(','))].join('\n')
}

/** SQL 里的 {param} 占位符名（去重保序）；与后端 PARAM_PATTERN 同形态 */
function paramNames(sqlText: string): string[] {
  const found: string[] = []
  for (const match of sqlText.matchAll(/\{([A-Za-z_]\w*)\}/g)) {
    if (!found.includes(match[1])) found.push(match[1])
  }
  return found
}

/** SQL 摘要：压成单行并截断（列表展示用） */
function oneLine(sqlText: string, width = 96) {
  const flat = sqlText.replace(/\s+/g, ' ').trim()
  return flat.length > width ? flat.slice(0, width) + '…' : flat
}

/** SQL 查询：选择数据源 + 自由 SQL（只读 SELECT/WITH）执行与结果展示；
 * 另含数据源 SQL 库（每数据源一个 .sql 文件，`-- name:` 分段，点选执行）。 */
export function SqlPanel() {
  const [datasources, setDatasources] = useState<Datasource[]>([])
  const [datasource, setDatasource] = useState('')
  const [sql, setSql] = useState('')
  const [limit, setLimit] = useState(100)
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  // SQL 库：条目列表 / 文件存在性 / 文件编辑
  const [entries, setEntries] = useState<SqlLibraryEntry[]>([])
  const [libraryExists, setLibraryExists] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [fileEditing, setFileEditing] = useState(false)
  const [fileContent, setFileContent] = useState('')
  const [fileSaving, setFileSaving] = useState(false)
  const [fileNotice, setFileNotice] = useState('')
  // 参数弹窗：待执行条目 + 各占位符当前值
  const [paramTarget, setParamTarget] = useState<{ entry: SqlLibraryEntry; params: string[] } | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const startedRef = useRef(0)

  useEffect(() => {
    api.listDatasources().then(response => {
      if (response.success) {
        const list = (response.data as Datasource[]) || []
        setDatasources(list.filter(item => item.enabled))
        const first = list.find(item => item.enabled)
        if (first) setDatasource(first.name)
      } else {
        setError(response.error || '数据源列表加载失败')
      }
    }).catch(e => setError(`数据源列表加载失败: ${e}`))
  }, [])

  // 选中数据源 → 加载其绑定的 SQL 库文件（不存在则展示新建入口）
  useEffect(() => {
    // cancelled 防竞态：快速切换数据源时，旧数据源的慢响应不得覆盖新结果
    let cancelled = false
    setFileEditing(false)
    setFileNotice('')
    setParamTarget(null)
    if (!datasource) {
      setEntries([])
      setLibraryExists(false)
      setFileContent('')
      return
    }
    setLibraryLoading(true)
    api.getSqlLibraryFile(datasource).then(response => {
      if (cancelled) return
      if (response.success && response.data) {
        setEntries(response.data.entries)
        setLibraryExists(response.data.exists)
        setFileContent(response.data.content)
      } else {
        setEntries([])
        setLibraryExists(false)
        setFileContent('')
      }
    }).finally(() => {
      if (!cancelled) setLibraryLoading(false)
    })
    return () => { cancelled = true }
  }, [datasource])

  // 查询中每秒计时：库不可达/网络黑洞时页面能看到等待了多久
  useEffect(() => {
    if (!loading) return
    setLoadingSeconds(0)
    const timer = setInterval(() => setLoadingSeconds(seconds => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [loading])

  // 参数记忆：数据源 + 条目 + 参数名 → 上次填的值（换订单号高频重跑只改一个框）
  const paramMemoKey = (entryName: string, param: string) =>
    `sql-param:${datasource}:${entryName}:${param}`

  function openEntry(entry: SqlLibraryEntry) {
    const params = paramNames(entry.sql)
    if (params.length === 0) {
      executeEntry(entry, {})
      return
    }
    const defaults: Record<string, string> = {}
    for (const param of params) {
      defaults[param] = localStorage.getItem(paramMemoKey(entry.name, param)) || ''
    }
    setParamValues(defaults)
    setParamTarget({ entry, params })
  }

  function executeEntry(entry: SqlLibraryEntry, values: Record<string, string>) {
    let sqlText = entry.sql
    for (const [key, value] of Object.entries(values)) {
      sqlText = sqlText.replaceAll(`{${key}}`, value)
      localStorage.setItem(paramMemoKey(entry.name, key), value)
    }
    setParamTarget(null)
    setSql(sqlText)
    void run(sqlText)
  }

  function confirmParams() {
    if (!paramTarget) return
    if (paramTarget.params.some(param => !(paramValues[param] || '').trim())) return
    executeEntry(paramTarget.entry, paramValues)
  }

  async function saveLibraryFile() {
    if (!datasource) return
    setFileSaving(true)
    setFileNotice('')
    setError('')
    try {
      const response = await api.saveSqlLibraryFile(datasource, fileContent)
      if (response.success && response.data) {
        setEntries(response.data.entries)
        setLibraryExists(true)
        setFileNotice('已保存')
        setTimeout(() => setFileNotice(''), 1500)
      } else {
        setError(response.error || 'SQL 库保存失败')
      }
    } catch (e) {
      setError(`保存请求失败: ${e}`)
    } finally {
      // 请求 rejection 时也必须复位，否则按钮永久卡在保存中
      setFileSaving(false)
    }
  }

  async function run(sqlOverride?: string) {
    const sqlText = (sqlOverride ?? sql).trim()
    if (!datasource) {
      setError('请选择数据源')
      return
    }
    if (!sqlText) {
      setError('请输入 SQL')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    setCopied(false)
    startedRef.current = performance.now()
    try {
      const response = await api.queryDatasource(datasource, sqlText, limit)
      setElapsed(Math.round(performance.now() - startedRef.current))
      if (response.success && response.data) {
        setResult(response.data)
        if (!response.data.ok) setError(response.data.message || '查询失败')
      } else {
        setError(response.error || '查询失败')
      }
    } catch (e) {
      setElapsed(Math.round(performance.now() - startedRef.current))
      setError(`查询请求失败: ${e}`)
    } finally {
      // 网络异常/非 JSON 响应时也必须复位，否则按钮永久卡在「执行中 Ns」
      setLoading(false)
    }
  }

  function downloadCsv() {
    if (!result?.ok) return
    const blob = new Blob(['\ufeff' + toCsv(result.columns, result.rows)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `sql-query-${Date.now()}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const kindLabel = (kind: string) => {
    const labels: Record<string, string> = {
      postgresql: 'PG', mysql: 'MySQL', oceanbase: 'OB', oracle: 'ORA',
      sqlite: 'SQLite', dm: 'DM', kingbase: 'KB', gaussdb: 'Gauss', excel: 'Excel',
    }
    return labels[kind] ?? kind
  }

  return (
    <div className="space-y-3" data-sql-panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">SQL 查询</h2>
          <span className="rounded border border-[#3a3a45] bg-white/5 px-1.5 py-0.5 text-[10px] text-[#8b8b9e]">
            只读 SELECT/WITH · 单次最多 500 行 · 自动回滚
          </span>
        </div>
        {elapsed > 0 && <span className="text-[11px] text-[#5a5a70]">耗时 {elapsed} ms</span>}
      </div>

      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>数据源</span>
            <select
              className="h-8 w-[260px] rounded-md border border-[#252530] bg-[#0f0f14] px-2 text-[12px] text-[#cdd3e0]"
              value={datasource}
              onChange={event => setDatasource(event.target.value)}
            >
              {datasources.length === 0 && <option value="">（无可用数据源）</option>}
              {datasources.map(item => (
                <option key={item.name} value={item.name}>
                  {item.name}（{kindLabel(item.kind)}）
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>行数上限</span>
            <select
              className="h-8 w-[90px] rounded-md border border-[#252530] bg-[#0f0f14] px-2 text-[12px] text-[#cdd3e0]"
              value={limit}
              onChange={event => setLimit(Number(event.target.value))}
            >
              {[50, 100, 200, 500].map(value => <option key={value} value={value}>{value} 行</option>)}
            </select>
          </label>
          <Button size="sm" className="h-8" disabled={loading} onClick={() => void run()}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {loading ? `执行中 ${loadingSeconds}s` : '执行'}
          </Button>
          <span className="text-[10px] text-[#5a5a70]">Ctrl / Cmd + Enter 快捷执行</span>
        </div>
        <textarea
          className="mt-3 h-[120px] w-full resize-y rounded-md border border-[#252530] bg-[#0f0f14] p-2.5 font-mono text-[12px] leading-relaxed text-[#cdd3e0] outline-none focus:border-[#4a4a5c]"
          placeholder={'select * from 表名 limit 10'}
          value={sql}
          onChange={event => setSql(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void run()
            }
          }}
        />
      </div>

      {datasource && (
        <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3" data-sql-library>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] text-[#8b8b9e]">
              <FileCode className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
              SQL 库（{datasource}）
              {entries.length > 0 && <span className="text-[#5a5a70]">· {entries.length} 条</span>}
              {fileNotice && <span className="text-emerald-300">{fileNotice}</span>}
            </span>
            <button
              className="flex shrink-0 items-center gap-1 text-[10px] text-[#8b8b9e] hover:text-indigo-300"
              data-sql-library-toggle
              onClick={() => setFileEditing(value => !value)}
            >
              <Pencil className="h-3 w-3" />{fileEditing ? '收起文件' : '编辑文件'}
            </button>
          </div>

          {fileEditing && (
            <div className="mb-2 space-y-1.5">
              <textarea
                className="h-[220px] w-full resize-y rounded-md border border-[#252530] bg-[#0f0f14] p-2.5 font-mono text-[12px] leading-relaxed text-[#cdd3e0] outline-none focus:border-[#4a4a5c]"
                placeholder={'-- name: 查询名称\nSELECT * FROM 表名 WHERE ID = \'{param}\''}
                value={fileContent}
                onChange={event => setFileContent(event.target.value)}
                data-sql-library-editor
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#5a5a70]">
                  `-- name: 名称` 分段，一段一条 SQL；{'{param}'} 为执行时填写的占位符
                </span>
                <Button size="sm" className="h-7 text-[11px]" disabled={fileSaving}
                  data-sql-library-save onClick={() => void saveLibraryFile()}>
                  {fileSaving ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
          )}

          {libraryLoading ? (
            <div className="px-2 py-3 text-center text-[11px] text-[#5a5a70]">加载中…</div>
          ) : entries.length === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-[#5a5a70]">
              {libraryExists
                ? 'SQL 库文件里还没有可执行条目（需 -- name: 名称 标记分段）'
                : '该数据源还没有 SQL 库文件'}
              {!libraryExists && (
                <button className="ml-1.5 text-indigo-300 hover:underline" data-sql-library-create
                  onClick={() => {
                    setFileContent(NEW_LIBRARY_TEMPLATE)
                    setFileEditing(true)
                  }}>
                  新建 {datasource}.sql
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {entries.map((entry, index) => (
                <div key={index}
                  className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1 hover:border-[#252530] hover:bg-white/[0.03]">
                  <button className="min-w-0 flex-1 text-left" data-sql-library-item
                    title={entry.sql}
                    onClick={() => openEntry(entry)}>
                    <span className="mr-2 text-[11px] font-medium text-[#cdd3e0]">{entry.name}</span>
                    <span className="font-mono text-[10px] text-[#5a5a70]">{oneLine(entry.sql)}</span>
                  </button>
                  <button className="shrink-0 text-[#5a5a70] opacity-0 transition-opacity group-hover:opacity-100 hover:text-indigo-300"
                    title="编辑文件"
                    onClick={() => setFileEditing(true)}>
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" data-sql-error>
          {error}
        </div>
      )}

      {result?.ok && (
        <div className="space-y-2" data-sql-result>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-[#8b8b9e]">
              {result.row_count} 行{result.message ? ` · ${result.message}` : ''}
            </span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 text-[11px]"
                onClick={async () => {
                  await navigator.clipboard.writeText(toCsv(result.columns, result.rows))
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}>
                <Copy className="mr-1 h-3 w-3" />{copied ? '已复制' : '复制 CSV'}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={downloadCsv}>
                <Download className="mr-1 h-3 w-3" />导出 CSV
              </Button>
            </div>
          </div>
          <div className="max-h-[480px] overflow-auto rounded-lg border border-[#252530]">
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
        </div>
      )}

      <Dialog open={!!paramTarget} onOpenChange={open => !open && setParamTarget(null)}>
        <DialogContent className="max-w-md gap-3" data-sql-param-dialog>
          <DialogHeader>
            <DialogTitle>执行「{paramTarget?.entry.name}」</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {paramTarget?.params.map(param => (
              <label key={param} className="block space-y-1">
                <span className="text-[11px] text-[#8b8b9e]">{param}</span>
                <Input
                  className="h-8 text-[12px]"
                  value={paramValues[param] || ''}
                  data-sql-param-input={param}
                  onChange={event => setParamValues(values => ({ ...values, [param]: event.target.value }))}
                />
              </label>
            ))}
            {paramTarget && paramTarget.params.some(param => !(paramValues[param] || '').trim()) && (
              <span className="block text-[10px] text-amber-300">参数不能为空</span>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => setParamTarget(null)}>
              取消
            </Button>
            <Button size="sm" className="h-8 text-[11px]" data-sql-param-run
              disabled={!!paramTarget && paramTarget.params.some(param => !(paramValues[param] || '').trim())}
              onClick={confirmParams}>
              执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
