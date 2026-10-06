# Agent Alias Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the composer agent selector icon-only and use alias-first agent names in selection and `@` references.

**Architecture:** Extract alias resolution into a React-free helper, retain the existing `agent-tabs` export as a compatibility wrapper, then update the composer and reference picker to consume it.

**Tech Stack:** React, TypeScript, Tailwind CSS, Node test runner.

---

### Task 1: Alias Resolution

**Files:**
- Create: `web-ui/src/lib/agent-display.ts`
- Modify: `web-ui/src/components/chat/agent-tabs.tsx`
- Test: `web-ui/tests/agent-display.test.ts`

- [x] Add a failing test importing `agentDisplayName` from `web-ui/src/lib/agent-display.ts`, asserting alias-first fallback.
- [x] Run `npm test` and confirm the module is missing.
- [x] Move the helper implementation into `agent-display.ts`, re-export it from `agent-tabs.tsx`, and rerun tests.

### Task 2: Composer And Reference UI

**Files:**
- Modify: `web-ui/src/components/chat/composer.tsx`
- Modify: `web-ui/src/components/chat/reference-picker.tsx`

- [x] Change the composer trigger to the same 28x28 icon-button style as `@`, using `Bot`, with an alias-based tooltip.
- [x] Use `agentDisplayName(a)` for `@` agent items so inserted references use aliases.
- [x] Run all frontend tests and `npx vite build`.
