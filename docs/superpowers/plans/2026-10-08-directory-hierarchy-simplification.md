# Directory Hierarchy Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the workspace hierarchy from `space > subsystem > task > conversation` to `space > task > conversation`.

**Architecture:** The frontend becomes the hierarchy boundary: it loads spaces and tasks, groups tasks directly under spaces, and no longer renders or submits subsystem ownership. Backend task listing ignores `sub_system_id`, task creation stores `NULL`, and conversation attachment uses only `space_id` / `task_id`. Existing subsystem tables and CRUD APIs remain untouched for compatibility.

**Tech Stack:** React 19 + TypeScript + Vite frontend, FastAPI + SQLAlchemy backend, Node test runner and pytest.

---

### Task 1: Regression Tests For The New Hierarchy

**Files:**
- Create: `web-ui/tests/directory-hierarchy.test.ts`
- Modify: `tests/test_project.py`
- Modify: `tests/test_api.py`

- [x] Add frontend source assertions proving that sidebar, task list, new task dialog, and project-conversion UI contain no active subsystem path.
- [x] Add `ProjectService` test proving a task can be created without a subsystem and that legacy subsystem filtering is ignored.
- [x] Add API tests proving `GET /api/tasks?sub_system_id=` ignores the filter and `POST /api/tasks` stores `NULL` even when the legacy field is supplied.
- [x] Run the new tests and confirm they fail before implementation.

### Task 2: Frontend Three-Level Navigation

**Files:**
- Modify: `web-ui/src/components/layout/sidebar.tsx`
- Modify: `web-ui/src/App.tsx`
- Modify: `web-ui/src/components/project/task-list-page.tsx`
- Modify: `web-ui/src/components/project/new-task-dialog.tsx`
- Modify: `web-ui/src/components/project/task-detail-page.tsx`
- Modify: `web-ui/src/components/chat/convert-to-project-dialog.tsx`
- Modify: `web-ui/src/components/chat/welcome-page.tsx`

- [x] In sidebar, load spaces and tasks together, map tasks to space children, remove subsystem child CRUD/rendering, and expose task selection.
- [x] In App, remove subsystem navigation state and pass a task-selected callback to sidebar.
- [x] In task list, keep space/status filters only and remove subsystem breadcrumb, dropdown, badges, and empty-state copy.
- [x] In new task dialog, require only space and name; do not submit `sub_system_id`.
- [x] In task detail, remove subsystem breadcrumb and ownership display; copied-task context no longer carries `subId`.
- [x] In project conversion, select only a space and call `attachSpace` with `space_id`.
- [x] Run frontend tests.

### Task 3: Backend Ownership Simplification

**Files:**
- Modify: `db_loc_agent/project.py`
- Modify: `db_loc_agent/app.py`

- [x] Keep `list_tasks` signature compatible but ignore `sub_system_id`.
- [x] Remove subsystem validation from `create_task`; new tasks always store `NULL`.
- [x] Ignore `sub_system_id` when attaching a conversation to a newly created task.
- [x] Keep subsystem service methods and all subsystem HTTP endpoints unchanged.
- [x] Run focused backend tests.

### Task 4: Verification

**Files:**
- No production files.

- [x] Run `cd web-ui && npm test`.
- [x] Run `.venv/bin/pytest tests/test_project.py tests/test_api.py -q`.
- [x] Inspect `git diff --stat` and ensure only hierarchy-related files changed by this task.
- [x] Record any unrelated pre-existing failures without changing them.
