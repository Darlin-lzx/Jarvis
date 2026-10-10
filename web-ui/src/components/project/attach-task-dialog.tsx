import { useEffect, useState } from 'react'
import { X, Loader2, FolderPlus } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export function AttachTaskDialog({ open, onClose, convId, spaceId, onAttached }: {
  open: boolean
  onClose: () => void
  convId: number | null
  spaceId?: number
  onAttached: (d: { task_id: number; task_name: string }) => void
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [tasks, setTasks] = useState<{ id: number; name: string }[]>([])
  const [taskId, setTaskId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSaving(false)
    if (spaceId) api.listTasks(spaceId).then(r => { if (r.success) setTasks(r.data || []) })
  }, [open, spaceId])

  const submit = async () => {
    if (!convId) return
    setSaving(true)
    try {
      const payload = mode === 'existing'
        ? { task_id: taskId === '' ? undefined : taskId }
        : { name }
      const r = await api.attachTask(convId, payload)
      if (r.success && r.data) { onAttached(r.data); onClose() }
      else setSaving(false)
    } catch { setSaving(false) }
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div className="bg-[#16161e] border border-[#252530] rounded-2xl w-[440px] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold flex items-center gap-2"><FolderPlus className="w-4 h-4 text-indigo-400" />另存为任务</h3>
          <button onClick={onClose} className="text-[#5a5a70] hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[12px] text-[#5a5a70] mb-4">把当前独立会话挂载到任务，会话及其全部产物将自动关联任务</p>
        <div className="flex items-center gap-2 mb-4">
          {(['existing', 'new'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={cn('px-3 h-8 rounded-lg text-[12px]', mode === m ? 'bg-[#5b7cfa] text-white' : 'bg-[#16161e] text-[#8b8b9e] border border-[#252530]')}>
              {m === 'existing' ? '挂载已有任务' : '新建任务'}
            </button>
          ))}
        </div>
        {mode === 'existing' ? (
          <select value={taskId} onChange={e => setTaskId(e.target.value ? Number(e.target.value) : '')}
            className="w-full h-9 rounded-lg bg-[#0f0f14] border border-[#252530] px-3 text-[13px] mb-4">
            <option value="">选择任务…</option>
            {tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : (
          <div className="space-y-3 mb-4">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="任务名称（必填）"
              className="w-full h-9 rounded-lg bg-[#0f0f14] border border-[#252530] px-3 text-[13px]" />
          </div>
        )}
        <button onClick={submit} disabled={saving || (mode === 'existing' ? !taskId : !name.trim())}
          className="w-full h-9 rounded-lg bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white text-[13px] disabled:opacity-40">
          {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : '确认关联'}
        </button>
      </div>
    </div>
  )
}
