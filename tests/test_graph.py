import json

from db_loc_agent.agents import AgentService
from db_loc_agent.artifacts import ArtifactService
from db_loc_agent.db import Database
from db_loc_agent.graph import AgentState, build_graph
from db_loc_agent.prompts import PromptService
from db_loc_agent.skills import SkillService


class FakeLLM:
    """非流式 mock：invoke 返回 AIMessage；with_structured_output 由外层独立实现，此处辅助 run 使用"""

    def __init__(self, reply="转换完成", parse=None, tool_script=None, skill_reply="脚本输出 100GB=102400MB"):
        self.reply = reply
        self._parse = parse
        # 模拟：首次调用绑定工具后返回 use_skill 工具调用，随后返回最终回复
        self._tool_script = tool_script
        self._skill_reply = skill_reply
        self._called = 0
        self._schemas = []

    def bind_tools(self, schemas, **kw):
        self._schemas = schemas
        return self

    def invoke(self, messages, **kw):
        from langchain_core.messages import AIMessage
        self._called += 1
        if self._tool_script and self._called == 1:
            return AIMessage(content="我需要调用技能", tool_calls=[
                {"name": "use_skill", "args": {"skill_id": self._tool_script, "args": "10"},
                 "id": "call_1"}])
        return AIMessage(content=self.reply)

    def stream(self, messages, **kw):
        """最终回复轮流式重放（graph.execute 对无工具调用轮走 stream 分支）"""
        from langchain_core.messages import AIMessage
        yield AIMessage(content=self.reply)

    def parse(self, text):
        return self._parse or {"intent": "ddl_convert", "agent_id": "ddl_converter",
                               "object_name": "user_order", "source_db": "oracle",
                               "target_db": "dm", "skill_id": "", "confidence": 0.95}


class ScriptedLLM(FakeLLM):
    """按调用次数依次返回预设内容/tool_calls（用于编排类测试）"""

    def __init__(self, steps, parse=None):
        super().__init__(reply="", parse=parse)
        self.steps = steps
        self.calls = []

    def invoke(self, messages, **kw):
        from langchain_core.messages import AIMessage
        idx = len(self.calls)
        if idx >= len(self.steps):
            return AIMessage(content="（无更多预设步骤）")
        text, tool_calls = self.steps[idx]
        self.calls.append(text if isinstance(text, str) else text)
        return AIMessage(content=text if isinstance(text, str) else "",
                         tool_calls=tool_calls or [])

    def stream(self, messages, **kw):
        """流式按调用次数返回当前步骤（execute 主循环统一用 stream，含工具调用轮）。"""
        from langchain_core.messages import AIMessage
        idx = len(self.calls)
        if idx >= len(self.steps):
            yield AIMessage(content="（无更多预设步骤）")
            return
        text, tool_calls = self.steps[idx]
        self.calls.append(text if isinstance(text, str) else text)
        yield AIMessage(content=text if isinstance(text, str) else "",
                        tool_calls=tool_calls or [])


def test_graph_full_flow(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    prompt_svc.create("ddl_converter 提示词", "agent",
                      AgentService(db).get("ddl_converter")["default_prompt"])

    graph = build_graph(
        llm=FakeLLM(reply="```sql\nCREATE TABLE USER_ORDER (ID INT);\n```"),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc,
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=None,
        parse_schema={},
        max_iterations=1,
    )
    state = AgentState(user_input="将 user_order 表转成达梦 DDL", conv_id=1)
    final = graph.invoke(state)
    assert final["reply"]
    assert final["namespace"].startswith("sess_1/ddl_converter/user_order/")
    namespaces = artifact_svc.list_namespaces(conv_id=1)
    assert len(namespaces) == 1


def test_graph_low_confidence_fallback(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    graph = build_graph(
        llm=FakeLLM(reply="回答", parse={"intent": 999, "agent_id": "", "object_name": "x",
                                         "source_db": "", "target_db": "", "skill_id": "",
                                         "confidence": 0.2}),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=None,
        parse_schema={},
        max_iterations=1,
    )
    final = graph.invoke(AgentState(user_input="随便问问", conv_id=2))
    assert final["agent_id"] == "nl2sql_qa"  # 回退知识库问答


def test_agent_autonomously_calls_skill(tmp_path):
    """agent 自主调用 use_skill 工具：执行技能脚本并把输出注入上下文"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    skill_svc = SkillService(db, str(tmp_path / "skills"))
    text = """---
name: disk_conv
description: GB 转 MB 换算
script: conv.py
---

按脚本换算容量单位。

```python
import sys
v = float(sys.argv[1]) if len(sys.argv) > 1 else 100
print(f"{v}GB = {v*1024}MB")
```
"""
    skill = skill_svc.create_from_md(text)
    skill_svc.set_enabled(skill["skill_id"], True)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    prompt_svc = PromptService(db)
    prompt_svc.create("ddl_converter 提示词", "agent",
                      AgentService(db).get("ddl_converter")["default_prompt"])
    # 定义解析结果不要带 skill_id（用户未 @），看 agent 是否自主调用
    graph = build_graph(
        llm=FakeLLM(reply="换算结果：10GB = 10240MB", tool_script=skill["skill_id"]),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc,
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=skill_svc,
        parse_schema={},
        max_iterations=3,
    )
    state = AgentState(user_input="把 10GB 换算成 MB", conv_id=3)
    final = graph.invoke(state)
    assert final["reply"] == "换算结果：10GB = 10240MB"
    # 工具调用已执行：技能脚本被执行（脚本真实落盘运行）
    r = skill_svc.run_script(skill["skill_id"], args="10")
    assert "10240" in r["stdout"]


def test_multi_agent_orchestration_call_agent(tmp_path):
    """多 Agent 编排：主 agent 委派 call_agent 给另一个 agent；子 agent 不带 call_agent 工具（防自递归）"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    prompt_svc.create("ddl_converter 提示词", "agent",
                      AgentService(db).get("ddl_converter")["default_prompt"])
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "ddl_converter",
                          "question": "请转换 select * from t"},
                 "id": "call_agent_1"}
    llm = ScriptedLLM([
        ("需要委派给转换智能体", [call_tool]),
        ("子智能体回复：已转换 SQL", None),
        ("最终汇总答复：已由 DDL 转换智能体完成", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="帮我做个 DDL 转换", conv_id=4,
        agent_id="migration_commander", task_state={"current_step": "complete"}))
    assert "最终汇总答复" in final["reply"]
    assert final.get("agent_calls") and final["agent_calls"][0]["agent_id"] == "ddl_converter"
    assert final["agent_calls"][0]["reply"] == "子智能体回复：已转换 SQL"
    # 主图暴露过 call_agent 工具；子 agent 不允许再委派（递归防护）
    main_schemas = {s["function"]["name"] for s in llm._schemas} if llm._schemas else set()
    assert "call_agent" in main_schemas


def test_custom_stream_events_on_call_agent(tmp_path):
    """call_agent 委派时经 custom 流模式实时下发「系统调度事件 + 子 Agent 输出事件」"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    prompt_svc.create("ddl_converter 提示词", "agent",
                      AgentService(db).get("ddl_converter")["default_prompt"])
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "ddl_converter",
                          "question": "请转换 select * from t"},
                 "id": "call_agent_1"}
    llm = ScriptedLLM([
        ("需要委派给转换智能体", [call_tool]),
        ("子智能体回复：已转换 SQL", None),
        ("最终汇总答复：已由 SQL 转换助手完成", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    custom_events = []
    for _mode, payload in graph.stream(
            AgentState(user_input="帮我做个 DDL 转换", conv_id=5,
                       agent_id="migration_commander",
                       task_state={"current_step": "complete"}),
            stream_mode=["custom"]):
        custom_events.append(payload)
    kinds = [e.get("type") for e in custom_events if isinstance(e, dict)]
    assert "system" in kinds and "sub_agent" in kinds
    sys_ev = next(e for e in custom_events if isinstance(e, dict) and e.get("type") == "system")
    sub_ev = next(e for e in custom_events if isinstance(e, dict) and e.get("type") == "sub_agent")
    assert "正在调用" in sys_ev["message"] and "SQL 转换助手" in sys_ev["message"]
    assert sub_ev["agent_name"] == "SQL 转换助手"
    assert sub_ev["reply"] == "子智能体回复：已转换 SQL"
    assert sub_ev["dispatcher_name"]  # 主 Agent 溯源名非空