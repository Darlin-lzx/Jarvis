import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Package, FolderOpen, X } from 'lucide-react'

interface ArtifactSidebarProps {
  convId: number | null
}

export function ArtifactSidebar({ convId }: ArtifactSidebarProps) {
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)

  useEffect(() => {
    if (convId == null) { setNamespaces([]); return }
    api.listArtifacts(convId).then(r => {
      if (r.success) setNamespaces(((r.data as unknown as string[]) || []))
    })
  }, [convId])

  return (
    <>
      <aside className="w-56 shrink-0 bg-[#0f0f14] border-l border-[#1e1e28] flex flex-col">
        <div className="px-4 py-3 border-b border-[#1e1e28]">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#6a6a7a]">
            <Package className="w-3.5 h-3.5" />
            <span>产物</span>
          </div>
        </div>
        <ScrollArea className="flex-1 px-3 py-2">
          {convId == null ? (
            <div className="flex flex-col items-center justify-center py-10 text-[#5a5a70]">
              <Package className="w-6 h-6 mb-2 opacity-40" />
              <span className="text-[11px]">选择会话查看产物</span>
            </div>
          ) : namespaces.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-[#5a5a70]">
              <FolderOpen className="w-6 h-6 mb-2 opacity-40" />
              <span className="text-[11px]">本会话暂无产物</span>
            </div>
          ) : (
            <div className="space-y-1">
              {namespaces.map(ns => (
                <div key={ns} className="px-2.5 py-2 rounded-lg hover:bg-white/[0.03] cursor-pointer transition-colors group">
                  <div className="flex items-center gap-2 text-[12px] text-[#8b8b9e] group-hover:text-[#c4c4d0]">
                    <FolderOpen className="w-3.5 h-3.5 text-indigo-400/50" />
                    <span className="truncate">{ns.split('/').slice(1).join(' / ')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>

      {/* Preview modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setPreview(null)}>
          <div className="bg-[#16161e] border border-[#252530] rounded-2xl w-[760px] max-h-[88vh] p-6 overflow-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold">{preview.title}</h3>
              <button onClick={() => setPreview(null)} className="text-[#5a5a70] hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="bg-[#0a0a0e] border border-[#252530] rounded-xl p-4 text-xs text-[#c4c4d0] whitespace-pre-wrap max-h-[62vh] overflow-auto font-mono">{preview.content}</pre>
          </div>
        </div>
      )}
    </>
  )
}
