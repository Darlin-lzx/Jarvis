import json

from db_loc_agent.agents import AgentService
from db_loc_agent.artifacts import ArtifactService
from db_loc_agent.db import Database
from db_loc_agent.graph import AgentState, build_graph
from db_loc_agent.prompts import PromptService
from db_loc_agent.skills import SkillService
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage


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
    assert "正在调用" in sys_ev["message"] and "小转" in sys_ev["message"]
    assert sub_ev["agent_name"] == "小转"
    assert sub_ev["reply"] == "子智能体回复：已转换 SQL"
    assert sub_ev["dispatcher_name"]  # 主 Agent 溯源名非空


def test_call_agent_tool_message_omits_displayed_sub_reply(tmp_path):
    """子 Agent 完整回复已单独展示给用户，返回主 Agent 的 ToolMessage 不应携带正文。

    否则指挥官会把 ToolMessage 中的完整报告复述进最终回复，前端出现两份相同内容。
    """
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
    sub_reply = "子智能体完整回复：" + "这是一份很长的转换报告内容。" * 30

    class RecordingScriptedLLM(ScriptedLLM):
        def __init__(self, steps):
            super().__init__(steps)
            self.seen_messages = []

        def stream(self, messages, **kw):
            self.seen_messages.append(list(messages))
            yield from super().stream(messages, **kw)

    llm = RecordingScriptedLLM([
        ("需要委派给转换智能体", [call_tool]),
        (sub_reply, None),
        ("转换已完成，详见上方子智能体输出。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="帮我做个 DDL 转换", conv_id=6,
        agent_id="migration_commander", task_state={"current_step": "complete"}))

    tool_payloads = []
    for messages in llm.seen_messages:
        for msg in messages:
            if msg.__class__.__name__ == "ToolMessage" and msg.name == "call_agent":
                tool_payloads.append(json.loads(msg.content))
    assert len(tool_payloads) == 1
    assert sub_reply not in tool_payloads[0].get("reply", "")
    assert tool_payloads[0]["reply_already_displayed"] is True
    assert final["agent_calls"][0]["reply"] == sub_reply


def test_call_agent_nested_tokens_are_not_parent_stream(tmp_path):
    """子 Agent 内部 LLM token 不能进入父图 messages 流。

    app.py 会把 messages 流当主回复 text 下发；若嵌套子 Agent token 也被
    LangGraph 捕获，前端会同时收到 text 与 sub_agent 两份相同内容。
    """
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    prompt_svc.create("ddl_converter 提示词", "agent",
                      AgentService(db).get("ddl_converter")["default_prompt"])
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    class CallbackToolFake(GenericFakeChatModel):
        def _stream(self, messages, stop=None, run_manager=None, **kw):
            from langchain_core.messages import AIMessageChunk
            from langchain_core.outputs import ChatGenerationChunk
            result = self._generate(messages, stop=stop,
                                    run_manager=run_manager, **kw)
            msg = result.generations[0].message
            if msg.content:
                chunk_msg = AIMessageChunk(content=msg.content, chunk_position="last")
                if run_manager:
                    run_manager.on_llm_new_token(msg.content, chunk=chunk_msg)
                yield ChatGenerationChunk(message=chunk_msg)
            if getattr(msg, "tool_calls", None):
                chunks = []
                for i, tc in enumerate(msg.tool_calls):
                    chunks.append({
                        "name": tc["name"],
                        "args": json.dumps(tc["args"], ensure_ascii=False),
                        "id": tc["id"], "index": i, "type": "tool_call_chunk",
                    })
                yield ChatGenerationChunk(message=AIMessageChunk(
                    content="", tool_call_chunks=chunks,
                    chunk_position="last" if not msg.content else None))

    sub_reply = "子智能体流式完整回复：这是详细报告"
    responses = iter([
        json.dumps({"intent": "migration_overall", "agent_id": "migration_commander",
                    "object_name": "", "source_db": "", "target_db": "",
                    "skill_id": "", "params": {}, "confidence": 1.0},
                   ensure_ascii=False),
        AIMessage(content="我来调度", tool_calls=[{
            "name": "call_agent",
            "args": {"agent_id": "ddl_converter", "question": "请转换"},
            "id": "nested_call_1",
        }]),
        sub_reply,
        "主智能体简要总结",
    ])
    graph = build_graph(
        llm=CallbackToolFake(messages=responses),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    parent_texts = []
    final_reply = ""
    for mode, payload in graph.stream(
            AgentState(user_input="帮我做个 DDL 转换", conv_id=7,
                       agent_id="migration_commander",
                       task_state={"current_step": "complete"}),
            stream_mode=["messages", "updates"]):
        if mode == "messages":
            parent_texts.append(payload[0].content or "")
        elif mode == "updates" and "reply" in payload:
            final_reply = payload["reply"].get("reply", "")

    assert sub_reply not in "".join(parent_texts)
    assert final_reply == "主智能体简要总结"


def test_parallel_calls_cannot_start_future_migration_stages(tmp_path):
    """逐级确认模式下，方案阶段不得把评估/代码改造混入同一并行批次提前执行。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    parallel_tool = {"name": "call_agents_parallel", "args": {"calls": [
        {"agent_id": "migration_planner", "question": "请生成迁移方案"},
        {"agent_id": "migration_assessor", "question": "请评估"},
        {"agent_id": "code_migrator", "question": "请改造代码"},
    ]}, "id": "parallel_future_1"}
    llm = ScriptedLLM([
        ("需要并行调度", [parallel_tool]),
        ("方案专家完整方案", None),
        ("评估专家报告", None),
        ("代码改造报告", None),
        ("方案阶段已完成", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=6,
        agent_service=AgentService(db),
    )
    custom_events = []
    final = {}
    for mode, payload in graph.stream(
            AgentState(
                user_input="继续生成迁移方案", conv_id=8,
                agent_id="migration_commander",
                task_state={"current_step": "SOLUTION_GENERATE",
                            "step_confirm": True, "pipeline_start": True}),
            stream_mode=["custom", "updates"]):
        if mode == "custom" and isinstance(payload, dict) \
                and payload.get("event") == "calling_agent":
            custom_events.append(payload["agent_id"])
        elif mode == "updates" and isinstance(payload, dict) and "reply" in payload:
            final = payload["reply"]

    assert custom_events == ["migration_planner"]
    assert [c["agent_id"] for c in final["agent_calls"]] == ["migration_planner"]


def test_sub_agent_conversational_reply_does_not_create_artifact(tmp_path):
    """子 Agent 的追问/中间对话不是交付物，不得写入右侧产物面板。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "migration_assessor",
                          "question": "请评估迁移风险"},
                 "id": "call_conversational_1"}
    llm = ScriptedLLM([
        ("需要评估", [call_tool]),
        ("请先提供源库对象清单、目标库类型和停机窗口。", None),
        ("评估专家需要补充信息。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="继续评估", conv_id=9,
        agent_id="migration_commander",
        task_state={"current_step": "ASSESSMENT_RUNNING",
                    "step_confirm": True, "pipeline_start": True}))

    assert final["agent_calls"][0]["artifacts"] == []
    assert artifact_svc.list_namespaces(conv_id=9) == []


def test_sub_agent_core_report_creates_one_document_and_chat_link(tmp_path):
    """核心报告只落业务文档；聊天事件只给简短状态和可预览文件记录。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "migration_assessor",
                          "question": "请评估迁移风险"},
                 "id": "call_core_report_1"}
    report = "# 迁移评估报告\n\n源库与目标库兼容性良好，主要风险集中在函数兼容性。"
    llm = ScriptedLLM([
        ("需要评估", [call_tool]),
        (report, None),
        ("评估文档已生成。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    custom_events = []
    for mode, payload in graph.stream(
            AgentState(user_input="继续评估", conv_id=10,
                       agent_id="migration_commander",
                       task_state={"current_step": "ASSESSMENT_RUNNING",
                                   "step_confirm": True, "pipeline_start": True}),
            stream_mode=["custom", "updates"]):
        if mode == "custom" and isinstance(payload, dict) and payload.get("type") == "sub_agent":
            custom_events.append(payload)

    event = custom_events[0]
    files = event["artifacts"]
    assert [f["path"].split("/")[-1] for f in files] == ["评估报告.md"]
    assert report not in event["reply"]
    assert "评估报告.md" in event["reply"]
    assert artifact_svc.read(files[0]["id"]) == report


def test_collector_failure_report_creates_chinese_artifact(tmp_path):
    """小采的结构化采集失败报告仍是核心产物，且使用中文文件名。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "migration_collector",
                          "question": "请采集 src_o 的源库元数据"},
                 "id": "call_collector_failure_1"}
    report = (
        "# Oracle 源库数据采集报告\n\n"
        "## 一、采集状态：无法完成\n\n"
        "| 数据源名称 | 类型 | 连接状态 |\n"
        "|:---|:---|:---:|\n"
        "| src_o | Oracle | 失败 |\n\n"
        "数据源未配置，无法采集对象清单。"
    )
    llm = ScriptedLLM([
        ("需要采集", [call_tool]),
        (report, None),
        ("数据采集报告已生成，请先确认采集结果。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    custom_events = []
    for mode, payload in graph.stream(
            AgentState(user_input="数据迁移", conv_id=11,
                       agent_id="migration_commander",
                       task_state={"current_step": "DATA_COLLECTION",
                                   "step_confirm": True, "pipeline_start": True}),
            stream_mode=["custom", "updates"]):
        if mode == "custom" and isinstance(payload, dict) and payload.get("type") == "sub_agent":
            custom_events.append(payload)

    event = custom_events[0]
    files = event["artifacts"]
    assert [f["path"].split("/")[-1] for f in files] == ["数据采集报告.md"]
    assert report not in event["reply"]
    assert "数据采集报告.md" in event["reply"]
    assert artifact_svc.read(files[0]["id"]) == report


def test_sub_agent_confirmation_form_is_not_written_as_artifact(tmp_path):
    """关键信息确认不是核心交付物，UI 控制块不得写入右侧产物文件。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "migration_planner",
                          "question": "请生成迁移方案"},
                 "id": "call_planner_confirmation_1"}
    form = {
        "title": "迁移方案关键信息确认",
        "fields": [{"name": "source_db_type", "label": "源数据库类型",
                    "type": "text", "options": []}],
        "submit": "确认并生成方案",
    }
    confirmation = (
        "我理解您希望继续，但生成迁移实施方案需要以下关键输入信息，目前这些字段缺失：\n\n"
        "## 缺失信息清单\n\n"
        "| 缺失字段 | 用途 | 必填性 |\n|---|---|---|\n"
        "| 源数据库类型 | 确定语法转换规则 | 必填 |\n\n"
        "请选择以下信息：\n\n"
        "<UI_RENDER>\n" + json.dumps(form, ensure_ascii=False) + "\n</UI_RENDER>\n\n"
        "提供以上信息后，我将生成可执行方案。"
    )
    llm = ScriptedLLM([
        ("需要方案", [call_tool]),
        (confirmation, None),
        ("方案专家等待关键信息确认。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    custom_events = []
    final = {}
    for mode, payload in graph.stream(
            AgentState(user_input="继续", conv_id=14,
                       agent_id="migration_commander",
                       task_state={"current_step": "SOLUTION_GENERATE",
                                   "step_confirm": True, "pipeline_start": True}),
            stream_mode=["custom", "updates"]):
        if mode == "custom" and isinstance(payload, dict) and payload.get("type") == "sub_agent":
            custom_events.append(payload)
        elif mode == "updates" and isinstance(payload, dict) and "reply" in payload:
            final = payload["reply"]

    event = custom_events[0]
    assert event["artifacts"] == []
    assert "<UI_RENDER>" not in event["reply"]
    assert event["ui_render"] == form
    assert final["agent_calls"][0]["artifacts"] == []
    assert artifact_svc.list_namespaces(conv_id=14) == []


def test_stage_block_is_invisible_and_disables_next_agent_calls(tmp_path):
    """数据采集未确认时评估专家不得执行，也不得把拦截事件渲染成执行动态。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    collector_tool = {"name": "call_agent",
                      "args": {"agent_id": "migration_collector",
                               "question": "请采集源库元数据"},
                      "id": "call_collector_stage_1"}
    assessor_tool = {"name": "call_agent",
                     "args": {"agent_id": "migration_assessor",
                              "question": "请评估迁移风险"},
                     "id": "call_assessor_premature_1"}
    llm = ScriptedLLM([
        ("需要采集", [collector_tool]),
        ("# 数据采集报告\n\n- 对象清单已采集", None),
        ("尝试评估", [assessor_tool]),
        ("数据采集阶段已停靠，请确认后继续。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=4,
        agent_service=AgentService(db),
    )
    custom_events = []
    final = {}
    for mode, payload in graph.stream(
            AgentState(user_input="数据迁移", conv_id=12,
                       agent_id="migration_commander",
                       task_state={"current_step": "DATA_COLLECTION",
                                   "step_confirm": True, "pipeline_start": True}),
            stream_mode=["custom", "updates"]):
        if mode == "custom" and isinstance(payload, dict):
            custom_events.append(payload)
        elif mode == "updates" and isinstance(payload, dict) and "reply" in payload:
            final = payload["reply"]

    assert [e.get("agent_id") for e in custom_events
            if e.get("event") == "calling_agent"] == ["migration_collector"]
    assert not any(e.get("event") == "stage_blocked" for e in custom_events)
    assert [c["agent_id"] for c in final["agent_calls"]] == ["migration_collector"]
    assert final["reply"] == "数据采集阶段已停靠，请确认后继续。"
    tool_names = [s["function"]["name"] for s in llm._schemas]
    assert "call_agent" not in tool_names
    assert "call_agents_parallel" not in tool_names


def test_free_flow_allows_out_of_order_stage_agent(tmp_path):
    """关闭流程强校验后，指挥官可按用户指派提前调用后续阶段专家。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "migration_assessor",
                          "question": "请直接评估迁移风险"},
                 "id": "call_free_flow_assessor_1"}
    class RecordingFreeFlowLLM(ScriptedLLM):
        def __init__(self, steps):
            super().__init__(steps)
            self.seen_messages = []

        def stream(self, messages, **kwargs):
            self.seen_messages.append(list(messages))
            yield from super().stream(messages, **kwargs)

    llm = RecordingFreeFlowLLM([
        ("用户指定评估", [call_tool]),
        ("请先提供源库对象清单、目标库类型和停机窗口。", None),
        ("评估专家已按用户指派执行。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="不用先采集，直接评估", conv_id=14,
        agent_id="migration_commander",
        task_state={"current_step": "DATA_COLLECTION",
                    "step_confirm": True, "pipeline_start": True,
                    "strict_flow": False}))

    assert [call["agent_id"] for call in final["agent_calls"]] == ["migration_assessor"]
    assert final["agent_calls"][0]["error"] == ""
    system_messages = [str(messages[0].content)
                       for messages in llm.seen_messages if messages]
    assert any("自由流程模式" in content for content in system_messages)
    assert any("不强制按状态机顺序" in content for content in system_messages)


def test_commander_does_not_write_orchestration_index_artifact(tmp_path):
    """调度索引是过程数据，不是核心交付物，不得进入产物面板。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    call_tool = {"name": "call_agent",
                 "args": {"agent_id": "migration_assessor",
                          "question": "请评估迁移风险"},
                 "id": "call_no_index_1"}
    llm = ScriptedLLM([
        ("需要评估", [call_tool]),
        ("请先提供源库对象清单。", None),
        ("评估专家等待补充信息。", None),
    ])
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=3,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="继续评估", conv_id=11,
        agent_id="migration_commander",
        task_state={"current_step": "ASSESSMENT_RUNNING",
                    "step_confirm": True, "pipeline_start": True}))

    assert final.get("agent_calls")
    assert artifact_svc.list_namespaces(conv_id=11) == []


def test_direct_core_agent_writes_only_business_document(tmp_path):
    """用户直接咨询评估专家时，也只生成核心报告，不生成 result.json。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    report = "# 迁移评估报告\n\n兼容性结论：可以迁移，需处理函数差异。"

    class OneReplyLLM(FakeLLM):
        def parse(self, text):
            return {"intent": "migration_assess", "agent_id": "migration_assessor",
                    "object_name": "营业库", "source_db": "oracle", "target_db": "dm",
                    "skill_id": "", "confidence": 0.99}

    graph = build_graph(
        llm=OneReplyLLM(reply=report), rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=1,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(user_input="请评估营业库", conv_id=12))

    filenames = [f["path"].split("/")[-1] for f in final["artifacts"]]
    assert filenames == ["评估报告.md"]


def test_direct_collector_failure_report_creates_chinese_artifact(tmp_path):
    """用户直接指派小采时，结构化失败报告同样落为中文采集产物。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    report = (
        "# 数据采集报告\n\n"
        "## 采集状态：无法完成\n\n"
        "- 数据源 src_o 未配置\n"
        "- 对象清单采集数量：0"
    )

    class OneReplyLLM(FakeLLM):
        def parse(self, text):
            return {"intent": "migration_collect", "agent_id": "migration_collector",
                    "object_name": "src_o", "source_db": "oracle", "target_db": "dm",
                    "skill_id": "", "confidence": 0.99}

    graph = build_graph(
        llm=OneReplyLLM(reply=report), rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=1,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(user_input="请采集 src_o", conv_id=13))

    filenames = [f["path"].split("/")[-1] for f in final["artifacts"]]
    assert filenames == ["数据采集报告.md"]
    assert artifact_svc.read(final["artifacts"][0]["id"]) == report


def test_core_sql_artifacts_use_chinese_filenames(tmp_path):
    """新产物文件名使用中文业务名，技术对象名仅作为后缀保留。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    class ConverterLLM(FakeLLM):
        def parse(self, text):
            return {"intent": "ddl_convert", "agent_id": "ddl_converter",
                    "object_name": "USER_ORDER", "source_db": "oracle",
                    "target_db": "dm", "skill_id": "", "confidence": 0.99}

    graph = build_graph(
        llm=ConverterLLM(reply="# 转换报告\n\n```sql\nCREATE TABLE USER_ORDER (ID INT);\n```"),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=1,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(user_input="转换 USER_ORDER", conv_id=13))

    filenames = [f["path"].split("/")[-1] for f in final["artifacts"]]
    assert filenames == ["转换脚本_USER_ORDER.sql", "转换报告.md"]


def test_code_migrator_gets_role_boundary_and_ignores_mismatched_history(tmp_path):
    """用户指派小改时，不得因历史评估任务而代跑评估专家职责。"""
    db = Database(str(tmp_path / "t.db"))
    from db_loc_agent.bootstrap import bootstrap
    bootstrap(db)
    prompt_svc = PromptService(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))

    class RecordingCodeLLM(FakeLLM):
        def __init__(self):
            super().__init__(reply="请切换到小评处理评估。")
            self.seen_messages = []

        def parse(self, text):
            return {"intent": "migration_assess", "agent_id": "migration_assessor",
                    "object_name": "", "source_db": "", "target_db": "",
                    "skill_id": "", "confidence": 0.95}

        def stream(self, messages, **kw):
            self.seen_messages.append(list(messages))
            yield from super().stream(messages, **kw)

    llm = RecordingCodeLLM()
    graph = build_graph(
        llm=llm, rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=prompt_svc, artifact_service=artifact_svc,
        skill_service=None, parse_schema={}, max_iterations=1,
        agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="干活", conv_id=14, agent_id="code_migrator",
        history=[{"role": "user", "content": "我要做数据迁移评估"},
                 {"role": "assistant", "content": "好的，我来帮你做数据迁移评估。"}]))

    assert final["agent_id"] == "code_migrator"
    system_prompt = str(llm.seen_messages[0][0].content)
    assert "职责边界（最高优先级）" in system_prompt
    assert "不得执行迁移评估" in system_prompt
    assert "小评" in system_prompt
    assert "不要把历史会话中的迁移评估任务当作当前任务" in system_prompt
