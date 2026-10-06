"""双库 Schema Diff 引擎测试。"""
import os
import sqlite3
import tempfile

import pytest

from db_loc_agent.db import Database
from db_loc_agent.db_tools import DbTools
from db_loc_agent.schema_diff import SchemaDiffService, normalize_type


@pytest.fixture()
def env(tmp_path):
    src = tmp_path / "src.db"
    tgt = tmp_path / "tgt.db"
    sqlite3.connect(src).executescript(
        """
        CREATE TABLE USER_ORDER (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL,
                                 amount DECIMAL(12,2), created_at TEXT);
        CREATE TABLE USER_INFO (uid INTEGER PRIMARY KEY, phone VARCHAR(20));
        CREATE INDEX idx_order_name ON USER_ORDER(name);
        """)
    sqlite3.connect(tgt).executescript(
        """
        CREATE TABLE USER_ORDER (id INTEGER PRIMARY KEY, name VARCHAR(100),
                                 created_at VARCHAR(20));
        CREATE TABLE LOG (id INTEGER PRIMARY KEY, msg TEXT);
        """)
    db = Database(str(tmp_path / "biz.db"))
    tools = DbTools(db)
    tools.create("src", "sqlite", str(src))
    tools.create("tgt", "sqlite", str(tgt))
    return SchemaDiffService(tools)


def test_normalize_type(db):
    """类型兼容映射从 sys_dict(category=type_alias) 读取。"""
    from db_loc_agent.agents import SysDictService
    aliases = SysDictService(db).map("type_alias")
    assert normalize_type("VARCHAR2(255)", aliases) == "VARCHAR"
    assert normalize_type("NUMBER(10,2)", aliases) == "NUMBER"
    assert normalize_type("CLOB", aliases) == "CLOB"


def test_diff_finds_all_differences(env):
    res = env.compare("src", "tgt")
    kinds = {d["kind"] for d in res["diffs"]}
    assert "missing_table" in kinds       # USER_INFO
    assert "missing_column" in kinds      # amount
    assert "type_changed" in kinds        # created_at
    assert "nullable_changed" in kinds    # name
    assert "extra_table" in kinds         # LOG
    assert "missing_index" in kinds       # name 索引
    assert res["summary"]["total_diffs"] == 6
    assert res["summary"]["identical"] is False


def test_identical_catalogs(tmp_path):
    ddl = "CREATE TABLE T (id INTEGER PRIMARY KEY, name TEXT NOT NULL);"
    a, b = tmp_path / "a.db", tmp_path / "b.db"
    sqlite3.connect(a).executescript(ddl)
    sqlite3.connect(b).executescript(ddl)
    db = Database(str(tmp_path / "biz.db"))
    tools = DbTools(db)
    tools.create("a", "sqlite", str(a))
    tools.create("b", sqlite_kind := "sqlite", str(b))
    svc = SchemaDiffService(tools)
    res = svc.compare("a", "b")
    assert res["summary"]["identical"] is True
    assert res["diffs"] == []


def test_api_smoke(tmp_path):
    from fastapi.testclient import TestClient
    from db_loc_agent.app import create_app

    ddl = "CREATE TABLE T (id INTEGER PRIMARY KEY, name TEXT NOT NULL);"
    a, b = tmp_path / "a.db", tmp_path / "b.db"
    sqlite3.connect(a).executescript(ddl)
    sqlite3.connect(b).executescript(
        "CREATE TABLE T (id INTEGER PRIMARY KEY, name TEXT);"
        "CREATE TABLE X (id INTEGER PRIMARY KEY);")

    app = create_app(db_path=str(tmp_path / "app.db"),
                     artifact_root=str(tmp_path / "art"),
                     faiss_dir=str(tmp_path / "faiss"),
                     config_override={"mysql_url": ""},  # 测试强制 SQLite，隔离生产 MySQL
                     static_dir=str(tmp_path))
    client = TestClient(app)
    # 注册数据源
    for n, p in (("a", a), ("b", b)):
        r = client.post("/api/datasources",
                        json={"name": n, "kind": "sqlite", "location": str(p)})
        assert r.status_code == 200
    r = client.post("/api/schema-diff", json={"source": "a", "target": "b"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["summary"]["total_diffs"] == 2  # 多表 X + name 可空性
    # 源/目标相同应被拒绝
    r = client.post("/api/schema-diff", json={"source": "a", "target": "a"})
    assert r.status_code == 400
