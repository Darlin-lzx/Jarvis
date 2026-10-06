"""迁移后运维（第二级）测试：健康巡检 / 慢 SQL 记录与查询 / 性能基线"""
import sqlite3

from db_loc_agent.db import Database, OpsCheck, SlowQuery
from db_loc_agent.db_tools import DbTools
from db_loc_agent.ops import OpsService


def _mkdb(tmp_path, with_ds=True):
    db = Database(str(tmp_path / "t.db"))
    db_file = str(tmp_path / "x.db")
    sqlite3.connect(db_file).close()  # 只读模式要求文件存在
    sqlite3.connect(db_file).execute("CREATE TABLE t1(id INTEGER PRIMARY KEY, name TEXT)")
    sqlite3.connect(db_file).execute("INSERT INTO t1 VALUES (1,'a'),(2,'b')")
    tools = DbTools(db)
    if with_ds:
        tools.create("demo", "sqlite", db_file)
    return db, tools


def test_health_check_records_and_counts(tmp_path):
    db, tools = _mkdb(tmp_path)
    ops = OpsService(db, tools, slow_threshold_ms=0)
    r = ops.health_check("demo")
    assert r["success"] is True
    d = r["data"]
    assert d["ok"] == 1 and d["failed"] == 0
    assert d["checks"][0]["ds"] == "demo" and d["checks"][0]["ok"] is True
    with db.session() as s:
        from sqlalchemy import select
        rows = list(s.scalars(select(OpsCheck)))
        assert len(rows) == 1 and rows[0].ok is True


def test_health_check_unknown_ds_fails(tmp_path):
    db, tools = _mkdb(tmp_path)
    ops = OpsService(db, tools)
    r = ops.health_check("nope")
    assert r["data"]["failed"] == 1 and r["data"]["checks"][0]["ok"] is False


def test_slow_query_recorded_above_threshold(tmp_path):
    db, tools = _mkdb(tmp_path)
    ops = OpsService(db, tools, slow_threshold_ms=100)
    ops.record_query("demo", "SELECT 1", 200)   # 超阈值 → 落库
    ops.record_query("demo", "SELECT 2", 50)    # 未超 → 不落库
    with db.session() as s:
        from sqlalchemy import select
        rows = list(s.scalars(select(SlowQuery)))
        assert len(rows) == 1 and rows[0].latency_ms == 200


def test_slow_queries_list_and_threshold(tmp_path):
    db, tools = _mkdb(tmp_path)
    ops = OpsService(db, tools, slow_threshold_ms=0)
    ops.record_query("demo", "SELECT count(*) FROM t1", 500)
    ops.record_query("demo", "SELECT 1", 700)
    r = ops.slow_queries(threshold_ms=600)
    assert len(r["data"]["queries"]) == 1
    assert r["data"]["queries"][0]["latency_ms"] == 700
    assert r["data"]["total"] == 2


def test_baseline_aggregates(tmp_path):
    db, tools = _mkdb(tmp_path)
    ops = OpsService(db, tools, slow_threshold_ms=0)
    ops.health_check("demo")                     # 探活样本
    ops.record_query("demo", "SELECT 1", 1200)   # 慢查询样本
    r = ops.baseline()
    d = r["data"]
    assert d["slow_samples"] == 1
    assert any(b["ds"] == "demo" for b in d["probe_baseline"])
    assert any(b["ds"] == "demo" for b in d["per_ds"])
    assert any(a["ds"] == "demo" for a in d["alerts"])  # 最大延迟超阈值告警


def test_dbtools_obs_query_hooked(tmp_path):
    """DbTools 执行只读查询时经 obs_query 回调记录慢查询"""
    db, tools = _mkdb(tmp_path)
    ops = OpsService(db, tools, slow_threshold_ms=0)
    tools.obs_query = ops.record_query
    res = tools.query("demo", "SELECT * FROM t1")
    assert res["ok"] is True
    with db.session() as s:
        from sqlalchemy import select
        rows = list(s.scalars(select(SlowQuery)))
        assert len(rows) == 1 and "t1" in rows[0].sql