"""Agent 注册中心：全部从业务库读取（DB AgentDef），代码不含写死数据。

新环境 / 新数据库通过 bootstrap 初始化：
    python run_seed.py        # 把 data/seed/*.json 导入配置的业务库
运行时 AgentService / PipelineService / SysDictService 只从数据库读取。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from db_loc_agent.db import AgentDef, Database, Pipeline, Prompt, SysDict


def _parse_output_files(raw) -> List[str]:
    """把 list / JSON 字符串 / 逗号文本统一解析为字符串列表。"""
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw]
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            v = json.loads(s)
            return [str(x) for x in v] if isinstance(v, (list, tuple)) else [s]
        except json.JSONDecodeError:
            return [x.strip() for x in s.split(",") if x.strip()]
    return []


class AgentService:
    """Agent 注册中心：仅从 DB AgentDef 读取；可在配置界面增删改。"""

    def __init__(self, db: Optional[Database] = None):
        self.db = db

    def all(self, enabled_only: bool = False) -> List[Dict]:
        if self.db is None:
            return []
        with self.db.session() as s:
            rows = list(s.scalars(select(AgentDef).order_by(AgentDef.id)))
            role_ids = {int(r.system_role_prompt_id) for r in rows if r.system_role_prompt_id}
            role_map: Dict[int, Prompt] = {}
            if role_ids:
                for p in s.scalars(select(Prompt).where(Prompt.id.in_(role_ids))):
                    role_map[p.id] = p
        result: List[Dict] = []
        for r in rows:
            role = role_map.get(int(r.system_role_prompt_id)) if r.system_role_prompt_id else None
            result.append({
                "id": r.agent_id,
                "name": r.name or r.agent_id,
                "alias": r.alias or "",
                "product_type": r.product_type or "其他",
                "stage": r.stage or "",
                "description": r.description or "",
                "intent": r.intent or "",
                "agent_type": r.agent_type or "子Agent",
                "role": "commander" if (r.agent_type or "") == "主Agent" else "specialist",
                "sub_agents": _parse_output_files(r.sub_agents),
                "bound_kbs": _parse_output_files(r.bound_kbs),
                "tools": _parse_output_files(r.tools),
                "enabled": bool(r.enabled),
                "prompt_id": r.prompt_id,
                "system_role_prompt_id": r.system_role_prompt_id,
                "system_role_name": role.name if role is not None else None,
                "system_role_enabled": bool(role.enabled) if role is not None else None,
                "default_prompt": (r.default_prompt or "").strip(),
                "output_files": _parse_output_files(r.output_files),
                "gen_artifact": bool(r.gen_artifact),
                "builtin": False,
            })
        if enabled_only:
            result = [a for a in result if a.get("enabled")]
        return result

    def enabled(self) -> List[Dict]:
        return self.all(enabled_only=True)

    def get(self, agent_id: str) -> Optional[Dict]:
        return next((a for a in self.all() if a["id"] == agent_id), None)

    def resolve(self, intent: str) -> Optional[str]:
        """意图 → agent_id；未命中回退 nl2sql_qa（若存在）。"""
        for a in self.enabled():
            if a.get("intent") == intent:
                return a["id"]
        for a in self.enabled():
            if a["id"] == "nl2sql_qa":
                return a["id"]
        return None

    def intents(self) -> List[str]:
        seen, out = set(), []
        for a in self.enabled():
            if a.get("intent") and a["intent"] not in seen:
                seen.add(a["intent"])
                out.append(a["intent"])
        return out

    def create(self, agent_id: str, name: str, description: str, intent: str,
               default_prompt: str = "", output_files: Optional[List[str]] = None,
               gen_artifact: bool = False, enabled: bool = True,
               system_role_prompt_id: Optional[int] = None,
               agent_type: str = "子Agent", bound_kbs: Optional[List[str]] = None,
               sub_agents: Optional[List[str]] = None,
               tools: Optional[List[str]] = None,
               alias: str = "") -> Dict:
        if not agent_id or not agent_id.strip():
            raise ValueError("agent_id 不能为空")
        if not intent:
            raise ValueError("intent 不能为空")
        if system_role_prompt_id is not None:
            self._validate_system_role(system_role_prompt_id)
        if self.db is None:
            raise ValueError("未启用 DB，无法注册 agent")
        with self.db.session() as s:
            row = s.scalar(select(AgentDef).where(AgentDef.agent_id == agent_id))
            if row is None:
                row = AgentDef(agent_id=agent_id)
                s.add(row)
            row.name = name or agent_id
            row.alias = alias or ""
            row.description = description or ""
            row.intent = intent
            row.agent_type = agent_type or "子Agent"
            row.sub_agents = json.dumps(sub_agents or [], ensure_ascii=False)
            row.default_prompt = default_prompt or ""
            row.output_files = json.dumps(output_files or [], ensure_ascii=False)
            row.gen_artifact = bool(gen_artifact)
            row.enabled = bool(enabled)
            row.system_role_prompt_id = system_role_prompt_id
            row.agent_type = agent_type or "子Agent"
            row.bound_kbs = json.dumps(list(bound_kbs or []), ensure_ascii=False)
            row.tools = json.dumps(list(tools or []), ensure_ascii=False)
            s.commit()
            s.refresh(row)
        return self.get(agent_id) or {"id": agent_id}

    def update(self, agent_id: str, **fields) -> Dict:
        if self.db is None:
            raise ValueError("未启用 DB 无法更新 agent")
        allowed = {"name", "alias", "description", "intent", "default_prompt", "enabled",
                   "output_files", "gen_artifact", "system_role_prompt_id",
                   "agent_type", "bound_kbs", "tools", "sub_agents"}
        with self.db.session() as s:
            row = s.scalar(select(AgentDef).where(AgentDef.agent_id == agent_id))
            if row is None:
                row = AgentDef(agent_id=agent_id)
                s.add(row)
            for k, v in fields.items():
                if k not in allowed:
                    continue
                if k == "system_role_prompt_id":
                    v = None if v in (None, "") else int(v)
                    if v is not None:
                        self._validate_system_role(v)
                    row.system_role_prompt_id = v
                elif k in ("output_files", "bound_kbs", "tools", "sub_agents"):
                    setattr(row, k, json.dumps(_parse_output_files(v), ensure_ascii=False) if v else "[]")
                elif k in ("enabled", "gen_artifact"):
                    setattr(row, k, bool(v))
                elif v is not None:
                    setattr(row, k, str(v))
            s.commit()
            s.refresh(row)
        return self.get(agent_id) or {"id": agent_id}

    def _validate_system_role(self, prompt_id) -> None:
        if self.db is None:
            raise ValueError("系统角色提示词不存在或未启用")
        with self.db.session() as s:
            p = s.get(Prompt, prompt_id)
            if not p or (p.type or "task_instruction") != "system_role" or not p.enabled:
                raise ValueError("系统角色提示词不存在或未启用")

    def set_enabled(self, agent_id: str, enabled: bool) -> None:
        if self.db is None:
            raise ValueError("未启用 DB")
        with self.db.session() as s:
            row = s.scalar(select(AgentDef).where(AgentDef.agent_id == agent_id))
            if row is None:
                row = AgentDef(agent_id=agent_id)
                s.add(row)
            row.enabled = bool(enabled)
            s.commit()

    def delete(self, agent_id: str) -> None:
        if self.db is None:
            raise ValueError("未启用 DB")
        from sqlalchemy import delete as sa_delete
        with self.db.session() as s:
            s.execute(sa_delete(AgentDef).where(AgentDef.agent_id == agent_id))
            s.commit()


class PipelineService:
    """流水线读取：从 DB pipeline 表取主 Agent 的强制编排顺序。"""

    def __init__(self, db: Optional[Database] = None):
        self.db = db

    def steps(self, name: str = "migration") -> List[Dict[str, str]]:
        if self.db is None:
            return []
        with self.db.session() as s:
            rows = list(s.scalars(
                select(Pipeline).where(Pipeline.pipeline_name == name)
                .order_by(Pipeline.sort_order)))
        return [{"agent_id": r.agent_id, "label": r.label or "", "desc": r.desc or ""}
                for r in rows]


class SysDictService:
    """系统字典读取：从 DB sys_dict 取领域规则/提示词片段。"""

    def __init__(self, db: Optional[Database] = None):
        self.db = db

    def value(self, category: str, key: str) -> Optional[str]:
        if self.db is None:
            return None
        with self.db.session() as s:
            row = s.scalar(select(SysDict).where(
                SysDict.category == category, SysDict.dict_key == key))
            return row.dict_value if row else None

    def map(self, category: str) -> Dict[str, str]:
        if self.db is None:
            return {}
        with self.db.session() as s:
            rows = list(s.scalars(select(SysDict).where(SysDict.category == category)))
        return {r.dict_key: r.dict_value for r in rows}


# 兼容旧 API（需显式传入 db；这里保留薄封装）。
def resolve_agent(db: Database, intent: str) -> Optional[str]:
    return AgentService(db).resolve(intent)


def list_agents(db: Database) -> List[Dict]:
    return AgentService(db).all()
