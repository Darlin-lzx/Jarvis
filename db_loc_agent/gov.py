"""多数据库统一管理与数据治理（第三级）：元数据资产目录 + 数据质量评分。

- catalog(): 抽取已启用数据源的元数据快照（表/视图 + 列定义 + 行数 + 主键），落库 gov_assets
- quality(): 对表做质量评分（非空率/唯一性/空值率），落库 gov_quality
- kg_sync(): 将表/列实体与 HAS_COLUMN 关系同步进知识图谱（KGEntity/KGRelation）
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from sqlalchemy import select, text

from db_loc_agent.db import (Database, GovAsset, GovQuality, KGEntity,
                             KGRelation)
from db_loc_agent.kg import KnowledgeGraph


def _quote_ident(name: str) -> str:
    """SQLite 支持的标识符引用（表名/列名来自元数据，_quote 防止特殊字符直拼 SQL）。"""
    return '"' + str(name).replace('"', '""') + '"'


class GovService:
    """数据资产目录与质量治理服务。"""

    def __init__(self, db: Database, db_tools: Any,
                 kg: Optional[KnowledgeGraph] = None):
        self.db = db
        self.db_tools = db_tools
        self.kg = kg

    # ---------- 资产目录 ----------
    def catalog(self, ds_name: str = "") -> Dict:
        """抽取（指定或全部启用）数据源的元数据目录。逐对象落库 gov_assets

        出于只读与安全边界：仅 SQLite 统计行数（COUNT(*)，行数过大时截断显示）；
        其余方言仅记录列定义与主键，不执行行统计。
        """
        targets = ([d for d in self.db_tools.list() if not ds_name or d["name"] == ds_name]
                   if self.db_tools is not None else [])
        if not targets:
            return {"success": True, "data": {"assets": [], "message": "无可抽取的数据源"}}
        added: List[Dict] = []
        with self.db.session() as s:
            for ds in targets:
                insp = self.db_tools.inspect_schema(ds["name"])
                if not insp.get("ok"):
                    continue
                for tbl in insp.get("tables", []):
                    try:
                        cols = self.db_tools.inspect_schema(ds["name"], tbl)
                    except Exception:
                        continue
                    col_defs = cols.get("columns", []) if cols.get("ok") else []
                    pk = ",".join(c["name"] for c in col_defs if c.get("pk"))
                    row_count = 0
                    if ds["kind"] == "sqlite":  # 只读行统计（仅本地 sqlite，避免网络库长时间查询）
                        try:
                            with self.db_tools.connect(ds["name"]) as conn:
                                rr = conn.execute(text(
                                    f"SELECT COUNT(*) FROM {_quote_ident(tbl)}"))
                                row_count = min(int(rr.scalar() or 0), 999999)
                        except Exception:
                            row_count = -1  # 统计失败
                    s.add(GovAsset(ds_name=ds["name"], object_name=tbl, obj_type="table",
                                   columns=json.dumps(col_defs, ensure_ascii=False),
                                   row_count=row_count, pk=pk))
                    added.append({"ds": ds["name"], "object": tbl, "obj_type": "table",
                                  "columns": len(col_defs), "row_count": row_count,
                                  "pk": pk})
                for v in insp.get("views", []):
                    s.add(GovAsset(ds_name=ds["name"], object_name=v, obj_type="view",
                                   columns="[]", row_count=0, pk=""))
                    added.append({"ds": ds["name"], "object": v, "obj_type": "view",
                                  "columns": 0, "row_count": 0, "pk": ""})
            s.commit()
        return {"success": True, "data": {"assets": added,
                                          "message": f"资产目录抽取完成，共 {len(added)} 个对象"}}

    def assets(self, ds_name: str = "") -> List[Dict]:
        with self.db.session() as s:
            q = select(GovAsset).order_by(GovAsset.id.desc())
            if ds_name:
                q = q.where(GovAsset.ds_name == ds_name)
            rows = list(s.scalars(q.limit(300)))
            return [{"id": r.id, "ds": r.ds_name, "object": r.object_name,
                     "obj_type": r.obj_type, "row_count": r.row_count, "pk": r.pk,
                     "columns": json.loads(r.columns or "[]"),
                     "created_at": r.created_at.isoformat() if r.created_at else None}
                    for r in rows]

    # ---------- 质量评分 ----------
    def quality(self, ds_name: str = "") -> Dict:
        """对目录中 sqlite 数据源的表做质量评分：

        - filled_rate: 关键列平均非空率（取前 3 列）
        - unique_rate: 主键去重率；无主键时用首列去重率粗估
        - null_rate:   空值最多列的空值比例
        - issues:      空值/重复行等提示
        """
        from db_loc_agent.db import OpsCheck  # noqa: F401  (确保表已建)
        with self.db.session() as s:
            q = select(GovAsset).order_by(GovAsset.id.asc())
            if ds_name:
                q = q.where(GovAsset.ds_name == ds_name)
            targets = [r for r in s.scalars(q) if r.obj_type == "table"]
        scored: List[Dict] = []
        with self.db.session() as s2:
            for a in targets:
                try:
                    col_defs = json.loads(a.columns or "[]")
                except json.JSONDecodeError:
                    col_defs = []
                total = len(col_defs)
                pk_col = (a.pk or "").split(",")[0] if a.pk else (
                    col_defs[0]["name"] if col_defs else "")
                issues: List[str] = []
                filled, nulls = 0, 0
                try:
                        with self.db_tools.connect(a.ds_name) as conn:
                            cnt = min(int(conn.execute(text(
                                f"SELECT COUNT(*) FROM {_quote_ident(a.object_name)}")).scalar() or 0),
                                999999)
                            # 平均非空率 + 最空列空值率（前 3 列统计，避免大表全列扫描）
                            sample_cols = col_defs[:3]
                            if sample_cols:
                                nonnulls = []
                                for c in sample_cols:
                                    nn = conn.execute(text(
                                        f"SELECT COUNT({_quote_ident(c['name'])}) FROM "
                                        f"{_quote_ident(a.object_name)}")).scalar() or 0
                                    nonnulls.append(int(nn))
                                filled = int(sum(nonnulls) / len(nonnulls))
                                filled_rate = int(filled * 100 / cnt) if cnt else 100
                                null_rate = int((cnt - min(nonnulls)) * 100 / cnt) if cnt else 0
                            else:
                                filled_rate, null_rate = 100, 0
                        # 唯一性
                        if pk_col:
                            du = conn.execute(text(
                                f"SELECT COUNT(DISTINCT {_quote_ident(pk_col)}) FROM "
                                f"{_quote_ident(a.object_name)}")).scalar() or 0
                            unique_rate = int(du * 100 / cnt) if cnt else 100
                        else:
                            unique_rate = 100
                        # 问题
                        if null_rate > 5:
                            issues.append(f"存在空值列（最高 {null_rate}%）")
                        if unique_rate < 100 and pk_col:
                            issues.append("存在重复主键/首列值")
                        if cnt == -1 or cnt >= 999999:
                            issues.append("行数超上限未完整统计")
                        score = int(0.5 * filled_rate + 0.3 * unique_rate
                                    + 0.2 * (100 - null_rate))
                        s2.add(GovQuality(ds_name=a.ds_name, object_name=a.object_name,
                                          row_count=cnt, filled_rate=filled_rate,
                                          unique_rate=unique_rate, null_rate=null_rate,
                                          score=score, issues=json.dumps(issues, ensure_ascii=False)))
                        scored.append({"ds": a.ds_name, "object": a.object_name,
                                       "row_count": cnt, "filled_rate": filled_rate,
                                       "unique_rate": unique_rate, "null_rate": null_rate,
                                       "score": score, "issues": issues})
                except Exception as e:
                    scored.append({"ds": a.ds_name, "object": a.object_name,
                                   "row_count": 0, "filled_rate": 0, "unique_rate": 0,
                                   "null_rate": 0, "score": 0,
                                   "issues": [f"评估失败: {str(e)[:120]}"]})
            s2.commit()
        return {"success": True, "data": {"scored": scored,
                                          "message": f"质量评分完成，共评估 {len(scored)} 张表"}}

    def quality_rows(self, ds_name: str = "") -> List[Dict]:
        with self.db.session() as s:
            q = select(GovQuality).order_by(GovQuality.id.desc())
            if ds_name:
                q = q.where(GovQuality.ds_name == ds_name)
            rows = list(s.scalars(q.limit(300)))
            return [{"id": r.id, "ds": r.ds_name, "object": r.object_name,
                     "row_count": r.row_count, "filled_rate": r.filled_rate,
                     "unique_rate": r.unique_rate, "null_rate": r.null_rate,
                     "score": r.score,
                     "issues": json.loads(r.issues or "[]"),
                     "created_at": r.created_at.isoformat() if r.created_at else None}
                    for r in rows]

    # ---------- 图谱同步 ----------
    def kg_sync(self) -> Dict:
        """把治理资产目录中的表/列同步为知识图谱实体与 HAS_COLUMN 关系。"""
        if self.kg is None:
            return {"success": True, "data": {"entities": 0, "relations": 0,
                                              "message": "知识图谱未启用"}}
        with self.db.session() as s:
            assets = list(s.scalars(select(GovAsset).order_by(GovAsset.id)))
            n_ent = n_rel = 0
            for a in assets:
                ent = s.scalar(select(KGEntity).where(
                    KGEntity.name == a.object_name, KGEntity.doc_name == f"ds:{a.ds_name}"))
                if ent is None:
                    s.add(KGEntity(name=a.object_name,
                                   etype="table" if a.obj_type == "table" else "object",
                                   doc_name=f"ds:{a.ds_name}"))
                    n_ent += 1
                rel = s.scalar(select(KGRelation).where(
                    KGRelation.subject == a.ds_name, KGRelation.object == a.object_name))
                if rel is None and a.obj_type == "table":
                    s.add(KGRelation(subject=a.ds_name, relation="HAS_OBJECT",
                                     object=a.object_name, doc_name=f"ds:{a.ds_name}"))
                    n_rel += 1
                if a.obj_type == "table":
                    try:
                        for c in json.loads(a.columns or "[]"):
                            en = s.scalar(select(KGEntity).where(
                                KGEntity.name == c.get("name", ""),
                                KGEntity.doc_name == f"ds:{a.ds_name}"))
                            if en is None:
                                s.add(KGEntity(name=c.get("name", ""), etype="column",
                                               doc_name=f"ds:{a.ds_name}"))
                                n_ent += 1
                            cr = s.scalar(select(KGRelation).where(
                                KGRelation.subject == a.object_name,
                                KGRelation.relation == "HAS_COLUMN",
                                KGRelation.object == c.get("name", "")))
                            if cr is None:
                                s.add(KGRelation(subject=a.object_name,
                                                 relation="HAS_COLUMN",
                                                 object=c.get("name", ""),
                                                 doc_name=f"ds:{a.ds_name}"))
                                n_rel += 1
                    except (json.JSONDecodeError, TypeError):
                        pass
            s.commit()
        return {"success": True, "data": {"entities": n_ent, "relations": n_rel,
                                          "message": f"图谱同步完成：+{n_ent} 实体 / +{n_rel} 关系"}}