# Agent Review Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style read-only workspace panel that follows the selected agent and shows Git changes, the project tree, and session tool evidence.

**Architecture:** Add a backend `WorkspaceService` that resolves an agent's `project_dir`, safely reads Git state and files, and extracts tool evidence from `trace_logs`. Expose five FastAPI routes and replace the current artifact-only right panel with a three-tab React workspace. Trace rows must record `agent_id` so Evidence can be filtered by conversation and agent.

**Tech Stack:** Python, FastAPI, SQLAlchemy, Git CLI, React 19, TypeScript, Tailwind, Node test runner, pytest.

---

## File Structure

- Create `jarvis_agent/workspace.py`: path-safe project, Git, file, and evidence reads.
- Modify `jarvis_agent/db.py`: add `trace_logs.agent_id` and lightweight migration.
- Modify `jarvis_agent/observability.py`: persist and return trace `agent_id`.
- Modify `jarvis_agent/graph.py`: attach agent IDs to code traces; add RAG and result-count traces.
- Modify `jarvis_agent/app.py`: instantiate `WorkspaceService` and expose API routes.
- Modify `web-ui/src/lib/types.ts`: add workspace response types.
- Modify `web-ui/src/lib/api.ts`: add workspace API methods.
- Create `web-ui/src/components/chat/workspace-panel.tsx`: three-tab right panel.
- Modify `web-ui/src/components/chat/chat-view.tsx`: mount the workspace panel and refresh it after a chat run.
- Delete `web-ui/src/components/chat/changed-files-panel.tsx`: the artifact-only panel is replaced.
- Create `tests/test_workspace.py`: service unit tests.
- Modify `tests/test_api.py`: API-level workspace coverage.
- Create `web-ui/tests/agent-workspace-panel.test.ts`: frontend contract/static tests.

## Test Commands

- Backend focused: `.venv/bin/pytest -q tests/test_workspace.py tests/test_api.py tests/test_graph.py tests/test_observability.py`
- Backend compile check: `.venv/bin/python -m compileall -q jarvis_agent`
- Frontend tests: `cd web-ui && npm test`
- Frontend build: `cd web-ui && npm run build`
- Frontend deploy: `cd web-ui && rm -rf ../jarvis_agent/web/assets && cp -R dist/* ../jarvis_agent/web/`

---

### Task 1: Attribute workspace traces to agents

**Files:**
- Modify: `jarvis_agent/db.py`
- Modify: `jarvis_agent/observability.py`
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] **Step 1: Write the failing trace attribution test**

Append to `tests/test_graph.py`:

```python
def test_code_and_rag_tool_traces_record_agent_id(tmp_path):
    from sqlalchemy import select

    from jarvis_agent.db import Database, TraceLog
    from jarvis_agent.graph import GraphRuntime
    from jarvis_agent.observability import ObservabilityService

    project = tmp_path / "order-center"
    project.mkdir()
    (project / "Handler.java").write_text("class Handler {}\n", encoding="utf-8")
    db = Database(str(tmp_path / "trace.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.update("family_order_agent", project_dir=str(project))
    rt = GraphRuntime(
        llm=FakeLLM(), rag_search=lambda query, **kwargs: [{"content": "hit"}],
        prompt_service=PromptService(db), artifact_service=None,
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc, rag_enabled=True,
        observability=ObservabilityService(db),
    )
    state = {"conv_id": 7, "trace_id": "trace-agent-id"}

    rt._dispatch_tool("code_search", {"query": "Handler"}, state=state,
                      current_agent_id="family_order_agent")
    rt._dispatch_tool("code_read", {"path": "Handler.java"}, state=state,
                      current_agent_id="family_order_agent")
    rt._dispatch_tool("rag_search", {"query": "移动看家"}, state=state,
                      current_agent_id="family_order_agent")

    with db.session() as session:
        rows = list(session.scalars(select(TraceLog).where(
            TraceLog.trace_id == "trace-agent-id"
        ).order_by(TraceLog.id)))
    assert [(row.phase, row.span, row.agent_id) for row in rows] == [
        ("code", "code_search", "family_order_agent"),
        ("code", "code_read", "family_order_agent"),
        ("rag", "rag_search", "family_order_agent"),
    ]
    assert "命中 1 个文件" in rows[0].message
    assert "读取工程文件: Handler.java" in rows[1].message
    assert "命中 1 条" in rows[2].message
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
.venv/bin/pytest -q tests/test_graph.py::test_code_and_rag_tool_traces_record_agent_id
```

Expected: FAIL because `TraceLog.agent_id` and `_trace(..., agent_id=...)` do not exist.

- [ ] **Step 3: Add the trace column and migration**

In `jarvis_agent/db.py`, add this field immediately after `phase` in `TraceLog`:

```python
    agent_id: Any = Column(String(64), default="", index=True)
```

In `Database._migrate_project`, add `trace_logs` to the tuple:

```python
                ("trace_logs",
                 {"agent_id": "VARCHAR(64) DEFAULT ''"}),
```

- [ ] **Step 4: Persist the agent ID**

Change `ObservabilityService.log` signature to:

```python
    def log(self, *, trace_id: str, phase: str, span: str = "",
            level: str = "info", message: str = "", conv_id=None,
            task_id=None, duration_ms=None, agent_id: str = "") -> str:
```

Add `agent_id=str(agent_id or "")[:64]` to the `TraceLog(...)` constructor. Add `agent_id` to `_trace_to_dict`.

In `GraphRuntime._trace`, add `agent_id: str = ""` to the signature and pass it to `observability.log`.

- [ ] **Step 5: Emit count-bearing code and RAG traces**

Replace the first two blocks in `GraphRuntime._dispatch_tool` with:

```python
        if name == "code_search":
            result = self._code_search(
                agent_for_tools, str(args.get("query", "")),
                top_k=int(args.get("top_k", 20) or 20))
            self._trace(state or {}, "code", name,
                        f"搜索工程代码: {args.get('query', '')}"
                        f"（命中 {len(result.get('matches', []))} 个文件）",
                        agent_id=agent_for_tools)
            return json.dumps(result, ensure_ascii=False)
        if name == "code_read":
            self._trace(state or {}, "code", name,
                        f"读取工程文件: {args.get('path', '')}",
                        agent_id=agent_for_tools)
            return json.dumps(self._code_read(
                agent_for_tools, str(args.get("path", ""))), ensure_ascii=False)
```

Replace the `rag_search` block with:

```python
        if name == "rag_search" and self.rag_search and self.rag_enabled:
            _kb_spaces = self._kb_ids(str(state.get("agent_id") or "") if state else "")
            result = self.rag_search(args.get("query", user_input),
                                     top_k=args.get("top_k", 3),
                                     space_id=None if _kb_spaces
                                     else (state.get("space_id") if state else None),
                                     kb_ids=_kb_spaces or None)
            result_count = len(result) if isinstance(result, list) else 0
            self._trace(state or {}, "rag", name,
                        f"知识库检索: {args.get('query', user_input)}"
                        f"（命中 {result_count} 条）",
                        agent_id=agent_for_tools)
            return json.dumps(result, ensure_ascii=False)
```

- [ ] **Step 6: Run the focused test**

Run:

```bash
.venv/bin/pytest -q tests/test_graph.py::test_code_and_rag_tool_traces_record_agent_id
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add jarvis_agent/db.py jarvis_agent/observability.py jarvis_agent/graph.py tests/test_graph.py
git commit -m "feat: attribute workspace tool traces to agents"
```

---

### Task 2: Add the read-only WorkspaceService

**Files:**
- Create: `jarvis_agent/workspace.py`
- Test: `tests/test_workspace.py`

- [ ] **Step 1: Write failing service tests**

Create `tests/test_workspace.py`:

```python
import subprocess

import pytest

from jarvis_agent.agents import AgentService
from jarvis_agent.bootstrap import bootstrap
from jarvis_agent.db import Database
from jarvis_agent.workspace import WorkspaceError, WorkspaceService


def _service(tmp_path):
    db = Database(str(tmp_path / "workspace.db"))
    bootstrap(db)
    root = tmp_path / "order-center"
    root.mkdir()
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
    (root / "Handler.java").write_text("class Handler {}\n", encoding="utf-8")
    agents = AgentService(db)
    agents.update("family_order_agent", project_dir=str(root))
    return WorkspaceService(db, agents), root


def test_summary_reads_git_branch_and_changes(tmp_path):
    service, root = _service(tmp_path)
    (root / "Handler.java").write_text("class Handler changed {}\n", encoding="utf-8")
    (root / "New.java").write_text("class New {}\n", encoding="utf-8")

    summary = service.summary("family_order_agent")

    assert summary["available"] is True
    assert summary["git"]["is_repo"] is True
    assert summary["changed_count"] == 2
    assert {item["path"] for item in summary["changes"]} == {
        "Handler.java", "New.java"
    }


def test_file_and_tree_are_confined_to_project(tmp_path):
    service, root = _service(tmp_path)
    root.joinpath("src").mkdir()
    root.joinpath("src/Handler.java").write_text("class Handler {}\n", encoding="utf-8")

    tree = service.tree("family_order_agent")
    file = service.file("family_order_agent", "src/Handler.java")

    assert [item["path"] for item in tree["items"]] == ["src"]
    assert file["content"] == "class Handler {}\n"
    with pytest.raises(WorkspaceError) as exc:
        service.file("family_order_agent", "../../workspace.db")
    assert exc.value.status_code == 400


def test_missing_project_returns_unavailable_summary(tmp_path):
    db = Database(str(tmp_path / "empty.db"))
    bootstrap(db)
    service = WorkspaceService(db, AgentService(db))

    assert service.summary("boot_agent")["available"] is False
    with pytest.raises(WorkspaceError):
        service.file("boot_agent", "README.md")


def test_evidence_extracts_reads_and_searches(tmp_path):
    from jarvis_agent.db import TraceLog

    service, _ = _service(tmp_path)
    with service.db.session() as session:
        session.add(TraceLog(
            trace_id="trace-evidence", conv_id=15,
            phase="code", span="code_read", agent_id="family_order_agent",
            message="读取工程文件: Handler.java"))
        session.add(TraceLog(
            trace_id="trace-evidence", conv_id=15,
            phase="code", span="code_search", agent_id="family_order_agent",
            message="搜索工程代码: 移动看家（命中 9 个文件）"))
        session.commit()

    evidence = service.evidence("family_order_agent", conv_id=15)

    assert evidence["counts"] == {"read": 1, "search": 1, "kb": 0}
    assert evidence["items"][0]["type"] == "search"
    assert evidence["items"][0]["query"] == "移动看家"
    assert evidence["items"][1]["type"] == "read"
    assert evidence["items"][1]["path"] == "Handler.java"
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run:

```bash
.venv/bin/pytest -q tests/test_workspace.py
```

Expected: collection/import FAIL because `jarvis_agent.workspace` does not exist.

- [ ] **Step 3: Implement the service**

Create `jarvis_agent/workspace.py`:

```python
"""Read-only workspace inspection for an agent's configured project directory."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from jarvis_agent.agents import AgentService
from jarvis_agent.db import Database, TraceLog


class WorkspaceError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = int(status_code)


class WorkspaceService:
    max_file_bytes = 1024 * 1024
    max_changes = 500
    max_tree_items = 300
    max_diff_chars = 40000
    excluded_dirs = {".git", ".svn", ".hg", ".idea", ".vscode", ".venv", "venv",
                     "__pycache__", "node_modules", "dist", "build", "target"}

    def __init__(self, db: Database, agents: AgentService):
        self.db = db
        self.agents = agents

    def _root(self, agent_id: str) -> Path:
        cfg = self.agents.get(agent_id)
        if cfg is None:
            raise WorkspaceError("智能体不存在", 404)
        raw = str(cfg.get("project_dir") or "").strip()
        if not raw:
            raise WorkspaceError("当前智能体未绑定工程目录", 404)
        path = Path(raw).expanduser()
        root = path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()
        if not root.is_dir():
            raise WorkspaceError("工程目录不可用", 404)
        return root

    def _agent(self, agent_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
        cfg = self.agents.get(agent_id) or {}
        return {
            "agent_id": agent_id,
            "name": cfg.get("alias") or cfg.get("name") or agent_id,
            "project_dir": str(root or cfg.get("project_dir") or ""),
        }

    @staticmethod
    def _safe_path(root: Path, relative_path: str) -> Path:
        raw = str(relative_path or "").strip().lstrip("/")
        if not raw or raw in (".", ".."):
            raise WorkspaceError("path 不能为空")
        candidate = (root / raw).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise WorkspaceError("path 必须位于当前工程目录内", 400) from exc
        return candidate

    @staticmethod
    def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-c", "core.QuotePath=false", *args], cwd=root,
            text=True, capture_output=True, timeout=8, check=check,
        )

    def _is_repo(self, root: Path) -> bool:
        try:
            return self._git(root, "rev-parse", "--is-inside-work-tree",
                             check=False).stdout.strip() == "true"
        except (OSError, subprocess.TimeoutExpired):
            return False

    def _branch(self, root: Path) -> str:
        result = self._git(root, "rev-parse", "--abbrev-ref", "HEAD", check=False)
        return result.stdout.strip() if result.returncode == 0 else ""

    def _status_items(self, root: Path) -> List[Dict[str, Any]]:
        result = self._git(root, "status", "--porcelain=v1", "--untracked-files=all")
        items: List[Dict[str, Any]] = []
        for line in result.stdout.splitlines()[:self.max_changes]:
            if len(line) < 4:
                continue
            git_status = line[:2].strip() or line[1].strip()
            path = line[3:]
            if " -> " in path:
                path = path.split(" -> ", 1)[1]
            additions, deletions = self._numstat(root, path, git_status)
            items.append({
                "path": Path(path).as_posix(), "status": git_status or "M",
                "additions": additions, "deletions": deletions,
            })
        return items

    def _numstat(self, root: Path, path: str, status: str) -> tuple[int, int]:
        if status == "?":
            try:
                lines = (root / path).read_text(encoding="utf-8", errors="ignore").splitlines()
                return len(lines), 0
            except OSError:
                return 0, 0
        result = self._git(root, "diff", "--numstat", "HEAD", "--", path, check=False)
        first = result.stdout.splitlines()[0].split("\t") if result.stdout else []
        if len(first) < 2 or first[0] == "-":
            return 0, 0
        return int(first[0]), int(first[1])

    def _summary_payload(self, agent_id: str, root: Optional[Path],
                         available: bool) -> Dict[str, Any]:
        changes: List[Dict[str, Any]] = []
        is_repo = False
        branch = ""
        git_error = ""
        if root is not None:
            is_repo = self._is_repo(root)
            if is_repo:
                try:
                    branch = self._branch(root)
                    changes = self._status_items(root)
                except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
                    git_error = str(exc)
        return {
            **self._agent(agent_id, root), "available": available,
            "git": {"is_repo": is_repo, "branch": branch, "error": git_error},
            "changes": changes, "changed_count": len(changes),
        }

    def summary(self, agent_id: str) -> Dict[str, Any]:
        try:
            root = self._root(agent_id)
        except WorkspaceError:
            return self._summary_payload(agent_id, None, False)
        return self._summary_payload(agent_id, root, True)

    def changes(self, agent_id: str) -> Dict[str, Any]:
        root = self._root(agent_id)
        return self._summary_payload(agent_id, root, True)

    def diff(self, agent_id: str, path: str) -> Dict[str, Any]:
        root = self._root(agent_id)
        safe = self._safe_path(root, path)
        relative = safe.relative_to(root).as_posix()
        if self._status_items_map(root).get(relative) == "?":
            content = safe.read_text(encoding="utf-8", errors="replace") \
                if safe.is_file() else ""
            body = "\n".join(f"+{line}" for line in content.splitlines())
            text = f"--- /dev/null\n+++ b/{relative}\n{body}"
        else:
            text = self._git(root, "diff", "HEAD", "--", relative).stdout
        return {"path": relative, "diff": text[:self.max_diff_chars],
                "truncated": len(text) > self.max_diff_chars}

    def _status_items_map(self, root: Path) -> Dict[str, str]:
        result = self._git(root, "status", "--porcelain=v1", "--untracked-files=all")
        output: Dict[str, str] = {}
        for line in result.stdout.splitlines():
            if len(line) < 4:
                continue
            path = line[3:]
            if " -> " in path:
                path = path.split(" -> ", 1)[1]
            output[Path(path).as_posix()] = line[:2].strip() or line[1].strip()
        return output

    def tree(self, agent_id: str, path: str = "") -> Dict[str, Any]:
        root = self._root(agent_id)
        directory = self._safe_path(root, path)
        if not directory.is_dir():
            raise WorkspaceError("目录不存在", 404)
        children = sorted(
            [item for item in directory.iterdir()
             if item.name not in self.excluded_dirs and not item.is_symlink()],
            key=lambda item: (not item.is_dir(), item.name.lower()),
        )
        items = [{
            "name": item.name,
            "path": item.relative_to(root).as_posix(),
            "type": "directory" if item.is_dir() else "file",
        } for item in children[:self.max_tree_items]]
        return {"path": directory.relative_to(root).as_posix(), "items": items,
                "truncated": len(children) > self.max_tree_items}

    def file(self, agent_id: str, path: str) -> Dict[str, Any]:
        root = self._root(agent_id)
        candidate = self._safe_path(root, path)
        if not candidate.is_file():
            raise WorkspaceError("文件不存在", 404)
        if candidate.stat().st_size > self.max_file_bytes:
            raise WorkspaceError("文件超过 1MB，不支持在线预览", 413)
        payload = candidate.read_bytes()
        if b"\0" in payload[:8192]:
            raise WorkspaceError("二进制文件不支持在线预览", 415)
        content = payload.decode("utf-8", errors="replace")
        return {
            "path": candidate.relative_to(root).as_posix(),
            "content": content, "truncated": False,
        }

    def evidence(self, agent_id: str, conv_id: Optional[int] = None,
                 limit: int = 100) -> Dict[str, Any]:
        root = self._root(agent_id)
        with self.db.session() as session:
            query = select(TraceLog).where(
                TraceLog.agent_id == agent_id,
                TraceLog.phase.in_(["code", "rag"]),
            if conv_id is not None:
                query = query.where(TraceLog.conv_id == int(conv_id))
            rows = list(session.scalars(query.order_by(
                TraceLog.id.desc()).limit(min(max(1, int(limit)), 500))))
        items: List[Dict[str, Any]] = []
        counts = {"read": 0, "search": 0, "kb": 0}
        for row in rows:
            message = row.message or ""
            if row.phase == "rag":
                kind, counts["kb"] = "kb", counts["kb"] + 1
                match = re.search(r"知识库检索:\s*(.*?)(?:（|$)", message)
                item = {"type": kind, "query": match.group(1).strip() if match else message}
            elif row.span in ("code_read", "code_presearch_read"):
                kind, counts["read"] = "read", counts["read"] + 1
                match = re.search(r"读取工程文件:\s*(.+)$", message)
                item = {"type": kind, "path": match.group(1).strip() if match else ""}
            else:
                kind, counts["search"] = "search", counts["search"] + 1
                query_match = re.search(r"(?:搜索工程代码|自动预检索):\s*(.*?)(?:（|$)", message)
                count_match = re.search(r"命中\s*(\d+)\s*个文件", message)
                item = {
                    "type": kind,
                    "query": query_match.group(1).strip() if query_match else message,
                    "matched_count": int(count_match.group(1)) if count_match else 0,
                }
            items.append({**item, "id": row.id, "created_at":
                          row.created_at.isoformat() if row.created_at else None})
        return {**self._agent(agent_id, root), "items": items, "counts": counts}
```

- [ ] **Step 4: Run service tests**

Run:

```bash
.venv/bin/pytest -q tests/test_workspace.py
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add jarvis_agent/workspace.py tests/test_workspace.py
git commit -m "feat: add read-only agent workspace service"
```

---

### Task 3: Expose workspace API routes

**Files:**
- Modify: `jarvis_agent/app.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write the failing API test**

Append to `tests/test_api.py`:

```python
def test_agent_workspace_api(tmp_path):
    import subprocess

    from jarvis_agent.db import Database

    db_path = str(tmp_path / "t.db")
    root = tmp_path / "workspace-project"
    root.mkdir()
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
    (root / "Handler.java").write_text("class Handler {}\n", encoding="utf-8")
    c = _client(tmp_path)
    assert c.put("/api/agents/boot_agent", json={"project_dir": str(root)}).status_code == 200

    summary = c.get("/api/agents/boot_agent/workspace/summary").json()["data"]
    assert summary["available"] is True
    assert summary["changed_count"] == 1

    changed = c.get("/api/agents/boot_agent/workspace/changes").json()["data"]
    assert changed["changes"][0]["path"] == "Handler.java"

    tree = c.get("/api/agents/boot_agent/workspace/tree").json()["data"]
    assert tree["items"][0]["path"] == "Handler.java"

    file = c.get("/api/agents/boot_agent/workspace/file?path=Handler.java").json()["data"]
    assert "class Handler" in file["content"]

    diff = c.get("/api/agents/boot_agent/workspace/file/diff?path=Handler.java").json()["data"]
    assert "+class Handler" in diff["diff"]

    r = c.get("/api/agents/boot_agent/workspace/file?path=../workspace-api.db")
    assert r.status_code == 400

    evidence = c.get("/api/agents/boot_agent/workspace/evidence?conv_id=8").json()["data"]
    assert evidence["items"] == []

    from jarvis_agent.observability import ObservabilityService
    ObservabilityService(Database(db_path)).log(
        trace_id="api-evidence", conv_id=8, phase="rag", span="rag_search",
        agent_id="boot_agent", message="知识库检索: 移动看家（命中 2 条）")
    evidence = c.get("/api/agents/boot_agent/workspace/evidence?conv_id=8").json()["data"]
    assert evidence["counts"]["kb"] == 1
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
.venv/bin/pytest -q tests/test_api.py::test_agent_workspace_api
```

Expected: FAIL with 404 responses because routes do not exist.

- [ ] **Step 3: Register the service and routes**

Add import:

```python
from jarvis_agent.workspace import WorkspaceError, WorkspaceService
```

After `agents_svc = AgentService(db)` add:

```python
    workspace = WorkspaceService(db, agents_svc)
```

After the delete agent route, add:

```python
    @app.get("/api/agents/{aid}/workspace/summary")
    def agent_workspace_summary(aid: str):
        try:
            return {"success": True, "data": workspace.summary(aid)}
        except WorkspaceError as exc:
            raise HTTPException(exc.status_code, str(exc))

    @app.get("/api/agents/{aid}/workspace/changes")
    def agent_workspace_changes(aid: str):
        try:
            return {"success": True, "data": workspace.changes(aid)}
        except WorkspaceError as exc:
            raise HTTPException(exc.status_code, str(exc))

    @app.get("/api/agents/{aid}/workspace/tree")
    def agent_workspace_tree(aid: str, path: str = ""):
        try:
            return {"success": True, "data": workspace.tree(aid, path)}
        except WorkspaceError as exc:
            raise HTTPException(exc.status_code, str(exc))

    @app.get("/api/agents/{aid}/workspace/file")
    def agent_workspace_file(aid: str, path: str):
        try:
            return {"success": True, "data": workspace.file(aid, path)}
        except WorkspaceError as exc:
            raise HTTPException(exc.status_code, str(exc))

    @app.get("/api/agents/{aid}/workspace/file/diff")
    def agent_workspace_diff(aid: str, path: str):
        try:
            return {"success": True, "data": workspace.diff(aid, path)}
        except WorkspaceError as exc:
            raise HTTPException(exc.status_code, str(exc))

    @app.get("/api/agents/{aid}/workspace/evidence")
    def agent_workspace_evidence(aid: str, conv_id: Optional[int] = None,
                                 limit: int = 100):
        try:
            return {"success": True,
                    "data": workspace.evidence(aid, conv_id=conv_id, limit=limit)}
        except WorkspaceError as exc:
            raise HTTPException(exc.status_code, str(exc))
```

- [ ] **Step 4: Run API test**

Run:

```bash
.venv/bin/pytest -q tests/test_api.py::test_agent_workspace_api
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add jarvis_agent/app.py tests/test_api.py
git commit -m "feat: expose agent workspace api"
```

---

### Task 4: Add frontend workspace contracts

**Files:**
- Modify: `web-ui/src/lib/types.ts`
- Modify: `web-ui/src/lib/api.ts`
- Test: `web-ui/tests/agent-workspace-panel.test.ts`

- [ ] **Step 1: Write the failing frontend contract test**

Create `web-ui/tests/agent-workspace-panel.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('agent workspace uses isolated summary, changes, project and evidence APIs', () => {
  const types = read('src/lib/types.ts')
  const api = read('src/lib/api.ts')

  assert.match(types, /export interface WorkspaceSummary \{/)
  assert.match(types, /export interface WorkspaceChange \{/)
  assert.match(types, /export interface WorkspaceEvidence \{/)
  assert.match(api, /agentWorkspaceSummary: \(agentId: string\)/)
  assert.match(api, /agentWorkspaceChanges: \(agentId: string\)/)
  assert.match(api, /agentWorkspaceTree: \(agentId: string, path = ''\)/)
  assert.match(api, /agentWorkspaceFile: \(agentId: string, path: string\)/)
  assert.match(api, /agentWorkspaceDiff: \(agentId: string, path: string\)/)
  assert.match(api, /agentWorkspaceEvidence: \(agentId: string, convId\?: number \| null\)/)
})
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
cd web-ui && npm test -- tests/agent-workspace-panel.test.ts
```

Expected: FAIL on `WorkspaceSummary`.

- [ ] **Step 3: Add types**

Append to `web-ui/src/lib/types.ts`:

```ts
export interface WorkspaceChange {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface WorkspaceSummary {
  available: boolean
  agent_id: string
  name: string
  project_dir: string
  git: { is_repo: boolean; branch: string; error?: string }
  changes: WorkspaceChange[]
  changed_count: number
}

export interface WorkspaceTreeNode {
  name: string
  path: string
  type: 'directory' | 'file'
}

export interface WorkspaceTree {
  path: string
  items: WorkspaceTreeNode[]
  truncated: boolean
}

export interface WorkspaceFile {
  path: string
  content: string
  truncated: boolean
}

export interface WorkspaceDiff {
  path: string
  diff: string
  truncated: boolean
}

export interface WorkspaceEvidenceItem {
  id: number
  type: 'read' | 'search' | 'kb'
  path?: string
  query?: string
  matched_count?: number
  created_at?: string | null
}

export interface WorkspaceEvidence {
  agent_id: string
  name: string
  project_dir: string
  items: WorkspaceEvidenceItem[]
  counts: { read: number; search: number; kb: number }
}
```

- [ ] **Step 4: Add API methods**

Add the import types `WorkspaceDiff, WorkspaceEvidence, WorkspaceFile, WorkspaceSummary, WorkspaceTree` to `web-ui/src/lib/api.ts`. Add methods after `getArtifactContent`:

```ts
  agentWorkspaceSummary: (agentId: string) =>
    request<WorkspaceSummary>(`/api/agents/${encodeURIComponent(agentId)}/workspace/summary`),
  agentWorkspaceChanges: (agentId: string) =>
    request<WorkspaceSummary>(`/api/agents/${encodeURIComponent(agentId)}/workspace/changes`),
  agentWorkspaceTree: (agentId: string, path = '') =>
    request<WorkspaceTree>(`/api/agents/${encodeURIComponent(agentId)}/workspace/tree?path=${encodeURIComponent(path)}`),
  agentWorkspaceFile: (agentId: string, path: string) =>
    request<WorkspaceFile>(`/api/agents/${encodeURIComponent(agentId)}/workspace/file?path=${encodeURIComponent(path)}`),
  agentWorkspaceDiff: (agentId: string, path: string) =>
    request<WorkspaceDiff>(`/api/agents/${encodeURIComponent(agentId)}/workspace/file/diff?path=${encodeURIComponent(path)}`),
  agentWorkspaceEvidence: (agentId: string, convId?: number | null) => {
    const params = new URLSearchParams()
    if (convId != null) params.set('conv_id', String(convId))
    return request<WorkspaceEvidence>(`/api/agents/${encodeURIComponent(agentId)}/workspace/evidence?${params.toString()}`)
  },
```

- [ ] **Step 5: Run frontend contract test**

Run:

```bash
cd web-ui && npm test -- tests/agent-workspace-panel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web-ui/src/lib/types.ts web-ui/src/lib/api.ts web-ui/tests/agent-workspace-panel.test.ts
git commit -m "feat: add agent workspace frontend contracts"
```

---

### Task 5: Build the three-tab workspace panel

**Files:**
- Create: `web-ui/src/components/chat/workspace-panel.tsx`
- Test: `web-ui/tests/agent-workspace-panel.test.ts`

- [ ] **Step 1: Add component structure assertions to the test**

Extend the test file:

```ts
test('workspace panel separates real changes from evidence', () => {
  const panel = read('src/components/chat/workspace-panel.tsx')

  assert.match(panel, /const \[tab, setTab\] = useState<WorkspaceTab>\('changes'\)/)
  assert.match(panel, /agentWorkspaceChanges\(/)
  assert.match(panel, /agentWorkspaceTree\(/)
  assert.match(panel, /agentWorkspaceEvidence\(/)
  assert.match(panel, /Evidence/)
  assert.match(panel, /未绑定工程目录/)
  assert.doesNotMatch(panel, /listArtifacts\(/)
})
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
cd web-ui && npm test -- tests/agent-workspace-panel.test.ts
```

Expected: FAIL because `workspace-panel.tsx` does not exist.

- [ ] **Step 3: Implement the panel**

Create `web-ui/src/components/chat/workspace-panel.tsx` with this exact initial structure and behavior:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { Agent, WorkspaceDiff, WorkspaceEvidence, WorkspaceFile,
  WorkspaceSummary, WorkspaceTreeNode, WorkspaceTree } from '@/lib/types'
import { cn } from '@/lib/utils'
import { FileCode, FileText, Folder, GitBranch, GitCompareArrows,
  Loader2, PanelRightOpen, Search, X } from 'lucide-react'

type WorkspaceTab = 'changes' | 'project' | 'evidence'

interface WorkspacePanelProps {
  agent?: Agent
  convId: number | null
  refreshKey: number
}

const statusClass: Record<string, string> = {
  M: 'text-amber-300 bg-amber-500/10',
  A: 'text-emerald-300 bg-emerald-500/10',
  '?': 'text-emerald-300 bg-emerald-500/10',
  D: 'text-red-300 bg-red-500/10',
  R: 'text-violet-300 bg-violet-500/10',
}

export function WorkspacePanel({ agent, convId, refreshKey }: WorkspacePanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<WorkspaceTab>('changes')
  const [width, setWidth] = useState(360)
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [evidence, setEvidence] = useState<WorkspaceEvidence | null>(null)
  const [projectPath, setProjectPath] = useState('')
  const [project, setProject] = useState<WorkspaceTree | null>(null)
  const [preview, setPreview] = useState<WorkspaceFile | WorkspaceDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const load = useCallback(async () => {
    if (!agent?.id) { setSummary(null); setEvidence(null); return }
    setLoading(true)
    const [summaryResult, evidenceResult] = await Promise.all([
      api.agentWorkspaceSummary(agent.id).catch(() => null),
      api.agentWorkspaceEvidence(agent.id, convId).catch(() => null),
    ])
    setSummary(summaryResult?.success ? summaryResult.data : null)
    setEvidence(evidenceResult?.success ? evidenceResult.data : null)
    setLoading(false)
  }, [agent?.id, convId])

  const loadProject = useCallback(async (path: string) => {
    if (!agent?.id || !summary?.available) return
    const result = await api.agentWorkspaceTree(agent.id, path).catch(() => null)
    if (result?.success) {
      setProjectPath(path)
      setProject(result.data)
    }
  }, [agent?.id, summary?.available])

  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    if (summary?.available) void loadProject('')
    else { setProject(null); setProjectPath('') }
  }, [summary?.available, summary?.project_dir, loadProject])

  const openChange = async (path: string) => {
    if (!agent?.id) return
    setPreview(null)
    const result = await api.agentWorkspaceDiff(agent.id, path).catch(() => null)
    if (result?.success) setPreview(result.data)
  }

  const openFile = async (path: string) => {
    if (!agent?.id) return
    setPreview(null)
    const result = await api.agentWorkspaceFile(agent.id, path).catch(() => null)
    if (result?.success) setPreview(result.data)
  }

  const openEvidence = async (item: WorkspaceEvidenceItem) => {
    if (item.type === 'read' && item.path) await openFile(item.path)
  }

  const onDragStart = (event: React.MouseEvent) => {
    dragRef.current = { startX: event.clientX, startWidth: width }
    const move = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return
      const next = dragRef.current.startWidth - (moveEvent.clientX - dragRef.current.startX)
      setWidth(Math.max(260, Math.min(520, next)))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-[#252530] bg-[#0f0f14] py-3">
        <button className="rounded-md p-1 text-[#8b8b9e] hover:bg-white/[0.04] hover:text-indigo-400"
          title="展开工作区" onClick={() => setCollapsed(false)}>
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <span className="text-[11px] tracking-widest text-[#9a9aa4]" style={{ writingMode: 'vertical-rl' }}>
          Workspace
        </span>
      </aside>
    )
  }

  const projectName = summary?.project_dir.split('/').filter(Boolean).pop() || 'PROJECT'
}
```

Complete the component return with the following exact layout:

```tsx
  return (
    <aside className="relative flex shrink-0 flex-col border-l border-[#252530] bg-[#0f0f14]"
      style={{ width }}>
      <div className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize hover:bg-indigo-500/30"
        onMouseDown={onDragStart} />
      <div className="flex shrink-0 items-center justify-between border-b border-[#252530] px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-[#cdd3e0]">
            {summary?.name || agent?.alias || agent?.name || 'Workspace'}
          </div>
          <div className="truncate font-mono text-[10px] text-[#6a6a7a]" title={summary?.project_dir}>
            {summary?.available ? `${projectName}${summary.git.branch ? ` · ${summary.git.branch}` : ''}` : 'NO PROJECT'}
          </div>
        </div>
        <button className="ml-2 text-[#5a5a70] hover:text-[#9a9aa4]" title="折叠工作区"
          onClick={() => setCollapsed(true)}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-[#252530] p-2">
        {([
          ['changes', `Changes ${summary?.changed_count ?? 0}`],
          ['project', 'Project'],
          ['evidence', `Evidence ${evidence ? evidence.items.length : 0}`],
        ] as const).map(([value, label]) => (
          <button key={value}
            className={cn('rounded-full px-2.5 py-1 text-[10px] transition-colors',
              tab === value ? 'bg-blue-500/15 text-blue-300' : 'text-[#8b8b9e] hover:bg-white/[0.04]')}
            onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !summary ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-[#5a5a70]" />
          </div>
        ) : !summary?.available ? (
          <div className="px-3 py-10 text-center text-[11px] leading-relaxed text-[#4a4a5a]">
            未绑定工程目录
          </div>
        ) : tab === 'changes' ? (
          !summary.git.is_repo ? (
            <div className="px-3 py-10 text-center text-[11px] text-[#4a4a5a]">非 Git 工程</div>
          ) : summary.changes.length === 0 ? (
            <div className="px-3 py-10 text-center text-[11px] text-[#4a4a5a]">暂无修改文件</div>
          ) : summary.changes.map(item => (
            <button key={item.path}
              className="mb-1 w-full rounded-lg border border-[#252530] bg-[#111118] px-2 py-2 text-left hover:border-indigo-500/30"
              onClick={() => openChange(item.path)}>
              <div className="flex items-center gap-2">
                <span className={cn('rounded px-1.5 py-0.5 text-[9px]', statusClass[item.status] || statusClass.M)}>
                  {item.status === '?' ? 'A' : item.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[#e4e4e9]">{item.path}</span>
              </div>
              <div className="mt-1 text-[10px]">
                <span className="text-emerald-400">+{item.additions}</span>
                <span className="ml-2 text-red-400">-{item.deletions}</span>
              </div>
            </button>
          ))
        ) : tab === 'project' ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-[#8b8b9e]">
              <button className="rounded bg-[#16161e] px-1.5 py-0.5 text-blue-300"
                onClick={() => loadProject('')}>{projectName}</button>
              {projectPath.split('/').filter(Boolean).map((part, index, parts) => (
                <button key={part}
                  className="rounded bg-[#16161e] px-1.5 py-0.5 hover:text-indigo-300"
                  onClick={() => loadProject(parts.slice(0, index + 1).join('/'))}>
                  {part}
                </button>
              ))}
            </div>
            {(project?.items || []).map((item: WorkspaceTreeNode) => (
              <button key={item.path}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[#b8bfcf] hover:bg-white/[0.03]"
                onClick={() => item.type === 'directory' ? loadProject(item.path) : openFile(item.path)}>
                {item.type === 'directory'
                  ? <Folder className="h-3 w-3 shrink-0 text-blue-300" />
                  : <FileCode className="h-3 w-3 shrink-0 text-cyan-300" />}
                <span className="truncate">{item.name}</span>
              </button>
            ))}
          </>
        ) : (
          (evidence?.items || []).map(item => (
            <button key={item.id} disabled={item.type !== 'read'}
              className="mb-1 w-full rounded-lg border border-[#252530] bg-[#111118] px-2 py-2 text-left disabled:cursor-default"
              onClick={() => openEvidence(item)}>
              <div className="flex items-center gap-2">
                {item.type === 'read'
                  ? <FileText className="h-3 w-3 shrink-0 text-violet-300" />
                  : <Search className="h-3 w-3 shrink-0 text-emerald-300" />}
                <span className="truncate text-[11px] text-[#e4e4e9]">
                  {item.path || item.query || item.type}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-[#5a5a70]">{item.type}</div>
            </button>
          ))
        )}
      </div>

      {preview && (
        <div className="flex h-[48%] shrink-0 flex-col border-t border-[#252530]">
          <div className="flex shrink-0 items-center justify-between border-b border-[#252530] px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[#9a9aa4]">
              {preview.path}
            </span>
            <button className="ml-2 text-[#5a5a70] hover:text-[#9a9aa4]" onClick={() => setPreview(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[#12121a] p-3 text-[10px] leading-relaxed text-[#b8bfcf]">
            {'diff' in preview ? preview.diff : preview.content}
          </pre>
        </div>
      )}
    </aside>
  )
}
```

Add `WorkspaceEvidenceItem` to the type import at the top of the component.

- [ ] **Step 4: Run frontend tests**

Run:

```bash
cd web-ui && npm test -- tests/agent-workspace-panel.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add web-ui/src/components/chat/workspace-panel.tsx web-ui/tests/agent-workspace-panel.test.ts
git commit -m "feat: add agent review workspace panel"
```

---

### Task 6: Integrate the workspace panel with the chat view

**Files:**
- Modify: `web-ui/src/components/chat/chat-view.tsx`
- Delete: `web-ui/src/components/chat/changed-files-panel.tsx`
- Test: `web-ui/tests/agent-workspace-panel.test.ts`

- [ ] **Step 1: Add integration assertions**

Extend `web-ui/tests/agent-workspace-panel.test.ts`:

```ts
test('chat view refreshes selected agent workspace after each run', () => {
  const chat = read('src/components/chat/chat-view.tsx')

  assert.match(chat, /import \{ WorkspacePanel \} from '\.\/workspace-panel'/)
  assert.doesNotMatch(chat, /ChangedFilesPanel/)
  assert.match(chat, /workspaceRefreshKey/)
  assert.match(chat, /setWorkspaceRefreshKey\(value => value \+ 1\)/)
  assert.match(chat, /<WorkspacePanel/)
  assert.match(chat, /agent=\{selectedWorkspaceAgent\}/)
})
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
cd web-ui && npm test -- tests/agent-workspace-panel.test.ts
```

Expected: integration test FAIL.

- [ ] **Step 3: Replace the artifact panel**

In `web-ui/src/components/chat/chat-view.tsx`:

1. Replace `import { ChangedFilesPanel } from './changed-files-panel'` with:

```tsx
import { WorkspacePanel } from './workspace-panel'
```

2. Add a refresh key below `const [items, setItems] = useState<DisplayItem[]>([])`:

```tsx
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0)
```

3. Add the selected agent immediately below `const agents = ...`:

```tsx
  const selectedWorkspaceAgent = agents.find(item => item.id === activeAgent)
```

4. In `handleSend`, immediately before `void refreshMigrateDetail()`, add:

```tsx
    setWorkspaceRefreshKey(value => value + 1)
```

5. Remove `previewRequest` state and every `setPreviewRequest` call. In the generated-artifact card, replace the clickable `button` for each file with a non-clickable row:

```tsx
<span key={file.id}
  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-indigo-500/25 bg-[#12121a] px-2 py-1 text-[11px] text-indigo-300">
  <FileText className="h-3 w-3 shrink-0" />
  <span className="truncate">{artifactFileName(file)}</span>
</span>
```

6. Replace the right panel JSX:

```tsx
<WorkspacePanel
  agent={selectedWorkspaceAgent}
  convId={convId}
  refreshKey={workspaceRefreshKey}
/>
```

7. Delete `web-ui/src/components/chat/changed-files-panel.tsx`.

- [ ] **Step 4: Run frontend tests and build**

Run:

```bash
cd web-ui && npm test && npm run build
```

Expected: all Node tests pass and TypeScript/Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web-ui/src/components/chat/chat-view.tsx web-ui/src/components/chat/changed-files-panel.tsx web-ui/tests/agent-workspace-panel.test.ts
git commit -m "feat: connect chat workspace to selected agent"
```

---

### Task 7: End-to-end verification and deployment

**Files:**
- Deploy: `jarvis_agent/web/`

- [ ] **Step 1: Run backend regression and compile checks**

Run:

```bash
.venv/bin/python -m compileall -q jarvis_agent
.venv/bin/pytest -q tests/test_workspace.py tests/test_api.py tests/test_graph.py tests/test_observability.py tests/test_reliability.py tests/test_llm.py
```

Expected: compile check exits 0; all selected tests pass. Do not run the unrelated legacy `test_boot_agent_writes_page_show_artifact` or `test_unauthorized_agent_does_not_fall_back_to_space_knowledge` failures as acceptance gates.

- [ ] **Step 2: Run full frontend checks**

Run:

```bash
cd web-ui && npm test && npm run build
```

Expected: all tests and the production build pass.

- [ ] **Step 3: Deploy static assets**

Run:

```bash
cd web-ui && rm -rf ../jarvis_agent/web/assets && cp -R dist/* ../jarvis_agent/web/
```

Expected: `jarvis_agent/web/assets` contains the newly built hashed JS/CSS files.

- [ ] **Step 4: Verify live behavior**

1. Ensure uvicorn is running on port `8000`.
2. Open `http://localhost:8000/`.
3. Select `order-center` in the chat agent tabs.
4. Confirm the right header shows `order-center`, its `project_dir`, and Git branch.
5. Confirm Changes shows only Git working-tree changes.
6. Confirm Project opens `/Users/l1nzx/Data/05_program/IdeaProjects/asiainfo/order-center`.
7. Run `手机受理移动看家参数转换组件是什么`.
8. After completion, confirm Evidence contains `code_read` / `code_search` and Changes remains based on Git state.

- [ ] **Step 5: Commit deployed assets if they changed**

```bash
git add jarvis_agent/web
git commit -m "chore: deploy agent review workspace"
```

---

## Self-Review

- Spec coverage: Tasks 1–3 implement agent-filtered Evidence and read-only Git/file APIs; Task 4–6 implement the three-tab UI and selected-agent switching; Task 7 verifies live behavior.
- Placeholder scan: no TODO/TBD placeholders remain; all code steps include executable content or exact replacement instructions.
- Type consistency: `WorkspaceSummary` matches `WorkspaceService.summary` and `changes`; `WorkspaceTree`, `WorkspaceFile`, `WorkspaceDiff`, and `WorkspaceEvidence` match the service payloads; API method names match component calls.
