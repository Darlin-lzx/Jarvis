# Platform P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement migration state events, artifact versions with SQL diff, global trace logs, and DB/LLM reliability protection without breaking the existing migration workflow.

**Architecture:** Add small backend services (`reliability.py`, `observability.py`) and extend `ArtifactService` instead of restructuring the application. Keep `db_migrate_task.status`, chat SSE, and the current WebSocket state snapshot authoritative; append event frames and trace/version metadata alongside them. Extend the existing delivery panel and task detail page rather than adding routes.

**Tech Stack:** FastAPI, SQLAlchemy, LangGraph/LangChain, React 19, Vite, pytest, Node built-in tests.

---

## Worktree Constraint

The repository already has many unrelated uncommitted changes. Before each task, run `git status --short`; never revert or broadly stage those files. Several target files are already dirty, so use diff checkpoints instead of automatic commits unless the user explicitly approves mixed-hunk staging.

### Task 1: Reliability Settings And Circuit Breaker

**Files:**

- Create: `jarvis_agent/reliability.py`
- Create: `tests/test_reliability.py`
- Modify: `jarvis_agent/config.py`
- Modify: `config.yaml`
- Modify: `jarvis_agent/llm.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_reliability.py`:

```python
import pytest

from jarvis_agent.config import ReliabilitySettings
from jarvis_agent.reliability import CircuitBreaker, CircuitOpenError, ReliableChatModel


def test_circuit_breaker_opens_and_half_open_recovers():
    breaker = CircuitBreaker(failure_threshold=3, recovery_seconds=30, clock=lambda: 100.0)
    assert breaker.state == "closed"
    for _ in range(3):
        breaker.record_failure()
    assert breaker.state == "open"
    assert breaker.allow_call() is False
    with pytest.raises(CircuitOpenError):
        breaker.check_allowed()
    breaker.clock = lambda: 131.0
    assert breaker.state == "half_open"
    breaker.record_success()
    assert breaker.state == "closed"
    assert breaker.failure_count == 0


def test_circuit_breaker_half_open_failure_reopens():
    breaker = CircuitBreaker(failure_threshold=2, recovery_seconds=10, clock=lambda: 50.0)
    breaker.record_failure()
    breaker.record_failure()
    breaker.clock = lambda: 61.0
    breaker.record_failure()
    assert breaker.state == "open"


class FlakyModel:
    def __init__(self):
        self.calls = 0

    def invoke(self, messages):
        self.calls += 1
        if self.calls < 3:
            raise TimeoutError("model timeout")
        return {"content": "ok"}


def test_reliable_chat_model_retries_transient_failure():
    settings = ReliabilitySettings(llm_retry_count=3, llm_retry_backoff_seconds=0)
    model = FlakyModel()
    reliable = ReliableChatModel(model, settings, sleeper=lambda seconds: None)
    assert reliable.invoke("hello") == {"content": "ok"}
    assert model.calls == 3


def test_reliable_chat_model_opens_after_failure_threshold():
    class TimeoutModel:
        def invoke(self, messages):
            raise TimeoutError("always timeout")

    settings = ReliabilitySettings(
        llm_failure_threshold=2, llm_retry_count=1, llm_retry_backoff_seconds=0
    )
    reliable = ReliableChatModel(TimeoutModel(), settings, sleeper=lambda seconds: None)
    with pytest.raises(TimeoutError):
        reliable.invoke("one")
    with pytest.raises(CircuitOpenError):
        reliable.invoke("two")
```

- [ ] **Step 2: Verify failure**

Run: `.venv/bin/pytest tests/test_reliability.py -q`

Expected: import failure because reliability classes do not exist.

- [ ] **Step 3: Implement**

Add `ReliabilitySettings` to `jarvis_agent/config.py`:

```python
@dataclass
class ReliabilitySettings:
    db_failure_threshold: int = 3
    db_recovery_seconds: int = 30
    llm_failure_threshold: int = 3
    llm_recovery_seconds: int = 60
    llm_retry_count: int = 3
    llm_retry_backoff_seconds: float = 1
    node_timeout_seconds: int = 300
```

Add the field to `AppConfig`, serialize it in `to_dict()`, and parse nested `reliability` dictionaries in `load_config()`.

Create `jarvis_agent/reliability.py`. `CircuitBreaker` exposes `state`, `allow_call()`, `check_allowed()`, `record_success()`, and `record_failure()`; its clock is injectable and transitions are `closed -> open -> half_open -> closed/open`. `CircuitOpenError` subclasses `RuntimeError`.

Implement `ReliableChatModel`:

```python
class ReliableChatModel:
    def __init__(self, model, settings, sleeper=time.sleep):
        self.model = model
        self.settings = settings
        self.sleeper = sleeper
        self.breaker = CircuitBreaker(
            failure_threshold=settings.llm_failure_threshold,
            recovery_seconds=settings.llm_recovery_seconds,
        )

    def parse(self, text):
        return self.model.parse(text)

    def invoke(self, messages, **kwargs):
        self.breaker.check_allowed()
        attempts = max(1, int(self.settings.llm_retry_count))
        last_error = None
        for attempt in range(attempts):
            try:
                result = self.model.invoke(messages, **kwargs)
                self.breaker.record_success()
                return result
            except (TimeoutError, ConnectionError) as exc:
                last_error = exc
                self.breaker.record_failure()
                self.breaker.check_allowed()
                if attempt + 1 < attempts:
                    delay = float(self.settings.llm_retry_backoff_seconds) * (2 ** attempt)
                    self.sleeper(delay)
        raise last_error
```

Append the approved `reliability:` block from the spec to `config.yaml`. Change `create_chat_model(settings, temperature=None, reliability=None)` so provider branches assign `model`, then return `ReliableChatModel(model, reliability)` when reliability settings are supplied.

- [ ] **Step 4: Verify**

Run: `.venv/bin/pytest tests/test_reliability.py -q`

Expected: `4 passed`.

### Task 2: Trace And State Event Persistence

**Files:**

- Modify: `jarvis_agent/db.py`
- Create: `jarvis_agent/observability.py`
- Create: `tests/test_observability.py`
- Modify: `jarvis_agent/state_machine.py`
- Modify: `jarvis_agent/state_stream.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_observability.py`:

```python
import json


def test_task_gets_trace_and_state_events(tmp_path):
    from jarvis_agent.db import Database
    from jarvis_agent.observability import ObservabilityService
    from jarvis_agent.state_machine import MigrateStateService

    db = Database(str(tmp_path / "t.db"))
    service = ObservabilityService(db)
    migrate = MigrateStateService(db, observability=service)
    task = migrate.create(conv_id=None, space_id=None)
    assert task.trace_id
    result = migrate.update_params(task.id, {
        "source_ds_id": "ds1", "source_db_type": "oracle",
        "target_db_type": "dm", "db_business_level": "核心",
        "db_capacity": "100GB", "stop_window": "2小时", "task_confirm": "确认",
    })
    events = service.list_state_events(task.id)
    assert [e["event_type"] for e in events] == ["TASK_STARTED", "NODE_SUCCESS"]
    assert events[-1]["from_status"] == "DATA_COLLECTION"
    assert events[-1]["trace_id"] == task.trace_id
    assert result["task"]["trace_id"] == task.trace_id


def test_trace_logs_are_ordered_and_serializable(tmp_path):
    from jarvis_agent.db import Database
    from jarvis_agent.observability import ObservabilityService

    service = ObservabilityService(Database(str(tmp_path / "t.db")))
    trace_id = service.log(trace_id="", phase="llm", span="invoke", message="call")
    service.log(trace_id=trace_id, phase="artifact", span="write", message="saved")
    logs = service.list_trace(trace_id)
    assert [x["phase"] for x in logs] == ["llm", "artifact"]
    assert json.dumps(logs, ensure_ascii=False)
```

- [ ] **Step 2: Verify failure**

Run: `.venv/bin/pytest tests/test_observability.py -q`

Expected: observability module and state-service hook do not exist.

- [ ] **Step 3: Add models and migrations**

Extend `ArtifactRecord` with `version`, `parent_version`, and indexed `trace_id`. Extend `DbMigrateTask` with indexed `task_type`, indexed `trace_id`, and `plugin_version`. Add `MigrateStateEvent` and `TraceLog` ORM classes exactly as specified in the design. Extend `_migrate_project()` with the six incremental columns through `_col_ddl()`.

- [ ] **Step 4: Implement ObservabilityService**

Create `jarvis_agent/observability.py`:

```python
class ObservabilityService:
    def new_trace_id(self) -> str:
        return uuid.uuid4().hex

    def log(self, *, trace_id: str, phase: str, span: str = "",
            level: str = "info", message: str = "", conv_id=None,
            task_id=None, duration_ms=None) -> str:
        trace_id = (trace_id or "").strip() or self.new_trace_id()
        with self.db.session() as session:
            session.add(TraceLog(
                trace_id=trace_id, conv_id=conv_id, task_id=task_id,
                phase=phase, span=span, level=level,
                message=str(message)[:4000], duration_ms=duration_ms,
            ))
            session.commit()
        return trace_id

    def list_trace(self, trace_id: str, limit: int = 500) -> list[dict]:
        with self.db.session() as session:
            rows = list(session.scalars(
                select(TraceLog).where(TraceLog.trace_id == trace_id)
                .order_by(TraceLog.id.asc()).limit(min(max(1, limit), 2000))
            ))
        return [self._trace_to_dict(row) for row in rows]

    def record_state_event(self, *, task_id: int, event_type: str,
                           from_status: str = "", to_status: str = "",
                           node_id: str = "", message: str = "",
                           conv_id=None, trace_id: str = "") -> dict:
        with self.db.session() as session:
            row = MigrateStateEvent(
                task_id=task_id, conv_id=conv_id, event_type=event_type,
                from_status=from_status, to_status=to_status,
                node_id=node_id, message=message[:1000], trace_id=trace_id,
            )
            session.add(row)
            session.commit()
            session.refresh(row)
            result = self._event_to_dict(row)
        if trace_id:
            self.log(
                trace_id=trace_id, phase="state", span=node_id or event_type,
                message=message or event_type, conv_id=conv_id, task_id=task_id,
            )
        return result

    def list_state_events(self, task_id: int, limit: int = 100) -> list[dict]:
        with self.db.session() as session:
            rows = list(session.scalars(
                select(MigrateStateEvent)
                .where(MigrateStateEvent.task_id == task_id)
                .order_by(MigrateStateEvent.id.asc())
                .limit(min(max(1, limit), 500))
            ))
        return [self._event_to_dict(row) for row in rows]
```

`_trace_to_dict()` and `_event_to_dict()` return plain dictionaries with ISO timestamps and safe defaults.

- [ ] **Step 5: Integrate state machine and broadcaster**

Change `MigrateStateService.__init__(self, db, observability=None)`. Generate a trace ID in `create()` and emit `TASK_STARTED`. Emit `NODE_SUCCESS` after status advancement, `NODE_FAILED` in `set_error()`, `TASK_COMPLETED` in `mark_finished()`, and `USER_INPUT` in `resume()`/confirmation updates. Event failures are swallowed by `_safe_event()` so state remains authoritative.

Add `task_type`, `trace_id`, and `plugin_version` to `to_dict()` using `getattr()` fallbacks. Add `migrate_state_event_frame()` and `MigrateStateBroadcaster.broadcast_event()` to `state_stream.py`.

- [ ] **Step 6: Verify**

Run: `.venv/bin/pytest tests/test_observability.py tests/test_state_stream.py -q`

Expected: all selected tests pass.

### Task 3: Artifact Versioning And SQL Diff

**Files:**

- Modify: `jarvis_agent/artifacts.py`
- Create: `tests/test_artifact_versions.py`
- Modify: `jarvis_agent/app.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_artifact_versions.py`:

```python
import pytest


def _service(tmp_path):
    from jarvis_agent.artifacts import ArtifactService
    from jarvis_agent.db import Database
    return ArtifactService(Database(str(tmp_path / "t.db")), str(tmp_path / "artifacts"))


def test_repeated_task_artifact_creates_versions_without_overwrite(tmp_path):
    service = _service(tmp_path)
    first = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 1;"}, task_id=13, trace_id="trace-1",
    )["files"][0]
    second = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 2;"}, task_id=13, trace_id="trace-2",
    )["files"][0]
    assert (first["version"], second["version"], second["parent_version"]) == (1, 2, 1)
    assert service.read(first["id"]) == "SELECT 1;"
    assert service.read(second["id"]) == "SELECT 2;"
    assert first["path"] != second["path"]
    assert [v["version"] for v in service.list_versions(second["id"])] == [1, 2]
    assert service.read_version(second["id"], 1) == "SELECT 1;"


def test_artifact_diff_reports_added_removed_and_changed(tmp_path):
    service = _service(tmp_path)
    service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "CREATE TABLE t (\n  id NUMBER\n);"}, task_id=13,
    )
    second = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "CREATE TABLE t (\n  id BIGINT,\n  name VARCHAR(100)\n);"},
        task_id=13,
    )["files"][0]
    diff = service.diff(second["id"], 1, 2)
    assert diff["summary"]["added"] >= 2
    assert diff["summary"]["removed"] >= 1
    assert diff["summary"]["changed"] >= 1
    assert {"added", "removed", "changed"}.issubset(
        {block["kind"] for block in diff["blocks"]}
    )


def test_artifact_diff_rejects_missing_version(tmp_path):
    service = _service(tmp_path)
    record = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 1"}, task_id=13,
    )["files"][0]
    with pytest.raises(ValueError):
        service.diff(record["id"], 1, 99)
```

- [ ] **Step 2: Verify failure**

Run: `.venv/bin/pytest tests/test_artifact_versions.py -q`

Expected: `write()` rejects keyword-only fields and version/diff methods do not exist.

- [ ] **Step 3: Implement versioned artifact service**

Extend `write()`:

```python
def write(self, namespace, conv_id, agent_id, object_name, files, *,
          task_id=None, trace_id=""):
```

Resolve task ownership from the conversation only when `task_id is None`. For task-bound records, calculate the next version from `task_id + agent_id + object_name + file_type`. Save task-bound files as `namespace/v{N}/{filename}` so old files remain immutable. Record `version`, `parent_version`, and `trace_id`; conversation-only legacy artifacts keep the current path and version 1.

Add `version_record()`, `list_versions()`, `read_version()`, and `diff()`. Diff uses `difflib.SequenceMatcher.get_opcodes()` and maps opcodes to `context`, `added`, `removed`, and `changed` blocks with left/right line numbers. Missing versions raise `ValueError`.

- [ ] **Step 4: Add APIs**

Add `/api/products/{rid}/versions`, `/api/products/{rid}/versions/{version}`, and `/api/products/{rid}/diff?left=&right=`. Return metadata plus content for a version; return summary and blocks for Diff. Preserve existing FastAPI error behavior.

- [ ] **Step 5: Verify**

Run: `.venv/bin/pytest tests/test_artifact_versions.py tests/test_attachments.py -q`

Expected: all selected tests pass.

### Task 4: Wire Trace Through App, Graph, Artifacts, And DB Tools

**Files:**

- Modify: `jarvis_agent/app.py`
- Modify: `jarvis_agent/graph.py`
- Modify: `jarvis_agent/db_tools.py`
- Modify: `tests/test_api.py`
- Modify: `tests/test_observability.py`

- [ ] **Step 1: Add failing integration tests**

Append to `tests/test_observability.py`:

```python
def test_migrate_task_detail_and_trace_api(tmp_path):
    from tests.test_api import _client

    client = _client(tmp_path)
    conv = client.post("/api/conversations", json={"title": "trace"}).json()["data"]
    task = client.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]
    assert task["trace_id"]
    detail = client.get(f"/api/migrate/tasks/{task['task_id']}").json()["data"]
    assert detail["trace_id"] == task["trace_id"]
    trace = client.get(f"/api/trace/{task['trace_id']}").json()["data"]
    assert trace[0]["task_id"] == task["task_id"]
```

Append a product API test to `tests/test_api.py` that writes two SQL versions through `ArtifactService`, then asserts:

```python
assert [v["version"] for v in versions] == [1, 2]
assert old["content"] == "SELECT 1;"
assert diff["summary"]["added"] == 1
assert diff["summary"]["removed"] == 1
```

Also add:

```python
def test_agent_state_carries_trace_id():
    from jarvis_agent.graph import AgentState

    state = AgentState(user_input="x", conv_id=1, trace_id="trace-graph")
    assert state["trace_id"] == "trace-graph"
```

- [ ] **Step 2: Verify failure**

Run: `.venv/bin/pytest tests/test_observability.py tests/test_api.py -q`

Expected: trace API, task trace field, graph state field, or product APIs fail.

- [ ] **Step 3: Integrate app services**

In `create_app()`:

```python
observability = ObservabilityService(db)
db_breaker = CircuitBreaker(
    failure_threshold=cfg.reliability.db_failure_threshold,
    recovery_seconds=cfg.reliability.db_recovery_seconds,
)
migrate_state = MigrateStateService(db, observability=observability)
db_tools = DbTools(db, circuit_breaker=db_breaker)
llm = create_chat_model(cfg.llm, reliability=cfg.reliability)
```

Pass `observability=observability` to `build_graph()`. Add:

```python
@app.get("/api/trace/{trace_id}")
def trace_detail(trace_id: str, limit: int = 500):
    return {"success": True, "data": observability.list_trace(trace_id, limit)}
```

After state-changing migration endpoints and graph updates, broadcast the recorded state event with `migrate_state_broadcaster.broadcast_event()`. Graph updates emit only when they explicitly carry `event_type`, preventing duplicate state-machine events.

- [ ] **Step 4: Thread trace through graph**

Add `trace_id: str` to `AgentState` and `observability` to `GraphRuntime`. Add `_trace(state, phase, span, message, level="info", duration_ms=None)`, which writes trace rows and swallows logging errors.

Call it for route selection (`phase="schedule"`), sub-agent calls (`phase="node"`), LLM invocations (`phase="llm"`), DB/ops/governance tools (`phase="db"`), and artifact writes (`phase="artifact"`). Pass `trace_id=str(state.get("trace_id", "") or "")` to all artifact writes.

Before constructing initial graph state in `chat_stream`, parse `Conversation.task_state`, find `migrate_task_id`, load the migration row, and create/backfill its trace ID. Include it in `AgentState`.

- [ ] **Step 5: Guard DB connections**

Extend `DbTools.__init__(db, circuit_breaker=None)`. For non-Excel `connect()`, call `check_allowed()` before creating an engine. Record failure when `engine.connect()` raises and success when it connects; keep existing transaction rollback and engine disposal unchanged. Excel sources bypass the breaker.

- [ ] **Step 6: Verify**

Run: `.venv/bin/pytest tests/test_observability.py tests/test_api.py tests/test_graph.py -q`

Expected: all selected backend tests pass.

### Task 5: Frontend Versions, Trace, And State Events

**Files:**

- Modify: `web-ui/src/lib/types.ts`
- Modify: `web-ui/src/lib/api.ts`
- Modify: `web-ui/src/hooks/use-migrate-state-socket.ts`
- Modify: `web-ui/src/components/chat/delivery-panel.tsx`
- Modify: `web-ui/src/components/project/task-detail-page.tsx`
- Modify: `web-ui/src/components/project/task-trace-panel.tsx`
- Create: `web-ui/tests/artifact-versions.test.ts`
- Create: `web-ui/tests/state-event-socket.test.ts`

- [ ] **Step 1: Write failing frontend tests**

`web-ui/tests/artifact-versions.test.ts` reads the source files and asserts:

```ts
assert.match(types, /version\?: number/)
assert.match(api, /listArtifactVersions/)
assert.match(api, /getArtifactVersion/)
assert.match(api, /diffArtifact/)
assert.match(panel, /版本历史/)
assert.match(panel, /差异对比/)
assert.match(panel, /diffBlocks/)
```

`web-ui/tests/state-event-socket.test.ts` asserts:

```ts
assert.match(types, /MigrateStateEventFrame/)
assert.match(hook, /state_event/)
assert.match(hook, /setEvents/)
assert.match(taskPage, /trace_id/)
assert.match(tracePanel, /全局追踪/)
```

- [ ] **Step 2: Verify failure**

Run from `web-ui`: `npm test`

Expected: only the two new tests fail.

- [ ] **Step 3: Add frontend types and APIs**

Add `ArtifactVersionItem`, `ArtifactDiffBlock`, `ArtifactDiff`, `TraceLogItem`, `MigrateStateEventData`, and `MigrateStateEventFrame` to `types.ts`. Extend `ArtifactItem` and `MigrateTask` with version/trace fields where applicable.

Add API methods:

```ts
listArtifactVersions: (id: number) => request<ArtifactVersionItem[]>(`/api/products/${id}/versions`)
getArtifactVersion: (id: number, version: number) =>
  request<ArtifactVersionItem & { content: string }>(`/api/products/${id}/versions/${version}`)
diffArtifact: (id: number, left: number, right: number) =>
  request<ArtifactDiff>(`/api/products/${id}/diff?left=${left}&right=${right}`)
getTraceLogs: (traceId: string) => request<TraceLogItem[]>(`/api/trace/${traceId}`)
```

- [ ] **Step 4: Extend socket hook**

Parse both `state` and `state_event` frames. Maintain `events` as the latest 100 events, clear it on task change/disconnect, return it from `useMigrateStateSocket()`, and keep the current 5-second REST fallback.

- [ ] **Step 5: Add version and diff UI**

In `delivery-panel.tsx`, extend the preview drawer with compact `版本历史` and `差异对比` controls. Version switching calls `getArtifactVersion`; Diff selects two existing versions and calls `diffArtifact`. Render `context`, `added`, `removed`, and `changed` blocks with consistent dark-panel styling and line numbers. Disable Diff when only one version exists.

- [ ] **Step 6: Add task trace UI**

Pass `trace_id` from the task detail page into `TaskTracePanel`. Add a compact `全局追踪` section that copies/shows the ID, fetches `getTraceLogs()`, and merges global logs with existing chat traces chronologically. Display phase, span, level, duration, and message.

- [ ] **Step 7: Verify**

Run from `web-ui`: `npm test`

Expected: all frontend tests pass.

### Task 6: Regression, Documentation, And Manual Smoke

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Document operations**

Add a concise `P0 平台化加固` section covering the product version APIs, trace API, `state_event` WebSocket frame, reliability settings, and restart behavior. Note that historical artifacts display as v1 and historical tasks backfill TraceID on first state change.

- [ ] **Step 2: Backend regression**

Run:

```bash
.venv/bin/pytest tests/test_reliability.py tests/test_observability.py tests/test_artifact_versions.py tests/test_state_stream.py tests/test_api.py tests/test_graph.py tests/test_attachments.py -q
```

Expected: all selected backend tests pass.

- [ ] **Step 3: Frontend regression**

Run from `web-ui`: `npm test`

Expected: all frontend tests pass.

- [ ] **Step 4: Compile checks**

Run `.venv/bin/python -m compileall jarvis_agent`, then `npm run build` from `web-ui`. Python must pass. If the repository’s known unrelated TypeScript build errors remain, capture them and confirm none reference the new files.

- [ ] **Step 5: Manual smoke**

Restart backend and Vite. Open a migration task, verify TraceID/timeline, generate the same core artifact twice, switch versions, compare v1/v2, and advance a stage while confirming event display does not duplicate assistant replies.

- [ ] **Step 6: Final review**

Run `git diff --check` and `git status --short`. Review only intended changes and do not revert unrelated dirty files. Commit only with explicit user approval because target files contain pre-existing edits.
