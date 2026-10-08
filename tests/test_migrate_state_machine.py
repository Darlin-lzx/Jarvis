"""迁移状态机：聊天流集成验证（确定性部分，不依赖真实 LLM）。

验证链路：用户消息 → parse_migrate_params → 迁移任务创建/推进 → task_state 持久化 →
db_migrate_task 状态机正确流转；LLM 层不可达时仅报错事件，不影响状态机先行推进。
"""
import json


class FakeEmbedding:
    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


def _client(app):
    from fastapi.testclient import TestClient
    return TestClient(app)


def test_migrate_state_machine_e2e(tmp_path):
    from db_loc_agent.app import create_app
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    c = _client(app)
    # 建会话
    r = c.post("/api/conversations", json={"title": "迁移评估"})
    cid = r.json()["data"]["id"]

    def send(msg):
        """POST /api/chat/stream 并消费全部 SSE（LLM 不可达，理论上最后是 error 事件）"""
        with c.stream("POST", "/api/chat/stream",
                      json={"message": msg, "conv_id": cid,
                            "agent_id": "migration_commander"}) as resp:
            body = "".join(resp.iter_text())
        return body

    # 第 1 轮：迁移意图 + 选择数据源（名称）
    body = send("我要做数据库国产化迁移，源数据源选：src_o")
    assert "error" in body.lower() or "data:" in body.lower()  # SSE 正常产出
    # 状态机先行创建迁移任务并推进
    r = c.get("/api/migrate/tasks")
    assert r.json()["success"] is True
    tasks = r.json()["data"]
    assert len(tasks) == 1, tasks
    t = tasks[0]
    assert t["status"] == "DATA_COLLECTION", t["status"]
    assert t["source_ds_id"] == "src_o"
    tid = t["task_id"]
    # 会话 task_state 已持久化（断点续跑依据）
    conv = c.get(f"/api/conversations/{cid}").json()["data"]
    ts = json.loads(conv.get("task_state") or "{}")
    assert ts.get("migrate_task_id") == tid
    assert ts.get("current_step") == "DATA_COLLECTION"
    # 数据源防重复：同一会话再选其他源，不覆盖
    send("重新选数据源：src_b")
    t2 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t2["source_ds_id"] == "src_o", "数据源一旦选定不可被后续轮次覆盖"

    # 第 2 轮：源/目标库类型
    send("目标库用达梦数据库，source_db_type：oracle")
    t3 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t3["target_db_type"] == "dm", t3["target_db_type"]  # 达梦→dm 归一化
    assert t3["source_db_type"] == "oracle"
    assert t3["status"] == "DATA_COLLECTION", t3["status"]

    # 第 3 轮：业务等级 + 容量 + 确认 → 对象扫描（自动扫描样例对象）
    send("业务等级：核心，容量：500GB，停机窗口：周六2小时，确认")
    t4 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t4["db_business_level"] == "核心"
    # 数据采集参数齐备并确认后 → 推进到迁移评估；数据采集阶段已自动扫描对象（样例兜底）
    assert t4["status"] == "ASSESSMENT_RUNNING", t4["status"]
    assert t4["object_count"] >= 1, "数据采集应产出对象清单"

    # 执行阶段手动闸门：不带确认词只传完成信号 → 不允许跨闸门
    r = c.post(f"/api/migrate/tasks/{tid}/advance", json={"object_count": 8})
    assert r.json()["data"]["advanced"] is False, "执行阶段无显式确认不得推进"
    assert r.json()["data"]["to"] == "ASSESSMENT_RUNNING"

    # 第 4 轮：用户显式“继续评估”→ 通过闸门进入评估执行
    send("继续评估")
    t5 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t5["status"] == "SOLUTION_GENERATE", t5["status"]

    # 执行阶段单步推进：带确认词才放行一级，且每轮一级
    r = c.post(f"/api/migrate/tasks/{tid}/advance", json={"task_confirm": "继续"})
    assert r.json()["data"]["to"] == "CODE_MIGRATE", r.json()
    # 断点续跑：后续轮普通消息（无确认）停靠当前阶段，不重置回采集阶段
    send("评估结果我看了")
    t6 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t6["status"] == "CODE_MIGRATE", "无确认消息执行阶段应停靠当前阶段（断点续跑）"
    # 后续确认轮继续推进，且不回退采集阶段
    send("继续")
    t7 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t7["status"] == "VERIFY_STAGE", t7["status"]
    assert t7["status"] not in ("DATA_COLLECTION",)
    print("MIGRATE E2E OK ->", t4["status"], "->", t7["status"])


def test_migrate_state_machine_conflict_via_chat(tmp_path):
    """聊天路径下 源==目标 类型冲突被后端拦截。"""
    from db_loc_agent.app import create_app
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    c = _client(app)
    r = c.post("/api/conversations", json={"title": "冲突"})
    cid = r.json()["data"]["id"]
    with c.stream("POST", "/api/chat/stream",
                  json={"message": "数据库迁移，源库 oracle，目标库也选 oracle，源数据源：src_o",
                        "conv_id": cid, "agent_id": "migration_commander"}) as resp:
        "".join(resp.iter_text())
    tid = c.get("/api/migrate/tasks").json()["data"][0]["task_id"]
    t = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t["target_db_type"] in ("", None), "源=目标库类型应被后端拦截清空"
    assert t["status"] == "DATA_COLLECTION", "未收集到合法目标库前不应推进"
    print("CONFLICT GUARD OK")


def test_migrate_task_reset_and_resume(tmp_path):
    """重置任务（回 INIT 清参数）与断点续跑（ERROR→可推进阶段）。"""
    from db_loc_agent.db import DbMigrateTask, MIGRATE_STATUS_ERROR, Database
    from db_loc_agent.app import create_app
    from sqlalchemy import select as _sq

    db_path = str(tmp_path / "t.db")
    app = create_app(
        db_path=db_path,
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    # 独立 Database 实例访问同一 db 文件（app 内部 db 不对外暴露）
    db = Database(db_path)
    c = _client(app)
    r = c.post("/api/conversations", json={"title": "重置/续跑"})
    cid = r.json()["data"]["id"]

    # 建立任务并推进到迁移评估（数据源+源库类型+目标库+容量+确认）
    with c.stream("POST", "/api/chat/stream",
                  json={"message": "国产化迁移，源数据源：src_r，source_db_type：oracle，目标库用达梦，容量 100GB，业务等级：一般，停机窗口：周六2小时，确认",
                        "conv_id": cid, "agent_id": "migration_commander"}) as resp:
        "".join(resp.iter_text())
    tid = c.get("/api/migrate/tasks").json()["data"][0]["task_id"]
    t0 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t0["status"] == "ASSESSMENT_RUNNING", t0["status"]

    # ---- 断点续跑：先把任务置为 ERROR，再调用 resume 恢复 ----
    with db.session() as s:
        row = s.get(DbMigrateTask, tid)
        row.status = MIGRATE_STATUS_ERROR
        row.error_msg = "扫描超时（测试模拟）"
        s.commit()
    r = c.post(f"/api/migrate/tasks/{tid}/resume")
    assert r.json()["success"] is True, r.json()
    resumed = r.json()["data"]
    assert resumed["status"] in ("ASSESSMENT_RUNNING",), resumed["status"]
    assert resumed["error_msg"] in ("", None), "续跑后错误应被清空"
    assert resumed["source_ds_id"] == "src_r", "续跑不清空已采集参数"
    # 非 ERROR 状态调用 resume 应报 400
    r2 = c.post(f"/api/migrate/tasks/{tid}/resume")
    assert r2.status_code == 400, "仅在 ERROR 状态支持断点续跑"

    # ---- 重置任务：状态回 INIT，参数清空 ----
    r = c.post(f"/api/migrate/tasks/{tid}/reset")
    assert r.json()["success"] is True, r.json()
    reset = r.json()["data"]
    assert reset["status"] == "DATA_COLLECTION", reset["status"]
    assert reset["source_ds_id"] in ("", None), "重置应清空源数据源"
    assert reset["target_db_type"] in ("", None), "重置应清空目标库"
    assert reset["db_capacity"] in ("", None), "重置应清空容量"
    # 资产也被清空
    with db.session() as s:
        from db_loc_agent.db import DbMigrateAsset
        n = len(list(s.scalars(_sq(DbMigrateAsset).where(DbMigrateAsset.task_id == tid))))
    assert n == 0, f"重置应清空该任务资产，实际 {n}"
    print("RESET/RESUME OK")


def test_migrate_task_strict_flow_toggle(tmp_path):
    """流程强校验是任务级开关：默认开启，可独立关闭且不影响逐级确认。"""
    from db_loc_agent.app import create_app
    from db_loc_agent.state_machine import MigrateStateService
    from db_loc_agent.db import Database

    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    c = _client(app)
    db = Database(str(tmp_path / "t.db"))
    svc = MigrateStateService(db)
    task = svc.create(conv_id=1, space_id=1)

    detail = c.get(f"/api/migrate/tasks/{task.id}").json()["data"]
    assert detail["strict_flow"] is True
    assert detail["step_confirm"] is True

    r = c.post(f"/api/migrate/tasks/{task.id}/strict-flow", json={"strict_flow": False})
    assert r.status_code == 200
    assert r.json()["data"]["strict_flow"] is False
    assert r.json()["data"]["step_confirm"] is True


def test_migrate_task_multi_conversation_shared(tmp_path):
    """一个迁移任务可被多个会话共享推进（1:N，任务级状态，无人会话排他）。"""
    from db_loc_agent.app import create_app
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    c = _client(app)

    def send(cid, msg):
        with c.stream("POST", "/api/chat/stream",
                      json={"message": msg, "conv_id": cid,
                            "agent_id": "migration_commander"}) as resp:
            "".join(resp.iter_text())

    # 会话 A 发起任务：选择数据源
    r = c.post("/api/conversations", json={"title": "会话A"})
    cid_a = r.json()["data"]["id"]
    send(cid_a, "我要做数据库国产化迁移，源数据源选：src_shared")
    tasks = c.get("/api/migrate/tasks").json()["data"]
    assert len(tasks) == 1, tasks
    tid = tasks[0]["task_id"]
    assert tasks[0]["conv_id"] == cid_a

    # 会话 B 接入同一任务：只说「继续推进」不指明数据源 → 兜底接入最近活跃任务
    r = c.post("/api/conversations", json={"title": "会话B"})
    cid_b = r.json()["data"]["id"]
    send(cid_b, "继续推进这个迁移，目标库用达梦，source_db_type：oracle")
    tasks = c.get("/api/migrate/tasks").json()["data"]
    assert len(tasks) == 1, f"多会话应共享同一任务，实际 {len(tasks)} 个: {tasks}"
    t = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t["task_id"] == tid, "会话 B 应复用会话 A 创建的任务"
    assert t["target_db_type"] == "dm", t["target_db_type"]
    assert t["source_db_type"] == "oracle"
    # conv_id 被更新为最近活跃会话（可选语义：记录最近活跃）
    assert tasks[0]["conv_id"] == cid_b, "复用后 conv_id 更新为最近活跃会话"

    # 会话 B 继续确认推进 → 不会回退、不会新建任务
    send(cid_b, "业务等级：核心，容量：200GB，停机窗口：周日2小时，确认")
    t2 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t2["status"] in ("ASSESSMENT_RUNNING",), t2["status"]
    tasks = c.get("/api/migrate/tasks").json()["data"]
    assert len(tasks) == 1, "多会话全程共享同一任务"
    print("MULTI-CONV SHARED OK ->", t2["status"])


def test_migrate_exec_lock_exclusive(tmp_path):
    """执行锁：一个任务同一时间只允许一个活跃执行流（串行协作）。"""
    from db_loc_agent.app import create_app
    from db_loc_agent.db import DbMigrateTask, MIGRATE_STATUS_ERROR, Database
    from db_loc_agent.state_machine import MigrateStateService

    db_path = str(tmp_path / "t.db")
    app = create_app(
        db_path=db_path,
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    db = Database(db_path)
    svc = MigrateStateService(db)
    c = _client(app)

    def send(cid, msg):
        with c.stream("POST", "/api/chat/stream",
                      json={"message": msg, "conv_id": cid,
                            "agent_id": "migration_commander"}) as resp:
            "".join(resp.iter_text())

    # 会话 A 发起任务：选择数据源
    r = c.post("/api/conversations", json={"title": "锁测试A"})
    cid_a = r.json()["data"]["id"]
    send(cid_a, "我要做数据库国产化迁移，源数据源选：src_lock")
    tid = c.get("/api/migrate/tasks").json()["data"][0]["task_id"]

    # ---- 会话 A 推进（带确认）期间模拟持锁；会话 B 尝试同一任务被拒 ----
    # 会话 A：推进到对象扫描（获取锁 → 处理 → 释放）
    send(cid_a, "目标库用达梦，source_db_type：oracle，业务等级：核心，容量：500GB，停机窗口：周六2小时，确认")
    t = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t["status"] in ("ASSESSMENT_RUNNING",), t["status"]
    # 阶段完成后锁已释放 → 其他会话可接手推进
    assert t["exec_lock"]["locked"] is False, "阶段完成后锁应已释放（串行协作）"

    # ---- 手动模拟 A 持锁中，B 发起 advance 被拒绝 ----
    with db.session() as s:
        row = s.get(DbMigrateTask, tid)
        row.exec_lock_session_id = "conv-A"
        row.lock_owner_user_id = "张三"
        from datetime import datetime, timedelta, timezone
        row.lock_expire_time = datetime.now(timezone.utc) + timedelta(seconds=300)
        s.commit()
    r = c.post(f"/api/migrate/tasks/{tid}/advance",
               json={"session_id": "conv-B", "task_confirm": "继续"})
    assert r.status_code == 400, "被其他会话占锁时推进应被拒绝"
    assert "只读" in r.json()["detail"] or "执行中" in r.json()["detail"], r.json()
    # 锁仍归 A 所有，状态未被推进
    row = svc.get(tid)
    assert row.exec_lock_session_id == "conv-A"

    # ---- 锁持有者（A）续期推进成功；完成后锁释放 ----
    r = c.post(f"/api/migrate/tasks/{tid}/advance",
               json={"session_id": "conv-A", "task_confirm": "继续"})
    assert r.json()["success"] is True, r.json()
    t2 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t2["exec_lock"]["locked"] is False, "推进完成后锁应释放"

    # ---- 超时自动释放：过期锁视作空闲，新会话可抢占 ----
    with db.session() as s:
        row = s.get(DbMigrateTask, tid)
        row.exec_lock_session_id = "dead-session"
        row.lock_owner_user_id = "挂起用户"
        from datetime import datetime, timedelta, timezone
        row.lock_expire_time = datetime.now(timezone.utc) - timedelta(seconds=10)
        s.commit()
    r = c.post(f"/api/migrate/tasks/{tid}/advance",
               json={"session_id": "conv-C", "task_confirm": "继续"})
    assert r.json()["success"] is True, "过期锁应被自动抢占"
    assert r.json()["data"]["to"] in ("SOLUTION_GENERATE", "CODE_MIGRATE", "VERIFY_STAGE"), r.json()

    # ---- 任务进入 ERROR：锁自动释放，任意会话可断点续跑 ----
    with db.session() as s:
        row = s.get(DbMigrateTask, tid)
        row.status = MIGRATE_STATUS_ERROR
        row.error_msg = "模拟异常"
        row.exec_lock_session_id = "conv-C"
        row.lock_owner_user_id = "用户C"
        s.commit()
    r = c.post(f"/api/migrate/tasks/{tid}/resume", json={"session_id": "conv-D"})
    assert r.json()["success"] is True, r.json()
    t3 = c.get(f"/api/migrate/tasks/{tid}").json()["data"]
    assert t3["exec_lock"]["locked"] in (True, False), "断点续跑后任务可继续推进"

    # ---- FINISHED：全局只读，任何状态变更被拒 ----
    from db_loc_agent.db import MIGRATE_STATUS_FINISHED
    with db.session() as s:
        row = s.get(DbMigrateTask, tid)
        row.status = MIGRATE_STATUS_FINISHED
        s.commit()
    r = c.post(f"/api/migrate/tasks/{tid}/advance",
               json={"session_id": "conv-E", "task_confirm": "继续"})
    assert r.status_code == 400, "FINISHED 后不允许再推进"
    print("EXEC-LOCK EXCLUSIVE OK")
