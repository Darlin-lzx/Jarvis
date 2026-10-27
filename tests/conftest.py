"""共享 pytest fixtures：提供已 bootstrap 内置数据的临时库 + 测试全局配置。"""
import os

# 测试不启用登录鉴权（测试客户端不携带令牌）
os.environ.setdefault("JARVIS_AUTH_DISABLED", "1")

import pytest

from jarvis_agent.bootstrap import bootstrap
from jarvis_agent.db import Database


@pytest.fixture
def db(tmp_path):
    """已导入 data/seed 内置数据的临时 SQLite 库。"""
    d = Database(str(tmp_path / "t.db"))
    bootstrap(d)
    return d
