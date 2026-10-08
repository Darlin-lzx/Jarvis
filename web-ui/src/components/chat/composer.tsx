import { useState, useRef, type KeyboardEvent, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Square, AtSign, Plus, ChevronDown, Mic, Paperclip, Loader2, X, Info } from 'lucide-react'
import { agentDisplayName } from './agent-tabs'
import { ReferencePicker } from './reference-picker'
import { api } from '@/lib/api'
import type { Agent, SendExtra, ChatReference, AttachmentItem } from '@/lib/types'

interface ComposerProps {
  onSend: (text: string, extra?: SendExtra) => void
  onStop?: () => void
  disabled: boolean
  activeAgent?: string
  convId?: number | null
  spaceId?: number | null
  /** 后端智能体列表（仅用于展示当前指派名，不再提供切换入口） */
  agentList?: Agent[]
  /** 当前迁移阶段（状态机，与 pipeline 一致） */
  currentStage?: string
}

export function Composer({ onSend, onStop, disabled, activeAgent, convId, spaceId, agentList, currentStage }: ComposerProps) {
  const agents = agentList && agentList.length > 0 ? agentList : []
  const currentAgent = agents.find(a => a.id === activeAgent)
  const [text, setText] = useState('')
  const [showRefPicker, setShowRefPicker] = useState(false)
  const [references, setReferences] = useState<ChatReference[]>([])
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState('')
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed && references.length === 0 && attachments.length === 0) return
    onSend(trimmed, {
      references: references.length > 0 ? references : undefined,
      attachment_ids: attachments.length > 0 ? attachments.map(a => a.id) : undefined,
    })
    setText('')
    setReferences([])
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // @ 引用选择器确认：追加正文占位文本 + 并入 references（按 type+id 去重；类型=agent 同样按此规则）
  const acceptRefs = (refs: ChatReference[]) => {
    if (refs.length === 0) return
    setReferences(prev => {
      const merged = [...prev]
      for (const r of refs) {
        const key = `${r.type}:${r.id}`
        if (!merged.some(p => `${p.type}:${p.id}` === key)) merged.push(r)
      }
      return merged
    })
    setText(prev => prev + refs.map(r => `@${r.name}`).join(' ') + ' ')
  }

  const removeReference = (r: ChatReference) => {
    setReferences(prev => prev.filter(p => `${p.type}:${p.id}` !== `${r.type}:${r.id}`))
  }

  const removeAttachment = (id: number) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  // + 上传附件：触发隐藏 input → 立即上传（attachment_ids 挂载会话，多轮复用）
  const openUploadPicker = () => {
    setUploadNote('')
    uploadInputRef.current?.click()
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    setUploading(true)
    setUploadNote('')
    api.uploadChatAttachments(files, { conv_id: convId ?? null, space_id: spaceId ?? null, auto_import: false })
      .then(r => {
        const list = r.data || []
        const ok = list.filter(i => !i.error)
        const bad = list.filter(i => i.error)
        if (ok.length > 0) {
          setAttachments(prev => [...prev, ...ok.map(i => ({
            id: i.id, name: i.name, file_type: i.file_type, object_name: i.object_name, text_len: i.text_len,
          }))])
        }
        if (bad.length > 0 && ok.length > 0) {
          setUploadNote(`部分文件处理失败：${bad.map(i => `${i.name}（${i.error}）`).join('；')}`)
        } else if (bad.length > 0) {
          setUploadNote(r.detail || '全部文件处理失败，请检查文件类型（支持 .sql/.ddl/.docx/.md/.txt/.xlsx/.pdf）')
        }
      })
      .catch(() => setUploadNote('上传失败，请稍后重试'))
      .finally(() => setUploading(false))
  }

  return (
    <div className="w-full px-4 pb-4 pt-2">
      <div className="w-full max-w-[48rem] mx-auto">
        {/* 当前阶段提示条：任务采集阶段引导（输入框上方，文字起点与输入框 placeholder 左对齐） */}
        <div className="mb-2 flex items-center gap-1">
          <Info className="w-3 h-3 text-indigo-400 shrink-0" />
          <span className="text-[11px] text-[#8b8b9e] truncate">
            当前处于【数据迁移任务・{currentStage || '数据采集'}】，智能体：
            {agentDisplayName(currentAgent || (activeAgent ? { name: activeAgent } : null))}
          </span>
        </div>
        <div className="relative bg-[#16161e] border border-[#252530] rounded-xl focus-within:border-indigo-500/40 transition-colors">
          {/* 隐藏文件上传 */}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
            accept=".sql,.ddl,.docx,.md,.txt,.xlsx,.pdf"
          />

          {/* 引用 / 附件 chips 区 */}
          {(references.length > 0 || attachments.length > 0) && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {references.map(r => (
                <div
                  key={`${r.type}:${r.id}`}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#2a2a35] text-[#cdd3e0] text-[12px]"
                >
                  <AtSign className="w-3 h-3 text-indigo-400" />
                  <span className="max-w-[140px] truncate">{r.name}</span>
                  <button
                    className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                    onClick={() => removeReference(r)}
                    title="移除引用"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {attachments.map(a => (
                <div
                  key={a.id}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-[#cdd3e0] text-[12px]"
                >
                  <Paperclip className="w-3 h-3 text-indigo-400" />
                  <span className="max-w-[140px] truncate">{a.name}</span>
                  <span className="text-[10px] text-[#5a5a70]">.{a.file_type}</span>
                  <button
                    className="text-[#5a5a70] hover:text-[#9a9aa4] transition-colors"
                    onClick={() => removeAttachment(a.id)}
                    title="移除附件"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {uploadNote && (
            <div className="px-4 pt-2 text-[11px] text-red-400/90">{uploadNote}</div>
          )}

          <Textarea
            className="w-full min-h-[60px] max-h-[120px] bg-transparent border-0 text-[#e4e4e9] text-[13px] resize-none pl-4 pr-4 py-3 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-[#5a5a70]"
            placeholder="今天帮你做些什么？"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          {/* 底部工具栏（所有按钮平铺） */}
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {/* @ 引用 / + 上传 */}
              <button
                className="flex items-center justify-center h-7 w-7 rounded-lg text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                onClick={() => setShowRefPicker(true)}
                title="@ 引用资源"
              >
                <AtSign className="w-4 h-4" />
              </button>
              <button
                className="flex items-center justify-center h-7 w-7 rounded-lg text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors disabled:opacity-60"
                onClick={openUploadPicker}
                disabled={uploading}
                title={uploading ? '上传中…' : '上传附件（.sql/.ddl/.docx/.md/.txt/.xlsx/.pdf）'}
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </button>
              <div className="w-px h-4 bg-[#2a2a35] mx-1" />

              <button className="flex items-center gap-1 text-[#4a4a5a] hover:text-[#9a9ab0] text-[12px] px-2 py-1 rounded hover:bg-white/[0.03] transition-colors">
                <span>默认权限</span>
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button className="flex items-center gap-1 text-[#4a4a5a] hover:text-[#9a9ab0] text-[12px] px-2 py-1 rounded hover:bg-white/[0.03] transition-colors">
                <span>快速</span>
                <ChevronDown className="w-3 h-3" />
              </button>

              <button
                className="text-[#4a4a5a] hover:text-[#9a9ab0] p-1 rounded transition-colors"
                title="语音输入"
              >
                <Mic className="w-4 h-4" />
              </button>

              {disabled ? (
                <Button
                  className="h-7 w-7 rounded-full bg-red-500/80 text-white hover:bg-red-500 p-0"
                  onClick={onStop}
                  title="中止生成"
                >
                  <Square className="w-3 h-3" />
                </Button>
              ) : (
                <Button
                  className="h-7 w-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white hover:from-indigo-400 hover:to-purple-500 p-0"
                  disabled={!text.trim() && references.length === 0 && attachments.length === 0}
                  onClick={handleSend}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7"/>
                  </svg>
                </Button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-1.5 text-center text-[10px] text-[#5a5a70]">
          内容由 AI 生成，请核实重要信息
        </div>
      </div>

      {/* @ 引用资源选择器 */}
      <ReferencePicker
        open={showRefPicker}
        onClose={() => setShowRefPicker(false)}
        onConfirm={acceptRefs}
        convId={convId}
        spaceId={spaceId}
      />
    </div>
  )
}
