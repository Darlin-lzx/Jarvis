import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type {
  WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowParseResponse,
  WorkflowTemplateResponse, WorkflowTemplateVersion,
} from '@/lib/types'
import { buildWorkflowRoutesForGraph } from './workflow-edge-routing'
import {
  addGotoItem, addTaskElement, deleteGotoItem, deleteJoinElement, deleteTaskElement,
  moveTaskElement, parseXmlDocument, serializeXmlDocument, setTaskLabel, setTaskLinks,
  setTaskService, taskTypeOptions,
} from './workflow-xml-editor'
import type { XmlDocument } from './workflow-xml-editor'
import { WorkflowNodeEditor } from './workflow-node-editor'
import type { WorkflowNodeDraft } from './workflow-node-editor'
import { WorkflowExportDialog } from './workflow-export-dialog'
import {
  AlertTriangle, CircleAlert, Cloud, Database, FileCode, FileDown, HardDrive, Link2, Maximize2,
  Network, Pencil, Plus, RotateCcw, Search, Workflow, ZoomIn, ZoomOut, Check, Copy,
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

function defaultGeometryFor(tasktype: string) {
  return compactNode(tasktype) ? { width: 30, height: 30 } : { width: 120, height: 60 }
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

function formatWorkflowXml(raw: string) {
  const compact = raw.replace(/>\s+</g, '><').trim()
  if (!compact) return null
  const parts = compact.split(/(<[^>]*>)/g).filter(part => part.length > 0)
  const lines: string[] = []
  let depth = 0
  let lastLineHasText = false
  for (const part of parts) {
    if (part.startsWith('<?') || part.startsWith('<!')) {
      lines.push('  '.repeat(depth) + part)
      lastLineHasText = false
      continue
    }
    if (part.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      if (lastLineHasText) lines[lines.length - 1] += part
      else lines.push('  '.repeat(depth) + part)
      lastLineHasText = false
      continue
    }
    if (part.startsWith('<')) {
      lines.push('  '.repeat(depth) + part)
      if (!part.endsWith('/>')) depth += 1
      lastLineHasText = false
      continue
    }
    const value = part.trim()
    if (value) {
      if (lines.length > 0) lines[lines.length - 1] += value
      else lines.push(value)
      lastLineHasText = true
    }
  }
  return lines.length > 0 ? lines.join('\n') : null
}

function XmlView({ content, modified }: { content: string | null; modified?: boolean }) {
  const [formatted, setFormatted] = useState(true)
  const [copied, setCopied] = useState(false)
  const text = content ?? ''
  const formattedText = useMemo(() => formatWorkflowXml(text), [text])
  const displayText = formatted && formattedText ? formattedText : text

  async function copyXml() {
    try {
      await navigator.clipboard.writeText(displayText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  if (!text.trim()) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-[#8b8b9e]">该版本无内容</div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-[#252530] px-3 py-1.5">
        {modified && (
          <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            已修改
          </span>
        )}
        <div className="flex items-center overflow-hidden rounded-md border border-[#252530]" data-xml-format-toggle>
          <button
            className={cn(
              'h-6 px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-40',
              formatted && formattedText ? 'bg-white/10 text-[#e4e4e9]' : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
            )}
            disabled={!formattedText}
            onClick={() => setFormatted(true)}
          >
            格式化
          </button>
          <button
            className={cn(
              'h-6 px-2 text-[11px]',
              !formatted || !formattedText ? 'bg-white/10 text-[#e4e4e9]' : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
            )}
            onClick={() => setFormatted(false)}
          >
            原始
          </button>
        </div>
        <span className="text-[10px] text-[#5a5a70]">{displayText.length} 字符</span>
        <button
          className="ml-auto flex h-6 items-center gap-1 rounded-md border border-[#252530] px-2 text-[11px] text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]"
          onClick={() => void copyXml()}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre data-xml-content className="max-h-[min(78vh,800px)] overflow-auto bg-[#0b0b10] p-3 font-mono text-[11px] leading-5 whitespace-pre select-text text-[#cdd3e0]">
        {displayText}
      </pre>
    </div>
  )
}

function AddNodeDialog({ open, onOpenChange, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (tasktype: string, label: string) => void
}) {
  const [tasktype, setTasktype] = useState('csf_service')
  const [label, setLabel] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="text-[15px]">添加节点</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-[11px] text-[#8b8b9e]">
          <label className="block space-y-1">
            <span>节点类型</span>
            <select
              className="h-8 w-full rounded-md border border-[#252530] bg-[#0f0f14] px-2 text-[12px] text-[#cdd3e0]"
              value={tasktype}
              onChange={event => setTasktype(event.target.value)}
            >
              {taskTypeOptions().map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span>label</span>
            <Input
              className="h-8 bg-[#0f0f14] text-[12px]"
              placeholder="节点名称"
              value={label}
              onChange={event => setLabel(event.target.value)}
            />
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            size="sm"
            className="h-8"
            disabled={!label.trim()}
            onClick={() => {
              onConfirm(tasktype, label.trim())
              onOpenChange(false)
            }}
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

export function WorkflowPanel({ initialTag }: { initialTag?: string } = {}) {
  const [tag, setTag] = useState(DEFAULT_TAG)
  const [dbSource, setDbSource] = useState<'remote' | 'local'>(() =>
    localStorage.getItem('workflow_db_source') === 'local' ? 'local' : 'remote')
  const [response, setResponse] = useState<WorkflowTemplateResponse | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [viewMode, setViewMode] = useState<'graph' | 'xml'>('graph')
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [connectMode, setConnectMode] = useState(false)
  const [connectSource, setConnectSource] = useState<string | null>(null)
  const [editedXml, setEditedXml] = useState<string | null>(null)
  const [editedGraph, setEditedGraph] = useState<WorkflowGraph | null>(null)
  const [editError, setEditError] = useState('')
  const [parsing, setParsing] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [addNodeOpen, setAddNodeOpen] = useState(false)
  const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number } | null>(null)
  const xmlDocRef = useRef<XmlDocument | null>(null)
  const nodeDragRef = useRef({
    pointerId: -1,
    nodeId: '',
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  })
  const canvasScrollRef = useRef<HTMLDivElement | null>(null)
  const canvasDragRef = useRef({
    pointerId: -1,
    clientX: 0,
    clientY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  })
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false)

  const query = async (nextTag = tag, nextSource = dbSource) => {
    const trimmed = nextTag.trim()
    if (!trimmed) {
      setError('请输入 template_tag')
      return
    }
    setLoading(true)
    setError('')
    const result: { success?: boolean; data?: WorkflowTemplateResponse; error?: string } =
      await api.getWorkflowTemplate(trimmed, nextSource).catch(exception => ({
      success: false,
      error: String(exception),
      }))
    if (result.success && result.data) {
      setResponse(result.data)
      setSelectedVersionId(result.data.selected_version_id)
      setSelectedNodeId(null)
      resetEdits()
      setEditMode(false)
      setConnectMode(false)
    } else {
      setResponse(null)
      setSelectedVersionId(null)
      setError(result.error || '查询失败')
    }
    setLoading(false)
  }

  // 外部跳转（如订单组件的 workflow_code 点击）：自动填入模板编码并查询
  // 注意：不能用「与当前 tag 相同则跳过」守卫——DEFAULT_TAG 恰好可能是被点击的编码
  useEffect(() => {
    const trimmed = initialTag?.trim()
    if (!trimmed) return
    setTag(trimmed)
    void query(trimmed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTag])

  const selectedVersion = useMemo(
    () => response?.versions.find(version => version.template_version_id === selectedVersionId)
      ?? response?.versions[0] ?? null,
    [response, selectedVersionId],
  )

  /** 页面级数据库开关：记住选择；已查询过时切换后自动按新库重查 */
  function switchDbSource(next: 'remote' | 'local') {
    if (next === dbSource) return
    setDbSource(next)
    localStorage.setItem('workflow_db_source', next)
    resetEdits()
    setEditMode(false)
    if (response) void query(tag, next)
  }
  const graph = editedGraph ?? selectedVersion?.workflow ?? null
  const effectiveXml = editedXml ?? selectedVersion?.content ?? null
  const hasEdits = editedXml !== null
  const editable = editMode && graph !== null
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId) ?? null
  const normalizedSearch = searchText.trim().toLowerCase()
  const matchedNode = (node: WorkflowNode) => !normalizedSearch
    || node.label.toLowerCase().includes(normalizedSearch)
    || node.id.toLowerCase().includes(normalizedSearch)
    || node.type.toLowerCase().includes(normalizedSearch)

  const exportDefaults = useMemo(() => ({
    templateTag: response?.template_tag ?? '',
    orderNum: String((response?.versions ?? []).reduce(
      (max, version) => Math.max(max, version.order_num ?? 0), 0,
    ) + 1),
    createStaffId: String(selectedVersion?.create_staff_id ?? ''),
  }), [response, selectedVersion])

  function resetEdits() {
    xmlDocRef.current = null
    setEditedXml(null)
    setEditedGraph(null)
    setEditError('')
    setConnectSource(null)
    setDragPreview(null)
  }

  /** 在 token 树上执行编辑并序列化；结构性编辑回传后端重新解析刷新图形。 */
  async function applyEdit(mutate: (doc: XmlDocument) => void, reparse = true) {
    const base = selectedVersion?.content ?? ''
    if (!xmlDocRef.current) {
      try {
        xmlDocRef.current = parseXmlDocument(base)
      } catch (exception) {
        setEditError(`XML 解析失败: ${exception instanceof Error ? exception.message : String(exception)}`)
        return
      }
    }
    try {
      mutate(xmlDocRef.current)
    } catch (exception) {
      setEditError(exception instanceof Error ? exception.message : String(exception))
      return
    }
    const nextXml = serializeXmlDocument(xmlDocRef.current)
    setEditedXml(nextXml)
    if (!reparse) return
    setParsing(true)
    const result: { success?: boolean; data?: WorkflowParseResponse; error?: string } =
      await api.parseWorkflowTemplate(nextXml)
        .catch(exception => ({ success: false, error: String(exception) }))
    setParsing(false)
    if (result.success && result.data) {
      if (result.data.workflow) {
        setEditedGraph(result.data.workflow)
        setEditError('')
      } else {
        setEditError(result.data.parse_error || 'XML 解析失败')
      }
    } else {
      setEditError(result.error || '工作流模板解析失败')
    }
  }

  function toggleEditMode() {
    setEditMode(value => !value)
    setConnectMode(false)
    setConnectSource(null)
    setViewMode('graph')
  }

  function handleNodeClick(node: WorkflowNode) {
    if (editable && connectMode) {
      if (!connectSource) {
        setConnectSource(node.id)
        return
      }
      if (node.id === connectSource) {
        setConnectSource(null)
        return
      }
      const source = connectSource
      setConnectSource(null)
      void applyEdit(doc => { addGotoItem(doc, source, node.id) })
      return
    }
    setSelectedNodeId(node.id)
  }

  function handleEdgeClick(edge: WorkflowEdge) {
    if (!editable || !graph) return
    const sourceLabel = graph.nodes.find(item => item.id === edge.source)?.label || edge.source
    const targetLabel = graph.nodes.find(item => item.id === edge.target)?.label || edge.target
    if (!window.confirm(`删除连线 ${sourceLabel} → ${targetLabel}？`)) return
    void applyEdit(doc => {
      if (edge.source_kind === 'join') deleteJoinElement(doc, edge.source, edge.target)
      else deleteGotoItem(doc, edge.source, edge.target)
    })
  }

  function handleNodeDragStart(event: ReactPointerEvent<SVGGElement>, node: WorkflowNode) {
    if (!editable || event.button !== 0) return
    event.stopPropagation()
    nodeDragRef.current = {
      pointerId: event.pointerId ?? -1,
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.x,
      originY: node.y,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragPreview({ id: node.id, x: node.x, y: node.y })
  }

  function handleNodeDragMove(event: ReactPointerEvent<SVGGElement>) {
    const drag = nodeDragRef.current
    if (drag.pointerId === -1 || drag.pointerId !== event.pointerId) return
    setDragPreview({
      id: drag.nodeId,
      x: drag.originX + (event.clientX - drag.startX) / zoom,
      y: drag.originY + (event.clientY - drag.startY) / zoom,
    })
  }

  function handleNodeDragEnd(event: ReactPointerEvent<SVGGElement>) {
    const drag = nodeDragRef.current
    nodeDragRef.current = { ...nodeDragRef.current, pointerId: -1, nodeId: '' }
    if (drag.pointerId === -1) return
    event.currentTarget.releasePointerCapture?.(drag.pointerId)
    const preview = dragPreview
    setDragPreview(null)
    const node = graph?.nodes.find(item => item.id === drag.nodeId)
    if (!preview || !node || !editable) return
    const base = editedGraph ?? selectedVersion?.workflow
    if (base) {
      // 拖拽只改坐标：本地更新图形，不触发后端解析
      setEditedGraph({
        ...base,
        nodes: base.nodes.map(item => item.id === node.id
          ? { ...item, x: Math.round(preview.x), y: Math.round(preview.y) }
          : item),
      })
    }
    void applyEdit(doc => {
      moveTaskElement(doc, node.id, preview.x, preview.y, node.width, node.height)
    }, false)
  }

  function handleAddNode(tasktype: string, label: string) {
    if (!graph) return
    const bounds = workflowGraphBounds(graph)
    const geometry = defaultGeometryFor(tasktype)
    void applyEdit(doc => {
      addTaskElement(doc, {
        id: String(Date.now()),
        label,
        tasktype,
        x: bounds.minX + bounds.width / 2 - geometry.width / 2,
        y: bounds.minY + bounds.height / 2 - geometry.height / 2,
        width: geometry.width,
        height: geometry.height,
      })
    })
  }

  function handleDeleteNode(nodeId: string) {
    if (!graph) return
    const label = graph.nodes.find(item => item.id === nodeId)?.label || nodeId
    if (!window.confirm(`删除节点 ${label} 及其所有连线？`)) return
    setSelectedNodeId(null)
    void applyEdit(doc => { deleteTaskElement(doc, nodeId) })
  }

  function handleSaveNode(nodeId: string, draft: WorkflowNodeDraft) {
    void applyEdit(doc => {
      setTaskLabel(doc, nodeId, draft.label)
      setTaskService(doc, nodeId, draft.service)
      setTaskLinks(doc, nodeId, draft.links)
    })
  }

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
          <div className="flex items-center overflow-hidden rounded-md border border-[#252530]" data-db-source="workflow-panel">
            <button
              className={cn(
                'flex h-8 items-center gap-1 px-2.5 text-[11px]',
                dbSource === 'remote' ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
              )}
              title="读远端工作流配置库"
              onClick={() => switchDbSource('remote')}
            >
              <Cloud className="h-3.5 w-3.5" />远端库
            </button>
            <button
              className={cn(
                'flex h-8 items-center gap-1 px-2.5 text-[11px]',
                dbSource === 'local' ? 'bg-indigo-500/20 text-indigo-300' : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
              )}
              title="直读 Jarvis 本地库（jarvis 库，无需注册数据源）"
              onClick={() => switchDbSource('local')}
            >
              <HardDrive className="h-3.5 w-3.5" />本地库
            </button>
          </div>
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
              value={selectedVersionId ?? selectedVersion?.template_version_id ?? undefined}
              onChange={event => {
                setSelectedVersionId(Number(event.target.value))
                setSelectedNodeId(null)
                resetEdits()
              }}
            >
              {response.versions.map(version => (
                <option key={version.template_version_id} value={version.template_version_id}>
                  版本 {version.template_version_id} · {version.valid_date || '无生效时间'}
                </option>
              ))}
            </select>
            {selectedVersion && <VersionBadge version={selectedVersion} />}
            {hasEdits && (
              <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                已修改
              </span>
            )}
            {graph && (
              <div className="flex items-center gap-1.5">
                <button
                  data-edit-toggle="workflow-panel"
                  className={cn(
                    'flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]',
                    editMode
                      ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                      : 'border-[#252530] text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
                  )}
                  title={editMode ? '退出编辑' : '进入编辑（拖拽移动节点、增删节点与连线、修改属性）'}
                  onClick={toggleEditMode}
                >
                  <Pencil className="h-3.5 w-3.5" />编辑
                </button>
                {editMode && (
                  <>
                    <button
                      data-connect-toggle="workflow-panel"
                      className={cn(
                        'flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]',
                        connectMode
                          ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                          : 'border-[#252530] text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
                      )}
                      title="连续点击两个节点创建连线"
                      onClick={() => {
                        setConnectMode(value => !value)
                        setConnectSource(null)
                      }}
                    >
                      <Link2 className="h-3.5 w-3.5" />连线
                    </button>
                    <button
                      data-add-node="workflow-panel"
                      className="flex h-7 items-center gap-1 rounded-md border border-[#252530] px-2 text-[11px] text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]"
                      onClick={() => setAddNodeOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />添加节点
                    </button>
                    {hasEdits && (
                      <button
                        data-reset-edits="workflow-panel"
                        className="flex h-7 items-center gap-1 rounded-md border border-[#252530] px-2 text-[11px] text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]"
                        title="放弃修改，恢复该版本原始 XML"
                        onClick={resetEdits}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />重置
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <button
              data-export-sql="workflow-panel"
              className="flex h-7 items-center gap-1 rounded-md border border-[#252530] px-2 text-[11px] text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0] disabled:opacity-40"
              title="导出为 vm_template_version INSERT 语句（XML 按 4000 字符分块）"
              disabled={!effectiveXml}
              onClick={() => setExportOpen(true)}
            >
              <FileDown className="h-3.5 w-3.5" />导出 SQL
            </button>
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center overflow-hidden rounded-md border border-[#252530]" data-view-mode="workflow-panel">
                <button
                  className={cn(
                    'flex h-7 items-center gap-1 px-2 text-[11px]',
                    viewMode === 'graph' ? 'bg-white/10 text-[#e4e4e9]' : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
                  )}
                  title="图形视图"
                  onClick={() => setViewMode('graph')}
                >
                  <Network className="h-3.5 w-3.5" />图形
                </button>
                <button
                  className={cn(
                    'flex h-7 items-center gap-1 px-2 text-[11px]',
                    viewMode === 'xml' ? 'bg-white/10 text-[#e4e4e9]' : 'text-[#8b8b9e] hover:bg-white/5 hover:text-[#cdd3e0]',
                  )}
                  title="XML 视图"
                  onClick={() => setViewMode('xml')}
                >
                  <FileCode className="h-3.5 w-3.5" />XML
                </button>
              </div>
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

          {editError && (
            <div className="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {editError}
                {hasEdits && '（当前图形未同步，可通过「重置」恢复原文）'}
              </span>
            </div>
          )}
          {parsing && (
            <div className="border-b border-[#252530] px-4 py-1.5 text-[11px] text-[#8b8b9e]">
              正在重新解析…
            </div>
          )}
          {viewMode === 'xml' ? (
            <XmlView content={effectiveXml} modified={hasEdits} />
          ) : selectedVersion?.parse_error && !graph ? (
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
                        <g key={edge.id}>
                          {editable && (
                            <path
                              d={path}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={10}
                              className="cursor-pointer"
                              onClick={() => handleEdgeClick(edge)}
                            >
                              <title>{`删除连线 ${edge.source} → ${edge.target}`}</title>
                            </path>
                          )}
                          <path
                            d={path}
                            fill="none"
                            stroke={isActive ? '#818cf8' : '#4b5563'}
                            strokeWidth={isActive ? 2.4 : 1.25}
                            opacity={isDimmed ? 0.18 : 0.92}
                            pointerEvents={editable ? 'none' : undefined}
                            markerEnd={`url(#${isActive ? 'workflow-arrow-active' : 'workflow-arrow'})`}
                          >
                            <title>{`${edge.source} → ${edge.target}`}</title>
                          </path>
                        </g>
                      )
                    })}
                    {graph.nodes.map(node => {
                      const style = NODE_STYLES[node.type] ?? NODE_STYLES.csf_service
                      const position = dragPreview && dragPreview.id === node.id ? dragPreview : node
                      const isSelected = node.id === selectedNodeId
                      const isConnectSource = connectMode && connectSource === node.id
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
                          data-node-id={node.id}
                          transform={`translate(${position.x}, ${position.y})`}
                          opacity={Math.min(
                            normalizedSearch && !isMatched ? 0.3 : 1,
                            nodeOpacity(node.type, isSelected),
                          )}
                          className={cn(
                            'cursor-pointer',
                            editable && connectMode && 'cursor-crosshair',
                            editable && !connectMode && 'cursor-move',
                          )}
                          onPointerDown={event => handleNodeDragStart(event, node)}
                          onPointerMove={handleNodeDragMove}
                          onPointerUp={handleNodeDragEnd}
                          onPointerCancel={handleNodeDragEnd}
                          onClick={() => handleNodeClick(node)}
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
                          {isConnectSource && (
                            shape === 'decision' ? (
                              <polygon points={diamondPoints} fill="none" stroke="#f59e0b" strokeWidth="2.5" transform="translate(4, 4) scale(0.94)" />
                            ) : (
                              <rect x="-4" y="-4" width={node.width + 8} height={node.height + 8} rx="7" fill="none" stroke="#f59e0b" strokeWidth="2.5" />
                            )
                          )}
                        </g>
                      )
                    })}
                  </g>
                </svg>
              </div>
              <aside className="min-h-0 border-t border-[#252530] p-3 xl:border-l xl:border-t-0">
                {selectedNode ? (
                  editable ? (
                    <WorkflowNodeEditor
                      key={`${selectedNode.id}-${selectedNode.label}-${selectedNode.links.length}`}
                      node={selectedNode}
                      graph={graph}
                      onSave={draft => handleSaveNode(selectedNode.id, draft)}
                      onDeleteNode={() => handleDeleteNode(selectedNode.id)}
                    />
                  ) : (
                    <NodeDetails node={selectedNode} graph={graph} />
                  )
                ) : (
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

      <WorkflowExportDialog
        key={exportOpen ? 'open' : 'closed'}
        open={exportOpen}
        onOpenChange={setExportOpen}
        xml={effectiveXml ?? ''}
        defaults={exportDefaults}
        table={response?.version_table}
      />
      <AddNodeDialog
        key={addNodeOpen ? 'open' : 'closed'}
        open={addNodeOpen}
        onOpenChange={setAddNodeOpen}
        onConfirm={handleAddNode}
      />
    </div>
  )
}
