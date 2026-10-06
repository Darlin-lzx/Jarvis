"""共享 pytest fixtures：提供已 bootstrap 内置数据的临时库。"""
import pytest

from db_loc_agent.bootstrap import bootstrap
from db_loc_agent.db import Database


@pytest.fixture
def db(tmp_path):
    """已导入 data/seed 内置数据的临时 SQLite 库。"""
    d = Database(str(tmp_path / "t.db"))
    bootstrap(d)
    return d
