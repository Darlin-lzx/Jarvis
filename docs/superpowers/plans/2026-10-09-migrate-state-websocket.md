# Migrate State WebSocket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push authoritative LangGraph migration state snapshots to the browser over WebSocket, with REST polling as a fallback.

**Architecture:** Keep chat text and artifacts on the existing SSE endpoint. Add a small in-process broadcaster that maps migrate task IDs to WebSocket connections. While consuming LangGraph `updates`, the backend extracts `task_state`, builds a full state snapshot, and broadcasts it; the frontend merges snapshots into the existing state board.

**Tech Stack:** FastAPI WebSocket, LangGraph `stream(stream_mode=["updates"])`, React 19 hook, Vite proxy, pytest, Node built-in tests.

---

## File Map

- Create `db_loc_agent/state_stream.py`: connection registry, task snapshot builder, safe cross-thread dispatch.
- Modify `db_loc_agent/app.py`: instantiate broadcaster, add `/ws/migrate/{task_id}`, broadcast from LangGraph updates and REST advancement.
- Create `tests/test_state_stream.py`: broadcaster and WebSocket API tests.
- Modify `tests/test_api.py`: REST advancement broadcast integration test.
- Modify `web-ui/src/lib/types.ts`: WebSocket snapshot type.
- Create `web-ui/src/hooks/use-migrate-state-socket.ts`: connection, snapshot merge, polling fallback.
- Modify `web-ui/src/components/project/task-detail-page.tsx`: consume real-time snapshots.
- Modify `web-ui/src/components/chat/chat-view.tsx`: consume real-time snapshots for the current conversation.
- Modify `web-ui/vite.config.ts`: proxy `/ws` to the FastAPI backend.
- Create `web-ui/tests/migrate-state-socket.test.ts`: static contract tests for hook, pages, proxy.

The worktree already contains many unrelated uncommitted changes. During implementation, do not stage or revert unrelated files. If Git commits would accidentally include those changes, verify with `git diff -- <paths>` and defer the commit rather than staging broad paths.

### Task 1: Backend Broadcaster

**Files:**
- Create: `db_loc_agent/state_stream.py`
- Test: `tests/test_state_stream.py`

- [ ] **Step 1: Write failing broadcaster tests**

```python
import asyncio

from db_loc_agent.state_stream import MigrateStateBroadcaster


class FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.loop = None

    async def send_json(self, data):
        self.sent.append(data)


def test_broadcaster_sends_snapshot_to_task_connection():
    b = MigrateStateBroadcaster()
    ws = FakeWebSocket()

    async def run():
        await b.add(1, ws)
        b.broadcast(1, {"event": "state", "task_id": 1})
        await asyncio.sleep(0)
        assert ws.sent == [{"event": "state", "task_id": 1}]
        await b.remove(1, ws)

    asyncio.run(run())
    assert b.count(1) == 0


def test_broadcaster_removes_failed_connection_and_keeps_healthy_connection():
    b = MigrateStateBroadcaster()
    failed = FakeWebSocket()
    healthy = FakeWebSocket()

    async def failed_send(_):
        raise RuntimeError("closed")

    failed.send_json = failed_send

    async def run():
        await b.add(1, failed)
        await b.add(1, healthy)
        b.broadcast(1, {"event": "state", "task_id": 1})
        await asyncio.sleep(0)
        assert healthy.sent == [{"event": "state", "task_id": 1}]
        assert b.count(1) == 1

    asyncio.run(run())
```

- [ ] **Step 2: Verify tests fail**

Run: `.venv/bin/pytest tests/test_state_stream.py -q`

Expected: import failure for `db_loc_agent.state_stream`.

- [ ] **Step 3: Implement broadcaster**

```python
"""In-process WebSocket broadcasting for migrate task state."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class _Connection:
    websocket: Any
    loop: asyncio.AbstractEventLoop


class MigrateStateBroadcaster:
    def __init__(self):
        self._connections: Dict[int, list[_Connection]] = {}

    async def add(self, task_id: int, websocket: Any) -> None:
        conn = _Connection(websocket, asyncio.get_running_loop())
        self._connections.setdefault(int(task_id), []).append(conn)

    async def remove(self, task_id: int, websocket: Any) -> None:
        conns = self._connections.get(int(task_id), [])
        self._connections[int(task_id)] = [c for c in conns if c.websocket is not websocket]
        if not self._connections[int(task_id)]:
            self._connections.pop(int(task_id), None)

    def count(self, task_id: int) -> int:
        return len(self._connections.get(int(task_id), []))

    def broadcast(self, task_id: int, snapshot: Dict[str, Any]) -> None:
        task_id = int(task_id)
        for conn in list(self._connections.get(task_id, [])):
            self._dispatch(conn, task_id, snapshot)

    def _dispatch(self, conn: _Connection, task_id: int,
                  snapshot: Dict[str, Any]) -> None:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        async def send_and_clean():
            try:
                await conn.websocket.send_json(snapshot)
            except Exception:
                await self.remove(task_id, conn.websocket)

        if current_loop is conn.loop:
            conn.loop.create_task(send_and_clean())
        else:
            asyncio.run_coroutine_threadsafe(send_and_clean(), conn.loop)
```

- [ ] **Step 4: Verify broadcaster tests pass**

Run: `.venv/bin/pytest tests/test_state_stream.py -q`

Expected: 2 passed.

### Task 2: Snapshot API and WebSocket Route

**Files:**
- Modify: `db_loc_agent/state_stream.py`
- Modify: `db_loc_agent/app.py`
- Test: `tests/test_state_stream.py`

- [ ] **Step 1: Add failing WebSocket route tests**

Append to `tests/test_state_stream.py`:

```python
def _client(tmp_path):
    from tests.test_api import _client as api_client
    return api_client(tmp_path)


def test_websocket_returns_initial_migrate_state(tmp_path):
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "状态通道"}).json()["data"]
    task = c.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]

    with c.websocket_connect(f"/ws/migrate/{task['task_id']}") as ws:
        snapshot = ws.receive_json()

    assert snapshot["event"] == "state"
    assert snapshot["task_id"] == task["task_id"]
    assert snapshot["status"] == "DATA_COLLECTION"


def test_websocket_reports_missing_task(tmp_path):
    c = _client(tmp_path)
    with c.websocket_connect("/ws/migrate/99999") as ws:
        snapshot = ws.receive_json()
    assert snapshot["event"] == "not_found"
```

- [ ] **Step 2: Verify route tests fail**

Run: `.venv/bin/pytest tests/test_state_stream.py -q`

Expected: WebSocket route returns 404 or `snapshot` is not a dict.

- [ ] **Step 3: Add snapshot builder**

In `state_stream.py`:

```python
def migrate_state_snapshot(row: Any, task_state: Dict | None = None,
                           status_label=None) -> Dict[str, Any]:
    task_state = task_state if isinstance(task_state, dict) else {}
    status = str(getattr(row, "status", "") or "")
    return {
        "event": "state",
        "task_id": int(row.id),
        "status": status,
        "status_label": status_label(status) if status_label else status,
        "current_step": task_state.get("current_step") or status,
        "step_status": task_state.get("step_status") or "",
        "awaiting_confirmation": bool(task_state.get("awaiting_confirmation")),
        "step_confirm": bool(getattr(row, "step_confirm", True)),
        "strict_flow": bool(getattr(row, "strict_flow", True)),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
```

- [ ] **Step 4: Add route and app broadcaster**

In `app.py`, import:

```python
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from db_loc_agent.state_stream import MigrateStateBroadcaster, migrate_state_snapshot
```

Inside `create_app`, after services are constructed:

```python
migrate_state_broadcaster = MigrateStateBroadcaster()

def _broadcast_migrate_state(task_id: int, task_state: Dict | None = None) -> None:
    try:
        row = migrate_state.get(int(task_id))
        if row is None:
            return
        migrate_state_broadcaster.broadcast(
            int(task_id), migrate_state_snapshot(row, task_state, status_label))
    except Exception:
        pass
```

Add route:

```python
@app.websocket("/ws/migrate/{task_id}")
async def migrate_state_socket(task_id: int, websocket: WebSocket):
    await websocket.accept()
    row = migrate_state.get(task_id)
    if row is None:
        await websocket.send_json({"event": "not_found", "task_id": task_id})
        await websocket.close(code=1008)
        return
    await migrate_state_broadcaster.add(task_id, websocket)
    try:
        await websocket.send_json(
            migrate_state_snapshot(row, None, status_label))
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_json({"event": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await migrate_state_broadcaster.remove(task_id, websocket)
```

- [ ] **Step 5: Verify route tests pass**

Run: `.venv/bin/pytest tests/test_state_stream.py -q`

Expected: 4 passed.

### Task 3: Broadcast LangGraph and REST State Changes

**Files:**
- Modify: `db_loc_agent/app.py`
- Test: `tests/test_state_stream.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing LangGraph stream broadcast test**

Append:

```python
def test_chat_stream_broadcasts_langgraph_task_state(tmp_path, monkeypatch):
    from langchain_core.messages import AIMessage
    import db_loc_agent.app as app_module

    class StateGraph:
        def stream(self, initial, stream_mode=None):
            yield "custom", {"type": "system", "message": "start"}
            yield "updates", {"migration_collector": {
                "task_state": {
                    "migrate_task_id": initial["task_state"]["migrate_task_id"],
                    "current_step": "DATA_COLLECTION",
                    "step_status": "done",
                }
            }}
            yield "messages", (AIMessage(content="采集完成"), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: StateGraph())
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "实时状态"}).json()["data"]
    task = c.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(Conversation, conv["id"])
        row.task_state = json.dumps({
            "migrate_task_id": task["task_id"],
            "current_step": "DATA_COLLECTION",
            "step_status": "running",
        }, ensure_ascii=False)
        s.commit()

    with c.websocket_connect(f"/ws/migrate/{task['task_id']}") as ws:
        ws.receive_json()
        with c.stream("POST", "/api/chat/stream", json={
                "message": "继续", "conv_id": conv["id"],
                "agent_id": "migration_commander"}) as resp:
            assert resp.status_code == 200
            list(resp.iter_lines())
        snapshot = ws.receive_json()

    assert snapshot["event"] == "state"
    assert snapshot["step_status"] == "done"
```

The test needs the existing imports used by `tests/test_api.py`; keep them at file top or import locally.

- [ ] **Step 2: Verify test fails**

Run: `.venv/bin/pytest tests/test_state_stream.py::test_chat_stream_broadcasts_langgraph_task_state -q`

Expected: timeout waiting for a second WebSocket message.

- [ ] **Step 3: Broadcast each relevant graph update**

In `chat_stream.gen()` before the `for mode, payload in graph.stream(...)` loop:

```python
stream_migrate_task_id = (task_state.get("migrate_task_id")
                          if isinstance(task_state, dict) else None)
```

Inside `for node, update in payload.items()`, before existing node branches:

```python
graph_task_state = update.get("task_state")
if isinstance(graph_task_state, dict):
    graph_task_id = graph_task_state.get("migrate_task_id") or stream_migrate_task_id
    if graph_task_id:
        _broadcast_migrate_state(int(graph_task_id), graph_task_state)
```

Also broadcast after `_res_upd` and `_res2` state-machine updates:

```python
_broadcast_migrate_state(migrate_row.id, task_state)
```

- [ ] **Step 4: Add failing REST advancement test**

In `tests/test_api.py`, extend `test_advance_after_collector_report_starts_assessment`:

```python
with c.websocket_connect(f"/ws/migrate/{task['task_id']}") as ws:
    ws.receive_json()
    res = c.post(f"/api/migrate/tasks/{task['task_id']}/advance", json={
        "task_confirm": "确认", "session_id": "test",
    }).json()["data"]
    snapshot = ws.receive_json()

assert snapshot["status"] == "ASSESSMENT_RUNNING"
assert res["task"]["status"] == "ASSESSMENT_RUNNING"
```

- [ ] **Step 5: Verify REST test fails**

Run: `.venv/bin/pytest tests/test_api.py::test_advance_after_collector_report_starts_assessment -q`

Expected: timeout waiting for WebSocket snapshot.

- [ ] **Step 6: Broadcast REST advancement**

At the end of a successful `/api/migrate/tasks/{tid}/advance` update:

```python
res = migrate_state.update_params(tid, payload)
_broadcast_migrate_state(tid, {
    "current_step": res["task"]["status"],
    "step_status": "running",
})
```

- [ ] **Step 7: Verify backend integration**

Run: `.venv/bin/pytest tests/test_state_stream.py tests/test_api.py::test_advance_after_collector_report_starts_assessment -q`

Expected: all selected tests pass.

### Task 4: Frontend WebSocket Hook

**Files:**
- Modify: `web-ui/src/lib/types.ts`
- Create: `web-ui/src/hooks/use-migrate-state-socket.ts`
- Modify: `web-ui/vite.config.ts`
- Test: `web-ui/tests/migrate-state-socket.test.ts`

- [ ] **Step 1: Add type**

In `types.ts`:

```ts
export interface MigrateStateSnapshot {
  event: 'state' | 'pong'
  task_id: number
  status?: MigrateStatus
  status_label?: string
  current_step?: string
  step_status?: string
  awaiting_confirmation?: boolean
  step_confirm?: boolean
  strict_flow?: boolean
  updated_at?: string | null
}
```

- [ ] **Step 2: Write failing frontend contract test**

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const hook = readFileSync(new URL('../src/hooks/use-migrate-state-socket.ts', import.meta.url), 'utf8')
const taskPage = readFileSync(new URL('../src/components/project/task-detail-page.tsx', import.meta.url), 'utf8')
const chat = readFileSync(new URL('../src/components/chat/chat-view.tsx', import.meta.url), 'utf8')
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

test('migrate state socket merges snapshots and falls back to polling', () => {
  assert.match(hook, /export function useMigrateStateSocket/)
  assert.match(hook, /new WebSocket\(migrateSocketUrl\(taskId\)\)/)
  assert.match(hook, /const fallbackTimer = setInterval\(\(\) => refreshRef.current\(\), 5000\)/)
  assert.match(hook, /setSnapshot\(message\)/)
})

test('task and chat state boards consume websocket snapshots', () => {
  assert.match(taskPage, /useMigrateStateSocket\(migrateDetail\?\.task_id/)
  assert.match(chat, /useMigrateStateSocket\(migrateDetail\?\.task_id/)
  assert.match(vite, /'\/ws'/)
})
```

- [ ] **Step 3: Verify frontend test fails**

Run from `web-ui`: `npm test`

Expected: `migrate-state-socket.test.ts` fails because the hook file does not exist.

- [ ] **Step 4: Implement hook**

```ts
import { useEffect, useRef, useState } from 'react'
import type { MigrateStateSnapshot, MigrateTaskDetail } from '@/lib/types'

function migrateSocketUrl(taskId: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/migrate/${taskId}`
}

export function useMigrateStateSocket(
  taskId: number | null | undefined,
  refresh?: () => void,
) {
  const [snapshot, setSnapshot] = useState<MigrateStateSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [polling, setPolling] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const refreshRef = useRef<(() => void) | undefined>(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    if (taskId == null) {
      setSnapshot(null)
      setConnected(false)
      setPolling(false)
      return
    }
    let closedByUnmount = false
    const ws = new WebSocket(migrateSocketUrl(taskId))
    socketRef.current = ws
    ws.onopen = () => {
      setConnected(true)
      setPolling(false)
      refreshRef.current?.()
    }
    ws.onmessage = ev => {
      try {
        const message = JSON.parse(ev.data) as MigrateStateSnapshot
        if (message.event === 'state') setSnapshot(message)
      } catch { /* ignore malformed frames */ }
    }
    ws.onclose = () => {
      if (closedByUnmount) return
      setConnected(false)
      setPolling(true)
      refreshRef.current?.()
    }
    return () => {
      closedByUnmount = true
      ws.close()
      socketRef.current = null
    }
  }, [taskId])

  useEffect(() => {
    if (taskId == null || !polling) return
    refreshRef.current?.()
    const fallbackTimer = setInterval(() => refreshRef.current(), 5000)
    return () => clearInterval(fallbackTimer)
  }, [taskId, polling])

  return { snapshot, connected, polling, setSnapshot }
}

export function mergeMigrateSnapshot(
  detail: MigrateTaskDetail | null,
  snapshot: MigrateStateSnapshot | null,
): MigrateTaskDetail | null {
  if (!detail || !snapshot || snapshot.task_id !== detail.task_id) return detail
  return {
    ...detail,
    status: snapshot.status ?? detail.status,
    status_label: snapshot.status_label ?? detail.status_label,
    current_step: snapshot.current_step ?? detail.current_step,
    step_status: snapshot.step_status ?? detail.step_status,
    awaiting_confirmation: snapshot.awaiting_confirmation ?? detail.awaiting_confirmation,
    step_confirm: snapshot.step_confirm ?? detail.step_confirm,
    strict_flow: snapshot.strict_flow ?? detail.strict_flow,
    updated_at: snapshot.updated_at ?? detail.updated_at,
  }
}
```

- [ ] **Step 5: Add Vite proxy**

In `vite.config.ts`:

```ts
'/ws': { target: 'ws://localhost:8000', ws: true },
```

- [ ] **Step 6: Verify frontend hook test passes**

Run from `web-ui`: `npm test`

Expected: all existing tests plus the new contract test pass.

### Task 5: Connect Real-Time State to Pages

**Files:**
- Modify: `web-ui/src/components/project/task-detail-page.tsx`
- Modify: `web-ui/src/components/chat/chat-view.tsx`
- Test: `web-ui/tests/migrate-state-socket.test.ts`

- [ ] **Step 1: Extend failing page test**

Add:

```ts
test('pages merge websocket snapshots into migrate detail', () => {
  assert.match(taskPage, /mergeMigrateSnapshot\(migrateDetail, socket\.snapshot\)/)
  assert.match(chat, /mergeMigrateSnapshot\(migrateDetail, socket\.snapshot\)/)
})
```

Run from `web-ui`: `npm test`.

Expected: new assertion fails.

- [ ] **Step 2: Integrate task page**

Import:

```ts
import { mergeMigrateSnapshot, useMigrateStateSocket } from '@/hooks/use-migrate-state-socket'
```

After `migrateDetail` state:

```ts
const migrateSocket = useMigrateStateSocket(migrateDetail?.task_id, load)
const liveMigrateDetail = mergeMigrateSnapshot(migrateDetail, migrateSocket.snapshot)
```

Replace `StateBoard` input `migrateDetail` with `liveMigrateDetail`. Keep REST loading and polling code unchanged as fallback.

- [ ] **Step 3: Integrate chat page**

Import the same helpers. After `migrateDetail` state:

```ts
const migrateSocket = useMigrateStateSocket(migrateDetail?.task_id, refreshMigrateDetail)
const liveMigrateDetail = mergeMigrateSnapshot(migrateDetail, migrateSocket.snapshot)
```

Use `liveMigrateDetail` for the compact progress bar, expanded `StateBoard`, and advance gate. Keep `setMigrateDetail` for REST/SSE updates.

- [ ] **Step 4: Verify frontend**

Run from `web-ui`: `npm test`.

Expected: 39 or more tests pass, with no failures.

### Task 6: Full Regression

**Files:** no new files.

- [ ] **Step 1: Run backend regression**

Run: `.venv/bin/pytest tests/test_state_stream.py tests/test_api.py tests/test_graph.py tests/test_attachments.py -q`

Expected: all tests pass.

- [ ] **Step 2: Run frontend regression**

Run from `web-ui`: `npm test`.

Expected: all tests pass.

- [ ] **Step 3: Check diff hygiene**

Run:

```bash
git diff --check
git diff -- db_loc_agent/state_stream.py db_loc_agent/app.py tests/test_state_stream.py web-ui/src/hooks/use-migrate-state-socket.ts web-ui/src/components/project/task-detail-page.tsx web-ui/src/components/chat/chat-view.tsx web-ui/vite.config.ts web-ui/src/lib/types.ts
```

Expected: no whitespace errors and no unrelated edits in the listed implementation files.
