import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { CircleAlert } from 'lucide-react'

/** 修改当前登录用户密码 */
export function ChangePasswordDialog({
  open, onOpenChange, onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: (message: string) => void
}) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!oldPassword || !newPassword) {
      setError('请填写原密码和新密码')
      return
    }
    if (newPassword.length < 8) {
      setError('新密码长度至少 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    setLoading(true)
    setError('')
    const response = await api.changePassword(oldPassword, newPassword)
    setLoading(false)
    if (response.success) {
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      onOpenChange(false)
      onDone?.('密码修改成功')
    } else {
      setError(response.error || '修改失败')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle className="text-[15px]">修改密码</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-[11px] text-[#8b8b9e]">
            <span>原密码</span>
            <Input type="password" className="h-9 bg-[#0f0f14] text-[13px]" value={oldPassword}
              onChange={e => setOldPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="block space-y-1 text-[11px] text-[#8b8b9e]">
            <span>新密码（至少 8 位）</span>
            <Input type="password" className="h-9 bg-[#0f0f14] text-[13px]" value={newPassword}
              onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="block space-y-1 text-[11px] text-[#8b8b9e]">
            <span>确认新密码</span>
            <Input type="password" className="h-9 bg-[#0f0f14] text-[13px]" value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" />
          </label>
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />{error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" className="h-8" disabled={loading} onClick={() => void submit()}>
            {loading ? '提交中…' : '确认修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
