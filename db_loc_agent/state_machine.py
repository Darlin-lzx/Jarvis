"""领域状态机：数据库国产化迁移任务的核心流程控制器。

设计要点（竞赛区分点）：
- 业务流程固化在后端状态机，硬编码流转规则，**LLM 无权决定跳转节点**；
- 状态与已采集参数持久化到 db_migrate_task 表，断点续跑：重新打开任务从上次状态继续；
- 指挥官 Agent 只负责对话、渲染表单、调度子 Agent。

状态流转（硬编码，指挥官无权修改流转顺序；与 pipeline 一致）：
  DATA_COLLECTION →[确认]→ ASSESSMENT_RUNNING →[确认]→ SOLUTION_GENERATE →[确认]→
       CODE_MIGRATE →[确认]→ VERIFY_STAGE →[确认]→ FINISHED
  任意节点可进入 ERROR（保存当前已采集参数与资产，支持断点续跑）
  执行阶段每一级都需用户显式确认（继续/确认），后端才跨闸门进入下一阶段。
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from db_loc_agent.db import (DbMigrateTask, DbMigrateFlow,
                             MIGRATE_STATUS_ASSESSMENT_RUNNING,
                             MIGRATE_STATUS_BASIC_INFO_COLLECTED,
                             MIGRATE_STATUS_CODE_MIGRATE,
                             MIGRATE_STATUS_DATA_COLLECTION,
                             MIGRATE_STATUS_DATA_SOURCE_SELECTED,
                             MIGRATE_STATUS_ERROR, MIGRATE_STATUS_FINISHED,
                             MIGRATE_STATUS_INIT, MIGRATE_STATUS_OBJECT_SCANNING,
                             MIGRATE_STATUS_SOLUTION_GENERATE,
                             MIGRATE_STATUS_SQL_TRANSFORM,
                             MIGRATE_STATUS_VERIFY_STAGE, MIGRATE_STATUSES)

# 执行锁超时：2 分钟（页面关闭后自动释放，防止死锁；阶段执行通常 <1 分钟）
EXEC_LOCK_TTL_SECONDS = 120
# 不允许被执行的全局只读状态（完成后所有会话只读）
_LOCK_READONLY_STATES = (MIGRATE_STATUS_FINISHED,)

# 数据源/库类型候选（用于前后端表单渲染与关键词解析）
SOURCE_DB_TYPES = ["oracle", "mysql", "db2", "sqlserver", "postgresql"]
TARGET_DB_TYPES = ["dm", "kingbase", "gaussdb", "oceanbase", "opengauss", "polardb"]


class MigrateStateError(ValueError):
    """状态机非法流转异常（如重复选择数据源、跳过节点）。"""


# 默认任务流程静态表（页面可编排；数据库有编排记录时以库表为准）
# 字段：status 状态 / label 节点名 / description 说明 /
#       need_confirm 进入下一节点前是否需用户显式确认 / required_fields 离开本节点前必须采集的字段
DEFAULT_FLOW: List[Dict[str, Any]] = [
    {"status": MIGRATE_STATUS_DATA_COLLECTION, "label": "数据采集",
     "description": "采集源库元数据/表结构/对象清单（小采），并确认源/目标库类型、业务等级、容量、停机窗口等参数",
     "need_confirm": True,
     "required_fields": ["source_ds_id", "source_db_type", "target_db_type",
                         "db_business_level", "db_capacity", "stop_window"]},
    {"status": MIGRATE_STATUS_ASSESSMENT_RUNNING, "label": "迁移评估",
     "description": "评估专家（小评）结合规则命中做兼容性风险与工作量评估",
     "need_confirm": True, "required_fields": []},
    {"status": MIGRATE_STATUS_SOLUTION_GENERATE, "label": "迁移方案",
     "description": "方案专家（小方）汇总采集与评估结果，生成国产化迁移落地方案",
     "need_confirm": True, "required_fields": []},
    {"status": MIGRATE_STATUS_CODE_MIGRATE, "label": "代码改造",
     "description": "改造专家（小改）做 JDBC/ORM/存储过程应用代码适配",
     "need_confirm": True, "required_fields": []},
    {"status": MIGRATE_STATUS_VERIFY_STAGE, "label": "迁移验证",
     "description": "验证专家（小测）校验语法与结构一致性",
     "need_confirm": True, "required_fields": []},
    {"status": MIGRATE_STATUS_FINISHED, "label": "完成（终态）",
     "description": "任务全部完成，所有会话只读",
     "need_confirm": False, "required_fields": []},
]


def _select_all_flow():
    """流程全表查询（SQLAlchemy select 对象，供增删改共用）。"""
    from sqlalchemy import select
    return select(DbMigrateFlow)


def _flow_nodes(flow: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """带默认值与过滤：仅保留启用节点，按传入顺序返回。"""
    if not flow:
        return list(DEFAULT_FLOW)
    out = []
    for n in flow:
        if not n.get("enabled", True):
            continue
        out.append({
            "status": n.get("status", ""),
            "label": n.get("label", ""),
            "description": n.get("description", ""),
            "need_confirm": bool(n.get("need_confirm", True)),
            "required_fields": list(n.get("required_fields") or []),
        })
    return out


def next_state(current: str, collected: Dict[str, Any],
               flow: Optional[List[Dict[str, Any]]] = None) -> str:
    """确定性流转：依据当前状态 + 已采集字段在流程表中推导下一状态。

    流程表驱动（页面可编排节点顺序 / 确认闸门 / 启用停用）：
    - 找到当前节点在流程中的位置，取其后首个启用节点为候选；
    - 当前节点 required_fields 未采集齐 → 停驻（返回当前状态）；
    - 当前节点 need_confirm 且本轮无 task_confirm → 停驻（返回当前状态）；
    - 候选节点为最后一个（FINISHED 之后）→ 终态停驻。
    """
    nodes = _flow_nodes(flow)
    cur = current or MIGRATE_STATUS_DATA_COLLECTION
    idx = next((i for i, n in enumerate(nodes) if n["status"] == cur), None)
    if idx is None or idx >= len(nodes) - 1:
        # 不在流程中（如 ERROR）或已到终态 → 保持
        return cur
    node = nodes[idx]
    for f in node.get("required_fields") or []:
        if not _truthy(collected.get(f)):
            return cur
    if node.get("need_confirm") and not _truthy(collected.get("task_confirm")):
        return cur
    return nodes[idx + 1]["status"]


def _truthy(v: Any) -> bool:
    if v is None:
        return False
    s = str(v).strip()
    if not s or s.lower() in ("none", "null", "未指定", "未选择"):
        return False
    return True


# 各状态对指挥官的动作指引（注入 system 上下文，LLM 据此推进，但无权改流转）
STATE_GUIDANCE: Dict[str, str] = {
    MIGRATE_STATUS_DATA_COLLECTION: (
        "数据采集阶段。当前动作：调用数据采集专家（call_agent → migration_collector，别名小采）"
        "采集源库元数据、表结构、索引约束与对象清单，并确认源/目标库类型、业务等级、容量、停机窗口等参数；"
        "参数与对象清单采集完成后停靠在本阶段，向用户展示并请求显式确认（输入“继续”/点确认），"
        "确认后由后端推进到迁移评估阶段，禁止自行跳过。"),
    MIGRATE_STATUS_ASSESSMENT_RUNNING: (
        "迁移评估阶段。当前动作：调用评估专家（call_agent → migration_assessor，别名小评），"
        "把采集结果与规则命中作为输入，由其做兼容性风险与工作量评估。评估完成后停靠当前阶段，"
        "请求用户显式确认（继续）后再由后端推进迁移方案阶段。"),
    MIGRATE_STATUS_SOLUTION_GENERATE: (
        "迁移方案阶段。当前动作：调用方案专家（call_agent → migration_planner，别名小方）"
        "汇总采集与评估结果，生成国产化迁移落地方案；方案完成后停靠当前阶段，"
        "向用户展示方案概要并请求确认（字段 task_confirm，选项：确认 / 返回修改）。"
        "确认后由后端推进到代码改造阶段，禁止自行跳转。"),
    MIGRATE_STATUS_CODE_MIGRATE: (
        "代码改造阶段。当前动作：调用改造专家（call_agent → code_migrator，别名小改）"
        "做 JDBC/ORM/存储过程应用代码适配；改造完成后停靠当前阶段，"
        "请求用户显式确认（继续）后再由后端推进迁移验证阶段。"),
    MIGRATE_STATUS_VERIFY_STAGE: (
        "迁移验证阶段。当前动作：调用验证专家（call_agent → migration_verifier，别名小测）做校验，"
        "验证完成停靠在当前阶段，请求用户显式确认（继续）后完成整个迁移，即生成结构化资产与完整报告。"),
    MIGRATE_STATUS_FINISHED: (
        "任务已全部完成。当前动作：向用户总结迁移结论，展示资产清单与报告产物（已生成）。"),
    MIGRATE_STATUS_ERROR: (
        "任务曾异常中断，当前支持断点续跑。当前动作：先读取 task_params 告知用户已采集进度，"
        "从上次中断的状态继续推进，不允许从头重新采集。"),
}

# 状态机对应的阶段性检索 kb_type 优先级（方向4：分层 RAG 定向检索）
STAGE_KB_TYPES: Dict[str, List[str]] = {
    MIGRATE_STATUS_DATA_COLLECTION: ["rules", "doc"],
    MIGRATE_STATUS_ASSESSMENT_RUNNING: ["rules", "cases"],
    MIGRATE_STATUS_SOLUTION_GENERATE: ["cases", "doc"],
    MIGRATE_STATUS_CODE_MIGRATE: ["cases", "rules"],
    MIGRATE_STATUS_VERIFY_STAGE: ["doc", "cases"],
}


def status_label(status: str) -> str:
    return {
        MIGRATE_STATUS_DATA_COLLECTION: "数据采集",
        MIGRATE_STATUS_ASSESSMENT_RUNNING: "迁移评估",
        MIGRATE_STATUS_SOLUTION_GENERATE: "迁移方案",
        MIGRATE_STATUS_CODE_MIGRATE: "代码改造",
        MIGRATE_STATUS_VERIFY_STAGE: "迁移验证",
        MIGRATE_STATUS_FINISHED: "已完成",
        MIGRATE_STATUS_ERROR: "异常中断（可续跑）",
        # 旧值兼容（存量任务映射后一般不会出现）
        MIGRATE_STATUS_INIT: "数据采集", MIGRATE_STATUS_DATA_SOURCE_SELECTED: "数据采集",
        MIGRATE_STATUS_BASIC_INFO_COLLECTED: "数据采集", MIGRATE_STATUS_OBJECT_SCANNING: "数据采集",
        MIGRATE_STATUS_SQL_TRANSFORM: "代码改造",
    }.get(status, status)


class MigrateStateService:
    """迁移任务状态机服务：读写 db_migrate_task，驱动确定性流转 + 断点续跑。"""

    def __init__(self, db, observability=None):
        self.db = db
        self.observability = observability

    # ---------- 读取 ----------

    def get(self, task_db_id: int) -> Optional[DbMigrateTask]:
        with self.db.session() as s:
            return s.get(DbMigrateTask, task_db_id)

    # ---------- 任务流程静态表（页面可编排） ----------

    def ensure_default_flow(self) -> None:
        """流程表为空时写入默认流程（首次建库 / 被清空后自动恢复）。"""
        from sqlalchemy import select
        with self.db.session() as s:
            exists = s.scalar(select(DbMigrateFlow.id).limit(1))
            if exists:
                return
            for i, n in enumerate(DEFAULT_FLOW):
                s.add(DbMigrateFlow(
                    sort_order=i, status=n["status"], label=n["label"],
                    description=n.get("description", ""),
                    need_confirm=n.get("need_confirm", True),
                    required_fields=json.dumps(n.get("required_fields") or [],
                                               ensure_ascii=False),
                    enabled=True))
            s.commit()

    def get_flow(self) -> List[Dict[str, Any]]:
        """读取流程静态表（按 sort_order 排序），空表则返回默认流程。"""
        from sqlalchemy import select as _select
        self.ensure_default_flow()
        with self.db.session() as s:
            rows = list(s.scalars(
                _select(DbMigrateFlow).order_by(DbMigrateFlow.sort_order)))
        out = []
        for r in rows:
            try:
                req = json.loads(r.required_fields or "[]")
            except Exception:
                req = []
            out.append({
                "id": r.id, "sort_order": r.sort_order, "status": r.status,
                "label": r.label, "description": r.description,
                "need_confirm": bool(r.need_confirm),
                "required_fields": req, "enabled": bool(r.enabled),
            })
        if not out:
            for i, n in enumerate(DEFAULT_FLOW):
                out.append({**n, "id": None, "sort_order": i, "enabled": True})
        return out

    def save_flow(self, nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """全量保存流程编排：按传入顺序重建节点。
        - status 需唯一且非空；
        - 至少保留一个节点；
        - FINISHED 节点在流转中始终停驻（终态），无需确认闸门。
        """
        cleaned: List[Dict[str, Any]] = []
        seen: set = set()
        for n in nodes:
            st = str(n.get("status") or "").strip()
            if not st or st in seen:
                continue
            seen.add(st)
            cleaned.append({
                "status": st,
                "label": str(n.get("label") or st),
                "description": str(n.get("description") or ""),
                "need_confirm": bool(n.get("need_confirm", True)),
                "required_fields": list(n.get("required_fields") or []),
                "enabled": bool(n.get("enabled", True)),
            })
        if not cleaned:
            raise MigrateStateError("流程编排不能为空")
        with self.db.session() as s:
            for r in s.scalars(_select_all_flow()):
                s.delete(r)
            for i, n in enumerate(cleaned):
                s.add(DbMigrateFlow(
                    sort_order=i, status=n["status"], label=n["label"],
                    description=n["description"],
                    need_confirm=n["need_confirm"],
                    required_fields=json.dumps(n["required_fields"],
                                               ensure_ascii=False),
                    enabled=n["enabled"]))
            s.commit()
        return self.get_flow()

    def reset_flow(self) -> List[Dict[str, Any]]:
        """恢复默认流程（清空编排记录）。"""
        with self.db.session() as s:
            for r in s.scalars(_select_all_flow()):
                s.delete(r)
            s.commit()
        return self.get_flow()

    def get_by_conv(self, conv_id: int) -> Optional[DbMigrateTask]:
        from sqlalchemy import select
        with self.db.session() as s:
            return s.scalar(select(DbMigrateTask).where(
                DbMigrateTask.conv_id == conv_id).order_by(DbMigrateTask.id.desc()))

    def get_by_project_task(self, project_task_id: int) -> Optional[DbMigrateTask]:
        from sqlalchemy import select
        with self.db.session() as s:
            return s.scalar(select(DbMigrateTask).where(
                DbMigrateTask.project_task_id == project_task_id
            ).order_by(DbMigrateTask.id.desc()))

    def bind_project_task(self, task_db_id: int, project_task_id: Optional[int]) -> None:
        """为存量迁移任务补显式业务任务归属。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row and row.project_task_id is None:
                row.project_task_id = project_task_id
                s.commit()

    def get_by_source_ds(self, source_ds_id: str,
                         space_id: Optional[int] = None,
                         project_task_id: Optional[int] = None,
                         owner_ref: Optional[int] = None) -> Optional[DbMigrateTask]:
        """按数据源 ID 查找进行中的任务（同一数据源不重复建任务，支持多会话共享推进）。

        多会话共享设计：任务级（非会话级）状态载体。业务任务会话只能接入该业务任务
        自己的迁移状态；普通会话按空间共享，不复用已完成任务。
        """
        from sqlalchemy import select
        with self.db.session() as s:
            conditions = [
                DbMigrateTask.source_ds_id == source_ds_id,
                DbMigrateTask.status != MIGRATE_STATUS_FINISHED,
            ]
            if space_id is not None:
                conditions.append(DbMigrateTask.space_id == space_id)
            if project_task_id is not None:
                conditions.append(DbMigrateTask.project_task_id == project_task_id)
            elif owner_ref is not None:
                conditions.append(DbMigrateTask.conv_id == owner_ref)
            rows = list(s.scalars(select(DbMigrateTask).where(*conditions)
                                  .order_by(DbMigrateTask.id.desc())))
        return rows[0] if rows else None

    def get_recent_active(self, space_id: Optional[int] = None,
                          project_task_id: Optional[int] = None,
                          owner_ref: Optional[int] = None) -> Optional[DbMigrateTask]:
        """最近活跃的进行中任务（多会话共享兜底：新会话说「继续推进」但未指明数据源时，
        接入最近活跃的任务；FINISHED 不计入。业务任务仅在其自身范围内查找。"""
        from sqlalchemy import select
        with self.db.session() as s:
            conditions = [DbMigrateTask.status != MIGRATE_STATUS_FINISHED]
            if space_id is not None:
                conditions.append(DbMigrateTask.space_id == space_id)
            if project_task_id is not None:
                conditions.append(DbMigrateTask.project_task_id == project_task_id)
            elif owner_ref is not None:
                conditions.append(DbMigrateTask.conv_id == owner_ref)
            rows = list(s.scalars(select(DbMigrateTask).where(*conditions)
                                  .order_by(DbMigrateTask.updated_at.desc()).limit(1)))
        return rows[0] if rows else None

    def to_dict(self, t: DbMigrateTask) -> Dict[str, Any]:
        return {
            "task_id": t.id, "space_id": t.space_id, "sub_system_id": t.sub_system_id,
            "project_task_id": getattr(t, "project_task_id", None),
            "task_name": t.task_name, "status": t.status,
            "status_label": status_label(t.status),
            "source_ds_id": t.source_ds_id, "source_ds_name": t.source_ds_name,
            "source_db_type": t.source_db_type, "target_db_type": t.target_db_type,
            "db_business_level": t.db_business_level, "db_capacity": t.db_capacity,
            "stop_window": t.stop_window, "object_count": t.object_count,
            "step_confirm": bool(getattr(t, "step_confirm", True)),
            "strict_flow": bool(getattr(t, "strict_flow", True)),
            "error_msg": t.error_msg, "conv_id": t.conv_id,
            "task_type": getattr(t, "task_type", "") or "database_migration",
            "trace_id": getattr(t, "trace_id", "") or "",
            "plugin_version": getattr(t, "plugin_version", "") or "",
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
            # 执行锁信息（多会话互斥展示）
            "exec_lock": self.lock_info(t),
        }

    # ---------- 执行锁（多会话互斥：一个任务同一时间只允许一个活跃执行流） ----------

    def lock_info(self, t: Optional[DbMigrateTask] = None,
                  task_db_id: Optional[int] = None) -> Dict[str, Any]:
        """查询任务执行锁状态：{locked, session_id, owner_user_id, expire_time, expired}"""
        if t is None and task_db_id is not None:
            t = self.get(task_db_id)
        if t is None:
            return {"locked": False, "session_id": "", "owner_user_id": "",
                    "expire_time": None, "expired": False,
                    "readonly": True, "reason": "任务不存在"}
        sid = (t.exec_lock_session_id or "").strip()
        exp = t.lock_expire_time
        now = datetime.now(timezone.utc)
        expired = False
        if sid and exp is not None:
            e = exp
            if e.tzinfo is None:
                e = e.replace(tzinfo=timezone.utc)
            expired = now > e
        locked = bool(sid) and not expired
        readonly = t.status in _LOCK_READONLY_STATES
        return {
            "locked": locked,
            "session_id": sid if locked else "",
            "owner_user_id": t.lock_owner_user_id or "" if locked else "",
            "expire_time": exp.isoformat() if (exp and locked) else None,
            "expired": bool(sid) and expired,
            "readonly": readonly,
            "reason": "任务已完成，全局只读" if readonly else "",
        }

    def try_acquire_lock(self, task_db_id: int, session_id: str,
                         owner_user_id: str = "", ttl_seconds: int = EXEC_LOCK_TTL_SECONDS,
                         force: bool = False, allow_readonly: bool = False) -> Dict[str, Any]:
        """尝试获取执行锁（状态变更动作前调用）。

        - FINISHED：拒绝（全局只读，不能修改/重新执行）；
        - ERROR：锁已自动释放，任何会话可抢占（断点续跑）；
        - 锁空闲/超时 → 获取成功；
        - 锁被同一会话持有 → 续期成功；
        - 锁被其他会话持有未过期 → 拒绝（返回 holder 提示只读）。
        返回 {ok, lock, message}
        """
        from datetime import datetime as _dt
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            info = self.lock_info(row)
            if info["readonly"] and not allow_readonly:
                return {"ok": False, "lock": info, "message": "任务已完成，所有会话只读，不能再次执行"}
            sid = str(session_id or "").strip()
            if not sid:
                return {"ok": False, "lock": info, "message": "缺少执行会话标识（session_id）"}
            # ERROR 状态：锁自动释放，允许任何会话接管（断点续跑）
            if row.status == MIGRATE_STATUS_ERROR:
                row.exec_lock_session_id = ""
                row.lock_owner_user_id = ""
                row.lock_expire_time = None
            # 已持有（非 ERROR 抢占）：续期
            cur_sid = (row.exec_lock_session_id or "").strip()
            if cur_sid and cur_sid == sid and not info["expired"]:
                row.lock_expire_time = _dt.now(timezone.utc) + timedelta(seconds=ttl_seconds)
                s.commit(); s.refresh(row)
                return {"ok": True, "lock": self.lock_info(row), "message": "锁续期成功"}
            # 空闲 / 超时 / ERROR / 强制抢占 → 获取
            if not cur_sid or info["expired"] or row.status == MIGRATE_STATUS_ERROR or force:
                row.exec_lock_session_id = sid
                row.lock_owner_user_id = owner_user_id or f"会话{sid}"
                row.lock_expire_time = _dt.now(timezone.utc) + timedelta(seconds=ttl_seconds)
                s.commit(); s.refresh(row)
                return {"ok": True, "lock": self.lock_info(row), "message": "执行锁获取成功"}
            # 被其他会话持有
            return {"ok": False, "lock": info,
                    "message": f"任务正在执行中（操作人：{info.get('owner_user_id') or '其他会话'}），当前为只读模式，不可发起新的执行动作"}

    def release_lock(self, task_db_id: int, session_id: str = "") -> None:
        """释放执行锁：传入 session_id 时仅锁持有者释放；空串时无条件释放。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                return
            if session_id and (row.exec_lock_session_id or "") != str(session_id).strip():
                return  # 非持有者不可释放
            row.exec_lock_session_id = ""
            row.lock_owner_user_id = ""
            row.lock_expire_time = None
            s.commit()

    def _auto_release_expired(self):
        """超时自动释放所有过期执行锁（页面关闭死锁兜底）。"""
        from sqlalchemy import select
        now = datetime.now(timezone.utc)
        with self.db.session() as s:
            rows = list(s.scalars(select(DbMigrateTask).where(
                DbMigrateTask.exec_lock_session_id != "")))
            for row in rows:
                exp = row.lock_expire_time
                if exp is None:
                    continue
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if now > exp:
                    row.exec_lock_session_id = ""
                    row.lock_owner_user_id = ""
                    row.lock_expire_time = None
            s.commit()

    def list(self, space_id: Optional[int] = None, status: Optional[str] = None,
             limit: int = 100) -> List[Dict[str, Any]]:
        from sqlalchemy import select
        q = select(DbMigrateTask).order_by(DbMigrateTask.id.desc()).limit(min(limit, 500))
        if space_id is not None:
            q = q.where(DbMigrateTask.space_id == space_id)
        if status:
            q = q.where(DbMigrateTask.status == status)
        with self.db.session() as s:
            rows = list(s.scalars(q))
        return [self.to_dict(r) for r in rows]

    # ---------- 创建 / 更新 ----------

    def create(self, conv_id: Optional[int], space_id: Optional[int],
               sub_system_id: Optional[int] = None,
               project_task_id: Optional[int] = None,
               source_ds_id: str = "", source_ds_name: str = "",
                 task_name: str = "数据库迁移评估") -> DbMigrateTask:
        trace_id = (self.observability.new_trace_id()
                    if self.observability else uuid.uuid4().hex)
        with self.db.session() as s:
            row = DbMigrateTask(conv_id=conv_id, space_id=space_id,
                                sub_system_id=sub_system_id,
                                project_task_id=project_task_id,
                                source_ds_id=source_ds_id or "",
                                source_ds_name=source_ds_name or "",
                                task_name=task_name or "数据库迁移评估",
                                status=MIGRATE_STATUS_DATA_COLLECTION,
                                trace_id=trace_id)
            s.add(row)
            s.commit()
            s.refresh(row)
            conv_id = row.conv_id
            trace_id = getattr(row, "trace_id", "") or trace_id
        self._safe_event(
            task_id=row.id, conv_id=conv_id, event_type="TASK_STARTED",
            from_status="", to_status=MIGRATE_STATUS_DATA_COLLECTION,
            node_id=MIGRATE_STATUS_DATA_COLLECTION, message="迁移任务已创建",
            trace_id=trace_id,
        )
        return row

    def _safe_event(self, **kwargs) -> None:
        if self.observability is None:
            return
        try:
            self.observability.record_state_event(**kwargs)
        except Exception:
            # 观测事件是旁路数据，不能阻塞或回滚业务状态。
            return

    def update_params(self, task_db_id: int, params: Dict[str, Any],
                      status_override: Optional[str] = None) -> Dict[str, Any]:
        """合并已采集参数到 db_migrate_task，并按状态机推导流转。

        返回：{task, advanced: True/False, from, to}——供上层决定是否提示前端。
        """
        from sqlalchemy import select
        from sqlalchemy.orm.attributes import flag_modified
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            merged = {
                "source_ds_id": params.get("source_ds_id") or row.source_ds_id or "",
                "source_ds_name": params.get("source_ds_name") or row.source_ds_name or "",
                "source_db_type": params.get("source_db_type") or row.source_db_type or "",
                "target_db_type": params.get("target_db_type") or row.target_db_type or "",
                "db_business_level": params.get("db_business_level") or row.db_business_level or "",
                "db_capacity": params.get("db_capacity") or row.db_capacity or "",
                "stop_window": params.get("stop_window") or row.stop_window or "",
                "object_count": int(params.get("object_count") or row.object_count or 0),
                "task_confirm": params.get("task_confirm") or "",
            }
            # 数据源防重复 BUG 硬拦截：一旦赋值，后续轮次传入的不同 source_ds_id 一律丢弃
            if row.source_ds_id and params.get("source_ds_id") \
                    and str(params.get("source_ds_id")) != str(row.source_ds_id):
                merged["source_ds_id"] = row.source_ds_id
            # 库类型归一化存储（达梦→dm / 人大金仓→kingbase …），保证报告/面板展示一致
            merged["source_db_type"] = normalize_db_type(str(merged.get("source_db_type") or ""))
            merged["target_db_type"] = normalize_db_type(str(merged.get("target_db_type") or ""))
            # 源/目标库类型冲突硬拦截：国产化迁移目标库必须 ≠ 源库（两种写法：dm / 达梦 均归一化比对）
            warning = ""
            _st_n = normalize_db_type(str(merged.get("source_db_type") or ""))
            _tt_n = normalize_db_type(str(merged.get("target_db_type") or ""))
            if _st_n and _tt_n and _st_n == _tt_n:
                merged["target_db_type"] = ""
                warning = (f"目标数据库类型与源数据库类型相同（{_st_n}），"
                           "后端已拦截，请重新选择不同的目标国产数据库")
            before = row.status
            conv_id = row.conv_id
            trace_id = getattr(row, "trace_id", "") or ""
            # 状态机流转（流程静态表驱动，页面可编排节点/闸门）：
            # - 采集阶段（INIT→选源→基础信息）：参数齐备时可在单次提交内级联走完；
            # - 执行阶段（扫对象/评估/SQL转换/方案/验证）：单次调用最多推进一级，
            #   每阶段等待实际执行（扫描/评估/转换等）完成后由后端继续推进。
            _COLLECTION_STATES = (MIGRATE_STATUS_DATA_COLLECTION,)
            advance = before
            flow_nodes = None  # 默认流程=DEFAULT_FLOW，无需查库
            try:
                flow_nodes = self.get_flow()  # 库表存在编排记录时以库表为准
            except Exception:
                flow_nodes = None
            for _guard in range(4):
                _nxt = next_state(advance, merged, flow_nodes)
                if _nxt == advance:
                    break
                advance = _nxt
                if advance not in _COLLECTION_STATES:
                    break  # 进入执行阶段即单步停靠
            row.status = advance
            row.source_ds_id = merged["source_ds_id"]
            row.source_ds_name = merged["source_ds_name"]
            row.source_db_type = merged["source_db_type"]
            row.target_db_type = merged["target_db_type"]
            row.db_business_level = merged["db_business_level"]
            row.db_capacity = merged["db_capacity"]
            row.stop_window = merged["stop_window"]
            row.object_count = merged["object_count"]
            if status_override:
                row.status = status_override
            s.commit()
            s.refresh(row)
            result = {"task": self.to_dict(row),
                      "advanced": row.status != before,
                      "from": before, "to": row.status,
                      "warning": warning}
        self._safe_event(
            task_id=task_db_id, conv_id=conv_id, event_type="USER_INPUT",
            from_status=before, to_status=before,
            node_id=before, message="用户提交任务参数",
            trace_id=trace_id,
        )
        self._safe_event(
            task_id=task_db_id, conv_id=conv_id, event_type="NODE_SUCCESS",
            from_status=before, to_status=result["to"],
            node_id=before, message="任务状态已更新",
            trace_id=trace_id,
        )
        return result

    def set_step_confirm(self, task_db_id: int, value: bool) -> Dict[str, Any]:
        """切换逐级确认开关（DB 配置化，不写死）：True=每级完成停驻等确认，False=一次性编排跑完。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            row.step_confirm = bool(value)
            s.commit()
            s.refresh(row)
            return self.to_dict(row)

    def set_strict_flow(self, task_db_id: int, value: bool) -> Dict[str, Any]:
        """切换流程强校验：True=严格顺序，False=允许用户指派任意阶段专家。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            row.strict_flow = bool(value)
            s.commit()
            s.refresh(row)
            return self.to_dict(row)

    def bind_conv(self, task_db_id: int, conv_id: Optional[int]) -> None:
        """记录最近活跃会话：一个迁移任务可被多个会话共享推进（1:N）。

        conv_id 仅作「最近活跃」展示用，不构成任务归属排他；任务状态始终任务级存储。
        """
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row:
                row.conv_id = conv_id
                s.commit()

    def set_error(self, task_db_id: int, error_msg: str) -> None:
        """进入 ERROR：自动释放执行锁（任何会话可接管执行断点续跑）。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row:
                before = row.status
                conv_id = row.conv_id
                trace_id = getattr(row, "trace_id", "") or ""
                row.status = MIGRATE_STATUS_ERROR
                row.error_msg = (error_msg or "")[:1000]
                row.exec_lock_session_id = ""
                row.lock_owner_user_id = ""
                row.lock_expire_time = None
                s.commit()
                self._safe_event(
                    task_id=task_db_id, conv_id=conv_id,
                    event_type="NODE_FAILED", from_status=before,
                    to_status=MIGRATE_STATUS_ERROR, node_id=before,
                    message=error_msg or "节点执行失败", trace_id=trace_id,
                )

    def mark_finished(self, task_db_id: int) -> None:
        """标记完成：自动释放执行锁（所有会话只读，只能查看产物）。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row:
                before = row.status
                conv_id = row.conv_id
                trace_id = getattr(row, "trace_id", "") or ""
                row.status = MIGRATE_STATUS_FINISHED
                row.exec_lock_session_id = ""
                row.lock_owner_user_id = ""
                row.lock_expire_time = None
                s.commit()
                self._safe_event(
                    task_id=task_db_id, conv_id=conv_id,
                    event_type="TASK_COMPLETED", from_status=before,
                    to_status=MIGRATE_STATUS_FINISHED, node_id=before,
                    message="迁移任务已完成", trace_id=trace_id,
                )

    def reset(self, task_db_id: int) -> Dict[str, Any]:
        """重置整个任务：状态回到 INIT，清空已采集参数、错误与执行锁（任务主体保留）。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            row.status = MIGRATE_STATUS_DATA_COLLECTION
            row.source_ds_id = ""
            row.source_ds_name = ""
            row.source_db_type = ""
            row.target_db_type = ""
            row.db_business_level = ""
            row.db_capacity = ""
            row.stop_window = ""
            row.object_count = 0
            row.error_msg = ""
            row.exec_lock_session_id = ""
            row.lock_owner_user_id = ""
            row.lock_expire_time = None
            s.commit()
            s.refresh(row)
            return self.to_dict(row)

    def resume(self, task_db_id: int) -> Dict[str, Any]:
        """断点续跑：仅 ERROR 状态可调用。清除错误标记，依据已采集参数
        恢复到可继续推进的阶段——不会从头重跑，已采集参数与产出资产保留。"""
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            if row.status != MIGRATE_STATUS_ERROR:
                raise MigrateStateError("仅异常中断（ERROR）状态支持断点续跑")
            before = row.status
            conv_id = row.conv_id
            trace_id = getattr(row, "trace_id", "") or ""
            row.error_msg = ""
            collected = {
                "source_ds_id": row.source_ds_id or "",
                "source_db_type": row.source_db_type or "",
                "target_db_type": row.target_db_type or "",
                "db_business_level": row.db_business_level or "",
                "db_capacity": row.db_capacity or "",
                "stop_window": row.stop_window or "",
                "object_count": row.object_count or 0,
                "task_confirm": "确认",
            }
            _COLLECTION_STATES = (MIGRATE_STATUS_DATA_COLLECTION,)
            advance = MIGRATE_STATUS_DATA_COLLECTION
            flow_nodes = None
            try:
                flow_nodes = self.get_flow()
            except Exception:
                flow_nodes = None
            for _guard in range(6):
                _nxt = next_state(advance, collected, flow_nodes)
                if _nxt == advance:
                    break
                advance = _nxt
                if advance not in _COLLECTION_STATES:
                    break  # 执行阶段单步停靠（需用户显式确认再逐级推进）
            row.status = advance
            s.commit()
            s.refresh(row)
            result = self.to_dict(row)
        self._safe_event(
            task_id=task_db_id, conv_id=conv_id, event_type="USER_INPUT",
            from_status=before, to_status=before, node_id=before,
            message="用户确认断点续跑", trace_id=trace_id,
        )
        self._safe_event(
            task_id=task_db_id, conv_id=conv_id, event_type="NODE_SUCCESS",
            from_status=before, to_status=result["status"], node_id=before,
            message="任务已恢复执行", trace_id=trace_id,
        )
        return result

    def retry_stage(self, task_db_id: int, stage: str) -> Dict[str, Any]:
        """回退到指定执行节点：保留参数与产物，只重置任务状态和错误信息。

        执行锁由调用方先抢占；这里只做目标节点合法性与状态回退，避免把
        “单节点重试”误实现成清空整个任务。
        """
        stage = str(stage or "").strip()
        nodes = [n for n in self.get_flow() if n.get("enabled", True)]
        target = next((n for n in nodes if n.get("status") == stage), None)
        if target is None or stage == MIGRATE_STATUS_FINISHED:
            raise MigrateStateError("重试阶段无效，仅支持流程中的执行节点")
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row is None:
                raise MigrateStateError(f"迁移任务不存在: {task_db_id}")
            before = row.status
            conv_id = row.conv_id
            trace_id = getattr(row, "trace_id", "") or ""
            row.status = stage
            row.error_msg = ""
            s.commit()
            s.refresh(row)
            result = self.to_dict(row)
        self._safe_event(
            task_id=task_db_id, conv_id=conv_id, event_type="USER_INPUT",
            from_status=before, to_status=stage, node_id=stage,
            message=f"用户重试节点：{target.get('label') or stage}",
            trace_id=trace_id,
        )
        return result

    def delete(self, task_db_id: int) -> None:
        with self.db.session() as s:
            row = s.get(DbMigrateTask, task_db_id)
            if row:
                s.delete(row)
                s.commit()


DB_TYPE_ALIASES: Dict[str, str] = {
    "oracle": "oracle", "甲骨文": "oracle", "ora": "oracle",
    "mysql": "mysql", "maria": "mysql",
    "db2": "db2",
    "sqlserver": "sqlserver", "sql server": "sqlserver", "mssql": "sqlserver",
    "dm": "dm", "达梦": "dm", "达梦数据库": "dm", "dm8": "dm",
    "kingbase": "kingbase", "人大金仓": "kingbase", "金仓": "kingbase", "kingbasees": "kingbase",
    "gaussdb": "gaussdb", "高斯": "gaussdb", "gauss": "gaussdb",
    "openogauss": "opengauss", "opengauss": "opengauss", "open gauss": "opengauss",
    "oceanbase": "oceanbase", "ob": "oceanbase", "obmysql": "oceanbase",
    "postgresql": "postgresql", "postgres": "postgresql", "pgsql": "postgresql",
    "polardb": "polardb", "polar-db": "polardb",
}


def normalize_db_type(text: str) -> str:
    """把用户常见说法归一化为库类型 key（oracle/mysql/dm/kingbase/gaussdb...）。"""
    return DB_TYPE_ALIASES.get((text or "").strip().lower(), (text or "").strip().lower())


def parse_migrate_params(user_input: str) -> Dict[str, Any]:
    """从用户输入中解析迁移参数（确定性，不依赖 LLM）。

    支持两种写法：
    1. 表单键值对：source_ds_id：本地 / target_db_type：达梦 / db_capacity：500GB / task_confirm：确认
    2. 自然语言：选 src_o 作为源数据源 / 目标库用达梦 / 容量 500GB / 业务等级核心 / 确认
    """
    import re as _re
    params: Dict[str, Any] = {}
    text = user_input or ""
    # ---- 1. 表单键值对 ----
    # 支持独立行与「xxx，key：value」内联写法（前面需有分隔符/行首，避免误吞中文）
    _KV_RE = _re.compile(
        r"(?m)(?:^|[,，;；\s])([A-Za-z][A-Za-z0-9_]*)\s*[:：]\s*(.+?)\s*(?=$|[,，;；\n]| \|)"
    )
    _KEY_RE = _re.compile(
        r"(?i)^(source_ds_id|source_ds_name|source_data_id|datasource|source_db_type|source_db"
        r"|target_db_type|target_db|db_business_level|business_level|db_capacity|capacity"
        r"|stop_window|task_confirm|object_count)\w*$")
    for m in _KV_RE.finditer(text):
        key, val = m.group(1).strip(), m.group(2).strip()
        if key and val and _KEY_RE.match(key):
            params[key] = val
    low = text.lower()
    # ---- 2. 自然语言 ----
    def _first(pat: str, default: str = "") -> str:
        m = _re.search(pat, text)
        return m.group(1).strip() if m else default

    # 数据源：源数据源/源库 选/用/为/是 X（X 为库类型关键字时视作类型而非数据源名）
    _src_id = _first(
        r"源数据源\s*(?:(?:选|选择|用|为|是)\s*[：:]?\s*|[：:]\s*)"
        r"([A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff.-]{0,59})")
    if _src_id and normalize_db_type(_src_id) not in (DB_TYPE_ALIASES.values()):
        params.setdefault("source_ds_id", _src_id)
    elif _src_id:  # 形如「源数据源选达梦」实为库类型
        params.setdefault("source_db_type", normalize_db_type(_src_id))
    # 源库类型：源库/源数据库 + 类型关键字
    _src_type = _first(r"源库\s*(?:类型)?\s*(?:选|选择|用|为|是|[:：])?\s*([a-z\u4e00-\u9fff]{2,16})", "")
    if _src_type and normalize_db_type(_src_type) in (DB_TYPE_ALIASES.values()):
        params.setdefault("source_db_type", normalize_db_type(_src_type))
    # 目标库类型：目标库/目标数据库（含 达梦/金仓/高斯/OB 常见写法）
    _tgt_raw = _first(
        r"目标库\s*(?:类型)?\s*(?:也|再)?\s*(?:(?:选|选择|用|为|是)\s*[：:]?\s*|[：:]\s*|[，,]?\s*)"
        r"([A-Za-z0-9_\u4e00-\u9fff]{1,16})", "")
    _tgt_norm = normalize_db_type(_tgt_raw) if _tgt_raw else ""
    if _tgt_raw and _tgt_norm in (DB_TYPE_ALIASES.values() or ("",)):
        params.setdefault("target_db_type", _tgt_norm)
    if "达梦" in text or _re.search(r"\bdm\b", low):
        params.setdefault("target_db_type", "dm")
    if "金仓" in text or "人大金仓" in text:
        params.setdefault("target_db_type", "kingbase")
    if "高斯" in text or "opengauss" in low or "open gauss" in low:
        params.setdefault("target_db_type", "opengauss")
    if "oceanbase" in low or "ob" in _re.split(r"\s+", low):
        if "obmysql" not in low:
            params.setdefault("target_db_type", "oceanbase")
    if "mysql" in low or "oracle" in low or "sqlserver" in low or "db2" in low:
        # 明确标注为源库时才作为源类型，避免「目标库用达梦代替mysql」误判
        if _first(r"源(?:库|数据库)\s*(?:类型)?\s*(?:为|是|用|选)?\s*(mysql|oracle|sqlserver|db2)\b"):
            params.setdefault("source_db_type", normalize_db_type(_first(r"(mysql|oracle|sqlserver|db2)", "")))
    # 业务等级 / 容量 / 停机窗口
    _lvl = _first(r"业务等级\s*(?:为|是|[:：])?\s*(核心|一般业务|一般)")
    if _lvl:
        params["db_business_level"] = "核心" if _lvl == "核心" else "一般业务"
    _cap = _first(r"(?:库容量|容量|数据量)\s*(?:为|是|约|[:：])?\s*([0-9][0-9.]*\s*[TGMKtgmk]?B?)")
    if _cap:
        params["db_capacity"] = _cap
    _win = _first(r"停机窗口\s*(?:为|是|[:：])?\s*([^，。,;；]{2,30})")
    if _win:
        params["stop_window"] = _win
    # 确认词（采集阶段确认 / 执行阶段每级“继续”推进共享同一闸门）
    if any(w in text for w in ("确认", "确认开始", "同意", "开始迁移", "开始执行", "就这么办",
                               "继续", "继续推进", "下一步", "下一阶段", "好的继续", "继续评估")) \
            and "task_confirm" not in params:
        params["task_confirm"] = "确认"
    if any(w in text for w in ("返回修改", "重新选择", "再选", "取消确认")) \
            and "task_confirm" not in params:
        params["task_confirm"] = "返回修改"
    return params
