# Sidebar Jarvis Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the commander's internal ID stable while displaying it as "贾维斯" and remove the sidebar's default-conversation directory.

**Architecture:** The backend continues receiving `jarvis_commander`; only frontend display metadata changes. The sidebar stops rendering direct default-space conversations and stops maintaining state used exclusively by that directory. Existing conversation management remains available through the workbench conversations panel.

**Tech Stack:** React, TypeScript, Node test runner, Vite.

---

### Task 1: Frontend Contracts

**Files:**
- Modify: `web-ui/src/components/chat/agent-tabs.tsx`
- Modify: `web-ui/src/components/layout/sidebar.tsx`
- Modify: `web-ui/src/App.tsx`
- Test: `web-ui/tests/default-conversation-directory.test.ts`
- Test: `web-ui/tests/jarvis-workbench-console.test.ts`

- [x] Write failing tests asserting that `jarvis_commander` maps to `贾维斯`, request calls still use `jarvis_commander`, and the sidebar no longer contains `默认会话`.
- [x] Run `node --test tests/default-conversation-directory.test.ts tests/jarvis-workbench-console.test.ts` and confirm both fail for missing behavior.
- [x] Rename the built-in display entry to `贾维斯` without changing its ID.
- [x] Remove the default-conversation directory, its default-space loading, and its rename/delete state and props from the sidebar.
- [x] Run the focused tests and confirm they pass.

### Task 2: Production Verification

**Files:**
- Modify generated files under `web-ui/dist/` and `jarvis_agent/web/` by running the build and sync.

- [x] Run `npm run build`.
- [x] Sync `web-ui/dist/` to `jarvis_agent/web/`.
- [x] Confirm the served bundle contains `贾维斯`, `jarvis_commander`, and no sidebar default-directory markup.
