# Core Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce only core agent documents as artifacts and expose them as clickable previews in chat.

**Architecture:** The graph remains the source of truth for artifact creation. Sub-agent events carry the resulting artifact records, while the chat view delegates preview opening to the existing artifact panel. No storage schema changes are needed.

**Tech Stack:** Python/LangGraph, FastAPI, React, TypeScript.

---

### Task 1: Backend Artifact Gate

**Files:**
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [x] Write failing tests for: conversational replies do not write artifacts; core sub-agent replies write only the configured business document and SQL; commander orchestration writes no index.
- [x] Implement the artifact gate and remove commander orchestration-index writing.
- [x] Run graph artifact tests.

### Task 2: Chat Event Contract

**Files:**
- Modify: `jarvis_agent/graph.py`
- Modify: `jarvis_agent/app.py`
- Test: `tests/test_graph.py`

- [x] Write a failing stream test proving sub-agent chat events omit the full report and include artifact records.
- [x] Add artifacts to sub-agent events and traces.
- [x] Run stream tests.

### Task 3: Clickable Chat Preview

**Files:**
- Modify: `web-ui/src/components/chat/chat-view.tsx`
- Modify: `web-ui/src/components/chat/delivery-panel.tsx`
- Modify: `web-ui/src/lib/types.ts`

- [x] Extend sub-agent display items with artifact records.
- [x] Render compact clickable file links instead of full deliverable text.
- [x] Let the artifact panel accept an external preview request and reuse its preview drawer.
- [x] Add a frontend filter test and verify historical process artifacts stay hidden.
- [x] Run `npm test`, `npx vite build`, and the Python regression suite. (`npm run build` is still blocked by pre-existing TypeScript errors outside this change.)

### Task 4: Direct Artifact Agent Streaming

**Files:**
- Modify: `jarvis_agent/app.py`
- Test: `tests/test_api.py`

- [x] Write a failing stream test proving direct consultation of an artifact-producing agent does not stream the full report.
- [x] Buffer direct-agent text until the artifact node decides whether it is a deliverable.
- [x] Emit a clickable artifact card when a file is produced; restore buffered text for conversational replies.
- [x] Run backend and frontend regression tests.
