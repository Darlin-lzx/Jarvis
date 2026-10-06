import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 面包屑分段：最后一级（无 onClick）白色加粗不可点击，其余可点击回退 */
export interface CrumbSegment {
  label: string
  full?: string
  onClick?: () => void
}

/** 任务页面包屑：任务 > 空间 / 子系统 [清除筛选]，与左侧导航 / 顶部下拉双向联动 */
export function TaskBreadcrumb({ segments, onClear, showClear }: {
  segments: CrumbSegment[]
  onClear?: () => void
  showClear?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5 mb-3 min-w-0 flex-wrap">
      {segments.map((s, i) => {
        const last = i === segments.length - 1
        const clickable = !!s.onClick && !last
        return (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span className="text-[11px] text-[#3a3a48] shrink-0">/</span>}
            {clickable ? (
              <button
                onClick={s.onClick}
                title={s.full || s.label}
                className="text-[12px] text-indigo-400 hover:text-indigo-300 hover:underline underline-offset-4 transition-colors max-w-[160px] truncate"
              >
                {s.label}
              </button>
            ) : (
              <span
                title={last ? (s.full || s.label) : undefined}
                className={cn(
                  'text-[12px] max-w-[180px] truncate',
                  last ? 'text-[#e4e4e9] font-semibold' : 'text-[#8b8b9e]',
                )}
              >
                {s.label}
              </span>
            )}
          </span>
        )
      })}
      {showClear && onClear && (
        <button
          onClick={onClear}
          className="ml-1 h-6 px-2 rounded-md border border-[#2a2a35] text-[10px] text-[#8b8b9e] hover:text-[#cdd3e0] hover:border-[#3a3a48] transition-colors flex items-center gap-1 shrink-0"
          title="清除全部筛选：回到全部空间、全部子系统、全部状态"
        >
          <X className="w-2.5 h-2.5" />清除筛选
        </button>
      )}
    </div>
  )
}