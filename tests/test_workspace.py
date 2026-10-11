import subprocess

import pytest

from jarvis_agent.agents import AgentService
from jarvis_agent.bootstrap import bootstrap
from jarvis_agent.db import Database
from jarvis_agent.workspace import WorkspaceError, WorkspaceService


def _service(tmp_path):
    db = Database(str(tmp_path / "workspace.db"))
    bootstrap(db)
    root = tmp_path / "order-center"
    root.mkdir()
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
    (root / "Handler.java").write_text("class Handler {}\n", encoding="utf-8")
    agents = AgentService(db)
    agents.update("family_order_agent", project_dir=str(root))
    return WorkspaceService(db, agents), root


def test_summary_reads_git_branch_and_changes(tmp_path):
    service, root = _service(tmp_path)
    (root / "Handler.java").write_text("class Handler changed {}\n", encoding="utf-8")
    (root / "New.java").write_text("class New {}\n", encoding="utf-8")

    summary = service.summary("family_order_agent")

    assert summary["available"] is True
    assert summary["git"]["is_repo"] is True
    assert summary["changed_count"] == 2
    assert {item["path"] for item in summary["changes"]} == {
        "Handler.java", "New.java"
    }


def test_file_and_tree_are_confined_to_project(tmp_path):
    service, root = _service(tmp_path)
    root.joinpath("src").mkdir()
    root.joinpath("src/Handler.java").write_text("class Handler {}\n", encoding="utf-8")

    tree = service.tree("family_order_agent")
    file = service.file("family_order_agent", "src/Handler.java")

    assert [item["path"] for item in tree["items"]] == ["src", "Handler.java"]
    assert file["content"] == "class Handler {}\n"
    with pytest.raises(WorkspaceError) as exc:
        service.file("family_order_agent", "../../workspace.db")
    assert exc.value.status_code == 400


def test_missing_project_returns_unavailable_summary(tmp_path):
    db = Database(str(tmp_path / "empty.db"))
    bootstrap(db)
    service = WorkspaceService(db, AgentService(db))

    assert service.summary("boot_agent")["available"] is False
    with pytest.raises(WorkspaceError):
        service.file("boot_agent", "README.md")


def test_evidence_extracts_reads_and_searches(tmp_path):
    from jarvis_agent.db import TraceLog

    service, _ = _service(tmp_path)
    with service.db.session() as session:
        session.add(TraceLog(
            trace_id="trace-evidence", conv_id=15,
            phase="code", span="code_read", agent_id="family_order_agent",
            message="读取工程文件: Handler.java"))
        session.add(TraceLog(
            trace_id="trace-evidence", conv_id=15,
            phase="code", span="code_search", agent_id="family_order_agent",
            message="搜索工程代码: 移动看家（命中 9 个文件）"))
        session.commit()

    evidence = service.evidence("family_order_agent", conv_id=15)

    assert evidence["counts"] == {"read": 1, "search": 1, "kb": 0}
    assert evidence["items"][0]["type"] == "search"
    assert evidence["items"][0]["query"] == "移动看家"
    assert evidence["items"][1]["type"] == "read"
    assert evidence["items"][1]["path"] == "Handler.java"
