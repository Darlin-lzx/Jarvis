"""知识图谱：从知识库文档提取实体与关系（规则式），检索时可做一跳图谱扩展，增强多跳问答"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from sqlalchemy import func, or_, select, text

from db_loc_agent.db import Database, DocumentRecord, KGEntity, KGRelation

# SQL 对象名（大写字母/数字/下划线，≥2 字符）
SQL_IDENT_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]{1,39}(?![A-Za-z0-9_])")
CREATE_TABLE_RE = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?",
                             re.IGNORECASE)
REFERENCES_RE = re.compile(r"REFERENCES\s+`?(\w+)`?\s*\(`?(\w+)`?\)", re.IGNORECASE)
# 中文关系句式：A 兼容/支持/等价于 B
CN_REL_RE = re.compile(
    r"([\u4e00-\u9fa5A-Za-z0-9_]{2,24}?)\s*(?:兼容|支持|等价于|对应|包含|基于|使用|提供)\s*"
    r"([\u4e00-\u9fa5A-Za-z0-9_]{2,24})")


def _clean(text: str) -> str:
    text = text.strip().strip('\'"` ')
    return (text or "").replace("\n", "").replace("…", "")


class KnowledgeGraph:
    """实体/关系存储与图谱扩展。

    - build_from_documents(): 从已入库 kb_documents 重建图谱（规则提取，不依赖 LLM）
    - expand(terms): 给定候选实体词，返回一跳内邻居三元组（供 RAG 注入）
    """

    def __init__(self, db: Database):
        self.db = db

    # ---------- 提取 ----------
    @staticmethod
    def _extract(text: str, source_type: str = "") -> tuple:
        """规则提取 (entities, relations)。entities: {name: type}；relations: (s, r, o) 列表"""
        entities: Dict[str, str] = {}
        relations: List[tuple] = []

        def add_rel(s: str, r: str, o: str) -> None:
            s, o = _clean(s), _clean(o)
            if len(s) < 2 or len(o) < 2 or s.lower() == o.lower():
                return
            r = (r or "related").strip()
            relations.append((s, r, o))
            entities.setdefault(s, "concept")
            entities.setdefault(o, "concept")

        # 1) SQL DDL：表 + 外键
        for m in CREATE_TABLE_RE.finditer(text):
            t = m.group(1)
            entities.setdefault(t, "table")
            # 该表定义块（从 CREATE TABLE 到分号/下一个 CREATE）
            seg = text[m.end():]
            seg = seg.split(";")[0]
            for rm in REFERENCES_RE.finditer(seg):
                ref_t = rm.group(1)
                add_rel(t, "REFERENCES", ref_t)
                entities.setdefault(ref_t, "table")
                entities.setdefault(rm.group(2), "column")
                add_rel(ref_t, "HAS_COLUMN", rm.group(2))
                add_rel(t, "HAS_COLUMN", rm.group(2))
        # 2) 中文关系句式（对文本块做，避免跨文档噪音）
        for m in CN_REL_RE.finditer(text):
            add_rel(m.group(1), "兼容", m.group(2))
        # 3) 兜底：明显的对象标识符
        if source_type == "sql":
            for ident in SQL_IDENT_RE.findall(text):
                entities.setdefault(ident, "object")
        return entities, relations

    def build_from_documents(self) -> Dict:
        """重建图谱：清空后从全部启用文档提取。返回统计。"""
        with self.db.session() as s:
            s.execute(text("DELETE FROM kg_relations"))
            s.execute(text("DELETE FROM kg_entities"))
            docs = list(s.scalars(select(DocumentRecord).where(DocumentRecord.enabled)))
            n_ent, n_rel = 0, 0
            for doc in docs:
                try:
                    content = doc.doc_path and __import__("pathlib").Path(doc.doc_path).read_text(encoding="utf-8") or ""
                except OSError:
                    continue
                ents, rels = self._extract(content, doc.source_type)
                doc_name = doc.name
                for name, etype in ents.items():
                    s.add(KGEntity(name=name, etype=etype, doc_name=doc_name))
                    n_ent += 1
                for sub, rel, obj in rels:
                    s.add(KGRelation(subject=sub, relation=rel, object=obj, doc_name=doc_name))
                    n_rel += 1
            s.commit()
            return {"entities": n_ent, "relations": n_rel}

    def overview(self) -> Dict:
        with self.db.session() as s:
            e = s.scalar(select(func.count()).select_from(KGEntity)) or 0
            r = s.scalar(select(func.count()).select_from(KGRelation)) or 0
            cols = s.execute(text("SELECT etype, COUNT(*) FROM kg_entities GROUP BY etype")).fetchall()
            rels = s.execute(text("SELECT relation, COUNT(*) FROM kg_relations GROUP BY relation "
                                  "ORDER BY COUNT(*) DESC LIMIT 12")).fetchall()
            return {"entities": e, "relations": r, "entity_types":
                    [{"type": row[0], "count": row[1]} for row in cols],
                    "top_relations": [{"relation": row[0], "count": row[1]} for row in rels]}

    def expand(self, terms: List[str], limit: int = 15) -> List[Dict]:
        """给定实体候选词，返回一跳邻居三元组（subject 或 object 命中）。"""
        if not terms:
            return []
        like = [f"%{t}%" for t in terms if t]
        if not like:
            return []
        cond = or_(*[KGRelation.subject.like(k) for k in like],
                   *[KGRelation.object.like(k) for k in like])
        with self.db.session() as s:
            rows = (s.execute(select(KGRelation).where(cond)
                              .order_by(KGRelation.id).limit(limit))).scalars().all()
            return [{"subject": r.subject, "relation": r.relation,
                     "object": r.object, "doc": r.doc_name} for r in rows]

    def match_entities(self, text: str, limit: int = 10) -> List[str]:
        """从一段文本中匹配已知实体名（子串命中），用于检索后候选扩展。"""
        with self.db.session() as s:
            rows = list(s.scalars(select(KGEntity.name).limit(2000)))
        hits = [n for n in rows if n and n.lower() in text.lower()]
        return sorted(hits, key=len, reverse=True)[:limit]