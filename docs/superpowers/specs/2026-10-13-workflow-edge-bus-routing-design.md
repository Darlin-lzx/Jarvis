# Workflow Edge Bus Routing Design

## Context

The first routing revision gives each edge a distinct path. That prevents duplicate lines, but dense fork and convergence graphs still look noisy. The user prefers overlapping same-direction edges and fewer visible paths.

## Goal

Route groups of edges through shared orthogonal bus channels. Visual simplicity is more important than keeping every edge independently distinguishable.

## Design

### Shared Buses

Group edges by source, target, direction, and approximate geometric band. Edges from one branching node to multiple downstream nodes share an initial vertical trunk before splitting near their targets. Edges from multiple upstream nodes into one convergence node share a final trunk before entering the target.

### Port Discipline

A bus leaves a branching node from one stable port and enters a convergence node from one stable port. Individual edges only separate from the bus shortly before their target and merge into the bus shortly after their source. Same-direction segments may intentionally overlap.

### Channel Reuse

For each source or target group, calculate one channel rather than a unique channel per edge. Use source/target ordering to keep split and merge stubs deterministic. Keep the existing node-avoidance fallback for a blocked shared channel.

### Interaction

Selecting a node highlights all paths that use a bus connected to that node. Unrelated buses are dimmed. Panning and zooming remain unchanged.

## Testing

- Extend routing tests to verify same-source and same-target edges reuse identical trunk segments.
- Verify the 23-node/31-edge original template and 13-node/29-edge simplified template produce non-empty valid paths.
- Run focused workflow tests and the production build.

## Non-Goals

- No node coordinate changes.
- No backend or XML parsing changes.
- No attempt to make every edge visually unique.
