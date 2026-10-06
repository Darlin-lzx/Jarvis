import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { KGOverview, KBTriple } from '@/lib/types'

export function KGPanel() {
  const [overview, setOverview] = useState<KGOverview | null>(null)
  const [query, setQuery] = useState('')
  const [triples, setTriples] = useState<KBTriple[]>([])
  const [terms, setTerms] = useState<string[]>([])
  const [rebuilding, setRebuilding] = useState(false)

  const load = async () => { const r = await api.kgOverview(); if (r.success) setOverview(r.data as KGOverview) }
  useEffect(() => { load() }, [])

  const handleRebuild = async () => { setRebuilding(true); await api.rebuildKG(); setRebuilding(false); load() }
  const handleSearch = async () => {
    if (!query.trim()) return; const r = await api.kgExpand(query.trim())
    if (r.success && r.data) { setTerms(r.data.terms || []); setTriples(r.data.triples || []) }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">知识图谱概览</h3>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mb-4">
          <div className="bg-[#26262d] border border-[#2f2f38] rounded-xl p-4 text-center"><div className="text-2xl font-bold text-white">{overview?.entities ?? '—'}</div><div className="text-xs text-[#9a9aa4] mt-1">实体</div></div>
          <div className="bg-[#26262d] border border-[#2f2f38] rounded-xl p-4 text-center"><div className="text-2xl font-bold text-white">{overview?.relations ?? '—'}</div><div className="text-xs text-[#9a9aa4] mt-1">关系</div></div>
        </div>
        <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleRebuild} disabled={rebuilding}>{rebuilding ? '🔄 重建中…' : '🔄 从知识库重建'}</Button>
      </Card>
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">图谱扩展查询</h3>
        <div className="flex gap-2 mb-3">
          <Input className="flex-1 bg-[#26262d] border-[#3a3a45]" placeholder="输入实体或问题" value={query} onChange={e => setQuery(e.target.value)} />
          <Button size="sm" variant="outline" onClick={handleSearch}>查询关联</Button>
        </div>
        {terms.length > 0 && <div className="flex gap-1 flex-wrap mb-2">{terms.map(t => <Badge key={t} variant="outline">{t}</Badge>)}</div>}
        {triples.length > 0 ? (
          <table className="w-full text-xs">
            <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">主体</th><th className="text-left p-2">关系</th><th className="text-left p-2">客体</th><th className="text-left p-2">来源</th></tr></thead>
            <tbody>{triples.map((t, i) => (<tr key={i} className="hover:bg-[#26262d]"><td className="p-2">{t.subject}</td><td className="p-2"><Badge variant="outline">{t.relation}</Badge></td><td className="p-2">{t.object}</td><td className="p-2 text-[#9a9aa4]">{t.doc || ''}</td></tr>))}</tbody>
          </table>
        ) : null}
      </Card>
    </div>
  )
}
