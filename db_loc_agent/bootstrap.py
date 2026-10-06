"""Bootstrap：把 data/seed/*.json 幂等导入业务库（替代代码中的写死数据）。

用法：
    python run_seed.py              # 用 config.yaml 的数据库（MySQL 或 SQLite）
    python -m db_loc_agent.bootstrap

说明：
- 仅同步 seed 中包含的内置/示例数据；用户自定义且不在 seed 中的记录不受影响。
- 可重复执行（幂等）：agents/models/sysdict/spaces 按唯一键 find-or-create，
  pipeline 按名称整体重建以保证步骤顺序。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from sqlalchemy import delete, select

from db_loc_agent.config import BASE_DIR, load_config
from db_loc_agent.db import (AgentDef, Database, ModelDef, Pipeline, Space,
                             SpaceSubsystem, SysDict, UserProfile)

SEED_DIR = BASE_DIR / "data" / "seed"


def _load(name: str) -> Any:
    p = SEED_DIR / f"{name}.json"
    return json.loads(p.read_text(encoding="utf-8"))


def bootstrap(db: Database) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    with db.session() as s:
        # 1) agents
        n = 0
        for a in _load("agents"):
            row = s.scalar(select(AgentDef).where(AgentDef.agent_id == a["agent_id"]))
            is_new = row is None
            if row is None:
                row = AgentDef(agent_id=a["agent_id"])
                s.add(row)
            row.name = a["name"]
            row.alias = a.get("alias", "")
            row.description = a.get("description", "")
            row.intent = a["intent"]
            row.agent_type = a.get("agent_type", "子Agent")
            row.product_type = a.get("product_type", "其他")
            row.stage = a.get("stage", "")
            row.sub_agents = json.dumps(a.get("sub_agents", []), ensure_ascii=False)
            row.gen_artifact = bool(a.get("gen_artifact", False))
            row.output_files = json.dumps(a.get("output_files", []), ensure_ascii=False)
            row.default_prompt = a.get("default_prompt", "")
            row.tools = json.dumps(a.get("tools", []), ensure_ascii=False)
            row.bound_kbs = "[]"
            # enabled 是用户运行时状态；seed 只给新记录初始值，不覆盖已有开关。
            if is_new:
                row.enabled = bool(a.get("enabled", True))
            n += 1
        counts["agents"] = n

        # 2) pipeline（按名称整体重建）
        pl_rows = _load("pipeline")
        names = {p["pipeline_name"] for p in pl_rows}
        for pname in names:
            s.execute(delete(Pipeline).where(Pipeline.pipeline_name == pname))
        for p in pl_rows:
            s.add(Pipeline(pipeline_name=p["pipeline_name"], agent_id=p["agent_id"],
                           label=p.get("label", ""), desc=p.get("desc", ""),
                           sort_order=p.get("sort_order", 0)))
        counts["pipeline"] = len(pl_rows)

        # 3) sysdict
        n = 0
        for d in _load("sysdict"):
            row = s.scalar(select(SysDict).where(
                SysDict.category == d["category"], SysDict.dict_key == d["dict_key"]))
            if row is None:
                row = SysDict(category=d["category"], dict_key=d["dict_key"])
                s.add(row)
            row.dict_value = d.get("dict_value", "")
            row.description = d.get("description", "")
            n += 1
        counts["sysdict"] = n

        # 4) models
        n = 0
        for m in _load("models"):
            row = s.scalar(select(ModelDef).where(ModelDef.model_id == m["model_id"]))
            if row is None:
                row = ModelDef(model_id=m["model_id"])
                s.add(row)
            row.name = m["name"]
            row.type = m.get("type", "LLM")
            row.provider = m.get("provider", "API接口")
            row.status = m.get("status", "已启用")
            row.api_url = m.get("api_url", "")
            row.api_key = m.get("api_key", "")
            row.version = m.get("version", "")
            row.timeout = m.get("timeout", 60)
            row.max_tokens = m.get("max_tokens", 4096)
            row.description = m.get("description", "")
            row.used_by_agents = json.dumps(m.get("used_by_agents", []), ensure_ascii=False)
            n += 1
        counts["models"] = n

        # 5) spaces + subsystems
        n = 0
        for sp in _load("spaces"):
            row = s.scalar(select(Space).where(Space.name == sp["name"]))
            if row is None:
                row = Space(name=sp["name"])
                s.add(row)
                s.flush()
            row.description = sp.get("description", "")
            for sub in sp.get("subsystems", []):
                ss = s.scalar(select(SpaceSubsystem).where(
                    SpaceSubsystem.space_id == row.id,
                    SpaceSubsystem.name == sub["name"]))
                if ss is None:
                    s.add(SpaceSubsystem(space_id=row.id, name=sub["name"],
                                         description=sub.get("description", "")))
            n += 1
        counts["spaces"] = n

        # 6) user_profile（当前登录用户，单行；按首行 find-or-create，改名/更新幂等）
        n = 0
        for u in _load("user_profile"):
            row = s.scalar(select(UserProfile).order_by(UserProfile.id).limit(1))
            if row is None:
                row = UserProfile(name=u.get("name", ""))
                s.add(row)
            row.name = u.get("name", row.name or "")
            row.role = u.get("role", "")
            row.title = u.get("title", "")
            row.email = u.get("email", "")
            row.avatar_color = u.get("avatar_color", "#5b7cfa")
            row.enabled = bool(u.get("enabled", True))
            n += 1
        counts["user_profile"] = n

        s.commit()
    return counts


def main() -> None:
    cfg = load_config()
    db = Database(cfg.db_path, cfg.mysql_url or None)
    counts = bootstrap(db)
    print("Bootstrap 完成：" + ", ".join(f"{k}={v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
