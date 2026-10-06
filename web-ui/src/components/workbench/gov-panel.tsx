import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { GovAsset, GovQualityRow } from '@/lib/types'

export function GovPanel() {
  const [assets, setAssets] = useState<GovAsset[]>([])
  const [quality, setQuality] = useState<GovQualityRow[]>([])
  const [dsFilter, setDsFilter] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [scoring, setScoring] = useState(false)
  const load = async () => {
    const [ar, qr] = await Promise.all([api.govAssets(dsFilter), api.govQualityRows(dsFilter)])
    if (ar.success) setAssets((ar.data as GovAsset[]) || [])
    if (qr.success) setQuality((qr.data as GovQualityRow[]) || [])
  }
  useEffect(() => { load() }, [])
  const handleCatalog = async () => { setExtracting(true); await api.govCatalog(dsFilter || undefined); setExtracting(false); load() }
  const handleQuality = async () => { setScoring(true); await api.govQuality(dsFilter || undefined); setScoring(false); load() }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">元数据资产目录</h3>
        <div className="flex gap-2 items-center flex-wrap">
          <Input className="w-48 bg-[#26262d] border-[#3a3a45]" placeholder="数据源名（留空=全部）" value={dsFilter} onChange={e => setDsFilter(e.target.value)} />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" disabled={extracting} onClick={handleCatalog}>{extracting ? '⏳ 抽取中…' : '🗂️ 抽取资产目录'}</Button>
          <Button size="sm" variant="outline" onClick={() => api.govKgSync()}>🧠 同步知识图谱</Button>
        </div>
        <table className="w-full text-[13px] mt-3">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">数据源</th><th className="text-left p-2">对象</th><th className="text-left p-2">类型</th><th className="text-left p-2">列数</th><th className="text-left p-2">行数</th><th className="text-left p-2">主键</th></tr></thead>
          <tbody>{assets.length === 0 ? (<tr><td colSpan={6}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">尚未抽取</div></td></tr>) : assets.map((a, i) => (
            <tr key={i} className="hover:bg-[#26262d]">
              <td className="p-2">{a.ds}</td><td className="p-2">{a.object}</td>
              <td className="p-2"><Badge variant="outline">{a.obj_type}</Badge></td>
              <td className="p-2">{a.columns?.length || 0}</td>
              <td className="p-2">{a.row_count < 0 ? '—' : a.row_count}</td>
              <td className="p-2 text-xs">{a.pk || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">数据质量评分</h3>
        <Button size="sm" variant="outline" disabled={scoring} onClick={handleQuality}>{scoring ? '⏳ 评分中…' : '🔍 质量评分'}</Button>
        <table className="w-full text-[13px] mt-3">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">数据源</th><th className="text-left p-2">对象</th><th className="text-left p-2">行数</th><th className="text-left p-2">非空率</th><th className="text-left p-2">唯一率</th><th className="text-left p-2">空值率</th><th className="text-left p-2">评分</th><th className="text-left p-2">问题</th></tr></thead>
          <tbody>{quality.length === 0 ? (<tr><td colSpan={8}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">尚未评分</div></td></tr>) : quality.map((q, i) => (
            <tr key={i} className="hover:bg-[#26262d]">
              <td className="p-2">{q.ds}</td><td className="p-2">{q.object}</td>
              <td className="p-2">{q.row_count}</td><td className="p-2">{q.filled_rate}%</td>
              <td className="p-2">{q.unique_rate}%</td><td className="p-2">{q.null_rate}%</td>
              <td className="p-2"><Badge className={q.score >= 80 ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : q.score >= 50 ? '' : 'text-[#f56c6c] bg-[#f56c6c26] border-[#f56c6c66]'}>{q.score}</Badge></td>
              <td className="p-2 text-xs text-[#9a9aa4]">{q.issues?.join('；') || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
    </div>
  )
}
