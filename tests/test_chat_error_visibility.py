import json


def _client(tmp_path):
    from tests.test_api import _client as api_client

    return api_client(tmp_path)


def test_graph_error_message_is_streamed_to_chat(tmp_path, monkeypatch):
    import jarvis_agent.app as app_module

    class ErrorGraph:
        def stream(self, initial, stream_mode=None):
            yield "updates", {
                "error": {
                    "error_message": (
                        "Error code: 429 - 余额不足或无可用资源包,请充值。"
                    ),
                    "reply": "执行失败：余额不足",
                },
            }

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: ErrorGraph())
    client = _client(tmp_path)
    conversation = client.post(
        "/api/conversations", json={"title": "错误可见"}
    ).json()["data"]

    response = client.post("/api/chat/stream", json={
        "message": "你是谁", "conv_id": conversation["id"],
        "agent_id": "jarvis_commander",
    })

    assert response.status_code == 200
    events = [json.loads(line.removeprefix("data: "))
              for line in response.text.splitlines() if line.startswith("data: ")]
    assert any(event.get("type") == "error"
               and "余额不足" in str(event.get("content")) for event in events)
    assert sum(event.get("type") == "error"
               and "余额不足" in str(event.get("content")) for event in events) == 1


def test_commander_small_talk_does_not_create_iteration_task(tmp_path, monkeypatch):
    import jarvis_agent.app as app_module
    from jarvis_agent.db import Database, JarvisTask
    from sqlalchemy import select

    captured = {}

    class CommanderGraph:
        def stream(self, initial, stream_mode=None):
            captured["task_state"] = initial.get("task_state")
            yield "messages", (type("Chunk", (), {"content": "我是小枢", "tool_call_chunks": None})(), {})

    monkeypatch.setattr(app_module, "build_graph", lambda *args, **kwargs: CommanderGraph())
    client = _client(tmp_path)
    conversation = client.post(
        "/api/conversations", json={"title": "普通问答"}
    ).json()["data"]

    response = client.post("/api/chat/stream", json={
        "message": "你是谁", "conv_id": conversation["id"],
        "agent_id": "jarvis_commander",
    })

    assert response.status_code == 200
    assert "我是小枢" in response.text
    with Database(str(tmp_path / "t.db")).session() as session:
        assert session.scalars(select(JarvisTask)).all() == []
    assert captured["task_state"].get("migrate_task_id") is None
