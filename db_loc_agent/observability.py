"""Global trace and migration state event persistence."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from db_loc_agent.db import MigrateStateEvent, TraceLog


class ObservabilityService:
    def __init__(self, db):
        self.db = db

    def new_trace_id(self) -> str:
        return uuid.uuid4().hex

    def log(self, *, trace_id: str, phase: str, span: str = "",
            level: str = "info", message: str = "", conv_id=None,
            task_id=None, duration_ms=None) -> str:
        trace_id = (trace_id or "").strip() or self.new_trace_id()
        with self.db.session() as session:
            session.add(TraceLog(
                trace_id=trace_id, conv_id=conv_id, task_id=task_id,
                phase=str(phase or "")[:32], span=str(span or "")[:64],
                level=str(level or "info")[:16],
                message=str(message or "")[:4000], duration_ms=duration_ms,
            ))
            session.commit()
        return trace_id

    def list_trace(self, trace_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.db.session() as session:
            rows = list(session.scalars(
                select(TraceLog).where(TraceLog.trace_id == trace_id)
                .order_by(TraceLog.id.asc())
                .limit(min(max(1, int(limit)), 2000))
            ))
        return [self._trace_to_dict(row) for row in rows]

    def record_state_event(self, *, task_id: int, event_type: str,
                           from_status: str = "", to_status: str = "",
                           node_id: str = "", message: str = "",
                           conv_id=None, trace_id: str = "") -> dict[str, Any]:
        with self.db.session() as session:
            row = MigrateStateEvent(
                task_id=int(task_id), conv_id=conv_id,
                event_type=str(event_type or "")[:40],
                from_status=str(from_status or "")[:40],
                to_status=str(to_status or "")[:40],
                node_id=str(node_id or "")[:64],
                message=str(message or "")[:1000],
                trace_id=(trace_id or "").strip(),
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

    def list_state_events(self, task_id: int, limit: int = 100) -> list[dict[str, Any]]:
        with self.db.session() as session:
            rows = list(session.scalars(
                select(MigrateStateEvent)
                .where(MigrateStateEvent.task_id == int(task_id))
                .order_by(MigrateStateEvent.id.asc())
                .limit(min(max(1, int(limit)), 500))
            ))
        return [self._event_to_dict(row) for row in rows]

    def _trace_to_dict(self, row: TraceLog) -> dict[str, Any]:
        return {
            "id": row.id, "trace_id": row.trace_id or "",
            "conv_id": row.conv_id, "task_id": row.task_id,
            "phase": row.phase or "", "span": row.span or "",
            "level": row.level or "info", "message": row.message or "",
            "duration_ms": row.duration_ms,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }

    def _event_to_dict(self, row: MigrateStateEvent) -> dict[str, Any]:
        return {
            "id": row.id, "task_id": row.task_id, "conv_id": row.conv_id,
            "event_type": row.event_type or "", "from_status": row.from_status or "",
            "to_status": row.to_status or "", "node_id": row.node_id or "",
            "message": row.message or "", "trace_id": row.trace_id or "",
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
