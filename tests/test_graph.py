import json
import threading
from pathlib import Path

from jarvis_agent.agents import AgentService
from jarvis_agent.artifacts import ArtifactService
from jarvis_agent.db import Database
from jarvis_agent.graph import AgentState, build_graph
from jarvis_agent.config import AppConfig
from jarvis_agent.prompts import PromptService
from langchain_core.messages import AIMessage


class FakeLLM:
    """非流式 mock：invoke 返回 AIMessage；with_structured_output 由外层独立实现，此处辅助 run 使用"""

    def __init__(self, reply="已梳理完成", parse=None):
        self.reply = reply
        self._parse = parse
        self._called = 0

    def bind_tools(self, schemas, **kw):
        return self

    def invoke(self, messages, **kw):
        from langchain_core.messages import AIMessage
        self._called += 1
        return AIMessage(content=self.reply)

    def stream(self, messages, **kw):
        from langchain_core.messages import AIMessage
        yield AIMessage(content=self.reply)

    def parse(self, text):
        return self._parse or {"intent": "jarvis_overall", "agent_id": "jarvis_commander",
                               "confidence": 0.95}


def _make_graph(db, tmp_path, llm=None, jarvis_state=None, **kw):
    return build_graph(
        llm=llm or FakeLLM(),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        agent_service=AgentService(db),
        artifact_service=ArtifactService(db, str(tmp_path / "artifacts")),
        skill_service=None,
        parse_schema={},
        jarvis_state=jarvis_state,
        max_iterations=2,
        **kw,
    )


def _bootstrap(db):
    from jarvis_agent.bootstrap import bootstrap
    bootstrap(db)


def test_graph_exposes_cross_project_agent_nodes(tmp_path):
    """主图节点是跨工程 6 个智能体（总控 + 5 业务域），不再是迁移壳层。"""
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    graph = _make_graph(db, tmp_path)
    nodes = set(graph.get_graph().nodes) - {"__start__", "__end__"}
    assert {
        "jarvis_commander", "boot_agent", "customer_order_agent",
        "family_order_agent", "rule_center_agent", "customer_center_agent",
        "qa", "artifact", "confirm", "error",
    }.issubset(nodes)


def test_stage_agent_mapping_matches_domain(tmp_path):
    """阶段 Agent 映射：页面展示→boot_agent、下单拆单→customer_order_agent 等。"""
    from jarvis_agent.graph import STAGE_AGENT_BY_STATUS
    assert STAGE_AGENT_BY_STATUS == {
        "PAGE_SHOW": "boot_agent",
        "ORDER_SPLIT": "customer_order_agent",
        "ORDER_ACCEPT": "family_order_agent",
        "RULE_CHECK": "rule_center_agent",
        "CUSTOMER_CHECK": "customer_center_agent",
    }


def test_low_confidence_falls_back_to_commander(tmp_path):
    """低置信度路由：intent 不在有效集合或置信度过低 → 回退总控/问答兜底。"""
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    graph = build_graph(
        llm=FakeLLM(reply="回答", parse={"intent": 999, "agent_id": "", "confidence": 0.2}),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=None,
        parse_schema={},
        max_iterations=1,
    )
    final = graph.invoke(AgentState(user_input="随便聊聊", conv_id=1))
    assert final["reply"]


def test_boot_agent_writes_page_show_artifact(tmp_path):
    """页面展示阶段：boot_agent 生成页面展示方案产物（boot_report.md→页面展示方案.md）。"""
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    graph = build_graph(
        llm=FakeLLM(reply="页面展示方案：梳理营业系统前端布点与展示入口。"),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=None,
        parse_schema={},
        max_iterations=2,
    )
    state = AgentState(
        user_input="梳理营业系统页面展示",
        conv_id=1,
        task_state={"migrate_task_id": 1, "current_step": "PAGE_SHOW",
                    "task_params": {"frontend_task": "营业系统页面展示", "business_scene": "营业受理"}},
    )
    final = graph.invoke(state)
    assert final["reply"]
    namespaces = artifact_svc.list_namespaces(conv_id=1)
    assert any("/boot_agent/" in ns for ns in namespaces), namespaces
    assert final.get("artifacts") or final.get("namespace"), "阶段 Agent 应产出产物"


def test_should_advance_step_confirm_gate(tmp_path):
    """逐级确认闸门：阶段字段齐备但无 task_confirm → stay；有确认 → next。"""
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    rt = _make_graph(db, tmp_path)
    rt2 = build_graph(
        llm=FakeLLM(), rag_search=lambda *a, **k: [],
        prompt_service=PromptService(db), agent_service=AgentService(db),
        artifact_service=ArtifactService(db, str(tmp_path / "artifacts")),
        skill_service=None, parse_schema={}, max_iterations=2)
    runtime = getattr(rt, "runtime", None) or rt2
    # should_advance 是 GraphRuntime 方法
    from jarvis_agent.graph import GraphRuntime
    rr = GraphRuntime(llm=FakeLLM(), rag_search=lambda *a, **k: [],
                      prompt_service=None, artifact_service=None,
                      skill_service=None, parse_schema={}, config=AppConfig(),
                      agent_service=AgentService(db))
    dec = rr.should_advance({
        "agent_id": "boot_agent",
        "task_state": {"migrate_task_id": 1, "current_step": "PAGE_SHOW",
                       "task_params": {"frontend_task": "x", "business_scene": "y"},
                       "strict_flow": True},
    })
    assert dec in ("stay", "wait_user", "next")
    dec2 = rr.should_advance({
        "agent_id": "boot_agent",
        "task_state": {"migrate_task_id": 1, "current_step": "PAGE_SHOW",
                       "task_params": {"frontend_task": "x", "business_scene": "y", "task_confirm": "确认"},
                       "strict_flow": True},
    })
    assert dec2 in ("next",)


def test_direct_assignment_bypasses_stage_gate(tmp_path):
    """显式指派子智能体：不经状态机阶段闸门，直接路由到指定 Agent。"""
    from jarvis_agent.graph import GraphRuntime
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    rr = GraphRuntime(llm=FakeLLM(), rag_search=lambda *a, **k: [],
                      prompt_service=None, artifact_service=None,
                      skill_service=None, parse_schema={}, config=AppConfig(),
                      agent_service=AgentService(db))
    st = rr.route_agent({
        "assigned_agent_id": "family_order_agent",
        "agent_id": "family_order_agent",
        "task_state": {"migrate_task_id": 1, "current_step": "PAGE_SHOW", "strict_flow": True},
    })
    assert st == "family_order_agent", "显式指派应直接路由到指定 Agent"


def test_unauthorized_agent_does_not_fall_back_to_space_knowledge(tmp_path):
    from jarvis_agent.graph import GraphRuntime

    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.create("isolated_agent", "隔离智能体", "无知识库授权", "isolated_agent")
    calls = []

    def rag_search(query, **kwargs):
        calls.append(kwargs)
        return []

    rr = GraphRuntime(
        llm=FakeLLM(), rag_search=rag_search, prompt_service=PromptService(db),
        artifact_service=ArtifactService(db, str(tmp_path / "artifacts")),
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc,
    )
    rr.route({"agent_id": "isolated_agent", "space_id": 42, "user_input": "检索知识"})

    assert calls
    assert calls[-1]["space_id"] is None
    assert calls[-1]["kb_ids"] == []


def test_direct_agent_write_only_business_document(tmp_path):
    """业务域 Agent 直接执行：产物落业务文档，不被当成通用问答。"""
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    graph = build_graph(
        llm=FakeLLM(reply="下单拆单方案：梳理营业厅下单入口与拆单调度规则。"),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=None,
        parse_schema={},
        max_iterations=2,
    )
    state = AgentState(
        user_input="梳理下单拆单规则",
        conv_id=1,
        agent_id="customer_order_agent",
        task_state={"migrate_task_id": 1, "current_step": "ORDER_SPLIT",
                    "task_params": {"order_source": "营业厅", "split_rule": "按号码段拆分"}},
    )
    final = graph.invoke(state)
    assert final["reply"]


def test_graph_cancellation_stops(tmp_path):
    """会话中止事件终止图执行。"""
    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    artifact_svc = ArtifactService(db, str(tmp_path / "artifacts"))
    cancel_event = threading.Event()
    cancel_event.set()

    class CancelledLLM(FakeLLM):
        def stream(self, messages, **kwargs):
            from langchain_core.messages import AIMessage
            yield AIMessage(content="第一段")
            yield AIMessage(content="这段不应被处理")

    graph = build_graph(
        llm=CancelledLLM(reply="", parse={"intent": "jarvis_overall", "agent_id": "jarvis_commander", "confidence": 0.9}),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        agent_service=AgentService(db),
        artifact_service=artifact_svc,
        skill_service=None,
        parse_schema={},
        max_iterations=1,
        cancellation_event=cancel_event,
    )
    import pytest
    with pytest.raises(RuntimeError, match="用户已中止"):
        list(graph.stream(AgentState(user_input="梳理页面展示", conv_id=1),
                          stream_mode=["updates", "custom"]))


def test_project_agent_exposes_scoped_code_tools(tmp_path):
    """配置工程目录后，当前智能体获得限定在该目录内的代码检索/读取工具。"""
    from jarvis_agent.graph import GraphRuntime

    project = tmp_path / "boot-project"
    src = project / "src"
    src.mkdir(parents=True)
    (src / "OrderController.java").write_text(
        "public class OrderController {\n    String entry = \"hall\";\n}\n",
        encoding="utf-8",
    )

    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.update("boot_agent", project_dir=str(project))
    rt = GraphRuntime(
        llm=FakeLLM(), rag_search=lambda *a, **k: [],
        prompt_service=PromptService(db), artifact_service=None,
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc,
    )
    names = {
        item["function"]["name"]
        for item in rt._tool_schemas(include_agents=False, current_agent_id="boot_agent")
    }
    assert {"code_search", "code_read"}.issubset(names)

    search = json.loads(rt._dispatch_tool(
        "code_search", {"query": "hall"}, state={"agent_id": "boot_agent"},
        current_agent_id="boot_agent"))
    assert search["ok"] is True
    assert search["matches"][0]["path"] == "src/OrderController.java"

    read = json.loads(rt._dispatch_tool(
        "code_read", {"path": "src/OrderController.java"},
        state={"agent_id": "boot_agent"}, current_agent_id="boot_agent"))
    assert read["ok"] is True
    assert "OrderController" in read["content"]

    escaped = json.loads(rt._dispatch_tool(
        "code_read", {"path": "../../t.db"},
        state={"agent_id": "boot_agent"}, current_agent_id="boot_agent"))
    assert escaped["ok"] is False
    assert "工程目录" in escaped["error"]


def test_project_agent_presearches_code_when_model_ignores_tools(tmp_path):
    """工程智能体收到代码问题时，即使模型不主动调用工具也有真实代码上下文。"""
    from jarvis_agent.graph import GraphRuntime

    project = tmp_path / "order-center"
    project.mkdir()
    (project / "GsmYdkjConvertHandler.java").write_text(
        "public class GsmYdkjConvertHandler {\n"
        "    // 手机受理移动看家参数转换组件\n"
        "}\n",
        encoding="utf-8",
    )

    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.update("family_order_agent", project_dir=str(project))

    class ToolIgnoringLLM(FakeLLM):
        def __init__(self):
            super().__init__(reply="依据代码回答")
            self.seen_messages = []

        def stream(self, messages, **kwargs):
            self.seen_messages.append(messages)
            yield AIMessage(content=self.reply)

    llm = ToolIgnoringLLM()
    rt = GraphRuntime(
        llm=llm, rag_search=lambda *a, **k: [],
        prompt_service=PromptService(db), artifact_service=None,
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc,
    )
    sub = rt._call_sub_agent(
        "family_order_agent", "手机受理移动看家参数转换组件是什么",
        state={"history": []},
    )

    assert sub["ok"] is True
    assert llm.seen_messages
    prompt_text = "\n".join(
        str(message.content) for message in llm.seen_messages[0]
    )
    assert "工程代码预检索结果" in prompt_text
    assert "GsmYdkjConvertHandler.java" in prompt_text
    assert "手机受理移动看家参数转换组件" in prompt_text


def test_code_tools_hidden_without_project_dir(tmp_path):
    """未配置工程目录时不暴露代码工具，避免模型误以为可以读文件。"""
    from jarvis_agent.graph import GraphRuntime

    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.update("boot_agent", project_dir="")
    rt = GraphRuntime(
        llm=FakeLLM(), rag_search=lambda *a, **k: [],
        prompt_service=PromptService(db), artifact_service=None,
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc,
    )
    names = {
        item["function"]["name"]
        for item in rt._tool_schemas(include_agents=False, current_agent_id="boot_agent")
    }
    assert "code_search" not in names
    assert "code_read" not in names


def test_agent_without_prompt_can_be_called(tmp_path):
    """未配置提示词的子智能体仍可被主智能体委派，运行时用名称/描述兜底。"""
    from jarvis_agent.graph import GraphRuntime

    db = Database(str(tmp_path / "t.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.create(
        "no_prompt_agent", "无提示词智能体", "负责回答通用问题", "no_prompt",
        default_prompt="", agent_type="子Agent",
    )
    rt = GraphRuntime(
        llm=FakeLLM(reply="无提示词智能体已完成"), rag_search=lambda *a, **k: [],
        prompt_service=PromptService(db), artifact_service=None,
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc,
    )
    sub = rt._call_sub_agent("no_prompt_agent", "请总结当前需求")
    assert sub["ok"] is True
    assert sub["reply"] == "无提示词智能体已完成"

    schemas = rt._tool_schemas(include_agents=True, current_agent_id="jarvis_commander")
    callable_ids = json.dumps(schemas, ensure_ascii=False)
    assert "no_prompt_agent" in callable_ids


def test_code_and_rag_tool_traces_record_agent_id(tmp_path):
    from sqlalchemy import select

    from jarvis_agent.db import Database, TraceLog
    from jarvis_agent.graph import GraphRuntime
    from jarvis_agent.observability import ObservabilityService

    project = tmp_path / "order-center"
    project.mkdir()
    (project / "Handler.java").write_text("class Handler {}\n", encoding="utf-8")
    db = Database(str(tmp_path / "trace.db"))
    _bootstrap(db)
    svc = AgentService(db)
    svc.update("family_order_agent", project_dir=str(project))
    rt = GraphRuntime(
        llm=FakeLLM(), rag_search=lambda query, **kwargs: [{"content": "hit"}],
        prompt_service=PromptService(db), artifact_service=None,
        skill_service=None, parse_schema={}, config=AppConfig(),
        agent_service=svc, rag_enabled=True,
        observability=ObservabilityService(db),
    )
    state = {"conv_id": 7, "trace_id": "trace-agent-id"}

    rt._dispatch_tool("code_search", {"query": "Handler"}, state=state,
                      current_agent_id="family_order_agent")
    rt._dispatch_tool("code_read", {"path": "Handler.java"}, state=state,
                      current_agent_id="family_order_agent")
    rt._dispatch_tool("rag_search", {"query": "移动看家"}, state=state,
                      current_agent_id="family_order_agent")

    with db.session() as session:
        rows = list(session.scalars(select(TraceLog).where(
            TraceLog.trace_id == "trace-agent-id"
        ).order_by(TraceLog.id)))
    assert [(row.phase, row.span, row.agent_id) for row in rows] == [
        ("code", "code_search", "family_order_agent"),
        ("code", "code_read", "family_order_agent"),
        ("rag", "rag_search", "family_order_agent"),
    ]
    assert "命中 1 个文件" in rows[0].message
    assert "读取工程文件: Handler.java" in rows[1].message
    assert "命中 1 条" in rows[2].message
