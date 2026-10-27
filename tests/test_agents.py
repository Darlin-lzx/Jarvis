"""Agent 注册中心测试（数据来自 bootstrap 后的 DB，代码不含写死数据）。"""
import pytest

from jarvis_agent.agents import AgentService, list_agents, resolve_agent

REQUIRED_IDS = {"jarvis_commander", "boot_agent", "customer_order_agent",
                    "family_order_agent", "rule_center_agent", "customer_center_agent"}


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
    assert len(rows) == 7


def test_agent_knowledge_access_is_isolated_and_qa_is_privileged(db):
    from jarvis_agent.db import KnowledgeBase

    svc = AgentService(db)
    with db.session() as s:
        s.add(KnowledgeBase(name="新增知识库", owner_agent_id="boot_agent"))
        s.commit()

    boot_ids = svc.kb_ids("boot_agent")
    order_ids = svc.kb_ids("customer_order_agent")
    assert boot_ids and order_ids
    assert set(boot_ids).isdisjoint(order_ids)
    assert svc.kb_ids("nl2sql_qa") == sorted(
        svc.kb_ids("nl2sql_qa"), key=lambda kb_id: kb_id)
    assert len(svc.kb_ids("nl2sql_qa")) >= 6

    svc.update("boot_agent", bound_kbs=[])
    assert svc.kb_ids("boot_agent") == []

    with pytest.raises(ValueError, match="知识库不存在"):
        svc.update("boot_agent", bound_kbs=["不存在知识库"])
