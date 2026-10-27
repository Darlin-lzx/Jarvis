"""Agent 配置化注册与数据源只读工具测试"""
import pytest

from jarvis_agent.agents import AgentService
from jarvis_agent.db import Database


def _svc(tmp_path):
    from jarvis_agent.bootstrap import bootstrap
    d = Database(str(tmp_path / "t.db"))
    bootstrap(d)
    return AgentService(d)


def test_builtin_agents_enabled_by_default(tmp_path):
    svc = _svc(tmp_path)
    all_a = svc.all()
    assert len(all_a) >= 4
    enabled = svc.enabled()
    assert "ddl_converter" in {a["id"] for a in enabled}
    assert svc.get("ddl_converter")["gen_artifact"] is True
    assert svc.get("nl2sql_qa")["gen_artifact"] is False


def test_bootstrap_preserves_user_disabled_agents(tmp_path):
    from jarvis_agent.bootstrap import bootstrap

    db = Database(str(tmp_path / "t.db"))
    bootstrap(db)
    svc = AgentService(db)
    svc.set_enabled("ddl_converter", False)

    bootstrap(db)

    assert svc.get("ddl_converter")["enabled"] is False


def test_bootstrap_preserves_edited_agent_config(tmp_path):
    from jarvis_agent.bootstrap import bootstrap

    db = Database(str(tmp_path / "t.db"))
    bootstrap(db)
    svc = AgentService(db)
    svc.update(
        "boot_agent",
        name="页面展示专家（用户修改）",
        alias="用户别名",
        description="用户修改后的职责",
        default_prompt="用户修改后的提示词",
        project_dir="/tmp/user-project",
        tools=["代码生成"],
        bound_kbs=["boot知识库"],
    )

    bootstrap(db)

    agent = svc.get("boot_agent")
    assert agent["name"] == "页面展示专家（用户修改）"
    assert agent["alias"] == "用户别名"
    assert agent["description"] == "用户修改后的职责"
    assert agent["default_prompt"] == "用户修改后的提示词"
    assert agent["project_dir"] == "/tmp/user-project"
    assert agent["tools"] == ["代码生成"]
    assert agent["bound_kbs"] == ["boot知识库"]


def test_resolve_intent(tmp_path):
    svc = _svc(tmp_path)
    assert svc.resolve("ddl_convert") == "ddl_converter"
    assert svc.resolve("unknown_intent") == "nl2sql_qa"


def test_create_custom_agent(tmp_path):
    svc = _svc(tmp_path)
    a = svc.create("sql_reviewer", "SQL审查", "审查生成的 SQL", "sql_review",
                   default_prompt="你是 SQL 审查专家", output_files=["review.md"],
                   gen_artifact=True, enabled=True)
    assert a["id"] == "sql_reviewer"
    assert {x["id"] for x in svc.enabled()} >= {"sql_reviewer"}
    # 自定义 intent 可命中路由
    assert svc.resolve("sql_review") == "sql_reviewer"
    # 停用后不再命中
    svc.set_enabled("sql_reviewer", False)
    assert "sql_reviewer" not in {x["id"] for x in svc.enabled()}
    assert svc.resolve("sql_review") == "nl2sql_qa"
    svc.delete("sql_reviewer")
    assert svc.get("sql_reviewer") is None


def test_db_tools_sqlite_read_only(tmp_path):
    from jarvis_agent.db_tools import DbTools
    db = Database(str(tmp_path / "t.db"))
    tools = DbTools(db)
    # 准备一个只读数据源指向临时 sqlite 库
    sample = tmp_path / "sample.db"
    import sqlite3
    conn = sqlite3.connect(str(sample))
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, mb INTEGER)")
    conn.execute("INSERT INTO users VALUES (1, 'alice', 1024), (2, 'bob', 2048)")
    conn.commit(); conn.close()

    tools.create("src_main", kind="sqlite", location=str(sample), enabled=True)
    assert tools.get("src_main")["enabled"] is True

    seen = tools.inspect_schema("src_main")
    assert seen["ok"] is True and "users" in seen["tables"]

    detail = tools.inspect_schema("src_main", "users")
    assert detail["ok"] is True and {c["name"] for c in detail["columns"]} >= {"id", "name", "mb"}

    q = tools.query("src_main", "SELECT name, mb FROM users ORDER BY id")
    assert q["ok"] is True and q["row_count"] == 2
    assert q["columns"] == ["name", "mb"]
    assert q["rows"][1] == ["bob", "2048"]

    # 写语句被拒绝
    for bad in ["UPDATE users SET mb=0", "INSERT INTO users VALUES (9,'x',0)",
                "DROP TABLE users", "DELETE FROM users"]:
        r = tools.query("src_main", bad)
        assert r["ok"] is False, bad

    # 语法校验：只读版权限
    ex = tools.explain("src_main", "SELECT name FROM users WHERE id=1")
    assert ex["ok"] is True and ex["valid"] is True


def test_db_tools_disable_and_delete(tmp_path):
    from jarvis_agent.db_tools import DbTools
    db = Database(str(tmp_path / "t.db"))
    tools = DbTools(db)
    sample = tmp_path / "s2.db"
    import sqlite3
    conn = sqlite3.connect(str(sample))
    conn.execute("CREATE TABLE t (a INT)")
    conn.commit(); conn.close()

    tools.create("ds2", kind="sqlite", location=str(sample))
    r = tools.inspect_schema("ds2")
    assert r["ok"] is True
    tools.set_enabled("ds2", False)
    r = tools.inspect_schema("ds2")
    assert r["ok"] is False and "已停用" in r["message"]
    tools.delete("ds2")
    assert tools.get("ds2") is None
