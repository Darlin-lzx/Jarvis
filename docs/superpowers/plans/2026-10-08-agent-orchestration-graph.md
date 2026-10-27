# Agent Orchestration Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-node shell graph with six visible migration agent nodes while preserving `build_graph(...)`, artifact behavior, state-machine authority, and non-migration chat.

**Architecture:** `migration_commander` becomes the entry/convergence node. A conditional edge maps `current_step` to one of five stage agents; each stage agent reuses the existing sub-agent executor and artifact gate. Stage conditional edges expose `next`, `stay`, `wait_user`, and `back`, but database status transitions remain owned by `MigrateStateService`.

**Tech Stack:** Python, LangGraph `StateGraph`, pytest, existing Agent/Artifact/State services.

---

### Task 1: Graph Contract Tests

**Files:**
- Modify: `tests/test_graph.py`

- [x] Add tests asserting compiled graph nodes contain exactly the six migration agent IDs plus LangGraph endpoints.
- [x] Add tests for every standard stage mapping and explicit assignment rejection.
- [x] Add tests for `should_advance`: missing required fields, pending confirmation, confirmed flow, disabled confirmation, and verification failure.
- [x] Run `.venv/bin/pytest tests/test_graph.py -q` and confirm the new tests fail because the old shell graph and helpers do not exist.

### Task 2: Runtime Routing Helpers

**Files:**
- Modify: `jarvis_agent/graph.py`

- [x] Define stage/agent mappings, normalize legacy stages, and resolve the configured flow through `migrate_state.get_flow()` with `DEFAULT_FLOW` fallback.
- [x] Implement `route_agent(state)` and `should_advance(state)` as public runtime methods.
- [x] Extend in-flight `task_state` with `step_status`, `awaiting_confirmation`, `task_confirm`, and `rollback_target` without changing the database schema.

### Task 3: Six Agent Nodes

**Files:**
- Modify: `jarvis_agent/graph.py`
- Modify: `jarvis_agent/app.py`

- [x] Implement `GraphRuntime.commander` as parse/entry and convergence; generic non-migration agents still execute through the existing executor inside this node.
- [x] Add wrappers for collector, assessor, planner, code migrator, and verifier. Each wrapper reuses `_call_sub_agent`, preserving Chinese core artifacts and `sub_agent` stream events.
- [x] Build the new graph with conditional edges. Map `wait_user`, `stay`, and `back` to commander convergence; map `next` to the next configured stage or commander for `FINISHED`.
- [x] Update SSE update handling for new node names while retaining parse/route/artifact/error events.

### Task 4: Regression

**Files:**
- Modify: existing tests only where they assert the removed shell orchestration behavior.

- [x] Run focused graph tests, then `.venv/bin/pytest tests -q`.
- [x] Run frontend tests/build if backend API types or board labels change.
- [x] Re-run the full backend suite and record unrelated pre-existing failures separately.

## Implementation note

The compiled graph exposes exactly the six migration agent nodes. Non-migration
and directly assigned generic agents execute through the existing executor inside
`migration_commander`; a `route_preflight` custom event tells SSE whether to buffer
artifact-agent text before streaming starts.
