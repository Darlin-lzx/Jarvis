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

function isDownward(source: RoutingNode, target: RoutingNode) {
  return target.y >= source.y + source.height - 1
}

function buildVerticalBusChannels(
  edges: RoutingEdge[],
  nodes: RoutingNode[],
  busSide: 'source' | 'target',
) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const channels = new Map<string, number>()

  for (const [, group] of groupEdges(edges, edge =>
    busSide === 'source' ? edge.source : edge.target)) {
    if (group.length < 2) continue

    const firstSource = nodeMap.get(group[0].source)!
    const firstTarget = nodeMap.get(group[0].target)!
    const downward = isDownward(firstSource, firstTarget)
    const busNode = nodeMap.get(busSide === 'source' ? group[0].source : group[0].target)!
    const otherNodes = group
      .map(edge => nodeMap.get(busSide === 'source' ? edge.target : edge.source)!)
      .filter(node => Boolean(node))

    const start = downward
      ? busSide === 'source'
        ? busNode.y + busNode.height
        : Math.max(...otherNodes.map(node => node.y + node.height))
      : busSide === 'source'
        ? busNode.y
        : busNode.y + busNode.height
    const end = downward
      ? busSide === 'source'
        ? Math.min(...otherNodes.map(node => node.y))
        : busNode.y
      : busSide === 'source'
        ? Math.max(...otherNodes.map(node => node.y + node.height))
        : Math.min(...otherNodes.map(node => node.y))

    const representativeX = otherNodes.reduce((sum, node) => sum + center(node).x, 0)
      / otherNodes.length
    const channel = findVerticalChannel(
      center(busNode).x,
      representativeX,
      start,
      end,
      nodes.filter(node => node.id !== busNode.id),
    )
    for (const edge of group) channels.set(edge.id, channel)
  }

  return channels
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
  sx: number,
  tx: number,
  start: number,
  end: number,
  obstacles: RoutingNode[],
) {
  const middle = (start + end) / 2
  const candidates = [middle]
  const distance = Math.max(320, Math.abs(end - start))
  for (let offset = CHANNEL_STEP; offset < distance; offset += CHANNEL_STEP) {
    candidates.push(middle - offset, middle + offset)
  }
  return candidates.find(y =>
    y > start + OBSTACLE_MARGIN &&
    y < end - OBSTACLE_MARGIN &&
    horizontalSegmentClear(Math.min(sx, tx), Math.max(sx, tx), y, obstacles),
  ) ?? middle
}

function findVerticalBypass(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  obstacles: RoutingNode[],
) {
  const preferredX = (sx + tx) / 2
  const candidates: number[] = []
  for (const node of obstacles) {
    candidates.push(
      node.x - OBSTACLE_MARGIN - CHANNEL_STEP,
      node.x + node.width + OBSTACLE_MARGIN + CHANNEL_STEP,
    )
  }
  return candidates
    .filter(x => x !== sx && x !== tx)
    .filter(x => verticalSegmentClear(sy, ty, x, obstacles))
    .filter(x => horizontalSegmentClear(
      Math.min(x, tx),
      Math.max(x, tx),
      ty,
      obstacles,
    ))
    .sort((a, b) => Math.abs(a - preferredX) - Math.abs(b - preferredX))[0]
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
  const compacted = points.reduce<Array<{ x: number; y: number }>>((result, point) => {
    const previous = result.at(-1)
    if (previous &&
      previous.x === point.x &&
      previous.y === point.y) return result
    if (previous) {
      const before = result.at(-2)
      if (before &&
        ((before.x === previous.x && previous.x === point.x) ||
          (before.y === previous.y && previous.y === point.y))) {
        result[result.length - 1] = point
        return result
      }
    }
    result.push(point)
    return result
  }, [])
  return compacted
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

    const targetBelow = isDownward(source, target)
    const targetAbove = target.y + target.height <= source.y + 1
    if (targetBelow || targetAbove) verticalEdges.push(edge)
    else horizontalEdges.push(edge)
  }

  const horizontalPorts = buildHorizontalPorts(horizontalEdges, graph.nodes)
  const sourceBusChannels = buildVerticalBusChannels(
    verticalEdges,
    graph.nodes,
    'source',
  )
  const targetBusChannels = buildVerticalBusChannels(
    verticalEdges,
    graph.nodes,
    'target',
  )
  const sourceGroupSize = new Map<string, number>()
  const targetGroupSize = new Map<string, number>()
  for (const edge of verticalEdges) {
    sourceGroupSize.set(edge.source, (sourceGroupSize.get(edge.source) ?? 0) + 1)
    targetGroupSize.set(edge.target, (targetGroupSize.get(edge.target) ?? 0) + 1)
  }

  for (const edge of verticalEdges) {
    const source = nodeMap.get(edge.source)!
    const target = nodeMap.get(edge.target)!
    const downward = isDownward(source, target)
    const sx = center(source).x
    const tx = center(target).x
    const sy = downward ? source.y + source.height : source.y
    const ty = downward ? target.y : target.y + target.height
    const obstacles = graph.nodes.filter(node =>
      node.id !== source.id && node.id !== target.id)

    // 上下对齐的边永远走直线：总线/绕行只会制造多余拐弯
    // （X 不对齐的边走中点 Z 形：与主轴衔接最自然；想完全对齐请拖拽节点或调坐标）
    if (Math.abs(sx - tx) < 0.5) {
      routes.set(edge.id, formatPath([
        { x: sx, y: sy },
        { x: sx, y: ty },
      ]))
      continue
    }

    // 两端都是单出/单入的"简单边"不走总线：一对一直连时中点 Z 形最干净，
    // 总线的 Y 由同组其他边决定，会把简单边拽出无意义的拐弯
    const isSimpleEdge = (sourceGroupSize.get(edge.source) ?? 0) === 1
      && (targetGroupSize.get(edge.target) ?? 0) === 1
    const sourceBus = !isSimpleEdge && (sourceGroupSize.get(edge.source)! > 1)
      ? sourceBusChannels.get(edge.id)
      : undefined
    const targetBus = !isSimpleEdge && (targetGroupSize.get(edge.target)! > 1)
      ? targetBusChannels.get(edge.id)
      : undefined
    const sourceChannel = sourceBus
      ?? targetBus
      ?? findVerticalChannel(sx, tx, sy, ty, obstacles)
    const sourceHorizontalIsClear = horizontalSegmentClear(
      Math.min(sx, tx),
      Math.max(sx, tx),
      sourceChannel,
      obstacles,
    )
    const targetHorizontalIsClear = targetBus
      ? horizontalSegmentClear(
        Math.min(sx, tx),
        Math.max(sx, tx),
        targetBus,
        obstacles,
      )
      : false

    if (targetBus && targetHorizontalIsClear &&
      targetGroupSize.get(edge.target)! > (sourceGroupSize.get(edge.source) ?? 1)) {
      routes.set(edge.id, formatPath([
        { x: sx, y: sy },
        { x: sx, y: targetBus },
        { x: tx, y: targetBus },
        { x: tx, y: ty },
      ]))
    } else if (sourceBus && targetBus && sourceHorizontalIsClear &&
      verticalSegmentClear(sourceChannel, targetBus, tx, obstacles)) {
      routes.set(edge.id, formatPath([
        { x: sx, y: sy },
        { x: sx, y: sourceChannel },
        { x: tx, y: sourceChannel },
        { x: tx, y: targetBus },
        { x: tx, y: ty },
      ]))
    } else if (sourceHorizontalIsClear) {
      routes.set(edge.id, formatPath([
        { x: sx, y: sy },
        { x: sx, y: sourceChannel },
        { x: tx, y: sourceChannel },
        { x: tx, y: ty },
      ]))
    } else {
      const bypass = findVerticalBypass(sx, sy, tx, ty, obstacles) ?? tx
      routes.set(edge.id, formatPath([
        { x: sx, y: sy },
        { x: bypass, y: sy },
        { x: bypass, y: ty },
        { x: tx, y: ty },
      ]))
    }
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
