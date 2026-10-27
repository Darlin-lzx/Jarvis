# Agent Knowledge Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-agent knowledge-base authorization with a relational `agent_kbs` table.

**Architecture:** Add `AgentKB` as the authorization source of truth. `AgentService` migrates legacy `agents.bound_kbs` values on read, resolves authorized IDs, and treats `nl2sql_qa` as privileged. Graph retrieval never falls back to conversation space for an explicitly resolved agent.

**Tech Stack:** SQLAlchemy 2.0, FastAPI, SQLite/MySQL, React/Vite.

---

### Task 1: Authorization Service And Storage

**Files:**

- Modify: `jarvis_agent/db.py`
- Modify: `jarvis_agent/agents.py`
- Test: `tests/test_agents.py`

- [ ] Write a failing test asserting isolation, privileged access, migration, and API validation.
- [ ] Run `pytest tests/test_agents.py tests/test_agents_db_tools.py::test_bootstrap_preserves_edited_agent_config -q`.
- [ ] Add `AgentKB`; implement `AgentService.kb_ids`, legacy migration, and create/update synchronization.
- [ ] Re-run the focused tests.

### Task 2: Retrieval Enforcement

**Files:**

- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] Write a failing test that an unauthorized agent receives no space fallback.
- [ ] Run `pytest tests/test_graph.py -q`.
- [ ] Use the resolved authorization list and disable implicit space fallback when a valid agent has no authorization.
- [ ] Re-run graph tests.

### Task 3: Frontend And Build

**Files:**

- Modify: `web-ui/src/components/workbench/agents-panel.tsx`

- [ ] Verify the editor loads, saves, and displays `bound_kbs`.
- [ ] Run `npm run build` and sync `dist/` to `jarvis_agent/web/`.
