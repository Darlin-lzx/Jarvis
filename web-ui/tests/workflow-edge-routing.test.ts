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

function points(path: string) {
  return [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
}

test('fan-out edges share one source trunk', () => {
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
  const leftPoints = points(left!)
  const rightPoints = points(right!)
  assert.deepEqual(leftPoints.slice(0, 2), rightPoints.slice(0, 2))
  assert.equal(leftPoints[1].y, rightPoints[1].y)
})

test('fan-in edges share one target trunk', () => {
  const target = node('target', 100, 500)
  const routes = buildWorkflowEdgeRoutes({
    nodes: [
      node('left', 0, 100),
      node('right', 260, 100),
      target,
    ],
    edges: [
      { id: 'left-edge', source: 'left', target: 'target' },
      { id: 'right-edge', source: 'right', target: 'target' },
    ],
  })
  const left = points(routes.get('left-edge')!)
  const right = points(routes.get('right-edge')!)
  assert.deepEqual(left.slice(2), right.slice(2))
  assert.equal(left[2].y, right[2].y)
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
  assert.equal(sy, 128)
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

test('offset vertical edges route around blocking nodes', () => {
  const routes = buildWorkflowEdgeRoutes({
    nodes: [
      node('source', 0, 100),
      node('blocker', 20, 160, 100, 340),
      node('target', 300, 500),
    ],
    edges: [{ id: 'edge', source: 'source', target: 'target' }],
  })
  const path = routes.get('edge')!
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]))
  const xs = numbers.filter((_, index) => index % 2 === 0)
  assert.ok(xs[xs.length - 2] > 130, path)
  assert.notEqual(xs[xs.length - 2], xs[xs.length - 1])
})
