import json
import asyncio
import queue
import threading
import time

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


def test_artifact_download_returns_native_xlsx(tmp_path):
    c = _client(tmp_path)
    from io import BytesIO
    from openpyxl import Workbook

    from db_loc_agent.artifacts import ArtifactService, make_namespace
    from db_loc_agent.db import Database

    workbook = Workbook()
    workbook.active.title = "改造清单"
    workbook.active.append(["对象名称"])
    workbook.active.append(["user_order"])
    buf = BytesIO()
    workbook.save(buf)
    service = ArtifactService(Database(str(tmp_path / "t.db")), str(tmp_path / "artifacts"))
    record = service.write(
        make_namespace("sess_1", "code_migrator", "user_order", "20260928T103000"),
        conv_id=1, agent_id="code_migrator", object_name="user_order",
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

    from db_loc_agent.db import Conversation as ConversationRow, Database
    with Database(str(tmp_path / "t.db")).session() as s:
        assert s.get(ConversationRow, conv["id"]) is None


def test_delete_conversation_removes_orchestration_tasks(tmp_path):
    """删除会话时同步清理其子任务编排记录，避免外键残留阻止 conversations 删除。"""
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "带子任务会话"}).json()["data"]

    from db_loc_agent.db import Database, Task as OrchestrationTask
    with Database(str(tmp_path / "t.db")).session() as s:
        s.add(OrchestrationTask(
            task_id=f"t-{conv['id']}", conv_id=conv["id"],
            agent_type="migration_collector", task_desc="采集", status="success"))
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
    task = c.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]

    from db_loc_agent.db import Conversation, Database
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(Conversation, conv["id"])
        row.task_state = json.dumps({
            "current_step": "DATA_COLLECTION",
            "step_status": "waiting_confirm",
            "awaiting_confirmation": True,
        }, ensure_ascii=False)
        s.commit()

    detail = c.get(f"/api/migrate/tasks/{task['task_id']}").json()["data"]
    assert detail["current_step"] == "DATA_COLLECTION"
    assert detail["step_status"] == "waiting_confirm"
    assert detail["awaiting_confirmation"] is True


def test_migrate_task_detail_repairs_collector_done_from_artifact(tmp_path):
    """存量会话：小采报告已落库但 step_status 被旧逻辑写成 running。"""
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "存量采集完成"}).json()["data"]
    task = c.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]

    from db_loc_agent.artifacts import ArtifactService
    from db_loc_agent.db import Conversation, Database
    artifact_svc = ArtifactService(Database(str(tmp_path / "t.db")), str(tmp_path / "artifacts"))
    artifact_svc.write(
        f"sess_{conv['id']}/migration_collector/report", conv["id"],
        "migration_collector", "report", {"数据采集报告.md": "# 数据采集报告\n\n- 已采集"},
    )
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(Conversation, conv["id"])
        row.task_state = json.dumps({
            "migrate_task_id": task["task_id"],
            "current_step": "DATA_COLLECTION",
            "step_status": "running",
            "awaiting_confirmation": False,
        }, ensure_ascii=False)
        s.commit()

    detail = c.get(f"/api/migrate/tasks/{task['task_id']}").json()["data"]
    assert detail["step_status"] == "done"


def test_confirm_excel_replacement_advances_collection_to_assessment(tmp_path, monkeypatch):
    """Excel 已扫描出对象且用户确认替代采集时，数据采集直接满足评估前置。"""
    from io import BytesIO

    from openpyxl import Workbook
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module
    from db_loc_agent.bootstrap import bootstrap
    from db_loc_agent.db import Conversation, Database, DbMigrateTask

    class FakeGraph:
        def stream(self, initial, stream_mode=None):
            yield "messages", (AIMessage(content="已进入迁移评估阶段。"), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: FakeGraph())
    bootstrap(Database(str(tmp_path / "t.db")))
    c = _client(tmp_path)

    wb = Workbook()
    wb.active.title = "用户表"
    wb.active.append(["id", "name"])
    for title in ("订单表", "账务表"):
        wb.create_sheet(title).append(["id", "amount"])
    buf = BytesIO()
    wb.save(buf)
    ds = c.post("/api/datasources/upload", files={
        "file": ("采集.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    }, data={"name": "当前Excel"}).json()["data"]

    conv = c.post("/api/conversations", json={"title": "Excel采集"}).json()["data"]
    task = c.post("/api/migrate/tasks", json={
        "conv_id": conv["id"], "source_ds_id": str(ds["id"]),
        "source_ds_name": ds["name"], "task_name": "Excel迁移评估",
    }).json()["data"]
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(DbMigrateTask, task["task_id"])
        row.target_db_type = "dm"
        row.object_count = 3
        s.commit()
        conv_row = s.get(Conversation, conv["id"])
        conv_row.task_state = json.dumps({
            "migrate_task_id": task["task_id"], "current_step": "DATA_COLLECTION",
            "task_params": {"source_ds_id": str(ds["id"]), "source_ds_name": ds["name"],
                            "target_db_type": "dm", "object_count": 3},
        }, ensure_ascii=False)
        s.commit()

    with c.stream("POST", "/api/chat/stream", json={
            "message": "确认采用当前 Excel 替代采集结果（3 张表）作为迁移评估输入",
            "conv_id": conv["id"], "agent_id": "migration_commander"}) as resp:
        assert resp.status_code == 200
        list(resp.iter_lines())

    detail = c.get(f"/api/migrate/tasks/{task['task_id']}").json()["data"]
    assert detail["status"] == "ASSESSMENT_RUNNING"


def test_advance_after_collector_report_starts_assessment(tmp_path):
    """采集报告已生成且用户确认推进时，必填说明字段不能继续卡住评估。"""
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "采集报告已生成"}).json()["data"]
    task = c.post("/api/migrate/tasks", json={
        "conv_id": conv["id"], "source_ds_id": "excel-1",
        "source_ds_name": "当前Excel", "task_name": "报告后推进",
    }).json()["data"]

    from db_loc_agent.artifacts import ArtifactService
    from db_loc_agent.db import Conversation, Database, DbMigrateTask
    ArtifactService(Database(str(tmp_path / "t.db")), str(tmp_path / "artifacts")).write(
        f"sess_{conv['id']}/migration_collector/report", conv["id"],
        "migration_collector", "report",
        {"数据采集报告.md": "# 数据采集报告\n\n- 已采集 3 张表"},
    )
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(DbMigrateTask, task["task_id"])
        row.target_db_type = "dm"
        row.object_count = 0
        s.commit()
        conv_row = s.get(Conversation, conv["id"])
        conv_row.task_state = json.dumps({
            "migrate_task_id": task["task_id"], "current_step": "DATA_COLLECTION",
            "step_status": "done", "task_params": {
                "source_ds_id": "excel-1", "source_ds_name": "当前Excel",
                "target_db_type": "dm"},
        }, ensure_ascii=False)
        s.commit()

    frames: queue.Queue[dict] = queue.Queue()

    def read_socket():
        with c.websocket_connect(f"/ws/migrate/{task['task_id']}") as websocket:
            frames.put(websocket.receive_json())
            while True:
                frames.put(websocket.receive_json())

    reader = threading.Thread(target=read_socket, daemon=True)
    reader.start()
    time.sleep(0.1)
    frames.get(timeout=2)
    res = c.post(f"/api/migrate/tasks/{task['task_id']}/advance", json={
        "task_confirm": "确认", "session_id": "test",
    }).json()["data"]
    snapshot = frames.get(timeout=2)

    assert res["task"]["status"] == "ASSESSMENT_RUNNING"
    assert snapshot["event"] == "state"
    assert snapshot["status"] == "ASSESSMENT_RUNNING"


def test_advance_auto_execution_does_not_cross_next_gate(tmp_path):
    """按钮确认后自动执行新阶段时，同一条执行消息不得再次触发状态机推进。"""
    c = _client(tmp_path)
    conv = c.post("/api/conversations", json={"title": "采集后执行"}).json()["data"]
    task = c.post("/api/migrate/tasks", json={
        "conv_id": conv["id"], "source_ds_id": "excel-1",
        "source_ds_name": "当前Excel", "task_name": "采集后执行",
    }).json()["data"]

    from db_loc_agent.db import Conversation, Database, DbMigrateTask
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(DbMigrateTask, task["task_id"])
        row.source_db_type = "excel"
        row.target_db_type = "mysql"
        row.db_business_level = "核心"
        row.db_capacity = "500GB"
        row.stop_window = "周六2小时"
        row.object_count = 3
        s.commit()
        conv_row = s.get(Conversation, conv["id"])
        conv_row.task_state = json.dumps({
            "migrate_task_id": task["task_id"], "current_step": "DATA_COLLECTION",
            "step_status": "waiting_confirm", "pipeline_start": True,
            "task_params": {"source_ds_id": "excel-1", "source_db_type": "excel",
                            "target_db_type": "mysql", "object_count": 3},
        }, ensure_ascii=False)
        s.commit()

    res = c.post(f"/api/migrate/tasks/{task['task_id']}/advance", json={
        "task_confirm": "确认", "session_id": "test",
    }).json()["data"]
    assert res["task"]["status"] == "ASSESSMENT_RUNNING"

    with c.stream("POST", "/api/chat/stream", json={
        "message": "开始执行", "conv_id": conv["id"],
        "agent_id": "migration_commander", "skip_state_advance": True,
    }) as resp:
        assert resp.status_code == 200
        list(resp.iter_lines())

    detail = c.get(f"/api/migrate/tasks/{task['task_id']}").json()["data"]
    assert detail["status"] == "ASSESSMENT_RUNNING", detail["status"]


def test_task_migrate_task_detail_includes_stage_execution_state(tmp_path):
    c = _client(tmp_path)
    space = c.post("/api/spaces", json={"name": "空间"}).json()["data"]
    task = c.post("/api/tasks", json={"space_id": space["id"], "name": "迁移任务"}).json()["data"]
    conv = c.post("/api/conversations", json={
        "task_id": task["id"], "title": "任务会话",
    }).json()["data"]
    migrate = c.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]

    from db_loc_agent.db import Conversation, Database
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(Conversation, conv["id"])
        row.task_state = json.dumps({
            "migrate_task_id": migrate["task_id"],
            "current_step": "DATA_COLLECTION",
            "step_status": "waiting_confirm",
            "awaiting_confirmation": True,
        }, ensure_ascii=False)
        s.commit()

    detail = c.get(f"/api/tasks/{task['id']}/migrate-task").json()["data"]
    assert detail["current_step"] == "DATA_COLLECTION"
    assert detail["step_status"] == "waiting_confirm"
    assert detail["awaiting_confirmation"] is True


def test_new_project_task_starts_collection_instead_of_recent_migration(tmp_path, monkeypatch):
    """业务任务之间不共享状态机；新任务必须从数据采集开始。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module
    from db_loc_agent.db import Database, DbMigrateTask

    class FakeGraph:
        def stream(self, initial, stream_mode=None):
            yield "messages", (AIMessage(content="开始数据采集。"), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: FakeGraph())
    c = _client(tmp_path)
    space = c.post("/api/spaces", json={"name": "空间"}).json()["data"]
    old_task = c.post("/api/tasks", json={
        "space_id": space["id"], "name": "旧任务"}).json()["data"]
    new_task = c.post("/api/tasks", json={
        "space_id": space["id"], "name": "新任务"}).json()["data"]
    old_conv = c.post("/api/conversations", json={
        "task_id": old_task["id"], "title": "旧会话"}).json()["data"]
    new_conv = c.post("/api/conversations", json={
        "task_id": new_task["id"], "title": "新会话"}).json()["data"]

    old_migrate = c.post("/api/migrate/tasks", json={
        "conv_id": old_conv["id"], "space_id": space["id"]}).json()["data"]
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(DbMigrateTask, old_migrate["task_id"])
        row.conv_id = old_task["id"]
        row.status = "ASSESSMENT_RUNNING"
        s.commit()

    with c.stream("POST", "/api/chat/stream", json={
        "message": "继续推进迁移", "conv_id": new_conv["id"],
        "agent_id": "migration_commander",
    }) as resp:
        assert resp.status_code == 200
        list(resp.iter_lines())

    detail = c.get(f"/api/tasks/{new_task['id']}/migrate-task").json()["data"]
    assert detail is not None
    assert detail["status"] == "DATA_COLLECTION"
    assert detail["task_id"] != old_migrate["task_id"]


def test_project_task_ignores_migration_when_conversation_id_collides(tmp_path, monkeypatch):
    """conv_id 同时代示会话/业务任务时，不能用它判断迁移任务归属。"""
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module
    from db_loc_agent.db import Database, DbMigrateTask

    class FakeGraph:
        def stream(self, initial, stream_mode=None):
            yield "messages", (AIMessage(content="开始数据采集。"), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: FakeGraph())
    c = _client(tmp_path)
    space = c.post("/api/spaces", json={"name": "空间"}).json()["data"]
    for i in range(11):
        c.post("/api/tasks", json={"space_id": space["id"], "name": f"占位{i}"})

    orphan = c.post("/api/migrate/tasks", json={
        "conv_id": 12, "space_id": space["id"]}).json()["data"]
    with Database(str(tmp_path / "t.db")).session() as s:
        row = s.get(DbMigrateTask, orphan["task_id"])
        row.status = "ASSESSMENT_RUNNING"
        s.commit()

    new_task = c.post("/api/tasks", json={
        "space_id": space["id"], "name": "新任务"}).json()["data"]
    assert new_task["id"] == 12
    new_conv = c.post("/api/conversations", json={
        "task_id": new_task["id"], "title": "新会话"}).json()["data"]

    before_chat = c.get(f"/api/tasks/{new_task['id']}/migrate-task").json()["data"]
    assert before_chat is None or before_chat["task_id"] != orphan["task_id"]

    with c.stream("POST", "/api/chat/stream", json={
        "message": "继续推进迁移", "conv_id": new_conv["id"],
        "agent_id": "migration_commander",
    }) as resp:
        assert resp.status_code == 200
        list(resp.iter_lines())

    detail = c.get(f"/api/tasks/{new_task['id']}/migrate-task").json()["data"]
    assert detail is not None
    assert detail["status"] == "DATA_COLLECTION"
    assert detail["task_id"] != orphan["task_id"]


def test_task_migrate_detail_falls_back_to_project_conversation_state(tmp_path):
    """迁移任务 conv_id 存业务任务 ID 时，仍要反查任务下会话的执行状态。"""
    c = _client(tmp_path)
    space = c.post("/api/spaces", json={"name": "空间"}).json()["data"]
    c.post("/api/tasks", json={"space_id": space["id"], "name": "占位任务"})
    task = c.post("/api/tasks", json={"space_id": space["id"], "name": "迁移任务"}).json()["data"]
    conv = c.post("/api/conversations", json={
        "task_id": task["id"], "title": "任务会话",
    }).json()["data"]
    migrate = c.post("/api/migrate/tasks", json={"conv_id": conv["id"]}).json()["data"]

    from db_loc_agent.db import Conversation, Database, DbMigrateTask
    with Database(str(tmp_path / "t.db")).session() as s:
        migrate_row = s.get(DbMigrateTask, migrate["task_id"])
        migrate_row.conv_id = task["id"]
        row = s.get(Conversation, conv["id"])
        row.task_state = json.dumps({
            "migrate_task_id": migrate["task_id"],
            "current_step": "DATA_COLLECTION",
            "step_status": "done",
            "awaiting_confirmation": False,
        }, ensure_ascii=False)
        s.commit()

    detail = c.get(f"/api/tasks/{task['id']}/migrate-task").json()["data"]
    assert detail["current_step"] == "DATA_COLLECTION"
    assert detail["step_status"] == "done"
    assert detail["awaiting_confirmation"] is False


def test_migration_collection_defaults_to_enabled_excel_and_local_mysql(tmp_path, monkeypatch):
    """演示默认链路：未显式选源/目标时，小采读 Excel，目标库为本地 MySQL。"""
    from io import BytesIO

    from openpyxl import Workbook
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module
    from db_loc_agent.bootstrap import bootstrap
    from db_loc_agent.db import Database

    class FakeGraph:
        def stream(self, initial, stream_mode=None):
            yield "messages", (AIMessage(content="已按默认配置完成数据采集。"), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: FakeGraph())
    bootstrap(Database(str(tmp_path / "t.db")))
    c = _client(tmp_path)

    wb = Workbook()
    wb.active.title = "用户表"
    wb.active.append(["id", "name"])
    for title in ("订单表", "账务表"):
        wb.create_sheet(title).append(["id", "amount"])
    buf = BytesIO()
    wb.save(buf)
    ds = c.post("/api/datasources/upload", files={
        "file": ("采集.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    }, data={"name": "默认Excel"}).json()["data"]

    conv = c.post("/api/conversations", json={"title": "默认采集"}).json()["data"]
    with c.stream("POST", "/api/chat/stream", json={
            "message": "开始采集", "conv_id": conv["id"],
            "agent_id": "migration_commander"}) as resp:
        assert resp.status_code == 200
        list(resp.iter_lines())

    from db_loc_agent.db import Conversation
    with Database(str(tmp_path / "t.db")).session() as s:
        state = json.loads(s.get(Conversation, conv["id"]).task_state or "{}")
    detail = c.get(f"/api/migrate/tasks/{state['migrate_task_id']}").json()["data"]

    assert state["migrate_task_id"] > 0
    assert detail["source_ds_id"] == str(ds["id"])
    assert detail["source_ds_name"] == ds["name"]
    assert detail["source_db_type"] == "excel"
    assert detail["target_db_type"] == "mysql"
    assert detail["object_count"] == 3


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

    monkeypatch.setattr(app_module, "create_chat_model",
                        lambda llm_cfg, **kwargs: BlockingLLM())
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

    monkeypatch.setattr(app_module, "create_chat_model",
                        lambda llm_cfg, **kwargs: DirectAgentLLM())
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


def test_auto_routed_core_agent_stream_suppresses_report_text(tmp_path, monkeypatch):
    """自动路由到产物型 Agent 时，也必须先缓冲正文、只下发产物卡片。"""
    import db_loc_agent.app as app_module
    from langchain_core.messages import AIMessage

    report = "# 迁移评估报告\n\n自动路由评估结论：可以迁移。"

    class AutoRoutedAgentLLM:
        def parse(self, text):
            return {"intent": "migration_assess", "agent_id": "migration_assessor",
                    "object_name": "营业库", "source_db": "oracle", "target_db": "dm",
                    "skill_id": "", "confidence": 0.99}

        def bind_tools(self, schemas, **kwargs):
            return self

        def stream(self, messages, **kwargs):
            yield AIMessage(content=report)

    monkeypatch.setattr(app_module, "create_chat_model",
                        lambda llm_cfg, **kwargs: AutoRoutedAgentLLM())
    c = _client(tmp_path)
    from db_loc_agent.bootstrap import bootstrap
    from db_loc_agent.db import Database
    bootstrap(Database(str(tmp_path / "t.db")))
    cid = c.post("/api/conversations", json={"title": "自动评估"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "请评估营业库", "conv_id": cid}) as r:
        for line in r.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    texts = [e["content"] for e in events if e["type"] == "text"]
    sub_agents = [e["content"] for e in events if e["type"] == "sub_agent"]
    assert report not in "".join(texts)
    assert sub_agents and sub_agents[-1]["artifacts"]
    assert sub_agents[-1]["reply"] == ""


def test_stage_gate_rejection_is_visible_in_chat(tmp_path, monkeypatch):
    """越级指派被图拦截时，用户必须能看到具体拦截原因。"""
    import db_loc_agent.app as app_module

    class BlockedGraph:
        def stream(self, initial, stream_mode=None):
            yield "updates", {"migration_commander": {
                "agent_id": "migration_commander",
                "route_reason": "当前阶段为数据采集，仅允许小采执行",
                "reply": "当前阶段为数据采集，仅允许小采执行；小评已被阶段闸门拦截。",
                "graph_phase": "blocked",
            }}

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: BlockedGraph())
    c = _client(tmp_path)
    cid = c.post("/api/conversations", json={"title": "越级拦截"}).json()["data"]["id"]

    events = []
    with c.stream("POST", "/api/chat/stream", json={
            "message": "@小评 直接评估", "conv_id": cid,
            "agent_id": "migration_assessor"}) as r:
        for line in r.iter_lines():
            raw = line if isinstance(line, bytes) else line.encode()
            if raw.startswith(b"data: "):
                events.append(json.loads(raw[6:]))

    assert any(e["type"] == "text" and "阶段闸门拦截" in e["content"]
               for e in events)
    messages = c.get(f"/api/conversations/{cid}/messages").json()["data"]
    assert any("阶段闸门拦截" in (m.get("content") or "")
               for m in messages if m["role"] == "assistant")


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
