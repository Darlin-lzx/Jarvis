# Workflow Ordered Layout Design

## Context

The simplified workflow has 13 nodes and 28 edges after removing the direct Fork-to-AND edge. Its original coordinates retain the removed decision and shell nodes' historical positions, leaving uneven gaps and a visually unbalanced graph.

## Goal

Generate a new template version with coordinates that follow execution order, use consistent spacing, and preserve all node IDs, service configuration, and edge relationships except for the visually misleading direct Fork-to-AND edge.

## Design

Use a central vertical spine for `开始节点`, `Fork`, `AND`, the four second-stage services, `流程完成处理`, and `结束节点`. The first independent service sits on the left branch. The first dependent service chain sits on the right and is ordered top to bottom by its execution sequence.

All adjacent stage centers are 260 pixels apart. The central spine uses x-center 520; the independent branch uses x-center 180; the first sequential service lane uses x-center 860. Only `<uiinfo>` coordinates change.

## Output

Create a separate SQL file with a new template version ID and description. This allows comparison with the existing simplified version without overwriting it.

## Validation

- Parse the generated SQL and confirm 13 nodes, 28 edges, zero warnings, and no decision or shell nodes.
- Verify intended adjacent node center distances are all 260 pixels.
- Confirm all task and goto references still resolve.
- Render the parsed graph through the existing frontend routing logic and inspect the layout in a browser mock.
