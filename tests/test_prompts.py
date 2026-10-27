import pytest
from sqlalchemy import select

from jarvis_agent.db import Database, Prompt
from jarvis_agent.prompts import PromptService


def _svc(tmp_path):
    return PromptService(Database(str(tmp_path / "t.db")))


def test_create_get_update_delete(tmp_path):
    svc = _svc(tmp_path)
    p = svc.create("路由提示词", "router", "你是解析器", enabled=True)
    assert p["name"] == "路由提示词"
    assert svc.get(p["id"])["category"] == "router"
    svc.update(p["id"], enabled=False)
    assert svc.get(p["id"])["enabled"] is False
    assert len(svc.list()) == 1
    svc.delete(p["id"])
    assert svc.list() == []


def test_update_missing_raises(tmp_path):
    svc = _svc(tmp_path)
    with pytest.raises(KeyError):
        svc.update(999, enabled=False)


def test_system_role_bind_and_delete_protection(tmp_path):
    """系统角色提示词：绑定校验（存在/type/enabled）、bound_agent_count、删除保护与解绑后删除"""
    from jarvis_agent.agents import AgentService
    svc = _svc(tmp_path)
    asvc = AgentService(svc.db)
    # 创建系统角色提示词
    role = svc.create("标准系统角色", "system", "你是公司合规专家", enabled=True,
                      prompt_type="system_role")
    assert role["type"] == "system_role"
    assert role["bound_agent_count"] == 0
    # 绑定 Agent：成功后 bound_agent_count / get_bound_agents 反映绑定
    asvc.create("custom_agent", "自定义智能体", "desc", "custom",
                system_role_prompt_id=role["id"])
    assert svc.get(role["id"])["bound_agent_count"] == 1
    assert svc.get_bound_agents(role["id"]) == [
        {"agent_id": "custom_agent", "name": "自定义智能体", "enabled": True}]
    # 绑定校验：不存在 / type 非 system_role / 未启用 一律拒绝
    with pytest.raises(ValueError, match="系统角色提示词不存在或未启用"):
        asvc.create("a1", "n1", "d1", "i1", system_role_prompt_id=999)
    task = svc.create("任务指令", "agent", "普通指令内容", enabled=True)  # 默认 task_instruction
    with pytest.raises(ValueError, match="系统角色提示词不存在或未启用"):
        asvc.create("a2", "n2", "d2", "i2", system_role_prompt_id=task["id"])
    disabled = svc.create("禁用角色", "system", "x", enabled=False, prompt_type="system_role")
    with pytest.raises(ValueError, match="系统角色提示词不存在或未启用"):
        asvc.create("a3", "n3", "d3", "i3", system_role_prompt_id=disabled["id"])
    # 删除保护：被绑定 1 个 Agent，拒绝删除
    with pytest.raises(ValueError, match="已被 1 个 Agent 绑定，请先解绑后再删除"):
        svc.delete(role["id"])
    # 解绑（update 传 None）后删除成功；普通提示词不受删除保护
    asvc.update("custom_agent", system_role_prompt_id=None)
    assert svc.get(role["id"])["bound_agent_count"] == 0
    svc.delete(role["id"])
    assert svc.get(role["id"]) is None
    assert task["bound_agent_count"] == 0
    svc.delete(task["id"])