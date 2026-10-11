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
    """Workspace lookup or read failure with an HTTP-compatible status."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = int(status_code)


class WorkspaceService:
    """Read Git, project files, and tool evidence without mutating the workspace."""

    max_file_bytes = 1024 * 1024
    max_changes = 500
    max_tree_items = 300
    max_diff_chars = 40000
    excluded_dirs = {
        ".git", ".svn", ".hg", ".idea", ".vscode", ".venv", "venv",
        "__pycache__", "node_modules", "dist", "build", "target",
    }

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
    def _git(root: Path, *args: str,
             check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-c", "core.QuotePath=false", *args], cwd=root,
            text=True, capture_output=True, timeout=8, check=check,
        )

    def _is_repo(self, root: Path) -> bool:
        try:
            return self._git(
                root, "rev-parse", "--is-inside-work-tree", check=False,
            ).stdout.strip() == "true"
        except (OSError, subprocess.TimeoutExpired):
            return False

    def _branch(self, root: Path) -> str:
        result = self._git(root, "rev-parse", "--abbrev-ref", "HEAD", check=False)
        return result.stdout.strip() if result.returncode == 0 else ""

    def _status_items(self, root: Path) -> List[Dict[str, Any]]:
        result = self._git(root, "status", "--porcelain=v1", "--untracked-files=normal")
        items: List[Dict[str, Any]] = []
        for line in result.stdout.splitlines()[:self.max_changes]:
            if len(line) < 4:
                continue
            git_status = line[:2].strip() or line[1].strip()
            path = line[3:]
            if path.endswith("/"):
                continue
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
                lines = (root / path).read_text(
                    encoding="utf-8", errors="ignore").splitlines()
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
                except (OSError, subprocess.TimeoutExpired,
                        subprocess.CalledProcessError) as exc:
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
        result = self._git(root, "status", "--porcelain=v1", "--untracked-files=normal")
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
        directory = root if not str(path or "").strip() else self._safe_path(root, path)
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
        current_path = "" if directory == root else directory.relative_to(root).as_posix()
        return {"path": current_path, "items": items,
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
        return {
            "path": candidate.relative_to(root).as_posix(),
            "content": payload.decode("utf-8", errors="replace"), "truncated": False,
        }

    def evidence(self, agent_id: str, conv_id: Optional[int] = None,
                 limit: int = 100) -> Dict[str, Any]:
        root = self._root(agent_id)
        with self.db.session() as session:
            query = select(TraceLog).where(
                TraceLog.agent_id == agent_id,
                TraceLog.phase.in_(["code", "rag"]),
            )
            if conv_id is not None:
                query = query.where(TraceLog.conv_id == int(conv_id))
            rows = list(session.scalars(query.order_by(
                TraceLog.id.desc()).limit(min(max(1, int(limit)), 500))))

        items: List[Dict[str, Any]] = []
        counts = {"read": 0, "search": 0, "kb": 0}
        for row in rows:
            message = row.message or ""
            if row.phase == "rag":
                counts["kb"] += 1
                match = re.search(r"知识库检索:\s*(.*?)(?:（|$)", message)
                item: Dict[str, Any] = {
                    "type": "kb",
                    "query": match.group(1).strip() if match else message,
                }
            elif row.span in ("code_read", "code_presearch_read"):
                counts["read"] += 1
                match = re.search(r"读取工程文件:\s*(.+)$", message)
                item = {"type": "read", "path": match.group(1).strip() if match else ""}
            else:
                counts["search"] += 1
                query_match = re.search(
                    r"(?:搜索工程代码|自动预检索):\s*(.*?)(?:（|$)", message)
                count_match = re.search(r"命中\s*(\d+)\s*个文件", message)
                item = {
                    "type": "search",
                    "query": query_match.group(1).strip() if query_match else message,
                    "matched_count": int(count_match.group(1)) if count_match else 0,
                }
            items.append({
                **item, "id": row.id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            })
        return {**self._agent(agent_id, root), "items": items, "counts": counts}
