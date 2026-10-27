import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, setToken } from '@/lib/api'
import { Layers, CircleAlert } from 'lucide-react'

/** 平台登录页：用户名密码登录，成功后进入工作台 */
export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    setLoading(true)
    setError('')
    const response = await api.login(username.trim(), password)
    setLoading(false)
    if (response.success && response.data) {
      setToken(response.data.token)
      onSuccess()
    } else {
      setError(response.error || '登录失败')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f0f14]" data-login-page>
      <div className="w-[380px] rounded-2xl border border-[#252530] bg-[#16161e] p-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15">
            <Layers className="h-6 w-6 text-indigo-400" />
          </div>
          <h1 className="text-[19px] font-semibold tracking-wide text-[#e4e4e9]">Jarvis</h1>
          <p className="text-[11px] text-[#5a5a70]">跨工程迭代开发多Agent智能编排平台 · 请登录</p>
        </div>
        <div className="space-y-3">
          <label className="block space-y-1 text-[11px] text-[#8b8b9e]">
            <span>用户名</span>
            <Input
              className="h-9 bg-[#0f0f14] text-[13px]"
              value={username}
              autoComplete="username"
              onChange={event => setUsername(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && void submit()}
            />
          </label>
          <label className="block space-y-1 text-[11px] text-[#8b8b9e]">
            <span>密码</span>
            <Input
              type="password"
              className="h-9 bg-[#0f0f14] text-[13px]"
              value={password}
              autoComplete="current-password"
              onChange={event => setPassword(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && void submit()}
            />
          </label>
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />{error}
            </div>
          )}
          <Button className="h-9 w-full text-[13px]" disabled={loading} onClick={() => void submit()}>
            {loading ? '登录中…' : '登 录'}
          </Button>
        </div>
      </div>
    </div>
  )
}
