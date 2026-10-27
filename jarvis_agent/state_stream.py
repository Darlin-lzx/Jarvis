"""In-process WebSocket broadcasting for cross-project iteration task state."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class _Connection:
    websocket: Any
    loop: asyncio.AbstractEventLoop


class JarvisStateBroadcaster:
    """Tracks WebSocket clients by iteration task and dispatches full snapshots."""

    def __init__(self) -> None:
        self._connections: Dict[int, list[_Connection]] = {}

    async def add(self, task_id: int, websocket: Any) -> None:
        connection = _Connection(websocket, asyncio.get_running_loop())
        self._connections.setdefault(int(task_id), []).append(connection)

    async def remove(self, task_id: int, websocket: Any) -> None:
        task_id = int(task_id)
        remaining = [
            connection for connection in self._connections.get(task_id, [])
            if connection.websocket is not websocket
        ]
        if remaining:
            self._connections[task_id] = remaining
        else:
            self._connections.pop(task_id, None)

    def count(self, task_id: int) -> int:
        return len(self._connections.get(int(task_id), []))

    def broadcast(self, task_id: int, snapshot: Dict[str, Any]) -> None:
        for connection in list(self._connections.get(int(task_id), [])):
            self._dispatch(connection, int(task_id), snapshot)

    def broadcast_event(self, task_id: int, event: Dict[str, Any]) -> None:
        """Dispatch a persisted iteration event without replacing state snapshots."""
        self.broadcast(task_id, event)

    def _dispatch(self, connection: _Connection, task_id: int,
                  snapshot: Dict[str, Any]) -> None:
        try:
            current_loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        async def send_and_clean() -> None:
            try:
                await connection.websocket.send_json(snapshot)
            except Exception:
                await self.remove(task_id, connection.websocket)

        if current_loop is connection.loop:
            connection.loop.create_task(send_and_clean())
        else:
            asyncio.run_coroutine_threadsafe(send_and_clean(), connection.loop)


def jarvis_state_snapshot(row: Any, task_state: Dict[str, Any] | None = None,
                          status_label=None) -> Dict[str, Any]:
    """Build the lightweight full-state frame consumed by the browser board."""
    task_state = task_state if isinstance(task_state, dict) else {}
    status = str(getattr(row, "status", "") or "")
    updated_at = getattr(row, "updated_at", None)
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
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def jarvis_state_event_frame(event: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Normalize a persisted iteration event for the browser board."""
    event = event if isinstance(event, dict) else {}
    return {
        "event": "state_event",
        "id": event.get("id"),
        "task_id": event.get("task_id"),
        "conv_id": event.get("conv_id"),
        "event_type": event.get("event_type") or "",
        "from_status": event.get("from_status") or "",
        "to_status": event.get("to_status") or "",
        "node_id": event.get("node_id") or "",
        "message": event.get("message") or "",
        "trace_id": event.get("trace_id") or "",
        "created_at": event.get("created_at"),
    }


# 兼容旧名（供既有测试/外部引用使用）
MigrateStateBroadcaster = JarvisStateBroadcaster
migrate_state_snapshot = jarvis_state_snapshot
migrate_state_event_frame = jarvis_state_event_frame
