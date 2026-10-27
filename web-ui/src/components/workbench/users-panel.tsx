import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CircleAlert, Plus, UserRound, KeyRound, Trash2 } from 'lucide-react'

interface UserRow {
  username: string
  display_name: string
  role: string
  created_at: string | null
}

/** 用户管理（仅管理员）：查看/创建用户、重置密码、删除 */
export function UsersPanel({ currentUser }: { currentUser: string }) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await api.listAuthUsers()
    if (response.success && response.data) {
      setUsers(response.data as UserRow[])
      setError('')
    } else {
      setError(response.error || '用户列表加载失败')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  async function createUser() {
    if (!username.trim() || !password) {
      setError('请填写用户名和初始密码')
      return
    }
    setCreating(true)
    setError('')
    const response = await api.createAuthUser({
      username: username.trim(), password, display_name: displayName.trim(), role,
    })
    setCreating(false)
    if (response.success) {
      setNotice(response.data?.message || '创建成功')
      setUsername(''); setDisplayName(''); setPassword('')
      void load()
    } else {
      setError(response.error || '创建失败')
    }
  }

  async function resetPassword(user: string) {
    const newPwd = window.prompt(`为用户 ${user} 设置新密码（至少 8 位）：`)
    if (!newPwd) return
    const response = await api.resetAuthUserPassword(user, newPwd)
    if (response.success) {
      setNotice(response.data?.message || '密码已重置')
      setError('')
    } else {
      setError(response.error || '重置失败')
    }
  }

  async function deleteUser(user: string) {
    if (!window.confirm(`确认删除用户 ${user}？其登录会话将一并失效。`)) return
    const response = await api.deleteAuthUser(user)
    if (response.success) {
      setNotice(response.data?.message || '已删除')
      setError('')
      void load()
    } else {
      setError(response.error || '删除失败')
    }
  }

  return (
    <div className="space-y-3" data-users-panel>
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 text-indigo-400" />
        <h2 className="text-[15px] font-semibold text-[#e4e4e9]">用户管理</h2>
        <span className="rounded border border-[#3a3a45] bg-white/5 px-1.5 py-0.5 text-[10px] text-[#8b8b9e]">
          仅管理员可见 · 角色决定可否管理用户
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />{error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">
          {notice}
        </div>
      )}

      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        <div className="mb-2 text-[12px] font-medium text-[#e4e4e9]">新建用户</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>用户名</span>
            <Input className="h-8 w-[180px] bg-[#0f0f14] text-[12px]" value={username}
              onChange={e => setUsername(e.target.value)} />
          </label>
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>显示名</span>
            <Input className="h-8 w-[140px] bg-[#0f0f14] text-[12px]" value={displayName}
              onChange={e => setDisplayName(e.target.value)} placeholder="默认同用户名" />
          </label>
          <label className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>初始密码（≥8 位）</span>
            <Input className="h-8 w-[180px] bg-[#0f0f14] text-[12px]" value={password}
              onChange={e => setPassword(e.target.value)} />
          </label>
          <div className="space-y-1 text-[11px] text-[#8b8b9e]">
            <span>角色</span>
            <div className="flex h-8 items-center overflow-hidden rounded-md border border-[#252530]">
              {(['user', 'admin'] as const).map(item => (
                <button key={item}
                  className={cn('h-8 px-3 text-[11px]', role === item ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5')}
                  onClick={() => setRole(item)}>
                  {item === 'admin' ? '管理员' : '普通用户'}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" className="h-8" disabled={creating} onClick={() => void createUser()}>
            <Plus className="mr-1 h-3.5 w-3.5" />{creating ? '创建中…' : '创建用户'}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        <div className="mb-2 text-[12px] font-medium text-[#e4e4e9]">用户列表（{users.length}）</div>
        {loading ? (
          <div className="py-6 text-center text-[12px] text-[#8b8b9e]">加载中…</div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[#252530]">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead className="bg-[#20202c]">
                <tr>
                  {['用户名', '显示名', '角色', '创建时间', '操作'].map(title => (
                    <th key={title} className="whitespace-nowrap border-b border-[#3d3d4a] px-2.5 py-1.5 font-semibold text-[#e8e8f0]">{title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.username} className="border-b border-[#1d1d26] hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[#cdd3e0]">{user.username}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-[#cdd3e0]">{user.display_name || '—'}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5">
                      <span className={cn('rounded border px-1.5 py-0.5 text-[10px]',
                        user.role === 'admin'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                          : 'border-[#3a3a45] bg-white/5 text-[#8b8b9e]')}>
                        {user.role === 'admin' ? '管理员' : '普通用户'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-[#8b8b9e]">{user.created_at ?? '—'}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <button
                          className="flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20"
                          onClick={() => void resetPassword(user.username)}>
                          <KeyRound className="h-3 w-3" />重置密码
                        </button>
                        {user.username !== currentUser && (
                          <button
                            className="flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/20"
                            onClick={() => void deleteUser(user.username)}>
                            <Trash2 className="h-3 w-3" />删除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
