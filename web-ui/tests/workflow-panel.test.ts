import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/workbench/workflow-panel.tsx', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')
const workbenchSource = readFileSync(
  new URL('../src/components/workbench/workbench-view.tsx', import.meta.url),
  'utf8',
)
const sidebarSource = readFileSync(new URL('../src/components/layout/sidebar.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('workflow panel queries by encoded template tag', () => {
  assert.equal(apiSource.includes('getWorkflowTemplate: async (tag: string,'), true)
  assert.equal(apiSource.includes('encodeURIComponent(tag)'), true)
  assert.equal(apiSource.includes('&source=${source}'), true)
  assert.equal(source.includes('api.getWorkflowTemplate(trimmed, nextSource)'), true)
  assert.equal(source.includes("const DEFAULT_TAG = 'com.ai.order.workflow.shedule.vm.GsmYdkjNewWFSchedule'"), true)
  assert.equal(source.includes('void query(DEFAULT_TAG)'), false)
  assert.equal(source.includes('请输入 template_tag 后查询'), true)
})

test('workflow panel switches database source between remote and local', () => {
  assert.equal(source.includes('data-db-source="workflow-panel"'), true)
  assert.equal(source.includes("useState<'remote' | 'local'>(() =>"), true)
  assert.equal(source.includes("localStorage.getItem('workflow_db_source')"), true)
  assert.equal(source.includes("localStorage.setItem('workflow_db_source', next)"), true)
  assert.equal(source.includes("function switchDbSource(next: 'remote' | 'local')"), true)
  assert.equal(source.includes('远端库'), true)
  assert.equal(source.includes('本地库'), true)
})

test('workflow API preserves backend error details', () => {
  assert.equal(apiSource.includes("error: body?.detail || `工作流模板查询失败 (${res.status})`"), true)
})

test('workflow panel renders original coordinates and version selection', () => {
  assert.equal(source.includes('data-nodes="workflow-canvas"'), true)
  assert.equal(source.includes('const VIEW_WIDTH = 1280'), true)
  assert.equal(source.includes('const VIEW_HEIGHT = 800'), true)
  assert.equal(source.includes('const INITIAL_ZOOM_FACTOR = 1.15'), true)
  assert.equal(source.includes('const MIN_INITIAL_ZOOM = 0.4'), true)
  assert.equal(source.includes('const MAX_ZOOM = 3'), true)
  assert.equal(source.includes('function fitWorkflowZoom(graph: WorkflowGraph)'), true)
  assert.equal(source.includes('function workflowGraphTransform(graph: WorkflowGraph, zoom: number)'), true)
  assert.equal(source.includes("from './workflow-edge-routing'"), true)
  assert.equal(source.includes('buildWorkflowRoutesForGraph(graph)'), true)
  assert.equal(source.includes('function nodeLines(node: WorkflowNode)'), true)
  assert.equal(source.includes("function nodeShape(type: string)"), true)
  assert.equal(source.includes("function decisionNode(type: string)"), true)
  assert.equal(source.includes("function nodeBorderWidth(type: string, isSelected: boolean)"), true)
  assert.equal(source.includes("function nodeOpacity(type: string, isSelected: boolean)"), true)
  assert.equal(source.includes('strokeDasharray={decisionNode(node.type) ? \'5 4\' : undefined}'), true)
  assert.equal(source.includes('Math.round(zoom * 100)'), true)
  assert.equal(source.includes('wheel-zoom'), true)
  assert.equal(source.includes('function handleCanvasDrag'), true)
  assert.equal(source.includes('event.ctrlKey || event.metaKey'), true)
  assert.equal(source.includes('scroller.scrollTop += event.deltaY'), true)
  assert.match(source, /max-h-\[min\(78vh,800px\)\]/)
  assert.match(source, /const canvasWidth = Math\.max\(\s*VIEW_WIDTH/)
  assert.match(source, /const canvasHeight = Math\.max\(\s*VIEW_HEIGHT/)
  assert.equal(source.includes('node.x'), true)
  assert.equal(source.includes('node.y'), true)
  assert.equal(source.includes('selectedVersionId'), true)
  assert.equal(source.includes('response?.versions[0] ?? null'), true)
})

test('workflow panel exposes details, search, zoom, and parse errors', () => {
  assert.equal(source.includes('selectedVersion?.parse_error'), true)
  assert.equal(source.includes('servicecode'), true)
  assert.equal(source.includes('searchText'), true)
  assert.equal(source.includes('setZoom'), true)
  assert.equal(typesSource.includes('export interface WorkflowTemplateVersion'), true)
})

test('workflow panel switches between graph and xml view', () => {
  assert.equal(source.includes(`useState<'graph' | 'xml'>('graph')`), true)
  assert.equal(source.includes(`data-view-mode="workflow-panel"`), true)
  assert.equal(source.includes("setViewMode('graph')"), true)
  assert.equal(source.includes("setViewMode('xml')"), true)
  assert.equal(source.includes('<XmlView content={effectiveXml} modified={hasEdits} />'), true)
  assert.equal(source.includes('该版本无内容'), true)
  assert.equal(source.includes('data-xml-content'), true)
  assert.equal(typesSource.includes('content: string | null'), true)
})

test('workflow panel edit mode wires xml editor operations', () => {
  assert.equal(source.includes('data-edit-toggle="workflow-panel"'), true)
  assert.equal(source.includes('function toggleEditMode()'), true)
  assert.equal(source.includes('data-connect-toggle="workflow-panel"'), true)
  assert.equal(source.includes('addGotoItem(doc, source, node.id)'), true)
  assert.equal(source.includes('data-add-node="workflow-panel"'), true)
  assert.equal(source.includes('data-reset-edits="workflow-panel"'), true)
  assert.equal(source.includes('function resetEdits()'), true)
  assert.equal(source.includes('async function applyEdit(mutate: (doc: XmlDocument) => void, reparse = true)'), true)
  assert.equal(source.includes('api.parseWorkflowTemplate(nextXml)'), true)
  assert.equal(source.includes('moveTaskElement(doc, node.id, preview.x, preview.y, node.width, node.height)'), true)
  assert.equal(source.includes('deleteTaskElement(doc, nodeId)'), true)
  assert.equal(source.includes('setTaskLabel(doc, nodeId, draft.label)'), true)
  assert.equal(source.includes('setTaskLinks(doc, nodeId, draft.links)'), true)
  assert.equal(source.includes('deleteJoinElement(doc, edge.source, edge.target)'), true)
  assert.equal(source.includes('handleNodeDragStart'), true)
  assert.equal(source.includes('setPointerCapture'), true)
  assert.equal(source.includes('WorkflowNodeEditor'), true)
  assert.equal(source.includes('const effectiveXml = editedXml ?? selectedVersion?.content ?? null'), true)
})

test('node editor saves label, service and links in one atomic edit', () => {
  const editorSource = readFileSync(
    new URL('../src/components/workbench/workflow-node-editor.tsx', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes('function handleSaveNode(nodeId: string, draft: WorkflowNodeDraft)'), true)
  assert.equal(source.includes('setTaskLabel(doc, nodeId, draft.label)'), true)
  assert.equal(source.includes('setTaskService(doc, nodeId, draft.service)'), true)
  assert.equal(source.includes('setTaskLinks(doc, nodeId, draft.links)'), true)
  assert.equal(source.includes("onSave={draft => handleSaveNode(selectedNode.id, draft)}"), true)
  assert.equal(editorSource.includes('保存全部修改'), true)
  assert.equal(editorSource.includes('export interface WorkflowNodeDraft'), true)
  assert.equal(editorSource.includes('onSave: (draft: WorkflowNodeDraft) => void'), true)
})

test('workflow panel exports sql with edited xml', () => {
  assert.equal(source.includes('data-export-sql="workflow-panel"'), true)
  assert.equal(source.includes('<WorkflowExportDialog'), true)
  assert.equal(source.includes("xml={effectiveXml ?? ''}"), true)
  assert.equal(source.includes('table={response?.version_table}'), true)
  assert.equal(typesSource.includes('version_table?: string'), true)
  assert.equal(apiSource.includes('parseWorkflowTemplate: async (xml: string)'), true)
  assert.equal(apiSource.includes("'/api/workflow-templates/parse'"), true)
  assert.equal(typesSource.includes('export interface WorkflowParseResponse'), true)
})

test('workflow xml view formats content and falls back to raw text', () => {
  assert.equal(source.includes('function formatWorkflowXml(raw: string)'), true)
  assert.equal(source.includes(`raw.replace(/>\\s+</g, '><')`), true)
  assert.equal(source.includes('formatted && formattedText ? formattedText : text'), true)
  assert.equal(source.includes('disabled={!formattedText}'), true)
  assert.equal(source.includes('navigator.clipboard.writeText(displayText)'), true)
  assert.match(source, /max-h-\[min\(78vh,800px\)\] overflow-auto bg-\[#0b0b10\] p-3 font-mono/)
})

test('workflow panel renders deterministic routed edges', () => {
  assert.equal(source.includes("from './workflow-edge-routing'"), true)
  assert.equal(source.includes('const edgeRoutes = useMemo'), true)
  assert.equal(source.includes('orthogonalEdgePath'), false)
  assert.equal(source.includes("strokeWidth={isActive ? 2.4 : 1.25}"), true)
  assert.equal(source.includes('opacity={isDimmed ? 0.18 : 0.92}'), true)
})

test('workflow panel is reachable from workbench navigation', () => {
  assert.equal(workbenchSource.includes("import { WorkflowPanel } from './workflow-panel'"), true)
  assert.equal(workbenchSource.includes("case 'workflows': return <WorkflowPanel />"), true)
  assert.equal(sidebarSource.includes("value: 'workflows'"), true)
  assert.equal(sidebarSource.includes("label: '工作流'"), true)
  assert.equal(appSource.includes("'workflows'"), true)
})
