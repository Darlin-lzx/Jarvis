import { useState, useEffect, useRef, type KeyboardEvent, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Square, AtSign, Plus, Bot, ChevronDown, Mic, Paperclip, Loader2, X, Hammer, Info } from 'lucide-react'
import { agents as builtinAgents, agentDisplayName, skillGroups } from './agent-tabs'
import { ReferencePicker } from './reference-picker'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Agent, SendExtra, ChatReference, AttachmentItem } from '@/lib/types'

interface ComposerProps {
  onSend: (text: string, extra?: SendExtra) => void
  onStop?: () => void
  disabled: boolean
  activeAgent?: string
  setActiveAgent?: (id: string) => void
  convId?: number | null
  spaceId?: number | null
  /** 后端智能体列表（用于下拉选择） */
  agentList?: Agent[]
}

export function Composer({ onSend, onStop, disabled, activeAgent, setActiveAgent, convId, spaceId, agentList }: ComposerProps) {
  // 使用后端智能体列表，如果未提供则降级为内置列表
  const agents = agentList && agentList.length > 0 ? agentList : builtinAgents
  const currentAgent = agents.find(a => a.id === activeAgent)
  const [text, setText] = useState('')
  const [showRefPicker, setShowRefPicker] = useState(false)
  const [references, setReferences] = useState<ChatReference[]>([])
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState('')
  const [showAgentDrp, setShowAgentDrp] = useState(false)
  const [showSkillDrp, setShowSkillDrp] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const agentDrpRef = useRef<HTMLDivElement>(null)
  const skillDrpRef = useRef<HTMLDivElement>(null)
  const [lastSkill, setLastSkill] = useState<string>(() => {
    try { return localStorage.getItem('last_skill') || '' } catch { return '' }
  })

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (agentDrpRef.current && !agentDrpRef.current.contains(event.target as Node)) {
        setShowAgentDrp(false)
      }
      if (skillDrpRef.current && !skillDrpRef.current.contains(event.target as Node)) {
        setShowSkillDrp(false)
      }
    }
    if (showAgentDrp || showSkillDrp) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAgentDrp, showSkillDrp])

  // 技能下拉：选中即记忆（与 WelcomePage 共用 localStorage key 'last_skill'）
  const selectSkill = (skill: string) => {
    setLastSkill(skill)
    try { localStorage.setItem('last_skill', skill) } catch { /* 忽略隐私模式异常 */ }
    setShowSkillDrp(false)
  }

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed && references.length === 0 && attachments.length === 0) return
    onSend(lastSkill ? `[技能：${lastSkill}] ${trimmed}` : trimmed, {
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
    <div className="px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto">
        {/* 当前阶段提示条：任务采集阶段引导（输入框上方，文字起点与输入框 placeholder 左对齐） */}
        <div className="mb-2 flex items-center gap-1">
          <Info className="w-3 h-3 text-indigo-400 shrink-0" />
          <span className="text-[11px] text-[#8b8b9e] truncate">
            当前处于【数据迁移任务・信息采集阶段】，智能体：
            {agentDisplayName(agents.find(a => a.id === activeAgent) as { name?: string; alias?: string } | null)}
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

              {/* 智能体下拉：联动 activeAgent */}
              <div className="relative" ref={agentDrpRef}>
                <button
                  className={cn(
                    'flex items-center justify-center h-7 w-7 rounded-lg transition-colors',
                    showAgentDrp ? 'text-indigo-400 bg-white/[0.05]' : 'text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05]'
                  )}
                  onClick={() => setShowAgentDrp(!showAgentDrp)}
                  title={`智能体：${agentDisplayName(currentAgent)}`}
                  aria-haspopup="menu"
                  aria-expanded={showAgentDrp}
                >
                  <Bot className="w-4 h-4" />
                </button>
                {showAgentDrp && (
                  <div className="absolute left-0 bottom-full mb-1 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-44 py-1.5 overflow-hidden">
                    <div className="px-3 pb-1 text-[11px] text-[#5a5a70]">内置智能体</div>
                    {agents.slice(0, 2).map(a => (
                      <button
                        key={a.id}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors',
                          a.id === activeAgent ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                        )}
                        onClick={() => { setActiveAgent?.(a.id); setShowAgentDrp(false) }}
                      >
                        <span className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0" style={{ backgroundColor: a.color + '20', color: a.color }}>
                          {(agentDisplayName(a) || '智')[0]}
                        </span>
                        <span className="truncate">{agentDisplayName(a as { name?: string; alias?: string })}</span>
                      </button>
                    ))}
                    <div className="px-3 pt-1.5 pb-1 text-[11px] text-[#5a5a70] border-t border-[#252530]">企业专属智能体</div>
                    {agents.slice(2).map(a => (
                      <button
                        key={a.id}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors',
                          a.id === activeAgent ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                        )}
                        onClick={() => { setActiveAgent?.(a.id); setShowAgentDrp(false) }}
                      >
                        <span className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0" style={{ backgroundColor: a.color + '20', color: a.color }}>
                          {(agentDisplayName(a) || '智')[0]}
                        </span>
                        <span className="truncate">{agentDisplayName(a as { name?: string; alias?: string })}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 技能下拉：localStorage 记忆 */}
              <div className="relative" ref={skillDrpRef}>
                <button
                  className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] text-[#9a9aa4] hover:text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                  onClick={() => setShowSkillDrp(!showSkillDrp)}
                  title="选择技能，发送消息时自动带入技能上下文"
                >
                  <Hammer className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span className={cn('max-w-[88px] truncate', !lastSkill && 'text-[#5a5a70]')}>{lastSkill || '技能'}</span>
                  <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', showSkillDrp && 'rotate-180')} />
                </button>
                {showSkillDrp && (
                  <div className="absolute left-0 bottom-full mb-1 bg-[#1a1a24] border border-[#252530] rounded-lg shadow-xl z-50 w-52 py-1.5 overflow-hidden">
                    {skillGroups.map(g => (
                      <div key={g.label}>
                        <div className="px-3 pt-1.5 pb-1 text-[11px] text-[#5a5a70]">{g.label}</div>
                        {g.skills.map(s => (
                          <button
                            key={s.label}
                            className={cn(
                              'w-full text-left px-3 py-2 text-[12px] transition-colors',
                              lastSkill === s.label ? 'bg-indigo-500/10 text-indigo-400' : 'text-[#cdd3e0] hover:bg-white/[0.05]'
                            )}
                            onClick={() => selectSkill(s.label)}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    ))}
                    {lastSkill && (
                      <button
                        className="w-full text-left px-3 pt-2 pb-1.5 text-[11px] text-[#5a5a70] hover:text-[#9a9aa4] border-t border-[#252530] transition-colors"
                        onClick={() => selectSkill('')}
                      >
                        清除技能
                      </button>
                    )}
                  </div>
                )}
              </div>

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
