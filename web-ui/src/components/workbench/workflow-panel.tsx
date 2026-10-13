import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { WorkflowGraph, WorkflowNode, WorkflowTemplateResponse, WorkflowTemplateVersion } from '@/lib/types'
import { buildWorkflowRoutesForGraph } from './workflow-edge-routing'
import {
  AlertTriangle, CircleAlert, Database, Maximize2, Search, Workflow,
  ZoomIn, ZoomOut,
} from 'lucide-react'

const DEFAULT_TAG = 'com.ai.order.workflow.shedule.vm.GsmYdkjNewWFSchedule'
const VIEW_WIDTH = 1280
const VIEW_HEIGHT = 800
const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
const INITIAL_ZOOM_FACTOR = 1.15
const MIN_INITIAL_ZOOM = 0.4

const NODE_STYLES: Record<string, { fill: string; stroke: string; text: string }> = {
  csf_start: { fill: '#123b2b', stroke: '#34d399', text: '#a7f3d0' },
  csf_finish: { fill: '#272733', stroke: '#8b8b9e', text: '#cdd3e0' },
  fork: { fill: '#3b2f15', stroke: '#f59e0b', text: '#fde68a' },
  and: { fill: '#123043', stroke: '#22d3ee', text: '#a5f3fc' },
  csf_service: { fill: '#1b2140', stroke: '#6366f1', text: '#c7d2fe' },
  csf_auto: { fill: '#123338', stroke: '#14b8a6', text: '#99f6e4' },
  decision: { fill: '#151221', stroke: '#f472b6', text: '#d8bbd0' },
  shell: { fill: '#2b2411', stroke: '#a3e635', text: '#d9f99d' },
}

function compactNode(type: string) {
  return ['csf_start', 'csf_finish', 'fork', 'and'].includes(type)
}

function decisionNode(type: string) {
  return type === 'decision'
}

function nodeShape(type: string) {
  if (compactNode(type)) return 'compact'
  if (decisionNode(type)) return 'decision'
  return 'rect'
}

function nodeLines(node: WorkflowNode) {
  const text = node.label || node.id
  const segment = decisionNode(node.type) ? 5 : 8
  if (text.length <= segment) return [text]
  if (text.length <= segment * 2) {
    return [text.slice(0, segment), text.slice(segment)]
  }
  if (text.length <= segment * 3) {
    return [text.slice(0, segment), text.slice(segment, segment * 2), text.slice(segment * 2)]
  }
  return [
    text.slice(0, segment),
    text.slice(segment, segment * 2),
    `${text.slice(segment * 2, segment * 2 + 4)}...`,
  ]
}

function nodeBorderWidth(type: string, isSelected: boolean) {
  if (isSelected) return 2.5
  if (decisionNode(type)) return 1.2
  if (compactNode(type)) return 1.5
  return 1.8
}

function nodeOpacity(type: string, isSelected: boolean) {
  if (isSelected) return 1
  if (decisionNode(type)) return 0.78
  return 1
}

function workflowGraphBounds(graph: WorkflowGraph) {
  if (graph.nodes.length === 0) {
    return { minX: 0, minY: 0, width: graph.width, height: graph.height }
  }
  const minX = Math.min(...graph.nodes.map(node => node.x))
  const minY = Math.min(...graph.nodes.map(node => node.y))
  const maxX = Math.max(...graph.nodes.map(node => node.x + node.width))
  const maxY = Math.max(...graph.nodes.map(node => node.y + node.height))
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

function fitWorkflowZoom(graph: WorkflowGraph) {
  const bounds = workflowGraphBounds(graph)
  return Math.min(
    1,
    VIEW_WIDTH / Math.max(bounds.width, 1),
    VIEW_HEIGHT / Math.max(bounds.height, 1),
  )
}

function initialWorkflowZoom(graph: WorkflowGraph) {
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_INITIAL_ZOOM, fitWorkflowZoom(graph) * INITIAL_ZOOM_FACTOR),
  )
}

function workflowGraphOffset(graph: WorkflowGraph, zoom: number) {
  const bounds = workflowGraphBounds(graph)
  const scaledWidth = bounds.width * zoom
  const scaledHeight = bounds.height * zoom
  const offsetX = scaledWidth <= VIEW_WIDTH
    ? (VIEW_WIDTH - scaledWidth) / 2 - bounds.minX * zoom
    : -bounds.minX * zoom
  const offsetY = scaledHeight <= VIEW_HEIGHT
    ? (VIEW_HEIGHT - scaledHeight) / 2 - bounds.minY * zoom
    : -bounds.minY * zoom
  return { offsetX, offsetY }
}

function workflowGraphTransform(graph: WorkflowGraph, zoom: number) {
  const { offsetX, offsetY } = workflowGraphOffset(graph, zoom)
  return `translate(${offsetX} ${offsetY}) scale(${zoom})`
}

function VersionBadge({ version }: { version: WorkflowTemplateVersion }) {
  return (
    <span className={cn(
      'shrink-0 rounded border px-1.5 py-0.5 text-[10px]',
      version.parse_error ? 'border-red-500/40 bg-red-500/10 text-red-300'
        : version.is_expired ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-green-500/40 bg-green-500/10 text-green-300',
    )}>
      {version.parse_error ? '解析失败' : version.is_expired ? '已过期' : '可用'}
    </span>
  )
}

function NodeDetails({ node, graph }: { node: WorkflowNode; graph: WorkflowGraph }) {
  const outgoing = graph.edges.filter(edge => edge.source === node.id)
  const nodeMap = new Map(graph.nodes.map(item => [item.id, item]))
  return (
    <div className="space-y-3 text-[12px]">
      <div>
        <div className="text-[13px] font-medium text-[#e4e4e9]">{node.label || node.id}</div>
        <div className="mt-1 font-mono text-[10px] text-[#8b8b9e]">ID {node.id} · {node.type}</div>
      </div>
      {node.service && (
        <div className="space-y-1 border-t border-[#252530] pt-3">
          <div className="text-[11px] font-medium text-[#cdd3e0]">服务调用</div>
          <div className="grid gap-1 text-[11px] text-[#8b8b9e]">
            <span>centercode：<span className="text-[#cdd3e0]">{node.service.centercode || '—'}</span></span>
            <span>servicecode：<span className="break-all text-[#cdd3e0]">{node.service.servicecode || '—'}</span></span>
            <span>servicename：<span className="text-[#cdd3e0]">{node.service.servicename || '—'}</span></span>
          </div>
        </div>
      )}
      {node.links.length > 0 && (
        <div className="space-y-1.5 border-t border-[#252530] pt-3">
          <div className="text-[11px] font-medium text-[#cdd3e0]">参数映射</div>
          {node.links.map((link, index) => (
            <div key={`${link.direction}-${link.left}-${index}`} className="rounded-md border border-[#252530] bg-[#0f0f14] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-[10px]">
                <span className={link.direction === 'IN' ? 'text-cyan-300' : 'text-emerald-300'}>{link.direction}</span>
                {link.default_value && <span className="truncate text-amber-300">{link.default_value}</span>}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-[#8b8b9e]">{link.left} → {link.right}</div>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1 border-t border-[#252530] pt-3">
        <div className="text-[11px] font-medium text-[#cdd3e0]">出边</div>
        {outgoing.length === 0 ? (
          <div className="text-[11px] text-[#5a5a70]">无</div>
        ) : outgoing.map(edge => (
          <div key={edge.id} className="truncate text-[11px] text-[#8b8b9e]">
            <span className="text-[#cdd3e0]">{nodeMap.get(edge.target)?.label || edge.target}</span>
            <span className="ml-1 font-mono text-[10px]">#{edge.target}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function WorkflowPanel() {
  const [tag, setTag] = useState(DEFAULT_TAG)
  const [response, setResponse] = useState<WorkflowTemplateResponse | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const canvasScrollRef = useRef<HTMLDivElement | null>(null)
  const canvasDragRef = useRef({
    pointerId: -1,
    clientX: 0,
    clientY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  })
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false)

  const query = async (nextTag = tag) => {
    const trimmed = nextTag.trim()
    if (!trimmed) {
      setError('请输入 template_tag')
      return
    }
    setLoading(true)
    setError('')
    const result: { success?: boolean; data?: WorkflowTemplateResponse; error?: string } =
      await api.getWorkflowTemplate(trimmed).catch(exception => ({
      success: false,
      error: String(exception),
      }))
    if (result.success && result.data) {
      setResponse(result.data)
      setSelectedVersionId(result.data.selected_version_id)
      setSelectedNodeId(null)
    } else {
      setResponse(null)
      setSelectedVersionId(null)
      setError(result.error || '查询失败')
    }
    setLoading(false)
  }

  const selectedVersion = useMemo(
    () => response?.versions.find(version => version.template_version_id === selectedVersionId)
      ?? response?.versions.find(version => version.workflow) ?? null,
    [response, selectedVersionId],
  )
  const graph = selectedVersion?.workflow ?? null
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId) ?? null
  const normalizedSearch = searchText.trim().toLowerCase()
  const matchedNode = (node: WorkflowNode) => !normalizedSearch
    || node.label.toLowerCase().includes(normalizedSearch)
    || node.id.toLowerCase().includes(normalizedSearch)
    || node.type.toLowerCase().includes(normalizedSearch)

  useEffect(() => {
    if (!graph) return
    setZoom(initialWorkflowZoom(graph))
  }, [graph])

  const graphBounds = useMemo(
    () => graph ? workflowGraphBounds(graph) : null,
    [graph],
  )
  const edgeRoutes = useMemo(
    () => graph ? buildWorkflowRoutesForGraph(graph) : new Map<string, string>(),
    [graph],
  )
  const canvasWidth = Math.max(
    VIEW_WIDTH,
    graphBounds ? Math.ceil(graphBounds.width * zoom) : 0,
  )
  const canvasHeight = Math.max(
    VIEW_HEIGHT,
    graphBounds ? Math.ceil(graphBounds.height * zoom) : 0,
  )

  function stopCanvasDrag() {
    canvasDragRef.current.pointerId = -1
    setIsDraggingCanvas(false)
  }

  function handleCanvasDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const scroller = canvasScrollRef.current
    if (!scroller) return
    event.preventDefault()
    canvasDragRef.current = {
      pointerId: event.pointerId ?? -1,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    }
    setIsDraggingCanvas(true)
  }

  function handleCanvasDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = canvasDragRef.current
    const scroller = canvasScrollRef.current
    if (drag.pointerId === -1 || !scroller) return
    scroller.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX)
    scroller.scrollTop = drag.scrollTop - (event.clientY - drag.clientY)
  }

  useEffect(() => {
    const scroller = canvasScrollRef.current
    if (!graph || !scroller) return

    const handleWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        scroller.scrollTop += event.deltaY
        scroller.scrollLeft += event.deltaX
        return
      }

      event.preventDefault()
      const canvas = scroller.querySelector('[data-nodes="workflow-canvas"]')
      if (!(canvas instanceof SVGSVGElement)) return

      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)),
      )
      if (nextZoom === zoom) return

      const oldOffset = workflowGraphOffset(graph, zoom)
      const nextOffset = workflowGraphOffset(graph, nextZoom)
      const canvasRect = canvas.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const pointerX = event.clientX - canvasRect.left + scroller.scrollLeft
      const pointerY = event.clientY - canvasRect.top + scroller.scrollTop
      const graphX = (pointerX - oldOffset.offsetX) / zoom
      const graphY = (pointerY - oldOffset.offsetY) / zoom
      const nextPointerX = nextOffset.offsetX + graphX * nextZoom
      const nextPointerY = nextOffset.offsetY + graphY * nextZoom
      const canvasOffsetX = canvasRect.left - scrollerRect.left + scroller.scrollLeft
      const canvasOffsetY = canvasRect.top - scrollerRect.top + scroller.scrollTop

      setZoom(nextZoom)
      requestAnimationFrame(() => {
        scroller.scrollLeft = canvasOffsetX + nextPointerX
          - (event.clientX - scrollerRect.left)
        scroller.scrollTop = canvasOffsetY + nextPointerY
          - (event.clientY - scrollerRect.top)
      })
    }

    scroller.addEventListener('wheel', handleWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', handleWheel)
  }, [graph, zoom])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">工作流模板</h2>
          {graph?.label && <span className="max-w-[420px] truncate text-[12px] text-[#8b8b9e]">{graph.label}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-[360px] max-w-full bg-[#16161e] text-[12px]"
            value={tag}
            placeholder="template_tag"
            onChange={event => setTag(event.target.value)}
            onKeyDown={event => event.key === 'Enter' && void query()}
          />
          <Button size="sm" className="h-8" disabled={loading} onClick={() => void query()}>
            <Search className="mr-1 h-3.5 w-3.5" />{loading ? '查询中' : '查询'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />{error}
        </div>
      )}
      {!response && !error && !loading && (
        <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-10 text-center text-[12px] text-[#8b8b9e]">
          请输入 template_tag 后查询
        </div>
      )}
      {response && response.versions.length === 0 && (
        <div className="rounded-lg border border-[#252530] bg-[#16161e] px-3 py-8 text-center text-[12px] text-[#8b8b9e]">
          未找到模板版本
        </div>
      )}

      {response && response.versions.length > 0 && (
        <div className="rounded-xl border border-[#252530] bg-[#16161e]">
          <div className="flex flex-wrap items-center gap-2 border-b border-[#252530] px-3 py-2">
            <Database className="h-3.5 w-3.5 text-indigo-400" />
            <select
              className="h-7 min-w-[320px] rounded-md border border-[#252530] bg-[#0f0f14] px-2 text-[12px] text-[#cdd3e0]"
              value={selectedVersionId ?? undefined}
              onChange={event => {
                setSelectedVersionId(Number(event.target.value))
                setSelectedNodeId(null)
              }}
            >
              {response.versions.map(version => (
                <option key={version.template_version_id} value={version.template_version_id}>
                  版本 {version.template_version_id} · {version.valid_date || '无生效时间'}
                </option>
              ))}
            </select>
            {selectedVersion && <VersionBadge version={selectedVersion} />}
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-7 w-44 bg-[#0f0f14] text-[11px]"
                value={searchText}
                placeholder="搜索节点"
                onChange={event => setSearchText(event.target.value)}
              />
              <div className="flex items-center overflow-hidden rounded-md border border-[#252530]">
                <button className="h-7 px-2 text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]" title="缩小" onClick={() => setZoom(value => Math.max(MIN_ZOOM, value - 0.1))}>
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <button className="h-7 px-2 text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]" title="放大" onClick={() => setZoom(value => Math.min(MAX_ZOOM, value + 0.1))}>
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
                <button className="h-7 px-2 text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]" title="适应画布" onClick={() => graph && setZoom(fitWorkflowZoom(graph))}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <span data-zoom-value className="flex h-7 min-w-[52px] items-center justify-center border-l border-[#252530] px-1 font-mono text-[10px] text-[#8b8b9e]">
                  {Math.round(zoom * 100)}%
                </span>
              </div>
            </div>
          </div>

          {selectedVersion?.parse_error ? (
            <div className="flex items-start gap-2 px-4 py-8 text-[12px] text-red-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{selectedVersion.parse_error}</span>
            </div>
          ) : graph ? (
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div
                ref={canvasScrollRef}
                data-wheel-zoom="workflow-canvas"
                className={cn(
                  'max-h-[min(78vh,800px)] touch-none overflow-auto overscroll-contain bg-[#0b0b10] p-3 select-none',
                  isDraggingCanvas ? 'cursor-grabbing' : 'cursor-grab',
                )}
                onPointerDown={handleCanvasDrag}
                onPointerMove={handleCanvasDragMove}
                onPointerUp={stopCanvasDrag}
                onPointerLeave={stopCanvasDrag}
              >
                <svg
                  data-nodes="workflow-canvas"
                  className="block max-w-none"
                  width={canvasWidth}
                  height={canvasHeight}
                  viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
                  role="img"
                  aria-label={graph.label || '工作流图'}
                >
                  <defs>
                    <marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" fill="#6b7280" />
                    </marker>
                    <marker id="workflow-arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" fill="#818cf8" />
                    </marker>
                  </defs>
                  <g transform={workflowGraphTransform(graph, zoom)}>
                    <rect width={graph.width + 40} height={graph.height + 40} fill="#0b0b10" />
                    {graph.edges.map(edge => {
                      const path = edgeRoutes.get(edge.id)
                      if (!path) return null
                      const isActive = selectedNodeId === edge.source || selectedNodeId === edge.target
                      const isDimmed = Boolean(selectedNodeId) && !isActive
                      return (
                        <path
                          key={edge.id}
                          d={path}
                          fill="none"
                          stroke={isActive ? '#818cf8' : '#4b5563'}
                          strokeWidth={isActive ? 2.4 : 1.25}
                          opacity={isDimmed ? 0.18 : 0.92}
                          markerEnd={`url(#${isActive ? 'workflow-arrow-active' : 'workflow-arrow'})`}
                        >
                          <title>{`${edge.source} → ${edge.target}`}</title>
                        </path>
                      )
                    })}
                    {graph.nodes.map(node => {
                      const style = NODE_STYLES[node.type] ?? NODE_STYLES.csf_service
                      const isSelected = node.id === selectedNodeId
                      const isMatched = matchedNode(node)
                      const lines = nodeLines(node)
                      const shape = nodeShape(node.type)
                      const diamondPoints = [
                        `${node.width / 2},0`,
                        `${node.width},${node.height / 2}`,
                        `${node.width / 2},${node.height}`,
                        `0,${node.height / 2}`,
                      ].join(' ')
                      return (
                        <g
                          key={node.id}
                          transform={`translate(${node.x}, ${node.y})`}
                          opacity={Math.min(
                            normalizedSearch && !isMatched ? 0.3 : 1,
                            nodeOpacity(node.type, isSelected),
                          )}
                          className="cursor-pointer"
                          onClick={() => setSelectedNodeId(node.id)}
                        >
                          {shape === 'compact' ? (
                            <circle cx={node.width / 2} cy={node.height / 2} r={node.width / 2} fill={style.fill} stroke={isSelected ? '#ffffff' : style.stroke} strokeWidth={nodeBorderWidth(node.type, isSelected)} />
                          ) : shape === 'decision' ? (
                            <polygon
                              points={diamondPoints}
                              fill={style.fill}
                              stroke={isSelected ? '#ffffff' : style.stroke}
                              strokeWidth={nodeBorderWidth(node.type, isSelected)}
                              strokeDasharray={decisionNode(node.type) ? '5 4' : undefined}
                            />
                          ) : (
                            <rect width={node.width} height={node.height} rx="4" fill={style.fill} stroke={isSelected ? '#ffffff' : style.stroke} strokeWidth={nodeBorderWidth(node.type, isSelected)} />
                          )}
                          {shape === 'compact' ? (
                            lines.map((line, index) => (
                              <text key={line + index} x={node.width / 2} y={node.height + 14 + index * 11} textAnchor="middle" fontSize="9" fill={style.text}>
                                {line}
                              </text>
                            ))
                          ) : lines.map((line, index) => (
                            <text key={line + index} x={node.width / 2} y={node.height / 2 + (index - (lines.length - 1) / 2) * 12} textAnchor="middle" fontSize="9.5" fill={style.text}>
                              {line}
                            </text>
                          ))}
                          {normalizedSearch && isMatched && (
                            shape === 'decision' ? (
                              <polygon points={diamondPoints} fill="none" stroke="#fbbf24" strokeWidth="1.5" transform="translate(2, 2) scale(0.97)" />
                            ) : (
                              <rect x="-2" y="-2" width={node.width + 4} height={node.height + 4} rx="5" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
                            )
                          )}
                        </g>
                      )
                    })}
                  </g>
                </svg>
              </div>
              <aside className="min-h-0 border-t border-[#252530] p-3 xl:border-l xl:border-t-0">
                {selectedNode ? <NodeDetails node={selectedNode} graph={graph} /> : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div><div className="text-[15px] font-semibold text-[#e4e4e9]">{graph.nodes.length}</div><div className="text-[10px] text-[#8b8b9e]">节点</div></div>
                      <div><div className="text-[15px] font-semibold text-[#e4e4e9]">{graph.edges.length}</div><div className="text-[10px] text-[#8b8b9e]">连线</div></div>
                      <div><div className="text-[15px] font-semibold text-[#e4e4e9]">{graph.variables.length}</div><div className="text-[10px] text-[#8b8b9e]">变量</div></div>
                    </div>
                    {graph.warnings.length > 0 && (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                        {graph.warnings.map(warning => <div key={warning}>{warning}</div>)}
                      </div>
                    )}
                    <div className="space-y-1 text-[11px] text-[#8b8b9e]">
                      <div>tasktag：{graph.tasktag || '—'}</div>
                      <div>owntype：{graph.owntype || '—'}</div>
                      <div>description：{graph.description || '—'}</div>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
