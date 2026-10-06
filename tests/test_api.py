import json

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
