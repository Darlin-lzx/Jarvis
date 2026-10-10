"""SQLite/MySQL 数据模型与连接（SQLAlchemy 2.0，经连接串可切换国产库）"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import (Boolean, Column, DateTime, ForeignKey, Integer, String,
                        Text, create_engine, inspect)
import json

from sqlalchemy.orm import declarative_base, sessionmaker

Base = declarative_base()


def utcnow() -> datetime:
    # 落表时间使用本地时区（无时区 naive）：
    # 业务库为本地部署、面向本地用户，created_at/updated_at 落表即本地时间，
    # 前端 new Date(iso) 按本地解析正好对齐，避免「存 UTC 慢 8 小时」。
    return datetime.now()


class Conversation(Base):
    __tablename__ = "conversations"
    id: Any = Column(Integer, primary_key=True)
    title: Any = Column(String(200), default="新会话")
    agent_id: Any = Column(String(64), default="", comment="会话关联 Agent")
    space_id: Any = Column(Integer, nullable=True, comment="归属空间，NULL=未归属")
    sub_system_id: Any = Column(Integer, nullable=True, comment="可选归属子系统")
    task_id: Any = Column(Integer, nullable=True, index=True,
                          comment="绑定任务，NULL=未绑定")
    task_state: Any = Column(Text, default="", comment="会话级任务状态（JSON：current_step/task_params）")
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class Message(Base):
    __tablename__ = "messages"
    id: Any = Column(Integer, primary_key=True)
    conv_id: Any = Column(Integer, ForeignKey("conversations.id"), index=True)
    role: Any = Column(String(20))  # user / assistant / tool
    content: Any = Column(Text)
    agent_id: Any = Column(String(64), default="")
    ui_render: Any = Column(Text, comment="结构化 UI 指令 JSON（交互表单）")
    created_at: Any = Column(DateTime, default=utcnow)


class Prompt(Base):
    __tablename__ = "prompts"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(100), unique=True)
    category: Any = Column(String(20), default="agent")  # system / router / agent
    content: Any = Column(Text)
    type: Any = Column(String(20), default="task_instruction",
                       comment="system_role系统角色/task_instruction任务指令/domain领域专用")
    enabled: Any = Column(Boolean, default=True)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class Skill(Base):
    __tablename__ = "skills"
    id: Any = Column(Integer, primary_key=True)
    skill_id: Any = Column(String(64), unique=True)
    name: Any = Column(String(100))
    description: Any = Column(String(300), default="")
    content: Any = Column(Text, default="")
    enabled: Any = Column(Boolean, default=False)
    created_at: Any = Column(DateTime, default=utcnow)


class ModelDef(Base):
    """模型管理：LLM / Embedding 模型配置（对应前端「模型管理」菜单）"""
    __tablename__ = "models"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(100), comment="模型名称（展示名，如 通义千问4）")
    model_id: Any = Column(String(64), unique=True, comment="模型标识（唯一，如 qwen4）")
    type: Any = Column(String(10), default="LLM", comment="LLM / Embedding")
    provider: Any = Column(String(20), default="API接口", comment="API接口 / 本地部署 / MCP模型")
    status: Any = Column(String(10), default="已启用", comment="已启用 / 已停用")
    api_url: Any = Column(String(500), default="", comment="API 地址")
    api_key: Any = Column(String(200), default="", comment="API 密钥")
    version: Any = Column(String(100), default="", comment="模型版本")
    timeout: Any = Column(Integer, default=60, comment="超时时间（秒）")
    max_tokens: Any = Column(Integer, default=4096, comment="最大上下文 Token")
    description: Any = Column(Text, default="", comment="描述")
    total_calls: Any = Column(Integer, default=0, comment="累计调用次数")
    fail_count: Any = Column(Integer, default=0, comment="失败次数")
    used_by_agents: Any = Column(Text, default="[]", comment="被引用智能体名称（JSON 数组）")
    created_at: Any = Column(DateTime, default=utcnow)


class AgentDef(Base):
    __tablename__ = "agents"
    id: Any = Column(Integer, primary_key=True)
    agent_id: Any = Column(String(64), unique=True)
    name: Any = Column(String(100))
    alias: Any = Column(String(100), default="", comment="别名/昵称（展示用，数据库配置化，不写死在代码）")
    product_type: Any = Column(String(30), default="其他", comment="产物类型（按此把 Agent 生成的产物归类，如 评估/转换/改造/方案/验证/任务/运维/治理/知识）")
    stage: Any = Column(String(40), default="", comment="迁移阶段（按此把产物归入状态机阶段分组：选择数据源/基础信息采集/对象扫描/兼容性评估/SQL转换/方案生成/验证/完成；空=不参与阶段分组归入其他）")
    description: Any = Column(String(300), default="")
    agent_type: Any = Column(String(20), default="子Agent")  # 主Agent / 子Agent
    bound_kbs: Any = Column(Text, default="[]")  # 已废弃：知识库按 Space 绑定，仅保留兼容
    tools: Any = Column(Text, default="[]")  # JSON 数组文本，如 ["RAG知识库检索","结果汇总"]
    prompt_id: Any = Column(Integer, nullable=True)
    system_role_prompt_id: Any = Column(Integer, nullable=True,
                                        comment="绑定系统角色提示词 id（仅允许 type=system_role 的启用提示词）")
    intent: Any = Column(String(64), default="")
    default_prompt: Any = Column(Text, default="")
    output_files: Any = Column(Text, default="")  # JSON 数组文本，如 ["a.md","result.json"]
    sub_agents: Any = Column(Text, default="[]", comment="子 Agent id 列表（主Agent编排用，JSON 数组）")
    gen_artifact: Any = Column(Boolean, default=False)
    enabled: Any = Column(Boolean, default=True)


class DocumentRecord(Base):
    __tablename__ = "kb_documents"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(200))
    source_type: Any = Column(String(10))  # md / sql / txt
    doc_path: Any = Column(String(500))
    chunk_count: Any = Column(Integer, default=0)
    enabled: Any = Column(Boolean, default=True)
    space_id: Any = Column(Integer, nullable=True, comment="归属空间，NULL=空间级/全局文档")
    sub_system_id: Any = Column(Integer, nullable=True, comment="可选归属子系统")
    kb_type: Any = Column(String(20), default="doc", comment="分层知识库类型：rules规则库/cases案例库/doc归档实施文档/运维手册；分层定向检索用")
    business_domain: Any = Column(String(50), default="db_migrate", index=True,
                                  comment="业务域：db_migrate/sql_audit/code_migrate/db_inspect")
    target_db: Any = Column(String(50), default="", comment="目标库类型，如 dm/kingbase/oceanbase")
    stage: Any = Column(String(50), default="", comment="阶段，如 collect/assess/transform/sync/verify")
    object_type: Any = Column(String(50), default="", comment="对象类型，如 table/function/procedure/datatype")
    confidence: Any = Column(String(20), default="verified",
                             comment="可信度：verified/pending_review/model_generated/human_authority")
    source: Any = Column(String(20), default="upload", comment="来源：upload/human/model/artifact")
    source_ref: Any = Column(String(200), default="", comment="来源溯源标识")
    effective_time: Any = Column(DateTime, nullable=True, comment="知识时效时间")
    negative_feedback_count: Any = Column(Integer, default=0, comment="负反馈次数")
    review_required: Any = Column(Boolean, default=False, comment="是否待人工复核")
    created_at: Any = Column(DateTime, default=utcnow)


class ArtifactRecord(Base):
    __tablename__ = "artifacts"
    id: Any = Column(Integer, primary_key=True)
    namespace: Any = Column(String(500), index=True)
    conv_id: Any = Column(Integer, index=True)
    agent_id: Any = Column(String(64), default="")
    object_name: Any = Column(String(200), default="")
    file_type: Any = Column(String(10))  # sql / md / json / txt
    path: Any = Column(String(500))
    space_id: Any = Column(Integer, nullable=True)
    sub_system_id: Any = Column(Integer, nullable=True)
    task_id: Any = Column(Integer, nullable=True, index=True)
    kb_doc_id: Any = Column(Integer, nullable=True, comment="已入库知识库文档 ID，NULL=未入库")
    version: Any = Column(Integer, default=1, comment="同任务同对象产物版本号")
    parent_version: Any = Column(Integer, nullable=True, comment="父版本号")
    trace_id: Any = Column(String(64), default="", index=True, comment="全局链路追踪 ID")
    created_at: Any = Column(DateTime, default=utcnow)


class MCPRecord(Base):
    __tablename__ = "mcp_servers"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(100))
    kind: Any = Column(String(10))  # stdio / http
    command_or_url: Any = Column(String(500))
    args: Any = Column(Text, default="")  # JSON 文本
    enabled: Any = Column(Boolean, default=True)


class ChatTrace(Base):
    """对话步骤级追踪：记录 parse/route/execute/skill/artifact 各节点事件"""
    __tablename__ = "chat_trace"
    id: Any = Column(Integer, primary_key=True)
    conv_id: Any = Column(Integer, index=True)
    node: Any = Column(String(20))  # parse / route / execute / skill / artifact / reply / error
    content: Any = Column(Text, default="")
    agent_id: Any = Column(String(64), default="")
    created_at: Any = Column(DateTime, default=utcnow)


class MigrateStateEvent(Base):
    """迁移状态机事件：记录每次状态/节点推进及用户确认行为"""
    __tablename__ = "migrate_state_events"
    id: Any = Column(Integer, primary_key=True)
    task_id: Any = Column(Integer, ForeignKey("db_migrate_task.id"), index=True)
    conv_id: Any = Column(Integer, nullable=True, index=True)
    event_type: Any = Column(String(40), index=True,
                             comment="TASK_STARTED/USER_INPUT/NODE_SUCCESS/NODE_FAILED/TASK_COMPLETED")
    from_status: Any = Column(String(40), default="")
    to_status: Any = Column(String(40), default="")
    node_id: Any = Column(String(64), default="", index=True)
    message: Any = Column(String(1000), default="")
    trace_id: Any = Column(String(64), default="", index=True)
    created_at: Any = Column(DateTime, default=utcnow)


class TraceLog(Base):
    """全局执行链路日志：LLM/DB/Agent/产物/状态等阶段统一追踪"""
    __tablename__ = "trace_logs"
    id: Any = Column(Integer, primary_key=True)
    trace_id: Any = Column(String(64), index=True)
    conv_id: Any = Column(Integer, nullable=True, index=True)
    task_id: Any = Column(Integer, nullable=True, index=True)
    phase: Any = Column(String(32), default="", index=True)
    span: Any = Column(String(64), default="")
    level: Any = Column(String(16), default="info")
    message: Any = Column(Text, default="")
    duration_ms: Any = Column(Integer, nullable=True)
    created_at: Any = Column(DateTime, default=utcnow, index=True)


class DataSource(Base):
    """只读数据源配置（源库/目标库连接凭证，用于 schema 探查与只读查询）"""
    __tablename__ = "data_sources"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(100), unique=True)  # 别名，如 src_oracle / tgt_dm
    kind: Any = Column(String(20), default="sqlite")  # sqlite / mysql / postgresql / oracle / dm / kingbase / gaussdb
    location: Any = Column(String(500))  # 文件路径或 host:port/db
    username: Any = Column(String(100), default="")
    password: Any = Column(String(200), default="")  # 凭据（演示环境明文；生产可加密）
    dsn: Any = Column(String(500), default="")  # 可选完整连接串，优先级高于其余字段
    enabled: Any = Column(Boolean, default=True)
    space_id: Any = Column(Integer, nullable=True, comment="归属空间，NULL=全局数据源")
    sub_system_id: Any = Column(Integer, nullable=True, comment="可选归属子系统")
    created_at: Any = Column(DateTime, default=utcnow)


class KGEntity(Base):
    """知识图谱实体（表/对象/概念等）"""
    __tablename__ = "kg_entities"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(200), index=True)  # 实体名
    etype: Any = Column(String(32), default="concept")  # table / column / concept / syntax
    doc_name: Any = Column(String(200), default="")  # 来源文档
    created_at: Any = Column(DateTime, default=utcnow)


class KGRelation(Base):
    """知识图谱三元组关系：subject -relation-> object"""
    __tablename__ = "kg_relations"
    id: Any = Column(Integer, primary_key=True)
    subject: Any = Column(String(200), index=True)
    relation: Any = Column(String(64))
    object: Any = Column(String(200), index=True)
    doc_name: Any = Column(String(200), default="")
    created_at: Any = Column(DateTime, default=utcnow)


class SecurityLog(Base):
    """安全网关审计日志：API 请求事件与 SQL 只读操作审计"""
    __tablename__ = "security_logs"
    id: Any = Column(Integer, primary_key=True)
    method: Any = Column(String(10))
    path: Any = Column(String(500))
    ip: Any = Column(String(64), default="")
    status: Any = Column(Integer, default=0)
    duration_ms: Any = Column(Integer, default=0)
    notes: Any = Column(Text, default="")  # SQL / 拦截原因等
    created_at: Any = Column(DateTime, default=utcnow)


class OpsCheck(Base):
    """运维健康巡检记录：每个数据源一条（接通/失败、延迟、错误信息）"""
    __tablename__ = "ops_checks"
    id: Any = Column(Integer, primary_key=True)
    ds_name: Any = Column(String(100), index=True)
    kind: Any = Column(String(20), default="")
    ok: Any = Column(Boolean, default=False)
    latency_ms: Any = Column(Integer, default=0)
    detail: Any = Column(Text, default="")
    created_at: Any = Column(DateTime, default=utcnow)


class SlowQuery(Base):
    """慢 SQL 记录：只读查询耗时超阈值时落库（性能基线与诊断）"""
    __tablename__ = "slow_queries"
    id: Any = Column(Integer, primary_key=True)
    ds_name: Any = Column(String(100), index=True)
    sql: Any = Column(Text, default="")
    latency_ms: Any = Column(Integer, default=0)
    created_at: Any = Column(DateTime, default=utcnow)


class GovAsset(Base):
    """治理资产目录：数据源对象的元数据快照（表/视图 + 列数 + 行数 + 主键）"""
    __tablename__ = "gov_assets"
    id: Any = Column(Integer, primary_key=True)
    ds_name: Any = Column(String(100), index=True)
    object_name: Any = Column(String(200), index=True)
    obj_type: Any = Column(String(10), default="table")  # table / view
    columns: Any = Column(Text, default="[]")  # JSON: [{name,type,nullable,pk}]
    row_count: Any = Column(Integer, default=0)
    pk: Any = Column(String(200), default="")
    created_at: Any = Column(DateTime, default=utcnow)


class Task(Base):
    """任务编排记录：主 Agent 拆解的子任务，支持依赖调度与进度追踪"""
    __tablename__ = "tasks"
    id: Any = Column(Integer, primary_key=True)
    task_id: Any = Column(String(64), unique=True, index=True)  # 前端生成的唯一 ID，如 t001
    conv_id: Any = Column(Integer, ForeignKey("conversations.id"), index=True)
    parent_task_id: Any = Column(String(64), default="")  # 依赖的前置任务 ID，空=无依赖
    agent_type: Any = Column(String(64), default="")  # 子 Agent ID
    task_desc: Any = Column(Text, default="")  # 任务描述
    status: Any = Column(String(20), default="pending")  # pending / running / success / fail
    input_context: Any = Column(Text, default="")  # 给子 Agent 的上下文（JSON）
    output: Any = Column(Text, default="")  # 子 Agent 执行结果
    error_msg: Any = Column(Text, default="")
    sort_order: Any = Column(Integer, default=0)  # 执行顺序
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class GovQuality(Base):
    """治理质量评分：按对象统计完整性/唯一性/空值率与综合分"""
    __tablename__ = "gov_quality"
    id: Any = Column(Integer, primary_key=True)
    ds_name: Any = Column(String(100), index=True)
    object_name: Any = Column(String(200), index=True)
    row_count: Any = Column(Integer, default=0)
    filled_rate: Any = Column(Integer, default=0)   # 0~100 非空率
    unique_rate: Any = Column(Integer, default=0)   # 0~100 主键/首列去重率
    null_rate: Any = Column(Integer, default=0)     # 0~100 空值最多的列比例
    score: Any = Column(Integer, default=0)         # 综合分 0~100
    issues: Any = Column(Text, default="[]")  # JSON 列表：发现的问题
    created_at: Any = Column(DateTime, default=utcnow)


class Space(Base):
    """业务空间：任务与子系统归属的顶级容器"""
    __tablename__ = "spaces"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(100), unique=True, nullable=False, comment="空间名称")
    description: Any = Column(String(500), default="", comment="空间描述")
    kb_ids: Any = Column(Text, default="[]", comment="空间绑定的知识库 id（JSON 数组）")
    members: Any = Column(Text, default="[]", comment="成员权限（JSON，预留，本期不做 RBAC）")
    enabled_agents: Any = Column(Text, default="[]", comment="空间启用/绑定的智能体 id（JSON 数组）")
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class SpaceSubsystem(Base):
    """空间内子系统：如 营业系统 / 开通系统"""
    __tablename__ = "space_subsystems"
    id: Any = Column(Integer, primary_key=True)
    space_id: Any = Column(Integer, ForeignKey("spaces.id"), index=True, comment="所属空间")
    name: Any = Column(String(100), comment="子系统名称（如 营业系统）")
    description: Any = Column(String(500), default="", comment="子系统描述")
    owner: Any = Column(String(100), default="", comment="负责人")
    tags: Any = Column(Text, default="[]", comment="标签（JSON 数组）")
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class ProjectTask(Base):
    """业务任务：强绑定空间（创建后不可修改），可选归属子系统"""
    __tablename__ = "project_tasks"
    id: Any = Column(Integer, primary_key=True)
    space_id: Any = Column(Integer, ForeignKey("spaces.id"), nullable=False, index=True,
                           comment="任务所属空间（创建后不可修改）")
    sub_system_id: Any = Column(Integer, nullable=True, comment="可选归属子系统（空间级任务为 NULL）")
    name: Any = Column(String(200), comment="任务名称")
    description: Any = Column(Text, default="", comment="任务描述")
    status: Any = Column(String(20), default="pending",
                         comment="pending/running/done/failed/paused")
    kb_ids: Any = Column(Text, default="[]", comment="任务关联知识库 id（JSON 数组）")
    agent_id: Any = Column(String(64), default="", comment="任务关联 Agent")
    creator: Any = Column(String(100), default="", comment="创建人")
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class TemplateRecord(Base):
    """模板中心：任务模板 / 会话模板（配置以 JSON 存 config 列）"""
    __tablename__ = "templates"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(200), nullable=False)
    type: Any = Column(String(20), default="task")  # task / conversation
    description: Any = Column(String(500), default="")
    tags: Any = Column(Text, default="[]")  # JSON 数组
    is_public: Any = Column(Boolean, default=False)
    creator: Any = Column(String(100), default="")
    config: Any = Column(Text, default="{}")  # JSON：default_name/skill/datasource_ids/agent_ids/kb_ids/mcp_ids/auto_import/prompt
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class Pipeline(Base):
    """流水线定义：主 Agent 任务确认后注入的强制编排顺序（按 sort_order 排序）。"""
    __tablename__ = "pipeline"
    id: Any = Column(Integer, primary_key=True)
    pipeline_name: Any = Column(String(64), index=True, comment="流水线名（如 migration）")
    agent_id: Any = Column(String(64), index=True, comment="该步骤对应的 Agent id")
    label: Any = Column(String(100), default="")
    desc: Any = Column(String(300), default="")
    sort_order: Any = Column(Integer, default=0)


class SysDict(Base):
    """系统字典（通用键值配置）：领域规则/提示词片段等，替代代码中的写死数据。"""
    __tablename__ = "sys_dict"
    id: Any = Column(Integer, primary_key=True)
    category: Any = Column(String(64), index=True, comment="分类：type_alias/output_rules/...")
    dict_key: Any = Column(String(128), default="", comment="键（如源类型名）")
    dict_value: Any = Column(Text, default="", comment="值（可存长文本/JSON）")
    description: Any = Column(String(300), default="")
    created_at: Any = Column(DateTime, default=utcnow)


class UserProfile(Base):
    """当前登录用户信息（轻量：仅展示用，不做真实鉴权）。业务数据存 DB，由 seed 导入。"""
    __tablename__ = "user_profiles"
    id: Any = Column(Integer, primary_key=True)
    name: Any = Column(String(100), default="", comment="用户姓名")
    role: Any = Column(String(64), default="", comment="角色，如 迁移专家")
    title: Any = Column(String(200), default="", comment="职位/副标题")
    email: Any = Column(String(128), default="", comment="邮箱（可选）")
    avatar_color: Any = Column(String(32), default="#5b7cfa", comment="头像底色（hex）")
    enabled: Any = Column(Boolean, default=True)
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


# 迁移任务状态枚举（状态机硬编码流转，不依赖大模型记忆）
MIGRATE_STATUS_DATA_COLLECTION = "DATA_COLLECTION"    # 数据采集（小采：元数据/表结构/对象清单 + 选源/库类型/基础参数）
MIGRATE_STATUS_INIT = "INIT"                        # 兼容旧值：初始化，等待选择数据源（已并入数据采集）
MIGRATE_STATUS_DATA_SOURCE_SELECTED = "DATA_SOURCE_SELECTED"  # 兼容旧值：数据源已选定（并入数据采集）
MIGRATE_STATUS_BASIC_INFO_COLLECTED = "BASIC_INFO_COLLECTED"  # 兼容旧值：基础信息采集完成（并入数据采集）
MIGRATE_STATUS_OBJECT_SCANNING = "OBJECT_SCANNING"  # 兼容旧值：扫描数据库对象（并入数据采集）
MIGRATE_STATUS_ASSESSMENT_RUNNING = "ASSESSMENT_RUNNING"      # 迁移评估（小评：兼容性风险/工作量评估）
MIGRATE_STATUS_SQL_TRANSFORM = "SQL_TRANSFORM"      # 兼容旧值：SQL 转换阶段（已并入代码改造）
MIGRATE_STATUS_SOLUTION_GENERATE = "SOLUTION_GENERATE"        # 迁移方案（小方：国产化迁移落地方案）
MIGRATE_STATUS_CODE_MIGRATE = "CODE_MIGRATE"        # 代码改造（小改：JDBC/ORM/存储过程适配）
MIGRATE_STATUS_VERIFY_STAGE = "VERIFY_STAGE"        # 迁移验证（小测：语法与结构一致性校验）
MIGRATE_STATUS_FINISHED = "FINISHED"                # 全部完成，报告与资产产物生成
MIGRATE_STATUS_ERROR = "ERROR"                      # 异常中断，支持断点续跑

# 对外展示的执行阶段（与 pipeline 一致）
MIGRATE_STATUSES = [
    MIGRATE_STATUS_DATA_COLLECTION, MIGRATE_STATUS_ASSESSMENT_RUNNING,
    MIGRATE_STATUS_SOLUTION_GENERATE, MIGRATE_STATUS_CODE_MIGRATE,
    MIGRATE_STATUS_VERIFY_STAGE, MIGRATE_STATUS_FINISHED, MIGRATE_STATUS_ERROR,
]

# 各阶段对应的「待采集字段」（状态机依据字段是否收集决定是否可推进）
MIGRATE_STAGE_FIELDS = {
    MIGRATE_STATUS_DATA_COLLECTION: ["source_ds_id", "source_db_type", "target_db_type",
                                     "db_business_level", "db_capacity", "stop_window"],
    MIGRATE_STATUS_ASSESSMENT_RUNNING: [],
    MIGRATE_STATUS_SOLUTION_GENERATE: [],
    MIGRATE_STATUS_CODE_MIGRATE: [],
    MIGRATE_STATUS_VERIFY_STAGE: [],
    MIGRATE_STATUS_FINISHED: [],
    MIGRATE_STATUS_ERROR: [],
    # 兼容旧值（存量任务映射用）
    MIGRATE_STATUS_INIT: ["source_ds_id"],
    MIGRATE_STATUS_DATA_SOURCE_SELECTED: ["source_db_type", "target_db_type"],
    MIGRATE_STATUS_BASIC_INFO_COLLECTED: ["db_business_level", "db_capacity"],
    MIGRATE_STATUS_OBJECT_SCANNING: [],
    MIGRATE_STATUS_SQL_TRANSFORM: [],
}


class DbMigrateTask(Base):
    """数据库国产化迁移任务主表：状态机状态与已采集参数持久化（断点续跑依据）"""
    __tablename__ = "db_migrate_task"
    id: Any = Column(Integer, primary_key=True)
    space_id: Any = Column(Integer, ForeignKey("spaces.id"), nullable=True, comment="所属空间 ID")
    sub_system_id: Any = Column(Integer, nullable=True, comment="所属子系统 ID")
    project_task_id: Any = Column(Integer, nullable=True, index=True,
                                  comment="所属业务任务 ID（状态机归属，避免与会话 ID 混淆）")
    task_name: Any = Column(String(200), default="数据库迁移评估", comment="任务名称")
    status: Any = Column(String(40), default=MIGRATE_STATUS_INIT, index=True, comment="状态机状态")
    source_ds_id: Any = Column(String(100), default="", comment="已选数据源 ID（一旦赋值，不再询问用户）")
    source_ds_name: Any = Column(String(200), default="", comment="已选数据源名称（UI 展示）")
    source_db_type: Any = Column(String(20), default="", comment="源数据库类型 oracle/mysql/db2/sqlserver...")
    target_db_type: Any = Column(String(20), default="", comment="目标国产数据库 dm/kingbase/gaussdb...")
    db_business_level: Any = Column(String(20), default="", comment="业务等级：核心 / 一般业务")
    db_capacity: Any = Column(String(64), default="", comment="库容量（如 500GB）")
    stop_window: Any = Column(String(64), default="", comment="允许停机窗口")
    object_count: Any = Column(Integer, default=0, comment="已扫描对象数（表/视图/存储过程/函数等）")
    error_msg: Any = Column(Text, default="", comment="ERROR 状态时的异常信息")
    # ---- 执行锁（多会话互斥：一个任务同一时间只允许一个活跃执行流） ----
    exec_lock_session_id: Any = Column(String(100), default="", index=True,
                                       comment="持有执行锁的会话 ID（空=无锁，可操作）")
    lock_owner_user_id: Any = Column(String(100), default="", comment="锁持有者用户 ID（展示用）")
    lock_expire_time: Any = Column(DateTime, nullable=True, comment="锁超时时间（超时自动释放，防页面关闭死锁）")
    conv_id: Any = Column(Integer, nullable=True, index=True, comment="绑定会话 ID（对话驱动）")
    task_type: Any = Column(String(40), default="database_migration", index=True,
                            comment="任务类型（预留平台化扩展）")
    trace_id: Any = Column(String(64), default="", index=True, comment="全局链路追踪 ID")
    plugin_version: Any = Column(String(40), default="", comment="编排/插件版本")
    step_confirm: Any = Column(Boolean, default=True, comment="逐级确认：True=每个执行阶段完成后停驻等待用户确认，False=一次性编排跑完")
    strict_flow: Any = Column(Boolean, default=True, comment="流程强校验：True=严格按状态机顺序，False=允许按用户指派自由选择阶段")
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class DbMigrateAsset(Base):
    """结构化迁移资产：风险项/转换 SQL/改造建议（区别于纯文本产物，机器可读、可溯源、可导出）"""
    __tablename__ = "db_migrate_asset"
    id: Any = Column(Integer, primary_key=True)
    task_id: Any = Column(Integer, ForeignKey("db_migrate_task.id"), index=True,
                          comment="关联迁移任务 ID")
    asset_type: Any = Column(String(20), default="table", comment="对象类型 table/view/procedure/function/trigger/index")
    asset_name: Any = Column(String(200), default="", comment="对象名称")
    risk_level: Any = Column(String(10), default="低", comment="风险等级 高/中/低（规则引擎+Agent 共同输出）")
    incompatible_detail: Any = Column(Text, default="[]", comment="不兼容点（结构化 JSON：规则ID/描述/命中片段）")
    rule_ids: Any = Column(Text, default="[]", comment="命中的规则 ID 列表（JSON，溯源用）")
    original_sql: Any = Column(Text, default="", comment="原始 SQL/DDL")
    converted_sql: Any = Column(Text, default="", comment="转换后的国产库 SQL/DDL")
    suggestion: Any = Column(Text, default="", comment="改造建议")
    source: Any = Column(String(32), default="rule_engine", comment="来源标识：rule_engine规则引擎 / assessor评估专家 / transformer转换专家")
    status: Any = Column(String(20), default="待改造", comment="状态：待改造/已改造/已验证")
    owner: Any = Column(String(100), default="", comment="负责人（预设人工实施人）")
    conv_id: Any = Column(Integer, nullable=True, index=True)
    created_at: Any = Column(DateTime, default=utcnow)
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class DbMigrateFlow(Base):
    """任务流程静态表：迁移状态机的可编排流程定义。

    页面可编排（增删节点/调整顺序/开关确认闸门），后端状态机按此表驱动流转：
    - sort_order：节点顺序（从小到大）
    - status：状态机节点状态（与 DbMigrateTask.status 对应）
    - label / description：节点名称与说明（前端展示）
    - need_confirm：推进到下一节点前是否需要用户显式确认（闸门）
    - required_fields：采集到这些字段后才允许离开本节点（JSON 数组）
    - enabled：是否参与流转（关闭=跳过该节点）
    """
    __tablename__ = "db_migrate_flow"
    id: Any = Column(Integer, primary_key=True)
    sort_order: Any = Column(Integer, default=0, index=True, comment="节点顺序")
    status: Any = Column(String(40), unique=True, index=True, comment="状态机状态")
    label: Any = Column(String(100), default="", comment="节点名称")
    description: Any = Column(String(300), default="", comment="节点说明")
    need_confirm: Any = Column(Boolean, default=True, comment="进入下一节点前是否需要用户确认")
    required_fields: Any = Column(Text, default="[]", comment="离开本节点前必须采集的字段（JSON 数组）")
    enabled: Any = Column(Boolean, default=True, comment="是否参与流转（关闭=跳过）")
    updated_at: Any = Column(DateTime, default=utcnow, onupdate=utcnow)


class Database:
    """SQLite/MySQL 连接与建表服务"""

    def __init__(self, db_path: str, mysql_url: str = None):
        self.db_path = db_path
        self.mysql_url = mysql_url

        if mysql_url:
            # MySQL 连接
            self.engine = create_engine(mysql_url, echo=False, pool_pre_ping=True)
            self.use_mysql = True
        else:
            # SQLite 连接（默认）
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
            self.engine = create_engine(f"sqlite:///{db_path}", echo=False)
            self.use_mysql = False

        Base.metadata.create_all(self.engine)
        # 轻量补列迁移（SQLite 与 MySQL 均执行，兼容在旧版本上建的库）
        self._migrate_agents()
        self._migrate_project()
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)

    def _col_ddl(self, ddl: str) -> str:
        """按方言调整 ADD COLUMN 类型：MySQL 不允许 TEXT/BLOB 列带 DEFAULT。"""
        if self.use_mysql and ddl.strip().upper().startswith("TEXT"):
            return "TEXT"
        return ddl

    def _migrate_agents(self):
        """轻量迁移：agents 表补齐 Agent 配置化新增的列（存量库无这些列）"""
        try:
            existing = {c["name"] for c in inspect(self.engine).get_columns("agents")}
            additions = {"intent": "VARCHAR(64) DEFAULT ''",
                         "default_prompt": "TEXT DEFAULT ''",
                         "output_files": "TEXT DEFAULT ''",
                         "gen_artifact": "BOOLEAN DEFAULT 0",
                         "system_role_prompt_id": "INTEGER",
                         "agent_type": "VARCHAR(20) DEFAULT '子Agent'",
                         "bound_kbs": "TEXT DEFAULT '[]'",
                         "sub_agents": "TEXT DEFAULT '[]'",
                         "tools": "TEXT DEFAULT '[]'",
                         "alias": "VARCHAR(100) DEFAULT ''"}
            with self.engine.begin() as conn:
                for col, ddl in additions.items():
                    if col not in existing:
                        conn.exec_driver_sql(f"ALTER TABLE agents ADD COLUMN {col} {self._col_ddl(ddl)}")
        except Exception:
            pass  # 表不存在等情况忽略

    def _migrate_project(self):
        """轻量迁移：conversations/artifacts 补齐归属相关列（存量库无这些列）"""
        try:
            for table, additions in (
                ("messages", {"ui_render": "TEXT"}),
                ("conversations",
                 {"space_id": "INTEGER", "sub_system_id": "INTEGER",
                  "task_id": "INTEGER", "agent_id": "VARCHAR(64) DEFAULT ''",
                  "task_state": "TEXT DEFAULT ''"}),
                ("artifacts",
                 {"space_id": "INTEGER", "sub_system_id": "INTEGER", "task_id": "INTEGER",
                  "kb_doc_id": "INTEGER", "version": "INTEGER DEFAULT 1",
                  "parent_version": "INTEGER", "trace_id": "VARCHAR(64) DEFAULT ''"}),
                ("spaces",
                 {"enabled_agents": "TEXT DEFAULT '[]'"}),
                ("space_subsystems",
                 {"description": "VARCHAR(500) DEFAULT ''", "owner": "VARCHAR(100) DEFAULT ''",
                  "tags": "TEXT DEFAULT '[]'", "updated_at": "DATETIME"}),
                ("data_sources",
                 {"space_id": "INTEGER", "sub_system_id": "INTEGER"}),
                ("kb_documents",
                 {"space_id": "INTEGER", "sub_system_id": "INTEGER",
                  "kb_type": "VARCHAR(20) DEFAULT 'doc'",
                  "business_domain": "VARCHAR(50) DEFAULT 'db_migrate'",
                  "target_db": "VARCHAR(50) DEFAULT ''",
                  "stage": "VARCHAR(50) DEFAULT ''",
                  "object_type": "VARCHAR(50) DEFAULT ''",
                  "confidence": "VARCHAR(20) DEFAULT 'verified'",
                  "source": "VARCHAR(20) DEFAULT 'upload'",
                  "source_ref": "VARCHAR(200) DEFAULT ''",
                  "effective_time": "DATETIME",
                  "negative_feedback_count": "INTEGER DEFAULT 0",
                  "review_required": "BOOLEAN DEFAULT 0"}),
                ("db_migrate_task",
                 {"exec_lock_session_id": "VARCHAR(100) DEFAULT ''",
                  "project_task_id": "INTEGER",
                  "lock_owner_user_id": "VARCHAR(100) DEFAULT ''",
                  "lock_expire_time": "DATETIME",
                  "step_confirm": "BOOLEAN DEFAULT 1",
                  "strict_flow": "BOOLEAN DEFAULT 1",
                  "task_type": "VARCHAR(40) DEFAULT 'database_migration'",
                  "trace_id": "VARCHAR(64) DEFAULT ''",
                  "plugin_version": "VARCHAR(40) DEFAULT ''"}),
                ("prompts",
                 {"type": "VARCHAR(20) DEFAULT 'task_instruction'"}),
            ):
                existing = {c["name"] for c in inspect(self.engine).get_columns(table)}
                with self.engine.begin() as conn:
                    for col, ddl in additions.items():
                        if col not in existing:
                            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {self._col_ddl(ddl)}")
        except Exception:
            pass  # 表不存在等情况忽略

    def session(self):
        return self.Session()


class TaskService:
    """任务编排服务：创建、查询、更新子任务"""

    def __init__(self, db: Database):
        self.db = db

    def create_tasks(self, conv_id: int, tasks: list) -> list:
        """批量创建子任务，返回 Task 列表"""
        from sqlalchemy import select
        created = []
        with self.db.session() as s:
            for i, t in enumerate(tasks):
                row = Task(
                    task_id=t.get("task_id", f"t{i+1:03d}"),
                    conv_id=conv_id,
                    parent_task_id=t.get("deps", [""])[0] if t.get("deps") else "",
                    agent_type=t.get("agent_type", ""),
                    task_desc=t.get("task_desc", ""),
                    status="pending",
                    input_context=json.dumps(t.get("input_context", {}), ensure_ascii=False)
                    if isinstance(t.get("input_context"), dict) else str(t.get("input_context", "")),
                    sort_order=i,
                )
                s.add(row)
                created.append(row)
            s.commit()
            for row in created:
                s.refresh(row)
        return [{"task_id": r.task_id, "agent_type": r.agent_type, "task_desc": r.task_desc,
                 "parent_task_id": r.parent_task_id, "status": r.status, "sort_order": r.sort_order}
                for r in created]

    def get_tasks(self, conv_id: int) -> list:
        """获取会话的所有任务，按 sort_order 排序"""
        from sqlalchemy import select
        with self.db.session() as s:
            rows = list(s.scalars(
                select(Task).where(Task.conv_id == conv_id).order_by(Task.sort_order)))
        return [{"task_id": r.task_id, "agent_type": r.agent_type, "task_desc": r.task_desc,
                 "parent_task_id": r.parent_task_id, "status": r.status,
                 "output": r.output, "error_msg": r.error_msg,
                 "sort_order": r.sort_order,
                 "created_at": r.created_at.isoformat() if r.created_at else None,
                 "updated_at": r.updated_at.isoformat() if r.updated_at else None}
                for r in rows]

    def update_status(self, task_id: str, status: str, output: str = "", error_msg: str = ""):
        """更新任务状态和结果"""
        from sqlalchemy import select
        with self.db.session() as s:
            row = s.scalar(select(Task).where(Task.task_id == task_id))
            if row:
                row.status = status
                if output:
                    row.output = output
                if error_msg:
                    row.error_msg = error_msg
                s.commit()

    def get_ready_tasks(self, conv_id: int) -> list:
        """获取可以执行的任务（status=pending 且依赖已完成）"""
        from sqlalchemy import select
        with self.db.session() as s:
            rows = list(s.scalars(
                select(Task).where(Task.conv_id == conv_id, Task.status == "pending")
                .order_by(Task.sort_order)))
        # 过滤：parent_task_id 为空或已完成
        done_ids = set()
        all_rows = list(s.scalars(select(Task).where(Task.conv_id == conv_id)))
        # 重新查询已完成的任务
        done_rows = list(s.scalars(
            select(Task).where(Task.conv_id == conv_id, Task.status == "success")))
        done_ids = {r.task_id for r in done_rows}

        ready = []
        for r in rows:
            if not r.parent_task_id or r.parent_task_id in done_ids:
                ready.append(r)
        return ready
