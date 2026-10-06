"""产物写入与 namespace 管理"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy import select

from db_loc_agent.db import ArtifactRecord, Database

# namespace 各段允许：字母数字、下划线、连字符、中文（中文此前被拒绝，导致
# "浙江营业库A" 这类对象名进不了 namespace，safe_object_name 又把中文删成只剩 "A"）
SEGMENT_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fff-]{1,128}$")


class NamespaceError(ValueError):
    pass


def make_namespace(conv_key: str, agent_id: str, object_name: str,
                   stamp: Optional[str] = None) -> str:
    for seg in (conv_key, agent_id, object_name):
        if not SEGMENT_RE.match(seg or ""):
            raise NamespaceError(f"非法 namespace 段: {seg!r}")
    stamp = stamp or datetime.now().strftime("%Y%m%dT%H%M%S")
    if not SEGMENT_RE.match(stamp):
        raise NamespaceError("非法时间戳")
    return f"{conv_key}/{agent_id}/{object_name}/{stamp}"


def safe_object_name(text: str, max_len: int = 128) -> str:
    # 保留中文/字母数字/下划线/连字符，其余替换为下划线；此前 [^A-Za-z0-9_-] 会把
    # "浙江营业库A" 里的中文全删成只剩 "A"，导致对象名/目录名退化成单字符垃圾名
    cleaned = re.sub(r"[^A-Za-z0-9_\u4e00-\u9fff-]+", "_", (text or "").strip()).strip("_")
    return (cleaned or "artifact")[:max_len]


# 提取失败/无意义时回退的默认对象名；以及应识别为"非对象名"的垃圾值（参数键名、占位词）
_DEFAULT_OBJECT_NAME = "artifact"
_JUNK_OBJECT_NAMES = {
    "artifact", "value", "confirm", "task_confirm",
    "source_data_id", "target_data_id", "source_db", "target_db",
    "source_db_type", "target_db_type", "datasource", "object_name",
}


def primary_object_name(text: str, max_len: int = 40) -> str:
    """从需求/对象清单中取主对象名（用于 namespace）：多对象取第一项、过长的截断。

    - text 为空 -> 默认名
    - 逗号/空格/换行分隔的清单 -> 取第一个 token 作为主对象名
    - 提取结果若为单字符、参数键名（snake_case）、或占位词 -> 回退默认名，
      避免产物目录出现 "A" / "task_confirm" 这类垃圾名
    - 截断到 max_len（默认 40）
    """
    if not text:
        return _DEFAULT_OBJECT_NAME
    first = re.split(r"[,，\s\n]+", text.strip(), maxsplit=1)[0]
    name = safe_object_name(first, max_len=max_len)
    if not name or name in _JUNK_OBJECT_NAMES or len(name) <= 1:
        return _DEFAULT_OBJECT_NAME
    return name


class ArtifactService:
    def __init__(self, db: Database, artifact_root: str):
        self.db = db
        self.root = Path(artifact_root)

    def _dir_for(self, namespace: str) -> Path:
        d = (self.root / namespace).resolve()
        if not str(d).startswith(str(self.root.resolve())):
            raise NamespaceError("namespace 越界")
        return d

    def write(self, namespace: str, conv_id: int, agent_id: str, object_name: str,
              files: Dict[str, str]) -> Dict:
        d = self._dir_for(namespace)
        d.mkdir(parents=True, exist_ok=True)
        # 归属解析：从会话反向读取 空间/子系统/任务
        space_id = sub_system_id = task_id = None
        if conv_id is not None:
            from db_loc_agent.db import Conversation
            with self.db.session() as s:
                conv = s.get(Conversation, conv_id)
                if conv:
                    space_id, sub_system_id, task_id = conv.space_id, conv.sub_system_id, conv.task_id
        records = []
        for fname, content in files.items():
            if "/" in fname or "\\" in fname or fname in ("", ".", ".."):
                raise NamespaceError(f"非法文件名: {fname}")
            fpath = d / fname
            fpath.write_text(content, encoding="utf-8")
            ftype = fpath.suffix.lstrip(".").lower() or "txt"
            with self.db.session() as s:
                rec = ArtifactRecord(namespace=namespace, conv_id=conv_id, agent_id=agent_id,
                                     object_name=object_name, file_type=ftype, path=str(fpath),
                                     space_id=space_id, sub_system_id=sub_system_id, task_id=task_id)
                s.add(rec)
                s.commit()
                s.refresh(rec)
                records.append(self._to_dict(rec))
        return {"namespace": namespace, "files": records}

    def list_namespaces(self, conv_id: Optional[int] = None) -> List[str]:
        with self.db.session() as s:
            q = select(ArtifactRecord.namespace).distinct()
            if conv_id is not None:
                q = q.where(ArtifactRecord.conv_id == conv_id)
            return sorted(set(s.scalars(q)))

    def list_files(self, namespace: str) -> List[Dict]:
        with self.db.session() as s:
            rows = list(s.scalars(select(ArtifactRecord).where(ArtifactRecord.namespace == namespace)))
            return [self._to_dict(r) for r in rows]

    def list_by_task(self, task_id: int) -> List[Dict]:
        with self.db.session() as s:
            rows = list(s.scalars(select(ArtifactRecord).where(ArtifactRecord.task_id == task_id)))
        return [self._to_dict(r) for r in rows]

    def read(self, record_id: int) -> Optional[str]:
        with self.db.session() as s:
            rec = s.get(ArtifactRecord, record_id)
            if not rec:
                return None
            p = Path(rec.path).resolve()
            if not str(p).startswith(str(self.root.resolve())):
                raise NamespaceError("产物路径越界")
            return p.read_text(encoding="utf-8")

    @staticmethod
    def _to_dict(r: ArtifactRecord) -> Dict:
        return {"id": r.id, "namespace": r.namespace, "conv_id": r.conv_id, "agent_id": r.agent_id,
                "object_name": r.object_name, "type": r.file_type, "path": r.path,
                "space_id": r.space_id, "sub_system_id": r.sub_system_id, "task_id": r.task_id,
                "kb_doc_id": r.kb_doc_id,
                "created_at": r.created_at.isoformat() if r.created_at else None}