import { useState, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { StreamEvent, SendExtra, SystemEvent, SubAgentEvent, MigrateEvent } from '@/lib/types'

export interface ChatStep {
  type: string
  content: Record<string, unknown> | string
  /** 距本次发送开始的耗时（ms），用于链路面板展示真实耗时；历史步骤无此字段 */
  ts?: number
}

/** 实时消息时间线条目：系统事件 / 子 Agent 输出（按发生顺序，供消息列表渲染） */
export interface TimelineItem {
  kind: 'system' | 'sub_agent'
  ev: SystemEvent | SubAgentEvent
}

/**
 * 剥离回复文本最前面的「解析结果 JSON」（形如 {"intent":...,"agent_id":...} 直接拼接在正文前的问题）。
 * 支持两种格式：
 * 1. 直接输出：{"intent":...,"agent_id":...}
 * 2. Markdown 代码块：```json\n{"intent":...}\n```
 * 键名可能含杂散空格（如 "agent _id"），统一去掉空白后匹配；仅当对象的所有键都属于
 * 解析字段集且包含 intent/agent_id/confidence 时剥离，避免误删用户需要的 JSON 回答。
 */
const PARSE_KEYS = new Set(['intent', 'agent_id', 'object_name', 'source_db', 'target_db', 'skill_id', 'params', 'confidence'])
const STREAM_UI_INTERVAL_MS = 80

export function stripLeadingJson(text: string): string {
  const t = text.replace(/^[\s\u200b\u200c\u200d\ufeff]+/, '')
  // 处理 markdown 代码块格式：```json ... ```
  const mdMatch = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```/)
  if (mdMatch) {
    const jsonStr = mdMatch[1].trim()
    try {
      const raw = JSON.parse(jsonStr)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const keys = new Set(Object.keys(raw).map(k => k.replace(/\s/g, '')))
        const core = ['intent', 'agent_id', 'confidence']
        const isParse = [...keys].every(k => PARSE_KEYS.has(k)) && core.every(k => keys.has(k))
        if (isParse) {
          return t.slice(mdMatch[0].length).replace(/^[\s\u200b\u200c\u200d\ufeff，,。；;：:\n\r*-]+/, '')
        }
      }
    } catch {
      /* 不是有效 JSON，继续尝试直接 JSON 格式 */
    }
  }
  // 处理直接 JSON 格式
  if (!t.startsWith('{')) return text
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return text
  const candidate = t.slice(0, end + 1)
  try {
    const raw = JSON.parse(candidate)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return text
    const keys = new Set(Object.keys(raw).map(k => k.replace(/\s/g, '')))
    const core = ['intent', 'agent_id', 'confidence']
    const isParse = [...keys].every(k => PARSE_KEYS.has(k)) && core.every(k => keys.has(k))
    if (isParse) {
      return t.slice(end + 1).replace(/^[\s\u200b\u200c\u200d\ufeff，,。；;：:\n\r*-]+/, '')
    }
  } catch {
    /* 不是有效 JSON，原样返回 */
  }
  return text
}

export function useChatStream() {
  const [streaming, setStreaming] = useState(false)
  const [assistantText, setAssistantText] = useState('')
  const [steps, setSteps] = useState<ChatStep[]>([])
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  /** 本次运行状态机推进事件（迁移任务的阶段流转），流结束后取用 */
  const [migrateState, setMigrateState] = useState<MigrateEvent | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeConvRef = useRef<number | null>(null)
  /** 本次运行的完整时间线快照（供发送方在流结束后持久化到会话视图） */
  const timelineRef = useRef<TimelineItem[]>([])
  /** 本次运行解析出的结构化 UI 指令（<UI_RENDER> 首个合法 JSON），流结束后取用 */
  const uiRenderRef = useRef<Record<string, unknown> | null>(null)
  /** 本次运行状态机推进事件（供发送方流结束后刷新迁移面板/状态） */
  const migrateRef = useRef<MigrateEvent | null>(null)
  /** 正文 token 高频到达时先合并渲染，避免长回复按 token 重复解析 Markdown 卡住页面 */
  const assistantTextRef = useRef('')
  const assistantTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = useCallback(() => {
    const convId = activeConvRef.current
    const controller = abortRef.current
    const abortLocal = () => controller?.abort()
    if (convId == null) {
      abortLocal()
      abortRef.current = null
      return
    }
    api.cancelChat(convId)
      .catch(() => null)
      .finally(() => {
        abortLocal()
        abortRef.current = null
      })
  }, [])

  const send = useCallback(async (message: string, convId: number | null, agentId?: string, extra?: SendExtra) => {
    setStreaming(true)
    setAssistantText('')
    setSteps([])
    setTimeline([])
    setMigrateState(null)
    timelineRef.current = []
    uiRenderRef.current = null
    migrateRef.current = null
    assistantTextRef.current = ''
    if (assistantTextTimerRef.current != null) {
      clearTimeout(assistantTextTimerRef.current)
      assistantTextTimerRef.current = null
    }

    const controller = new AbortController()
    abortRef.current = controller
    activeConvRef.current = convId
    const startTs = performance.now() // 用于链路节点真实耗时统计

    const flushAssistantText = (sync: boolean) => {
      if (assistantTextTimerRef.current != null) {
        clearTimeout(assistantTextTimerRef.current)
        assistantTextTimerRef.current = null
      }
      if (sync) setAssistantText(stripLeadingJson(assistantTextRef.current))
    }

    try {
      const resp = await api.chatStream(message, convId, agentId, controller.signal, extra)
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`)
      }
      const reader = resp.body?.getReader()
      if (!reader) {
        throw new Error('响应体不可读（body 为空）')
      }

      const dec = new TextDecoder()
      let buf = ''
      let fullText = ''

      const scheduleAssistantText = (text: string) => {
        assistantTextRef.current = text
        if (assistantTextTimerRef.current != null) return
        assistantTextTimerRef.current = setTimeout(() => {
          assistantTextTimerRef.current = null
          setAssistantText(stripLeadingJson(assistantTextRef.current))
        }, STREAM_UI_INTERVAL_MS)
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''

        for (const part of parts) {
          if (!part.startsWith('data:')) continue
          const line = part.replace(/^data:\s*/, '').trim()
          if (line === '[DONE]') continue
          try {
            const ev: StreamEvent = JSON.parse(line)
            if (ev.type === 'text') {
              fullText += ev.content as string
              scheduleAssistantText(fullText)
            } else if (ev.type === 'system') {
              timelineRef.current.push({ kind: 'system', ev: ev.content as SystemEvent })
              setTimeline(prev => [...prev, { kind: 'system', ev: ev.content as SystemEvent }])
            } else if (ev.type === 'sub_agent') {
              timelineRef.current.push({ kind: 'sub_agent', ev: ev.content as SubAgentEvent })
              setTimeline(prev => [...prev, { kind: 'sub_agent', ev: ev.content as SubAgentEvent }])
              // 同时进入链路步骤，便于任务链路面板展示「子 Agent 调用」节点
              setSteps(prev => [...prev, { type: 'agent', content: ev.content as unknown as Record<string, unknown>, ts: Math.round(performance.now() - startTs) }])
            } else if (ev.type === 'error') {
              // 后端错误事件：进入时间线，便于流结束后在会话视图持久展示
              const msg = String(ev.content ?? '') || '处理失败'
              const se: SystemEvent = { message: `❌ ${msg}`, event: 'error' }
              timelineRef.current.push({ kind: 'system', ev: se })
              setTimeline(prev => [...prev, { kind: 'system', ev: se }])
            } else if (ev.type === 'ui_render') {
              // 结构化 UI 指令：仅当为对象时保存，调用方在流结束后取用
              console.log('[use-chat-stream] ui_render event:', ev.content)
              if (ev.content && typeof ev.content === 'object') {
                uiRenderRef.current = ev.content as Record<string, unknown>
                console.log('[use-chat-stream] uiRenderRef set:', uiRenderRef.current)
              }
            } else if (ev.type === 'migrate') {
              // 状态机推进事件：迁移任务阶段流转（后端硬编码控制）
              const me = ev.content as MigrateEvent
              migrateRef.current = me
              setMigrateState(me)
              console.log('[use-chat-stream] migrate event:', me)
            } else if (ev.type !== 'done') {
              setSteps(prev => [...prev, { type: ev.type, content: ev.content as Record<string, unknown> | string, ts: Math.round(performance.now() - startTs) }])
            }
          } catch { /* ignore */ }
        }
      }
      flushAssistantText(true)
      return stripLeadingJson(fullText)
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') throw e
      return null
    } finally {
      flushAssistantText(true)
      setStreaming(false)
      abortRef.current = null
      activeConvRef.current = null
    }
  }, [])

  return { streaming, assistantText, steps, timeline, timelineRef, uiRenderRef, migrateState, migrateRef, send, stop }
}
