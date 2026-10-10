"""数据库只读工具集：数据源配置 CRUD + schema 探查 + 只读查询/语法校验。

安全边界：
- 查询仅允许 SELECT/WITH/EXPLAIN，禁止 DDL/DML（INSERT/UPDATE/DELETE/DROP/ALTER/CREATE...）
- 仅允许 SELECT 语句（可带 LIMIT 上限，默认 100 行）
- 所有调用走只读模式（SQLite URI mode=ro；其他库内层事务回滚）
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text

from db_loc_agent.db import DataSource, Database

# SELECT / WITH 开头；禁止分号后跟其他语句
_SELECT_RE = re.compile(
    r"^\s*(SELECT|WITH)\b.*$", re.IGNORECASE | re.DOTALL)
_BLOCKED_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE",
    "TRUNCATE", "GRANT", "REVOKE", "MERGE", "REPLACE", "ATTACH", "DETACH", "VACUUM")

QUERY_ROW_LIMIT = 100   # 单次查询最大返回行数
QUERY_CELL_LIMIT = 500  # 单格最大展示字符


class DbTools:
    """数据源管理 + 只读查询工具。"""

    DIALECTS = ("sqlite", "mysql", "postgresql", "oracle", "dm", "kingbase", "gaussdb",
                "excel")

    def __init__(self, db: Optional[Database] = None, audit: Optional[Any] = None,
                 obs_query: Optional[Callable[[str, str, int], None]] = None,
                 circuit_breaker: Optional[Any] = None):
        self.db = db
        self.audit = audit  # 可选审计回调: audit(kind, name, sql_or_notes)
        self.obs_query = obs_query  # 可选观测回调: obs_query(ds_name, sql, latency_ms) 用于慢查询/性能基线
        self.circuit_breaker = circuit_breaker

    # ---------- 配置 CRUD ----------
    def list(self, space_id: Optional[int] = None,
             sub_system_id: Optional[int] = None) -> List[Dict]:
        if self.db is None:
            return []
        from sqlalchemy import select
        with self.db.session() as s:
            q = select(DataSource)
            if space_id:
                q = q.where(DataSource.space_id == space_id)
            if sub_system_id:
                q = q.where(DataSource.sub_system_id == sub_system_id)
            rows = list(s.scalars(q.order_by(DataSource.id)))
            return [{"id": r.id, "name": r.name, "kind": r.kind, "location": r.location,
                     "username": r.username, "enabled": r.enabled,
                     "space_id": r.space_id, "sub_system_id": r.sub_system_id} for r in rows]

    def get(self, name: str) -> Optional[Dict]:
        return next((d for d in self.list() if d["name"] == name), None)

    def create(self, name: str, kind: str = "sqlite", location: str = "",
               username: str = "", password: str = "", dsn: str = "",
               enabled: bool = True,
               space_id: Optional[int] = None,
               sub_system_id: Optional[int] = None) -> Dict:
        if not name or not name.strip():
            raise ValueError("数据源名称不能为空")
        if kind not in self.DIALECTS:
            raise ValueError(f"不支持的数据库类型: {kind}（可选: {', '.join(self.DIALECTS)}）")
        if self.db is None:
            raise ValueError("未启用 DB")
        data = {"kind": kind, "location": location or "", "username": username or "",
                "password": password or "", "dsn": dsn or "", "enabled": bool(enabled),
                "space_id": space_id, "sub_system_id": sub_system_id}
        with self.db.session() as s:
            from sqlalchemy import select
            row = s.scalar(select(DataSource).where(DataSource.name == name))
            if row is None:
                row = DataSource(name=name)
                s.add(row)
            for k, v in data.items():
                setattr(row, k, v)
            s.commit()
            s.refresh(row)
        out = self.get(name) or {"name": name}
        out.update(data)
        return out

    def set_enabled(self, name: str, enabled: bool) -> None:
        if self.db is None:
            raise ValueError("未启用 DB")
        from sqlalchemy import select
        with self.db.session() as s:
            row = s.scalar(select(DataSource).where(DataSource.name == name))
            if row is None:
                raise ValueError(f"数据源不存在: {name}")
            row.enabled = bool(enabled)
            s.commit()

    def update(self, old_name: str, new_name: str, kind: str = "sqlite",
               location: str = "", username: str = "", password: str = "",
               dsn: str = "", enabled: bool = True,
               space_id: Optional[int] = None,
               sub_system_id: Optional[int] = None) -> Dict:
        """更新数据源配置，支持改名（old_name 为现有名称，new_name 为更新后名称）。

        - 新名称与旧名称不同且已被其他数据源占用时抛 ValueError（name 唯一约束）；
        - space_id / sub_system_id 仅在传入非 None 时更新，避免误清归属。
        """
        if self.db is None:
            raise ValueError("未启用 DB")
        old_name = (old_name or "").strip()
        new_name = (new_name or "").strip()
        if not new_name:
            raise ValueError("数据源名称不能为空")
        if kind not in self.DIALECTS:
            raise ValueError(f"不支持的数据库类型: {kind}（可选: {', '.join(self.DIALECTS)}）")
        with self.db.session() as s:
            from sqlalchemy import select
            row = s.scalar(select(DataSource).where(DataSource.name == old_name))
            if row is None:
                raise ValueError(f"数据源不存在: {old_name}")
            if new_name != old_name:
                clash = s.scalar(select(DataSource).where(
                    DataSource.name == new_name, DataSource.id != row.id))
                if clash is not None:
                    raise ValueError(f"数据源名称已存在: {new_name}")
                row.name = new_name
            row.kind = kind
            row.location = location or ""
            row.username = username or ""
            row.password = password or ""
            row.dsn = dsn or ""
            row.enabled = bool(enabled)
            if space_id is not None:
                row.space_id = space_id
            if sub_system_id is not None:
                row.sub_system_id = sub_system_id
            s.commit()
            s.refresh(row)
        out = self.get(new_name) or {"name": new_name}
        out.update({"kind": kind, "location": location or "", "username": username or "",
                    "enabled": bool(enabled),
                    "space_id": space_id, "sub_system_id": sub_system_id})
        return out

    def delete(self, name: str) -> None:
        if self.db is None:
            raise ValueError("未启用 DB")
        from sqlalchemy import delete as sa_delete, select
        with self.db.session() as s:
            s.execute(sa_delete(DataSource).where(DataSource.name == name))
            s.commit()

    # ---------- 连接 ----------
    @staticmethod
    def _parse_location(loc: str):
        """解析 location 'host:port/dbname' → (host, port, dbname)"""
        host_port, _, dbname = loc.partition("/")
        host, _, port = host_port.partition(":")
        return host, port, dbname

    def _conn_str(self, ds: Dict) -> str:
        if ds.get("dsn"):
            return ds["dsn"]
        kind, loc = ds["kind"], ds.get("location", "")
        uname = quote_plus(ds.get("username", ""))
        pwd = quote_plus(ds.get("password", ""))
        if kind == "sqlite":
            # SQLite 只读 URI：file: 前缀 + mode=ro + uri=true（防写/防新建）
            if "mode=ro" in loc or "uri=true" in loc:
                return f"sqlite:///{loc}"
            return f"sqlite:///file:{loc}?mode=ro&uri=true"
        host, port, dbname = self._parse_location(loc)
        if kind == "mysql":
            return f"mysql+pymysql://{uname}:{pwd}@{host}:{port or 3306}/{dbname}"
        if kind == "postgresql":
            return f"postgresql+psycopg2://{uname}:{pwd}@{host}:{port or 5432}/{dbname}"
        if kind == "kingbase":
            return f"postgresql+psycopg2://{uname}:{pwd}@{host}:{port or 54321}/{dbname}"
        if kind == "gaussdb":
            return f"postgresql+psycopg2://{uname}:{pwd}@{host}:{port or 8000}/{dbname}"
        if kind == "oracle":
            return f"oracle+oracledb://{uname}:{pwd}@{host}:{port or 1521}/?service_name={dbname}"
        if kind == "dm":
            return f"dm+dmPy://{uname}:{pwd}@{host}:{port or 5236}/{dbname}"
        raise ValueError(f"不支持的数据库类型: {kind}")

    @contextmanager
    def connect(self, name: str):
        ds = self.get(name)
        if not ds:
            raise ValueError(f"数据源不存在: {name}")
        if not ds["enabled"]:
            raise ValueError(f"数据源已停用: {name}")
        if ds["kind"] == "excel":
            path = self._excel_path(ds)
            if not path or not os.path.exists(path):
                raise ValueError(f"Excel 文件不存在: {path or '(未配置)'}")
            yield path
            return
        cs = self._conn_str({**ds, "kind": ds["kind"], "location": ds["location"],
                             "username": ds["username"], "password": (self._pwd(name) or "")})
        if self.circuit_breaker is not None:
            self.circuit_breaker.check_allowed()
        engine = create_engine(cs, connect_args={"check_same_thread": False}
                               if ds["kind"] == "sqlite" else {}, server_side_cursors=False)
        try:
            try:
                conn = engine.connect()
            except Exception:
                if self.circuit_breaker is not None:
                    self.circuit_breaker.record_failure()
                raise
            if self.circuit_breaker is not None:
                self.circuit_breaker.record_success()
            tx = conn.begin()
            yield conn
            tx.rollback()  # 所有数据源操作只读：统一回滚
        finally:
            engine.dispose()

    def _pwd(self, name: str) -> Optional[str]:
        """读取密码（列表接口不回传，仅连接时用）"""
        if self.db is None:
            return None
        from sqlalchemy import select
        with self.db.session() as s:
            row = s.scalar(select(DataSource).where(DataSource.name == name))
            return row.password if row else None

    # ---------- 只读查询 ----------
    @staticmethod
    def _validate_read_only(sql: str) -> str:
        sql = sql.strip().rstrip(";").strip()
        if not _SELECT_RE.match(sql):
            raise ValueError("仅允许 SELECT/WITH 只读查询")
        for kw in _BLOCKED_KEYWORDS:
            if re.search(rf"\b{kw}\b", sql, re.IGNORECASE):
                raise ValueError(f"禁止执行的语句/关键字: {kw}")
        return sql

    def query(self, name: str, sql: str, limit: int = QUERY_ROW_LIMIT) -> Dict:
        """执行只读查询，返回 {ok, columns, rows, row_count, message}"""
        try:
            q = self._validate_read_only(sql)
        except ValueError as e:
            if self.audit:
                self.audit("deny", name, f"{sql} | {e}")
            return {"ok": False, "columns": [], "rows": [], "row_count": 0, "message": str(e)}
        if limit <= 0 or limit > 500:
            limit = QUERY_ROW_LIMIT
        ds = self.get(name)
        if ds and ds.get("kind") == "excel":
            if not ds.get("enabled"):
                return {"ok": False, "columns": [], "rows": [], "row_count": 0,
                        "message": "数据源已停用"}
            path = self._excel_path(ds)
            if not path or not os.path.exists(path):
                return {"ok": False, "columns": [], "rows": [], "row_count": 0,
                        "message": f"Excel 文件不存在: {path or '(未配置)'}"}
            res = self._excel_query(path, q, limit)
            if self.audit:
                self.audit("query", name, f"excel:{path} | {q[:200]}")
            return res
        t0 = time.time()
        try:
            with self.connect(name) as conn:
                rows = conn.execute(text(q).execution_options(limit=limit)).mappings()
                data = list(rows)[:limit]
                columns = list(data[0].keys()) if data else []
                out_rows = []
                for row in data:
                    out_rows.append([self._fmt(r) for r in row.values()])
                latency = int((time.time() - t0) * 1000)
                if self.audit:
                    self.audit("query", name, q[:400])
                if self.obs_query:
                    try:
                        self.obs_query(name, q, latency)
                    except Exception:
                        pass  # 观测失败不影响查询
                return {"ok": True, "columns": columns, "rows": out_rows,
                        "row_count": len(out_rows), "message": ""}
        except Exception as e:
            return {"ok": False, "columns": [], "rows": [],
                    "row_count": 0, "message": f"查询失败: {e}"}

    @staticmethod
    def _fmt(v: Any) -> str:
        if v is None:
            return ""
        s = str(v)
        return s[:QUERY_CELL_LIMIT] + "…" if len(s) > QUERY_CELL_LIMIT else s

    # ---------- Excel 数据源（kind="excel"，数据源不可连接时的替代采集） ----------
    @staticmethod
    def _excel_path(ds: Dict) -> str:
        return (ds.get("location") or "").strip()

    @staticmethod
    def _load_excel(path: str):
        import openpyxl
        return openpyxl.load_workbook(path, read_only=True, data_only=True)

    @staticmethod
    def _infer_excel_type(samples: List[Any]) -> str:
        """按样本值推断列类型（源库风格：NUMBER / DATE / VARCHAR2），用于生成 DDL 走规则引擎"""
        vals = [v for v in samples if v is not None and str(v).strip() != ""]
        if not vals:
            return "VARCHAR2(255)"
        ints = 0
        floats = 0
        dates = 0
        for v in vals[:8]:
            if isinstance(v, (int, float)):
                if isinstance(v, bool):
                    continue
                if float(v).is_integer():
                    ints += 1
                else:
                    floats += 1
            elif isinstance(v, (datetime, date)):
                dates += 1
            # 字符串一律按文本处理：手机号/编码等长数字串不推断为数值
        if dates >= max(1, len(vals) // 2):
            return "DATE"
        if ints == len(vals):
            return "NUMBER(10)"
        if ints + floats == len(vals):
            return "NUMBER(10,2)"
        return "VARCHAR2(255)"

    @staticmethod
    def _excel_tables(path: str) -> List[str]:
        wb = DbTools._load_excel(path)
        try:
            return [ws.title for ws in wb.worksheets
                    if ws.title and not ws.title.startswith("_")]
        finally:
            wb.close()

    @staticmethod
    def _excel_columns(path: str, sheet: str) -> List[Dict]:
        """读取 sheet 表头行 + 每列类型推断，返回列定义（name/type/nullable/pk）"""
        wb = DbTools._load_excel(path)
        try:
            ws = wb[sheet]
            rows = ws.iter_rows(values_only=True)
            header = next(rows, None)
            if not header:
                return []
            sample_rows = []
            for r in rows:
                if len(sample_rows) >= 8:
                    break
                sample_rows.append(r)
            cols: List[Dict] = []
            for i, h in enumerate(header):
                if h is None or str(h).strip() == "":
                    continue
                samples = [r[i] for r in sample_rows if i < len(r)]
                cols.append({"name": str(h).strip(),
                             "type": DbTools._infer_excel_type(samples),
                             "nullable": True, "pk": False})
            return cols
        finally:
            wb.close()

    @staticmethod
    def _excel_rows(path: str, sheet: str, limit: int = QUERY_ROW_LIMIT) -> Dict:
        """读取 sheet 前 limit 行样本（首行为表头），返回 {columns, rows}"""
        wb = DbTools._load_excel(path)
        try:
            ws = wb[sheet]
            rows = ws.iter_rows(values_only=True)
            header = next(rows, None)
            if not header:
                return {"columns": [], "rows": []}
            columns = [str(h).strip() if h is not None else f"col{i+1}"
                       for i, h in enumerate(header)]
            data = []
            for r in rows:
                if len(data) >= limit:
                    break
                data.append([DbTools._fmt(v) for v in r])
            return {"columns": columns, "rows": data}
        finally:
            wb.close()

    def _excel_query(self, path: str, sql: str, limit: int) -> Dict:
        """Excel 只读采样：从 sql 中识别目标 sheet（FROM 后标识符），读前 limit 行样本"""
        m = re.search(r"\bFROM\s+([`\"\[]?)([\w\-]+)([`\"\]]?)?", sql, re.IGNORECASE)
        sheet = (m.group(2) if m else "") or ""
        if sheet and sheet.lower() == "select":
            sheet = ""
        try:
            tables = self._excel_tables(path)
        except Exception as e:
            return {"ok": False, "columns": [], "rows": [], "row_count": 0,
                    "message": f"读取 Excel 失败: {e}"}
        if not tables:
            return {"ok": False, "columns": [], "rows": [], "row_count": 0,
                    "message": "Excel 中没有工作表"}
        if sheet and sheet not in tables:
            return {"ok": False, "columns": [], "rows": [], "row_count": 0,
                    "message": f"工作表不存在: {sheet}（可选: {', '.join(tables[:10])}）"}
        target = sheet or tables[0]
        try:
            res = self._excel_rows(path, target, limit)
            return {"ok": True, "columns": res["columns"], "rows": res["rows"],
                    "row_count": len(res["rows"]),
                    "message": f"Excel 工作表 {target} 样本（前 {len(res['rows'])} 行）"}
        except Exception as e:
            return {"ok": False, "columns": [], "rows": [], "row_count": 0,
                    "message": f"读取工作表失败: {e}"}

    def inspect_schema(self, name: str, object_name: str = "") -> Dict:
        """探查表/视图结构：列出对象，或指定对象时返回其列定义与类型"""
        ds = self.get(name)
        if not ds:
            return {"ok": False, "message": f"数据源不存在: {name}"}
        if not ds["enabled"]:
            return {"ok": False, "message": f"数据源已停用: {name}"}
        kind = ds["kind"]
        if kind == "excel":
            try:
                path = self._excel_path(ds)
                if not path or not os.path.exists(path):
                    return {"ok": False, "message": f"Excel 文件不存在: {path or '(未配置)'}"}
                obj = (object_name or "").strip()
                if not obj:
                    tables = self._excel_tables(path)
                    return {"ok": True, "scheme": "excel", "tables": tables, "views": [],
                            "message": f"Excel 工作表 {len(tables)} 个（数据源不可连接时的替代采集）"}
                if obj not in self._excel_tables(path):
                    return {"ok": False, "message": f"工作表不存在: {obj}"}
                cols = self._excel_columns(path, obj)
                return {"ok": True, "scheme": "excel", "object": obj, "columns": cols,
                        "message": f"工作表 {obj} 共 {len(cols)} 列（类型为按样本推断）"}
            except Exception as e:
                return {"ok": False, "message": f"读取 Excel 失败: {e}"}
        try:
            from sqlalchemy import MetaData, Table, inspect as sa_inspect
            with self.connect(name) as conn:
                insp = sa_inspect(conn)
                obj = (object_name or "").strip()
                if not obj:
                    tables = insp.get_table_names()
                    views = insp.get_view_names()
                    return {"ok": True, "scheme": kind, "tables": tables, "views": views,
                            "message": f"共 {len(tables)} 张表, {len(views)} 个视图"}
                table = Table(obj, MetaData(), autoload_with=conn)
                cols = [{"name": c.name, "type": str(c.type), "nullable": c.nullable,
                         "pk": c.primary_key} for c in table.columns]
                return {"ok": True, "scheme": kind, "object": obj, "columns": cols,
                        "message": f"表 {obj} 共 {len(cols)} 列"}
        except Exception as e:
            return {"ok": False, "message": f"探查失败: {e}"}

    def explain(self, name: str, sql: str) -> Dict:
        """只读语法/执行计划校验：拒绝非 SELECT，返回查询计划摘要（不返回数据）"""
        q = self._validate_read_only(sql)
        ds = self.get(name)
        if ds and ds.get("kind") == "excel":
            if not ds.get("enabled"):
                return {"ok": False, "valid": False, "plan": [], "message": "数据源已停用"}
            path = self._excel_path(ds)
            if not path or not os.path.exists(path):
                return {"ok": False, "valid": False, "plan": [], "message": f"Excel 文件不存在: {path or '(未配置)'}"}
            try:
                tables = self._excel_tables(path)
                m = re.search(r"\bFROM\s+([`\"\[]?)([\w\-]+)([`\"\]]?)?", q, re.IGNORECASE)
                target = (m.group(2) if m else "") or ""
                if target and target not in tables:
                    return {"ok": False, "valid": False, "plan": [], "message": f"工作表不存在: {target}"}
                return {"ok": True, "valid": True, "plan": [f"EXCEL 工作表 {target or tables[0]} 采样"],
                        "message": "语法有效（Excel 只读采样，未执行数据查询）"}
            except Exception as e:
                return {"ok": False, "valid": False, "plan": [], "message": f"读取 Excel 失败: {e}"}
        try:
            with self.connect(name) as conn:
                plan_sql = f"EXPLAIN QUERY PLAN {q}"
                try:
                    rows = conn.execute(text(plan_sql)).mappings()
                except Exception:
                    rows = conn.execute(text(f"EXPLAIN {q}")).mappings()
                plan = [" ".join(str(v) for v in r.values()) for r in rows]
                return {"ok": True, "valid": True, "plan": plan[:20],
                        "message": "语法有效（只读校验，未执行数据查询）"}
        except Exception as e:
            return {"ok": False, "valid": False, "plan": [], "message": f"语法无效: {e}"}


def pg_sqlite_inspect_fallback(path: str) -> Dict:
    """sqlite 快速探测（供测试/演示直接读文件）"""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
        return {"tables": [r[0] for r in cursor.fetchall()], "views": []}
    finally:
        conn.close()
