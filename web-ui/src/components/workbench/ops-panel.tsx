import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { OpsHealthRecord } from '@/lib/types'

export function OpsPanel() {
  const [history, setHistory] = useState<OpsHealthRecord[]>([])
  const [dsFilter, setDsFilter] = useState('')
  const [checking, setChecking] = useState(false)
  const [baseline, setBaseline] = useState<string | null>(null)
  const load = async () => { const r = await api.opsHealthHistory(); if (r.success) setHistory((r.data as OpsHealthRecord[]) || []) }
  useEffect(() => { load() }, [])
  const handleCheck = async () => { setChecking(true); await api.opsHealthCheck(dsFilter || undefined); setChecking(false); load() }
  const handleBaseline = async () => { setBaseline('⏳ 计算中…'); const r = await api.opsBaseline(); setBaseline(r.success ? JSON.stringify(r.data, null, 2) : '❌ ' + (r.detail || '')) }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">健康巡检</h3>
        <div className="flex gap-2 items-center flex-wrap">
          <Input className="w-48 bg-[#26262d] border-[#3a3a45]" placeholder="数据源名（留空=全部）" value={dsFilter} onChange={e => setDsFilter(e.target.value)} />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" disabled={checking} onClick={handleCheck}>{checking ? '⏳ 巡检中…' : '🚑 开始巡检'}</Button>
        </div>
        <table className="w-full text-[13px] mt-3">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">数据源</th><th className="text-left p-2">类型</th><th className="text-left p-2">状态</th><th className="text-left p-2">延迟</th><th className="text-left p-2">详情</th></tr></thead>
          <tbody>{history.length === 0 ? (<tr><td colSpan={5}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">尚未巡检</div></td></tr>) : history.map((h, i) => (
            <tr key={i} className="hover:bg-[#26262d]">
              <td className="p-2">{h.ds}</td><td className="p-2"><Badge variant="outline">{h.kind}</Badge></td>
              <td className="p-2"><Badge className={h.ok ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : 'text-[#f56c6c] bg-[#f56c6c26] border-[#f56c6c66]'}>{h.ok ? '正常' : '故障'}</Badge></td>
              <td className="p-2">{h.latency_ms}ms</td><td className="p-2 text-xs text-[#9a9aa4] truncate max-w-[200px]">{h.detail || ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">性能基线</h3>
        <Button size="sm" variant="outline" onClick={handleBaseline}>📈 生成性能基线</Button>
        {baseline && <pre className="mt-3 text-xs text-[#cdd3e0] bg-[#0f0f14] border border-[#2f2f38] rounded-lg p-3 max-h-80 overflow-auto whitespace-pre-wrap">{baseline}</pre>}
      </Card>
    </div>
  )
}
