"""业务任务/空间/子系统服务：空间-任务-会话-产物 归属链路"""
from __future__ import annotations

import json
from typing import Dict, List, Optional

from sqlalchemy import func, select

from db_loc_agent.db import (ArtifactRecord, Conversation, Database,
                             DataSource, DocumentRecord, ProjectTask, Space,
                             SpaceSubsystem)


class ProjectError(Exception):
    """业务错误：status 用于映射 HTTP 状态码"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


DEFAULT_SPACE_NAME = "临时会话"


class ProjectService:
    def __init__(self, db: Database):
        self.db = db

    # ---------- 空间 ----------
    @staticmethod
    def _space_dict(sp: Space, subs: List[SpaceSubsystem]) -> Dict:
        return {"id": sp.id, "name": sp.name, "description": sp.description,
                "kb_ids": json.loads(sp.kb_ids or "[]"),
                "members": json.loads(sp.members or "[]"),
                "enabled_agents": json.loads(sp.enabled_agents or "[]"),
                "subsystems": [ProjectService._subsystem_dict(x) for x in subs],
                "created_at": sp.created_at.isoformat() if sp.created_at else None}

    @staticmethod
    def _subsystem_dict(ss: SpaceSubsystem) -> Dict:
        return {"id": ss.id, "space_id": ss.space_id, "name": ss.name,
                "description": ss.description or "",
                "owner": ss.owner or "",
                "tags": json.loads(ss.tags or "[]"),
                "created_at": ss.created_at.isoformat() if ss.created_at else None}

    def list_spaces(self) -> List[Dict]:
        with self.db.session() as s:
            spaces = list(s.scalars(select(Space).order_by(Space.id)))
            subs = list(s.scalars(select(SpaceSubsystem).order_by(SpaceSubsystem.id)))
            # 子系统 → 任务数（供侧边栏角标 / 任务页联动）
            task_counts: Dict[int, int] = {}
            for (sid,) in s.execute(select(ProjectTask.sub_system_id)
                                    .where(ProjectTask.sub_system_id.isnot(None))):
                task_counts[sid] = task_counts.get(sid, 0) + 1
        by_space: Dict[int, List[SpaceSubsystem]] = {}
        for x in subs:
            by_space.setdefault(x.space_id, []).append(x)
        result = []
        for sp in spaces:
            d = self._space_dict(sp, by_space.get(sp.id, []))
            d["task_count"] = sum(task_counts.get(ss["id"], 0) for ss in d["subsystems"])
            for ss in d["subsystems"]:
                ss["task_count"] = task_counts.get(ss["id"], 0)
            result.append(d)
        return result

    def get_space(self, space_id: int) -> Dict:
        with self.db.session() as s:
            sp = s.get(Space, space_id)
            if not sp:
                raise ProjectError(404, "空间不存在")
            subs = list(s.scalars(select(SpaceSubsystem)
                                  .where(SpaceSubsystem.space_id == space_id)))
            return self._space_dict(sp, subs)

    def ensure_default_space(self) -> Dict:
        """获取或创建全局默认空间，用于侧边栏直接新建项目会话。"""
        with self.db.session() as s:
            sp = s.scalar(select(Space).where(Space.name == DEFAULT_SPACE_NAME))
            if sp is None:
                sp = Space(name=DEFAULT_SPACE_NAME, description="系统临时会话目录（新建会话默认落在此）")
                s.add(sp)
                s.commit()
                space_id = sp.id
            else:
                space_id = sp.id
        return self.get_space(space_id)

    def create_space(self, name: str, description: str = "",
                     kb_ids: Optional[List[int]] = None) -> Dict:
        name = (name or "").strip()
        if not name:
            raise ProjectError(400, "空间名称不能为空")
        with self.db.session() as s:
            if s.scalar(select(Space).where(Space.name == name)):
                raise ProjectError(400, "空间名称已存在")
            sp = Space(name=name, description=description or "",
                       kb_ids=json.dumps(kb_ids or [], ensure_ascii=False))
            s.add(sp)
            s.commit()
            s.refresh(sp)
            return self._space_dict(sp, [])

    def update_space(self, space_id: int, payload: Dict) -> Dict:
        with self.db.session() as s:
            sp = s.get(Space, space_id)
            if not sp:
                raise ProjectError(404, "空间不存在")
            if "name" in payload and payload["name"].strip() and payload["name"].strip() != sp.name:
                dup = s.scalar(select(Space).where(Space.name == payload["name"].strip()))
                if dup and dup.id != space_id:
                    raise ProjectError(400, "空间名称已存在")
                sp.name = payload["name"].strip()
            if "description" in payload:
                sp.description = str(payload["description"])
            if "kb_ids" in payload:
                sp.kb_ids = json.dumps(payload["kb_ids"], ensure_ascii=False)
            if "enabled_agents" in payload:
                sp.enabled_agents = json.dumps(payload["enabled_agents"] or [],
                                               ensure_ascii=False)
            s.commit()
            s.refresh(sp)
            subs = list(s.scalars(select(SpaceSubsystem).where(SpaceSubsystem.space_id == space_id)))
            return self._space_dict(sp, subs)

    def delete_space(self, space_id: int) -> None:
        with self.db.session() as s:
            sp = s.get(Space, space_id)
            if not sp:
                raise ProjectError(404, "空间不存在")
            if s.scalar(select(ProjectTask).where(ProjectTask.space_id == space_id)):
                raise ProjectError(409, "空间下存在任务，请先删除任务再删除空间")
            for ss in s.scalars(select(SpaceSubsystem).where(SpaceSubsystem.space_id == space_id)):
                s.delete(ss)
            s.delete(sp)
            s.commit()

    # ---------- 子系统 ----------
    def get_subsystem(self, space_id: int, ssid: int) -> Dict:
        with self.db.session() as s:
            ss = s.get(SpaceSubsystem, ssid)
            if not ss or ss.space_id != space_id:
                raise ProjectError(404, "子系统不存在")
            return self._subsystem_dict(ss)

    def subsystem_stats(self, space_id: int, ssid: int) -> Dict:
        with self.db.session() as s:
            ss = s.get(SpaceSubsystem, ssid)
            if not ss or ss.space_id != space_id:
                raise ProjectError(404, "子系统不存在")
            task_count = s.scalar(select(func.count(ProjectTask.id))
                                  .where(ProjectTask.sub_system_id == ssid)
                                  .where(ProjectTask.space_id == space_id)) or 0
            conv_count = s.scalar(select(func.count(Conversation.id))
                                  .where(Conversation.sub_system_id == ssid)) or 0
            artifact_count = s.scalar(select(func.count(ArtifactRecord.id))
                                      .where(ArtifactRecord.sub_system_id == ssid)) or 0
            doc_count = s.scalar(select(func.count(DocumentRecord.id))
                                 .where(DocumentRecord.sub_system_id == ssid)) or 0
            ds_count = s.scalar(select(func.count(DataSource.id))
                                .where(DataSource.sub_system_id == ssid)) or 0
            return {"space_id": space_id, "sub_system_id": ssid,
                    "task_count": task_count, "conv_count": conv_count,
                    "artifact_count": artifact_count, "doc_count": doc_count,
                    "ds_count": ds_count}

    def create_subsystem(self, space_id: int, name: str, description: str = "",
                         owner: str = "", tags: Optional[List[str]] = None) -> Dict:
        name = (name or "").strip()
        if not name:
            raise ProjectError(400, "子系统名称不能为空")
        with self.db.session() as s:
            if not s.get(Space, space_id):
                raise ProjectError(404, "空间不存在")
            ss = SpaceSubsystem(space_id=space_id, name=name, description=description or "",
                                owner=owner or "", tags=json.dumps(tags or [], ensure_ascii=False))
            s.add(ss)
            s.commit()
            s.refresh(ss)
            return self._subsystem_dict(ss)

    def update_subsystem(self, space_id: int, ssid: int, payload: Dict) -> Dict:
        with self.db.session() as s:
            ss = s.get(SpaceSubsystem, ssid)
            if not ss or ss.space_id != space_id:
                raise ProjectError(404, "子系统不存在")
            if payload.get("name", "").strip():
                ss.name = payload["name"].strip()
            if "description" in payload:
                ss.description = str(payload["description"])
            if "owner" in payload:
                ss.owner = str(payload["owner"])
            if "tags" in payload:
                ss.tags = json.dumps(payload["tags"], ensure_ascii=False)
            s.commit()
            s.refresh(ss)
            return self._subsystem_dict(ss)

    def delete_subsystem(self, space_id: int, ssid: int) -> None:
        with self.db.session() as s:
            ss = s.get(SpaceSubsystem, ssid)
            if not ss or ss.space_id != space_id:
                raise ProjectError(404, "子系统不存在")
            if s.scalar(select(ProjectTask).where(ProjectTask.sub_system_id == ssid)):
                raise ProjectError(409, "子系统已被任务引用，不能删除")
            if s.scalar(select(Conversation).where(Conversation.sub_system_id == ssid)) \
                    or s.scalar(select(ArtifactRecord).where(ArtifactRecord.sub_system_id == ssid)):
                raise ProjectError(409, "子系统下存在会话或产物，不能删除")
            s.delete(ss)
            s.commit()

    # ---------- 任务 ----------
    @staticmethod
    def _task_dict(t: ProjectTask, conv_count: int = 0, art_count: int = 0) -> Dict:
        return {"id": t.id, "space_id": t.space_id, "sub_system_id": t.sub_system_id,
                "name": t.name, "description": t.description, "status": t.status,
                "kb_ids": json.loads(t.kb_ids or "[]"), "agent_id": t.agent_id,
                "creator": t.creator, "conv_count": conv_count, "artifact_count": art_count,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "updated_at": t.updated_at.isoformat() if t.updated_at else None}

    def list_tasks(self, space_id: Optional[int] = None,
                   status: Optional[str] = None,
                   sub_system_id: Optional[int] = None) -> List[Dict]:
        with self.db.session() as s:
            q = select(ProjectTask)
            if space_id:
                q = q.where(ProjectTask.space_id == space_id)
            if sub_system_id:
                q = q.where(ProjectTask.sub_system_id == sub_system_id)
            if status:
                q = q.where(ProjectTask.status == status)
            tasks = list(s.scalars(q.order_by(ProjectTask.id.desc())))
            conv_counts, art_counts = {}, {}
            task_ids = [t.id for t in tasks]
            if task_ids:
                for (tid,) in s.execute(select(Conversation.task_id)
                                        .where(Conversation.task_id.in_(task_ids))):
                    conv_counts[tid] = conv_counts.get(tid, 0) + 1
                for (tid,) in s.execute(select(ArtifactRecord.task_id)
                                        .where(ArtifactRecord.task_id.in_(task_ids))):
                    art_counts[tid] = art_counts.get(tid, 0) + 1
            return [self._task_dict(t, conv_counts.get(t.id, 0), art_counts.get(t.id, 0))
                    for t in tasks]

    def get_task(self, task_id: int) -> Dict:
        with self.db.session() as s:
            t = s.get(ProjectTask, task_id)
            if not t:
                raise ProjectError(404, "任务不存在")
            convs = list(s.scalars(select(Conversation)
                                   .where(Conversation.task_id == task_id)
                                   .order_by(Conversation.id)))
            arts = list(s.scalars(select(ArtifactRecord)
                                  .where(ArtifactRecord.task_id == task_id)
                                  .order_by(ArtifactRecord.id)))
            space = s.get(Space, t.space_id)
            sub = s.get(SpaceSubsystem, t.sub_system_id) if t.sub_system_id else None
        return {**self._task_dict(t, len(convs), len(arts)),
                "space_name": space.name if space else "",
                "sub_system_name": sub.name if sub else "",
                "sessions": [{"id": c.id, "title": c.title,
                              "created_at": c.created_at.isoformat() if c.created_at else None}
                             for c in convs],
                "artifacts": [{"id": a.id, "namespace": a.namespace, "conv_id": a.conv_id,
                               "agent_id": a.agent_id, "object_name": a.object_name,
                               "type": a.file_type,
                               "created_at": a.created_at.isoformat() if a.created_at else None}
                              for a in arts]}

    def create_task(self, space_id: int, name: str,
                    sub_system_id: Optional[int] = None, description: str = "",
                    kb_ids: Optional[List[int]] = None, agent_id: str = "",
                    creator: str = "") -> Dict:
        name = (name or "").strip()
        if not name:
            raise ProjectError(400, "任务名称不能为空")
        if not sub_system_id:
            raise ProjectError(400, "请选择所属子系统")
        with self.db.session() as s:
            if not s.get(Space, space_id):
                raise ProjectError(404, "空间不存在")
            ss = s.get(SpaceSubsystem, sub_system_id)
            if not ss or ss.space_id != space_id:
                raise ProjectError(400, "子系统不属于所选空间")
            t = ProjectTask(space_id=space_id, sub_system_id=sub_system_id, name=name,
                            description=description or "",
                            kb_ids=json.dumps(kb_ids or [], ensure_ascii=False),
                            agent_id=agent_id or "", creator=creator or "")
            s.add(t)
            s.commit()
            s.refresh(t)
            return self._task_dict(t)

    def update_task(self, task_id: int, payload: Dict) -> Dict:
        with self.db.session() as s:
            t = s.get(ProjectTask, task_id)
            if not t:
                raise ProjectError(404, "任务不存在")
            if "space_id" in payload and payload["space_id"] != t.space_id:
                raise ProjectError(403, "任务所属空间创建后不可修改")
            if "sub_system_id" in payload and int(payload["sub_system_id"] or 0) != (t.sub_system_id or 0):
                raise ProjectError(403, "任务所属子系统创建后不可修改")
            if "name" in payload:
                t.name = str(payload["name"]).strip() or t.name
            if "description" in payload:
                t.description = str(payload["description"])
            if "status" in payload:
                t.status = str(payload["status"])
            if "agent_id" in payload:
                t.agent_id = str(payload["agent_id"])
            if "kb_ids" in payload:
                t.kb_ids = json.dumps(payload["kb_ids"], ensure_ascii=False)
            s.commit()
            s.refresh(t)
            return self._task_dict(t)

    def delete_task(self, task_id: int) -> None:
        """删除任务：级联删除其下全部会话（含消息/trace/本地产物），知识库已入库副本保留"""
        from db_loc_agent.db import ChatTrace, Message
        with self.db.session() as s:
            t = s.get(ProjectTask, task_id)
            if not t:
                raise ProjectError(404, "任务不存在")
            # 级联删除该任务下的会话（含其消息/trace/产物记录与本地文件）
            for c in s.scalars(select(Conversation).where(Conversation.task_id == task_id)):
                s.query(Message).filter(Message.conv_id == c.id).delete(synchronize_session=False)
                s.query(ChatTrace).filter(ChatTrace.conv_id == c.id).delete(synchronize_session=False)
                for a in s.scalars(select(ArtifactRecord).where(ArtifactRecord.conv_id == c.id)):
                    if a.path:
                        try:
                            from pathlib import Path as _P
                            _P(a.path).unlink(missing_ok=True)
                        except OSError:
                            pass
                    s.delete(a)
                s.delete(c)
            # 任务其它未删会话残留产物：task_id 解绑保留
            for a in s.scalars(select(ArtifactRecord).where(ArtifactRecord.task_id == task_id)):
                a.task_id = None
            s.delete(t)
            s.commit()

    # ---------- 另存为任务 ----------
    def attach_conversation_to_task(self, conv_id: int, payload: Dict) -> Dict:
        with self.db.session() as s:
            conv = s.get(Conversation, conv_id)
            if not conv:
                raise ProjectError(404, "会话不存在")
            if not conv.space_id:
                raise ProjectError(400, "独立会话必须先归属空间才能转为任务")
            task_id = payload.get("task_id")
            if task_id:
                task = s.get(ProjectTask, int(task_id))
                if not task:
                    raise ProjectError(404, "任务不存在")
                if task.space_id != conv.space_id:
                    raise ProjectError(400, "所选任务与会话所在空间不一致")
            else:
                name = str(payload.get("name") or conv.title or "新任务").strip()
                if not name:
                    raise ProjectError(400, "任务名称不能为空")
                sub_id = payload.get("sub_system_id") or conv.sub_system_id
                if sub_id:
                    ss = s.get(SpaceSubsystem, int(sub_id))
                    if not ss or ss.space_id != conv.space_id:
                        raise ProjectError(400, "子系统不属于会话所在空间")
                task = ProjectTask(space_id=conv.space_id, sub_system_id=sub_id or None,
                                   name=name, description=str(payload.get("description", "")),
                                   agent_id=str(payload.get("agent_id") or conv.agent_id or ""))
                s.add(task)
                s.flush()
            conv.task_id = task.id
            conv.sub_system_id = task.sub_system_id or conv.sub_system_id
            for art in s.scalars(select(ArtifactRecord).where(ArtifactRecord.conv_id == conv_id)):
                art.task_id = task.id
                art.space_id = task.space_id
                art.sub_system_id = task.sub_system_id
            s.commit()
            return {"task_id": task.id, "task_name": task.name}
