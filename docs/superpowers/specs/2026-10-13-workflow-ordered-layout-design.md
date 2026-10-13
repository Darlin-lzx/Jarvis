# Workflow Ordered Layout Design

## Context

The simplified workflow has 13 nodes and 29 edges. Its original coordinates retain the removed decision and shell nodes' historical positions, leaving uneven gaps and a visually unbalanced graph.

## Goal

Generate a new template version with coordinates that follow execution order, use consistent spacing, and preserve all node IDs, service configuration, `gotoitem` references, and edge relationships.

## Design

Use a central vertical spine for `开始节点`, `Fork`, `AND`, `流程完成处理`, and `结束节点`. The first independent service sits on the left branch. The dependent service chain sits on the right and is ordered top to bottom by its execution sequence. The second-stage service chain also stays on the right in dependency order.

All adjacent stage centers are 260 pixels apart. The central spine uses x-center 520; the independent branch uses x-center 180; sequential service lanes use x-center 860. Only `<uiinfo>` coordinates change.

## Output

Create a separate SQL file with a new template version ID and description. This allows comparison with the existing simplified version without overwriting it.

## Validation

- Parse the generated SQL and confirm 13 nodes, 29 edges, zero warnings, and no decision or shell nodes.
- Verify intended adjacent node center distances are all 260 pixels.
- Confirm all task and goto references still resolve.
- Render the parsed graph through the existing frontend routing logic and inspect the layout in a browser mock.
