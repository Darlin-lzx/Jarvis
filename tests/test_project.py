import os
import tempfile
import pytest

from jarvis_agent.db import Database
from jarvis_agent.project import ProjectError, ProjectService


@pytest.fixture()
def proj():
    fd, path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    db = Database(path)
    yield ProjectService(db)
    db.engine.dispose()
    os.remove(path)


def test_space_task_flow_ignores_subsystem_dimension(proj):
    sp = proj.create_space("测试空间", "描述", kb_ids=[])
    assert sp["id"] > 0
    legacy_sub = proj.create_subsystem(sp["id"], "营业系统")
    legacy_task = proj.create_task(space_id=sp["id"], name="存量任务")
    task = proj.create_task(space_id=sp["id"], name="DDL迁移",
                            description="", kb_ids=[], agent_id="a1")

    assert task["status"] == "pending"
    assert task["space_id"] == sp["id"]
    assert task["sub_system_id"] is None
    assert {t["id"] for t in proj.list_tasks(sp["id"], sub_system_id=legacy_sub["id"])} == {
        legacy_task["id"], task["id"]
    }
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
    task = proj.create_task(space_id=sp["id"], name="T")
    with proj.db.session() as s:
        from jarvis_agent.db import Conversation
        s.add(Conversation(title="c1", space_id=sp["id"], task_id=task["id"]))
        s.commit()
    proj.delete_task(task["id"])
    with proj.db.session() as s:
        from jarvis_agent.db import Conversation
        c = s.query(Conversation).first()
        assert c is None, "删除任务应级联删除其下会话"


def test_task_delete_cascades_migrate_state(proj):
    """删除业务任务必须同步删除其跨工程迭代任务与状态事件，避免新任务接入旧状态。"""
    import json

    from jarvis_agent.db import (
        Conversation, JarvisStateEvent, JarvisTask,
    )

    sp = proj.create_space("S", "")
    task = proj.create_task(space_id=sp["id"], name="T")
    with proj.db.session() as s:
        conv = Conversation(title="c1", space_id=sp["id"], task_id=task["id"])
        s.add(conv)
        s.flush()
        migrate = JarvisTask(
            conv_id=conv.id, space_id=sp["id"], project_task_id=task["id"],
            status="ORDER_SPLIT")
        s.add(migrate)
        s.flush()
        s.add(JarvisStateEvent(
            task_id=migrate.id, conv_id=conv.id, event_type="NODE_SUCCESS"))
        conv.task_state = json.dumps({"migrate_task_id": migrate.id})
        s.commit()
        migrate_id = migrate.id

    proj.delete_task(task["id"])

    with proj.db.session() as s:
        assert s.get(JarvisTask, migrate_id) is None
        assert s.query(JarvisStateEvent).filter(
            JarvisStateEvent.task_id == migrate_id).count() == 0
