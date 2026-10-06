import { Wifi, WifiOff, Settings } from 'lucide-react'

interface TopBarProps {
  healthy: boolean
  onSettings?: () => void
}

export function TopBar({ healthy, onSettings }: TopBarProps) {
  return (
    <div className="h-11 bg-[#12121a]/80 backdrop-blur-md border-b border-[#1e1e28] flex items-center justify-between px-5 shrink-0">
      <div className="flex items-center gap-2.5">
        <span className="font-semibold text-[13px] tracking-tight">数据库国产化智能体</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${healthy ? 'bg-green-500 glow-success' : 'bg-red-500 glow-danger'}`} />
          <span className="text-[11px] text-[#5a5a70]">{healthy ? '服务正常' : '服务离线'}</span>
          {healthy ? <Wifi className="w-3.5 h-3.5 text-green-500/60" /> : <WifiOff className="w-3.5 h-3.5 text-red-500/60" />}
        </div>
        {onSettings && (
          <button
            className="text-[#5a5a70] hover:text-[#9a9ab0] p-1.5 rounded-lg hover:bg-white/[0.03] transition-colors"
            onClick={onSettings}
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
