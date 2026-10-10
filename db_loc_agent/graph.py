"""LangGraph 主图：parse → route → execute → artifact → reply"""
from __future__ import annotations

import json
import re
import time
import threading
from io import BytesIO
from typing import Any, Callable, Dict, List, Optional

from langgraph.graph import END, StateGraph
from typing_extensions import TypedDict

from db_loc_agent.agents import AgentService, PipelineService
from db_loc_agent.artifacts import (ArtifactService, NamespaceError,
                                    make_namespace, primary_object_name)
from db_loc_agent.config import AppConfig
from db_loc_agent.db_tools import DbTools
from db_loc_agent.prompts import PromptService
from db_loc_agent.state_machine import (DEFAULT_FLOW, STATE_GUIDANCE,
                                        STAGE_KB_TYPES, status_label)

# 兜底识别「宣布要调用子 Agent 却没真正发起工具调用」的回复文本
# （如「我将调用【评估专家】获取最新的评估进度。」）；排除已完成的「已调用【…】」
_ANNOUNCE_CALL_RE = re.compile(
    r"(?:将|让我|我来|准备|计划|需要|应该|应当)[^。！？\n]{0,10}调用"
    r"|(?<!已)调用[^。！？\n]{0,14}【")

# 交付门控：识别"反问/要参数/无法完成"类回复——这类回复不是实际产物，
# 即便超过 120 字或含 Markdown 列表也不应落盘（否则产物列表被"请提供参数…"污染）。
# 命中任一模式即视为非交付，跳过写产物。
_CHINESE_ARTIFACT_NAMES = {
    "assessment_report.md": "评估报告.md",
    "convert_report.md": "转换报告.md",
    "migration_plan.md": "迁移方案.md",
    "migration_guide.md": "改造指南.md",
    "ops_report.md": "运维巡检报告.md",
    "governance_report.md": "治理报告.md",
    "verify_report.md": "验证报告.md",
    "generate.md": "智能体报告.md",
    "collected_data.md": "数据采集报告.md",
}


class ChatRunCancelled(RuntimeError):
    """用户显式中止当前会话执行。"""


def _core_report_filename(configured_name: str) -> str:
    """核心交付物使用中文名；未知业务文件名保持配置不变。"""
    return _CHINESE_ARTIFACT_NAMES.get(configured_name, configured_name)


def _is_core_delivery(agent_id: str, text: str) -> bool:
    """判断 Agent 回复是否为核心交付物；小采的结构化失败报告也属于交付物。"""
    stripped = (text or "").strip()
    if not stripped:
        return False
    has_md = any(line.lstrip().startswith("#") for line in stripped.splitlines())
    sql_blocks = re.findall(
        r"```sql\s*\n(.*?)\n```", stripped, re.DOTALL | re.IGNORECASE)
    if agent_id == "migration_planner" and _is_substantive_migration_plan(stripped):
        return True
    if agent_id == "code_migrator" and _is_substantive_code_analysis(stripped):
        return True
    if _INTERACTIVE_NON_DELIVERY_RE.search(stripped):
        return False
    if agent_id == "migration_collector" and has_md:
        has_table = any(line.lstrip().startswith("|") for line in stripped.splitlines())
        has_list = any(re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line)
                       for line in stripped.splitlines())
        if has_table or has_list:
            return True
    # 分析型专家（小评评估/小方方案/小测验证）：结构化分段【…】回复即核心交付物，
    # 无 Markdown 标题也可落盘为报告（与采集/改造专家的产出判定对齐）。
    if agent_id in ("migration_assessor", "migration_planner") \
            and len(stripped) > 120:
        if re.search(r"【[^】]{2,16}】", stripped) \
                and not _NON_DELIVERY_RE.search(stripped):
            return True
    return ((has_md or bool(sql_blocks))
            and not _NON_DELIVERY_RE.search(stripped))


_INTERACTIVE_NON_DELIVERY_RE = re.compile(
    r"我需要以下|需要明确|请提供上述|请提供.{0,12}参数|请给出.{0,12}选项|"
    r"关键信息确认|缺失信息清单|请选择以下信息|提供以上信息后|"
    r"需要以下关键.{0,8}信息|请确认以下关键.{0,8}信息|"
    r"待补充|待确认|请通过.{0,12}表单|暂无法|"
    r"能力说明|职责边界|超出.{0,16}职责|本次不予执行|建议切换到|"
    r"我能做什么|我能帮你|可以帮你完成|需要你提供.{0,12}材料|"
    r"前置条件|待你进入.{0,12}阶段|采集服务说明|"
    r"必须补充.{0,12}输入|缺失项|请补充以下.{0,8}字段|无法据此"
)
_NON_DELIVERY_RE = re.compile(
    _INTERACTIVE_NON_DELIVERY_RE.pattern + "|" +
    r"无法.{0,6}评估|无法.{0,6}完成|暂时无法|若.{0,10}条件.{0,6}无法|"
    r"请通过.{0,10}提供|缺少.{0,8}参数|请补充.{0,8}信息|"
    r"暂.{0,4}无法确定|无法准确.{0,6}评估"
)
_MIGRATION_PLAN_TERMS = (
    "实施路径", "迁移策略", "分阶段实施", "割接方案", "割接窗口",
    "回滚预案", "风险控制", "迁移步骤", "目标架构",
)


def _is_substantive_migration_plan(text: str) -> bool:
    """识别完整迁移方案，避免风险描述中的“待确认”误伤交付判定。"""
    stripped = (text or "").strip()
    if len(stripped) < 100:
        return False
    return sum(term in stripped for term in _MIGRATION_PLAN_TERMS) >= 2


_CODE_ANALYSIS_TERMS = (
    "JDBC", "ORM", "MyBatis", "Hibernate", "存储过程", "事务", "分页",
    "数据转换", "连接串",
)


def _is_substantive_code_analysis(text: str) -> bool:
    """识别小改的结构化分析，允许末尾存在追加材料的交互提示。"""
    stripped = (text or "").strip()
    if len(stripped) < 120 or "【分析结果】" not in stripped:
        return False
    if not any(marker in stripped for marker in ("【风险】", "【下一步建议】")):
        return False
    return sum(term in stripped for term in _CODE_ANALYSIS_TERMS) >= 2


def _role_boundary_block(agent_id: str) -> str:
    """为被用户显式指派的专项 Agent 注入不可覆盖的职责边界。"""
    if agent_id == "code_migrator":
        return (
            "\n\n## 职责边界（最高优先级）\n"
            "你当前是代码改造助手（小改），只处理 JDBC/ORM/存储过程调用等应用代码改造任务。\n"
            "1. 不得执行迁移评估、DDL 转换或迁移验证；即使用户或历史会话要求/提到这些任务，"
            "也不能代跑其他智能体职责。\n"
            "2. 当最新需求明确是迁移评估或延续历史评估任务时，先说明小改负责代码改造，"
            "再建议切换到迁移评估专家（小评，migration_assessor）。\n"
            "3. 不要把历史会话中的迁移评估任务当作当前任务；历史主题与当前职责冲突时，以当前指派为准。\n"
            "4. 只有最新需求包含代码改造信息，或明确让小改继续时，才执行代码改造。"
        ) + _code_migrator_input_discipline()
    return ""


def _code_migrator_input_discipline() -> str:
    return (
        "\n\n## 输入纪律（最高优先级）\n"
        "1. 任务只有源库、目标库、对象数量等参数且缺少待改造代码（JDBC/ORM/SQL/存储过程）时，"
        "使用一套清晰标注为“示例数据”的 Oracle 分页 SQL 与目标库等价 SQL 生成演示产物，"
        "并在风险中说明真实改造需替换为业务代码；不得输出能力介绍或材料清单替代交付物。\n"
        "2. 已提供结构化资产时，必须逐项引用资产名和原始SQL，再给改造建议。\n"
        "3. 不得复述【输出文件】要求；文件由产物系统自动生成。"
    )

PARSE_KEYS = {"intent", "agent_id", "object_name", "source_db",
              "target_db", "skill_id", "params", "confidence"}
CORE_KEYS = {"intent", "agent_id", "confidence"}

MIGRATION_AGENT_IDS = (
    "migration_commander", "migration_collector", "migration_assessor",
    "migration_planner", "code_migrator", "migration_verifier",
)
STAGE_AGENT_IDS = MIGRATION_AGENT_IDS[1:]
STAGE_AGENT_BY_STATUS = {
    "DATA_COLLECTION": "migration_collector",
    "ASSESSMENT_RUNNING": "migration_assessor",
    "SOLUTION_GENERATE": "migration_planner",
    "CODE_MIGRATE": "code_migrator",
    "VERIFY_STAGE": "migration_verifier",
}
_M_EXEC_STATES = ("DATA_COLLECTION", "ASSESSMENT_RUNNING", "SOLUTION_GENERATE",
                  "CODE_MIGRATE", "VERIFY_STAGE", "FINISHED")
_LEGACY_STEP_MAP = {
    "step1": "DATA_COLLECTION", "step2": "DATA_COLLECTION",
    "step3": "DATA_COLLECTION", "complete": "DATA_COLLECTION",
    "step2_conflict": "DATA_COLLECTION",
    "INIT": "DATA_COLLECTION", "DATA_SOURCE_SELECTED": "DATA_COLLECTION",
    "BASIC_INFO_COLLECTED": "DATA_COLLECTION", "OBJECT_SCANNING": "DATA_COLLECTION",
    "SQL_TRANSFORM": "CODE_MIGRATE",
}

# 全局交互式表单规则：追加到所有 Agent 的 system 提示词（不受 DB 提示词覆盖影响）。
# 模型据此在回复中嵌入 <UI_RENDER>{...}</UI_RENDER>，后端提取后交由前端渲染为可交互表单。
# 注意：若角色提示词自身已约定 UI_RENDER 格式（如 component/param_key 单组件格式），以角色提示词为准。
UI_FORM_RULE = (
    "\n\n## 交互式表单（必须遵守）\n"
    "当需要用户补充或确认关键信息时，必须先在正文中逐项列出待确认字段；"
    "禁止输出「请确认以上信息 / 请完成以上选择」却没有具体字段。\n"
    "有明确候选选项（如选择数据源、源库类型、目标库类型等）时，"
    "必须输出对应选项字段；无候选选项（如说明、SQL、对象范围）时，必须输出 textarea 字段：\n"
    "<UI_RENDER>\n"
    "{\"title\": \"请选择数据源\", \"fields\": [{\"name\": \"datasource\", \"label\": \"数据源\", "
    "\"type\": \"select\", \"options\": [\"<候选1>\", \"<候选2>\"]}], \"submit\": \"确认选择\"}\n"
    "</UI_RENDER>\n"
    "规则：\n"
    "1. 若角色提示词已约定专属的 UI_RENDER 格式（如 component/options/param_key 单组件格式），"
    "必须按角色提示词的格式输出，本节仅作兜底；\n"
    "2. JSON 必须合法（双引号、无注释、无尾逗号），整个回复中最多一个 UI_RENDER 块；\n"
    "3. 候选 options 可使用系统占位符（如 {{system_data_source_list}} 表示已启用数据源列表，"
    "后端会自动替换为真实名称），或来自上下文中的真实清单，不得编造；\n"
    "4. 无候选清单的自由文本信息（如粘贴 SQL、说明迁移范围）使用 textarea 字段，"
    "不得使用空选项的 select/radio。"
)

# 控制指令块：<UI_RENDER>/<TASK_STATE>（正文中这些块会被后端剥离，仅用于流式提取与状态更新）
_CONTROL_BLOCK_RE = re.compile(r"<(UI_RENDER|TASK_STATE)[^>]*>[\s\S]*?</\1[^>]*>", re.I)
_UI_RENDER_BLOCK_RE = re.compile(r"<UI_RENDER\s*>([\s\S]*?)</UI_RENDER\s*>", re.I)


def _strip_control_blocks(text: str) -> str:
    """从文本中剔除 <UI_RENDER>/<TASK_STATE> 指令块（防御：历史回灌时防止模型照抄该结构）。"""
    return _CONTROL_BLOCK_RE.sub("", text or "")


_BARE_UI_RENDER_RE = re.compile(
    r"(?im)^[ \t]*(?:\*\*)?UI_RENDER(?:\*\*)?[ \t]*:[^\n]*$")
_MARKDOWN_HEADING_RE = re.compile(
    r"(?m)^\s*(?P<prefix>#{1,6}\s+|\*\*|【)(?P<title>[^#\n]+?)(?:】|\*\*)?[ \t]*$")
_ALLOWED_SIMULATION_SQL_PREFIXES = {
    "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP",
    "WITH", "MERGE", "TRUNCATE", "REPLACE", "EXPLAIN", "CALL",
}


_MOCK_COLLECTOR_OBJECTS = [
    ("V_ORDER_SUMMARY", "视图", 6, "order_id、user_name、order_amount、status、create_date、area_name"),
    ("P_CALC_USER_BALANCE", "存储过程", 5, "user_id、begin_date、end_date、balance、return_code"),
    ("F_GET_ORDER_LEVEL", "函数", 3, "order_amount、member_level、return_value"),
    ("TRG_ORDER_ID", "触发器", 4, "trigger_name、table_name、event_type、sequence_name"),
    ("IDX_USER_MOBILE", "索引", 3, "table_name、column_name、index_type"),
    ("SEQ_ORDER_ID", "序列", 3, "sequence_name、start_value、increment_by"),
    ("T_USER_PROFILE", "表", 8, "user_id、user_name、mobile、email、city_id、level_score、created_at、updated_at"),
    ("T_AREA_INFO", "表", 5, "area_id、parent_id、area_name、area_level、sort_no"),
]


_MOCK_CODE_MIGRATION_ITEMS = [
    (
        "分页查询",
        "SELECT order_id, customer_id, order_amount FROM user_order "
        "WHERE status = 'PAID' ORDER BY created_at DESC AND ROWNUM <= 100;",
        "SELECT order_id, customer_id, order_amount FROM user_order "
        "WHERE status = 'PAID' ORDER BY created_at DESC LIMIT 100;",
        "#### 风险提示\n\n- ORDER BY 与 ROWNUM 的原语义需逐条复核，避免迁移后排序边界变化。",
    ),
    (
        "自增主键",
        "CREATE SEQUENCE seq_user_order START WITH 1 INCREMENT BY 1;",
        "CREATE TABLE user_order_auto_id (id BIGINT AUTO_INCREMENT PRIMARY KEY, "
        "order_no VARCHAR(64) NOT NULL);",
        "#### 风险提示\n\n- 序列改为自增主键前，必须确认业务是否依赖跨表取号。",
    ),
    (
        "日期函数",
        "SELECT order_id FROM user_order WHERE created_at > SYSDATE - 7;",
        "SELECT order_id FROM user_order WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY);",
        "#### 风险提示\n\n- 时区与默认时间精度会影响查询结果。",
    ),
    (
        "条件转换",
        "SELECT DECODE(order_status, 'A', '已受理', 'B', '处理中', '未知') FROM user_order;",
        "SELECT CASE order_status WHEN 'A' THEN '已受理' WHEN 'B' THEN '处理中' "
        "ELSE '未知' END FROM user_order;",
        "#### 风险提示\n\n- DECODE 的空值匹配语义与 CASE 不同，需补充空值用例。",
    ),
    (
        "大对象读取",
        "SELECT contract_content FROM user_contract "
        "WHERE DBMS_LOB.GETLENGTH(contract_content) > 1024;",
        "SELECT contract_content FROM user_contract "
        "WHERE CHAR_LENGTH(contract_content) > 1024;",
        "#### 风险提示\n\n- CLOB 与 TEXT 的字符集、截断策略需保持一致。",
    ),
    (
        "存储过程调用",
        "CALL p_update_user_balance(1001, 250.00);",
        "CALL update_user_balance(1001, 250.00);",
        "#### 风险提示\n\n- 参数模式、返回值和事务边界需由应用侧回归测试覆盖。",
    ),
]


def _strip_bare_ui_render(text: str) -> str:
    """剔除模型漏写标签时输出的单行 UI_RENDER 指令。"""
    return _BARE_UI_RENDER_RE.sub("", text or "")


def _strip_interactive_sections(text: str) -> str:
    """删除 UI_RENDER / 数据源选择等交互附录，保留核心报告正文。"""
    lines = (text or "").splitlines()
    output: List[str] = []
    cursor = 0
    while cursor < len(lines):
        line = lines[cursor]
        heading = _MARKDOWN_HEADING_RE.match(line)
        normalized = re.sub(r"[\s_*【】#]+", "", heading.group("title")) if heading else ""
        interactive = heading is not None and any(
            token in normalized.upper() for token in ("UIRENDER", "选择数据源", "数据源选择"))
        if interactive:
            hash_prefix = re.match(r"^\s*(#{1,6})", line)
            level = len(hash_prefix.group(1)) if hash_prefix else 2
            cursor += 1
            while cursor < len(lines):
                next_heading = _MARKDOWN_HEADING_RE.match(lines[cursor])
                if next_heading:
                    next_hash = re.match(r"^\s*(#{1,6})", lines[cursor])
                    next_level = len(next_hash.group(1)) if next_hash else 2
                    if next_level <= level:
                        break
                cursor += 1
            continue
        output.append(line)
        cursor += 1
    return "\n".join(output).strip()


def _sanitize_plan_artifact(text: str) -> str:
    """小方产物只保留迁移方案，交互确认内容由前端表单通道处理。"""
    return _strip_interactive_sections(_strip_bare_ui_render(text or "")).strip()


def _normalized_heading(title: str) -> str:
    return re.sub(r"[\s_*:：-]+", "", title or "")


def _section_heading(line: str) -> tuple[str, int] | tuple[None, int]:
    markdown = _MARKDOWN_HEADING_RE.match(line)
    if markdown:
        hashes = re.match(r"^\s*(#{1,6})", line)
        return _normalized_heading(markdown.group("title")), len(hashes.group(1)) if hashes else 2
    bracket = re.match(r"^\s*【([^】]{1,40})】\s*[:：]?\s*$", line)
    if bracket:
        return _normalized_heading(bracket.group(1)), 2
    numbered = re.match(r"^\s*\d+[.、)]\s*([^:：\n]{1,40}?)\s*[:：]?\s*$", line)
    if numbered:
        return _normalized_heading(numbered.group(1)), 2
    return None, 0


def _strip_named_sections(text: str, names: set[str]) -> str:
    """删除指定标题小节，支持 Markdown、【】和编号小节。"""
    lines = (text or "").splitlines()
    output: List[str] = []
    cursor = 0
    while cursor < len(lines):
        title, level = _section_heading(lines[cursor])
        if title is not None and title in names:
            cursor += 1
            while cursor < len(lines):
                next_title, next_level = _section_heading(lines[cursor])
                if next_title is not None and next_level <= level:
                    break
                cursor += 1
            continue
        output.append(lines[cursor])
        cursor += 1
    return "\n".join(output).strip()


def _sanitize_assessment_artifact(text: str) -> str:
    """评估报告只保留评估内容，输出文件清单由产物系统负责展示。"""
    return _strip_named_sections(
        _strip_bare_ui_render(text or ""), {"输出文件", "输出文件清单"}).strip()


_CODE_ARTIFACT_REQUEST_RE = re.compile(
    r"(?im)^[ \t]*(?:[-*+]\s*|\d+[.)]\s+)?"
    r"(?:请确认|请提供|请补充|继续提供|若需继续).*$")


def _sanitize_code_migration_artifact(text: str) -> str:
    """小改分析报告剔除输出要求与追加材料追问。"""
    cleaned = _strip_named_sections(
        _strip_bare_ui_render(text or ""),
        {"输出文件", "输出文件清单"},
    )
    return _CODE_ARTIFACT_REQUEST_RE.sub("", cleaned).strip()


def _extract_sql_after_heading(text: str, titles: tuple[str, ...]) -> str:
    """按 Markdown / 【】标题提取指定小节中的第一个 SQL 代码块。"""
    wanted = {_normalized_heading(t) for t in titles}
    headings = list(_MARKDOWN_HEADING_RE.finditer(text or ""))
    for idx, heading in enumerate(headings):
        if _normalized_heading(heading.group("title")) not in wanted:
            continue
        section_end = headings[idx + 1].start() if idx + 1 < len(headings) else len(text or "")
        section = text[heading.start():section_end]
        blocks = re.findall(
            r"```(?:sql|mysql|oracle|dm)?\s*\n([\s\S]*?)\n```",
            section, re.IGNORECASE)
        if blocks:
            return blocks[0].strip()
    return ""


def _extract_code_migration_sqls(text: str) -> tuple[str, str]:
    return (
        _extract_sql_after_heading(text, ("改造前 SQL", "改造前的SQL", "原始SQL", "源SQL")),
        _extract_sql_after_heading(text, ("改造后 SQL", "改造后的SQL", "转换后SQL", "目标SQL")),
    )


def _extract_code_migration_items(text: str) -> List[Dict[str, str]]:
    """提取多个改造项；无三级标题时兼容旧的单项前后 SQL 格式。"""
    headings = list(_MARKDOWN_HEADING_RE.finditer(text or ""))
    items: List[Dict[str, str]] = []
    for idx, heading in enumerate(headings):
        level = len(heading.group("prefix").strip())
        if level != 3:
            continue
        section_end = len(text or "")
        for next_heading in headings[idx + 1:]:
            if len(next_heading.group("prefix").strip()) <= level:
                section_end = next_heading.start()
                break
        section = text[heading.start():section_end]
        before_sql, after_sql = _extract_code_migration_sqls(section)
        if not before_sql or not after_sql:
            continue
        title = re.sub(r"^\d+[.、]\s*", "", heading.group("title").strip())
        items.append({
            "type": f"SQL-{title}",
            "before": before_sql,
            "after": after_sql,
            "risk": _extract_risk_section(section).strip(),
        })
    if items:
        return items
    before_sql, after_sql = _extract_code_migration_sqls(text)
    return [{"type": "SQL", "before": before_sql, "after": after_sql, "risk": ""}]


def _extract_risk_section(text: str) -> str:
    headings = list(_MARKDOWN_HEADING_RE.finditer(text or ""))
    for idx, heading in enumerate(headings):
        title = _normalized_heading(heading.group("title"))
        if "风险" not in title:
            continue
        end = headings[idx + 1].start() if idx + 1 < len(headings) else len(text or "")
        section = text[heading.start():end].strip()
        return section
    return ""


def _simulate_target_sql_execution(sql: str) -> tuple[bool, str]:
    statements = [part.strip() for part in (sql or "").split(";") if part.strip()]
    if not statements:
        return False, "改造后 SQL 为空，未进入模拟校验"
    for statement in statements:
        first_word = re.match(r"[A-Za-z]+", statement)
        prefix = first_word.group(0).upper() if first_word else ""
        if prefix not in _ALLOWED_SIMULATION_SQL_PREFIXES:
            return False, f"无法识别 SQL 语句类型：{statement[:40]}"
    return True, "语句结构通过本地模拟校验"


def _target_database_name(state: Dict) -> str:
    parse = state.get("parse_result") or {}
    params = (state.get("task_state") or {}).get("task_params") or {}
    value = (
        params.get("target_db_type")
        or params.get("target_db")
        or parse.get("target_db")
        or "MySQL"
    )
    return str(value).strip() or "MySQL"


def _workbook_bytes(sheet_title: str, headers: List[str], rows: List[List[Any]]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_title
    sheet.append(headers)
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="5B7CFA")
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for row in rows:
        sheet.append(row)
    for row in sheet.iter_rows():
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    for index, width in enumerate([6, 14, 18, 42, 42, 12, 18, 36], 1):
        sheet.column_dimensions[chr(64 + index)].width = width
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _build_code_migration_files(text: str, target_db: str) -> tuple[Dict[str, Any], str]:
    items = _extract_code_migration_items(text)
    prepared = []
    for item in items:
        ok, reason = _simulate_target_sql_execution(item["after"])
        prepared.append({**item, "ok": ok, "reason": reason})
    risk = _extract_risk_section(text) or "## 风险说明\n\n- 未识别到模型给出的风险说明，请在执行前人工复核。"
    overall_ok = bool(prepared) and all(item["ok"] for item in prepared)
    data_source = "示例数据（真实执行前必须替换业务代码）" if "示例数据" in (text or "")[:200] else "模型输出"
    report_parts = [
        "# SQL改造报告\n\n",
        "## 目标库模拟执行结果\n\n",
        f"- 目标库：{target_db}\n",
        f"- 数据来源：{data_source}\n",
        "- 执行模式：SIMULATION\n",
        f"- 结果：{'模拟执行成功' if overall_ok else '模拟执行失败'}\n",
        "- 校验说明：逐条语句执行结构校验；未连接目标库，未执行真实 DDL/DML。\n\n",
    ]
    for idx, item in enumerate(prepared, 1):
        item_risk = item.get("risk") or risk.strip()
        report_parts.extend([
            f"## {idx}. {item['type']}\n\n",
            "### 改造前 SQL\n\n",
            f"```sql\n{item['before']}\n```\n\n",
            "### 改造后 SQL\n\n",
            f"```sql\n{item['after']}\n```\n\n",
            f"- 模拟执行结果：{'成功' if item['ok'] else '失败'}（{item['reason']}）\n\n",
            f"{item_risk}\n\n",
        ])
    report_parts.append(risk.strip() if len(items) <= 1 else "")
    report = "\n".join(report_parts)
    workbook = _workbook_bytes(
        "改造清单",
        ["序号", "对象/代码类型", "改造前SQL", "改造后SQL", "目标库", "模拟执行结果", "风险说明"],
        [[idx, item["type"], item["before"], item["after"], target_db,
          "模拟执行成功" if item["ok"] else "模拟执行失败",
          item.get("risk") or risk]
         for idx, item in enumerate(prepared, 1)],
    )
    after_sql = (
        prepared[0]["after"] if len(prepared) == 1
        else ";\n\n".join(item["after"].rstrip(";") for item in prepared) + ";"
    )
    return {
        "改造后SQL.sql": after_sql,
        "SQL改造报告.md": report,
        "代码改造清单.xlsx": workbook,
    }, report


def _mock_code_migration_reply(state: Dict) -> str:
    params = (state.get("task_state") or {}).get("task_params") or {}
    source_db = str(
        params.get("source_db_type")
        or params.get("source_db")
        or (state.get("parse_result") or {}).get("source_db")
        or "Oracle").strip() or "Oracle"
    target_db = _target_database_name(state)
    parts = [
        "# SQL改造报告（示例数据）\n\n",
        f"## 演示范围\n\n- 源库类型：{source_db}\n- 目标库类型：{target_db}\n\n",
    ]
    for idx, (title, before_sql, after_sql, risk) in enumerate(
            _MOCK_CODE_MIGRATION_ITEMS, 1):
        parts.extend([
            f"### {idx}. {title}\n\n",
            "#### 改造前 SQL\n\n",
            f"```sql\n{before_sql}\n```\n\n",
            "#### 改造后 SQL\n\n",
            f"```sql\n{after_sql}\n```\n\n",
            f"{risk}\n\n",
        ])
    parts.extend([
        "## 风险说明\n\n",
        "- 本报告使用示例数据：真实执行前必须替换为业务待改造 SQL/JDBC/ORM 代码。\n",
        "- 分页语法、序列取号、日期函数、驱动类名、连接串和事务隔离级别需结合目标库版本复核。\n",
        "- 示例仅做结构模拟，不连接目标库执行真实 DDL/DML。\n",
    ])
    return "".join(parts)


def _verify_target_sql(sql: str, target_db: str) -> tuple[bool, str]:
    target = (target_db or "").strip().lower()
    statements = [part.strip() for part in (sql or "").split(";") if part.strip()]
    if not statements:
        return False, "未生成转换 SQL"
    for statement in statements:
        first_word = re.match(r"[A-Za-z]+", statement)
        prefix = first_word.group(0).upper() if first_word else ""
        if prefix not in _ALLOWED_SIMULATION_SQL_PREFIXES:
            return False, f"无法识别 SQL 语句类型：{statement[:40]}"
        if target in ("mysql", "mysqli"):
            mysql_incompatible = [
                ("CREATE OR REPLACE", "MySQL 视图不支持 CREATE OR REPLACE"),
                ("VARCHAR2", "MySQL 不支持 VARCHAR2 类型"),
                ("NUMBER", "MySQL 不支持 NUMBER 类型"),
                ("SYSDATE", "MySQL 不支持 SYSDATE 函数"),
                ("ROWNUM", "MySQL 不支持 ROWNUM 伪列"),
            ]
            for token, reason in mysql_incompatible:
                if token.upper() in statement.upper():
                    return False, reason
    return True, "转换 SQL 通过目标库语法静态校验"


_MOCK_VERIFICATION_ASSETS = [
    {
        "asset_type": "function", "asset_name": "示例_f_order_level", "risk_level": "低",
        "original_sql": "CREATE OR REPLACE FUNCTION f_order_level(p_amount NUMBER) RETURN VARCHAR2;",
        "converted_sql": "CREATE FUNCTION f_order_level(p_amount DECIMAL(12,2)) "
                         "RETURNS VARCHAR(20) DETERMINISTIC RETURN 'NORMAL';",
        "suggestion": "示例数据：函数头、确定性标记与返回类型已按 MySQL 语法改写。",
    },
    {
        "asset_type": "view", "asset_name": "示例_v_failed_view", "risk_level": "高",
        "original_sql": "CREATE OR REPLACE VIEW v_failed_view AS SELECT * FROM t_order;",
        "converted_sql": "CREATE OR REPLACE VIEW v_failed_view AS SELECT * FROM t_order;",
        "suggestion": "示例数据：MySQL 不支持 CREATE OR REPLACE VIEW，需删除重建。",
    },
    {
        "asset_type": "trigger", "asset_name": "示例_trg_order_insert", "risk_level": "中",
        "original_sql": "CREATE OR REPLACE TRIGGER trg_order_insert BEFORE INSERT ON t_order;",
        "converted_sql": "CREATE TRIGGER trg_order_insert BEFORE INSERT ON t_order "
                         "FOR EACH ROW SET NEW.created_at = NOW();",
        "suggestion": "示例数据：触发器语法已调整为 MySQL 形式。",
    },
    {
        "asset_type": "sequence", "asset_name": "示例_seq_failed", "risk_level": "高",
        "original_sql": "CREATE SEQUENCE seq_failed START WITH 1 INCREMENT BY 1;",
        "converted_sql": "",
        "suggestion": "示例数据：MySQL 无原生序列，需改为 AUTO_INCREMENT 或取号表。",
    },
    {
        "asset_type": "procedure", "asset_name": "示例_p_update_balance", "risk_level": "中",
        "original_sql": "CREATE OR REPLACE PROCEDURE p_update_balance(p_uid NUMBER);",
        "converted_sql": "CREATE PROCEDURE update_user_balance(IN p_uid BIGINT, "
                         "IN p_amount DECIMAL(12,2)) BEGIN UPDATE t_account "
                         "SET balance = balance + p_amount WHERE id = p_uid END;",
        "suggestion": "示例数据：过程名、参数模式和语句块语法已按 MySQL 调整。",
    },
    {
        "asset_type": "table", "asset_name": "示例_t_failed_type", "risk_level": "高",
        "original_sql": "CREATE TABLE t_failed_type (id NUMBER, remark VARCHAR2(200));",
        "converted_sql": "CREATE TABLE t_failed_type (id NUMBER, remark VARCHAR(200));",
        "suggestion": "示例数据：NUMBER 需改为 DECIMAL/BIGINT，不能保留 Oracle 类型。",
    },
    {
        "asset_type": "index", "asset_name": "示例_idx_user_mobile", "risk_level": "低",
        "original_sql": "CREATE INDEX idx_user_mobile ON t_user(mobile);",
        "converted_sql": "CREATE INDEX idx_user_mobile ON t_user(mobile);",
        "suggestion": "示例数据：普通索引语法兼容，校验通过。",
    },
    {
        "asset_type": "synonym", "asset_name": "示例_syn_failed", "risk_level": "中",
        "original_sql": "CREATE SYNONYM syn_failed FOR t_user;",
        "converted_sql": "",
        "suggestion": "示例数据：MySQL 不支持同义词，需改造为视图或直接引用原表。",
    },
]


def _with_demo_verification_assets(assets: List[Dict]) -> List[Dict]:
    """演示链路保证校验清单有足够样本；真实资产始终排在前面。"""
    if len(assets) >= 10:
        return assets
    if len(assets) <= 2:
        return [*assets, *_MOCK_VERIFICATION_ASSETS]
    needed = 10 - len(assets)
    return [*assets, *_MOCK_VERIFICATION_ASSETS[:needed]]


def _build_verification_report(assets: List[Dict], target_db: str) -> str:
    rows = []
    for asset in assets:
        converted = str(asset.get("converted_sql") or "").strip()
        ok, reason = _verify_target_sql(converted, target_db)
        rows.append({
            "asset": asset,
            "converted": converted,
            "ok": ok,
            "reason": reason,
        })

    success_rows = [r for r in rows if r["ok"]]
    failed_rows = [r for r in rows if not r["ok"]]
    demo_count = sum(1 for row in rows
                     if str(row["asset"].get("asset_name", "")).startswith("示例_"))

    def render_rows(items: List[Dict], result_label: str) -> str:
        if not items:
            return "（无）"
        blocks = []
        for idx, row in enumerate(items, 1):
            asset = row["asset"]
            sql = row["converted"] or str(asset.get("original_sql") or "-- 暂无 SQL")
            suggestion = asset.get("suggestion") or "请人工复核并补充修复方案。"
            blocks.append(
                f"### {idx}. {asset.get('asset_type', 'object')} `{asset.get('asset_name', '')}`\n\n"
                f"- 校验结果：{result_label}\n"
                f"- 原因分析：{row['reason']}\n"
                f"- 修复建议：{suggestion}\n\n"
                f"```sql\n{sql}\n```")
        return "\n\n".join(blocks)

    demo_line = (
        f"- 示例补充对象：{demo_count} 条（示例数据，不代表真实资产）\n\n"
        if demo_count else ""
    )
    return (
        "# 校验报告\n\n"
        "## 一、校验概览\n\n"
        f"- 目标库：{target_db}\n"
        "- 校验方式：本地静态校验（SIMULATION），未连接目标库执行\n"
        f"- 校验对象总数：{len(rows)}｜成功：{len(success_rows)}｜失败：{len(failed_rows)}\n\n"
        + demo_line
        +
        "## 二、成功 SQL 清单\n\n"
        f"{render_rows(success_rows, '成功')}\n\n"
        "## 三、失败 SQL 清单\n\n"
        f"{render_rows(failed_rows, '失败')}\n"
    )


def _build_verification_workbook(assets: List[Dict], target_db: str) -> bytes:
    rows: List[List[Any]] = []
    for asset in assets:
        converted = str(asset.get("converted_sql") or "").strip()
        ok, reason = _verify_target_sql(converted, target_db)
        rows.append([
            len(rows) + 1,
            asset.get("asset_type", "object"),
            asset.get("asset_name", ""),
            target_db,
            "成功" if ok else "失败",
            reason,
            asset.get("suggestion") or "请人工复核并补充修复方案。",
            converted or str(asset.get("original_sql") or "-- 暂无 SQL"),
        ])
    return _workbook_bytes(
        "测试清单",
        ["序号", "对象类型", "对象名称", "目标库", "校验结果", "原因分析", "修复建议", "转换SQL"],
        rows,
    )


def _extract_ui_render(text: str) -> Optional[Dict]:
    """提取首个合法 UI_RENDER JSON；非法块保持剥离即可，不能进入产物正文。"""
    for body in _UI_RENDER_BLOCK_RE.finditer(text or ""):
        try:
            obj = json.loads(body.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _extract_json_from_markdown(text: str) -> str:
    """从 markdown 代码块中提取 JSON（LLM 常返回 ```json { ... } ``` 格式）。"""
    if not text:
        return text
    # 匹配 ```json ... ``` 或 ``` ... ``` 代码块
    m = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return text


def _strip_leading_parse_json(text: str) -> str:
    """剥离助手历史回复最前面误输出的「解析结果 JSON」（历史脏数据回灌时防止模型照抄结构）。
    支持两种格式：
    1. 直接输出：{"intent":...,"agent_id":...}
    2. Markdown 代码块：```json\n{"intent":...}\n```
    键名可能含杂散空格，归一化后匹配；仅当所有键都属于解析字段集且含核心键时剥离。"""
    t = text.lstrip("\ufeff\u200b\u200c\u200d \t\r\n")
    # 处理 markdown 代码块格式：```json ... ```
    md_match = re.match(r"^```(?:json)?\s*\n([\s\S]*?)\n?```", t, re.IGNORECASE)
    if md_match:
        json_str = md_match.group(1).strip()
        try:
            obj = json.loads(json_str)
            if isinstance(obj, dict):
                keys = {"".join(str(k).split()) for k in obj}
                if keys and keys <= PARSE_KEYS and CORE_KEYS <= keys:
                    # 匹配成功，剥离整个代码块
                    rest = t[md_match.end():].lstrip("\ufeff\u200b\u200c\u200d \t\r\n")
                    return rest
        except json.JSONDecodeError:
            pass
    # 处理直接 JSON 格式
    if not t.startswith("{"):
        return text
    depth = in_str = esc = 0
    end = -1
    for i, ch in enumerate(t):
        if in_str:
            if esc:
                esc = 0
            elif ch == "\\":
                esc = 1
            elif ch == '"':
                in_str = 0
            continue
        if ch == '"':
            in_str = 1
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return text
    try:
        obj = json.loads(t[: end + 1])
    except json.JSONDecodeError:
        return text
    if not isinstance(obj, dict):
        return text
    keys = {"".join(str(k).split()) for k in obj}
    if not keys or not keys <= PARSE_KEYS or not CORE_KEYS <= keys:
        return text
    rest = t[end + 1:].lstrip("\ufeff\u200b\u200c\u200d \t\r\n")
    return rest


class AgentState(TypedDict, total=False):
    user_input: str
    conv_id: int
    space_id: int  # 会话归属空间：RAG 检索按 Space 过滤（知识库按 Space 绑定）
    history: List[Dict[str, str]]  # [{"role": "user"/"assistant", "content": "..."}]
    parse_result: Dict[str, Any]
    route_reason: str
    rag_context: List[Dict]
    kg_context: List[Dict]
    agent_id: str
    prompt_text: str
    skill_id: str
    reply: str
    artifacts: List[Dict]
    namespace: str
    skill_calls: List[Dict]
    agent_calls: List[Dict]
    error: str
    extra_context: str  # @ 引用 / + 上传 注入的额外上下文内容块（app.py 组装，视为最高优先级上下文）
    task_state: Dict  # 会话级任务状态 {current_step, task_params}（后端维护并注入，指挥官据此推进采集步骤）
    trace_id: str  # 全局链路追踪 ID（随 AgentState 贯穿路由、节点、工具与产物）
    assigned_agent_id: str  # 用户本轮显式指派的 Agent（防止路由过程中丢失）
    graph_phase: str  # entry / stage / converge / blocked
    graph_route_target: str  # 入口条件边的确定性目标
    graph_next_step: str  # 阶段节点计算出的下一状态（仅图内流转，不直接写 DB）
    generic_executed: bool  # 小枢内复用执行的非迁移智能体标记


def _default_parse_schema_prompt(intents: List[str], ags: Dict[str, Dict]) -> str:
    agent_lines = "\n".join(f"- {i}: {v['intent']}" for i, v in ags.items())
    return f"""你是需求解析器。把用户需求解析为 JSON，字段如下：
- intent: 必须是以下之一 {intents}
- agent_id: 必须是 {list(ags)} 之一（对应意图）
- object_name: 用户提到的数据库对象名（表/存储过程等），没有则给空字符串
- source_db / target_db: oracle / db2 / sqlserver / dm / kingbase / gaussdb，未知给空字符串
- skill_id: 用户 @ 的技能 id，没有给空字符串
- params: {{}} 空对象
- confidence: 0~1 的数值
仅输出 JSON，不要其他内容。
\n{agent_lines}"""


class GraphRuntime:
    """持有依赖服务的运行上下文（供节点使用，便于测试注入）"""

    def __init__(self, llm: Any, rag_search: Callable, prompt_service: PromptService,
                 artifact_service: ArtifactService, skill_service: Any,
                 parse_schema: Optional[Dict], config: AppConfig,
                 max_iterations: int = 3, agent_service: Optional[AgentService] = None,
                 pipeline_service: Optional[PipelineService] = None,
                 db_tools: Optional[DbTools] = None, kg=None,
                 ops=None, gov=None,
                 rag_enabled: bool = True, datasources_enabled: bool = True,
                 migrate_assets: Any = None, migrate_state: Any = None,
                 observability: Any = None,
                 cancellation_event: Optional[threading.Event] = None):
        self.llm = llm
        self.rag_search = rag_search
        self.prompts = prompt_service
        self.artifacts = artifact_service
        self.skills = skill_service
        self.parse_schema = parse_schema
        self.config = config
        self.agent_svc = agent_service or AgentService(None)
        self.pipeline = pipeline_service or PipelineService(None)
        self.db_tools = db_tools
        self.kg = kg
        self.ops = ops
        self.gov = gov
        # 迁移能力：结构化资产服务（规则引擎扫描结果注入评估专家）+ 状态机服务
        self.migrate_assets = migrate_assets
        self.migrate_state = migrate_state
        self.observability = observability
        self.cancellation_event = cancellation_event
        # 快速问答（无空间归属会话）：禁用知识库检索与数据源/运维探活能力
        self.rag_enabled = rag_enabled
        self.datasources_enabled = datasources_enabled
        self.max_iterations = max_iterations

    def _check_cancelled(self) -> None:
        if self.cancellation_event is not None and self.cancellation_event.is_set():
            raise ChatRunCancelled("用户已中止本次智能体执行")

    def _stream_llm(self, llm: Any, messages: List[Any],
                    config: Optional[Dict] = None) -> tuple[Any, str]:
        text_parts: List[str] = []
        agg: Any = None
        for chunk in llm.stream(messages, config=config or {}):
            self._check_cancelled()
            if hasattr(chunk, "content") and chunk.content:
                text_parts.append(chunk.content)
            agg = chunk if agg is None else agg + chunk
        text = "".join(text_parts) if text_parts else (
            agg.content if hasattr(agg, "content") else str(agg) if agg else "")
        return agg, text

    def _trace(self, state: Dict, phase: str, span: str, message: str,
               level: str = "info", duration_ms: int | None = None) -> None:
        if self.observability is None:
            return
        try:
            self.observability.log(
                trace_id=str(state.get("trace_id", "") or ""),
                phase=phase, span=span, level=level, message=message,
                conv_id=state.get("conv_id"),
                task_id=(state.get("task_state") or {}).get("migrate_task_id")
                if isinstance(state.get("task_state"), dict) else None,
                duration_ms=duration_ms,
            )
        except Exception:
            return

    def get_prompt(self, category: str) -> str:
        rows = [p for p in self.prompts.list(category=category) if p["enabled"]]
        if not rows:
            return ""
        # 同 category 取最近更新的（id 最大）
        return max(rows, key=lambda p: p["id"])["content"]

    def parse(self, state: AgentState) -> AgentState:
        self._check_cancelled()
        text = state.get("user_input", "")
        if hasattr(self.llm, "parse"):
            result = self.llm.parse(text)
            self._check_cancelled()
        else:  # 真模型：结构化输出
            from langchain_core.messages import HumanMessage, SystemMessage
            pmt = _default_parse_schema_prompt(self.agent_svc.intents(),
                                               {a["id"]: a for a in self.agent_svc.enabled()})
            _started = time.monotonic()
            resp, _ = self._stream_llm(
                self.llm,
                [SystemMessage(content=pmt), HumanMessage(content=text)],
            )
            self._trace(state, "llm", "parse", "需求解析完成",
                        duration_ms=int((time.monotonic() - _started) * 1000))
            # 从 markdown 代码块中提取 JSON（LLM 常返回 ```json { ... } ``` 格式）
            raw = resp.content if hasattr(resp, "content") else str(resp)
            raw = _extract_json_from_markdown(raw)
            try:
                result = json.loads(raw)
            except (json.JSONDecodeError, AttributeError) as e:
                raise NamespaceError(f"解析输出非 JSON: {e}") from e
        if not isinstance(result, dict):
            result = {}
        state["parse_result"] = {
            "intent": str(result.get("intent", "")),
            "agent_id": str(result.get("agent_id", "")),
            "object_name": str(result.get("object_name", "")),
            "source_db": str(result.get("source_db", "")),
            "target_db": str(result.get("target_db", "")),
            "skill_id": str(result.get("skill_id", "")),
            "params": result.get("params", {}) if isinstance(result.get("params"), dict) else {},
            "confidence": float(result.get("confidence", 0.0)),
        }
        state["skill_id"] = state["parse_result"]["skill_id"]
        return state

    def route(self, state: AgentState) -> AgentState:
        # 如果前端已指定智能体，直接使用
        if state.get("agent_id") and self.agent_svc.get(state["agent_id"]):
            state["route_reason"] = f"用户指定 {state['agent_id']}"
        else:
            pr = state.get("parse_result", {})
            conf = pr.get("confidence", 0.0)
            intent = pr.get("intent", "")
            valid = self.agent_svc.intents()
            if conf < 0.5 or intent not in valid:
                state["agent_id"] = "nl2sql_qa"
                state["route_reason"] = "低置信度/未知意图，回退知识库问答（不自由发挥）"
            else:
                state["agent_id"] = self.agent_svc.resolve(intent)
                state["route_reason"] = f"命中 {state['agent_id']}"
        agent_cfg = self.agent_svc.get(state["agent_id"]) or {}
        # 提示词：先取 agents 表管理的中（category=agent，按名称对应），无则默认
        managed = [p for p in self.prompts.list(category="agent") if p["enabled"]]
        target = [p for p in managed if p["name"] == state["agent_id"]]
        state["prompt_text"] = target[-1]["content"] if target else agent_cfg.get("default_prompt", "")
        # 系统角色提示词：Agent 绑定的系统角色（type=system_role 且启用）前置拼接到系统提示词；
        # 找不到/未启用/未绑定时保持原 prompt_text（不报错）
        role_prompt_id = agent_cfg.get("system_role_prompt_id")
        if role_prompt_id:
            try:
                role = self.prompts.get(role_prompt_id)
            except Exception:
                role = None
            if (role and role.get("type") == "system_role" and role.get("enabled")
                    and (role.get("content") or "").strip()):
                state["prompt_text"] = role["content"].strip() + "\n\n" + state["prompt_text"]
        # RAG 注入（按会话空间过滤：知识库按 Space 绑定；方向4：按任务阶段定向检索）
        q = state.get("user_input", "")
        kb_types = None
        src_db = tgt_db = ""
        _ts_now = state.get("task_state") or {}
        if state.get("agent_id") == "migration_commander" and _ts_now:
            _step = str(_ts_now.get("current_step") or "").split("|")[0]
            if _step in STAGE_KB_TYPES:
                kb_types = STAGE_KB_TYPES[_step]
            _tp = _ts_now.get("task_params") or {}
            src_db = str(_tp.get("source_db_type") or "")
            tgt_db = str(_tp.get("target_db_type") or "")
        try:
            state["rag_context"] = (
                self.rag_search(q, top_k=self.config.rag_top_k,
                                space_id=state.get("space_id"),
                                kb_types=kb_types,
                                source_db=src_db, target_db=tgt_db)
                if (q and self.rag_enabled) else [])
        except TypeError:
            # 兼容旧式 rag_search 签名（无 kb_types 参数）
            state["rag_context"] = (
                self.rag_search(q, top_k=self.config.rag_top_k,
                                space_id=state.get("space_id"))
                if (q and self.rag_enabled) else [])
        # 知识图谱扩展：命中实体的一跳邻居三元组，辅助多跳问答
        state["kg_context"] = []
        if self.kg is not None:
            try:
                corpus = q + " " + " ".join(c.get("content", "") for c in state["rag_context"])
                terms = self.kg.match_entities(corpus, limit=10)
                if terms:
                    state["kg_context"] = self.kg.expand(terms, limit=15)
            except Exception:
                state["kg_context"] = []
        self._trace(state, "schedule", str(state.get("agent_id") or ""),
                    state.get("route_reason") or "路由完成")
        return state

    def _normalized_stage(self, state: Dict) -> str:
        task_state = state.get("task_state") or {}
        raw = str(task_state.get("current_step") or "DATA_COLLECTION").split("|")[0]
        return _LEGACY_STEP_MAP.get(raw, raw)

    def _flow_nodes(self) -> List[Dict]:
        if self.migrate_state is not None and hasattr(self.migrate_state, "get_flow"):
            try:
                flow = self.migrate_state.get_flow()
                if flow:
                    return [
                        {
                            "status": str(n.get("status") or ""),
                            "need_confirm": bool(n.get("need_confirm", True)),
                            "required_fields": list(n.get("required_fields") or []),
                            "enabled": bool(n.get("enabled", True)),
                        }
                        for n in flow if n.get("enabled", True)
                    ]
            except Exception:
                pass
        return list(DEFAULT_FLOW)

    def _next_stage_status(self, state: Dict) -> str:
        cur = self._normalized_stage(state)
        nodes = self._flow_nodes()
        idx = next((i for i, n in enumerate(nodes) if n["status"] == cur), None)
        if idx is None or idx >= len(nodes) - 1:
            return "FINISHED"
        return nodes[idx + 1]["status"]

    def _selected_agent(self, state: AgentState, explicit_agent_id: str = "") -> str:
        explicit = explicit_agent_id or state.get("agent_id") or ""
        if explicit and self.agent_svc.get(explicit):
            return explicit
        pr = state.get("parse_result", {})
        conf = float(pr.get("confidence", 0.0) or 0.0)
        intent = str(pr.get("intent", ""))
        if conf < 0.5 or intent not in self.agent_svc.intents():
            return "nl2sql_qa"
        return self.agent_svc.resolve(intent) or "nl2sql_qa"

    def commander(self, state: AgentState) -> AgentState:
        """入口与汇聚节点：入口负责解析/路由；汇聚阶段不再重复执行。"""
        if state.get("graph_phase") == "converge":
            return state

        explicit_agent_id = str(state.get("agent_id") or "")
        state["assigned_agent_id"] = explicit_agent_id
        state["graph_phase"] = "entry"
        self.parse(state)
        selected = self._selected_agent(state, explicit_agent_id)
        task_state = state.get("task_state")
        migration_task = bool(task_state is not None and (
            task_state.get("migrate_task_id") or task_state.get("current_step")))
        strict_flow = bool((task_state or {}).get("strict_flow", True))

        if migration_task and selected == "migration_commander":
            selected = STAGE_AGENT_BY_STATUS.get(self._normalized_stage(state), selected)

        if (migration_task and strict_flow
                and selected in STAGE_AGENT_IDS
                and selected != STAGE_AGENT_BY_STATUS.get(self._normalized_stage(state))):
            expected = STAGE_AGENT_BY_STATUS.get(self._normalized_stage(state), "migration_commander")
            state["agent_id"] = "migration_commander"
            state["route_reason"] = (
                f"当前阶段为{status_label(self._normalized_stage(state))}，"
                f"仅允许{self._agent_name(expected)}执行；"
                f"{self._agent_name(selected)}已被阶段闸门拦截")
            state["reply"] = (
                f"{state['route_reason']}。请先完成当前阶段并确认后再指派"
                f"{self._agent_name(selected)}。")
            state["graph_phase"] = "blocked"
            state["graph_route_target"] = END
            ts = state.setdefault("task_state", {})
            ts["step_status"] = "waiting_confirm"
            ts["awaiting_confirmation"] = True
            return state

        state["agent_id"] = selected
        if migration_task and selected in STAGE_AGENT_IDS:
            self.route(state)
            state["graph_route_target"] = selected
            return state

        self.route(state)
        state["graph_route_target"] = END
        # 非迁移智能体在小枢节点内复用旧执行核心。先推送路由预检事件，
        # 让 SSE 在正文流开始前知道是否需要缓冲产物型 Agent 的回复。
        self._emit({"type": "route_preflight", "agent_id": selected})
        self.execute(state)
        self.artifact(state)
        state["graph_phase"] = "converge"
        state["generic_executed"] = True
        return state

    def route_agent(self, state: Dict) -> str:
        """条件边 A：显式指派校验 + current_step 阶段映射。"""
        if state.get("graph_phase") == "converge":
            return END
        if state.get("graph_route_target"):
            return state["graph_route_target"]

        explicit = str(state.get("assigned_agent_id") or state.get("agent_id") or "")
        task_state = state.get("task_state")
        stage = self._normalized_stage(state)
        expected = STAGE_AGENT_BY_STATUS.get(stage)
        strict_flow = bool((task_state or {}).get("strict_flow", True))

        if explicit in STAGE_AGENT_IDS:
            if task_state is not None and strict_flow and expected and explicit != expected:
                state["route_reason"] = (
                    f"当前阶段为{status_label(stage)}，仅允许{self._agent_name(expected)}执行；"
                    f"{self._agent_name(explicit)}不可越级指派")
                return "migration_commander"
            return explicit

        pr = state.get("parse_result") or {}
        if explicit != "migration_commander" and float(pr.get("confidence", 0.0) or 0.0) < 0.5:
            return "migration_commander"
        if explicit == "migration_commander":
            return expected or END
        return END

    @staticmethod
    def _value_present(value: Any) -> bool:
        if value is None:
            return False
        text = str(value).strip()
        return bool(text) and text.lower() not in ("none", "null", "未指定", "未选择")

    def should_advance(self, state: Dict) -> str:
        """条件边 B-E：next/stay/wait_user/back 的统一语义。"""
        task_state = state.get("task_state") or {}
        params = task_state.get("task_params") or {}
        if not isinstance(params, dict):
            params = {}
        if (task_state.get("verification_failed")
                or params.get("verification_failed")
                or task_state.get("rollback_target")):
            return "back"

        stage = self._normalized_stage(state)
        nodes = self._flow_nodes()
        node = next((n for n in nodes if n["status"] == stage), None)
        if node is None:
            return "wait_user"
        missing = [f for f in node.get("required_fields") or []
                   if not self._value_present(params.get(f))]
        if missing:
            return "stay"
        if (node.get("need_confirm", True)
                and bool(task_state.get("step_confirm", True))
                and not self._value_present(params.get("task_confirm"))):
            return "wait_user"
        return "next"

    def stage_route(self, state: Dict) -> str:
        decision = self.should_advance(state)
        if decision != "next":
            return "migration_commander"
        next_stage = state.get("graph_next_step") or self._next_stage_status(state)
        return STAGE_AGENT_BY_STATUS.get(next_stage, "migration_commander")

    def _stage_question(self, state: AgentState) -> str:
        parts = [state.get("user_input", "")]
        task_state = state.get("task_state") or {}
        params = task_state.get("task_params") or {}
        if isinstance(params, dict) and params:
            param_text = "\n".join(f"- {k}: {v}" for k, v in params.items())
            parts.append("当前任务参数：\n" + param_text)
        if (state.get("extra_context") or "").strip():
            parts.append("引用/附件上下文：\n" + state["extra_context"].strip())
        return "\n\n".join(p for p in parts if p)

    def _collect_excel_locally(self, state: AgentState) -> Dict:
        """Excel 采集走本地确定性扫描，避免模型慢调用或漏调工具导致阶段假卡死。"""
        params = (state.get("task_state") or {}).get("task_params") or {}
        # 数据源识别：优先名称；仅拿到 ID（source_ds_id）时按 ID 解析为名称再探查，
        # 避免把数字 ID 当 name 传入导致「数据源不存在: 5」式误报。
        ds_name = str(params.get("source_ds_name") or params.get("source_ds_id") or "")
        if self.db_tools is not None and ds_name:
            ds_list = self.db_tools.list()
            matched = next((str(d.get("name")) for d in ds_list
                            if str(d.get("name")) == ds_name), None)
            if matched is None:
                matched = next((str(d.get("name")) for d in ds_list
                                if str(d.get("id")) == ds_name), None)
            if matched:
                ds_name = matched
        schema = self.db_tools.inspect_schema(ds_name)
        if not schema.get("ok"):
            return {"ok": False, "error": schema.get("message", "Excel 数据源探查失败")}

        object_rows = []
        for table in schema.get("tables") or []:
            detail = self.db_tools.inspect_schema(ds_name, str(table))
            columns = detail.get("columns") or []
            object_rows.append((table, columns))

        conv_id = int(state.get("conv_id", 0))
        object_name = primary_object_name(state.get("user_input", ""))
        namespace = make_namespace(f"sess_{conv_id}", "migration_collector", object_name)
        lines = [
            "# 数据采集报告",
            "",
            "## 采集结果",
            "",
            f"- 数据源：{ds_name}",
            f"- 源库类型：Excel",
            f"- 采集对象：{len(object_rows)} 张表",
            "",
            "| 序号 | 对象名称 | 对象类型 | 字段数 | 字段清单 |",
            "|---|---|---|---|---|",
        ]
        for idx, (table, columns) in enumerate(object_rows, 1):
            fields = "、".join(str(c.get("name", "")) for c in columns)
            lines.append(f"| {idx} | {table} | 表 | {len(columns)} | {fields} |")
        demo_objects = _MOCK_COLLECTOR_OBJECTS[:max(0, 10 - len(object_rows))]
        if demo_objects:
            lines.extend([
                "",
                "## 示例补充对象（演示数据）",
                "",
                f"以下 {len(demo_objects)} 个对象为演示补充样本，用于展示完整采集清单结构；"
                "示例对象未计入真实对象数。",
                "",
                "| 序号 | 对象名称 | 对象类型 | 字段数 | 字段清单 |",
                "|---|---|---|---|---|",
            ])
            for idx, (name, asset_type, field_count, fields) in enumerate(demo_objects, 1):
                lines.append(f"| {idx} | {name} | {asset_type} | {field_count} | {fields} |")
        lines.extend([
            "",
            "## 采集说明",
            "",
            "以上清单来自 Excel 工作表结构扫描，字段类型基于样本数据推断。索引、约束、存储过程和视图在 Excel 中未提供，后续评估将按“源库未提供”处理。",
        ])
        report = "\n".join(lines)

        task_state = state.get("task_state") or {}
        try:
            result = self.artifacts.write(
                namespace, conv_id, "migration_collector", object_name,
                {"数据采集报告.md": report},
                task_id=task_state.get("migrate_task_id"),
                trace_id=str(state.get("trace_id", "") or ""),
            )
        except NamespaceError as exc:
            return {"ok": False, "error": f"采集报告入库失败：{exc}"}

        files = result.get("files", [])
        self._trace(state, "db", "db_schema", "Excel 数据源本地结构扫描完成")
        self._trace(
            state, "artifact", "migration_collector",
            "核心产物已写入: " + ", ".join(str(f.get("path", "")) for f in files),
        )
        self._emit({
            "type": "artifact", "agent_id": "migration_collector",
            "agent_name": self._agent_name("migration_collector"),
            "namespace": namespace, "files": files,
        })
        if len(object_rows):
            params = task_state.setdefault("task_params", {})
            params["object_count"] = len(object_rows)
        reply = "已生成核心产物：" + "、".join(
            str(f.get("path", "")).split("/")[-1] for f in files)
        return {"ok": True, "agent_id": "migration_collector",
                "agent_name": self._agent_name("migration_collector"),
                "reply": reply, "artifacts": files, "ui_render": None}

    def _run_stage_agent(self, state: AgentState, agent_id: str) -> AgentState:
        self._check_cancelled()
        state["agent_id"] = agent_id
        state["graph_phase"] = "stage"
        _started = time.monotonic()
        self._trace(state, "node", agent_id, "阶段智能体开始执行")
        self.route(state)
        self._emit({"type": "system", "event": "calling_agent",
                    "message": f"正在调用【{self._agent_name(agent_id)}】执行任务…",
                    "agent_id": agent_id})
        params = (state.get("task_state") or {}).get("task_params") or {}
        use_local_excel = (
            agent_id == "migration_collector"
            and self.db_tools is not None
            and str(params.get("source_db_type") or "").lower() == "excel"
        )
        sub = (
            self._collect_excel_locally(state) if use_local_excel
            else self._call_sub_agent(agent_id, self._stage_question(state), state=state)
        )
        self._check_cancelled()
        self._emit_sub_agent(
            {**state, "agent_id": "migration_commander"}, agent_id, sub)
        state["reply"] = sub.get("reply") or sub.get("error") or ""
        state["agent_calls"] = [{
            "agent_id": agent_id,
            "question": state.get("user_input", ""),
            "reply": sub.get("reply", ""),
            "error": sub.get("error", ""),
            "artifacts": sub.get("artifacts") or [],
        }]
        state["artifacts"] = sub.get("artifacts") or []

        ts = state.setdefault("task_state", {})
        failed = bool(sub.get("error")) or bool(ts.get("verification_failed"))
        if failed:
            flow_nodes = self._flow_nodes()
            current_idx = next(
                (i for i, n in enumerate(flow_nodes)
                 if n["status"] == self._normalized_stage(state)), 0)
            ts["step_status"] = "rollback_pending" if agent_id == "migration_verifier" else "running"
            ts["rollback_target"] = flow_nodes[max(0, current_idx - 1)]["status"]
        else:
            ts["step_status"] = "done" if sub.get("artifacts") else "running"
        ts["awaiting_confirmation"] = False

        decision = self.should_advance(state)
        if decision == "wait_user":
            ts["step_status"] = "waiting_confirm"
            ts["awaiting_confirmation"] = True
        elif decision == "back":
            ts["step_status"] = "rollback_pending"
            ts["awaiting_confirmation"] = True
        # stay 表示参数未齐、不能推进；不能推翻子 Agent 已产出报告的执行完成态。
        if decision == "next":
            state["graph_next_step"] = self._next_stage_status(state)
            if state["graph_next_step"] not in STAGE_AGENT_BY_STATUS:
                state["graph_phase"] = "converge"
        else:
            state["graph_phase"] = "converge"
        self._trace(
            state, "node", agent_id,
            "阶段智能体执行完成" if not failed else "阶段智能体执行失败",
            level="info" if not failed else "error",
            duration_ms=int((time.monotonic() - _started) * 1000),
        )
        return state

    def migration_collector(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "migration_collector")

    def migration_assessor(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "migration_assessor")

    def migration_planner(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "migration_planner")

    def code_migrator(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "code_migrator")

    def migration_verifier(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "migration_verifier")

    def _available_skills(self) -> List[Dict]:
        """返回已启用的技能清单（供 LLM 自主选择调用）"""
        if self.skills is None:
            return []
        try:
            rows = self.skills.list()
        except Exception:
            return []
        return [{"skill_id": s.get("skill_id"), "name": s.get("name"),
                 "description": s.get("description"), "script": s.get("script")}
                for s in rows if s.get("enabled")]

    def _exec_skill(self, skill_id: str, args: str = "") -> Dict:
        """调用技能：返回技能内容 + 脚本执行结果。skill_id 优先精确匹配，找不到时按 name 兜底匹配"""
        skill = self.skills.get(skill_id)
        if not skill and skill_id:
            # 兼容 LLM 传名称而非注册 ID 的情况
            for row in self._available_skills():
                if row.get("name") == skill_id or row.get("skill_id") == skill_id:
                    skill = self.skills.get(row["skill_id"])
                    break
        if not skill:
            return {"ok": False, "error": f"技能 {skill_id} 不存在"}
        out = {"ok": True, "skill_id": skill["skill_id"], "name": skill["name"],
               "content": skill["content"]}
        if skill.get("chain"):
            try:
                c = self.skills.run_chain(skill_id, args=args)
                out["chain"] = c.get("stdout", "")
                if c.get("error"):
                    out["error"] = c["error"]
                if c.get("steps"):
                    out["chain_steps"] = [{"skill": s.get("skill"), "ok": s.get("ok"),
                                           "timed_out": s.get("timed_out", False)}
                                          for s in c["steps"]]
            except Exception as e:
                out["chain_error"] = str(e)
        elif skill.get("script"):
            try:
                srun = self.skills.run_script(skill_id, args=args)
                out["script"] = srun.get("stdout", "")
                if srun.get("stderr"):
                    out["script_stderr"] = srun["stderr"][:2000]
                out["script_timed_out"] = srun.get("timed_out", False)
            except Exception as e:
                out["script_error"] = str(e)
        return out

    def _agent_name(self, agent_id: str) -> str:
        """按 agent_id 取展示名（优先别名 alias，退化为 name，未知给回 id）"""
        cfg = self.agent_svc.get(agent_id) or {}
        return cfg.get("alias") or cfg.get("name") or agent_id

    def _stage_allowed_agents(self, state: Dict) -> Optional[set]:
        """逐级确认模式下，返回当前迁移阶段允许调度的子 Agent。"""
        if state.get("agent_id") != "migration_commander":
            return None
        task_state = state.get("task_state") or {}
        if not bool(task_state.get("strict_flow", True)):
            return None
        if not bool(task_state.get("step_confirm", True)):
            return None
        stage = str(task_state.get("current_step") or "").split("|")[0]
        return {
            "DATA_COLLECTION": {"migration_collector"},
            "ASSESSMENT_RUNNING": {"migration_assessor"},
            "SOLUTION_GENERATE": {"migration_planner"},
            "CODE_MIGRATE": {"code_migrator"},
            "VERIFY_STAGE": {"migration_verifier"},
            "FINISHED": set(),
        }.get(stage)

    def _blocked_agent_result(self, agent_id: str, allowed: set) -> Dict:
        names = "、".join(self._agent_name(a) for a in sorted(allowed)) or "本阶段专属工具"
        return self._sub_agent_tool_result({
            "ok": False,
            "agent_id": agent_id,
            "agent_name": self._agent_name(agent_id),
            "error": (
                f"状态机拦截：当前阶段仅允许调用 {names}；{self._agent_name(agent_id)} 未执行。"
                "请立即停止调用后续阶段 Agent，向用户展示当前阶段结果并等待显式确认。"
            ),
        })

    def _sub_agent_tool_result(self, sub: Dict) -> Dict:
        """返回给主 Agent 的子 Agent 结果投影。

        完整回复已通过 sub_agent 事件单独展示并落 trace，不能再放入 ToolMessage；
        否则主 Agent 很容易把完整报告复述进最终回复，造成前端重复。
        """
        return {
            "ok": bool(sub.get("ok")),
            "agent_id": sub.get("agent_id", ""),
            "agent_name": sub.get("agent_name", ""),
            "reply_already_displayed": True,
            "error": sub.get("error", ""),
            "artifacts": sub.get("artifacts", []),
        }

    def _emit(self, payload: Dict) -> None:
        """向流式前端推送自定义事件（get_stream_writer 仅在有 custom 流模式时可用；
        测试/静态 invoke 无 writer 时静默跳过，不影响主流程）"""
        try:
            from langgraph.config import get_stream_writer
            get_stream_writer()(payload)
        except Exception:
            pass

    def _emit_sub_agent(self, state: Dict, agent_id: str, sub: Dict) -> None:
        """下发子 Agent 输出与终态，前端用同一 agent_id 替换“正在调用”。"""
        agent_name = self._agent_name(agent_id)
        self._emit({
            "type": "sub_agent",
            "agent_id": agent_id,
            "agent_name": agent_name,
            "dispatcher_id": state.get("agent_id", ""),
            "dispatcher_name": self._agent_name(str(state.get("agent_id", ""))),
            "reply": sub.get("reply", ""),
            "error": sub.get("error", ""),
            "artifacts": sub.get("artifacts", []),
            "ui_render": sub.get("ui_render"),
        })
        success = not bool(sub.get("error"))
        artifacts = sub.get("artifacts") or []
        if not success:
            message = f"【{agent_name}】执行失败"
        elif artifacts:
            message = f"【{agent_name}】执行完成，产物已生成"
        else:
            message = f"【{agent_name}】执行完成"
        self._emit({
            "type": "system",
            "event": "agent_finished",
            "message": message,
            "agent_id": agent_id,
            "success": success,
            "artifact_count": len(artifacts),
        })

    def _call_sub_agent(self, agent_id: str, question: str,
                        state: Optional[Dict] = None) -> Dict:
        """多 Agent 编排：以另一个已启用 Agent 的提示词独立处理子问题（子 Agent 不带 call_agent
        工具，防止自递归），返回其回答文本。

        子 Agent 若配置 gen_artifact=True 且本轮产出实质性内容，在此内联写产物文件
        （子 Agent 不经过 artifact 节点），并返回写入的文件清单——这样每个专项 Agent
        的报告按产出者入库（assessment_report.md / DDL_xxx.sql 等），不再挂指挥官名下。
        """
        cfg = self.agent_svc.get(agent_id)
        if not cfg:
            return {"ok": False, "error": f"Agent {agent_id} 不存在"}
        if not cfg.get("enabled", True):
            return {"ok": False, "error": f"Agent {agent_id} 已停用"}
        system = (cfg.get("default_prompt") or "").strip()
        if not system:
            return {"ok": False, "error": f"Agent {agent_id} 未配置提示词"}
        if agent_id == "code_migrator":
            system += _code_migrator_input_discipline()
        # 方向2：规则引擎扫描结果注入（评估/转换专家接收结构化风险清单作为输入，
        # 只做业务层面解读与转换，不重复基础语法识别——「规则找问题，大模型解释问题」）
        sub_context = ""
        if (self.migrate_assets is not None and state is not None
                and agent_id in ("migration_assessor", "migration_transformer",
                                 "migration_verifier")):
            _ts = state.get("task_state") or {}
            _mid = _ts.get("migrate_task_id")
            if _mid:
                try:
                    rows = self.migrate_assets.list(int(_mid))
                except Exception:
                    rows = []
                if rows:
                    lines = [f"- {a['asset_type']} `{a['asset_name']}`（{a['risk_level']}风险）"
                             f"：{a['suggestion'] or '—'}"
                             + (f"\n  原始SQL：{a['original_sql'][:200]}" if a.get("original_sql") else "")
                             + (f"\n  转换SQL：{a['converted_sql'][:300]}" if a.get("converted_sql") else "")
                             for a in rows[:25]]
                    sub_context = (
                        "\n\n## 规则引擎静态扫描结果（结构化资产，必须作为评估/转换输入，禁止忽略）\n"
                        + "\n".join(lines)
                        + "\n\n要求：你是业务解读专家而非基础语法识别器。"
                        "基础语法问题已由规则引擎打标，你只负责业务影响解读、改造建议与目标库转换。")
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
        messages = [SystemMessage(content=system + UI_FORM_RULE)]
        if sub_context:
            messages.append(SystemMessage(content=sub_context))
        messages.append(HumanMessage(content=question))
        chunks, iterations = [], 0
        _started = time.monotonic()
        while iterations < self.max_iterations:
            self._check_cancelled()
            iterations += 1
            llm = self.llm
            if hasattr(llm, "bind_tools"):
                try:
                    llm = llm.bind_tools(self._tool_schemas(include_agents=False))
                except Exception:
                    llm = self.llm
            # callbacks=[] 切断父图 messages 流对嵌套子 Agent token 的捕获；
            # 子 Agent 完整回复只通过 sub_agent custom event 下发一次。
            _llm_started = time.monotonic()
            resp, text = self._stream_llm(
                llm, messages, config={"callbacks": []})
            self._trace(
                state or {}, "llm", agent_id, "子智能体模型调用完成",
                duration_ms=int((time.monotonic() - _llm_started) * 1000),
            )
            tool_calls = getattr(resp, "tool_calls", None) or []
            if not tool_calls:
                chunks.append(text)
                break
            self._check_cancelled()
            messages.append(resp)
            for tc in tool_calls:
                name = tc.get("name", "")
                args = tc.get("args", {}) if isinstance(tc.get("args"), dict) else {}
                out = self._dispatch_tool(name, args, state=state)
                messages.append(ToolMessage(content=out, tool_call_id=tc.get("id", ""), name=name))
        full_reply = "\n".join(chunks) or "（该 Agent 未给出回答）"
        self._check_cancelled()
        ui_render = _extract_ui_render(full_reply)
        full_reply = _strip_control_blocks(full_reply)
        full_reply = _strip_bare_ui_render(full_reply)
        if agent_id == "migration_assessor":
            full_reply = _sanitize_assessment_artifact(full_reply)
        if agent_id == "migration_planner":
            full_reply = _sanitize_plan_artifact(full_reply)
        if agent_id == "code_migrator":
            full_reply = _sanitize_code_migration_artifact(full_reply)
            if (str((state.get("task_state") or {}).get("current_step") or "") == "CODE_MIGRATE"
                    and not _is_core_delivery(agent_id, full_reply)):
                full_reply = _mock_code_migration_reply(state)
        reply = full_reply
        produced: List[Dict] = []
        # 子 Agent 自行入库：只有业务交付物才落盘。Markdown 标题代表报告，
        # SQL 代码块代表转换脚本；小采的结构化失败报告也保留为采集产物。
        if (cfg.get("gen_artifact", False) and self.artifacts is not None
                and state is not None):
            stripped = full_reply.strip()
            sql_blocks = re.findall(
                r"```sql\s*\n(.*?)\n```", stripped, re.DOTALL | re.IGNORECASE)
            verifier_assets: List[Dict] = []
            if agent_id == "migration_verifier":
                task_state = state.get("task_state") or {}
                migrate_task_id = task_state.get("migrate_task_id")
                if migrate_task_id and self.migrate_assets is not None:
                    try:
                        verifier_assets = self.migrate_assets.list(int(migrate_task_id))
                        verifier_assets = _with_demo_verification_assets(verifier_assets)
                    except Exception:
                        verifier_assets = []
            if _is_core_delivery(agent_id, stripped) or verifier_assets:
                pr = state.get("parse_result") or {}
                obj = primary_object_name(
                    pr.get("object_name") or question or state.get("user_input", ""))
                ns = make_namespace(
                    f"sess_{int(state.get('conv_id', 0))}", agent_id, obj)
                # 报告文件名取该 Agent output_files 模板第一个 .md 成员
                report_name = "generate.md"
                for fname in cfg.get("output_files", []) or []:
                    if fname.endswith(".md") and "<" not in fname:
                        report_name = fname
                        break
                report_name = _core_report_filename(report_name)
                if agent_id == "code_migrator" and not sql_blocks:
                    report_name = "代码改造分析报告.md"
                files: Dict[str, Any] = {report_name: stripped}
                specialized_code_artifact = False
                if agent_id == "migration_verifier" and verifier_assets:
                    report = _build_verification_report(
                        verifier_assets, _target_database_name(state))
                    files = {
                        "校验报告.md": report,
                        "迁移测试清单.xlsx": _build_verification_workbook(
                            verifier_assets, _target_database_name(state)),
                    }
                    stripped = report
                    specialized_code_artifact = True
                if agent_id == "code_migrator":
                    before_sql, after_sql = _extract_code_migration_sqls(stripped)
                    if before_sql and after_sql:
                        files, report = _build_code_migration_files(
                            stripped, _target_database_name(state))
                        stripped = report
                        specialized_code_artifact = True
                # SQL 转换专家等：额外抽取 SQL 代码块单独存为 .sql
                if not specialized_code_artifact:
                    for idx, block in enumerate(sql_blocks):
                        files[f"转换脚本_{obj}_{idx + 1}.sql" if idx else f"转换脚本_{obj}.sql"] = block.strip()
                try:
                    _task_state = state.get("task_state") or {}
                    res = self.artifacts.write(
                        ns, int(state.get("conv_id", 0)), agent_id, obj, files,
                        task_id=_task_state.get("migrate_task_id"),
                        trace_id=str(state.get("trace_id", "") or ""))
                    produced = res.get("files", [])
                    self._trace(
                        state, "artifact", agent_id,
                        "核心产物已写入: " + ", ".join(str(f.get("path", "")) for f in produced),
                    )
                    reply = "已生成核心产物：" + "、".join(
                        str(f.get("path", "")).split("/")[-1] for f in produced)
                    # 实时事件：通知前端产物已生成（按产出 Agent 分组）
                    self._emit({"type": "artifact", "agent_id": agent_id,
                                "agent_name": self._agent_name(agent_id),
                                "namespace": ns, "files": produced})
                except NamespaceError as e:
                    reply += f"\n\n（产物入库失败：{e}）"
        self._trace(
            state or {}, "node", agent_id, "子智能体调用完成",
            duration_ms=int((time.monotonic() - _started) * 1000),
        )
        return {"ok": True, "agent_id": agent_id, "agent_name": cfg.get("name") or agent_id,
                "reply": reply, "artifacts": produced, "ui_render": ui_render}

    def _dispatch_tool(self, name: str, args: Dict, state: Optional[Dict]) -> str:
        """工具分发：返回工具结果 JSON 字符串（供主图与子 Agent 共用）"""
        user_input = state.get("user_input", "") if state else ""
        if name == "rag_search" and self.rag_search and self.rag_enabled:
            result = self.rag_search(args.get("query", user_input),
                                     top_k=args.get("top_k", 3),
                                     space_id=state.get("space_id") if state else None)
            return json.dumps(result, ensure_ascii=False)
        if name == "use_skill" and self.skills is not None:
            exec_out = self._exec_skill(str(args.get("skill_id", "")), str(args.get("args", "")))
            return json.dumps(exec_out, ensure_ascii=False)
        if name == "db_schema" and self.db_tools is not None:
            self._trace(state or {}, "db", name, "数据源结构探查")
            return json.dumps(self.db_tools.inspect_schema(
                str(args.get("ds", "")), str(args.get("object", ""))), ensure_ascii=False)
        if name == "db_query" and self.db_tools is not None:
            self._trace(state or {}, "db", name, "数据源只读查询")
            return json.dumps(self.db_tools.query(
                str(args.get("ds", "")), str(args.get("sql", ""))), ensure_ascii=False)
        if name == "db_explain" and self.db_tools is not None:
            self._trace(state or {}, "db", name, "数据源执行计划查询")
            return json.dumps(self.db_tools.explain(
                str(args.get("ds", "")), str(args.get("sql", ""))), ensure_ascii=False)
        if name == "call_agent":
            sub = self._call_sub_agent(
                str(args.get("agent_id", "")), str(args.get("question", "")),
                state=state)
            return json.dumps(self._sub_agent_tool_result(sub), ensure_ascii=False)
        if name == "call_agents_parallel":
            # 兜底路径（正常仅主图 execute 处理）：串行逐个执行，行为等价
            raw = args.get("calls")
            results = [self._sub_agent_tool_result(self._call_sub_agent(
                str(c.get("agent_id", "")), str(c.get("question", "")), state=state))
                       for c in (raw or []) if isinstance(c, dict) and c.get("agent_id")]
            return json.dumps({"parallel": False, "results": results}, ensure_ascii=False)
        if name == "ops_health" and self.ops is not None:
            self._trace(state or {}, "db", name, "运维健康巡检")
            return json.dumps(self.ops.health_check(str(args.get("ds", ""))), ensure_ascii=False)
        if name == "ops_slow_sql" and self.ops is not None:
            self._trace(state or {}, "db", name, "慢 SQL 查询")
            return json.dumps(self.ops.slow_queries(
                threshold_ms=int(args.get("threshold_ms", 0)),
                limit=int(args.get("limit", 20))), ensure_ascii=False)
        if name == "ops_baseline" and self.ops is not None:
            self._trace(state or {}, "db", name, "性能基线查询")
            return json.dumps(self.ops.baseline(), ensure_ascii=False)
        if name == "gov_catalog" and self.gov is not None:
            self._trace(state or {}, "governance", name, "治理资产目录查询")
            return json.dumps(self.gov.catalog(str(args.get("ds", ""))), ensure_ascii=False)
        if name == "gov_quality" and self.gov is not None:
            self._trace(state or {}, "governance", name, "治理质量评分")
            return json.dumps(self.gov.quality(str(args.get("ds", ""))), ensure_ascii=False)
        if name == "gov_kgsync" and self.gov is not None:
            self._trace(state or {}, "governance", name, "知识图谱同步")
            return json.dumps(self.gov.kg_sync(), ensure_ascii=False)
        return json.dumps({"error": f"未知工具: {name}"}, ensure_ascii=False)

    def execute(self, state: AgentState) -> AgentState:
        skill_block = ""
        if state.get("skill_id"):
            try:
                if self.skills is not None:
                    skill = self.skills.get(state["skill_id"])
                    if skill:
                        skill_block = f"\n\n## 用户指定的技能\n### {skill['name']}\n{skill['description']}\n{skill['content']}"
                        script_name = skill.get("script")
                        chain = skill.get("chain")
                        if script_name or chain:
                            try:
                                srun = self.skills.run_chain(state["skill_id"]) \
                                    if chain else self.skills.run_script(state["skill_id"])
                            except Exception as e:
                                skill_block += f"\n\n### 技能脚本执行失败：{e}\n请基于技能说明回答。"
                            else:
                                if srun.get("timed_out"):
                                    script_out = f"（脚本 {script_name} 执行超时，请基于技能说明回答）"
                                else:
                                    script_out = (srun.get("stdout") or "").strip()
                                    if srun.get("stderr"):
                                        script_out += f"\n[stderr] {srun['stderr'][:2000]}"
                                skill_block += (
                                    f"\n\n### 技能脚本执行结果 `{script_name or ' / '.join(chain or [])}`\n"
                                    f"{script_out if script_out else '（无输出）'}\n"
                                    "请优先使用脚本输出回答，并注明结果来自技能脚本。")
            except Exception:
                skill_block = ""
        rag_block = ""
        if state.get("rag_context"):
            lines = []
            for i, c in enumerate(state["rag_context"]):
                lines.append(f"[{i}] 来源:{c['doc_name']}#{c['chunk_index']} score={c['score']}\n{c['content']}")
            rag_block = "\n\n## 知识库检索结果（必须带引用，不得编造）\n" + "\n".join(lines)

        kg_block = ""
        if state.get("kg_context"):
            triples = "\n".join(f"- {t['subject']} --{t['relation']}--> {t['object']}"
                                for t in state["kg_context"])
            kg_block = ("\n\n## 知识图谱关联（实体关系三元组，用于多跳推理辅助）\n" + triples +
                        "\n仅在回答与实体关联问题时引用，未涉及的实体关系不要编造。")

        skills_info = ""
        if self.skills is not None:
            av = self._available_skills()
            if av:
                skills_info = (
                    "\n\n## 可用技能清单\n" + "\n".join(
                        f"- {s['skill_id']}（{s['name']}）: {s['description']}"
                        + (f"，脚本 {s['script']}" if s.get("script") else "")
                        for s in av) +
                    "\n硬性规则：只要用户需求与清单中某个技能匹配，你就必须通过 use_skill 工具调用它"
                    "（即使你已知道答案也要调用以获得脚本输出），获取结果后再回答。")

        ds_info = ""
        if self.datasources_enabled and self.db_tools is not None:
            dss = [d for d in self.db_tools.list() if d.get("enabled")]
            if dss:
                ds_info = ("\n\n## 已配置只读数据源（可用 db_schema 探查表结构、db_query 执行只读查询）\n"
                           + "\n".join(f"- {d['name']}（{d['kind']}）: {d.get('location', '')}"
                                       for d in dss))

        # @ 引用 / + 上传 的额外上下文：视为最高优先级（追加在 system 最前，紧邻提示词之后）
        ref_block = ""
        if (state.get("extra_context") or "").strip():
            ref_block = "\n\n## 本次引用/附件上下文\n" + state["extra_context"].strip()

        # ---- 会话级任务状态注入：current_step（状态机阶段）/ task_params（后端维护） ----
        # LLM 无法自动读取后端变量，必须由后端每轮拼进 system 上下文；
        # 否则指挥官「失忆」反复停留在第一步、重复向用户索要已收集参数。
        # 关键点：状态机阶段由后端确定性流转，LLM 只按指引推进当前阶段，无权跳转节点。
        task_state_block = ""
        # 仅当用户本轮输入为迁移/任务指令时才注入任务状态并引导推进；非任务指令（你是谁/闲聊）
        # 不注入，避免指挥官凭空汇报"已收集基础信息"或主动推进（任务参数是历史断点续跑数据，非本轮采集）。
        _task_directive = bool(re.search(
            r"继续|确认|同意|下一步|下一阶段|开始执行|开始迁移|就这么办|推进|执行|选择|"
            r"数据源|源库|源数据库|目标库|目标数据库|库类型|容量|停机|业务等级|迁移对象|"
            r"扫描|评估|转换|方案|验证|投产|回滚|国产化|迁移|达梦|金仓|高斯|oceanbase|"
            r"opengauss|postgresql|oracle|mysql", str(state.get("user_input") or "")))
        if state.get("agent_id") == "migration_commander" and state.get("task_state") is not None \
                and _task_directive:
            ts = state["task_state"] or {}
            ts_step_raw = str(ts.get("current_step") or "DATA_COLLECTION").split("|")[0]
            ts_step = _LEGACY_STEP_MAP.get(ts_step_raw, ts_step_raw)
            strict_flow = bool(ts.get("strict_flow", True))
            warning = ts.get("last_warning")
            ts_params = ts.get("task_params") or {}
            if isinstance(ts_params, dict):
                param_lines = "\n".join(f"- {k}：{v}" for k, v in ts_params.items())
            else:
                param_lines = str(ts_params)
            guidance = STATE_GUIDANCE.get(ts_step, "")
            if strict_flow:
                ack_rules = (
                    "1. 先读取 current_step（状态机阶段）与 task_params，判断采集/执行进行到哪一步、"
                    "已收集了哪些参数，禁止重复索要已收集的参数；\n"
                    "2. 所选数据源已由后端记录（source_ds_id 一旦赋值不再询问），禁止重复弹出数据源选择表单；\n"
                    "3. 状态跳转由后端状态机控制，你无权跳转节点，只能推进当前阶段："
                    "基础信息阶段收集参数、执行阶段依次编排对应子 Agent；\n"
                    "4. 需要用户补充当前阶段所需信息时，按当前动作指引输出交互式表单（UI_RENDER）；\n"
                    "5. 若本条回复完成了当前阶段的素材产出（如扫描清单、转换脚本），"
                    "可附加一个状态声明块提示后端（该块不会展示给用户，JSON 必须合法）：\n"
                    "<TASK_STATE>\n{\"task_params\": {\"stage_done\": \"true\"}}\n</TASK_STATE>\n"
                    "（注意：该声明不会改变状态机阶段，仅作后端推进素材的信号。）")
            else:
                ack_rules = (
                    "1. 当前为自由流程模式：current_step 仅表示最近记录的进度，不是执行许可；\n"
                    "2. 用户指定哪个阶段/专家，就优先调用对应子 Agent，不得以前序阶段未完成为由拒绝；\n"
                    "3. 用户未明确指定阶段时，可按当前阶段执行；\n"
                    "4. 已收集参数仍需复用，禁止重复索要。")
            warn_line = ""
            if warning:
                warn_line = "\n⚠️ 后端拦截提示：%s" % str(warning)
            task_state_block = (
                "\n\n## 当前任务状态（后端状态机变量，必须读取并据此推进，无权修改阶段流转）\n"
                f"- 当前阶段（current_step）：{ts_step}（{status_label(ts_step)}）\n"
                f"- 已收集参数（task_params）：\n{param_lines if param_lines else '（暂无，尚未开始采集）'}\n"
                f"- 当前动作指引：{guidance or '（无特定指引，按用户需求回复）'}\n"
                + (warn_line + "\n" if warn_line else "") +
                "推进规则（必须严格遵守）：\n" + ack_rules)

        # ---- 代码级迁移流水线（编排确定性保障） ----
        # 任务确认后（app.py 写入 pipeline_start=True），由后端注入强制调度计划，
        # 不再依赖指挥官模型自主决定「调几个子 Agent、调哪几个」——这是竞赛演示
        # 「指挥官只串联 1 个子 Agent 就结束」隐患的根因修复。
        # 后续轮用户说「继续/接着/下一步」时同样激活，补齐剩余步骤。
        pipeline_active = False
        pipeline_block = ""
        if state.get("agent_id") == "migration_commander":
            _ts0 = state.get("task_state") or {}
            _step0 = _LEGACY_STEP_MAP.get(
                str(_ts0.get("current_step") or "").split("|")[0],
                str(_ts0.get("current_step") or "").split("|")[0])
            _continue = bool(re.search(r"继续|接着|下一步|开始执行|开始迁移", state.get("user_input", "")))
            _strict_flow = bool(_ts0.get("strict_flow", True))
            pipeline_active = (_step0 in _M_EXEC_STATES
                               and (bool(_ts0.get("pipeline_start")) or _continue)
                               and _strict_flow)
            if not _strict_flow:
                pipeline_block = (
                    "\n\n## 自由流程模式（流程强校验已关闭）\n"
                    "当前任务不强制按状态机顺序执行。用户指定哪个阶段/专家，就调用对应子 Agent；"
                    "用户未明确指定时，可按当前阶段执行。不得因为前序阶段未完成而拒绝执行。")
        if pipeline_active:
            # 逐级确认开关（DB 配置化，来自任务 step_confirm）：开启=每级完成停驻等确认，关闭=一次性编排跑完
            _step_confirm = bool(_ts0.get("step_confirm", True))
            if _step_confirm:
                pipeline_block = (
                    "\n\n## 当前迁移阶段（逐级确认模式，后端已开启）\n"
                    f"你正处于「{status_label(_step0)}」阶段。\n"
                    "必须严格遵守：\n"
                    "1. 本轮只执行当前阶段对应的动作（按上方「当前动作指引」调用当前阶段的子 Agent / 产出当前阶段素材）；\n"
                    "2. 完成后立即停驻：向用户展示本阶段产物摘要，并明确请求用户确认（回复「继续 / 确认」）；\n"
                    "3. 在获得用户确认前，禁止编排下一个阶段的子 Agent，禁止输出后续阶段的结论或报告内容；\n"
                    "4. 用户确认后由后端自动推进到下一阶段，你无需也不得自行跳转。")
            else:
                plan_lines = "\n".join(
                    f"{i}. {p['agent_id']}（{p['label']}）：{p['desc']}"
                    for i, p in enumerate(self.pipeline.steps("migration"), 1))
                pipeline_block = (
                    "\n\n## 强制调度计划（后端代码注入，必须完整执行）\n"
                    "用户已确认迁移任务。你必须按以下顺序编排子 Agent，把已采集参数（源/目标数据源等）"
                    "写入每个委派问题中：\n" + plan_lines +
                    "\n执行规则（必须严格遵守）：\n"
                    "1. 每个步骤必须真正发起工具调用：串行用 call_agent；互相独立的步骤"
                    "（data_migrator 与 code_migrator）优先用 call_agents_parallel 一次并行委派；\n"
                    "2. migration_verifier 必须在其余步骤全部返回后最后调用；\n"
                    "3. 全部步骤完成前禁止输出面向用户的最终总结；\n"
                    "4. 全部完成后输出简要总结（禁止重复子 Agent 回答内容）。")

        # 非任务指令（你是谁/问候/闲聊/普通问答）：覆盖迁移引导，指示纯回答，
        # 避免模型主动引导迁移、列举数据源或复读已输出内容。
        non_task_block = ""
        if state.get("agent_id") == "migration_commander" and not _task_directive:
            non_task_block = (
                "\n\n## 当前对话不是迁移任务指令\n"
                "用户本轮输入未包含迁移/任务推进意图（如自我介绍、问候、闲聊、普通问答）。请严格遵守：\n"
                "1. 直接针对用户的问题简洁回答，不要主动引导/启动迁移流程；\n"
                "2. 不要主动列举可用数据源、不要追问迁移需求、不要重复能力介绍；\n"
                "3. 严禁复述或重复任何已输出的内容，同一内容只输出一次。")

        system = (state.get("prompt_text") + _role_boundary_block(state.get("agent_id", "")) +
                  "\n目标库: " + state["parse_result"].get("target_db", "") +
                  ref_block + rag_block + skill_block + skills_info + ds_info + kg_block +
                  task_state_block + pipeline_block + non_task_block + UI_FORM_RULE)
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
        messages = [SystemMessage(content=system)]
        # 注入历史对话上下文（最近 N 轮）
        for h in state.get("history", [])[-10:]:
            if h.get("role") == "user":
                messages.append(HumanMessage(content=h.get("content", "")))
            elif h.get("role") == "assistant":
                # 历史脏数据可能自带「解析结果 JSON」前缀或控制指令块，回灌前剥离，
                # 防止模型照抄该结构导致重复输出
                messages.append(AIMessage(
                    content=_strip_control_blocks(_strip_leading_parse_json(h.get("content", "")))))
        messages.append(HumanMessage(content=state.get("user_input", "")))

        # 工具调用循环：LLM 可自主调用 rag_search（检索知识库）、use_skill（执行技能）、
        # db_*（只读数据源查询）与 call_agent（编排其他智能体）
        reply_chunks, iterations = [], 0
        skill_calls: List[Dict] = []
        agent_calls: List[Dict] = []
        # 本轮各子 Agent 内联写入的产物累计（供指挥官 artifact 节点写任务索引引用）
        inline_artifacts: List[Dict] = []
        allow_agents = True   # 是否允许 call_agent（指挥官采集阶段被硬闸门关闭）；循环内会重新赋值
        nudge_used = False    # 「宣布要调用却没调用」的系统提醒每轮最多补一次，防止死循环
        plan_nudges = 0       # 流水线看门狗：计划未完成就收尾时的强制续跑提醒（最多 2 次）
        stage_blocked = False # 逐级确认下一旦违规调用后续阶段，本轮立即关闭子 Agent 工具
        while iterations < self.max_iterations:
            self._check_cancelled()
            iterations += 1
            llm = self.llm
            if hasattr(llm, "bind_tools"):
                try:
                    # 硬闸门：指挥官仅在状态机执行阶段（扫对象/评估/SQL转换/方案/验证）
                    # 才暴露 call_agent 工具；采集阶段（INIT/选源/基础信息）不暴露，
                    # 从工具层保证「后端状态机未放行前不调用子 Agent」
                    allow_agents = True
                    if state.get("agent_id") == "migration_commander":
                        _cmdr_step_raw = str(((state.get("task_state") or {})
                                              .get("current_step") or ""))
                        _cmdr_step = _LEGACY_STEP_MAP.get(
                            _cmdr_step_raw.split("|")[0], _cmdr_step_raw.split("|")[0])
                        allow_agents = _cmdr_step in _M_EXEC_STATES
                    llm = llm.bind_tools(self._tool_schemas(
                        include_agents=allow_agents and not stage_blocked,
                        current_agent_id=state.get("agent_id", "")))
                except Exception:
                    llm = self.llm
            # 关键修复：用 llm.stream() 代替 llm.invoke()，避免某些 LLM 提供商
            # （如通义千问）在 invoke() 内部流式实现导致 messages 模式捕获多次。
            # stream() 逐 token 产出，LangGraph 的 messages 模式只捕获一次完整流。
            # 逐块聚合，保留工具调用增量，并在每个 token 边界响应中止。
            resp, text = self._stream_llm(llm, messages)
            tool_calls = getattr(resp, "tool_calls", None) or [] if resp else []
            if not tool_calls:
                # 兜底：模型「嘴上宣布将调用子 Agent」却没真正发起工具调用
                # （LLM 常见行为；会话历史里出现过只宣布不执行的样例时会加剧）。
                # call_agent 可用且尚未提醒过时，注入系统提醒要求立即真正调用；
                # 模型可改为真正调用，或给出不提及调用的最终答复。
                if (allow_agents and not nudge_used
                        and iterations < self.max_iterations
                        and _ANNOUNCE_CALL_RE.search(text)):
                    nudge_used = True
                    messages.append(AIMessage(content=text))
                    messages.append(HumanMessage(content=(
                        "（系统提醒，用户不可见）你刚才声明将调用其他智能体，"
                        "但没有实际发起 call_agent 工具调用。请立即通过 call_agent "
                        "工具真正调用目标智能体（不要再用文字宣布）；"
                        "若确实无需调用，请直接给出面向用户的最终答复，"
                        "且不要再提及将调用任何智能体。")))
                    continue
                # 流水线看门狗：强制调度计划未完成时模型提前输出总结 → 拦截并要求继续编排。
                # 这是「指挥官只串联 1 个子 Agent 就结束」的代码级兜底（不依赖模型自觉）。
                if (pipeline_active and iterations < self.max_iterations
                        and plan_nudges < 2 and allow_agents):
                    called_ids = {str(ac.get("agent_id", "")) for ac in agent_calls}
                    pending = [p for p in self.pipeline.steps("migration") if p["agent_id"] not in called_ids]
                    if pending:
                        plan_nudges += 1
                        remain = "、".join(p["agent_id"] for p in pending)
                        messages.append(AIMessage(content=text))
                        messages.append(HumanMessage(content=(
                            "（系统提醒，用户不可见）强制调度计划尚未完成：还未调用 "
                            f"{remain}。请继续按计划顺序通过 call_agent / call_agents_parallel "
                            "工具真正调用剩余子 Agent（migration_verifier 最后调用），"
                            "全部完成后再输出面向用户的简要总结。现在立即发起下一个工具调用。")))
                        continue
                # 最终回复轮：node 内 llm.stream 的 token 会被 langgraph
                # stream_mode="messages" 捕获并推给前端（打字机效果）。
                reply_chunks.append(text)
                break
            # 本轮发起工具调用：中间推理文本不进入最终回复
            from langchain_core.messages import ToolMessage
            messages.append(resp)
            for tc in tool_calls:
                name = tc.get("name", "")
                args = tc.get("args", {}) if isinstance(tc.get("args"), dict) else {}
                out: Optional[str] = None
                if name == "use_skill":
                    exec_out = self._exec_skill(str(args.get("skill_id", "")),
                                                str(args.get("args", "")))
                    skill_calls.append({"skill_id": args.get("skill_id", ""),
                                        "args": args.get("args", ""),
                                        "script": exec_out.get("script", ""),
                                        "chain": exec_out.get("chain", ""),
                                        "script_error": exec_out.get("script_error", ""),
                                        "chain_error": exec_out.get("chain_error", ""),
                                        "error": exec_out.get("error", "")})
                    out = json.dumps(exec_out, ensure_ascii=False)
                elif name == "call_agent":
                    sub_id = str(args.get("agent_id", ""))
                    sub_name = self._agent_name(sub_id)
                    allowed_agents = self._stage_allowed_agents(state)
                    if allowed_agents is not None and sub_id not in allowed_agents:
                        blocked = self._blocked_agent_result(sub_id, allowed_agents)
                        stage_blocked = True
                        out = json.dumps(blocked, ensure_ascii=False)
                    else:
                        # 调度事件：通知前端「正在调用子 Agent」（灰色系统事件，非业务答案）
                        self._emit({"type": "system", "event": "calling_agent",
                                    "message": f"正在调用【{sub_name}】执行任务…",
                                    "agent_id": sub_id})
                        sub = self._call_sub_agent(sub_id, str(args.get("question", "")), state=state)
                        sub_arts = sub.get("artifacts") or []
                        if sub_arts:
                            inline_artifacts.extend(sub_arts)
                        agent_calls.append({"agent_id": sub_id,
                                            "question": args.get("question", ""),
                                            "reply": sub.get("reply", ""),
                                            "error": sub.get("error", ""),
                                            "artifacts": sub_arts})
                        # 子 Agent 输出事件：前端单独渲染为蓝色子 Agent 消息（带调度溯源）
                        self._emit_sub_agent(state, sub_id, sub)
                        out = json.dumps(self._sub_agent_tool_result(sub), ensure_ascii=False)
                elif name == "call_agents_parallel":
                    # 并行编排：互相独立的子任务（如 数据搬迁 ∥ 代码改造）一次并行委派。
                    # 子 Agent 内部为纯 LLM/只读检索 + 各自独立 DB 会话，可安全并发；
                    # SSE 事件统一在主线程按提交顺序发出，保证前端渲染时序稳定。
                    raw_calls = args.get("calls")
                    if isinstance(raw_calls, str):
                        try:
                            raw_calls = json.loads(raw_calls)
                        except json.JSONDecodeError:
                            raw_calls = []
                    calls = [c for c in (raw_calls or [])
                             if isinstance(c, dict) and str(c.get("agent_id", "")).strip()][:4]
                    if not calls:
                        out = json.dumps(
                            {"error": "calls 为空或格式不合法，应为 [{\"agent_id\": ..., \"question\": ...}]，最多 4 个"},
                            ensure_ascii=False)
                    else:
                        allowed_agents = self._stage_allowed_agents(state)
                        if allowed_agents is None:
                            runnable_calls = calls
                            blocked_results: List[Dict] = []
                        else:
                            runnable_calls = [c for c in calls
                                              if str(c["agent_id"]) in allowed_agents]
                            blocked_results = [self._blocked_agent_result(str(c["agent_id"]), allowed_agents)
                                               for c in calls
                                               if str(c["agent_id"]) not in allowed_agents]
                            for c in calls:
                                sub_id = str(c["agent_id"])
                                if sub_id not in allowed_agents:
                                    stage_blocked = True
                        for c in runnable_calls:
                            self._emit({"type": "system", "event": "calling_agent",
                                        "message": f"正在调用【{self._agent_name(str(c['agent_id']))}】执行任务…（并行）",
                                        "agent_id": str(c["agent_id"])})
                        subs: List[Dict] = []
                        if runnable_calls:
                            from concurrent.futures import ThreadPoolExecutor
                            with ThreadPoolExecutor(max_workers=len(runnable_calls)) as pool:
                                futs = [pool.submit(self._call_sub_agent, str(c["agent_id"]),
                                                    str(c.get("question", "")), state)
                                        for c in runnable_calls]
                                for f in futs:
                                    try:
                                        subs.append(f.result())
                                    except Exception as e:  # 单个子 Agent 失败不拖垮整批
                                        subs.append({"ok": False, "error": f"并行执行异常：{e}"})
                        for c, sub in zip(runnable_calls, subs):
                            sub_id = str(c["agent_id"])
                            sub_name = self._agent_name(sub_id)
                            sub_arts = sub.get("artifacts") or []
                            if sub_arts:
                                inline_artifacts.extend(sub_arts)
                            agent_calls.append({"agent_id": sub_id,
                                                "question": c.get("question", ""),
                                                "reply": sub.get("reply", ""),
                                                "error": sub.get("error", ""),
                                                "artifacts": sub_arts})
                            self._emit_sub_agent(state, sub_id, sub)
                        out = json.dumps({"parallel": True, "results": [
                            self._sub_agent_tool_result(sub) for sub in subs
                        ] + blocked_results}, ensure_ascii=False)
                if out is None:
                    out = self._dispatch_tool(name, args, state=state)
                messages.append(ToolMessage(content=out, tool_call_id=tc.get("id", ""), name=name))

        state["reply"] = "\n".join(reply_chunks)
        if skill_calls:
            state["skill_calls"] = skill_calls
        if agent_calls:
            state["agent_calls"] = agent_calls
        # 暴露本轮各子 Agent 内联写入的产物，供 artifact 节点引用/合并
        if inline_artifacts:
            state["artifacts"] = inline_artifacts
        return state

    def _tool_schemas(self, include_agents: bool = True,
                      current_agent_id: str = "") -> List[Dict]:
        """暴露给 LLM 的工具定义：rag_search / use_skill / db_schema / db_query / db_explain /
        call_agent（多智能体编排，默认排除当前执行的智能体，避免自循环）"""
        schemas = [
            {"type": "function",
             "function": {"name": "rag_search",
                          "description": "检索知识库获取国产数据库迁移/语法资料，参数 query 为检索词，top_k 为返回条数（默认3）",
                          "parameters": {"type": "object",
                                         "properties": {"query": {"type": "string"}, "top_k": {"type": "integer"}},
                                         "required": ["query"]}}},
            {"type": "function",
             "function": {"name": "use_skill",
                          "description": "调用已启用的技能并（若有脚本则）执行脚本，返回技能内容与脚本输出。skill_id 为技能 ID；args 为传给脚本的命令行参数，只传具体值（如 8、abc.sql），多个参数用空格分隔；严禁传自然语言句子、单位后缀或说明文字",
                          "parameters": {"type": "object",
                                         "properties": {"skill_id": {"type": "string"}, "args": {"type": "string"}},
                                         "required": ["skill_id"]}}},
        ]
        if self.datasources_enabled and self.db_tools is not None:
            schemas.append({"type": "function",
                            "function": {"name": "db_schema",
                                         "description": "探查已配置只读数据源的表/视图/列结构。ds 为数据源名称；object 为空时列出全部对象，填写对象名时返回其列与类型定义",
                                         "parameters": {"type": "object",
                                                        "properties": {"ds": {"type": "string"}, "object": {"type": "string"}},
                                                        "required": ["ds"]}}})
            schemas.append({"type": "function",
                            "function": {"name": "db_query",
                                         "description": "对已配置只读数据源执行只读 SELECT/WITH 查询（禁止任何写操作），返回列名与最多100行数据。ds 为数据源名称，sql 为 SQL 语句",
                                         "parameters": {"type": "object",
                                                        "properties": {"ds": {"type": "string"}, "sql": {"type": "string"}},
                                                        "required": ["ds", "sql"]}}})
            schemas.append({"type": "function",
                            "function": {"name": "db_explain",
                                         "description": "对已配置只读数据源做只读语法校验（EXPLAIN，不返回数据），用于确认 SQL 语法有效。ds 为数据源名称，sql 为待校验语句",
                                         "parameters": {"type": "object",
                                                        "properties": {"ds": {"type": "string"}, "sql": {"type": "string"}},
                                                        "required": ["ds", "sql"]}}})
        if include_agents:
            peers = [a for a in self.agent_svc.enabled()
                     if a.get("id") and a.get("id") != current_agent_id
                     and a.get("default_prompt")]
            if peers:
                peer_desc = "；".join(f"{a['id']}（{a['name']}）" for a in peers)
                schemas.append({"type": "function",
                                "function": {"name": "call_agent",
                                             "description": "多智能体编排：当本智能体无法独立完成某子任务时，把该子问题委派给以下其他已启用智能体处理，返回其回答。agent_id 必须是其中之一"
                                             + f" [{peer_desc}]；question 为委派的具体子问题。**注意：子智能体的回答已通过独立事件展示给用户，你在最终回复中不要重复/复述子智能体的回答内容，只需简要确认已委派并等待结果即可。**",
                                             "parameters": {"type": "object",
                                                            "properties": {"agent_id": {"type": "string"},
                                                                           "question": {"type": "string"}},
                                                            "required": ["agent_id", "question"]}}})
                schemas.append({"type": "function",
                                "function": {"name": "call_agents_parallel",
                                             "description": "并行多智能体编排：把多个**互相独立、无先后依赖**的子任务一次并行委派（如 数据搬迁 与 应用代码改造），全部执行完后统一返回结果。calls 为数组，每项 {agent_id, question}，最多 4 个；有先后依赖的任务必须用 call_agent 串行。可选 agent_id 同 call_agent。"
                                             + f" [{peer_desc}]；**同样禁止在最终回复中重复/复述子智能体的回答内容。**",
                                             "parameters": {"type": "object",
                                                            "properties": {"calls": {"type": "array",
                                                                                     "items": {"type": "object",
                                                                                               "properties": {"agent_id": {"type": "string"},
                                                                                                              "question": {"type": "string"}},
                                                                                               "required": ["agent_id", "question"]}}},
                                                            "required": ["calls"]}}})
        if self.datasources_enabled and self.ops is not None:
            schemas.append({"type": "function",
                            "function": {"name": "ops_health",
                                         "description": "对已配置数据源做健康巡检（探活 SELECT 1，返回各数据源接通状态与延迟）。ds 为空则巡检全部启用数据源",
                                         "parameters": {"type": "object",
                                                        "properties": {"ds": {"type": "string"}},
                                                        "required": []}}})
            schemas.append({"type": "function",
                            "function": {"name": "ops_slow_sql",
                                         "description": "查询慢 SQL 诊断记录（耗时超过 threshold_ms 默认可不传），返回慢查询列表与统计",
                                         "parameters": {"type": "object",
                                                        "properties": {"threshold_ms": {"type": "integer"},
                                                                       "limit": {"type": "integer"}},
                                                        "required": []}}})
            schemas.append({"type": "function",
                            "function": {"name": "ops_baseline",
                                         "description": "查看性能基线：按数据源的慢查询样本与探活延迟聚合（均值/最大），并给出超标告警",
                                         "parameters": {"type": "object", "properties": {}, "required": []}}})
        if self.gov is not None:
            schemas.append({"type": "function",
                            "function": {"name": "gov_catalog",
                                         "description": "抽取数据源元数据资产目录（表/视图/列/行数/主键），ds 为空则抽取全部启用数据源",
                                         "parameters": {"type": "object",
                                                        "properties": {"ds": {"type": "string"}},
                                                        "required": []}}})
            schemas.append({"type": "function",
                            "function": {"name": "gov_quality",
                                         "description": "对已建资产目录的表生成数据质量评分（非空率/唯一性/空值率），ds 为空则评估全部",
                                         "parameters": {"type": "object",
                                                        "properties": {"ds": {"type": "string"}},
                                                        "required": []}}})
            schemas.append({"type": "function",
                            "function": {"name": "gov_kgsync",
                                         "description": "把治理资产目录中的表/列同步为知识图谱实体与关系",
                                         "parameters": {"type": "object", "properties": {}, "required": []}}})
        return schemas

    def artifact(self, state: AgentState) -> AgentState:
        self._check_cancelled()
        pr = state["parse_result"]
        agent_id = state["agent_id"]
        cfg = self.agent_svc.get(agent_id) or {}
        conv_id = int(state.get("conv_id", 0))
        object_name = primary_object_name(pr.get("object_name") or state.get("user_input", ""))
        namespace = make_namespace(f"sess_{conv_id}", agent_id, object_name)
        # 本轮各子 Agent 内联写入的产物（execute 阶段累计），artifact 节点需合并引用
        inline_files: List[Dict] = list(state.get("artifacts") or [])

        # 指挥官只负责编排。调度索引是过程数据，不是核心交付物，不落产物库。
        if agent_id == "migration_commander":
            return state

        # 其他 Agent：按 gen_artifact 开关决定是否落盘（直接对话场景，
        # 如用户直接和评估专家对话时由该 Agent 自行写 assessment_report.md）
        if not cfg.get("gen_artifact", False):
            return state
        text = state.get("reply", "")
        # 交付门控：反问/要参数类回复不落盘（与 _call_sub_agent 内联写盘一致）
        sql_blocks = re.findall(r"```sql\s*\n(.*?)\n```", text, re.DOTALL | re.IGNORECASE)
        if not _is_core_delivery(agent_id, text):
            return state
        files: Dict[str, str] = {}
        for idx, block in enumerate(sql_blocks):
            files[f"转换脚本_{object_name}_{idx + 1}.sql" if idx else f"转换脚本_{object_name}.sql"] = block.strip()
        md = re.sub(r"```(sql|markdown|json)?\n.*?\n```", "", text, flags=re.DOTALL | re.IGNORECASE).strip() or text
        # 报告文件名按预置 Agent 产物模板映射（agents.py output_files 中第一个 .md 成员）
        report_name = "generate.md"
        for fname in cfg.get("output_files", []) or []:
            if fname.endswith(".md") and "<" not in fname:
                report_name = fname
                break
        report_name = _core_report_filename(report_name)
        files[report_name] = md
        try:
            _task_state = state.get("task_state") or {}
            res = self.artifacts.write(
                namespace, conv_id, agent_id, object_name, files,
                task_id=_task_state.get("migrate_task_id"),
                trace_id=str(state.get("trace_id", "") or ""))
            self._trace(
                state, "artifact", agent_id,
                "核心产物已写入: " + ", ".join(
                    str(f.get("path", "")) for f in res.get("files", [])),
            )
        except NamespaceError as e:
            state["error"] = str(e)
            return state
        state["namespace"] = namespace
        state["artifacts"] = res["files"]
        return state


def build_graph(llm: Any, rag_search: Callable, prompt_service: PromptService,
                artifact_service: ArtifactService, skill_service: Any,
                parse_schema: Optional[Dict] = None, config: Optional[AppConfig] = None,
                max_iterations: int = 3, agent_service: Optional[AgentService] = None,
                pipeline_service: Optional[PipelineService] = None,
                db_tools: Optional[DbTools] = None, kg=None, ops=None, gov=None,
                rag_enabled: bool = True, datasources_enabled: bool = True,
                migrate_assets: Any = None, migrate_state: Any = None,
                observability: Any = None,
                cancellation_event: Optional[threading.Event] = None):
    rt = GraphRuntime(llm=llm, rag_search=rag_search, prompt_service=prompt_service,
                      artifact_service=artifact_service, skill_service=skill_service,
                      parse_schema=parse_schema, config=config or AppConfig(),
                      max_iterations=max_iterations, agent_service=agent_service,
                      pipeline_service=pipeline_service,
                      db_tools=db_tools, kg=kg, ops=ops, gov=gov,
                      rag_enabled=rag_enabled, datasources_enabled=datasources_enabled,
                      migrate_assets=migrate_assets, migrate_state=migrate_state,
                      observability=observability,
                      cancellation_event=cancellation_event)
    g = StateGraph(AgentState)
    g.add_node("migration_commander", rt.commander)
    g.add_node("migration_collector", rt.migration_collector)
    g.add_node("migration_assessor", rt.migration_assessor)
    g.add_node("migration_planner", rt.migration_planner)
    g.add_node("code_migrator", rt.code_migrator)
    g.add_node("migration_verifier", rt.migration_verifier)
    g.set_entry_point("migration_commander")
    route_map = {agent_id: agent_id for agent_id in STAGE_AGENT_IDS}
    route_map[END] = END
    g.add_conditional_edges("migration_commander", rt.route_agent, route_map)
    stage_map = {agent_id: agent_id for agent_id in STAGE_AGENT_IDS}
    stage_map["migration_commander"] = "migration_commander"
    for agent_id in STAGE_AGENT_IDS:
        g.add_conditional_edges(agent_id, rt.stage_route, stage_map)
    return g.compile()
