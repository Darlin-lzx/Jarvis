# Workflow Edge Routing Design

## Context

The workflow graph keeps original XML node coordinates, but the current orthogonal edges all route through simple midpoints. When several edges share a vertical gap, especially around fork and AND nodes, they overlap or cross and make the graph difficult to read.

## Goal

Redesign edge rendering while preserving every node's original XML `x`, `y`, width, and height. Backend parsing, template data, and node coordinate semantics do not change.

## Design

### Directional Ports

Edges choose ports from their geometric relationship:

- Downward edge: source bottom port to target top port.
- Upward edge: source top port to target bottom port.
- Horizontal edge: source side port to target opposite-side port.

### Channel Allocation

Instead of sharing one midpoint, parallel edges receive separate orthogonal routing channels. Edges entering the same node are ordered by source position and spread across stable target-side lanes. Edges leaving a branching node are ordered by target position and assigned distinct source-side lanes. Channel calculations are deterministic and based only on graph geometry.

### Node Avoidance

The preferred channel lies in the clear gap between source and target. If that path crosses a node bounding box, the edge routes through the nearest available side channel. Paths remain orthogonal and preserve a consistent engineering-diagram style.

### Visual Hierarchy

Unselected edges use thinner strokes and lower opacity. Selecting a node highlights its incident edges and dims unrelated edges. Arrows follow the final segment direction. Optional subtle color separation distinguishes normal flow from converging flow without introducing a high-saturation palette.

## Testing

- Add pure-function tests for directional port selection, path generation, channel allocation, and node-avoidance fallback.
- Validate routing with the original 23-node/31-edge template and the generated no-decision/no-shell 13-node/29-edge template.
- Keep existing workflow panel tests passing and verify the production build.

## Non-Goals

- No automatic node relayout.
- No changes to XML coordinates or backend workflow parsing.
- No interaction changes to zooming or panning.
