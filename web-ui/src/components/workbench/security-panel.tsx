import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { SecurityLog } from '@/lib/types'

export function SecurityPanel() {
  const [logs, setLogs] = useState<SecurityLog[]>([])
  const [pathFilter, setPathFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const load = async () => { const r = await api.securityLogs(); if (r.success) setLogs((r.data as SecurityLog[]) || []) }
  useEffect(() => { load() }, [])

  const filtered = logs.filter(x => {
    if (pathFilter && pathFilter !== 'all' && !(x.path || '').includes(pathFilter)) return false
    if (statusFilter && statusFilter !== 'all') {
      const s = String(x.status)
      if (statusFilter === '0') { if (s !== '429' && s !== '401') return false }
      else if (!s.startsWith(statusFilter)) return false
    }
    return true
  })

  return (
    <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
      <h3 className="text-sm font-semibold mb-3">API 请求审计日志</h3>
      <div className="flex gap-2 items-center mb-3 flex-wrap">
        <span className="text-xs text-[#9a9aa4]">筛选：</span>
        <Select value={pathFilter} onValueChange={setPathFilter}>
          <SelectTrigger className="w-52 bg-[#26262d] border-[#3a3a45]"><SelectValue placeholder="全部路径" /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部路径</SelectItem><SelectItem value="datasources">数据源</SelectItem><SelectItem value="chat">对话</SelectItem><SelectItem value="kg">知识图谱</SelectItem><SelectItem value="agents">智能体</SelectItem></SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 bg-[#26262d] border-[#3a3a45]"><SelectValue placeholder="全部状态" /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="2">2xx 成功</SelectItem><SelectItem value="4">4xx/5xx</SelectItem><SelectItem value="0">拦截记录</SelectItem></SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={load}>刷新</Button>
        <span className="text-xs text-[#9a9aa4]">当前 {filtered.length} / {logs.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">时间</th><th className="text-left p-2">方法</th><th className="text-left p-2">路径</th><th className="text-left p-2">IP</th><th className="text-left p-2">状态</th><th className="text-left p-2">耗时</th><th className="text-left p-2">备注</th></tr></thead>
          <tbody>{filtered.length === 0 ? (<tr><td colSpan={7}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无日志</div></td></tr>) : filtered.map((l, i) => {
            const st = String(l.status); const isDeny = st === '401' || st === '429'
            return (
              <tr key={i} className="hover:bg-[#26262d]">
                <td className="p-2 whitespace-nowrap text-xs">{l.created_at ? new Date(l.created_at).toLocaleString() : ''}</td>
                <td className="p-2"><Badge variant="outline">{l.method}</Badge></td>
                <td className="p-2 font-mono text-xs truncate max-w-[260px]">{l.path}</td>
                <td className="p-2">{l.ip}</td>
                <td className="p-2"><Badge className={isDeny ? 'text-[#f56c6c] bg-[#f56c6c26] border-[#f56c6c66]' : st.startsWith('2') ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{isDeny ? '⛔ ' : ''}{st}</Badge></td>
                <td className="p-2">{l.duration_ms}ms</td>
                <td className="p-2 text-xs text-[#9a9aa4] truncate max-w-[220px]">{l.notes || ''}</td>
              </tr>
            )
          })}</tbody>
        </table>
      </div>
    </Card>
  )
}
