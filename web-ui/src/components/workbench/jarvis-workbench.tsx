import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import type { Agent, ArtifactItem, BizTask } from '@/lib/types'
import { JarvisConsole } from './jarvis-console'
import './jarvis-workbench.css'

type JarvisWorkbenchProps = {
  onTabChange?: (tab: string) => void
  jarvisConvId: number | null
  ensureJarvisConversation: () => Promise<number>
}

type JarvisData = {
  healthy: boolean | null
  model: string
  agents: Agent[]
  tasks: BizTask[]
  artifacts: ArtifactItem[]
  knowledgeCount: number | null
}

const emptyData: JarvisData = {
  healthy: null,
  model: 'UNAVAILABLE',
  agents: [],
  tasks: [],
  artifacts: [],
  knowledgeCount: null,
}

const quickLinks = [
  { id: 'conversations', label: 'CONSOLE' },
  { id: 'agents', label: 'AGENTS' },
  { id: 'kb', label: 'KNOWLEDGE' },
  { id: 'artifacts', label: 'ARTIFACTS' },
  { id: 'workspace', label: 'WORKSPACE' },
  { id: 'dbs', label: 'SYSTEM' },
]

function initials(id: string) {
  const letters = id.split(/[-_]/).filter(Boolean).slice(0, 2)
  return (letters.map(part => part[0]).join('') || id.slice(0, 2)).toUpperCase()
}

function clockText(date: Date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function JarvisWorkbench({
  onTabChange,
  jarvisConvId,
  ensureJarvisConversation,
}: JarvisWorkbenchProps) {
  const [data, setData] = useState<JarvisData>(emptyData)
  const [now, setNow] = useState(() => new Date())
  const [consoleActive, setConsoleActive] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let alive = true
    const next = { ...emptyData }
    const jobs = [
      api.health().then(r => {
        next.healthy = (r as unknown as { status?: string }).status === 'ok' || r.data?.status === 'ok'
      }),
      api.getSettings().then(r => {
        next.model = r.success && r.data?.model ? r.data.model.toUpperCase() : 'UNAVAILABLE'
      }),
      api.listAgents().then(r => {
        next.agents = r.success ? r.data || [] : []
      }),
      api.listTasks().then(r => {
        next.tasks = r.success ? r.data || [] : []
      }),
      api.listAllArtifacts().then(r => {
        next.artifacts = r.success ? r.data || [] : []
      }),
      api.listKbs().then(r => {
        next.knowledgeCount = r.success ? (r.data || []).length : null
      }),
    ]

    Promise.allSettled(jobs).then(() => {
      if (alive) setData(next)
    })
    return () => { alive = false }
  }, [])

  const onlineAgents = useMemo(() => data.agents.filter(agent => agent.enabled), [data.agents])
  const runningTasks = useMemo(() => data.tasks.filter(task => task.status === 'running').length, [data.tasks])
  const pendingTasks = useMemo(() => data.tasks.filter(task => task.status === 'pending').length, [data.tasks])

  const note = runningTasks > 0
    ? `智能体编队在线，当前有 ${runningTasks} 个执行任务。可直接指定执行者或继续下达指令。`
    : '智能体编队已就绪。可按需求直接指定执行者，知识库访问权限保持隔离。'

  return (
    <div className="jarvis-workbench">
      <div className="jarvis-scanline" aria-hidden="true" />
      <div className="jarvis-shell">
        <aside className="jarvis-column">
          <section className="jarvis-panel">
            <div className="jarvis-heading"><span>AGENT CORE</span><span>{onlineAgents.length}/{data.agents.length || 0}</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">MODEL</span><span className="jarvis-value">{data.model}</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">STATUS</span><span className="jarvis-value">{data.healthy == null ? 'CHECKING' : data.healthy ? 'ONLINE' : 'OFFLINE'}</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">KNOWLEDGE</span><span className="jarvis-value">{data.knowledgeCount == null ? 'UNAVAILABLE' : data.knowledgeCount}</span></div>
          </section>

          <section className="jarvis-panel">
            <div className="jarvis-heading"><span>OPERATIONS</span><span>LIVE</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">RUNNING</span><span className="jarvis-value">{runningTasks}</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">PENDING</span><span className="jarvis-value">{pendingTasks}</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">ARTIFACTS</span><span className="jarvis-value">{data.artifacts.length}</span></div>
          </section>

          <section className="jarvis-panel">
            <div className="jarvis-heading"><span>QUICK ACCESS</span><span>06</span></div>
            <div className="jarvis-links">
              {quickLinks.map(link => (
                <button
                  key={link.id}
                  className="jarvis-link"
                  onClick={() => onTabChange?.(link.id)}
                >
                  {link.label}
                </button>
              ))}
            </div>
          </section>
        </aside>

        <main className={`jarvis-column jarvis-main ${consoleActive ? 'console-active' : ''}`}>
          <div className="jarvis-brand">
            <h1 className="jarvis-title">JARVIS</h1>
            <div className="jarvis-subtitle">COMMAND WORKBENCH · {data.healthy ? 'ONLINE' : 'STANDBY'}</div>
          </div>

          <div className={`jarvis-reactor ${consoleActive ? 'compact' : ''}`} aria-hidden="true">
            <div className="jarvis-ring jarvis-ring-1" />
            <div className="jarvis-ring jarvis-ring-2" />
            <div className="jarvis-ring jarvis-ring-3" />
            <div className="jarvis-ring jarvis-ring-4" />
            <div className="jarvis-core"><span>JARVIS</span></div>
          </div>

          <JarvisConsole
            convId={jarvisConvId}
            ensureConversation={ensureJarvisConversation}
            onActiveChange={setConsoleActive}
          />
        </main>

        <aside className="jarvis-column">
          <section className="jarvis-panel">
            <div className="jarvis-heading"><span>LOCAL TIME</span><span>{now.toLocaleDateString('zh-CN')}</span></div>
            <div className="jarvis-clock">{clockText(now)}<small> {now.getHours() >= 12 ? 'PM' : 'AM'}</small></div>
            <div className="jarvis-row"><span className="jarvis-row-label">HEALTH</span><span className="jarvis-value">{data.healthy == null ? 'CHECKING' : data.healthy ? 'PASS' : 'FAIL'}</span></div>
            <div className="jarvis-row"><span className="jarvis-row-label">TASKS</span><span className="jarvis-value">{data.tasks.length}</span></div>
          </section>

          <section className="jarvis-panel">
            <div className="jarvis-heading"><span>AGENT FLEET</span><span>{data.agents.length}</span></div>
            <div className="jarvis-overflow">
              {data.agents.map(agent => (
                <div
                  key={agent.id}
                  className={`jarvis-agent ${agent.enabled ? 'enabled' : 'jarvis-disabled'}`}
                >
                  <div className="jarvis-agent-glyph">{initials(agent.id)}</div>
                  <div>
                    <div className="jarvis-agent-name">{agent.alias || agent.name}</div>
                    <div className="jarvis-agent-role">{agent.agent_type || agent.description || agent.id}</div>
                  </div>
                  <div className="jarvis-agent-state">{agent.enabled ? 'READY' : 'OFF'}</div>
                </div>
              ))}
              {!data.agents.length && <div className="jarvis-row"><span className="jarvis-row-label">STATE</span><span className="jarvis-value">UNAVAILABLE</span></div>}
            </div>
          </section>

          <section className="jarvis-panel">
            <div className="jarvis-heading"><span>NOTES</span><span>AI</span></div>
            <p className="jarvis-agent-role">{note}</p>
          </section>
        </aside>
      </div>
    </div>
  )
}
