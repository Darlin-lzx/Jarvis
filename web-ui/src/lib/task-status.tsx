import { cn } from '@/lib/utils'
import type { TaskStatus } from '@/lib/types'

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待执行', running: '执行中', done: '已完成', failed: '失败', paused: '已暂停',
}

const TASK_STATUS_CLS: Record<TaskStatus, string> = {
  pending: 'text-[#9a9aa4] bg-[#26262d]',
  running: 'text-blue-400 bg-blue-500/15',
  done: 'text-green-400 bg-green-500/15',
  failed: 'text-red-400 bg-red-500/15',
  paused: 'text-amber-400 bg-amber-500/15',
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={cn('text-[10px] px-2 py-0.5 rounded-full shrink-0', TASK_STATUS_CLS[status])}>
      {TASK_STATUS_LABEL[status]}
    </span>
  )
}