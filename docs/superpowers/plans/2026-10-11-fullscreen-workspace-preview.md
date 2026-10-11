# Fullscreen Workspace Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workspace panel's small bottom preview pane with a fullscreen immersive file and diff viewer.

**Architecture:** Keep workspace navigation, loading, API calls, and `openFileRequest` handling inside `WorkspacePanel`. Render the resulting `WorkspaceFile` or `WorkspaceDiff` in a fixed viewport overlay owned by the same component, preserving existing line targeting while freeing the right panel from an embedded preview region. No backend contracts change.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Node test runner.

---

## File Structure

- Create `web-ui/tests/fullscreen-workspace-preview.test.ts`: frontend contract tests for fullscreen layout, line targeting, and Escape handling.
- Modify `web-ui/src/components/chat/workspace-panel.tsx`: add the Escape listener and replace the bottom preview pane with a fullscreen overlay.

The repository currently contains many unrelated staged and unstaged changes. Do not run broad `git add` commands. Stage only the exact files named in each commit step.

### Task 1: Add The Failing Preview Contract Test

**Files:**

- Create: `web-ui/tests/fullscreen-workspace-preview.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-ui/tests/fullscreen-workspace-preview.test.ts` with:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const panel = readFileSync('src/components/chat/workspace-panel.tsx', 'utf8')

test('workspace preview renders as a fullscreen overlay', () => {
  assert.match(panel, /role="dialog"\s+aria-modal="true"/)
  assert.match(panel, /fixed inset-0 z-\[120\] flex flex-col/)
  assert.match(panel, /aria-label="关闭预览"/)
  assert.match(panel, /min-h-0 flex-1 overflow-auto/)
  assert.doesNotMatch(panel, /h-\[48%\]/)
})

test('fullscreen preview preserves line targeting and horizontal scrolling', () => {
  assert.match(panel, /data-line=\{index \+ 1\}/)
  assert.match(panel, /previewLine === index \+ 1/)
  assert.match(panel, /whitespace-pre/)
  assert.doesNotMatch(panel, /whitespace-pre-wrap break-words/)
})

test('fullscreen preview closes with Escape', () => {
  assert.match(panel, /event\.key === 'Escape'/)
  assert.match(panel, /window\.addEventListener\('keydown', closePreview\)/)
  assert.match(panel, /window\.removeEventListener\('keydown', closePreview\)/)
})
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
cd web-ui && node --test tests/fullscreen-workspace-preview.test.ts
```

Expected: FAIL because the current panel has no `role="dialog"`, no fullscreen overlay, no Escape listener, and still contains `h-[48%]`.

- [ ] **Step 3: Commit the failing test in a TDD checkpoint**

Run:

```bash
git add web-ui/tests/fullscreen-workspace-preview.test.ts
git commit -m "test: define fullscreen workspace preview behavior"
```

### Task 2: Implement The Fullscreen Overlay

**Files:**

- Modify: `web-ui/src/components/chat/workspace-panel.tsx`

- [ ] **Step 1: Add the Escape effect**

Immediately after the existing line-scroll effect near line 119, add:

```tsx
  useEffect(() => {
    if (!preview) return
    const closePreview = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPreview(null)
      setPreviewLine(null)
    }
    window.addEventListener('keydown', closePreview)
    return () => window.removeEventListener('keydown', closePreview)
  }, [preview, previewLine])
```

The `previewLine` dependency keeps hook cleanup aligned with the rendered target-line state.

- [ ] **Step 2: Replace the embedded preview block**

Replace the entire current block beginning with `{preview && (` around line 312 and ending before `</aside>` with:

```tsx
      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[120] flex flex-col bg-[#0a0a0e]/[0.98] backdrop-blur-sm"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#252530] bg-[#0f0f14] px-4 py-3">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#9a9aa4]"
              title={preview.path}
            >
              {preview.path}
              {!('diff' in preview) && previewLine ? `:${previewLine}` : ''}
            </span>
            <button
              aria-label="关闭预览"
              className="rounded-md p-1 text-[#5a5a70] transition-colors hover:bg-white/[0.05] hover:text-[#e4e4e9]"
              onClick={() => {
                setPreview(null)
                setPreviewLine(null)
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <pre
            ref={previewRef}
            className="min-h-0 flex-1 overflow-auto bg-[#12121a] p-4 text-[12px] leading-relaxed text-[#b8bfcf]"
          >
            {'diff' in preview ? (
              <span className="whitespace-pre">{preview.diff}</span>
            ) : preview.content.split('\n').map((line, index) => (
              <div
                key={index}
                data-line={index + 1}
                className={cn(
                  '-mx-4 flex min-w-max gap-4 px-4',
                  previewLine === index + 1 && 'bg-sky-500/15 text-sky-100',
                )}
              >
                <span className="w-12 shrink-0 select-none text-right text-[#4a4a5a]">
                  {index + 1}
                </span>
                <span className="whitespace-pre">{line || ' '}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
```

This keeps the same preview state and APIs while giving the content the complete viewport. `whitespace-pre` plus `min-w-max` allows long lines to scroll horizontally instead of wrapping into a taller, harder-to-scan block.

- [ ] **Step 3: Run the focused test**

Run:

```bash
cd web-ui && node --test tests/fullscreen-workspace-preview.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the existing workspace integration test**

Run:

```bash
cd web-ui && node --test tests/agent-workspace-panel.test.ts
```

Expected: PASS, including the existing assertion that message file locations use `openFileRequest` and `data-line`.

- [ ] **Step 5: Run the complete frontend verification**

Run:

```bash
cd web-ui && npm test && npm run build
```

Expected: all Node tests pass and TypeScript/Vite build completes successfully.

- [ ] **Step 6: Commit the implementation**

Run:

```bash
git add web-ui/src/components/chat/workspace-panel.tsx
git commit -m "feat: add fullscreen workspace preview"
```

If Task 1's TDD checkpoint was not committed separately, also include the exact test path in `git add`; never stage unrelated files.
