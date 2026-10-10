from db_loc_agent.db import Database
from db_loc_agent.state_machine import MigrateStateService


def _service(tmp_path):
    db_path = tmp_path / "state.sqlite3"
    db = Database(str(db_path))
    return MigrateStateService(db), db


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


def test_source_datasource_reuse_is_scoped_by_space_and_project_task(tmp_path):
    svc, db = _service(tmp_path)
    try:
        other_space = svc.create(conv_id=1, space_id=1, source_ds_id="excel-1")
        old_task = svc.create(
            conv_id=99, project_task_id=10, space_id=2, source_ds_id="excel-1")
        svc.create(
            conv_id=20, project_task_id=20, space_id=2, source_ds_id="excel-1")

        found = svc.get_by_source_ds("excel-1", space_id=2, project_task_id=10)
        assert found.id == old_task.id
        assert svc.get_by_source_ds("excel-1", space_id=2, project_task_id=30) is None
        assert svc.get_by_source_ds("excel-1", space_id=1).id == other_space.id
    finally:
        db.engine.dispose()
