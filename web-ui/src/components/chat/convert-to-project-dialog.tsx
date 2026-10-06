import { useState, useEffect } from 'react'
import { FolderKanban } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Space } from '@/lib/types'

/* ======== 快速问答 → 项目会话：选择空间与子系统 ======== */
export function ConvertToProjectDialog({ open, spaces, onClose, onConfirm }: {
  open: boolean
  spaces: Space[]
  onClose: () => void
  onConfirm: (spaceId: number, subId?: number) => void
}) {
  const [sid, setSid] = useState<number | null>(null)
  const [subId, setSubId] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (open) {
      setSid(spaces.length > 0 ? spaces[0].id : null)
      setSubId(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!open) return null
  const current = spaces.find(s => s.id === sid)
  const subs = current?.subsystems ?? []
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[420px] rounded-xl bg-[#1a1a24] border border-[#252530] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#252530]">
          <h3 className="text-[14px] font-semibold text-[#e4e4e9]">转为项目会话</h3>
          <p className="text-[11px] text-[#5a5a70] mt-0.5">绑定空间后，本会话产物可入库、Agent 可读取该空间知识库与数据源</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-[11px] text-[#8b8b9e] mb-1.5 block">选择空间</label>
            {spaces.length === 0 ? (
              <div className="text-[12px] text-amber-400/90 py-3 text-center border border-amber-500/20 rounded-lg bg-amber-500/5">
                暂无可用空间，请先创建空间
              </div>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {spaces.map(s => (
                  <button
                    key={s.id}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] transition-colors text-left',
                      sid === s.id ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-[#252530] bg-[#16161e] text-[#cdd3e0] hover:border-[#3a3a45]'
                    )}
                    onClick={() => { setSid(s.id); setSubId(undefined) }}
                  >
                    <FolderKanban className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate flex-1">{s.name}</span>
                    <span className="text-[10px] text-[#5a5a70]">{s.subsystems?.length ?? 0} 个子系统</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {current && (
            <div>
              <label className="text-[11px] text-[#8b8b9e] mb-1.5 block">归属子系统（可选）</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  className={cn(
                    'px-3 py-1.5 rounded-lg border text-[12px] transition-colors',
                    subId == null ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-[#252530] bg-[#16161e] text-[#8b8b9e] hover:border-[#3a3a45]'
                  )}
                  onClick={() => setSubId(undefined)}
                >
                  不绑定
                </button>
                {subs.map(x => (
                  <button
                    key={x.id}
                    className={cn(
                      'px-3 py-1.5 rounded-lg border text-[12px] transition-colors',
                      subId === x.id ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-[#252530] bg-[#16161e] text-[#8b8b9e] hover:border-[#3a3a45]'
                    )}
                    onClick={() => setSubId(x.id)}
                  >
                    {x.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#252530]">
          <Button size="sm" variant="outline" className="text-[12px] h-8 border-[#252530] text-[#9a9aa4]" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            className="text-[12px] h-8 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white hover:opacity-90"
            disabled={sid == null}
            onClick={() => { if (sid != null) onConfirm(sid, subId) }}
          >
            转为项目会话
          </Button>
        </div>
      </div>
    </div>
  )
}