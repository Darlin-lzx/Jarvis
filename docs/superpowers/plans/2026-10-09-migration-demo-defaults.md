# Migration Demo Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh migration collection default to the enabled Excel source and local MySQL target, and keep stage completion visible when a migration task references a business task id.

**Architecture:** Keep `db_migrate_task` authoritative. In the chat migration state preparation path, fill only missing source and target fields from deterministic data-source defaults before calling `update_params()`. Extend task-detail execution-state resolution to fall back from `DbMigrateTask.conv_id` to the latest conversation under that business task. Confirmation gates remain unchanged.

**Tech Stack:** FastAPI, SQLAlchemy, pytest, existing Excel `DbTools`.

---

### Task 1: Excel and MySQL Defaults

**Files:**
- Modify: `tests/test_api.py`
- Modify: `jarvis_agent/app.py`

- [x] Add an integration test that uploads a three-sheet Excel workbook, starts a migration collection without explicit source or target, and expects `source_db_type=excel`, `target_db_type=mysql`, and `object_count=3`.
- [x] Run the test and verify it fails because source and target remain empty.
- [x] Add a narrowly scoped default helper to the migration chat path: choose the first enabled Excel data source only when source is absent, and set target to `mysql` only when target is absent.
- [x] Re-run the focused test and verify it passes.

### Task 2: Business-Task Stage State Fallback

**Files:**
- Modify: `tests/test_api.py`
- Modify: `jarvis_agent/app.py`

- [x] Add a regression test where `DbMigrateTask.conv_id` stores a project-task id while the linked conversation stores `step_status=done`; `/api/tasks/{project_task_id}/migrate-task` must return the done state.
- [x] Run the test and verify it fails because the response omits execution state.
- [x] Extend `_with_migrate_execution_state()` so it reads the direct conversation first, then falls back to conversations whose `task_id` equals `data["conv_id"]`, preferring one whose `task_state.migrate_task_id` matches the migration task.
- [x] Re-run the focused test and verify it passes.

### Task 3: Verification and Demo Data

**Files:**
- No production files added.
- Runtime data: current local SQLite migration task.

- [x] Run focused API tests, then the complete backend test suite.
- [x] Backfill the current demo task to use `src_oracle_excel`, `source_db_type=excel`, and `target_db_type=mysql`, preserving the generated report and user confirmation gate.
- [x] Verify the task detail response shows the intended defaults and current execution state.
