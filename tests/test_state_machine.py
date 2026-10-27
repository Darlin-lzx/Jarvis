from jarvis_agent.db import Database
from jarvis_agent.state_machine import JarvisStateService


def _service(tmp_path):
    db_path = tmp_path / "state.sqlite3"
    db = Database(str(db_path))
    return JarvisStateService(db), db


def test_recent_active_is_scoped_by_space_and_project_task(tmp_path):
    svc, db = _service(tmp_path)
    try:
        other_space = svc.create(conv_id=1, space_id=1)
        old_task = svc.create(conv_id=99, project_task_id=10, space_id=2)
        svc.create(conv_id=20, project_task_id=20, space_id=2)

        assert svc.get_recent_active(space_id=2, project_task_id=10).id == old_task.id
        assert svc.get_recent_active(space_id=2, project_task_id=30) is None
        assert svc.get_recent_active(space_id=1).id == other_space.id
    finally:
        db.engine.dispose()


def test_default_flow_is_cross_project_iteration(tmp_path):
    svc, db = _service(tmp_path)
    try:
        flow = svc.get_flow()
        statuses = [n["status"] for n in flow]
        assert statuses == ["PAGE_SHOW", "ORDER_SPLIT", "ORDER_ACCEPT",
                            "RULE_CHECK", "CUSTOMER_CHECK", "FINISHED"]
    finally:
        db.engine.dispose()
