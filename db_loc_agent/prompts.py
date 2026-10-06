"""提示词管理服务（SQLite）"""
from __future__ import annotations

from typing import Dict, List, Optional

from sqlalchemy import func as sa_func, select

from db_loc_agent.db import AgentDef, Database, Prompt

# 提示词类型枚举（与 prompts.type 列对应）
PROMPT_TYPE_SYSTEM_ROLE = "system_role"      # 系统角色
PROMPT_TYPE_TASK_INSTRUCTION = "task_instruction"  # 任务指令
PROMPT_TYPE_DOMAIN = "domain"                # 领域专用


class PromptService:
    def __init__(self, db: Database):
        self.db = db

    def list(self, category: str | None = None,
             prompt_type: str | None = None) -> List[Dict]:
        with self.db.session() as s:
            q = select(Prompt)
            if category:
                q = q.where(Prompt.category == category)
            if prompt_type:
                q = q.where(Prompt.type == prompt_type)
            return [self._to_dict(p) for p in s.scalars(q)]

    def get(self, prompt_id: int) -> Optional[Dict]:
        with self.db.session() as s:
            p = s.get(Prompt, prompt_id)
            return self._to_dict(p) if p else None

    def create(self, name: str, category: str, content: str, enabled: bool = True,
               prompt_type: str = "task_instruction") -> Dict:
        """创建提示词。prompt_type 取值 system_role / task_instruction / domain。"""
        with self.db.session() as s:
            p = Prompt(name=name, category=category, content=content,
                       enabled=enabled, type=prompt_type)
            s.add(p)
            s.commit()
            s.refresh(p)
            return self._to_dict(p)

    def update(self, prompt_id: int, **fields) -> Dict:
        with self.db.session() as s:
            p = s.get(Prompt, prompt_id)
            if not p:
                raise KeyError(f"提示词不存在: {prompt_id}")
            for k, v in fields.items():
                if hasattr(p, k):
                    setattr(p, k, v)
            s.commit()
            return self._to_dict(p)

    def delete(self, prompt_id: int) -> None:
        """删除提示词。type=system_role 且已被 Agent 绑定时拒绝删除。"""
        with self.db.session() as s:
            p = s.get(Prompt, prompt_id)
            if not p:
                raise KeyError(f"提示词不存在: {prompt_id}")
            if (p.type or "task_instruction") == PROMPT_TYPE_SYSTEM_ROLE:
                n = s.scalar(select(sa_func.count(AgentDef.id))
                             .where(AgentDef.system_role_prompt_id == prompt_id)) or 0
                if n:
                    raise ValueError(f"该系统角色已被 {n} 个 Agent 绑定，请先解绑后再删除")
            s.delete(p)
            s.commit()

    def get_bound_agents(self, prompt_id: int) -> List[Dict]:
        """返回绑定了该提示词的 Agent 列表 [{agent_id, name, enabled}]。"""
        with self.db.session() as s:
            rows = list(s.scalars(select(AgentDef)
                                  .where(AgentDef.system_role_prompt_id == prompt_id)
                                  .order_by(AgentDef.id)))
        return [{"agent_id": r.agent_id, "name": r.name or r.agent_id,
                 "enabled": bool(r.enabled) if r.enabled is not None else True}
                for r in rows]

    def get_enabled_system_role_dict(self) -> Dict[int, Dict]:
        """返回 id → {name, enabled} 映射（全部 type=system_role 提示词，供绑定校验/解析）。"""
        with self.db.session() as s:
            rows = list(s.scalars(
                select(Prompt).where(Prompt.type == PROMPT_TYPE_SYSTEM_ROLE)))
        return {p.id: {"name": p.name, "enabled": bool(p.enabled) if p.enabled is not None else False}
                for p in rows}

    def _bound_agent_count(self, prompt_id: int) -> int:
        """被 AgentDef.system_role_prompt_id 引用的 Agent 数量。"""
        with self.db.session() as s:
            n = s.scalar(select(sa_func.count(AgentDef.id))
                         .where(AgentDef.system_role_prompt_id == prompt_id))
            return n or 0

    def _to_dict(self, p: Prompt) -> Dict:
        bound = self._bound_agent_count(p.id) if (p.type or "task_instruction") == PROMPT_TYPE_SYSTEM_ROLE else 0
        return {"id": p.id, "name": p.name, "category": p.category, "content": p.content,
                "type": p.type or "task_instruction", "enabled": p.enabled,
                "bound_agent_count": bound,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None}