import asyncio
import json
import queue
import threading
import time

from db_loc_agent.state_stream import MigrateStateBroadcaster


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


def test_broadcaster_sends_snapshot_to_task_connection():
    broadcaster = MigrateStateBroadcaster()
    websocket = FakeWebSocket()

    async def run():
        await broadcaster.add(1, websocket)
        broadcaster.broadcast(1, {"event": "state", "task_id": 1})
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert websocket.sent == [{"event": "state", "task_id": 1}]
        await broadcaster.remove(1, websocket)

    asyncio.run(run())
    assert broadcaster.count(1) == 0


def test_broadcaster_removes_failed_connection_and_keeps_healthy_connection():
    broadcaster = MigrateStateBroadcaster()
    failed = FakeWebSocket()
    healthy = FakeWebSocket()

    async def failed_send(_data):
        raise RuntimeError("closed")

    failed.send_json = failed_send

    async def run():
        await broadcaster.add(1, failed)
        await broadcaster.add(1, healthy)
        broadcaster.broadcast(1, {"event": "state", "task_id": 1})
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert healthy.sent == [{"event": "state", "task_id": 1}]
        assert broadcaster.count(1) == 1

    asyncio.run(run())


def _client(tmp_path):
    from tests.test_api import _client as api_client

    return api_client(tmp_path)


def test_websocket_returns_initial_migrate_state(tmp_path):
    client = _client(tmp_path)
    conversation = client.post(
        "/api/conversations", json={"title": "状态通道"}
    ).json()["data"]
    task = client.post(
        "/api/migrate/tasks", json={"conv_id": conversation["id"]}
    ).json()["data"]

    with client.websocket_connect(f"/ws/migrate/{task['task_id']}") as websocket:
        snapshot = websocket.receive_json()

    assert snapshot["event"] == "state"
    assert snapshot["task_id"] == task["task_id"]
    assert snapshot["status"] == "DATA_COLLECTION"


def test_websocket_reports_missing_task(tmp_path):
    client = _client(tmp_path)
    with client.websocket_connect("/ws/migrate/99999") as websocket:
        snapshot = websocket.receive_json()

    assert snapshot["event"] == "not_found"


def test_websocket_initial_snapshot_includes_persisted_execution_state(tmp_path):
    from db_loc_agent.db import Conversation, Database

    client = _client(tmp_path)
    conversation = client.post(
        "/api/conversations", json={"title": "等待确认"}
    ).json()["data"]
    task = client.post(
        "/api/migrate/tasks", json={"conv_id": conversation["id"]}
    ).json()["data"]
    with Database(str(tmp_path / "t.db")).session() as session:
        row = session.get(Conversation, conversation["id"])
        row.task_state = json.dumps({
            "migrate_task_id": task["task_id"],
            "current_step": "DATA_COLLECTION",
            "step_status": "waiting_confirm",
            "awaiting_confirmation": True,
        }, ensure_ascii=False)
        session.commit()

    with client.websocket_connect(f"/ws/migrate/{task['task_id']}") as websocket:
        snapshot = websocket.receive_json()

    assert snapshot["step_status"] == "waiting_confirm"
    assert snapshot["awaiting_confirmation"] is True


def test_chat_stream_broadcasts_langgraph_task_state(tmp_path, monkeypatch):
    from langchain_core.messages import AIMessage

    import db_loc_agent.app as app_module
    from db_loc_agent.db import Conversation, Database

    class StateGraph:
        def stream(self, initial, stream_mode=None):
            yield "custom", {"type": "system", "message": "start"}
            yield "updates", {"migration_collector": {
                "task_state": {
                    "migrate_task_id": initial["task_state"]["migrate_task_id"],
                    "current_step": "DATA_COLLECTION",
                    "step_status": "done",
                },
            }}
            yield "messages", (AIMessage(content="采集完成"), {})

    monkeypatch.setattr(app_module, "build_graph",
                        lambda *args, **kwargs: StateGraph())
    client = _client(tmp_path)
    conversation = client.post(
        "/api/conversations", json={"title": "实时状态"}
    ).json()["data"]
    task = client.post(
        "/api/migrate/tasks", json={"conv_id": conversation["id"]}
    ).json()["data"]
    with Database(str(tmp_path / "t.db")).session() as session:
        row = session.get(Conversation, conversation["id"])
        row.task_state = json.dumps({
            "migrate_task_id": task["task_id"],
            "current_step": "DATA_COLLECTION",
            "step_status": "running",
        }, ensure_ascii=False)
        session.commit()

    frames: queue.Queue[dict] = queue.Queue()

    def read_socket():
        with client.websocket_connect(f"/ws/migrate/{task['task_id']}") as websocket:
            frames.put(websocket.receive_json())
            while True:
                frames.put(websocket.receive_json())

    reader = threading.Thread(target=read_socket, daemon=True)
    reader.start()
    time.sleep(0.1)
    with client.stream("POST", "/api/chat/stream", json={
            "message": "继续", "conv_id": conversation["id"],
            "agent_id": "migration_commander"}) as response:
        assert response.status_code == 200
        list(response.iter_lines())
    time.sleep(0.1)

    deadline = time.monotonic() + 2
    snapshots = []
    while time.monotonic() < deadline:
        try:
            snapshots.append(frames.get(timeout=0.1))
        except queue.Empty:
            if snapshots:
                break
    snapshot = next(item for item in snapshots if item.get("step_status") == "done")

    assert snapshot["event"] == "state"
    assert snapshot["step_status"] == "done"
