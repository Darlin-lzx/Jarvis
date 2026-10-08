import json
import asyncio

from fastapi.testclient import TestClient

from db_loc_agent.app import create_app


class FakeEmbedding:
    """确定性向量：按文本长度/序号生成，无需网络"""

    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


def _client(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama",
                                 "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"},
                         "mysql_url": ""},  # 强制 SQLite 隔离，不污染生产 MySQL
        embedding_function=FakeEmbedding(),
    )
    return TestClient(app)


def test_health_and_static(tmp_path):
    c = _client(tmp_path)
    assert c.get("/api/health").json()["status"] == "ok"
    assert c.get("/").status_code == 200


def test_conversation_crud(tmp_path):
    c = _client(tmp_path)
    r = c.post("/api/conversations", json={"title": "会话A"})
    assert r.status_code == 200
    conv = r.json()["data"]
    assert conv["id"] > 0
    assert c.get("/api/conversations").json()["data"]
    assert c.delete(f"/api/conversations/{conv['id']}").json()["success"] is True


def test_default_space_endpoint_creates_and_reuses_space(tmp_path):
    c = _client(tmp_path)

    first = c.get("/api/spaces/default")
    second = c.get("/api/spaces/default")

    assert first.status_code == 200
    assert first.json()["data"]["name"] == "默认空间"
    assert first.json()["data"]["id"] == second.json()["data"]["id"]


def test_prompt_skill_pipeline(tmp_path):
    c = _client(tmp_path)
    r = c.post("/api/prompts", json={"name": "p1", "category": "agent", "content": "内容"})
    assert r.status_code == 200
    r = c.post("/api/skills", json={"name": "Oracle转换", "description": "d",
                                    "content": "规则"})
    assert r.status_code == 200
    sid = r.json()["data"]["skill_id"]
    assert c.post(f"/api/skills/{sid}/toggle", json={"enabled": True}).json()["success"] is True
    r = c.post("/api/mcp/servers", json={"name": "demo", "kind": "http",
                                         "command_or_url": "http://127.0.0.1:1"})
    assert r.status_code == 200
    assert c.get("/api/mcp/servers").json()["data"]


def test_conversation_trace_api(tmp_path):
    """trace 查询 API：空会话返回空列表，不 500"""
    c = _client(tmp_path)
    r = c.post("/api/conversations", json={"title": "trace会话"})
    cid = r.json()["data"]["id"]
    tr = c.get(f"/api/conversations/{cid}/trace")
    assert tr.status_code == 200
    assert tr.json()["success"] is True
    assert tr.json()["data"] == []


def test_chat_stream_does_not_block_other_conversation_reads(tmp_path, monkeypatch):
    """智能体同步执行期间，其他会话的打开请求不能被事件循环阻塞。"""
    import db_loc_agent.app as app_module
    from langchain_core.messages import AIMessage

    class BlockingLLM:
        def parse(self, text):
            return {"intent": "chat", "agent_id": "nl2sql_qa",
                    "object_name": "", "source_db": "", "target_db": "",
                    "skill_id": "", "confidence": 0.99}

        def bind_tools(self, schemas, **kwargs):
            return self

        def stream(self, messages, **kwargs):
            import time
            time.sleep(1)
            yield AIMessage(content="回答完成")

    monkeypatch.setattr(app_module, "create_chat_model", lambda llm_cfg: BlockingLLM())
    app = _client(tmp_path).app
    from db_loc_agent.bootstrap import bootstrap
    from db_loc_agent.db import Database
    bootstrap(Database(str(tmp_path / "t.db")))

    async def run():
        async def invoke(method: str, path: str, body: dict | None = None):
            raw_body = json.dumps(body, ensure_ascii=False).encode() if body is not None else b""
            headers = [(b"content-type", b"application/json")] if body is not None else []
            scope = {
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": method, "scheme": "http", "path": path,
                "raw_path": path.encode(), "query_string": b"", "headers": headers,
                "client": ("testclient", 123), "server": ("testserver", 80),
            }
            messages: asyncio.Queue = asyncio.Queue()
            request_sent = False
            response_done = asyncio.Event()

            async def receive():
                nonlocal request_sent
                if not request_sent:
                    request_sent = True
                    return {"type": "http.request", "body": raw_body, "more_body": False}
                await response_done.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if message["type"] == "http.response.body" and not message.get("more_body"):
                    response_done.set()
                await messages.put(message)

            app_task = asyncio.create_task(app(scope, receive, send))
            return app_task, messages, response_done

        async def create_conversation(title: str):
            task, messages, done = await invoke("POST", "/api/conversations", {"title": title})
            await asyncio.wait_for(done.wait(), timeout=1)
            chunks = []
            while not messages.empty():
                message = messages.get_nowait()
                if message["type"] == "http.response.body":
                    chunks.append(message.get("body", b""))
            payload = json.loads(b"".join(chunks))
            task.cancel()
            return payload["data"]["id"]

        busy = await create_conversation("运行中")
        other = await create_conversation("待打开")

        chat_task, chat_messages, chat_done = await invoke("POST", "/api/chat/stream", {
            "message": "普通问答", "conv_id": busy, "agent_id": "nl2sql_qa"})
        while True:
            message = await asyncio.wait_for(chat_messages.get(), timeout=2)
            if (message["type"] == "http.response.body"
                    and b'"type": "parse"' in message.get("body", b"")):
                break

        get_task, get_messages, get_done = await invoke("GET", f"/api/conversations/{other}")
        await asyncio.wait_for(get_done.wait(), timeout=0.5)
        get_task.cancel()
        chat_task.cancel()

    asyncio.run(run())


def test_commander_does_not_rewrap_sub_agent_artifact_card(tmp_path, monkeypatch):
    """指挥官编排时，子 Agent 产物只能由子 Agent 发一次，主回复保留简要总结。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module
    from db_loc_agent.bootstrap import bootstrap
    from db_loc_agent.db import Database

    artifact = {
        "id": 501,
        "namespace": "sess/collector/src",
        "conv_id": 1,
        "agent_id": "migration_collector",
        "path": "/tmp/数据采集报告.md",
    }

    class FakeGraph:
        def stream(self, initial, stream_mode=None):
            yield "custom", {
                "type": "sub_agent",
                "agent_id": "migration_collector",
                "agent_name": "小采",
                "dispatcher_id": "migration_commander",
                "dispatcher_name": "小枢",
                "reply": "已生成核心产物：数据采集报告.md",
                "error": "",
                "artifacts": [artifact],
            }
            yield "updates", {
                "artifact": {
                    "artifacts": [artifact],
                    "namespace": artifact["namespace"],
                    "agent_id": "migration_commander",
                }
            }
            yield "messages", (AIMessage(content="数据采集已完成，请确认后继续评估。"), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: FakeGraph())
    bootstrap(Database(str(tmp_path / "t.db")))
    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "编排去重"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "开始迁移", "conv_id": cid,
            "agent_id": "migration_commander"}) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

    sub_cards = [e["content"] for e in events if e["type"] == "sub_agent"]
    assert len(sub_cards) == 1
    assert sub_cards[0]["agent_id"] == "migration_collector"
    assert any(e["type"] == "text" and "数据采集已完成" in e["content"]
               for e in events)


def test_chat_stream_adds_fallback_form_for_empty_confirmation(tmp_path, monkeypatch):
    """模型只说“请确认以上信息”但未给字段时，必须自动兜底出可交互表单。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module

    class EmptyConfirmationGraph:
        def stream(self, initial, stream_mode=None):
            yield "messages", (
                AIMessage(content="我需要先确认以下关键信息。\n\n请完成以上选择。"), {})

    monkeypatch.setattr(app_module, "build_graph",
                        lambda *args, **kwargs: EmptyConfirmationGraph())
    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "空确认"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "请生成迁移方案", "conv_id": cid,
            "agent_id": "migration_planner"}) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    ui_events = [e["content"] for e in events if e["type"] == "ui_render"]
    assert ui_events, "空确认必须下发 UI_RENDER，不能让用户无内容可确认"
    fields = ui_events[0].get("fields") or []
    assert fields, "兜底表单必须有具体输入字段"
    assert any("具体待确认信息" in str(field.get("label", "")) for field in fields)

    messages = c.get(f"/api/conversations/{cid}/messages").json()["data"]
    assistant = next(m for m in messages if m["role"] == "assistant")
    assert assistant["ui_render"] == ui_events[0]


def test_chat_stream_keeps_explicit_field_list_without_fallback_form(tmp_path, monkeypatch):
    """正文已逐项列出待确认字段时，不额外叠加通用兜底表单。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module

    class ExplicitFieldsGraph:
        def stream(self, initial, stream_mode=None):
            yield "messages", (AIMessage(content=(
                "请确认以下关键信息：\n"
                "1. 源数据源：营业库\n"
                "2. 目标数据库：达梦\n"
                "3. 停机窗口：4 小时\n"
                "请确认以上信息。"
            )), {})

    monkeypatch.setattr(app_module, "build_graph",
                        lambda *args, **kwargs: ExplicitFieldsGraph())
    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "明确字段"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "请确认", "conv_id": cid,
            "agent_id": "migration_planner"}) as resp:
        for line in resp.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    assert not [e for e in events if e["type"] == "ui_render"]


def test_chat_stream_exposes_sub_agent_form_once(tmp_path, monkeypatch):
    """子 Agent 输出的表单要转成 ui_render 事件，不能把控制块当正文展示。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module

    form = {
        "title": "迁移方案关键信息确认",
        "fields": [{"name": "source_db_type", "label": "源数据库类型",
                    "type": "text", "options": []}],
    }

    class SubAgentFormGraph:
        def stream(self, initial, stream_mode=None):
            yield "custom", {
                "type": "sub_agent",
                "agent_id": "migration_planner",
                "agent_name": "小方",
                "dispatcher_id": "migration_commander",
                "dispatcher_name": "小枢",
                "reply": "请补充以下关键信息：源数据库类型。",
                "error": "",
                "artifacts": [],
                "ui_render": form,
            }
            yield "messages", (
                AIMessage(content="方案专家等待关键信息确认。"), {})

    monkeypatch.setattr(app_module, "build_graph",
                        lambda *args, **kwargs: SubAgentFormGraph())
    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "子Agent表单"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "继续", "conv_id": cid,
            "agent_id": "migration_commander"}) as resp:
        for line in resp.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    assert [e["content"] for e in events if e["type"] == "ui_render"] == [form]
    sub_events = [e["content"] for e in events if e["type"] == "sub_agent"]
    assert sub_events and sub_events[0]["ui_render"] == form


def test_chat_stream_persists_rendered_form_for_history(tmp_path, monkeypatch):
    """模型输出的 UI_RENDER 需要随消息保存，刷新会话后表单不能消失。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module

    form = {
        "title": "请确认迁移范围",
        "fields": [{
            "name": "migration_scope", "label": "迁移范围",
            "type": "text", "options": [],
        }],
        "submit": "确认",
    }

    class FormGraph:
        def stream(self, initial, stream_mode=None):
            content = (
                "请确认迁移范围：\n<UI_RENDER>\n"
                + json.dumps(form, ensure_ascii=False)
                + "\n</UI_RENDER>"
            )
            yield "messages", (AIMessage(content=content), {})

    monkeypatch.setattr(app_module, "build_graph",
                        lambda *args, **kwargs: FormGraph())
    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "历史表单"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "请确认迁移范围", "conv_id": cid,
            "agent_id": "migration_planner"}) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    ui_events = [e["content"] for e in events if e["type"] == "ui_render"]
    assert ui_events == [form]
    assert all("<UI_RENDER>" not in (e.get("content") or "")
               for e in events if e["type"] == "text")

    messages = c.get(f"/api/conversations/{cid}/messages").json()["data"]
    assistant = next(m for m in messages if m["role"] == "assistant")
    assert assistant["ui_render"] == form


def test_conversation_messages_strips_historical_sub_agent_echo(tmp_path):
    """旧数据中主回复完整复述子 Agent 报告时，历史接口只返回主回复自有内容。

    子 Agent 原文仍由 trace 接口单独返回，避免历史会话渲染两份相同报告。
    """
    from db_loc_agent.db import ChatTrace, Conversation, Database, Message

    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "历史重复"}).json()["data"]["id"]
    sub_reply = "# 子智能体报告\n\n" + "这是已经单独展示过的详细内容。\n" * 20
    db = Database(str(tmp_path / "t.db"))
    with db.session() as s:
        s.add(ChatTrace(
            conv_id=cid, node="agent", agent_id="ddl_converter",
            content=json.dumps({"agent_id": "ddl_converter", "agent_name": "SQL 转换助手",
                                "reply": sub_reply}, ensure_ascii=False)))
        s.commit()
        s.add(Message(
            conv_id=cid, role="assistant", agent_id="migration_commander",
            content=f"主智能体开始调度。\n\n{sub_reply}\n\n主智能体完成总结。"))
        s.commit()

    r = c.get(f"/api/conversations/{cid}/messages")
    assert r.status_code == 200
    rows = r.json()["data"]
    assistant = next(m for m in rows if m["role"] == "assistant")
    assert sub_reply not in assistant["content"]
    assert "主智能体开始调度。" in assistant["content"]
    assert "主智能体完成总结。" in assistant["content"]


def test_direct_core_agent_stream_suppresses_report_text(tmp_path, monkeypatch):
    """直接咨询产物型 Agent 时，正文写入文件后聊天只展示可点击产物卡片。"""
    import db_loc_agent.app as app_module
    from langchain_core.messages import AIMessage

    report = "# 迁移评估报告\n\n兼容性结论：可以迁移，需处理函数差异。"

    class DirectAgentLLM:
        def parse(self, text):
            return {"intent": "migration_assess", "agent_id": "migration_assessor",
                    "object_name": "营业库", "source_db": "oracle", "target_db": "dm",
                    "skill_id": "", "confidence": 0.99}

        def bind_tools(self, schemas, **kwargs):
            return self

        def stream(self, messages, **kwargs):
            yield AIMessage(content=report)

    monkeypatch.setattr(app_module, "create_chat_model", lambda llm_cfg: DirectAgentLLM())
    c = _client(tmp_path)
    from db_loc_agent.bootstrap import bootstrap
    from db_loc_agent.db import Database
    bootstrap(Database(str(tmp_path / "t.db")))
    cid = c.post("/api/conversations", json={"title": "直接评估"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "请评估营业库", "conv_id": cid,
            "agent_id": "migration_assessor"}) as r:
        for line in r.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    texts = [e["content"] for e in events if e["type"] == "text"]
    sub_agents = [e["content"] for e in events if e["type"] == "sub_agent"]
    assert report not in "".join(texts)
    assert sub_agents, "核心产物必须以带文件记录的卡片事件下发"
    assert sub_agents[-1]["artifacts"]
    assert sub_agents[-1]["reply"] == ""

    messages = c.get(f"/api/conversations/{cid}/messages").json()["data"]
    assert all(report not in (m.get("content") or "") for m in messages)


def test_upload_pdf(tmp_path):
    from fpdf import FPDF

    c = _client(tmp_path)
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("helvetica", size=12)
    pdf.cell(text="PDF knowledge doc")
    r = c.post("/api/kb/documents",
               files={"file": ("guide.pdf", bytes(pdf.output()), "application/pdf")})
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["data"]["chunks"] >= 1
    docs = c.get("/api/kb/documents").json()["data"]
    assert any(d["name"] == "guide.pdf" for d in docs)

    # 扫描件/图片 PDF 不报崩溃，仍应明确报错
    bad_data = b"%PDF-1.4 \n1 0 obj\n%fake" + b"x" * 20
    bad = c.post("/api/kb/documents",
                 files={"file": ("scan.pdf", bad_data, "application/pdf")})
    assert bad.status_code == 400
