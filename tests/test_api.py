import json
import asyncio
import queue
import threading
import time

from fastapi.testclient import TestClient

from jarvis_agent.app import create_app


class FakeEmbedding:
    """确定性向量：按文本长度/序号生成，无需网络"""

    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


def _client(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        faiss_dir=str(tmp_path / "faiss"),
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



def test_agent_create_and_update_persist_configuration(tmp_path):
    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database

    db_path = str(tmp_path / "t.db")
    bootstrap(Database(db_path))
    c = _client(tmp_path)
    c.app.dependency_overrides.clear()
    r = c.post("/api/agents", json={
        "agent_id": "review_agent",
        "name": "代码审查",
        "alias": "审查员",
        "project_dir": "/tmp/review",
        "description": "审查代码",
        "intent": "code_review",
        "default_prompt": "你是审查专家",
        "enabled": True,
        "agent_type": "子Agent",
        "tools": ["代码生成"],
        "bound_kbs": ["boot知识库"],
    })

    assert r.status_code == 200
    assert r.json()["success"] is True

    r = c.put("/api/agents/boot_agent", json={
        "name": "页面展示专家（编辑后）",
        "alias": "编辑别名",
        "project_dir": "/tmp/boot",
        "description": "编辑后的描述",
        "default_prompt": "编辑后的提示词",
        "enabled": True,
        "agent_type": "子Agent",
        "tools": ["文件读写"],
        "bound_kbs": ["boot知识库"],
    })

    assert r.status_code == 200
    assert r.json()["success"] is True

    agents = {a["id"]: a for a in c.get("/api/agents").json()["data"]}
    created = agents["review_agent"]
    assert created["agent_type"] == "子Agent"
    assert created["tools"] == ["代码生成"]
    assert created["bound_kbs"] == ["boot知识库"]
    updated = agents["boot_agent"]
    assert updated["name"] == "页面展示专家（编辑后）"
    assert updated["alias"] == "编辑别名"
    assert updated["project_dir"] == "/tmp/boot"
    assert updated["bound_kbs"] == ["boot知识库"]

    kbs = {kb["name"]: kb for kb in c.get("/api/kbs").json()["data"]}
    boot_kb = kbs["boot知识库"]
    assert {"review_agent", "boot_agent"}.issubset(set(boot_kb["bound_agent_ids"]))
    assert "页面展示专家（编辑后）" in boot_kb["bound_agent_names"]
    assert boot_kb["doc_count"] >= 0
    assert boot_kb["chunk_count"] >= 0



def test_agent_update_rejects_unknown_knowledge_base(tmp_path):
    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database

    bootstrap(Database(str(tmp_path / "t.db")))
    c = _client(tmp_path)

    r = c.put("/api/agents/boot_agent", json={"bound_kbs": ["不存在知识库"]})

    assert r.status_code == 400
    assert "知识库不存在" in r.json()["detail"]


def test_agent_create_supports_empty_prompt(tmp_path):
    """提示词可留空：运行时用智能体名称/描述兜底，不阻断配置创建。"""
    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database

    bootstrap(Database(str(tmp_path / "seed.db")))
    c = _client(tmp_path)

    r = c.post("/api/agents", json={
        "agent_id": "empty_prompt_agent",
        "name": "无提示词智能体",
        "description": "负责通用问答",
        "intent": "",
        "default_prompt": "",
        "enabled": True,
        "agent_type": "子Agent",
    })

    assert r.status_code == 200
    assert r.json()["data"]["default_prompt"] == ""


def test_agent_workspace_api_reads_project(tmp_path):
    import subprocess

    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database, TraceLog

    db_path = str(tmp_path / "t.db")
    bootstrap(Database(db_path))
    root = tmp_path / "order-center"
    root.mkdir()
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
    (root / "Handler.java").write_text("class Handler {}\n", encoding="utf-8")
    c = _client(tmp_path)
    r = c.post("/api/agents", json={
        "agent_id": "workspace_agent", "name": "工程阅读", "project_dir": str(root),
    })
    assert r.status_code == 200

    summary = c.get("/api/agents/workspace_agent/workspace/summary")
    assert summary.status_code == 200
    payload = summary.json()["data"]
    assert payload["available"] is True
    assert payload["git"]["is_repo"] is True
    assert payload["changed_count"] == 1

    tree = c.get("/api/agents/workspace_agent/workspace/tree")
    assert tree.status_code == 200
    assert tree.json()["data"]["path"] == ""
    assert [item["path"] for item in tree.json()["data"]["items"]] == ["Handler.java"]

    file = c.get("/api/agents/workspace_agent/workspace/file",
                 params={"path": "Handler.java"})
    assert file.status_code == 200
    assert "class Handler" in file.json()["data"]["content"]

    with Database(db_path).session() as session:
        session.add(TraceLog(
            trace_id="trace-api", conv_id=21, phase="code", span="code_read",
            agent_id="workspace_agent", message="读取工程文件: Handler.java"))
        session.commit()
    evidence = c.get(
        "/api/agents/workspace_agent/workspace/evidence",
        params={"conv_id": 21},
    )
    assert evidence.status_code == 200
    assert evidence.json()["data"]["counts"]["read"] == 1


def test_agent_workspace_api_maps_errors(tmp_path):
    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database

    bootstrap(Database(str(tmp_path / "t.db")))
    c = _client(tmp_path)
    assert c.post("/api/agents", json={
        "agent_id": "missing_project", "name": "无工程", "project_dir": "",
    }).status_code == 200
    assert c.get("/api/agents/missing_project/workspace/file",
                 params={"path": "a.txt"}).status_code == 404



def test_knowledge_base_menu_returns_agent_bindings(tmp_path):
    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database

    bootstrap(Database(str(tmp_path / "t.db")))
    c = _client(tmp_path)

    r = c.post("/api/kbs", json={"name": "订单中心知识库", "description": "订单领域知识"})
    assert r.status_code == 200
    assert r.json()["success"] is True

    r = c.post("/api/kbs", json={"name": "订单中心知识库"})
    assert r.status_code == 400
    assert "已存在" in r.json()["detail"]

    items = c.get("/api/kbs").json()["data"]
    kb = next(item for item in items if item["name"] == "订单中心知识库")
    assert kb["description"] == "订单领域知识"
    assert kb["bound_agent_ids"] == []
    assert kb["bound_agent_names"] == []




def test_artifact_download_returns_native_xlsx(tmp_path):
    c = _client(tmp_path)
    from io import BytesIO
    from openpyxl import Workbook

    from jarvis_agent.artifacts import ArtifactService, make_namespace
    from jarvis_agent.db import Database

    workbook = Workbook()
    workbook.active.title = "改造清单"
    workbook.active.append(["对象名称"])
    workbook.active.append(["user_order"])
    buf = BytesIO()
    workbook.save(buf)
    service = ArtifactService(Database(str(tmp_path / "t.db")), str(tmp_path / "artifacts"))
    record = service.write(
        make_namespace("sess_1", "boot_agent", "page_show", "20260928T103000"),
        conv_id=1, agent_id="boot_agent", object_name="page_show",
        files={"代码改造清单.xlsx": buf.getvalue()},
    )["files"][0]

    response = c.get(f"/api/artifacts/{record['id']}/download")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert response.content[:2] == b"PK"

    preview = c.get(f"/api/artifacts/{record['id']}/file")

    assert preview.status_code == 200
    assert "user_order" in preview.json()["content"]




def test_model_list_includes_zhipu_preset(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "models.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "zhipu",
                                 "model": "",
                                 "base_url": "",
                                 "api_key": ""},
                         "mysql_url": ""},
    )
    c = TestClient(app)

    r = c.get("/api/ollama/models")

    assert r.status_code == 200
    assert "GLM-5.3" in r.json()["data"]




def test_conversation_crud(tmp_path):
    c = _client(tmp_path)
    r = c.post("/api/conversations", json={"title": "会话A"})
    assert r.status_code == 200
    conv = r.json()["data"]
    assert conv["id"] > 0
    assert c.get("/api/conversations").json()["data"]
    assert c.delete(f"/api/conversations/{conv['id']}").json()["success"] is True
    assert c.get(f"/api/conversations/{conv['id']}").status_code == 404

    from jarvis_agent.db import Conversation as ConversationRow, Database
    with Database(str(tmp_path / "t.db")).session() as s:
        assert s.get(ConversationRow, conv["id"]) is None




def test_delete_conversation_removes_orchestration_tasks(tmp_path):
    """删除会话时同步清理其子任务编排记录，避免外键残留阻止 conversations 删除。"""
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "带子任务会话"}).json()["data"]

    from jarvis_agent.db import Database, Task as OrchestrationTask
    with Database(str(tmp_path / "t.db")).session() as s:
        s.add(OrchestrationTask(
            task_id=f"t-{conv['id']}", conv_id=conv["id"],
            agent_type="boot_agent", task_desc="页面展示", status="success"))
        s.commit()

    assert c.delete(f"/api/conversations/{conv['id']}").json()["success"] is True

    with Database(str(tmp_path / "t.db")).session() as s:
        remaining = list(s.query(OrchestrationTask).filter(
            OrchestrationTask.conv_id == conv["id"]))
        assert remaining == []




def test_cancel_chat_endpoint_exists_and_returns_success(tmp_path):
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "中止会话"}).json()["data"]

    r = c.post(f"/api/chat/{conv['id']}/cancel")

    assert r.status_code == 200
    assert r.json()["success"] is True




def test_default_space_endpoint_creates_and_reuses_space(tmp_path):
    c = _client(tmp_path)

    first = c.get("/api/spaces/default")
    second = c.get("/api/spaces/default")

    assert first.status_code == 200
    assert first.json()["data"]["name"] == "默认空间"
    assert first.json()["data"]["id"] == second.json()["data"]["id"]




def test_create_conversation_defaults_to_default_space(tmp_path):
    c = _client(tmp_path)

    first = c.post("/api/conversations", json={"title": "直接新建"})
    second = c.post("/api/conversations", json={"title": "发送首条消息"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["data"]["space_id"] == second.json()["data"]["space_id"]
    assert first.json()["data"]["space_name"] == "默认空间"




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




def test_migrate_task_detail_includes_stage_execution_state(tmp_path):
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "采集完成"}).json()["data"]
    task = c.post("/api/jarvis/tasks", json={"conv_id": conv["id"]}).json()["data"]

    from jarvis_agent.db import Conversation, Database
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(Conversation, conv["id"])
        row.task_state = json.dumps({
            "current_step": "PAGE_SHOW",
            "step_status": "waiting_confirm",
            "awaiting_confirmation": True,
        }, ensure_ascii=False)
        s.commit()

    detail = c.get(f"/api/jarvis/tasks/{task['task_id']}").json()["data"]
    assert detail["current_step"] in ("PAGE_SHOW",)
    assert detail["step_status"] == "waiting_confirm"
    assert detail["awaiting_confirmation"] is True




def test_task_api_ignores_subsystem_dimension(tmp_path):
    c = _client(tmp_path)
    space = c.post("/api/spaces", json={"name": "空间A"}).json()["data"]
    legacy_sub = c.post(
        f"/api/spaces/{space['id']}/subsystems", json={"name": "营业系统"}
    ).json()["data"]
    first = c.post("/api/tasks", json={
        "space_id": space["id"], "sub_system_id": legacy_sub["id"], "name": "存量任务",
    }).json()["data"]
    second = c.post("/api/tasks", json={
        "space_id": space["id"], "name": "新任务",
    }).json()["data"]

    assert first["sub_system_id"] is None
    assert second["sub_system_id"] is None
    listed = c.get(
        f"/api/tasks?space_id={space['id']}&sub_system_id={legacy_sub['id']}"
    ).json()["data"]
    assert {t["id"] for t in listed} == {first["id"], second["id"]}




def test_chat_stream_does_not_block_other_conversation_reads(tmp_path, monkeypatch):
    """智能体同步执行期间，其他会话的打开请求不能被事件循环阻塞。"""
    import jarvis_agent.app as app_module
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

    monkeypatch.setattr(app_module, "create_chat_model",
                        lambda llm_cfg, **kwargs: BlockingLLM())
    app = _client(tmp_path).app
    from jarvis_agent.bootstrap import bootstrap
    from jarvis_agent.db import Database
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




def test_unified_knowledge_search_and_feedback(tmp_path):
    c = _client(tmp_path)
    content = "达梦 DM 转换 函数 NVL 规则"
    uploaded = c.post(
        "/api/kb/documents",
        files={"file": ("dm-nvl.md", content.encode(), "text/markdown")},
        data={
            "kb_type": "rules",
            "business_domain": "db_migrate",
            "target_db": "dm",
            "stage": "transform",
            "object_type": "function",
            "confidence": "verified",
            "source": "human",
            "source_ref": "人工规则库",
        },
    )
    assert uploaded.status_code == 200
    doc_id = uploaded.json()["data"]["id"]

    listed = c.get("/api/kb/documents").json()["data"]
    assert listed[0]["business_domain"] == "db_migrate"
    assert listed[0]["confidence"] == "verified"

    legacy = c.get("/api/kb/search", params={"q": content, "top_k": 3})
    assert legacy.status_code == 200
    assert legacy.json()["data"][0]["doc_id"] == doc_id

    result = c.post("/api/knowledge/search", json={
        "query": content,
        "top_k": 3,
        "business_domain": "db_migrate",
        "target_db": "dm",
        "stage": "transform",
        "object_type": "function",
    })
    assert result.status_code == 200
    body = result.json()["data"]
    assert body["degraded"] is False
    assert body["no_hit_reason"] is None
    hit = body["results"][0]
    assert hit["confidence_score"] == 1.0
    assert hit["domain_match"] == 1.0
    assert hit["source_ref"] == "人工规则库"

    feedback = c.post("/api/knowledge/feedback", json={
        "doc_id": doc_id,
        "feedback": "negative",
        "reason": "规则不适用",
    })
    assert feedback.status_code == 200
    assert feedback.json()["data"]["confidence"] == "pending_review"
    assert feedback.json()["data"]["review_required"] is True
