"""Agent 注册中心测试（数据来自 bootstrap 后的 DB，代码不含写死数据）。"""
from db_loc_agent.agents import AgentService, list_agents, resolve_agent

REQUIRED_IDS = {"migration_assessor", "ddl_converter", "code_migrator", "nl2sql_qa"}


def test_all_required_agents_present(db):
    ids = {a["id"] for a in AgentService(db).all()}
    assert REQUIRED_IDS.issubset(ids)


def test_intent_map_consistent(db):
    """启用 Agent 的意图唯一且能稳定解析回该 Agent。"""
    svc = AgentService(db)
    for a in svc.enabled():
        assert svc.resolve(a["intent"]) == a["id"]


def test_resolve_agent_unknown_falls_back(db):
    assert resolve_agent(db, "unknown") == "nl2sql_qa"


def test_list_agents(db):
    rows = list_agents(db)
    assert all("id" in r and "name" in r for r in rows)
    assert len(rows) == 11
