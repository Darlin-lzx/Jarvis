import { Wifi, WifiOff, Settings, LogOut, User } from 'lucide-react'

interface TopBarProps {
  healthy: boolean
  onSettings?: () => void
  /** 当前登录用户显示名 */
  authUser?: string
  onLogout?: () => void
}

export function TopBar({ healthy, onSettings, authUser, onLogout }: TopBarProps) {
  return (
    <div className="h-11 bg-[#12121a]/80 backdrop-blur-md border-b border-[#1e1e28] flex items-center justify-between px-5 shrink-0">
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
      {authUser && (
        <div className="flex items-center gap-2" data-auth-user>
          <User className="w-3.5 h-3.5 text-[#5a5a70]" />
          <span className="text-[11px] text-[#8b8b9e]">{authUser}</span>
          {onLogout && (
            <button
              className="flex items-center gap-1 rounded-lg border border-[#252530] px-2 py-1 text-[10px] text-[#8b8b9e] hover:border-red-500/40 hover:text-red-300 transition-colors"
              onClick={onLogout}
              title="退出登录"
            >
              <LogOut className="w-3 h-3" />退出
            </button>
          )}
        </div>
      )}
    </div>
  )
}
