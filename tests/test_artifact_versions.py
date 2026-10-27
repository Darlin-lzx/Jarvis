import pytest


def _service(tmp_path):
    from jarvis_agent.artifacts import ArtifactService
    from jarvis_agent.db import Database

    return ArtifactService(
        Database(str(tmp_path / "t.db")), str(tmp_path / "artifacts")
    )


def test_repeated_task_artifact_creates_versions_without_overwrite(tmp_path):
    service = _service(tmp_path)
    first = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 1;"}, task_id=13, trace_id="trace-1",
    )["files"][0]
    second = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 2;"}, task_id=13, trace_id="trace-2",
    )["files"][0]

    assert (first["version"], second["version"], second["parent_version"]) == (1, 2, 1)
    assert service.read(first["id"]) == "SELECT 1;"
    assert service.read(second["id"]) == "SELECT 2;"
    assert first["path"] != second["path"]
    assert [version["version"] for version in service.list_versions(second["id"])] == [1, 2]
    assert service.read_version(second["id"], 1) == "SELECT 1;"


def test_artifact_diff_reports_added_removed_and_changed(tmp_path):
    service = _service(tmp_path)
    service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "CREATE TABLE t (\n  id NUMBER\n);"}, task_id=13,
    )
    second = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "CREATE TABLE t (\n  id BIGINT,\n  name VARCHAR(100)\n);"},
        task_id=13,
    )["files"][0]

    diff = service.diff(second["id"], 1, 2)
    assert diff["summary"]["added"] >= 2
    assert diff["summary"]["removed"] >= 1
    assert diff["summary"]["changed"] >= 1
    assert {"added", "removed", "changed"}.issubset(
        {block["kind"] for block in diff["blocks"]}
    )


def test_artifact_diff_rejects_missing_version(tmp_path):
    service = _service(tmp_path)
    record = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 1"}, task_id=13,
    )["files"][0]

    with pytest.raises(ValueError):
        service.diff(record["id"], 1, 99)


def test_product_version_and_diff_apis(tmp_path):
    from tests.test_api import _client

    client = _client(tmp_path)
    service = _service(tmp_path)
    service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT 1"}, task_id=13,
    )
    second = service.write(
        "sess/agent/object", 1, "agent", "object",
        {"report.sql": "SELECT\n2"}, task_id=13,
    )["files"][0]

    versions = client.get(f"/api/products/{second['id']}/versions").json()["data"]
    old = client.get(f"/api/products/{second['id']}/versions/1").json()["data"]
    diff = client.get(
        f"/api/products/{second['id']}/diff", params={"left": 1, "right": 2}
    ).json()["data"]

    assert [version["version"] for version in versions] == [1, 2]
    assert old["content"] == "SELECT 1"
    assert diff["summary"]["added"] == 2
    assert diff["summary"]["removed"] == 1
