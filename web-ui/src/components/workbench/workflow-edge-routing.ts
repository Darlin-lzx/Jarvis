import type { WorkflowGraph } from '../../lib/types'

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

function groupEdges(edges: RoutingEdge[], key: (edge: RoutingEdge) => string) {
  const groups = new Map<string, RoutingEdge[]>()
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
      center(nodeMap.get(a.target)!).x - center(nodeMap.get(b.target)!).x)
    const source = nodeMap.get(ordered[0].source)!
    ordered.forEach((edge, index) => {
      sourcePorts.set(edge.id, portAt(source, index, ordered.length, 'x'))
    })
  }

  for (const [, group] of groupEdges(edges, edge => edge.target)) {
    const ordered = [...group].sort((a, b) =>
      center(nodeMap.get(a.source)!).x - center(nodeMap.get(b.source)!).x)
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
      center(nodeMap.get(a.target)!).y - center(nodeMap.get(b.target)!).y)
    const source = nodeMap.get(ordered[0].source)!
    ordered.forEach((edge, index) => {
      sourcePorts.set(edge.id, portAt(source, index, ordered.length, 'y'))
    })
  }

  for (const [, group] of groupEdges(edges, edge => edge.target)) {
    const ordered = [...group].sort((a, b) =>
      center(nodeMap.get(a.source)!).y - center(nodeMap.get(b.source)!).y)
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
  const distance = Math.max(320, Math.abs(end - start))
  for (let offset = CHANNEL_STEP; offset < distance; offset += CHANNEL_STEP) {
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
  const distance = Math.max(320, Math.abs(end - start))
  for (let offset = CHANNEL_STEP; offset < distance; offset += CHANNEL_STEP) {
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
      node.id !== source.id && node.id !== target.id)
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
      node.id !== source.id && node.id !== target.id)
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
