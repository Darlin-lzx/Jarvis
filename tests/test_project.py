import os
import tempfile
import pytest

from db_loc_agent.db import Database
from db_loc_agent.project import ProjectError, ProjectService


@pytest.fixture()
def proj():
    fd, path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    db = Database(path)
    yield ProjectService(db)
    db.engine.dispose()
    os.remove(path)


def test_space_subsystem_task_flow(proj):
    sp = proj.create_space("测试空间", "描述", kb_ids=[])
    assert sp["id"] > 0
    sub = proj.create_subsystem(sp["id"], "营业系统")
    assert sub["name"] == "营业系统"
    task = proj.create_task(space_id=sp["id"], sub_system_id=sub["id"],
                            name="DDL迁移", description="", kb_ids=[], agent_id="a1")
    assert task["status"] == "pending" and task["space_id"] == sp["id"]
    # 空间不可改
    with pytest.raises(ProjectError) as ei:
        proj.update_task(task["id"], {"space_id": 999})
    assert ei.value.status == 403
    # 有任务时空间不可删
    with pytest.raises(ProjectError) as ei:
        proj.delete_space(sp["id"])
    assert ei.value.status == 409


def test_ensure_default_space_is_idempotent(proj):
    first = proj.ensure_default_space()
    second = proj.ensure_default_space()

    assert first["name"] == "默认空间"
    assert first["id"] == second["id"]
    assert [s["name"] for s in proj.list_spaces() if s["name"] == "默认空间"] == ["默认空间"]


def test_task_delete_cascades_conversations(proj):
    """删除任务：级联删除其下全部会话（含消息/trace/产物），知识库副本保留。"""
    sp = proj.create_space("S", "")
    sub = proj.create_subsystem(sp["id"], "营业系统")
    task = proj.create_task(space_id=sp["id"], sub_system_id=sub["id"], name="T")
    with proj.db.session() as s:
        from db_loc_agent.db import Conversation
        s.add(Conversation(title="c1", space_id=sp["id"], task_id=task["id"]))
        s.commit()
    proj.delete_task(task["id"])
    with proj.db.session() as s:
        from db_loc_agent.db import Conversation
        c = s.query(Conversation).first()
        assert c is None, "删除任务应级联删除其下会话"
