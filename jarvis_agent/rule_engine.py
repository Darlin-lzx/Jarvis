"""数据库迁移静态规则引擎：硬编码/配置化规则 + 词法扫描，识别 SQL/DDL 不兼容项。

「规则负责找问题，大模型负责解释问题、写方案」：
- 规则引擎用 JSON 规则做静态词法扫描，命中即打上结构化风险标签（高/中/低），结果可复现；
- 评估专家 Agent 接收扫描结果作为输入，只做业务层面解读与改造建议，不重复做基础语法识别。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

# 内置默认规则（可被 sys_dict category=migrate_rules 的 JSON 覆盖 / 追加）
DEFAULT_RULES: List[Dict[str, Any]] = [
    # ---- Oracle 特有语法 / 关键字 ----
    {"rule_id": "R001", "desc": "Oracle ROWNUM 分页伪列不兼容",
     "match_pattern": r"\bROWNUM\b", "risk": "高",
     "suggest": "改写为 FETCH FIRST ... ROWS ONLY 或 LIMIT 分页语法"},
    {"rule_id": "R002", "desc": "Oracle ROWID 伪列不兼容",
     "match_pattern": r"\bROWID\b", "risk": "高",
     "suggest": "ROWID 与物理存储强相关，去除该伪列依赖"},
    {"rule_id": "R003", "desc": "Oracle DUAL 虚拟表（多数国产库已兼容，需验证）",
     "match_pattern": r"\bFROM\s+DUAL\b", "risk": "低",
     "suggest": "国产库通常支持 DUAL，实施前在目标库执行 SELECT SYSDATE FROM DUAL 验证"},
    {"rule_id": "R004", "desc": "Oracle SYSDATE 函数不兼容",
     "match_pattern": r"\bSYSDATE\b", "risk": "中",
     "suggest": "替换为 NOW() / CURRENT_TIMESTAMP 或目标库当前时间函数"},
    {"rule_id": "R005", "desc": "Oracle NVL 空值函数不兼容",
     "match_pattern": r"\bNVL\s*\(", "risk": "中",
     "suggest": "替换为 COALESCE()"},
    {"rule_id": "R006", "desc": "Oracle DECODE 条件函数不兼容",
     "match_pattern": r"\bDECODE\s*\(", "risk": "高",
     "suggest": "改写为 CASE WHEN 表达式"},
    {"rule_id": "R007", "desc": "Oracle CONNECT BY 层次查询不兼容",
     "match_pattern": r"\bCONNECT\s+BY\b", "risk": "高",
     "suggest": "改写为 WITH RECURSIVE 递归 CTE"},
    {"rule_id": "R008", "desc": "Oracle START WITH 层次查询起点不兼容",
     "match_pattern": r"\bSTART\s+WITH\b", "risk": "高",
     "suggest": "与 CONNECT BY 一并改写为递归 CTE"},
    {"rule_id": "R009", "desc": "Oracle MINUS 集合差运算不兼容",
     "match_pattern": r"\bMINUS\b", "risk": "中",
     "suggest": "改写为 EXCEPT / NOT EXISTS"},
    {"rule_id": "R010", "desc": "Oracle (+) 外连接旧语法不兼容",
     "match_pattern": r"\(\s*\+?\s*\)\s*\*\s*|\*\)\s*\+?\s*\(\s*\+\s*\)", "risk": "高",
     "suggest": "改写为标准 LEFT/RIGHT JOIN ON 语法"},
    {"rule_id": "R011", "desc": "Oracle 序列 SEQUENCE 迁移风险",
     "match_pattern": r"(?i)\bCREATE\s+SEQUENCE\b|\w+\.NEXTVAL|\w+\.CURRVAL", "risk": "中",
     "suggest": "国产库序列语法不同，需按目标库序列定义迁移并核对自增取值"},
    {"rule_id": "R012", "desc": "Oracle 同义词 SYNONYM 不兼容",
     "match_pattern": r"(?i)\bCREATE\s+SYNONYM\b", "risk": "中",
     "suggest": "国产库多为视图/别名替代，评估后逐个转换"},
    {"rule_id": "R013", "desc": "Oracle 包 PACKAGE 不兼容",
     "match_pattern": r"(?i)\bCREATE\s+OR\s+REPLACE\s+PACKAGE\b", "risk": "高",
     "suggest": "包体需拆分为独立过程/函数，国产库不原生支持 PACKAGE"},
    {"rule_id": "R014", "desc": "Oracle MATERIALIZED VIEW 物化视图不兼容",
     "match_pattern": r"(?i)\bMATERIALIZED\s+VIEW\b", "risk": "中",
     "suggest": "改用目标库物化视图或定时刷新的普通视图/表"},
    # ---- MySQL 特有语法 ----
    {"rule_id": "R015", "desc": "MySQL AUTO_INCREMENT 自增关键字不兼容",
     "match_pattern": r"\bAUTO_INCREMENT\b", "risk": "中",
     "suggest": "替换为目标国产库自增语法（如达梦 IDENTITY / 人大金仓 SERIAL/IDENTITY）"},
    {"rule_id": "R016", "desc": "MySQL 反引号标识符不兼容",
     "match_pattern": r"`[^`]+`", "risk": "中",
     "suggest": "去除反引号或替换为目标库标识符引用符"},
    {"rule_id": "R017", "desc": "MySQL ENGINE=InnoDB 建表参数（部分国产库不兼容）",
     "match_pattern": r"(?i)\bENGINE\s*=\s*\w+", "risk": "低",
     "suggest": "删除 ENGINE 子句，国产库默认存储引擎"},
    {"rule_id": "R018", "desc": "MySQL 字段类型/默认值差异（unsigned/zerofill 等）",
     "match_pattern": r"(?i)\bUNSIGNED\b|\bZEROFILL\b|\bCURRENT_TIMESTAMP\s+ON\s+UPDATE\b",
     "risk": "中", "suggest": "核对目标库对应数据类型与默认值迁移规则"},
    # ---- 通用类型/语法差异 ----
    {"rule_id": "R019", "desc": "VARCHAR2 类型（Oracle 特有）",
     "match_pattern": r"(?i)\bVARCHAR2\s*\(", "risk": "高",
     "suggest": "按字符/字节语义转换为目标库 VARCHAR 并核对长度单位"},
    {"rule_id": "R020", "desc": "NUMBER 精度默认（Oracle number 未带精度）",
     "match_pattern": r"(?i)\bNUMBER\b(?!\s*\()", "risk": "中",
     "suggest": "明确 NUMERIC/INT 精度，避免隐式大数类型转换为 NUMERIC(38)"},
    {"rule_id": "R021", "desc": "CLOB/BLOB 大对象字段迁移",
     "match_pattern": r"(?i)\bCLOB\b|\bBLOB\b", "risk": "中",
     "suggest": "国产库大对象类型（如 TEXT/BYTEA）功能差异大，需逐个核对读写方式"},
    {"rule_id": "R022", "desc": "存储过程/函数 OUT 参数（PL/SQL 特有）",
     "match_pattern": r"(?i)\bOUT\s+(?:NOCOPY\s+)?(?:VARCHAR2|VARCHAR|NUMBER|DATE)\b", "risk": "中",
     "suggest": "核对目标库过程语言参数模式（PROCEDURE/FUNCTION 语法差异）"},
    {"rule_id": "R023", "desc": "异常处理 EXCEPTION WHEN 块（PL/SQL 特有）",
     "match_pattern": r"(?i)\bEXCEPTION\s+WHEN\b", "risk": "中",
     "suggest": "改写为目标库异常处理语法并核对异常类型名"},
    {"rule_id": "R024", "desc": "游标声明 CURSOR ... IS（PL/SQL 特有）",
     "match_pattern": r"(?i)\bCURSOR\s+\w+\s+IS\b", "risk": "中",
     "suggest": "改写为目标库游标定义语法"},
    {"rule_id": "R025", "desc": "FOR UPDATE 行锁（部分国产库不兼容）",
     "match_pattern": r"\bFOR\s+UPDATE\b", "risk": "低",
     "suggest": "验证目标库行锁语义并核对事务隔离级别"},
    {"rule_id": "R026", "desc": "TRUNCATE 使用（部分库要求 DELETE）",
     "match_pattern": r"(?i)\bTRUNCATE\s+TABLE\b", "risk": "低",
     "suggest": "国产库一般支持 TRUNCATE，实施前验证权限与回滚语义差异"},
    {"rule_id": "R027", "desc": "分区表 PARTITION BY（各库语法差异大）",
     "match_pattern": r"(?i)\bPARTITION\s+BY\b", "risk": "高",
     "suggest": "按目标库分区语法重写，核对分区键与分区策略"},
    {"rule_id": "R028", "desc": "触发器中 NEW/OLD 伪记录",
     "match_pattern": r"\b:NEW\b|\b:OLD\b", "risk": "中",
     "suggest": "改写为目标库触发器伪记录引用语法（通常去除冒号或写 NEW/OLD）"},
]

# 高风险命中片段长度上限（防止打点覆盖整条 SQL）
_SNIPPET_LEN = 120


def _strip_sql_comments(text: str) -> str:
    """简单去除行注释/块注释，避免注释内容命中关键字（保留字符串内命中）。"""
    t = re.sub(r"--[^\n]*", " ", text)
    t = re.sub(r"/\*.*?\*/", " ", t, flags=re.DOTALL)
    return t


class RuleEngine:
    """静态规则引擎：加载规则（内置 + sys_dict 覆盖追加），对 SQL/DDL 做词法扫描。"""

    def __init__(self, sys_dict_service: Any = None):
        self._sys_dict = sys_dict_service
        self._rules = self._compile(self._load_rules())

    # ---------- 规则加载 ----------

    def _load_rules(self) -> List[Dict[str, Any]]:
        rules = json.loads(json.dumps(DEFAULT_RULES))
        if self._sys_dict is not None:
            try:
                custom = self._sys_dict.value("migrate_rules", "rules")
                if custom and custom.strip():
                    extra = json.loads(custom)
                    if isinstance(extra, list):
                        rules.extend(extra)
            except Exception:
                pass  # 自定义规则格式错误时忽略，仅用内置规则
        return rules

    def _compile(self, rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        compiled = []
        for r in rules:
            pat = r.get("match_pattern") or r.get("match_keyword", "")
            try:
                compiled.append({**r, "_re": re.compile(pat, re.IGNORECASE)})
            except re.error:
                continue  # 非法正则跳过
        return compiled

    def rules(self) -> List[Dict[str, Any]]:
        """返回规则清单（去除编译对象，可 JSON 序列化）。"""
        return [{k: v for k, v in r.items() if not k.startswith("_")} for r in self._rules]

    def save_rules(self, rules: List[Dict[str, Any]]) -> None:
        """把规则全集（内置+自定义的合并结果）持久化到 sys_dict（覆盖存储）。"""
        from sqlalchemy import select as sa_select
        from jarvis_agent.db import SysDict
        if self._sys_dict is None:
            raise ValueError("未启用 DB，无法持久化规则")
        db = getattr(self._sys_dict, "db", None)
        if db is None:
            raise ValueError("sys_dict 服务缺少 db 引用")
        with db.session() as s:
            row = s.scalar(sa_select(SysDict).where(
                SysDict.category == "migrate_rules", SysDict.dict_key == "rules"))
            if row is None:
                row = SysDict(category="migrate_rules", dict_key="rules",
                              description="数据库迁移静态规则库（JSON）")
                s.add(row)
            row.dict_value = json.dumps(rules, ensure_ascii=False)
            s.commit()
        self._rules = self._compile(self._load_rules())

    # ---------- 词法扫描 ----------

    def scan(self, sql_text: str, object_name: str = "",
             asset_type: str = "table") -> Dict[str, Any]:
        """扫描单条/整段 SQL/DDL，返回结构化扫描结果。

        结果：{object_name, asset_type, findings: [{rule_id, desc, risk, suggest, snippet}],
               summary: {high, medium, low}, hit_rules: [rule_id...]}
        """
        text = sql_text or ""
        findings: List[Dict[str, Any]] = []
        seen: set = set()
        for r in self._rules:
            m = r["_re"].search(text)
            if m:
                if r["rule_id"] in seen:
                    continue
                seen.add(r["rule_id"])
                start = max(0, m.start() - 24)
                end = min(len(text), m.end() + 24)
                snippet = text[start:end].strip()
                if len(snippet) > _SNIPPET_LEN:
                    snippet = snippet[:_SNIPPET_LEN]
                findings.append({
                    "rule_id": r["rule_id"],
                    "desc": r.get("desc", ""),
                    "risk": r.get("risk", "中"),
                    "suggest": r.get("suggest", ""),
                    "snippet": snippet,
                })
        summary = {"high": 0, "medium": 0, "low": 0}
        for f in findings:
            key = f["risk"]
            summary[key] = summary.get(key, 0) + 1
        return {
            "object_name": object_name or "",
            "asset_type": asset_type,
            "findings": findings,
            "summary": summary,
            "hit_rules": list(seen),
        }

    def scan_many(self, objects: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """批量扫描对象清单：[{asset_type, asset_name, original_sql}] → 结构化资产输入。"""
        return [self.scan(obj.get("original_sql", ""),
                          obj.get("asset_name", ""), obj.get("asset_type", "table"))
                for obj in objects]

    # ---------- 关键词混合检索（方向4 规则库检索辅助） ----------

    def keyword_match(self, query: str, docs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """在给定分块列表中做规则关键词命中排序（与向量检索互补，保证可复现）。"""
        tokens = [t for t in re.split(r"[\s,，。；;：:()]+", query or "") if len(t) >= 2]
        scored = []
        for d in docs:
            content = (d.get("content") or "").lower()
            hit = sum(1 for t in tokens if t.lower() in content)
            if hit:
                d = dict(d)
                d["kw_score"] = hit
                scored.append(d)
        return sorted(scored, key=lambda x: -x["kw_score"])


def scan_sql(sql_text: str) -> List[Dict[str, Any]]:
    """便捷函数：单次扫描返回 findings 列表（无对象归属的纯 SQL 扫描）。"""
    return RuleEngine().scan(sql_text).get("findings", [])