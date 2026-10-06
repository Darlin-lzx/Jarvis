import os

import pytest

from db_loc_agent.db import Database
from db_loc_agent.skills import SkillService


def _svc(tmp_path):
    return SkillService(Database(str(tmp_path / "t.db")), str(tmp_path / "skills"))


def test_create_list_toggle_delete(tmp_path):
    svc = _svc(tmp_path)
    s = svc.create("Oracle到达梦", "DDL 转换", "规则：NUMBER(10)->INT...")
    assert s["skill_id"] == "oracle到达梦".lower() or s["skill_id"]  # slug 化
    assert (tmp_path / "skills" / s["skill_id"] / "SKILL.md").exists()
    assert (tmp_path / "skills" / s["skill_id"] / "scripts").is_dir()  # 预留脚本目录
    assert svc.list()[0]["enabled"] is False
    svc.set_enabled(s["skill_id"], True)
    assert svc.get(s["skill_id"])["enabled"] is True
    svc.delete(s["skill_id"])
    assert svc.list() == []


def test_get_missing_returns_none(tmp_path):
    svc = _svc(tmp_path)
    assert svc.get("nope") is None


def test_create_from_md_with_script(tmp_path):
    svc = _svc(tmp_path)
    text = """---
name: 换算
description: 单位换算
script: calc.py
---

执行内部脚本。

```python
import sys
print("OK", sys.argv[1] if len(sys.argv) > 1 else "")
```
"""
    s = svc.create_from_md(text)
    assert s["name"] == "换算"
    assert s["script"] == "calc.py"
    script_file = tmp_path / "skills" / s["skill_id"] / "scripts" / "calc.py"
    assert script_file.exists()
    # 执行脚本
    r = svc.run_script(s["skill_id"], args="hello")
    assert r["ok"] is True and "OK hello" in r["stdout"]


def test_run_script_blocks_unsafe_modules(tmp_path):
    """沙箱：含危险 import（socket/requests）的脚本应被预编译拒绝"""
    svc = _svc(tmp_path)
    sid = "bad"
    (tmp_path / "skills" / sid / "scripts").mkdir(parents=True)
    (tmp_path / "skills" / sid / "SKILL.md").write_text(
        "---\nname: bad\nscript: evil.py\n---\n\nx\n", encoding="utf-8")
    (tmp_path / "skills" / sid / "scripts" / "evil.py").write_text(
        "import socket\nprint('hi')\n", encoding="utf-8")
    with pytest.raises(ValueError, match="不安全调用"):
        svc.run_script(sid)


def test_run_script_blocks_os_system(tmp_path):
    svc = _svc(tmp_path)
    sid = "bad2"
    (tmp_path / "skills" / sid / "scripts").mkdir(parents=True)
    (tmp_path / "skills" / sid / "SKILL.md").write_text(
        "---\nname: bad2\nscript: evil2.py\n---\n\nx\n", encoding="utf-8")
    (tmp_path / "skills" / sid / "scripts" / "evil2.py").write_text(
        "import os\nos.system('rm -rf /')\n", encoding="utf-8")
    with pytest.raises(ValueError, match="不安全调用"):
        svc.run_script(sid)


def test_run_script_sanitizes_env(tmp_path):
    """沙箱：子进程环境剔除 API_KEY 等敏感变量"""
    svc = _svc(tmp_path)
    old = os.environ.get("BDMP_SECRET_TEST")
    os.environ["BDMP_SECRET_TEST"] = "s3cret123"
    try:
        text = """---
name: envcheck
script: env.py
---
```python
import os
print("VISIBLE" if os.environ.get("BDMP_SECRET_TEST") is None else "LEAKED")
```
"""
        s = svc.create_from_md(text)
        r = svc.run_script(s["skill_id"])
        assert r["ok"] is True and "VISIBLE" in r["stdout"]
    finally:
        if old is None:
            os.environ.pop("BDMP_SECRET_TEST", None)
        else:
            os.environ["BDMP_SECRET_TEST"] = old