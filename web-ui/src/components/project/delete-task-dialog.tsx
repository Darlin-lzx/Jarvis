import { useEffect } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'

interface DeleteTaskDialogProps {
  open: boolean
  taskName: string
  deleting?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteTaskDialog({
  open,
  taskName,
  deleting = false,
  onCancel,
  onConfirm,
}: DeleteTaskDialogProps) {
  useEffect(() => {
    if (!open || deleting) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, deleting, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => {
        if (!deleting) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="删除任务"
        className="w-[min(440px,100%)] overflow-hidden rounded-xl border border-[#2a2a35] bg-[#16161e] shadow-2xl shadow-black/50"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-red-500/25 bg-red-500/10">
              <AlertTriangle className="h-[18px] w-[18px] text-red-400" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold text-[#e4e4e9]">删除任务</h3>
              <div
                className="mt-2 line-clamp-2 break-all text-[13px] font-medium text-[#cdd3e0]"
                title={taskName}
              >
                {taskName}
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2 rounded-lg border border-red-500/15 bg-red-500/[0.06] p-3 text-[12px] leading-relaxed">
            <div className="flex items-start gap-2 text-[#cdd3e0]">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-red-400" />
              <span>将级联删除该任务下全部会话与产物</span>
            </div>
            <div className="flex items-start gap-2 text-[#9a9aa4]">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[#5a5a70]" />
              <span>知识库已入库副本保留，不受本次删除影响</span>
            </div>
            <div className="flex items-start gap-2 text-[#9a9aa4]">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[#5a5a70]" />
              <span>此操作不可恢复，请确认后再继续</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#252530] bg-[#12121a] px-5 py-3.5">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="h-8 rounded-lg border border-[#2f2f38] px-3 text-[12px] text-[#9a9aa4] transition-colors hover:border-[#3a3a48] hover:text-[#cdd3e0] disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-red-500 px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {deleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
