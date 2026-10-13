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
  assert.equal(apiSource.includes('getWorkflowTemplate: async (tag: string)'), true)
  assert.equal(apiSource.includes('encodeURIComponent(tag)'), true)
  assert.equal(source.includes('api.getWorkflowTemplate(trimmed)'), true)
  assert.equal(source.includes("const DEFAULT_TAG = 'com.ai.order.workflow.shedule.vm.GsmYdkjNewWFSchedule'"), true)
  assert.equal(source.includes('void query(DEFAULT_TAG)'), false)
  assert.equal(source.includes('请输入 template_tag 后查询'), true)
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
  assert.equal(source.includes('version.workflow'), true)
})

test('workflow panel exposes details, search, zoom, and parse errors', () => {
  assert.equal(source.includes('selectedVersion?.parse_error'), true)
  assert.equal(source.includes('servicecode'), true)
  assert.equal(source.includes('searchText'), true)
  assert.equal(source.includes('setZoom'), true)
  assert.equal(typesSource.includes('export interface WorkflowTemplateVersion'), true)
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
