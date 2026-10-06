"""安全网关测试：鉴权 / 限流 / 审计落库 / SQL 只读审计回调"""
import time

import pytest

from db_loc_agent.db import Database, SecurityLog
from db_loc_agent.security import SecurityGateway


def test_auth_allowed_when_key_empty():
    g = SecurityGateway(api_key="")
    assert g.authorize("1.1.1.1", {}) is None  # 未配置 Key 全部放行


def test_auth_rejects_invalid_key():
    g = SecurityGateway(api_key="secret")
    assert g.authorize("1.1.1.1", {"x-api-key": "nope"}) == "invalid_api_key"
    # Authorization Bearer
    assert g.authorize("1.1.1.1", {"authorization": "Bearer other"}) == "invalid_api_key"


def test_auth_accepts_valid_key():
    g = SecurityGateway(api_key="secret")
    assert g.authorize("1.1.1.1", {"x-api-key": "secret"}) is None
    assert g.authorize("1.1.1.1", {"authorization": "Bearer secret"}) is None


def test_rate_limit_window(tmp_path):
    g = SecurityGateway(rate_limit_per_min=3)
    ips = ["10.0.0.1"]
    assert g.authorize("10.0.0.1", {}) is None
    assert g.authorize("10.0.0.1", {}) is None
    assert g.authorize("10.0.0.1", {}) is None
    assert g.authorize("10.0.0.1", {}) == "rate_limited"  # 第 4 次超限
    # 其他 IP 不受影响
    assert g.authorize("10.0.0.2", {}) is None
    # 窗口重置后可再请求
    g._buckets["10.0.0.1"] = (0, time.time() - 61)
    assert g.authorize("10.0.0.1", {}) is None


def test_audit_writes_log(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    g = SecurityGateway(api_key="x", security_log=True)
    g.audit(db, "GET", "/api/health", "127.0.0.1", 200, 12, "note")
    with db.session() as s:
        from sqlalchemy import select
        row = s.scalars(select(SecurityLog)).first()
        assert row is not None
        assert row.path == "/api/health" and row.status == 200
        assert row.duration_ms == 12 and row.notes == "note"


def test_audit_disabled(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    g = SecurityGateway(api_key="", security_log=False)
    g.audit(db, "GET", "/api/x", "ip", 200)
    with db.session() as s:
        from sqlalchemy import select
        rows = list(s.scalars(select(SecurityLog)))
        assert rows == []


def test_sql_audit_via_dbtools(tmp_path):
    """DbTools 只读查询经 audit 回调记录 SQL 与拦截写语句"""
    import sqlite3
    from db_loc_agent.db_tools import DbTools
    db = Database(str(tmp_path / "t.db"))
    db_file = tmp_path / "x.db"
    sqlite3.connect(str(db_file)).close()  # 只读模式要求文件存在
    seen = []
    tools = DbTools(db, audit=lambda kind, name, note: seen.append((kind, name, note)))
    # 写语句被拒并审计 deny
    tools.create("demo", "sqlite", str(db_file))
    res = tools.query("demo", "insert into t values(1)")
    assert res["ok"] is False
    assert ("deny", "demo") in [(k, n) for k, n, _ in seen]
    # 只读查询成功并审计 query
    res2 = tools.query("demo", "select count(*) from sqlite_master")
    assert res2["ok"] is True
    assert any(k == "query" and n == "demo" for k, n, _ in seen)