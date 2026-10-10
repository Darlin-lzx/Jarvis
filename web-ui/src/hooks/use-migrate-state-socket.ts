import { useEffect, useRef, useState } from 'react'
import type {
  MigrateStateEventFrame,
  MigrateStateSnapshot,
  MigrateTaskDetail,
} from '@/lib/types'

function migrateSocketUrl(taskId: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/migrate/${taskId}`
}

export function useMigrateStateSocket(
  taskId: number | null | undefined,
  refresh?: () => void,
) {
  const [snapshot, setSnapshot] = useState<MigrateStateSnapshot | null>(null)
  const [events, setEvents] = useState<MigrateStateEventFrame[]>([])
  const [connected, setConnected] = useState(false)
  const [polling, setPolling] = useState(false)
  const refreshRef = useRef<(() => void) | undefined>(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    if (taskId == null) {
      setSnapshot(null)
      setEvents([])
      setConnected(false)
      setPolling(false)
      return
    }

    let closedByUnmount = false
    const websocket = new WebSocket(migrateSocketUrl(taskId))
    websocket.onopen = () => {
      setConnected(true)
      setPolling(false)
      refreshRef.current?.()
    }
    websocket.onmessage = event => {
      try {
        const message = JSON.parse(event.data) as
          | MigrateStateSnapshot
          | MigrateStateEventFrame
        if (message.event === 'state') setSnapshot(message)
        if (message.event === 'state_event') {
          setEvents(prev => [...prev, message].slice(-100))
        }
      } catch {
        // Ignore malformed frames; REST remains the authoritative fallback.
      }
    }
    websocket.onclose = () => {
      if (closedByUnmount) return
      setConnected(false)
      setPolling(true)
      setEvents([])
      refreshRef.current?.()
    }

    return () => {
      closedByUnmount = true
      websocket.close()
    }
  }, [taskId])

  useEffect(() => {
    if (taskId == null || !polling) return
    refreshRef.current?.()
    const fallbackTimer = setInterval(() => refreshRef.current?.(), 5000)
    return () => clearInterval(fallbackTimer)
  }, [taskId, polling])

  return { snapshot, events, connected, polling }
}

export function mergeMigrateSnapshot(
  detail: MigrateTaskDetail | null,
  snapshot: MigrateStateSnapshot | null,
): MigrateTaskDetail | null {
  if (!detail || !snapshot || snapshot.task_id !== detail.task_id) return detail
  return {
    ...detail,
    status: snapshot.status ?? detail.status,
    status_label: snapshot.status_label ?? detail.status_label,
    current_step: snapshot.current_step ?? detail.current_step,
    step_status: snapshot.step_status ?? detail.step_status,
    awaiting_confirmation: snapshot.awaiting_confirmation ?? detail.awaiting_confirmation,
    step_confirm: snapshot.step_confirm ?? detail.step_confirm,
    strict_flow: snapshot.strict_flow ?? detail.strict_flow,
    updated_at: snapshot.updated_at ?? detail.updated_at,
  }
}
