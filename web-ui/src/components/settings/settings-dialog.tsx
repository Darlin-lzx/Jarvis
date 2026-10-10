import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import type { Settings } from '@/lib/types'
import { Radio } from 'lucide-react'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [form, setForm] = useState<Settings>({ provider: 'ollama', model: '', base_url: '', api_key: '', embedding_model: '' })
  const [models, setModels] = useState<string[]>([])

  useEffect(() => {
    if (open) { api.getSettings().then(r => { if (r.success && r.data) setForm(r.data) }) }
  }, [open])

  const handleFetchModels = async () => {
    const r = await api.listModels({ type: 'LLM', enabled: true })
    if (r.success && r.data) setModels(r.data.map(m => m.name || m.model_id))
  }

  const handleSave = async () => { await api.updateSettings(form); onOpenChange(false) }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#16161e] border-[#252530] text-[#e4e4e9] max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">模型设置</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-[11px] text-[#6a6a7a] font-medium">LLM 提供商</Label>
            <Select value={form.provider} onValueChange={v => setForm({ ...form, provider: v })}>
              <SelectTrigger className="bg-[#1a1a24] border-[#252530] rounded-lg"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="ollama">Ollama（本地）</SelectItem><SelectItem value="deepseek">DeepSeek</SelectItem><SelectItem value="bailian">阿里云百炼</SelectItem><SelectItem value="zhipu">智谱 GLM</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-[11px] text-[#6a6a7a] font-medium">模型</Label>
            <div className="flex gap-2">
              <Input className="flex-1 bg-[#1a1a24] border-[#252530] rounded-lg" placeholder="qwen2.5 / deepseek-chat" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} />
              <Button size="sm" variant="outline" className="rounded-lg" onClick={handleFetchModels}>
                <Radio className="w-3.5 h-3.5 mr-1" />模型列表
              </Button>
            </div>
            {models.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {models.map(m => (
                  <button key={m} className="px-2.5 py-1 text-[11px] rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-colors" onClick={() => setForm({ ...form, model: m })}>
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label className="text-[11px] text-[#6a6a7a] font-medium">Base URL</Label>
            <Input className="bg-[#1a1a24] border-[#252530] rounded-lg" placeholder="http://localhost:11434" value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label className="text-[11px] text-[#6a6a7a] font-medium">API Key</Label>
            <Input className="bg-[#1a1a24] border-[#252530] rounded-lg" type="password" placeholder="DeepSeek/百炼/智谱 必填" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label className="text-[11px] text-[#6a6a7a] font-medium">Embedding 模型</Label>
            <Input className="bg-[#1a1a24] border-[#252530] rounded-lg" placeholder="nomic-embed-text" value={form.embedding_model} onChange={e => setForm({ ...form, embedding_model: e.target.value })} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="rounded-lg" onClick={() => onOpenChange(false)}>取消</Button>
          <Button className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white rounded-lg hover:from-indigo-400 hover:to-purple-500" onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
