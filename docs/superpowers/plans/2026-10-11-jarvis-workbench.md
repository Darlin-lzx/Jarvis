# Jarvis Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default workbench with the approved cinematic Jarvis command deck and wire it to real application data.

**Architecture:** Introduce a dedicated `JarvisWorkbench` component and scoped CSS so HUD presentation does not grow the generic workspace panel. The component reads existing APIs for agents, model settings, health, tasks, and artifacts. App-level command handoff creates a conversation and lets `ChatView` send the first message automatically.

**Tech Stack:** React 19, TypeScript, Vite, scoped CSS, existing FastAPI client, Node test runner.

---

### Task 1: Guard the visual contract

**Files:**
- Create: `web-ui/tests/jarvis-workbench-design.test.ts`
- Create: `web-ui/public/jarvis-hud-bg.png`
- Create: `web-ui/src/components/workbench/jarvis-workbench.css`
- Create: `web-ui/src/components/workbench/jarvis-workbench.tsx`

- [ ] **Step 1: Write the failing design test**

Create `web-ui/tests/jarvis-workbench-design.test.ts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('Jarvis workbench uses the approved command deck design', () => {
  const component = read('src/components/workbench/jarvis-workbench.tsx')
  const css = read('src/components/workbench/jarvis-workbench.css')

  assert.match(component, /JARVIS/)
  assert.match(component, /AGENT FLEET/)
  assert.match(component, /KNOWLEDGE/)
  assert.match(css, /jarvis-hud-bg\.png/)
  assert.match(css, /scanline/)
  assert.match(css, /--jarvis-cyan/)
  assert.equal(existsSync('public/jarvis-hud-bg.png'), true)
  assert.equal(component.includes('数据库迁移'), false)
  assert.equal(component.includes('国产库迁移'), false)
})
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `cd web-ui && node --test tests/jarvis-workbench-design.test.ts`

Expected: FAIL because `jarvis-workbench.tsx` does not exist.

### Task 2: Implement the workbench and data wiring

**Files:**
- Modify: `web-ui/src/components/workbench/workbench-view.tsx`
- Modify: `web-ui/src/App.tsx`
- Modify: `web-ui/src/components/chat/chat-view.tsx`

- [ ] **Step 1: Implement the three-column command deck**

`JarvisWorkbench` props:

```ts
type JarvisWorkbenchProps = {
  onTabChange?: (tab: string) => void
  onCommand?: (command: string) => void
}
```

Use real sources:

```ts
api.health()
api.getSettings()
api.listAgents()
api.listTasks()
api.listAllArtifacts()
```

Display unavailable values as `UNAVAILABLE`; do not invent CPU, memory, latency, power, or capacity telemetry.

- [ ] **Step 2: Add command handoff**

In `App.tsx`, create a pending command state, create a conversation against the default space, select that conversation, and pass the command down:

```ts
const [pendingCommand, setPendingCommand] = useState<string | null>(null)
const handleJarvisCommand = async (command: string) => {
  // Create default-space conversation, set pendingCommand(command), and open ChatView.
}
```

In `ChatView`, accept:

```ts
initialMessage?: string | null
onInitialMessageConsumed?: () => void
```

After history load settles, send `initialMessage` once and call `onInitialMessageConsumed`.

- [ ] **Step 3: Run source-level test and build**

Run: `cd web-ui && node --test tests/jarvis-workbench-design.test.ts && npm run build`

Expected: test passes and TypeScript build succeeds.

### Task 3: Verify integration and sync

**Files:**
- Generated: `jarvis_agent/web/**`

- [ ] **Step 1: Verify no migration-specific workbench copy**

Run: `rg -n "数据库迁移|国产库迁移|迁移方案|DDL 兼容" web-ui/src/components/workbench/jarvis-workbench.tsx`

Expected: no matches.

- [ ] **Step 2: Run focused tests**

Run: `cd web-ui && node --test tests/jarvis-workbench-design.test.ts`

Expected: PASS.

- [ ] **Step 3: Build and sync production frontend**

Run:

```bash
cd web-ui && npm run build && rsync -a --delete dist/ ../jarvis_agent/web/
```

Expected: build succeeds and production assets contain the new background and bundle.
