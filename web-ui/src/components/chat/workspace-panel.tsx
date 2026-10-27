import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type {
  Agent, WorkspaceDiff, WorkspaceEvidence, WorkspaceEvidenceItem,
  WorkspaceFile, WorkspaceSummary, WorkspaceTreeNode, WorkspaceTree,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  BookOpen, FileCode, FileText, Folder, Loader2, PanelRightOpen, Search, X,
} from 'lucide-react'

type WorkspaceTab = 'changes' | 'project' | 'evidence'

interface WorkspacePanelProps {
  agent?: Agent
  convId: number | null
  refreshKey: number
  openFileRequest?: WorkspaceFileRequest | null
  onOpenFileRequestConsumed?: () => void
}

export interface WorkspaceFileRequest {
  agentId: string
  path: string
  line?: number
  requestId: number
}

const statusClass: Record<string, string> = {
  M: 'text-amber-300 bg-amber-500/10',
  A: 'text-emerald-300 bg-emerald-500/10',
  '?': 'text-emerald-300 bg-emerald-500/10',
  D: 'text-red-300 bg-red-500/10',
  R: 'text-violet-300 bg-violet-500/10',
}

const evidenceLabel: Record<string, string> = {
  read: '读取文件',
  search: '代码检索',
  kb: '知识库',
}

export function WorkspacePanel({ agent, convId, refreshKey, openFileRequest, onOpenFileRequestConsumed }: WorkspacePanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<WorkspaceTab>('changes')
  const [width, setWidth] = useState(360)
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [evidence, setEvidence] = useState<WorkspaceEvidence | null>(null)
  const [projectPath, setProjectPath] = useState('')
  const [project, setProject] = useState<WorkspaceTree | null>(null)
  const [preview, setPreview] = useState<WorkspaceFile | WorkspaceDiff | null>(null)
  const [previewLine, setPreviewLine] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const previewRef = useRef<HTMLPreElement | null>(null)

  const load = useCallback(async () => {
    if (!agent?.id) {
      setSummary(null)
      setEvidence(null)
      return
    }
    setLoading(true)
    const [changesResult, evidenceResult] = await Promise.all([
      api.agentWorkspaceChanges(agent.id).catch(() => null),
      api.agentWorkspaceEvidence(agent.id, convId).catch(() => null),
    ])
    setSummary(changesResult?.success ? changesResult.data ?? null : null)
    setEvidence(evidenceResult?.success ? evidenceResult.data ?? null : null)
    setLoading(false)
  }, [agent?.id, convId])

  const loadProject = useCallback(async (path: string) => {
    if (!agent?.id || !summary?.available) return
    const result = await api.agentWorkspaceTree(agent.id, path).catch(() => null)
    if (result?.success) {
      setProjectPath(path)
      setProject(result.data ?? null)
    }
  }, [agent?.id, summary?.available])

  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    if (summary?.available) void loadProject('')
    else {
      setProject(null)
      setProjectPath('')
    }
  }, [summary?.available, summary?.project_dir, loadProject])

  const openChange = async (path: string) => {
    if (!agent?.id) return
    setPreview(null)
    setPreviewLine(null)
    const result = await api.agentWorkspaceDiff(agent.id, path).catch(() => null)
    if (result?.success) setPreview(result.data ?? null)
  }

  const openFile = useCallback(async (path: string, line?: number) => {
    if (!agent?.id) return
    setPreview(null)
    setPreviewLine(line ?? null)
    const result = await api.agentWorkspaceFile(agent.id, path).catch(() => null)
    if (result?.success) setPreview(result.data ?? null)
  }, [agent?.id])

  useEffect(() => {
    if (!openFileRequest || openFileRequest.agentId !== agent?.id || !summary?.available) return
    setCollapsed(false)
    setTab('project')
    void openFile(openFileRequest.path, openFileRequest.line)
    onOpenFileRequestConsumed?.()
  }, [openFileRequest, agent?.id, summary?.available, openFile, onOpenFileRequestConsumed])

  useEffect(() => {
    if (!preview || !previewLine || 'diff' in preview) return
    previewRef.current?.querySelector(`[data-line="${previewLine}"]`)
      ?.scrollIntoView({ block: 'center' })
  }, [preview, previewLine])

  useEffect(() => {
    if (!preview) return
    const closePreview = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreview(null)
        setPreviewLine(null)
      }
    }
    window.addEventListener('keydown', closePreview)
    return () => window.removeEventListener('keydown', closePreview)
  }, [preview, previewLine])

  const openEvidence = async (item: WorkspaceEvidenceItem) => {
    if (item.type === 'read' && item.path) await openFile(item.path)
  }

  const onDragStart = (event: React.MouseEvent) => {
    dragRef.current = { startX: event.clientX, startWidth: width }
    const move = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return
      const next = dragRef.current.startWidth - (moveEvent.clientX - dragRef.current.startX)
      setWidth(Math.max(280, Math.min(520, next)))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-[#252530] bg-[#0f0f14] py-3">
        <button
          className="rounded-md p-1 text-[#8b8b9e] hover:bg-white/[0.04] hover:text-indigo-400"
          title="展开工作区" onClick={() => setCollapsed(false)}
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <span className="text-[11px] tracking-widest text-[#9a9aa4]" style={{ writingMode: 'vertical-rl' }}>
          Workspace
        </span>
      </aside>
    )
  }

  const projectName = summary?.project_dir.split('/').filter(Boolean).pop() || 'PROJECT'
  const projectLoading = loading || (!!summary?.available && !project)

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-[#252530] bg-[#0f0f14]"
      style={{ width }}
    >
      <div
        className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize hover:bg-indigo-500/30"
        onMouseDown={onDragStart}
      />
      <div className="flex shrink-0 items-center justify-between border-b border-[#252530] px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-[#cdd3e0]">
            {summary?.name || agent?.alias || agent?.name || 'Workspace'}
          </div>
          <div
            className="truncate font-mono text-[10px] text-[#6a6a7a]"
            title={summary?.project_dir || agent?.project_dir || ''}
          >
            {summary?.available
              ? `${projectName}${summary.git.branch ? ` · ${summary.git.branch}` : ''}`
              : 'NO PROJECT'}
          </div>
        </div>
        <button
          className="ml-2 text-[#5a5a70] hover:text-[#9a9aa4]"
          title="折叠工作区" onClick={() => setCollapsed(true)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-[#252530] p-2">
        {([
          ['changes', `Changes ${summary?.changed_count ?? 0}`],
          ['project', 'Project'],
          ['evidence', `Evidence ${evidence ? evidence.items.length : 0}`],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            className={cn(
              'rounded-full px-2.5 py-1 text-[10px] transition-colors',
              tab === value ? 'bg-blue-500/15 text-blue-300' : 'text-[#8b8b9e] hover:bg-white/[0.04]',
            )}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !summary ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-[#5a5a70]" />
          </div>
        ) : !summary?.available ? (
          <div className="px-3 py-10 text-center text-[11px] leading-relaxed text-[#4a4a5a]">
            未绑定工程目录
          </div>
        ) : tab === 'changes' ? (
          !summary.git.is_repo ? (
            <div className="px-3 py-10 text-center text-[11px] text-[#4a4a5a]">非 Git 工程</div>
          ) : summary.changes.length === 0 ? (
            <div className="px-3 py-10 text-center text-[11px] text-[#4a4a5a]">暂无修改文件</div>
          ) : summary.changes.map(item => (
            <button
              key={item.path}
              className="mb-1 w-full rounded-lg border border-[#252530] bg-[#111118] px-2 py-2 text-left transition-colors hover:border-indigo-500/30"
              onClick={() => openChange(item.path)}
            >
              <div className="flex items-center gap-2">
                <span className={cn('rounded px-1.5 py-0.5 text-[9px]', statusClass[item.status] || statusClass.M)}>
                  {item.status === '?' ? 'A' : item.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[#e4e4e9]">{item.path}</span>
              </div>
              <div className="mt-1 text-[10px]">
                <span className="text-emerald-400">+{item.additions}</span>
                <span className="ml-2 text-red-400">-{item.deletions}</span>
              </div>
            </button>
          ))
        ) : tab === 'project' ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-[#8b8b9e]">
              <button
                className="rounded bg-[#16161e] px-1.5 py-0.5 text-blue-300"
                onClick={() => loadProject('')}
              >
                {projectName}
              </button>
              {projectPath.split('/').filter(Boolean).map((part, index, parts) => (
                <button
                  key={part}
                  className="rounded bg-[#16161e] px-1.5 py-0.5 hover:text-indigo-300"
                  onClick={() => loadProject(parts.slice(0, index + 1).join('/'))}
                >
                  {part}
                </button>
              ))}
            </div>
            {projectLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-[#5a5a70]" />
              </div>
            ) : (
              (project?.items || []).map((item: WorkspaceTreeNode) => (
                <button
                  key={item.path}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[#b8bfcf] hover:bg-white/[0.03]"
                  onClick={() => item.type === 'directory' ? loadProject(item.path) : openFile(item.path)}
                >
                  {item.type === 'directory'
                    ? <Folder className="h-3 w-3 shrink-0 text-blue-300" />
                    : <FileCode className="h-3 w-3 shrink-0 text-cyan-300" />}
                  <span className="truncate">{item.name}</span>
                </button>
              ))
            )}
          </>
        ) : (evidence?.items || []).length === 0 ? (
          <div className="px-3 py-10 text-center text-[11px] leading-relaxed text-[#4a4a5a]">
            本轮暂无工程读取或知识库检索记录
          </div>
        ) : (evidence?.items || []).map(item => (
          <button
            key={item.id}
            disabled={item.type !== 'read'}
            className={cn(
              'mb-1 w-full rounded-lg border border-[#252530] bg-[#111118] px-2 py-2 text-left',
              item.type === 'read' && 'transition-colors hover:border-indigo-500/30',
            )}
            onClick={() => openEvidence(item)}
          >
            <div className="flex items-center gap-2">
              {item.type === 'read'
                ? <FileText className="h-3 w-3 shrink-0 text-violet-300" />
                : item.type === 'search'
                  ? <Search className="h-3 w-3 shrink-0 text-emerald-300" />
                  : <BookOpen className="h-3 w-3 shrink-0 text-blue-300" />}
              <span className="truncate text-[11px] text-[#e4e4e9]">
                {item.path || item.query || item.type}
              </span>
              {item.type === 'search' && !!item.matched_count && (
                <span className="ml-auto shrink-0 text-[10px] text-emerald-400">{item.matched_count}</span>
              )}
            </div>
            <div className="mt-1 text-[10px] text-[#5a5a70]">{evidenceLabel[item.type] || item.type}</div>
          </button>
        ))}
      </div>

      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[120] flex flex-col bg-[#0a0a0e]/[0.98] backdrop-blur-sm"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#252530] bg-[#0f0f14] px-4 py-3">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#9a9aa4]"
              title={preview.path}
            >
              {preview.path}
              {!('diff' in preview) && previewLine ? `:${previewLine}` : ''}
            </span>
            <button
              aria-label="关闭预览"
              className="rounded-md p-1 text-[#5a5a70] transition-colors hover:bg-white/[0.05] hover:text-[#e4e4e9]"
              onClick={() => {
                setPreview(null)
                setPreviewLine(null)
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <pre
            ref={previewRef}
            className="min-h-0 flex-1 overflow-auto bg-[#12121a] p-4 text-[12px] leading-relaxed text-[#b8bfcf]"
          >
            {'diff' in preview ? (
              <span className="whitespace-pre">{preview.diff}</span>
            ) : preview.content.split('\n').map((line, index) => (
              <div
                key={index}
                data-line={index + 1}
                className={cn(
                  '-mx-4 flex min-w-max gap-4 px-4',
                  previewLine === index + 1 && 'bg-sky-500/15 text-sky-100',
                )}
              >
                <span className="w-12 shrink-0 select-none text-right text-[#4a4a5a]">
                  {index + 1}
                </span>
                <span className="whitespace-pre">{line || ' '}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </aside>
  )
}
