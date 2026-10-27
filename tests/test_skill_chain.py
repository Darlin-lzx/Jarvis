"""技能链测试：chain 声明解析、顺序执行、上下文传递、失败中断"""
import pytest

from jarvis_agent.db import Database
from jarvis_agent.skills import SkillService


@pytest.fixture()
def svc(tmp_path):
    db = Database(db_path=str(tmp_path / "t.db"))
    return SkillService(db, str(tmp_path / "skills"))


def _mk_script(svc, skill_id, code, fname="run.py"):
    svc.create(skill_id, skill_id, code)
    svc.update_md_script(skill_id, fname)
    d = svc._scripts_dir(skill_id)
    (d / fname).write_text(code, encoding="utf-8")
    return svc

STEPS_A = """import os
print("STEP-A", os.getenv("CHAIN_CTX_FILE", ""))
print("A-OUT")
"""

STEPS_B = """import os, json
ctx = json.load(open(os.getenv("CHAIN_CTX_FILE")))
print("B-STEPS", [s.get("skill") for s in ctx["steps"]])
print("B-OUT")
"""


def test_run_chain_order_and_ctx(svc):
    _mk_script(svc, "step-a", STEPS_A)
    _mk_script(svc, "step-b", STEPS_B)
    svc.create_from_md(
        "---\nname: pipe\ndescription: 顺序编排\n"
        "chain: step-a, step-b\n---\n\n编排说明\n")
    info = svc.get("pipe")
    assert info["chain"] == ["step-a", "step-b"]
    assert info["script"] is None
    res = svc.run_chain("pipe")
    assert res["ok"] is True
    assert "STEP-A" in res["stdout"]
    assert "A-OUT" in res["stdout"]
    assert "B-STEPS" in res["stdout"]
    assert '"skill": "step-a"' in res["stdout"] or "step-a" in res["stdout"]
    assert [s["skill"] for s in res["steps"]] == ["step-a", "step-b"]


def test_run_chain_sub_step_fails(svc):
    _mk_script(svc, "ok-step", 'import sys\nprint("ok")\nsys.exit(1)\n')
    _mk_script(svc, "never-run", 'print("SHOULD-NOT-RUN")\n')
    svc.create_from_md(
        "---\nname: breaker\ndescription: 失败中断\n"
        "chain: ok-step, never-run\n---\n\n说明\n")
    res = svc.run_chain("breaker")
    assert res["ok"] is False
    # 第一步 sys.exit(1) 即失败，绝不执行第二步
    assert "never-run" not in [s["skill"] for s in res.get("steps", [])]


def test_run_chain_fallback_single_script(svc):
    _mk_script(svc, "solo", 'print("solo-out")\n')
    res = svc.run_chain("solo")  # 无 chain，退化为单脚本
    assert res["ok"] is True
    assert "solo-out" in res["stdout"]


def test_run_chain_missing_sub(svc):
    svc.create_from_md(
        "---\nname: miss\ndescription: 缺子技能\n"
        "chain: nonexist\n---\n\n说明\n")
    res = svc.run_chain("miss")
    assert res["ok"] is False
    assert "不存在" in res["error"]


def test_update_keeps_chain_declaration(svc):
    svc.create_from_md(
        "---\nname: pipe\ndescription: 编排\nchain: step-a,step-b\n---\n\n正文\n")
    svc.update("pipe", "管道2", "新描述", "新正文")
    info = svc.get("pipe")
    assert info["chain"] == ["step-a", "step-b"]
    assert info["content"] == "新正文"