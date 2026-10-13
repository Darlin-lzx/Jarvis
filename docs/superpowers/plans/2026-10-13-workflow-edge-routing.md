# Workflow Edge Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce workflow edge clutter with deterministic orthogonal routing while preserving original XML node coordinates.

**Architecture:** Extract routing into a pure frontend module that maps each workflow edge ID to an SVG path. The React panel precomputes routes with `useMemo` and renders them without changing graph parsing, zoom, pan, or node positions.

**Tech Stack:** React 19, TypeScript, SVG, Node's built-in TypeScript test runner.

---

### Task 1: Pure Edge Routing Module

**Files:**

- Create: `web-ui/src/components/workbench/workflow-edge-routing.ts`
- Create: `web-ui/tests/workflow-edge-routing.test.ts`

- [ ] **Step 1: Write failing tests for directional ports and deterministic routes**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWorkflowEdgeRoutes,
} from '../src/components/workbench/workflow-edge-routing.ts'

const node = (id: string, x: number, y: number, width = 120, height = 56) => ({
  id,
  x,
  y,
  width,
  height,
})

test('vertical edges use spread ports and an orthogonal channel', () => {
  const source = node('source', 100, 100)
  const targets = [
    node('left', 0, 300),
    node('right', 260, 300),
  ]
  const routes = buildWorkflowEdgeRoutes({
    nodes: [source, ...targets],
    edges: [
      { id: 'left-edge', source: 'source', target: 'left' },
      { id: 'right-edge', source: 'source', target: 'right' },
    ],
  })

  const left = routes.get('left-edge')
  const right = routes.get('right-edge')
  assert.ok(left?.startsWith('M '))
  assert.ok(right?.startsWith('M '))
  assert.notEqual(left, right)
  assert.ok(left!.includes(' L '))
  assert.ok(right!.includes(' L '))
})

test('horizontal edges leave and enter on opposite sides', () => {
  const routes = buildWorkflowEdgeRoutes({
    nodes: [
      node('source', 0, 100),
      node('target', 260, 100),
    ],
    edges: [{ id: 'edge', source: 'source', target: 'target' }],
  })
  const path = routes.get('edge')!
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  const [sx, sy] = numbers
  assert.equal(sx, 120)
  assert.equal(sy, 160)
  assert.ok(path.includes(' L '))
})

test('node avoidance moves a vertical channel out of an obstacle', () => {
  const routes = buildWorkflowEdgeRoutes({
    nodes: [
      node('source', 100, 100),
      node('obstacle', 100, 200),
      node('target', 100, 356),
    ],
    edges: [{ id: 'edge', source: 'source', target: 'target' }],
  })
  const path = routes.get('edge')!
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  assert.ok(numbers.some(value => value < 100 || value > 220))
})
```

- [ ] **Step 2: Run tests and verify the module import fails**

Run: `cd web-ui && node --test tests/workflow-edge-routing.test.ts`

Expected: FAIL because `workflow-edge-routing.ts` does not exist.

- [ ] **Step 3: Implement the routing module**

```ts
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../../lib/types'

interface RoutingNode {
  id: string
  x: number
  y: number
  width: number
  height: number
}

interface RoutingEdge {
  id: string
  source: string
  target: string
}

interface RoutingGraph {
  nodes: RoutingNode[]
  edges: RoutingEdge[]
}

type PortMap = Map<string, number>

const PORT_MARGIN = 11
const OBSTACLE_MARGIN = 6
const CHANNEL_STEP = 16

function center(node: RoutingNode) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  }
}

function portAt(node: RoutingNode, index: number, count: number, axis: 'x' | 'y') {
  const size = axis === 'x' ? node.width : node.height
  const margin = Math.min(PORT_MARGIN, size / 4)
  const ratio = count === 1 ? 0.5 : (index + 1) / (count + 1)
  const offset = margin + (size - margin * 2) * ratio
  return (axis === 'x' ? node.x : node.y) + offset
}

function groupEdges<T extends RoutingEdge>(
  edges: T[],
  key: (edge: T) => string,
) {
  const groups = new Map<string, T[]>()
  for (const edge of edges) {
    const group = groups.get(key(edge)) ?? []
    group.push(edge)
    groups.set(key(edge), group)
  }
  return groups
}

function buildVerticalPorts(edges: RoutingEdge[], nodes: RoutingNode[]) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const sourcePorts: PortMap = new Map()
  const targetPorts: PortMap = new Map()

  for (const [, group] of groupEdges(edges, edge => edge.source)) {
    const ordered = [...group].sort((a, b) =>
      center(nodeMap.get(a.target)!).x - center(nodeMap.get(b.target)!).x,
    )
    const source = nodeMap.get(ordered[0].source)!
    ordered.forEach((edge, index) => {
      sourcePorts.set(edge.id, portAt(source, index, ordered.length, 'x'))
    })
  }

  for (const [, group] of groupEdges(edges, edge => edge.target)) {
    const ordered = [...group].sort((a, b) =>
      center(nodeMap.get(a.source)!).x - center(nodeMap.get(b.source)!).x,
    )
    const target = nodeMap.get(ordered[0].target)!
    ordered.forEach((edge, index) => {
      targetPorts.set(edge.id, portAt(target, index, ordered.length, 'x'))
    })
  }

  return { sourcePorts, targetPorts }
}

function buildHorizontalPorts(edges: RoutingEdge[], nodes: RoutingNode[]) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const sourcePorts: PortMap = new Map()
  const targetPorts: PortMap = new Map()

  for (const [, group] of groupEdges(edges, edge => edge.source)) {
    const ordered = [...group].sort((a, b) =>
      center(nodeMap.get(a.target)!).y - center(nodeMap.get(b.target)!).y,
    )
    const source = nodeMap.get(ordered[0].source)!
    ordered.forEach((edge, index) => {
      sourcePorts.set(edge.id, portAt(source, index, ordered.length, 'y'))
    })
  }

  for (const [, group] of groupEdges(edges, edge => edge.target)) {
    const ordered = [...group].sort((a, b) =>
      center(nodeMap.get(a.source)!).y - center(nodeMap.get(b.source)!).y,
    )
    const target = nodeMap.get(ordered[0].target)!
    ordered.forEach((edge, index) => {
      targetPorts.set(edge.id, portAt(target, index, ordered.length, 'y'))
    })
  }

  return { sourcePorts, targetPorts }
}

function rectsIntersect(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  node: RoutingNode,
) {
  const bx1 = node.x - OBSTACLE_MARGIN
  const by1 = node.y - OBSTACLE_MARGIN
  const bx2 = node.x + node.width + OBSTACLE_MARGIN
  const by2 = node.y + node.height + OBSTACLE_MARGIN
  return ax1 <= bx2 && ax2 >= bx1 && ay1 <= by2 && ay2 >= by1
}

function horizontalSegmentClear(
  x1: number,
  x2: number,
  y: number,
  obstacles: RoutingNode[],
) {
  return !obstacles.some(node => rectsIntersect(x1, y, x2, y, node))
}

function verticalSegmentClear(
  y1: number,
  y2: number,
  x: number,
  obstacles: RoutingNode[],
) {
  return !obstacles.some(node => rectsIntersect(x, y1, x, y2, node))
}

function findVerticalChannel(
  source: RoutingNode,
  target: RoutingNode,
  downward: boolean,
  obstacles: RoutingNode[],
) {
  const start = downward ? source.y + source.height : target.y + target.height
  const end = downward ? target.y : source.y
  const middle = (start + end) / 2
  const candidates = [middle]
  for (let offset = CHANNEL_STEP; offset < Math.max(320, end - start); offset += CHANNEL_STEP) {
    candidates.push(middle - offset, middle + offset)
  }
  return candidates.find(y =>
    y > start + OBSTACLE_MARGIN &&
    y < end - OBSTACLE_MARGIN &&
    horizontalSegmentClear(source.x, source.x + source.width, y, obstacles),
  ) ?? middle
}

function findHorizontalChannel(
  source: RoutingNode,
  target: RoutingNode,
  sourceIsLeft: boolean,
  obstacles: RoutingNode[],
) {
  const start = sourceIsLeft ? source.x + source.width : target.x + target.width
  const end = sourceIsLeft ? target.x : source.x
  const middle = (start + end) / 2
  const candidates = [middle]
  for (let offset = CHANNEL_STEP; offset < Math.max(320, end - start); offset += CHANNEL_STEP) {
    candidates.push(middle - offset, middle + offset)
  }
  return candidates.find(x =>
    x > start + OBSTACLE_MARGIN &&
    x < end - OBSTACLE_MARGIN &&
    verticalSegmentClear(source.y, source.y + source.height, x, obstacles),
  ) ?? middle
}

function formatPath(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ')
}

export function buildWorkflowEdgeRoutes(graph: RoutingGraph) {
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]))
  const routes = new Map<string, string>()
  const verticalEdges: RoutingEdge[] = []
  const horizontalEdges: RoutingEdge[] = []

  for (const edge of graph.edges) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) continue

    const targetBelow = target.y >= source.y + source.height - 1
    const targetAbove = target.y + target.height <= source.y + 1
    if (targetBelow || targetAbove) verticalEdges.push(edge)
    else horizontalEdges.push(edge)
  }

  const verticalPorts = buildVerticalPorts(verticalEdges, graph.nodes)
  const horizontalPorts = buildHorizontalPorts(horizontalEdges, graph.nodes)

  for (const edge of verticalEdges) {
    const source = nodeMap.get(edge.source)!
    const target = nodeMap.get(edge.target)!
    const downward = target.y >= source.y + source.height - 1
    const sx = verticalPorts.sourcePorts.get(edge.id) ?? center(source).x
    const tx = verticalPorts.targetPorts.get(edge.id) ?? center(target).x
    const sy = downward ? source.y + source.height : source.y
    const ty = downward ? target.y : target.y + target.height
    const obstacles = graph.nodes.filter(node =>
      node.id !== source.id && node.id !== target.id,
    )
    const channel = findVerticalChannel(source, target, downward, obstacles)
    routes.set(edge.id, formatPath([
      { x: sx, y: sy },
      { x: sx, y: channel },
      { x: tx, y: channel },
      { x: tx, y: ty },
    ]))
  }

  for (const edge of horizontalEdges) {
    const source = nodeMap.get(edge.source)!
    const target = nodeMap.get(edge.target)!
    const sourceIsLeft = center(source).x <= center(target).x
    const sy = horizontalPorts.sourcePorts.get(edge.id) ?? center(source).y
    const ty = horizontalPorts.targetPorts.get(edge.id) ?? center(target).y
    const sx = sourceIsLeft ? source.x + source.width : source.x
    const tx = sourceIsLeft ? target.x : target.x + target.width
    const obstacles = graph.nodes.filter(node =>
      node.id !== source.id && node.id !== target.id,
    )
    const channel = findHorizontalChannel(source, target, sourceIsLeft, obstacles)
    routes.set(edge.id, formatPath([
      { x: sx, y: sy },
      { x: channel, y: sy },
      { x: channel, y: ty },
      { x: tx, y: ty },
    ]))
  }

  return routes
}

export function buildWorkflowRoutesForGraph(graph: WorkflowGraph) {
  return buildWorkflowEdgeRoutes(graph as unknown as RoutingGraph)
}
```

- [ ] **Step 4: Run routing tests and verify they pass**

Run: `cd web-ui && node --test tests/workflow-edge-routing.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add web-ui/src/components/workbench/workflow-edge-routing.ts web-ui/tests/workflow-edge-routing.test.ts
git commit -m "feat: add workflow edge routing"
```

### Task 2: Integrate Routing Into the Workflow Canvas

**Files:**

- Modify: `web-ui/src/components/workbench/workflow-panel.tsx`
- Modify: `web-ui/tests/workflow-panel.test.ts`

- [ ] **Step 1: Update panel tests for routed rendering**

Add assertions that the panel imports and memoizes the routing module and no longer calls `orthogonalEdgePath`:

```ts
assert.equal(source.includes("from './workflow-edge-routing'"), true)
assert.equal(source.includes('const edgeRoutes = useMemo'), true)
assert.equal(source.includes('orthogonalEdgePath'), false)
assert.equal(source.includes("strokeWidth={isActive ? 2.4 : 1.25}"), true)
assert.equal(source.includes("opacity={isDimmed ? 0.18 : 0.92}"), true)
```

- [ ] **Step 2: Run panel tests and verify they fail before integration**

Run: `cd web-ui && node --test tests/workflow-panel.test.ts`

Expected: FAIL on the new routing assertions.

- [ ] **Step 3: Integrate the pure routes**

In `workflow-panel.tsx`:

```tsx
import { buildWorkflowRoutesForGraph } from './workflow-edge-routing'
```

Remove the local `orthogonalEdgePath` function and add near `graphBounds`:

```tsx
const edgeRoutes = useMemo(
  () => graph ? buildWorkflowRoutesForGraph(graph) : new Map<string, string>(),
  [graph],
)
```

Replace the per-edge path calculation:

```tsx
const path = edgeRoutes.get(edge.id)
```

Update normal edge styling:

```tsx
strokeWidth={isActive ? 2.4 : 1.25}
opacity={isDimmed ? 0.18 : 0.92}
```

- [ ] **Step 4: Run all focused frontend tests**

Run: `cd web-ui && node --test tests/workflow-edge-routing.test.ts tests/workflow-panel.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add web-ui/src/components/workbench/workflow-panel.tsx web-ui/tests/workflow-panel.test.ts
git commit -m "feat: render routed workflow edges"
```

### Task 3: Real Template Validation and Build

**Files:**

- No production files changed unless validation exposes a defect.

- [ ] **Step 1: Validate the original attachment graph**

Parse `/Users/l1nzx/.codex/attachments/16b6055c-df69-40f9-a003-bea19ca86355/pasted-text.txt` with `jarvis_agent.workflow_template.parse_workflow_xml`, then call the backend parser's graph geometry through a temporary Node test fixture. Expected: every one of the 31 edge IDs receives a non-empty SVG path.

- [ ] **Step 2: Validate the no-decision/no-shell SQL**

Parse `file/vm_template_version_no_decision_no_shell.sql`, combine its content columns, and run `parse_workflow_xml`. Expected: all 29 edge IDs receive non-empty SVG paths.

- [ ] **Step 3: Run production build**

Run: `cd web-ui && npm run build`

Expected: TypeScript compilation and Vite build PASS.

- [ ] **Step 4: Verify browser behavior**

Open `http://127.0.0.1:8000/#/workspace/workflows`, mock or query an available template, and verify:

- Edges no longer collapse into one midpoint channel.
- Fork and AND convergence lanes are visibly separated.
- Selected-node highlighting still works.
- Wheel/trackpad pan and Ctrl/Command-wheel zoom still work.

- [ ] **Step 5: Commit any validation fix**

If validation requires a code fix:

```bash
git add web-ui/src/components/workbench/workflow-edge-routing.ts web-ui/tests/workflow-edge-routing.test.ts
git commit -m "fix: refine workflow edge routing"
```
