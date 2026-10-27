import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Datasource } from '@/lib/types'
import { Download, Play, Copy, Terminal, Trash2 } from 'lucide-react'

interface SqlResult {
  ok: boolean
  columns: string[]
  rows: string[][]
  row_count: number
  message: string
}

interface HistoryEntry {
  datasource: string
  sql: string
}

const HISTORY_KEY = 'sql-query-history'
const HISTORY_MAX = 10

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const list = raw ? JSON.parse(raw) as HistoryEntry[] : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function toCsv(columns: string[], rows: string[][]) {
  const escape = (value: string) => `"${String(value ?? '').replaceAll('"', '""')}"`
  return [columns.map(escape).join(','), ...rows.map(row => row.map(escape).join(','))].join('\n')
}

/** SQL 查询：选择数据源 + 自由 SQL（只读 SELECT/WITH）执行与结果展示 */
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
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory)
  const [copied, setCopied] = useState(false)
  const startedRef = useRef(0)

  useEffect(() => {
    api.listDatasources().then(response => {
      if (response.success) {
        const list = (response.data as Datasource[]) || []
        setDatasources(list.filter(item => item.enabled))
        const first = list.find(item => item.enabled)
        if (first) setDatasource(first.name)
      }
    })
  }, [])

  // 查询中每秒计时：库不可达/网络黑洞时页面能看到等待了多久
  useEffect(() => {
    if (!loading) return
    setLoadingSeconds(0)
    const timer = setInterval(() => setLoadingSeconds(seconds => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [loading])

  function pushHistory(entry: HistoryEntry) {
    const next = [entry, ...loadHistory().filter(item => item.sql !== entry.sql)].slice(0, HISTORY_MAX)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
    setHistory(next)
  }

  async function run() {
    if (!datasource) {
      setError('请选择数据源')
      return
    }
    if (!sql.trim()) {
      setError('请输入 SQL')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    setCopied(false)
    startedRef.current = performance.now()
    const response = await api.queryDatasource(datasource, sql.trim(), limit)
    setLoading(false)
    setElapsed(Math.round(performance.now() - startedRef.current))
    if (response.success && response.data) {
      setResult(response.data)
      if (response.data.ok) pushHistory({ datasource, sql: sql.trim() })
      else setError(response.data.message || '查询失败')
    } else {
      setError(response.error || '查询失败')
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
                  {item.name}（{kindLabel(item.kind)}·{item.location}）
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

      {history.length > 0 && (
        <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3" data-sql-history>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] text-[#8b8b9e]">历史（最近 {history.length} 条，点击回填）</span>
            <button
              className="flex items-center gap-1 text-[10px] text-[#5a5a70] hover:text-red-300"
              onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]) }}
            >
              <Trash2 className="h-3 w-3" />清空历史
            </button>
          </div>
          <div className="space-y-1">
            {history.map((item, index) => (
              <button
                key={index}
                className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left hover:border-[#252530] hover:bg-white/[0.03]"
                onClick={() => {
                  setDatasource(item.datasource)
                  setSql(item.sql)
                }}
              >
                <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[#8b8b9e]">{item.datasource}</span>
                <span className="truncate font-mono text-[11px] text-[#9a9aa4]">{item.sql}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
