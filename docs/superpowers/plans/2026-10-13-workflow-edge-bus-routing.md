# Workflow Edge Bus Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route same-direction workflow edges through shared orthogonal trunks so dense graphs show fewer lines.

**Architecture:** Replace per-edge spread ports and channels with deterministic group channels. Vertical edge groups favor a shared target channel when multiple edges converge, and a shared source channel when one node fans out. Horizontal routing keeps the existing single-path behavior until a fixture demonstrates shared-layer noise.

**Tech Stack:** React 19, TypeScript, SVG, Node's built-in TypeScript test runner.

---

### Task 1: Shared Vertical Trunks

**Files:**

- Modify: `web-ui/tests/workflow-edge-routing.test.ts`
- Modify: `web-ui/src/components/workbench/workflow-edge-routing.ts`

- [ ] **Step 1: Add failing tests**

Add tests which require all fan-out edges from one source to share the same first two path segments, and all fan-in edges to one target to share the same final two path segments.

- [ ] **Step 2: Verify RED**

Run: `cd web-ui && node --test tests/workflow-edge-routing.test.ts`

Expected: the two new tests fail against the current spread-port implementation.

- [ ] **Step 3: Implement group channels**

Build incoming and outgoing edge groups. Give each group one channel. For each vertical edge, use the incoming-group channel when that group has more than one edge; otherwise use its outgoing-group channel. Use source/target center ports so overlapping edges align exactly.

- [ ] **Step 4: Verify GREEN**

Run: `cd web-ui && node --test tests/workflow-edge-routing.test.ts`

Expected: all routing tests pass.

### Task 2: Real Graphs and Production Build

**Files:**

- Modify only if validation exposes a defect: `web-ui/src/components/workbench/workflow-edge-routing.ts`

- [ ] **Step 1: Validate both real graphs**

Parse the original attachment and generated no-decision/no-shell SQL, then require every edge ID to receive a valid `M ... L ...` path.

- [ ] **Step 2: Measure trunk reuse**

For the simplified 13-node/29-edge graph, report the number of unique vertical trunk segments. It must be lower than the edge count.

- [ ] **Step 3: Run focused tests and build**

Run: `cd web-ui && node --test tests/workflow-edge-routing.test.ts tests/workflow-panel.test.ts && npm run build`

Expected: all focused tests and the production build pass.

### Task 3: Browser Check

- [ ] **Step 1: Mock the simplified graph in Playwright**

Confirm all 29 paths render, zoom and scroll still work, and selected-node highlighting still changes path styling.
