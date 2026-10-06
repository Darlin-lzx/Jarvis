import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { VectorSpaceStat } from '@/lib/types'
import {
  Search, RefreshCw, Database, AlertTriangle, XCircle, CheckCircle2, Loader2
} from 'lucide-react'

/* ---- 类型 ---- */
type StatusFilter = '全部' | '正常' | '异常'

/* ---- 状态图标 ---- */
function StatusIcon({ status }: { status: VectorSpaceStat['status'] }) {
  if (status === '正常') {
    return <span className="inline-flex items-center gap-1 text-[11px] text-green-400"><CheckCircle2 className="w-3.5 h-3.5" />正常</span>
  }
  if (status === '无向量数据') {
    return <span className="inline-flex items-center gap-1 text-[11px] text-yellow-400"><AlertTriangle className="w-3.5 h-3.5" />无向量数据</span>
  }
  return <span className="inline-flex items-center gap-1 text-[11px] text-red-400"><XCircle className="w-3.5 h-3.5" />索引异常</span>
}

/* ---- 主组件 ---- */
export function VectorPanel() {
  const [vectorKBs, setVectorKBs] = useState<VectorSpaceStat[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('全部')

  const load = async () => {
    setLoading(true)
    setLoadError('')
    const r = await api.getVectorStats().catch(e => ({ success: false, error: String(e), data: undefined as VectorSpaceStat[] | undefined }))
    if (r.success) setVectorKBs((r.data as VectorSpaceStat[]) || [])
    else setLoadError((r as { error?: string }).error || '加载向量库统计失败')
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = vectorKBs.filter(kb => {
    const matchSearch = !searchQ || kb.name.toLowerCase().includes(searchQ.toLowerCase()) || kb.key.toLowerCase().includes(searchQ.toLowerCase())
    const matchStatus =
      statusFilter === '全部' ||
      (statusFilter === '正常' && kb.status === '正常') ||
      (statusFilter === '异常' && kb.status !== '正常')
    return matchSearch && matchStatus
  })

  const statusOptions: StatusFilter[] = ['全部', '正常', '异常']

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">向量库管理</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4a4a5a]" />
            <Input
              className="h-8 pl-8 pr-3 w-48 text-[12px] bg-[#16161e] border-[#252530] placeholder:text-[#4a4a5a]"
              placeholder="知识库名称搜索"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-[12px] text-[#9a9aa4] hover:text-indigo-400"
            onClick={load}
          >
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1', loading && 'animate-spin')} />
            刷新状态
          </Button>
        </div>
      </div>

      {/* 筛选 */}
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-[#5a5a70] mr-1">筛选：</span>
        {statusOptions.map(opt => (
          <button
            key={opt}
            className={cn(
              'px-2.5 py-1 rounded-md text-[11px] transition-colors',
              statusFilter === opt
                ? 'bg-indigo-500/10 text-indigo-400'
                : 'text-[#5a5a70] hover:text-[#9a9aa4] hover:bg-white/[0.03]'
            )}
            onClick={() => setStatusFilter(opt)}
          >
            {opt}
          </button>
        ))}
      </div>

      {/* 加载失败 */}
      {loadError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[12px] text-red-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {loadError}
          <button className="ml-auto underline hover:no-underline" onClick={load}>重试</button>
        </div>
      )}

      {/* 内容区 */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-[#5a5a70] animate-spin" />
        </div>
      ) : !loadError && filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Database className="w-10 h-10 text-[#2a2a35] mb-3" />
          <p className="text-[13px] text-[#5a5a70] mb-1">暂无向量库数据</p>
          <p className="text-[11px] text-[#3a3a4a]">
            当前空间知识库还未产生任何向量数据，请先上传文档或入库产物
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[#252530] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#252530] bg-[#16161e]">
                <th className="text-left px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">知识库名称</th>
                <th className="text-center px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">文档总数</th>
                <th className="text-center px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">向量总数</th>
                <th className="text-center px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">Chunk总数</th>
                <th className="text-center px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">存储占用</th>
                <th className="text-center px-3 py-2.5 text-[11px] font-medium text-[#5a5a70]">状态</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(kb => (
                <tr key={kb.id} className="border-b border-[#1e1e28] hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Database className="w-3.5 h-3.5 text-[#5a5a70] shrink-0" />
                      <div>
                        <span className="text-[12px] text-[#cdd3e0] font-medium">{kb.name}</span>
                        <span className="text-[10px] text-[#4a4a5a] ml-1.5 font-mono">{kb.key}</span>
                      </div>
                    </div>
                  </td>
                  <td className="text-center px-3 py-2.5 text-[12px] text-[#9a9aa4]">{kb.docCount}</td>
                  <td className="text-center px-3 py-2.5 text-[12px] text-[#9a9aa4]">{kb.vectorCount}</td>
                  <td className="text-center px-3 py-2.5 text-[12px] text-[#9a9aa4]">{kb.chunkCount}</td>
                  <td className="text-center px-3 py-2.5 text-[12px] text-[#9a9aa4]">{kb.storageMB}MB</td>
                  <td className="text-center px-3 py-2.5">
                    <StatusIcon status={kb.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 底部计数 */}
      {filtered.length > 0 && (
        <div className="text-[11px] text-[#4a4a5a]">
          共 {filtered.length} 个知识库 · 向量统计来自 FAISS 索引与知识库文档表（真实数据）
        </div>
      )}
    </div>
  )
}
