import json


def test_task_gets_trace_and_state_events(tmp_path):
    from jarvis_agent.db import Database
    from jarvis_agent.observability import ObservabilityService
    from jarvis_agent.state_machine import JarvisStateService

    db = Database(str(tmp_path / "t.db"))
    service = ObservabilityService(db)
    migrate = JarvisStateService(db, observability=service)
    task = migrate.create(conv_id=None, space_id=None)
    assert task.trace_id

    result = migrate.update_params(task.id, {
        "frontend_task": "页面展示",
        "business_scene": "营业受理",
        "task_confirm": "确认",
    })
    events = service.list_state_events(task.id)
    assert [event["event_type"] for event in events] == [
        "TASK_STARTED", "USER_INPUT", "NODE_SUCCESS"
    ]
    assert events[-1]["from_status"] == "PAGE_SHOW"
    assert events[-1]["trace_id"] == task.trace_id
    assert result["task"]["trace_id"] == task.trace_id


def test_trace_logs_are_ordered_and_serializable(tmp_path):
    from jarvis_agent.db import Database
    from jarvis_agent.observability import ObservabilityService

    service = ObservabilityService(Database(str(tmp_path / "t.db")))
    trace_id = service.log(trace_id="", phase="llm", span="invoke", message="call")
    service.log(trace_id=trace_id, phase="artifact", span="write", message="saved")
    logs = service.list_trace(trace_id)
    assert [item["phase"] for item in logs] == ["llm", "artifact"]
    assert json.dumps(logs, ensure_ascii=False)


def test_iter_task_detail_and_trace_api(tmp_path):
    from tests.test_api import _client

    client = _client(tmp_path)
    conversation = client.post(
        "/api/conversations", json={"title": "trace"}
    ).json()["data"]
    task = client.post(
        "/api/jarvis/tasks", json={"conv_id": conversation["id"]}
    ).json()["data"]
    assert task["trace_id"]

    detail = client.get(f"/api/jarvis/tasks/{task['task_id']}").json()["data"]
    assert detail["trace_id"] == task["trace_id"]

    trace = client.get(f"/api/trace/{task['trace_id']}").json()["data"]
    assert trace[0]["task_id"] == task["task_id"]


def test_agent_state_carries_trace_id():
    from jarvis_agent.graph import AgentState

    state = AgentState(user_input="x", conv_id=1, trace_id="trace-graph")
    assert state["trace_id"] == "trace-graph"
