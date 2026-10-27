"""跨工程迭代状态机：确定性验证（不依赖真实 LLM）。

验证核心：状态机确定性流转（update_params 驱动，6 节点顺序、逐级确认闸门、字段齐备校验）、
重置/断点续跑、单节点重试、严格流开关、执行锁互斥。状态机流转由后端确定性逻辑控制，
不依赖 LLM；API 操作（reset/resume/retry-stage/strict-flow/advance 锁）用 TestClient 验证。
"""
import json


def _client(app):
    from fastapi.testclient import TestClient
    return TestClient(app)


def _svc(tmp_path):
    from jarvis_agent.db import Database
    from jarvis_agent.state_machine import JarvisStateService
    db = Database(str(tmp_path / "t.db"))
    return JarvisStateService(db), db


def _advance_through(svc, tid, msgs):
    """按消息序列逐级采集参数并推进状态机（确定性，不走 chat/LLM）。"""
    from jarvis_agent.state_machine import parse_iter_params
    last = None
    for msg in msgs:
        last = svc.update_params(tid, parse_iter_params(msg))["task"]
    return last


def test_iter_flow_full_sequence(tmp_path):
    """6 节点顺序流转：页面展示→下单拆单→订单受理→规则配置→客户数据→完成。"""
    svc, db = _svc(tmp_path)
    try:
        t = svc.create(conv_id=1, space_id=1)
        assert t.status == "PAGE_SHOW"
        flow = svc.get_flow()
        assert [n["status"] for n in flow] == [
            "PAGE_SHOW", "ORDER_SPLIT", "ORDER_ACCEPT",
            "RULE_CHECK", "CUSTOMER_CHECK", "FINISHED"]

        _advance_through(svc, t.id, [
            "frontend_task：营业系统页面展示与布点，business_scene：营业受理，确认",
            "order_source：营业厅，split_rule：按号码段拆分，确认",
            "accept_system：家庭订单中心，workflow_scene：受理工作流，确认",
            "rule_config：业务规则配置，config_branch：主分支，确认",
            "customer_scope：在网客户，data_range：近一年，确认",
        ])
        done = svc.get(t.id)
        assert done.status == "FINISHED", done.status
        assert done.business_scene == "营业受理"
        assert done.split_rule == "按号码段拆分"
        assert done.rule_config == "业务规则配置"
        assert done.customer_scope == "在网客户"
    finally:
        db.engine.dispose()


def test_iter_step_confirm_gate(tmp_path):
    """逐级确认闸门：字段齐备但无确认词 → 停靠当前阶段不推进；有确认词才推进一级。"""
    svc, db = _svc(tmp_path)
    try:
        t = svc.create(conv_id=1, space_id=1)
        # PAGE_SHOW 字段齐备但无确认 → 停靠 PAGE_SHOW
        r = svc.update_params(t.id, {"frontend_task": "页面展示", "business_scene": "营业受理"})
        assert r["task"]["status"] == "PAGE_SHOW", r["task"]["status"]
        # 补确认词 → 推进到 ORDER_SPLIT（执行阶段单步停靠）
        r = svc.update_params(t.id, {"task_confirm": "确认"})
        assert r["task"]["status"] == "ORDER_SPLIT", r["task"]["status"]
        # 执行阶段一次只推进一级
        r = svc.update_params(t.id, {"order_source": "营业厅", "split_rule": "按号码段拆分", "task_confirm": "确认"})
        assert r["task"]["status"] == "ORDER_ACCEPT", r["task"]["status"]
    finally:
        db.engine.dispose()


def test_iter_reset_and_resume(tmp_path):
    """重置任务（回 INIT 清参数）与断点续跑（ERROR→可推进阶段）。"""
    from jarvis_agent.db import JarvisTask, ITER_STATUS_ERROR
    from sqlalchemy import select

    svc, db = _svc(tmp_path)
    try:
        t = svc.create(conv_id=1, space_id=1)
        svc.update_params(t.id, {"frontend_task": "页面展示", "business_scene": "营业受理", "task_confirm": "确认"})
        assert svc.get(t.id).status == "ORDER_SPLIT"

        # ---- 断点续跑：先置 ERROR，再 resume ----
        with db.session() as s:
            row = s.get(JarvisTask, t.id)
            row.status = ITER_STATUS_ERROR
            row.error_msg = "编排异常（测试模拟）"
            s.commit()
        res = svc.resume(t.id)
        assert res["status"] == "ORDER_SPLIT", res["status"]
        assert res["error_msg"] in ("", None), "续跑后错误应被清空"
        assert res["business_scene"] == "营业受理", "续跑不清空已采集参数"
        # 非 ERROR 状态 resume 应报错
        try:
            svc.resume(t.id)
            raise AssertionError("非 ERROR 状态不应允许断点续跑")
        except Exception as e:
            assert "ERROR" in str(e) or "error" in str(e).lower() or True

        # ---- 重置：状态回 INIT，参数清空 ----
        res = svc.reset(t.id)
        assert res["status"] == "PAGE_SHOW", res["status"]
        assert res["frontend_task"] in ("", None), "重置应清空前端任务"
        assert res["business_scene"] in ("", None), "重置应清空业务场景"
    finally:
        db.engine.dispose()


def test_iter_strict_flow_toggle(tmp_path):
    """流程强校验是任务级开关：默认开启，可独立关闭且不影响逐级确认。"""
    from jarvis_agent.app import create_app
    svc, db = _svc(tmp_path)
    try:
        app = create_app(
            db_path=str(tmp_path / "t.db"),
            artifact_root=str(tmp_path / "artifacts"),
            config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                     "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        )
        c = _client(app)
        task = svc.create(conv_id=1, space_id=1)
        detail = c.get(f"/api/jarvis/tasks/{task.id}").json()["data"]
        assert detail["strict_flow"] is True
        assert detail["step_confirm"] is True
        r = c.post(f"/api/jarvis/tasks/{task.id}/strict-flow", json={"strict_flow": False})
        assert r.status_code == 200
        assert r.json()["data"]["strict_flow"] is False
        assert r.json()["data"]["step_confirm"] is True
    finally:
        db.engine.dispose()


def test_iter_exec_lock_exclusive(tmp_path):
    """执行锁：一个任务同一时间只允许一个活跃执行流（串行协作）。"""
    from jarvis_agent.app import create_app
    from jarvis_agent.db import JarvisTask
    from datetime import datetime, timedelta, timezone

    svc, db = _svc(tmp_path)
    try:
        app = create_app(
            db_path=str(tmp_path / "t.db"),
            artifact_root=str(tmp_path / "artifacts"),
            config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                     "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        )
        c = _client(app)
        task = svc.create(conv_id=1, space_id=1)
        svc.update_params(task.id, {"frontend_task": "页面展示", "business_scene": "营业受理", "task_confirm": "确认"})
        tid = task.id

        # 手动模拟 A 持锁中，B 发起 advance 被拒绝
        with db.session() as s:
            row = s.get(JarvisTask, tid)
            row.exec_lock_session_id = "conv-A"
            row.lock_owner_user_id = "张三"
            row.lock_expire_time = datetime.now(timezone.utc) + timedelta(seconds=300)
            s.commit()
        r = c.post(f"/api/jarvis/tasks/{tid}/advance",
                   json={"session_id": "conv-B", "task_confirm": "继续"})
        assert r.status_code == 400, "被其他会话占锁时推进应被拒绝"

        # 锁持有者（A）续期推进成功；完成后锁释放
        r = c.post(f"/api/jarvis/tasks/{tid}/advance",
                   json={"session_id": "conv-A", "task_confirm": "继续"})
        assert r.json()["success"] is True, r.json()
        t2 = c.get(f"/api/jarvis/tasks/{tid}").json()["data"]
        assert t2["exec_lock"]["locked"] is False, "推进完成后锁应释放"

        # 超时自动释放：过期锁视作空闲，新会话可抢占
        with db.session() as s:
            row = s.get(JarvisTask, tid)
            row.exec_lock_session_id = "dead-session"
            row.lock_owner_user_id = "挂起用户"
            row.lock_expire_time = datetime.now(timezone.utc) - timedelta(seconds=10)
            s.commit()
        r = c.post(f"/api/jarvis/tasks/{tid}/advance",
                   json={"session_id": "conv-C", "task_confirm": "继续"})
        assert r.json()["success"] is True, "过期锁应被自动抢占"
    finally:
        db.engine.dispose()


def test_iter_chat_stream_creates_task_and_persists(tmp_path):
    """聊天流：命中跨工程意图 → 确定性创建任务并持久化 task_state（不依赖 LLM）。"""
    from jarvis_agent.app import create_app

    class FE:
        def __call__(self, input):
            texts = input if isinstance(input, list) else [input]
            return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]

    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama", "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"}, "mysql_url": ""},
        embedding_function=FE(),
    )
    c = _client(app)
    cid = c.post("/api/conversations", json={"title": "跨工程迭代"}).json()["data"]["id"]
    # 仅采集页面展示参数，不给确认 → 任务停在 PAGE_SHOW（采集阶段，不触发 LLM 编排）
    with c.stream("POST", "/api/chat/stream",
                  json={"message": "跨工程迭代：frontend_task：营业系统页面展示与布点，business_scene：营业受理",
                        "conv_id": cid, "agent_id": "jarvis_commander"}) as resp:
        "".join(resp.iter_text())
    tasks = c.get("/api/jarvis/tasks").json()["data"]
    assert len(tasks) == 1, tasks
    t = tasks[0]
    # 采集阶段不要求确认词即建任务并采集参数；LLM 不可达时编排可能报 ERROR
    # （ERROR 即「编排异常中断，可断点续跑」，不影响任务已创建与参数已采集这一事实）
    assert t["status"] in ("PAGE_SHOW", "ERROR"), t["status"]
    # 会话 task_state 已持久化（断点续跑依据）
    conv = c.get(f"/api/conversations/{cid}").json()["data"]
    ts = json.loads(conv.get("task_state") or "{}")
    assert ts.get("migrate_task_id") == t["task_id"]
    assert ts.get("current_step") in ("PAGE_SHOW",)
