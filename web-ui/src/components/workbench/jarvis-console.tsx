import { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser } from 'lucide-react'
import { api } from '@/lib/api'
import type { Message, SubAgentEvent, SystemEvent } from '@/lib/types'
import { useChatStream, type TimelineItem } from '@/hooks/use-chat-stream'
import { UiForm } from '@/components/chat/ui-form'

type JarvisConsoleProps = {
  convId: number | null
  ensureConversation: () => Promise<number>
  onActiveChange?: (active: boolean) => void
}

type ConsoleLine = {
  key: string
  kind: 'user' | 'assistant' | 'trace' | 'fault'
  content: string
  uiRender?: Record<string, unknown> | null
}

function messageToLine(message: Message, index: number): ConsoleLine {
  return {
    key: `history-${message.id ?? index}-${index}`,
    kind: message.role,
    content: message.content,
    uiRender: message.ui_render,
  }
}

function timelineToLine(item: TimelineItem, index: number): ConsoleLine {
  if (item.kind === 'system') {
    const ev = item.ev as SystemEvent
    const content = ev.message || ev.event || '系统事件'
    return {
      key: `trace-${index}`,
      kind: ev.event === 'error' || content.includes('❌') ? 'fault' : 'trace',
      content,
    }
  }

  const ev = item.ev as SubAgentEvent
  const actor = ev.agent_name || ev.agent_id || 'SUB AGENT'
  if (ev.error) {
    return { key: `trace-${index}`, kind: 'fault', content: `${actor} · ${ev.error}` }
  }
  return { key: `trace-${index}`, kind: 'trace', content: `${actor} · ${ev.reply || '执行中'}` }
}

function formValuesToMessage(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== '' && value != null)
    .map(([key, value]) => `${key}：${typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}`)
    .join('\n')
}

export function JarvisConsole({ convId, ensureConversation, onActiveChange }: JarvisConsoleProps) {
  const [lines, setLines] = useState<ConsoleLine[]>([])
  const [input, setInput] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [preserveAssistantText, setPreserveAssistantText] = useState(false)
  const [consoleCleared, setConsoleCleared] = useState(false)
  const {
    streaming,
    assistantText,
    timeline,
    timelineRef,
    uiRenderRef,
    send,
    stop,
  } = useChatStream()
  const logRef = useRef<HTMLDivElement | null>(null)
  const skipNextHistoryLoadRef = useRef(false)
  const runEpochRef = useRef(0)

  useEffect(() => {
    if (convId == null) {
      setLoadingHistory(false)
      setPreserveAssistantText(false)
      return
    }
    if (skipNextHistoryLoadRef.current) {
      skipNextHistoryLoadRef.current = false
      setLoadingHistory(false)
      return
    }

    let alive = true
    setLoadingHistory(true)
    api.getMessages(convId).then(response => {
      if (!alive) return
      if (!response.success || !response.data) {
        throw new Error(response.error || '历史加载失败')
      }
      setLines(response.data.map(messageToLine))
    }).catch(error => {
      if (!alive) return
      setLines([{
        key: `history-fault-${Date.now()}`,
        kind: 'fault',
        content: error instanceof Error ? error.message : '历史加载失败',
      }])
    }).finally(() => {
      if (alive) setLoadingHistory(false)
    })
    return () => { alive = false }
  }, [convId])

  const runCommand = useCallback(async (text: string) => {
    const command = text.trim()
    if (!command || streaming || preparing) return

    const runEpoch = runEpochRef.current
    setPreparing(true)
    setConsoleCleared(false)
    skipNextHistoryLoadRef.current = true
    setPreserveAssistantText(false)

    try {
      const id = await ensureConversation()
      if (runEpochRef.current !== runEpoch) return

      setLines(previous => [...previous, {
        key: `user-${Date.now()}`,
        kind: 'user',
        content: command,
      }])
      setInput('')

      const response = await send(command, id, 'jarvis_commander')
      if (runEpochRef.current !== runEpoch) return

      const traces = timelineRef.current.map(timelineToLine)
      const uiRender = uiRenderRef.current
      if (response || uiRender) {
        setLines(previous => [
          ...previous,
          ...traces,
          {
            key: `assistant-${Date.now()}`,
            kind: 'assistant',
            content: response ?? '',
            uiRender,
          },
        ])
      } else {
        setPreserveAssistantText(true)
        setLines(previous => [...previous, ...traces])
      }
    } catch (error) {
      if (runEpochRef.current !== runEpoch) return

      const traces = timelineRef.current.map(timelineToLine)
      setPreserveAssistantText(true)
      setLines(previous => [
        ...previous,
        ...traces,
        {
          key: `fault-${Date.now()}`,
          kind: 'fault',
          content: error instanceof Error ? error.message : '处理失败',
        },
      ])
    } finally {
      setPreparing(false)
    }
  }, [ensureConversation, preparing, send, streaming, timelineRef, uiRenderRef])

  const handleSubmit = useCallback(() => {
    if (streaming) {
      stop()
      return
    }
    void runCommand(input)
  }, [input, runCommand, stop, streaming])

  const handleUiAction = useCallback((values: Record<string, unknown>) => {
    void runCommand(formValuesToMessage(values))
  }, [runCommand])

  const handleClearConsole = useCallback(() => {
    runEpochRef.current += 1
    if (streaming) stop()
    setConsoleCleared(true)
    setLines([])
    setPreserveAssistantText(false)
  }, [stop, streaming])

  useEffect(() => {
    onActiveChange?.(lines.length > 0 || (streaming && !consoleCleared) || loadingHistory)
  }, [consoleCleared, lines.length, loadingHistory, onActiveChange, streaming])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [assistantText, lines, timeline])

  const status = streaming
    ? 'PROCESSING'
    : preparing
      ? 'CONNECTING'
      : convId == null
        ? 'STANDBY'
        : 'READY'

  return (
    <section
      className="jarvis-console"
      data-active={lines.length > 0 || (streaming && !consoleCleared) ? 'true' : 'false'}
    >
      <header className="jarvis-console-header">
        <span className="jarvis-console-title">JARVIS CONSOLE</span>
        <span className="jarvis-console-tools">
          <button
            type="button"
            className="jarvis-console-clear"
            onClick={handleClearConsole}
            aria-label="清空贾维斯控制台显示"
            title="清空当前显示，不删除历史"
          >
            <Eraser size={12} aria-hidden="true" />
            CLEAR
          </button>
          <span className="jarvis-console-status">{status}</span>
        </span>
      </header>

      <div className="jarvis-console-log" ref={logRef} role="log" aria-live="polite">
        {loadingHistory && <div className="jarvis-trace">TRACE · LOADING HISTORY</div>}
        {lines.map(line => (
          <div key={line.key} className={`jarvis-line jarvis-line-${line.kind}`}>
            {line.kind === 'user' && <span className="jarvis-line-label">OPERATOR&gt;</span>}
            {line.kind === 'assistant' && <span className="jarvis-line-label">JARVIS&gt;</span>}
            {line.kind === 'trace' && <span>TRACE · {line.content}</span>}
            {line.kind === 'fault' && <span>FAULT · {line.content}</span>}
            {(line.kind === 'user' || line.kind === 'assistant') && (
              <div className="jarvis-line-content">
                {line.content}
                {line.uiRender && <UiForm data={line.uiRender} onAction={handleUiAction} />}
              </div>
            )}
          </div>
        ))}

        {streaming && !consoleCleared && timeline.map((item, index) => {
          const line = timelineToLine(item, index)
          return (
            <div key={line.key} className={`jarvis-line jarvis-line-${line.kind}`}>
              {line.kind === 'trace' && <span>TRACE · {line.content}</span>}
              {line.kind === 'fault' && <span>FAULT · {line.content}</span>}
            </div>
          )
        })}

        {streaming && !consoleCleared && (
          <div className="jarvis-line jarvis-line-jarvis">
            <span className="jarvis-line-label">JARVIS&gt;</span>
            <div className="jarvis-line-content">
              {assistantText || <span className="jarvis-processing">PROCESSING…</span>}
            </div>
          </div>
        )}

        {!streaming && preserveAssistantText && assistantText && (
          <div className="jarvis-line jarvis-line-jarvis">
            <span className="jarvis-line-label">JARVIS&gt;</span>
            <div className="jarvis-line-content">{assistantText}</div>
          </div>
        )}
      </div>

      <form
        className="jarvis-input"
        onSubmit={event => {
          event.preventDefault()
          handleSubmit()
        }}
      >
        <input
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="向贾维斯下达指令"
          aria-label="Jarvis command"
          disabled={preparing && !streaming}
        />
        <button type="submit" disabled={preparing && !streaming}>
          {streaming ? 'ABORT' : preparing ? 'CONNECT' : 'EXECUTE'}
        </button>
      </form>
    </section>
  )
}
