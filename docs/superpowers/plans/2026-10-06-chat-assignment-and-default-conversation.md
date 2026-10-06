# Chat Assignment And Default Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable explicit agent assignment, Chinese artifact filenames, and default-space conversation creation with one consistent chat page.

**Architecture:** Artifact naming is normalized in the graph before writes. Default-space ownership is guaranteed by `ProjectService` and exposed through a FastAPI endpoint. The React app uses the same `ChatView` for globally created and space-opened conversations.

**Tech Stack:** Python/FastAPI/LangGraph, React/TypeScript, Node test runner.

---

### Task 1: Chinese Artifact Filenames

- [ ] Add failing graph tests asserting `评估报告.md` and `转换脚本_对象.sql`.
- [ ] Centralize new-file template normalization in `graph.py`.
- [ ] Run graph artifact tests.

### Task 2: Default Space Conversation

- [ ] Add a failing service test for idempotent `ensure_default_space()`.
- [ ] Add a failing API test for `/api/spaces/default`.
- [ ] Implement service and API behavior.
- [ ] Change the sidebar action to `新建会话`; create in default space and open `ChatView`.

### Task 3: Assignable Agent Tabs

- [ ] Add a failing frontend test for assignment callback behavior.
- [ ] Make agent tabs buttons with disabled/streaming-aware click behavior.
- [ ] Pass `setActiveAgent` from `ChatView`.
- [ ] Run frontend tests and Vite build.
