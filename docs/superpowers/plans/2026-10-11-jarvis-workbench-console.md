# Jarvis Workbench Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Jarvis commands inside the workbench by adding a persistent, HUD-styled console that talks only to `jarvis_commander`.

**Architecture:** App owns a `jarvisConvId` independent from `conv.currentId` and persists it in `localStorage`; App validates or creates the fixed conversation without changing route state. `JarvisWorkbench` mounts a dedicated `JarvisConsole`, which loads history, reuses `useChatStream`, renders telemetry and structured forms, and scrolls internally while the left and right HUD panels stay visible.

**Tech Stack:** React 18, TypeScript, existing `api` client, existing `useChatStream` hook, existing `UiForm`, CSS, Node's built-in test runner, Vite production build.

---

## Current Repository Constraint

These target files are already modified or untracked in the current dirty worktree:

- `web-ui/src/App.tsx`
- `web-ui/src/components/workbench/workbench-view.tsx`
- `web-ui/src/components/workbench/jarvis-workbench.tsx`
- `web-ui/src/components/workbench/jarvis-workbench.css`
- `web-ui/tests/jarvis-workbench-design.test.ts`

Implementation must not run broad `git add .` and must not automatically commit these files, because doing so would absorb pre-existing edits. Use targeted tests and `npm run build`; if the user later confirms ownership, stage each exact path individually.

### Task 1: Define The Embedded Console Contract

**Files:**

- Modify: `web-ui/tests/jarvis-workbench-design.test.ts`
- Create: `web-ui/tests/jarvis-workbench-console.test.ts`

- [ ] **Step 1: Replace the outdated routing test**

Use this as the complete contents of `web-ui/tests/jarvis-workbench-design.test.ts`:

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

test('Jarvis commands stay in the embedded workbench console', () => {
  const app = read('src/App.tsx')
  const view = read('src/components/workbench/workbench-view.tsx')
  const workbench = read('src/components/workbench/jarvis-workbench.tsx')

  assert.match(app, /jarvisConvId/)
  assert.match(app, /ensureJarvisConversation/)
  assert.match(view, /jarvisConvId=/)
  assert.match(workbench, /<JarvisConsole/)
  assert.equal(app.includes('handleJarvisCommand'), false)
  assert.equal(app.includes('setPendingCommand'), false)
  assert.equal(workbench.includes('onCommand?'), false)
})
```

- [ ] **Step 2: Add behavior and visual assertions**

Create `web-ui/tests/jarvis-workbench-console.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('Jarvis console uses one persisted commander conversation', () => {
  const app = read('src/App.tsx')
  const consoleSource = read('src/components/workbench/jarvis-console.tsx')

  assert.match(app, /const JARVIS_CONV_STORAGE_KEY = 'jarvis\.console\.convId'/)
  assert.match(app, /api\.createConversation\('贾维斯控制台', \{\s*space_id: spaceResponse\.data\.id,\s*agent_id: 'jarvis_commander',\s*\}\)/)
  assert.match(app, /window\.localStorage\.setItem\(JARVIS_CONV_STORAGE_KEY, String\(conversationResponse\.data\.id\)\)/)
  assert.match(consoleSource, /await send\(command, id, 'jarvis_commander'\)/)
  assert.equal(consoleSource.includes('setActiveAgent'), false)
  assert.equal(consoleSource.includes('window.location.hash'), false)
})

test('Jarvis console renders chat, telemetry, faults, forms, and abort', () => {
  const consoleSource = read('src/components/workbench/jarvis-console.tsx')
  const css = read('src/components/workbench/jarvis-workbench.css')

  assert.match(consoleSource, /OPERATOR&gt;/)
  assert.match(consoleSource, /JARVIS&gt;/)
  assert.match(consoleSource, /TRACE ·/)
  assert.match(consoleSource, /FAULT ·/)
  assert.match(consoleSource, /PROCESSING/)
  assert.match(consoleSource, /ABORT/)
  assert.match(consoleSource, /<UiForm/)
  assert.match(consoleSource, /useChatStream/)
  assert.match(consoleSource, /api\.getMessages\(convId\)/)
  assert.match(consoleSource, /stop\(\)/)
  assert.equal(consoleSource.includes('ChatView'), false)
  assert.equal(consoleSource.includes('window.alert'), false)

  assert.match(css, /\.jarvis-console \{/)
  assert.match(css, /\.jarvis-console-log \{/)
  assert.match(css, /\.jarvis-line-user \{/)
  assert.match(css, /\.jarvis-line-jarvis \{/)
  assert.match(css, /\.jarvis-trace \{/)
  assert.match(css, /\.jarvis-fault \{/)
  assert.match(css, /\.jarvis-reactor\.compact \{/)
})
```

- [ ] **Step 3: Verify the new contracts fail**

Run:

```bash
cd web-ui
node --test tests/jarvis-workbench-design.test.ts tests/jarvis-workbench-console.test.ts
```

Expected: fail because `jarvis-console.tsx` does not exist and App still contains `handleJarvisCommand`.

### Task 2: Add App-Owned Persistent Conversation State

**Files:**

- Modify: `web-ui/src/App.tsx`
- Modify: `web-ui/src/components/workbench/workbench-view.tsx`

- [ ] **Step 1: Add the storage helper**

Change the React import in `web-ui/src/App.tsx` to:

```ts
import { useState, useEffect, useCallback } from 'react'
```

Add this directly above `export default function App()`:

```ts
const JARVIS_CONV_STORAGE_KEY = 'jarvis.console.convId'

function readStoredJarvisConvId(): number | null {
  const raw = window.localStorage.getItem(JARVIS_CONV_STORAGE_KEY)
  const id = raw == null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isInteger(id) && id > 0 ? id : null
}
```

Inside `App`, after `activeAgent`, add:

```ts
const [jarvisConvId, setJarvisConvId] = useState<number | null>(() => readStoredJarvisConvId())
```

Delete:

```ts
const [pendingCommand, setPendingCommand] = useState<string | null>(null)
```

- [ ] **Step 2: Replace command routing with conversation ensuring**

Delete the complete `handleJarvisCommand` function and add:

```ts
const ensureJarvisConversation = useCallback(async () => {
  if (jarvisConvId != null) {
    const existing = await api.getConversation(jarvisConvId).catch(() => null)
    if (existing?.success && existing.data) return jarvisConvId
    window.localStorage.removeItem(JARVIS_CONV_STORAGE_KEY)
    setJarvisConvId(null)
  }

  const spaceResponse = await api.getDefaultSpace()
  if (!spaceResponse.success || !spaceResponse.data) {
    throw new Error(spaceResponse.error || '默认空间不可用')
  }

  const conversationResponse = await api.createConversation('贾维斯控制台', {
    space_id: spaceResponse.data.id,
    agent_id: 'jarvis_commander',
  })
  if (!conversationResponse.success || !conversationResponse.data) {
    throw new Error(conversationResponse.error || '会话创建失败')
  }

  const id = conversationResponse.data.id
  window.localStorage.setItem(JARVIS_CONV_STORAGE_KEY, String(id))
  setJarvisConvId(id)
  void conv.reload()
  return id
}, [conv.reload, jarvisConvId])
```

Keep `handleConvCreated` unchanged because explicit sidebar navigation still uses it.

Remove these two props from the `ChatView` element:

```tsx
initialMessage={pendingCommand}
onInitialMessageConsumed={() => setPendingCommand(null)}
```

- [ ] **Step 3: Pass the state through WorkbenchView**

Replace `WorkbenchViewProps` in `web-ui/src/components/workbench/workbench-view.tsx` with:

```ts
interface WorkbenchViewProps {
  activeTab: string
  onTabChange?: (tab: string) => void
  onNew?: () => void
  jarvisConvId: number | null
  ensureJarvisConversation: () => Promise<number>
}
```

Replace the component signature and workspace case with:

```tsx
export function WorkbenchView({
  activeTab,
  onTabChange,
  onNew,
  jarvisConvId,
  ensureJarvisConversation,
}: WorkbenchViewProps) {
```

```tsx
case 'workspace':
  return (
    <JarvisWorkbench
      onTabChange={onTabChange}
      jarvisConvId={jarvisConvId}
      ensureJarvisConversation={ensureJarvisConversation}
    />
  )
```

In App, replace `onCommand={handleJarvisCommand}` with:

```tsx
jarvisConvId={jarvisConvId}
ensureJarvisConversation={ensureJarvisConversation}
```

- [ ] **Step 4: Run routing contract tests**

```bash
cd web-ui
node --test tests/jarvis-workbench-design.test.ts tests/jarvis-workbench-console.test.ts
```

Expected: routing assertions pass; remaining failures point to the missing console and CSS.

### Task 3: Implement The Console Component

**Files:**

- Create: `web-ui/src/components/workbench/jarvis-console.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { Message } from '@/lib/types'
import { useChatStream, type TimelineItem } from '@/hooks/use-chat-stream'
import { UiForm } from '@/components/chat/ui-form'

type JarvisConsoleProps = {
  convId: number | null
  ensureConversation: () => Promise<number>
  onActiveChange?: (active: boolean) => void
}

type ConsoleLine = {
  key: string
  kind: 'user' | 'assistant' | 'trace' | 'fault'
  content: string
  uiRender?: Record<string, unknown> | null
}

function messageToLine(message: Message, index: number): ConsoleLine {
  return {
    key: `history-${message.id ?? index}-${index}`,
    kind: message.role,
    content: message.content,
    uiRender: message.ui_render,
  }
}

function timelineToLine(item: TimelineItem, index: number): ConsoleLine {
  if (item.kind === 'system') {
    const ev = item.ev
    const content = ev.message || ev.event || '系统事件'
    return {
      key: `trace-${index}`,
      kind: ev.event === 'error' || content.includes('❌') ? 'fault' : 'trace',
      content,
    }
  }

  const ev = item.ev
  const actor = ev.agent_name || ev.agent_id || 'SUB AGENT'
  if (ev.error) {
    return { key: `trace-${index}`, kind: 'fault', content: `${actor} · ${ev.error}` }
  }
  return { key: `trace-${index}`, kind: 'trace', content: `${actor} · ${ev.reply || '执行中'}` }
}

function formValuesToMessage(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== '' && value != null)
    .map(([key, value]) => `${key}：${typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}`)
    .join('\n')
}

export function JarvisConsole({ convId, ensureConversation, onActiveChange }: JarvisConsoleProps) {
  const [lines, setLines] = useState<ConsoleLine[]>([])
  const [input, setInput] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const {
    streaming,
    assistantText,
    timeline,
    timelineRef,
    uiRenderRef,
    send,
    stop,
  } = useChatStream()
  const logRef = useRef<HTMLDivElement | null>(null)
  const skipNextHistoryLoadRef = useRef(false)

  useEffect(() => {
    if (convId == null) {
      setLines([])
      setLoadingHistory(false)
      skipNextHistoryLoadRef.current = false
      return
    }
    if (skipNextHistoryLoadRef.current) {
      skipNextHistoryLoadRef.current = false
      setLoadingHistory(false)
      return
    }

    let alive = true
    setLoadingHistory(true)
    api.getMessages(convId).then(response => {
      if (!alive) return
      if (!response.success || !response.data) {
        throw new Error(response.error || '历史加载失败')
      }
      setLines(response.data.map(messageToLine))
    }).catch(error => {
      if (!alive) return
      setLines([{
        key: `history-fault-${Date.now()}`,
        kind: 'fault',
        content: error instanceof Error ? error.message : '历史加载失败',
      }])
    }).finally(() => {
      if (alive) setLoadingHistory(false)
    })
    return () => { alive = false }
  }, [convId])

  const runCommand = useCallback(async (text: string) => {
    const command = text.trim()
    if (!command || streaming || preparing) return

    setPreparing(true)
    if (convId == null) skipNextHistoryLoadRef.current = true

    try {
      const id = await ensureConversation()
      setLines(previous => [...previous, {
        key: `user-${Date.now()}`,
        kind: 'user',
        content: command,
      }])
      setInput('')

      const response = await send(command, id, 'jarvis_commander')
      const traces = timelineRef.current.map(timelineToLine)
      const uiRender = uiRenderRef.current
      if (response || uiRender) {
        setLines(previous => [
          ...previous,
          ...traces,
          {
            key: `assistant-${Date.now()}`,
            kind: 'assistant',
            content: response,
            uiRender,
          },
        ])
      } else {
        setLines(previous => [...previous, ...traces])
      }
    } catch (error) {
      const traces = timelineRef.current.map(timelineToLine)
      setLines(previous => [
        ...previous,
        ...traces,
        {
          key: `fault-${Date.now()}`,
          kind: 'fault',
          content: error instanceof Error ? error.message : '处理失败',
        },
      ])
    } finally {
      setPreparing(false)
    }
  }, [convId, ensureConversation, preparing, send, timelineRef, uiRenderRef])

  const handleSubmit = useCallback(() => {
    if (streaming) {
      stop()
      return
    }
    void runCommand(input)
  }, [input, runCommand, stop, streaming])

  const handleUiAction = useCallback((values: Record<string, unknown>) => {
    void runCommand(formValuesToMessage(values))
  }, [runCommand])

  useEffect(() => {
    onActiveChange?.(lines.length > 0 || streaming || loadingHistory)
  }, [lines.length, loadingHistory, onActiveChange, streaming])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [assistantText, lines, timeline])

  const status = streaming
    ? 'PROCESSING'
    : preparing
      ? 'CONNECTING'
      : convId == null
        ? 'STANDBY'
        : 'READY'

  return (
    <section className="jarvis-console" data-active={lines.length > 0 || streaming ? 'true' : 'false'}>
      <header className="jarvis-console-header">
        <span>JARVIS CONSOLE</span>
        <span className="jarvis-console-status">{status}</span>
      </header>

      <div className="jarvis-console-log" ref={logRef} role="log" aria-live="polite">
        {loadingHistory && <div className="jarvis-trace">TRACE · LOADING HISTORY</div>}
        {lines.map(line => (
          <div key={line.key} className={`jarvis-line jarvis-line-${line.kind}`}>
            {line.kind === 'user' && <span className="jarvis-line-label">OPERATOR&gt;</span>}
            {line.kind === 'assistant' && <span className="jarvis-line-label">JARVIS&gt;</span>}
            {line.kind === 'trace' && <span>TRACE · {line.content}</span>}
            {line.kind === 'fault' && <span>FAULT · {line.content}</span>}
            {(line.kind === 'user' || line.kind === 'assistant') && (
              <div className="jarvis-line-content">
                {line.content}
                {line.uiRender && <UiForm data={line.uiRender} onAction={handleUiAction} />}
              </div>
            )}
          </div>
        ))}

        {streaming && timeline.map((item, index) => {
          const line = timelineToLine(item, index)
          return (
            <div key={line.key} className={`jarvis-line jarvis-line-${line.kind}`}>
              {line.kind === 'trace' && <span>TRACE · {line.content}</span>}
              {line.kind === 'fault' && <span>FAULT · {line.content}</span>}
            </div>
          )
        })}

        {streaming && (
          <div className="jarvis-line jarvis-line-jarvis">
            <span className="jarvis-line-label">JARVIS&gt;</span>
            <div className="jarvis-line-content">
              {assistantText || <span className="jarvis-processing">PROCESSING…</span>}
            </div>
          </div>
        )}
      </div>

      <form
        className="jarvis-input"
        onSubmit={event => {
          event.preventDefault()
          handleSubmit()
        }}
      >
        <input
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="向贾维斯下达指令"
          aria-label="Jarvis command"
          disabled={preparing && !streaming}
        />
        <button type="submit" disabled={preparing && !streaming}>
          {streaming ? 'ABORT' : preparing ? 'CONNECT' : 'EXECUTE'}
        </button>
      </form>
    </section>
  )
}
```

- [ ] **Step 2: Run the source contract tests**

```bash
cd web-ui
node --test tests/jarvis-workbench-design.test.ts tests/jarvis-workbench-console.test.ts
```

Expected: console source assertions pass after Task 4 imports it; CSS assertions remain until Task 5.

### Task 4: Mount The Console In The Workbench

**Files:**

- Modify: `web-ui/src/components/workbench/jarvis-workbench.tsx`

- [ ] **Step 1: Replace command state with console state**

Add:

```tsx
import { JarvisConsole } from './jarvis-console'
```

Replace the props type and signature with:

```ts
type JarvisWorkbenchProps = {
  onTabChange?: (tab: string) => void
  jarvisConvId: number | null
  ensureJarvisConversation: () => Promise<number>
}
```

```tsx
export function JarvisWorkbench({
  onTabChange,
  jarvisConvId,
  ensureJarvisConversation,
}: JarvisWorkbenchProps) {
```

Remove `const [command, setCommand] = useState('')`, remove the `submit` function, and add:

```ts
const [consoleActive, setConsoleActive] = useState(false)
```

- [ ] **Step 2: Replace the old center command block**

Use:

```tsx
<main className={`jarvis-column jarvis-main ${consoleActive ? 'console-active' : ''}`}>
```

Use:

```tsx
<div className={`jarvis-reactor ${consoleActive ? 'compact' : ''}`} aria-hidden="true">
```

Replace the complete old `jarvis-command` block with:

```tsx
<JarvisConsole
  convId={jarvisConvId}
  ensureConversation={ensureJarvisConversation}
  onActiveChange={setConsoleActive}
/>
```

- [ ] **Step 3: Run targeted tests**

```bash
cd web-ui
node --test tests/jarvis-workbench-design.test.ts tests/jarvis-workbench-console.test.ts
```

Expected: all non-CSS assertions pass.

### Task 5: Style The Console And Compact Reactor

**Files:**

- Modify: `web-ui/src/components/workbench/jarvis-workbench.css`

- [ ] **Step 1: Add compact reactor rules after `.jarvis-main`**

```css
.jarvis-main.console-active {
  justify-content: flex-start;
}

.jarvis-main.console-active .jarvis-brand {
  margin-bottom: 2px;
}

.jarvis-reactor.compact {
  height: min(122px, 16vh);
  max-width: 138px;
}

.jarvis-reactor.compact .jarvis-ring-2 {
  animation-duration: 18s;
}

.jarvis-reactor.compact .jarvis-ring-4 {
  animation-duration: 7s;
}

.jarvis-reactor.compact .jarvis-core span {
  font-size: 8px;
}
```

- [ ] **Step 2: Add console rules after `.jarvis-command`**

```css
.jarvis-console {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  width: min(780px, 100%);
  min-height: 0;
  background: rgba(0, 12, 15, .72);
  border: 1px solid var(--jarvis-line);
  box-shadow: 0 0 34px rgba(35, 216, 239, .09), inset 0 0 34px rgba(0, 0, 0, .55);
  backdrop-filter: blur(10px);
}

.jarvis-main.console-active .jarvis-console {
  flex: 1 1 auto;
}

.jarvis-console::before,
.jarvis-console::after {
  content: "";
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid var(--jarvis-cyan);
}

.jarvis-console::before {
  left: -1px;
  top: -1px;
  border-right: 0;
  border-bottom: 0;
}

.jarvis-console::after {
  right: -1px;
  bottom: -1px;
  border-left: 0;
  border-top: 0;
}

.jarvis-console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 13px 8px;
  border-bottom: 1px solid rgba(35, 216, 239, .18);
  color: var(--jarvis-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  letter-spacing: 3px;
}

.jarvis-console-status {
  color: var(--jarvis-cyan);
  text-shadow: 0 0 12px rgba(35, 216, 239, .38);
}

.jarvis-console-log {
  display: none;
  min-height: 0;
  padding: 12px 13px;
  overflow: auto;
  scrollbar-color: rgba(35, 216, 239, .45) rgba(0, 0, 0, .25);
  scrollbar-width: thin;
}

.jarvis-console[data-active='true'] .jarvis-console-log {
  display: block;
  flex: 1 1 auto;
}

.jarvis-line {
  margin-bottom: 10px;
  color: #dfffff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.65;
}

.jarvis-line-label {
  margin-right: 8px;
  color: var(--jarvis-cyan);
  font-weight: 800;
}

.jarvis-line-user {
  display: flex;
  align-items: flex-start;
}

.jarvis-line-user .jarvis-line-label {
  color: #ff8b97;
}

.jarvis-line-jarvis {
  display: flex;
  align-items: flex-start;
}

.jarvis-line-content {
  min-width: 0;
  flex: 1;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.jarvis-trace {
  color: var(--jarvis-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  letter-spacing: 1px;
}

.jarvis-fault {
  color: #ff8b97;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.jarvis-processing {
  color: var(--jarvis-cyan);
  animation: jarvis-blink 1.15s steps(2, start) infinite;
}

.jarvis-console .jarvis-input {
  margin: 12px;
}

.jarvis-console .jarvis-input:has(input:disabled) {
  opacity: .62;
}

@keyframes jarvis-blink {
  50% { opacity: .32; }
}
```

- [ ] **Step 3: Add narrow-layout stability inside the existing media query**

```css
.jarvis-main.console-active {
  min-height: min(78vh, 760px);
}

.jarvis-main.console-active .jarvis-console {
  min-height: 420px;
}
```

- [ ] **Step 4: Run targeted tests**

```bash
cd web-ui
node --test tests/jarvis-workbench-design.test.ts tests/jarvis-workbench-console.test.ts
```

Expected: both files pass.

### Task 6: Verify Tests, Build, And Live UI

**Files:**

- No additional source edits.

- [ ] **Step 1: Frontend tests**

```bash
cd web-ui
npm test
```

Expected: all tests pass. If the previously observed migration/stage-flow failures remain, record their names and confirm they are pre-existing and unrelated; do not change them for this feature.

- [ ] **Step 2: Production build**

```bash
cd web-ui
npm run build
```

Expected: TypeScript and Vite build succeed.

- [ ] **Step 3: Lint**

```bash
cd web-ui
npm run lint
```

Expected: succeeds. Pre-existing failures outside touched behavior must be reported without unrelated edits.

- [ ] **Step 4: Manual verification at `http://127.0.0.1:5173/`**

Verify:

1. Submitting from `#/workspace` does not create `#/chat/{id}`.
2. `OPERATOR>` and streaming `JARVIS>` render in the center console.
3. Left and right HUD panels remain visible.
4. The reactor shrinks, the console scrolls internally, and `ABORT` cancels a run.
5. Refresh restores `贾维斯控制台` history without selecting the sidebar conversation.
6. Deleting that conversation and submitting again creates a replacement without navigation.

## Self-Review

- Spec coverage: non-routing, independent conversation state, exact storage key, fixed agent and title, history, telemetry, faults, structured forms, abort, sidebar refresh, compact reactor, and internal scrolling all have implementation and verification steps.
- Placeholder scan: no placeholder language remains; every source edit has exact code.
- Type consistency: `WorkbenchView`, `JarvisWorkbench`, and `JarvisConsole` share the same `number | null` and `() => Promise<number>` contracts, and the console uses existing `Message`, `TimelineItem`, and `UiForm` types.
- Commit safety: implementation changes are intentionally not committed from this dirty worktree without explicit user confirmation.
