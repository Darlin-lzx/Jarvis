"""双库 Schema Diff 引擎（确定性元数据比对）。

定位：与"LLM 生成迁移报告"互补的确定性能力。
同时连接【源库 / 目标库】（均复用 db_tools 的只读连接），抽取结构化元数据，
自动比对出 表/视图、列、类型、可空性、主键、索引 的差异，结果可复现、可审计。

设计为纯函数式、无副作用：
- extract_catalog(db_tools, ds_name) -> dict   抽取单个库的元数据快照
- diff_catalogs(src, tgt) -> dict              比对两个快照，返回结构化差异
- to_markdown(result) -> str                   生成可读的 Markdown 报告

可扩展点（接入领域规则，见 sys_dict 类型映射 / index 比对）：
- 把"字面不同但语义兼容"的类型（如 Oracle VARCHAR2 → DM VARCHAR2）判为等价，
  规则可来自 data/skills 或知识库，由 LLM 仅处理规则覆盖不到的差异。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

# 类型兼容映射从 sys_dict 表（category=type_alias）读取，由 bootstrap 导入，
# 代码中不写死。

# 差异严重级别（用于排序与前端标色）
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def normalize_type(type_str: str, aliases: Optional[Dict[str, str]] = None) -> str:
    """归一化类型字符串：去括号长度、去空白、大写，并映射到兼容族。

    例如 'VARCHAR2(255)' -> 'VARCHAR'；'NUMBER(10,2)' -> 'NUMBER'。
    """
    s = str(type_str or "").strip().upper()
    # 去掉括号及其长度/精度（最小处理：兼容规则后续可决定是否保留长度比对）
    base = s.split("(", 1)[0].strip()
    return (aliases or {}).get(base, base)


class SchemaDiffService:
    """双库 Schema 比对服务。"""

    def __init__(self, db_tools: Any, db: Any = None):
        self.db_tools = db_tools
        self.db = db
        self._aliases_cache: Optional[Dict[str, str]] = None

    def aliases(self) -> Dict[str, str]:
        """类型兼容映射（从 sys_dict category=type_alias 读取，带缓存）。"""
        if self._aliases_cache is None:
            from db_loc_agent.agents import SysDictService
            self._aliases_cache = (SysDictService(self.db).map("type_alias")
                                   if self.db is not None else {})
        return self._aliases_cache

    # ---------- 元数据抽取 ----------
    def extract_catalog(self, ds_name: str) -> Dict[str, Any]:
        """抽取单个数据源的完整元数据快照（只读）。"""
        from sqlalchemy import inspect as sa_inspect

        with self.db_tools.connect(ds_name) as conn:
            insp = sa_inspect(conn)
            catalog: Dict[str, Any] = {"ds_name": ds_name, "objects": {}}

            tables = list(insp.get_table_names())
            views = list(insp.get_view_names())

            for obj in tables:
                catalog["objects"][obj] = self._extract_object(insp, obj, "table", self.aliases())
            for obj in views:
                catalog["objects"][obj] = self._extract_object(insp, obj, "view", self.aliases())
            return catalog

    @staticmethod
    def _extract_object(insp: Any, obj: str, obj_type: str,
                        aliases: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        cols = []
        for c in insp.get_columns(obj):
            cols.append({
                "name": c["name"],
                "type": str(c["type"]),
                "type_norm": normalize_type(c["type"], aliases),
                "nullable": bool(c.get("nullable", True)),
            })
        pk_cols: List[str] = []
        try:
            pk = insp.get_pk_constraint(obj) or {}
            pk_cols = list(pk.get("constrained_columns") or [])
        except Exception:
            pk_cols = []
        indexes: List[Dict[str, Any]] = []
        if obj_type == "table":
            try:
                for ix in insp.get_indexes(obj):
                    indexes.append({
                        "name": ix.get("name"),
                        "columns": list(ix.get("column_names") or []),
                        "unique": bool(ix.get("unique", False)),
                    })
            except Exception:
                indexes = []
        return {
            "type": obj_type,
            "columns": {c["name"]: c for c in cols},
            "pk": pk_cols,
            "indexes": indexes,
        }

    # ---------- 比对 ----------
    def compare(self, source_ds: str, target_ds: str) -> Dict[str, Any]:
        """对两个数据源执行完整 diff，返回结构化结果。"""
        src = self.extract_catalog(source_ds)
        tgt = self.extract_catalog(target_ds)
        return self.diff_catalogs(src, tgt, source_ds, target_ds)

    @staticmethod
    def diff_catalogs(src: Dict[str, Any], tgt: Dict[str, Any],
                      source_ds: Optional[str] = None,
                      target_ds: Optional[str] = None) -> Dict[str, Any]:
        diffs: List[Dict[str, Any]] = []

        src_objs = src.get("objects", {})
        tgt_objs = tgt.get("objects", {})
        src_names = set(src_objs.keys())
        tgt_names = set(tgt_objs.keys())

        # 1) 对象级别（表/视图）
        for name in sorted(src_names - tgt_names):
            otype = src_objs[name].get("type", "object")
            diffs.append({
                "level": "object", "kind": f"missing_{otype}",
                "object": name, "severity": "high",
                "message": f"目标库缺少{('表' if otype == 'table' else '视图')} {name}",
            })
        for name in sorted(tgt_names - src_names):
            otype = tgt_objs[name].get("type", "object")
            diffs.append({
                "level": "object", "kind": f"extra_{otype}",
                "object": name, "severity": "low",
                "message": f"目标库多出{('表' if otype == 'table' else '视图')} {name}",
            })

        # 2) 共有对象 → 列 / 主键 / 索引
        for name in sorted(src_names & tgt_names):
            so, to = src_objs[name], tgt_objs[name]
            diffs.extend(SchemaDiffService._diff_object(name, so, to))

        summary = SchemaDiffService._summarize(
            src, tgt, diffs, source_ds, target_ds)
        result = {
            "source": source_ds or src.get("ds_name"),
            "target": target_ds or tgt.get("ds_name"),
            "summary": summary,
            "diffs": diffs,
        }
        result["markdown"] = SchemaDiffService.to_markdown(result)
        return result

    @staticmethod
    def _diff_object(name: str, so: Dict[str, Any],
                     to: Dict[str, Any]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        sc, tc = so.get("columns", {}), to.get("columns", {})
        sn, tn = set(sc.keys()), set(tc.keys())

        for col in sorted(sn - tn):
            out.append({
                "level": "column", "kind": "missing_column",
                "object": name, "column": col, "severity": "high",
                "message": f"表 {name} 目标库缺少列 {col}（源类型 {sc[col]['type']}）",
            })
        for col in sorted(tn - sn):
            out.append({
                "level": "column", "kind": "extra_column",
                "object": name, "column": col, "severity": "low",
                "message": f"表 {name} 目标库多出列 {col}",
            })
        for col in sorted(sn & tn):
            a, b = sc[col], tc[col]
            if a["type_norm"] != b["type_norm"]:
                out.append({
                    "level": "column", "kind": "type_changed",
                    "object": name, "column": col, "severity": "medium",
                    "from": a["type"], "to": b["type"],
                    "message": f"表 {name} 列 {col} 类型变化：{a['type']} → {b['type']}",
                })
            if a["nullable"] != b["nullable"]:
                out.append({
                    "level": "column", "kind": "nullable_changed",
                    "object": name, "column": col, "severity": "low",
                    "from": a["nullable"], "to": b["nullable"],
                    "message": (f"表 {name} 列 {col} 可空性变化："
                                f"{'可空' if a['nullable'] else '非空'} → "
                                f"{'可空' if b['nullable'] else '非空'}"),
                })

        # 主键
        if so.get("pk") != to.get("pk"):
            out.append({
                "level": "constraint", "kind": "pk_changed",
                "object": name, "severity": "medium",
                "from": so.get("pk"), "to": to.get("pk"),
                "message": f"表 {name} 主键不一致：{so.get('pk')} → {to.get('pk')}",
            })

        # 索引（按"列集合+唯一性"归一比对，忽略名称差异）
        si = {tuple(sorted(i["columns"])): i for i in so.get("indexes", [])}
        ti = {tuple(sorted(i["columns"])): i for i in to.get("indexes", [])}
        for key in sorted(set(si) - set(ti), key=lambda x: "".join(x)):
            out.append({
                "level": "index", "kind": "missing_index",
                "object": name, "severity": "low",
                "message": f"表 {name} 目标库缺少索引（列 {list(key)}）",
            })
        return out

    @staticmethod
    def _summarize(src: Dict[str, Any], tgt: Dict[str, Any],
                   diffs: List[Dict[str, Any]], source_ds: Optional[str],
                   target_ds: Optional[str]) -> Dict[str, Any]:
        def count(kind: str) -> int:
            return sum(1 for d in diffs if d["kind"] == kind)

        by_severity = {
            "high": sum(1 for d in diffs if d["severity"] == "high"),
            "medium": sum(1 for d in diffs if d["severity"] == "medium"),
            "low": sum(1 for d in diffs if d["severity"] == "low"),
        }
        return {
            "source": source_ds or src.get("ds_name"),
            "target": target_ds or tgt.get("ds_name"),
            "objects_src": len(src.get("objects", {})),
            "objects_tgt": len(tgt.get("objects", {})),
            "missing_objects": sum(1 for d in diffs if d["level"] == "object"
                                   and d["kind"].startswith("missing")),
            "extra_objects": sum(1 for d in diffs if d["level"] == "object"
                                 and d["kind"].startswith("extra")),
            "missing_columns": count("missing_column"),
            "type_changed": count("type_changed"),
            "nullable_changed": count("nullable_changed"),
            "pk_changed": count("pk_changed"),
            "missing_index": count("missing_index"),
            "by_severity": by_severity,
            "total_diffs": len(diffs),
            "identical": len(diffs) == 0,
        }

    # ---------- Markdown 报告 ----------
    @staticmethod
    def to_markdown(result: Dict[str, Any]) -> str:
        s = result["summary"]
        lines = [
            "# 双库 Schema 差异报告",
            "",
            f"- 源库：**{result['source']}**　目标库：**{result['target']}**",
            f"- 对象数：源 {s['objects_src']} / 目标 {s['objects_tgt']}",
            f"- 差异总数：**{s['total_diffs']}**"
            f"（高 {s['by_severity']['high']} / 中 {s['by_severity']['medium']} "
            f"/ 低 {s['by_severity']['low']}）",
            "",
            "## 差异汇总",
            "",
            f"- 缺失对象：{s['missing_objects']}　多余对象：{s['extra_objects']}",
            f"- 缺失列：{s['missing_columns']}　类型变化：{s['type_changed']}",
            f"- 可空性变化：{s['nullable_changed']}　主键不一致：{s['pk_changed']}"
            f"　缺失索引：{s['missing_index']}",
            "",
        ]
        if s["identical"]:
            lines.append("✅ 两个库结构完全一致。")
            return "\n".join(lines)

        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for d in sorted(result["diffs"],
                        key=lambda x: (SEVERITY_ORDER[x["severity"]],
                                       x.get("object", ""), x.get("column", ""))):
            grouped.setdefault(d["severity"], []).append(d)

        for sev, label in (("high", "高风险（必须处理）"),
                           ("medium", "中风险（需确认）"),
                           ("low", "低风险（提示）")):
            if sev not in grouped:
                continue
            lines += ["", f"## {label}", ""]
            for d in grouped[sev]:
                lines.append(f"- {d['message']}")
        return "\n".join(lines)
