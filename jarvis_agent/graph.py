"""LangGraph 主图：parse → route → execute → artifact → reply"""
from __future__ import annotations

import json
import os
import re
import time
import threading
from pathlib import Path
from io import BytesIO
from typing import Any, Callable, Dict, List, Optional

from langgraph.graph import END, StateGraph
from typing_extensions import TypedDict

from jarvis_agent.agents import AgentService, PipelineService
from jarvis_agent.artifacts import (ArtifactService, NamespaceError,
                                    make_namespace, primary_object_name)
from jarvis_agent.config import AppConfig
from jarvis_agent.db_tools import DbTools
from jarvis_agent.prompts import PromptService
from jarvis_agent.state_machine import (DEFAULT_FLOW, STATE_GUIDANCE,
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
    "boot_report.md": "页面展示方案.md",
    "order_report.md": "下单拆单方案.md",
    "accept_report.md": "订单受理方案.md",
    "rule_report.md": "规则配置方案.md",
    "customer_report.md": "客户数据方案.md",
    "change_report.md": "跨工程改动清单.md",
    "generate.md": "智能体报告.md",
    "collected_data.md": "跨工程调研报告.md",
}

_INFORMATIONAL_QUESTION_RE = re.compile(
    r"什么是|是什么|介绍一下|介绍|解释|区别|差异|优缺点|为什么|怎么理解|[吗呢][?？]?"
)
_EXPLICIT_ARTIFACT_RE = re.compile(
    r"(?:生成|输出|整理|导出)[^。\n]{0,20}"
    r"(?:报告|方案|清单|脚本|指南|产物|文件|Excel)"
    r"|产物文件|落盘"
)
_BUSINESS_EXECUTION_RE = re.compile(
    r"(?:请|帮我|为我|麻烦|需要|要求|执行|完成|开始|继续)"
    r"[^。\n]{0,8}(?:页面展示|下单|拆单|订单受理|规则|客户数据|代码改动|小前|小订|小受|小规|小客|编排)"
    r"|^(?:页面展示|下单|拆单|订单受理|规则|客户数据|代码改动|小前|小订|小受|小规|小客|编排)"
    r"|^(?:继续|确认|同意|下一步|下一阶段|开始执行|开始迭代|推进)$"
)
_TASK_DIRECTIVE_RE = re.compile(
    r"继续|确认|同意|下一步|下一阶段|开始执行|开始迭代|就这么办|推进|执行|选择|"
    r"页面展示|下单|拆单|订单受理|规则|客户数据|代码改动|跨工程|迭代|"
    r"布点|前端|工作流|业务场景|受理工程|调度规则|配置分支|取数"
)
_CODE_EXCLUDE_DIRS = {
    ".git", ".svn", ".hg", ".idea", ".vscode", ".venv", "venv",
    "__pycache__", "node_modules", "dist", "build", "target", "vendor",
}
_CODE_TEXT_EXTS = {
    "", ".asm", ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".csv",
    ".ddl", ".env", ".go", ".gradle", ".groovy", ".h", ".hpp", ".htm", ".html",
    ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".less", ".md", ".php",
    ".pl", ".properties", ".py", ".rb", ".rs", ".sass", ".scala", ".scss",
    ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml",
    ".yaml", ".yml",
}
_CODE_QUESTION_RE = re.compile(
    r"代码|组件|类名|接口|方法|流程|字段|配置|报文|服务|工程|模块|逻辑|实现|"
    r"改造|文件|路径|读取|搜索|设计"
)
_CODE_TERM_RE = re.compile(
    r"[A-Za-z][A-Za-z0-9_.-]{2,}"
    r"|手机受理|移动看家|参数转换|参数平装|受理接口|转换组件|平装组件|看家|平装"
)


class ChatRunCancelled(RuntimeError):
    """用户显式中止当前会话执行。"""


def _core_report_filename(configured_name: str) -> str:
    """核心交付物使用中文名；未知业务文件名保持配置不变。"""
    return _CHINESE_ARTIFACT_NAMES.get(configured_name, configured_name)


def _is_core_delivery(agent_id: str, text: str) -> bool:
    """判断 Agent 回复是否为核心交付物；boot工程的结构化调研报告也属于交付物。"""
    stripped = (text or "").strip()
    if not stripped:
        return False
    has_md = any(line.lstrip().startswith("#") for line in stripped.splitlines())
    sql_blocks = re.findall(
        r"```sql\s*\n(.*?)\n```", stripped, re.DOTALL | re.IGNORECASE)
    if agent_id == "family_order_agent" and _is_substantive_change_plan(stripped):
        return True
    if agent_id == "rule_center_agent" and _is_substantive_code_analysis(stripped):
        return True
    if _INTERACTIVE_NON_DELIVERY_RE.search(stripped):
        return False
    if agent_id == "boot_agent" and has_md:
        has_table = any(line.lstrip().startswith("|") for line in stripped.splitlines())
        has_list = any(re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line)
                       for line in stripped.splitlines())
        if has_table or has_list:
            return True
    # 分析型专家（下单拆单/订单受理/客户数据）：结构化分段【…】回复即核心交付物，
    # 无 Markdown 标题也可落盘为报告（与页面展示/规则配置专家的产出判定对齐）。
    if agent_id in ("customer_order_agent", "family_order_agent") \
            and len(stripped) > 120:
        if re.search(r"【[^】]{2,16}】", stripped) \
                and not _NON_DELIVERY_RE.search(stripped):
            return True
    return ((has_md or bool(sql_blocks))
            and not _NON_DELIVERY_RE.search(stripped))


def _is_artifact_request(*texts: Optional[str]) -> bool:
    """直接咨询仅在用户明确要求交付物或业务执行时才落盘。"""
    for text in texts:
        content = text or ""
        if _EXPLICIT_ARTIFACT_RE.search(content):
            return True
        if _INFORMATIONAL_QUESTION_RE.search(content):
            continue
        if _BUSINESS_EXECUTION_RE.search(content):
            return True
    return False


def _is_task_directive(text: Optional[str]) -> bool:
    return _is_artifact_request(text) or bool(_TASK_DIRECTIVE_RE.search(text or ""))


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
_CHANGE_PLAN_TERMS = (
    "实施路径", "改动策略", "分阶段实施", "联调方案", "联调窗口",
    "回滚预案", "风险控制", "改动步骤", "目标架构",
)


def _is_substantive_change_plan(text: str) -> bool:
    """识别完整的跨工程改动方案，避免风险描述中的“待确认”误伤交付判定。"""
    stripped = (text or "").strip()
    if len(stripped) < 100:
        return False
    return sum(term in stripped for term in _CHANGE_PLAN_TERMS) >= 2


_CODE_ANALYSIS_TERMS = (
    "接口", "调用链", "DTO", "字段", "布点", "前端页面", "工作流",
    "调度规则", "配置分支", "取数逻辑",
)


def _is_substantive_code_analysis(text: str) -> bool:
    """识别业务域的结构化代码改动分析，允许末尾存在追加材料的交互提示。"""
    stripped = (text or "").strip()
    if len(stripped) < 120 or "【分析结果】" not in stripped:
        return False
    if not any(marker in stripped for marker in ("【风险】", "【下一步建议】")):
        return False
    return sum(term in stripped for term in _CODE_ANALYSIS_TERMS) >= 2


def _role_boundary_block(agent_id: str) -> str:
    """为被用户显式指派的专项业务域 Agent 注入不可覆盖的职责边界。"""
    if agent_id == "rule_center_agent":
        return (
            "\n\n## 职责边界（最高优先级）\n"
            "你当前是规则中心 Agent（小规），只处理规则中心工程的业务规则与配置相关代码改动。\n"
            "1. 不得代跑其他业务域（boot/客户订单中心/家庭订单中心/客户中心）的职责；"
            "即使用户或历史会话要求/提到这些任务，也不能代跑。\n"
            "2. 当最新需求明确属于其他工程（页面展示/下单拆单/订单受理/客户数据）时，"
            "先说明小规负责规则与配置，再建议切换到对应业务域 Agent。\n"
            "3. 不要把历史会话中的其他工程任务当作当前任务；历史主题与当前职责冲突时，以当前指派为准。\n"
            "4. 只有最新需求包含规则/配置改动信息，或明确让小规继续时，才执行本域代码改动。"
        ) + _rule_center_agent_input_discipline()
    return ""


def _rule_center_agent_input_discipline() -> str:
    return (
        "\n\n## 输入纪律（最高优先级）\n"
        "1. 任务缺少待梳理的业务规则/配置分支（rule_config / config_branch）时，"
        "使用一套清晰标注为“示例规则”的规则中心工程配置样例生成演示改动清单，"
        "并在风险中说明真实改动需替换为业务配置；不得输出能力介绍或材料清单替代交付物。\n"
        "2. 已提供结构化资产时，必须逐项引用规则名与改动点，再给改动建议。\n"
        "3. 不得复述【输出文件】要求；文件由产物系统自动生成。"
    )

PARSE_KEYS = {"intent", "agent_id", "object_name", "source_db",
              "target_db", "skill_id", "params", "confidence"}
CORE_KEYS = {"intent", "agent_id", "confidence"}

JARVIS_AGENT_IDS = (
    "jarvis_commander", "boot_agent", "customer_order_agent",
    "family_order_agent", "rule_center_agent", "customer_center_agent",
)
STAGE_AGENT_IDS = JARVIS_AGENT_IDS[1:]
SYSTEM_NODE_IDS = ("qa", "artifact", "confirm", "error")
ROUTABLE_NODES = ("jarvis_commander", *STAGE_AGENT_IDS, "qa", "artifact", "confirm")
STAGE_AGENT_BY_STATUS = {
    "PAGE_SHOW": "boot_agent",
    "ORDER_SPLIT": "customer_order_agent",
    "ORDER_ACCEPT": "family_order_agent",
    "RULE_CHECK": "rule_center_agent",
    "CUSTOMER_CHECK": "customer_center_agent",
}
_M_EXEC_STATES = ("PAGE_SHOW", "ORDER_SPLIT", "ORDER_ACCEPT",
                  "RULE_CHECK", "CUSTOMER_CHECK", "FINISHED")
_LEGACY_STEP_MAP = {
    "step1": "PAGE_SHOW", "step2": "ORDER_SPLIT",
    "step3": "ORDER_ACCEPT", "complete": "PAGE_SHOW",
    "step2_conflict": "ORDER_SPLIT",
    "INIT": "PAGE_SHOW", "PAGE_SHOW": "PAGE_SHOW",
    "ORDER_SPLIT": "ORDER_SPLIT", "ORDER_ACCEPT": "ORDER_ACCEPT",
    "RULE_CHECK": "RULE_CHECK", "CUSTOMER_CHECK": "CUSTOMER_CHECK",
}

# 全局交互式表单规则：追加到所有 Agent 的 system 提示词（不受 DB 提示词覆盖影响）。
# 模型据此在回复中嵌入 <UI_RENDER>{...}</UI_RENDER>，后端提取后交由前端渲染为可交互表单。
# 注意：若角色提示词自身已约定 UI_RENDER 格式（如 component/param_key 单组件格式），以角色提示词为准。
UI_FORM_RULE = (
    "\n\n## 交互式表单（必须遵守）\n"
    "当需要用户补充或确认关键信息时，必须先在正文中逐项列出待确认字段；"
    "禁止输出「请确认以上信息 / 请完成以上选择」却没有具体字段。\n"
    "有明确候选选项（如选择业务场景、订单来源、受理工程等）时，"
    "必须输出对应选项字段；无候选选项（如说明、改动范围、代码片段）时，必须输出 textarea 字段：\n"
    "<UI_RENDER>\n"
    "{\"title\": \"请选择业务场景\", \"fields\": [{\"name\": \"business_scene\", \"label\": \"业务场景\", "
    "\"type\": \"select\", \"options\": [\"<候选1>\", \"<候选2>\"]}], \"submit\": \"确认选择\"}\n"
    "</UI_RENDER>\n"
    "规则：\n"
    "1. 若角色提示词已约定专属的 UI_RENDER 格式（如 component/options/param_key 单组件格式），"
    "必须按角色提示词的格式输出，本节仅作兜底；\n"
    "2. JSON 必须合法（双引号、无注释、无尾逗号），整个回复中最多一个 UI_RENDER 块；\n"
    "3. 候选 options 可使用系统占位符（如 {{system_space_list}} 表示已启用空间列表，"
    "后端会自动替换为真实名称），或来自上下文中的真实清单，不得编造；\n"
    "4. 无候选清单的自由文本信息（如粘贴代码、说明改动范围）使用 textarea 字段，"
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
    """受理专家产物只保留跨工程改动方案，交互确认内容由前端表单通道处理。"""
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


_CODE_ARTIFACT_REQUEST_RE = re.compile(
    r"(?im)^[ \t]*(?:[-*+]\s*|\d+[.)]\s+)?"
    r"(?:请确认|请提供|请补充|继续提供|若需继续).*$")


def _sanitize_change_artifact(text: str) -> str:
    """业务域改动报告剔除输出要求与追加材料追问。"""
    cleaned = _strip_named_sections(
        _strip_bare_ui_render(text or ""),
        {"输出文件", "输出文件清单"},
    )
    return _CODE_ARTIFACT_REQUEST_RE.sub("", cleaned).strip()


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


_MOCK_CHANGE_ITEMS = [
    (
        "页面-下单入口",
        "前端/布点",
        "新增下单入口按钮与页面跳转，接入订单提交接口，完成布点数据上报。",
    ),
    (
        "接口-下单提交",
        "接口/调用链",
        "下单接口新增参数校验与库存预扣，返回订单号，串联客户订单中心。",
    ),
    (
        "接口-订单查询",
        "接口/调用链",
        "订单查询接口支持状态机流转字段，补充分页与过滤参数。",
    ),
    (
        "调度-拆单规则",
        "规则/调度",
        "按商家、仓库、配送时效、金额阈值配置拆单规则，规则中心下发配置。",
    ),
    (
        "页面-订单受理",
        "前端/布点",
        "新增订单受理工作台页面，展示待受理、异常订单列表并接入受理接口。",
    ),
    (
        "接口-工作流触发",
        "接口/调用链",
        "订单受理后触发工作流，串联审批流与外围系统交互，支持回调。",
    ),
    (
        "接口-客户资料查询",
        "接口/取数",
        "客户资料接口扩展会员等级、账户余额、标签字段，供下单与受理展示。",
    ),
    (
        "规则-业务配置",
        "规则/配置",
        "业务规则开关与配置分支下发到各工程，按生效范围与灰度策略生效。",
    ),
]


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


def _extract_change_items(text: str) -> List[Dict[str, str]]:
    """从业务域报告文本中提取代码改动项（按三级标题或编号小节）。"""
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
        title = re.sub(r"^\d+[.、]\s*", "", heading.group("title").strip())
        items.append({
            "type": f"改动-{title}",
            "detail": _extract_risk_section(section).strip(),
        })
    return items


def _mock_change_plan_reply(state: Dict) -> str:
    params = (state.get("task_state") or {}).get("task_params") or {}
    scene = str(params.get("business_scene") or "跨工程迭代开发").strip() or "跨工程迭代开发"
    return (
        "# 跨工程改动方案（演示假设）\n\n"
        "## 演示输入假设\n\n"
        f"- 业务场景：{scene}\n"
        "- 涉及工程：boot工程 / 客户订单中心 / 家庭订单中心 / 规则中心 / 客户中心\n"
        "- 业务流：页面展示 → 下单拆单 → 订单受理 → 工作流\n\n"
        "## 一、实施路径\n\n"
        "1. 冻结各工程接口契约与配置快照，导出调用链与配置清单。\n"
        "2. boot工程梳理页面展示与布点层，明确前端入口与数据来源接口。\n"
        "3. 客户订单中心梳理下单入口与拆单调度规则，输出下单拆单改动点。\n"
        "4. 家庭订单中心梳理订单受理工程与工作流/外围系统交互，输出受理与工作流改动点。\n"
        "5. 规则中心梳理业务规则与配置分支，客户中心梳理客户数据与取数逻辑。\n"
        "6. 汇总各工程改动清单为跨工程改动包，进入人工确认节点。\n\n"
        "## 二、跨工程改动包\n\n"
        "| 序号 | 工程 | 改动类型 | 改动点 | 备注 |\n"
        "| --- | --- | --- | --- | --- |\n"
        "| 1 | boot工程 | 前端/布点 | 新增下单入口与数据展示 | 需后端接口配合 |\n"
        "| 2 | 客户订单中心 | 下单拆单 | 拆单调度规则调整 | 涉及调度逻辑 |\n"
        "| 3 | 家庭订单中心 | 订单受理 | 受理工作流新增环节 | 涉及外围系统 |\n"
        "| 4 | 规则中心 | 规则配置 | 业务规则开关与分支 | 配置分支选择 |\n"
        "| 5 | 客户中心 | 客户数据 | 客户资料字段扩展 | 涉及取数逻辑 |\n\n"
        "## 三、风险控制\n\n"
        "- 每个工程改动保留改动点清单与调用链，便于审计和联调。\n"
        "- 跨工程接口契约变更需在联调窗口内完成回归。\n"
        "- 配置分支生效范围与灰度策略需人工复核。\n\n"
        "## 四、回滚预案\n\n"
        "- 各工程配置与代码保持可回退版本，配置快照在观察期内不做变更。\n"
        "- 若联调失败，回退对应工程的改动点并重放失败前检查点。\n\n"
        "## 五、验收与联调口径\n\n"
        "- 页面验收：前端入口与数据展示符合业务场景。\n"
        "- 接口验收：下单拆单、订单受理、工作流调用链全部打通。\n"
        "- 规则与数据验收：配置分支生效、客户数据口径一致。\n"
    )


def _mock_change_reply(state: Dict) -> str:
    params = (state.get("task_state") or {}).get("task_params") or {}
    scene = str(params.get("business_scene") or "跨工程迭代开发").strip() or "跨工程迭代开发"
    parts = [
        "# 跨工程代码改动清单（示例）\n\n",
        f"## 演示范围\n\n- 业务场景：{scene}\n\n",
    ]
    for idx, (title, etype, detail) in enumerate(_MOCK_CHANGE_ITEMS, 1):
        parts.extend([
            f"### {idx}. {title}\n\n",
            f"- 改动类型：{etype}\n",
            f"- 改动点：{detail}\n\n",
        ])
    parts.extend([
        "## 风险说明\n\n",
        "- 本清单使用示例数据：真实改动前必须替换为业务代码与接口契约。\n",
        "- 接口、调用链、字段与配置分支需结合各工程实际代码复核。\n",
        "- 示例仅做结构模拟，不连接业务库执行真实变更。\n",
    ])
    return "".join(parts)


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
    text = re.sub(r"<think>[\s\S]*?</think>\s*", "", text, flags=re.IGNORECASE)
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
    generic_executed: bool  # 总控内复用执行的普通问答智能体标记
    control_target: str  # 图内控制出口：artifact / confirm / error / END
    retry_target: str  # error 节点重试时返回的节点
    error_source: str  # 首次发生异常的节点名
    error_message: str  # 面向状态与日志的异常描述
    retry_count: int  # 当前节点已重试次数
    confirm_decision: str  # wait_user / stay / next / back / finish / error


def _default_parse_schema_prompt(intents: List[str], ags: Dict[str, Dict]) -> str:
    agent_lines = "\n".join(f"- {i}: {v['intent']}" for i, v in ags.items())
    return f"""你是需求解析器。把用户需求解析为 JSON，字段如下：
- intent: 必须是以下之一 {intents}
- agent_id: 必须是 {list(ags)} 之一（对应意图）
- object_name: 用户提到的业务对象/工程名（前端页面/接口/配置分支等），没有则给空字符串
- source_db / target_db: 保留字段，跨工程迭代平台不涉及数据库对象，统一给空字符串
- skill_id: 用户 @ 的技能 id，没有给空字符串
- params: {{}} 空对象
- confidence: 0~1 的数值
如果用户只是闲聊、问候或提问通用知识（例如“你是谁”“系统能做哪些跨工程开发”），
不要伪造业务编排意图；返回 intent/agent_id 为空字符串、confidence 为 0。
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
                 rag_enabled: bool = True, datasources_enabled: bool = True,
                 jarvis_state: Any = None,
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
        # 状态机服务（跨工程迭代状态机 JarvisStateService）
        self.jarvis_state = jarvis_state
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
               level: str = "info", duration_ms: int | None = None,
               agent_id: str = "") -> None:
        if self.observability is None:
            return
        try:
            self.observability.log(
                trace_id=str(state.get("trace_id", "") or ""),
                phase=phase, span=span, level=level, message=message,
                agent_id=agent_id,
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
                # 需求解析是内部调用；断开父图 messages 流，思考/JSON token 不进聊天框。
                config={"callbacks": []},
            )
            self._trace(state, "llm", "parse", "需求解析完成",
                        duration_ms=int((time.monotonic() - _started) * 1000))
            # 从 markdown 代码块中提取 JSON（LLM 常返回 ```json { ... } ``` 格式）
            raw = resp.content if hasattr(resp, "content") else str(resp)
            raw = _extract_json_from_markdown(raw)
            try:
                result = json.loads(raw)
            except (json.JSONDecodeError, AttributeError):
                # 解析器输出纯思考或截断时走低置信度兜底，不能把内部推理当作错误回复。
                result = {"intent": "", "agent_id": "", "confidence": 0.0}
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
        configured_prompt = target[-1]["content"] if target else agent_cfg.get("default_prompt", "")
        state["prompt_text"] = configured_prompt or self._agent_base_prompt(agent_cfg)
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
        # 工程目录：智能体负责的工程代码根目录（库表配置化），注入提示上下文
        _project_dir = str(agent_cfg.get("project_dir") or "").strip()
        if _project_dir:
            state["prompt_text"] = (state.get("prompt_text") or "").rstrip() + \
                f"\n\n工程目录：{_project_dir}"
            state["prompt_text"] += self._project_tool_discipline(_project_dir)
        # RAG 注入：智能体知识库授权是唯一检索范围，未授权时禁止回退会话空间。
        q = state.get("user_input", "")
        kb_types = None
        src_db = tgt_db = ""
        _ts_now = state.get("task_state") or {}
        if state.get("agent_id") == "jarvis_commander" and _ts_now:
            _step = str(_ts_now.get("current_step") or "").split("|")[0]
            if _step in STAGE_KB_TYPES:
                kb_types = STAGE_KB_TYPES[_step]
            _tp = _ts_now.get("task_params") or {}
            src_db = ""
            tgt_db = ""
        try:
            _kb_spaces = self._kb_ids(str(state.get("agent_id") or ""))
            state["rag_context"] = (
                self.rag_search(q, top_k=self.config.rag_top_k,
                                space_id=None,
                                kb_ids=_kb_spaces,
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
        raw = str(task_state.get("current_step") or "PAGE_SHOW").split("|")[0]
        return _LEGACY_STEP_MAP.get(raw, raw)

    def _kb_ids(self, agent_id: str) -> Optional[List[int]]:
        """智能体绑定的知识库 id（bound_kbs → kbs.id）；
        None 表示未绑定（检索全部知识库），非空列表表示绑定了指定知识库。"""
        if not agent_id or self.agent_svc is None:
            return None
        try:
            ids = self.agent_svc.kb_ids(agent_id)
            return ids if ids else None
        except Exception:
            return None

    def _flow_nodes(self) -> List[Dict]:
        if self.jarvis_state is not None and hasattr(self.jarvis_state, "get_flow"):
            try:
                flow = self.jarvis_state.get_flow()
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
        iter_task = bool(task_state is not None and (
            task_state.get("migrate_task_id") or task_state.get("current_step")))

        if (iter_task and selected == "jarvis_commander"
                and _is_task_directive(state.get("user_input"))):
            selected = STAGE_AGENT_BY_STATUS.get(self._normalized_stage(state), selected)

        state["agent_id"] = selected
        if selected in STAGE_AGENT_IDS:
            if explicit_agent_id == selected:
                # 用户显式指派：单智能体直接执行，不走状态机推进/逐级确认
                state.setdefault("task_state", {})["direct_assignment"] = True
            self.route(state)
            state["graph_route_target"] = selected
            return state

        self.route(state)
        # 普通问答智能体统一进入 qa 系统节点；总控只做解析、路由和上下文准备。
        state["graph_route_target"] = "qa"
        return state

    def route_agent(self, state: Dict) -> str:
        """条件边 A：显式指派校验 + current_step 阶段映射。"""
        if state.get("control_target") == "error":
            return "error"
        if state.get("graph_phase") == "converge":
            return END
        if state.get("graph_route_target"):
            return state["graph_route_target"]

        explicit = str(state.get("assigned_agent_id") or state.get("agent_id") or "")
        task_state = state.get("task_state")
        stage = self._normalized_stage(state)
        expected = STAGE_AGENT_BY_STATUS.get(stage)

        if explicit in STAGE_AGENT_IDS:
            return explicit

        pr = state.get("parse_result") or {}
        if explicit != "jarvis_commander" and float(pr.get("confidence", 0.0) or 0.0) < 0.5:
            return "jarvis_commander"
        if explicit == "jarvis_commander":
            return expected or END
        return END

    def _should_write_delivery(self, state: Dict) -> bool:
        """普通问答智能体是否需要交给 artifact 节点统一判定落盘。"""
        agent_id = str(state.get("agent_id") or "")
        cfg = self.agent_svc.get(agent_id) or {}
        return bool(
            self.artifacts is not None
            and cfg.get("gen_artifact", False)
            and _is_artifact_request(state.get("user_input"))
        )

    def qa_node(self, state: AgentState) -> AgentState:
        """普通问答与非迁移业务智能体的统一执行节点。"""
        state["graph_phase"] = "generic"
        self.route(state)
        self._emit({"type": "route_preflight", "agent_id": state.get("agent_id", "")})
        self.execute(state)
        state["generic_executed"] = True
        state["graph_phase"] = "converge"
        state["control_target"] = (
            "artifact" if self._should_write_delivery(state) else END)
        return state

    def qa_route(self, state: Dict) -> str:
        if state.get("control_target") == "error":
            return "error"
        return "artifact" if state.get("control_target") == "artifact" else END

    def artifact_node(self, state: AgentState) -> AgentState:
        """统一产物出口：阶段产物可能已内联落盘，此处只做去重判定和补写。"""
        self.artifact(state)
        if state.get("error"):
            state["control_target"] = "error"
            state["error_source"] = "artifact"
            state["error_message"] = str(state["error"])
            return state
        state["control_target"] = "confirm"
        return state

    def artifact_route(self, state: Dict) -> str:
        if state.get("control_target") == "error":
            return "error"
        task_state = state.get("task_state") or {}
        if task_state.get("direct_assignment"):
            return END
        is_iter = bool(task_state is not None and (
            task_state.get("migrate_task_id") or task_state.get("current_step")))
        return "confirm" if is_iter else END

    def confirm_node(self, state: AgentState) -> AgentState:
        """统一确认/推进出口；除 ERROR 外不直接写任务状态。"""
        task_state = state.setdefault("task_state", {})
        if task_state.get("direct_assignment"):
            state["confirm_decision"] = "finish"
            state["control_target"] = END
            return state
        if not (task_state.get("migrate_task_id") or task_state.get("current_step")):
            state["confirm_decision"] = "finish"
            state["control_target"] = END
            return state

        decision = self.should_advance(state)
        state["confirm_decision"] = decision
        stage = self._normalized_stage(state)
        if decision in ("stay", "wait_user"):
            task_state["step_status"] = "waiting_confirm"
            task_state["awaiting_confirmation"] = True
            state["reply"] = state.get("reply") or (
                f"{status_label(stage)}已完成，请确认后继续。")
        elif decision == "back":
            task_state["step_status"] = "rollback_pending"
            task_state["awaiting_confirmation"] = True
        elif decision == "next":
            next_stage = self._next_stage_status(state)
            state["graph_next_step"] = next_stage
            task_state["awaiting_confirmation"] = False
            params = task_state.setdefault("task_params", {})
            if isinstance(params, dict):
                params.pop("task_confirm", None)
            if next_stage not in STAGE_AGENT_BY_STATUS:
                state["confirm_decision"] = "finish"
        state["control_target"] = "confirm"
        return state

    def confirm_route(self, state: Dict) -> str:
        if state.get("control_target") == "error":
            return "error"
        decision = state.get("confirm_decision") or self.should_advance(state)
        if decision == "back":
            target = (state.get("task_state") or {}).get("rollback_target")
            return STAGE_AGENT_BY_STATUS.get(target, "jarvis_commander")
        if decision == "next":
            next_stage = state.get("graph_next_step") or self._next_stage_status(state)
            return STAGE_AGENT_BY_STATUS.get(next_stage, "jarvis_commander")
        return END

    def _safe_node(self, name: str, fn: Callable[[AgentState], AgentState]):
        """节点异常统一标记到状态；是否重试由 error 节点决定。"""
        def run(state: AgentState) -> AgentState:
            retrying = state.get("retry_target") == name
            try:
                result = fn(state)
                if retrying:
                    result.pop("control_target", None)
                    result.pop("confirm_decision", None)
                    result.pop("error_source", None)
                    result.pop("error_message", None)
                return result
            except ChatRunCancelled:
                raise
            except Exception as exc:
                if retrying:
                    state["retry_count"] = int(state.get("retry_count") or 0) + 1
                else:
                    state["retry_target"] = name
                    state["retry_count"] = 0
                state["error_source"] = name
                state["error_message"] = str(exc)
                state["confirm_decision"] = "error"
                state["control_target"] = "error"
                self._trace(state, "node", name, str(exc), level="error")
                return state
        return run

    def error_node(self, state: AgentState) -> AgentState:
        """唯一异常出口：最多重试一次，重试仍失败则写 ERROR。"""
        source = state.get("retry_target") or state.get("error_source") or ""
        retry_count = int(state.get("retry_count") or 0)
        message = state.get("error_message") or "节点执行失败"
        if retry_count < 1 and source in ROUTABLE_NODES:
            state["control_target"] = source
            return state

        task_state = state.get("task_state") or {}
        task_id = task_state.get("migrate_task_id")
        if task_id and self.jarvis_state is not None:
            try:
                self.jarvis_state.set_error(int(task_id), message)
            except Exception:
                pass
        state["reply"] = f"执行失败：{message}"
        state["confirm_decision"] = "error"
        state["control_target"] = END
        return state

    def error_route(self, state: Dict) -> str:
        target = state.get("control_target")
        if target in ROUTABLE_NODES:
            return target
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
            return "jarvis_commander"
        next_stage = state.get("graph_next_step") or self._next_stage_status(state)
        return STAGE_AGENT_BY_STATUS.get(next_stage, "jarvis_commander")

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
        params = state.setdefault("task_state", {}).setdefault("task_params", {})
        # task_confirm 是进入当前阶段的一次性闸门令牌，不能在产物生成后再次放行。
        params.pop("task_confirm", None)
        sub = self._call_sub_agent(agent_id, self._stage_question(state), state=state)
        self._check_cancelled()
        self._emit_sub_agent(
            {**state, "agent_id": "jarvis_commander"}, agent_id, sub)
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
            ts["step_status"] = "rollback_pending" if agent_id == "customer_center_agent" else "running"
            ts["rollback_target"] = flow_nodes[max(0, current_idx - 1)]["status"]
        else:
            ts["step_status"] = "done" if sub.get("artifacts") else "running"
        ts["awaiting_confirmation"] = False
        # 阶段推进交给 confirm 系统节点；专家节点只负责执行与失败标记。
        # verification_failed 保留给 confirm 的 back 分支，不算节点异常。
        if bool(sub.get("error")) and not bool(ts.get("verification_failed")):
            state["control_target"] = "error"
            state["error_source"] = agent_id
            state["error_message"] = str(sub.get("error"))
            state["confirm_decision"] = "error"
        else:
            state["control_target"] = "artifact"
        self._trace(
            state, "node", agent_id,
            "阶段智能体执行完成" if not failed else "阶段智能体执行失败",
            level="info" if not failed else "error",
            duration_ms=int((time.monotonic() - _started) * 1000),
        )
        return state

    def boot_agent(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "boot_agent")

    def customer_order_agent(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "customer_order_agent")

    def family_order_agent(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "family_order_agent")

    def rule_center_agent(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "rule_center_agent")

    def customer_center_agent(self, state: AgentState) -> AgentState:
        return self._run_stage_agent(state, "customer_center_agent")

    def stage_route(self, state: Dict) -> str:
        if state.get("control_target") == "error":
            return "error"
        return "artifact"

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

    @staticmethod
    def _agent_base_prompt(cfg: Dict) -> str:
        """空提示词的轻量角色说明：不阻断调用，仅让模型知道职责边界。"""
        name = cfg.get("alias") or cfg.get("name") or cfg.get("id") or "智能体"
        description = str(cfg.get("description") or "").strip()
        if description:
            return (f"你是{name}。职责：{description}。"
                    "请基于用户问题、知识库检索结果和工具输出回答；没有依据时明确说明，不要编造。")
        return f"你是{name}。请基于用户问题和工具输出完成任务；没有依据时明确说明，不要编造。"

    @staticmethod
    def _project_tool_discipline(project_dir: str) -> str:
        """工程目录存在时，强制模型用只读工具验证代码结论。"""
        return (
            "\n\n## 工程代码工具使用规则（最高优先级）\n"
            f"当前智能体绑定的工程目录：{project_dir}。\n"
            "只要问题涉及代码定位、类名、组件、方法、接口、流程、字段、配置或改动方案，"
            "必须先调用 code_search 检索工程，再用 code_read 阅读命中的文件；"
            "不能只凭业务语义、命名习惯或记忆推断类名、文件路径和内部逻辑。\n"
            "知识库结果只能作为背景线索；工程代码结论必须以 code_read 返回的内容为准。"
            "如果检索无命中，明确说明无命中，不要编造文件。"
        )

    @staticmethod
    def _is_code_question(question: str) -> bool:
        return bool(_CODE_QUESTION_RE.search(str(question or "")))

    @staticmethod
    def _code_question_terms(question: str) -> List[str]:
        """从中文需求中提取稳定的代码检索词；优先业务短语，其次英文标识符。"""
        value = str(question or "")
        terms: List[str] = []
        for match in _CODE_TERM_RE.finditer(value):
            term = match.group(0).strip()
            if len(term) >= 2 and term.lower() not in {t.lower() for t in terms}:
                terms.append(term)
        return terms[:3]

    @staticmethod
    def _code_match_rank(match: Dict, terms: List[str]) -> tuple:
        path = str(match.get("path", "")).lower()
        preview = str(match.get("preview", "")).lower()
        terms_hit = sum(1 for term in terms
                        if term.lower() in path or term.lower() in preview)
        score = sum(path.count(term.lower()) + preview.count(term.lower())
                    for term in terms)
        filename_score = sum(2 for term in terms
                             if term.lower() in path.rsplit("/", 1)[-1])
        return (-terms_hit, -(score + filename_score), path.count("/"),
                str(match.get("path", "")))

    def _code_presearch_context(self, agent_id: str, question: str,
                                state: Optional[Dict] = None) -> str:
        """在模型自主调用工具前，先注入一次受限工程检索结果。

        GLM 对“必须先调用工具”的指令并不总稳定；这里把代码证据变成上下文的
        确定性行为，避免自然语言咨询退化为业务命名推断。
        """
        if not self._is_code_question(question):
            return ""
        terms = self._code_question_terms(question)
        if not terms:
            return ""

        matches: Dict[str, Dict] = {}
        searched: List[str] = []
        for term in terms:
            result = self._code_search(agent_id, term, top_k=8)
            searched.append(term)
            if not result.get("ok"):
                continue
            for row in result.get("matches", []):
                path = str(row.get("path", ""))
                if not path:
                    continue
                current = matches.setdefault(path, {
                    "path": path, "line": row.get("line", 0),
                    "preview": row.get("preview", ""), "terms": [],
                })
                if term not in current["terms"]:
                    current["terms"].append(term)

        lines = [f"搜索词：{'、'.join(searched)}"]
        if not matches:
            self._trace(state or {}, "code", "code_presearch",
                        f"自动预检索无命中: {searched}",
                        agent_id=agent_id)
            lines.append("未命中工程文件。回答时必须说明工程内未检索到依据，不得推断类名或路径。")
            return "\n\n## 工程代码预检索结果（已强制执行）\n" + "\n".join(lines)

        term_list = [term.lower() for term in terms]
        ordered = sorted(matches.values(),
                         key=lambda row: self._code_match_rank(row, term_list))
        lines.append("命中文件：")
        for row in ordered[:5]:
            lines.append(
                f"- `{row['path']}:{row.get('line', 0)}` {row.get('preview', '')}"
            )

        read = self._code_read(agent_id, ordered[0]["path"])
        if read.get("ok"):
            self._trace(state or {}, "code", "code_presearch_read",
                        f"自动读取工程文件: {read.get('path', '')}",
                        agent_id=agent_id)
            lines.append(
                f"\n已读取 `{read['path']}` 的真实内容（truncated={read.get('truncated', False)}）：\n"
                f"```\n{read['content']}\n```"
            )
            lines.append(
                "请优先基于以上真实代码回答；内容不足时继续调用 code_search / code_read。"
            )
        else:
            lines.append(f"自动读取失败：{read.get('error', '')}")
        self._trace(state or {}, "code", "code_presearch",
                    f"自动预检索: {searched}，命中 {len(matches)} 个文件",
                    agent_id=agent_id)
        return "\n\n## 工程代码预检索结果（已强制执行）\n" + "\n".join(lines)

    def _project_root(self, agent_id: str) -> Optional[Path]:
        """取当前智能体配置的工程目录；不存在或不是目录时返回 None。"""
        cfg = self.agent_svc.get(agent_id) if agent_id and self.agent_svc else None
        raw = str(cfg.get("project_dir") or "").strip() if cfg else ""
        if not raw:
            return None
        root = Path(raw).expanduser()
        root = root.resolve() if root.is_absolute() else (Path.cwd() / root).resolve()
        return root if root.is_dir() else None

    @staticmethod
    def _is_text_code_file(path: Path) -> bool:
        return path.suffix.lower() in _CODE_TEXT_EXTS

    def _iter_code_files(self, root: Path, limit: int = 5000):
        count = 0
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            rel_dir = Path(dirpath).relative_to(root)
            dirnames[:] = sorted(d for d in dirnames if d not in _CODE_EXCLUDE_DIRS)
            for filename in sorted(filenames):
                path = Path(dirpath) / filename
                if not self._is_text_code_file(path) or path.is_symlink():
                    continue
                try:
                    if path.stat().st_size > 1024 * 1024:
                        continue
                    yield path, path.relative_to(root).as_posix()
                except OSError:
                    continue
                count += 1
                if count >= limit:
                    return

    def _code_search(self, agent_id: str, query: str, top_k: int = 20) -> Dict:
        root = self._project_root(agent_id)
        if root is None:
            return {"ok": False, "error": "当前智能体未配置有效的工程目录"}
        terms = [s.strip().lower() for s in str(query or "").split() if s.strip()]
        if not terms:
            return {"ok": False, "error": "query 不能为空"}
        matches: List[Dict] = []
        truncated = False
        for path, rel_path in self._iter_code_files(root):
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for line_no, line in enumerate(text.splitlines(), 1):
                low = line.lower()
                if all(term in low for term in terms):
                    matches.append({
                        "path": rel_path,
                        "line": line_no,
                        "preview": line.strip()[:300],
                    })
                    if len(matches) >= max(1, min(int(top_k or 20), 50)):
                        truncated = True
                        break
            if truncated:
                break
        return {
            "ok": True,
            "project_dir": str(root),
            "query": query,
            "matches": matches,
            "truncated": truncated,
            "hint": "先 code_search 找到相对路径，再用 code_read 读取文件",
        }

    def _code_read(self, agent_id: str, relative_path: str) -> Dict:
        root = self._project_root(agent_id)
        if root is None:
            return {"ok": False, "error": "当前智能体未配置有效的工程目录"}
        raw = str(relative_path or "").strip().lstrip("/")
        if not raw:
            return {"ok": False, "error": "path 不能为空"}
        candidate = (root / raw).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return {"ok": False, "error": "path 必须位于当前智能体的工程目录内"}
        if not candidate.is_file():
            return {"ok": False, "error": f"文件不存在: {raw}"}
        if not self._is_text_code_file(candidate):
            return {"ok": False, "error": "仅支持读取文本/代码文件"}
        try:
            content = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return {"ok": False, "error": f"读取失败: {exc}"}
        max_chars = 20000
        truncated = len(content) > max_chars
        return {
            "ok": True,
            "path": candidate.relative_to(root).as_posix(),
            "content": content[:max_chars],
            "truncated": truncated,
        }

    def _stage_allowed_agents(self, state: Dict) -> Optional[set]:
        """逐级确认模式下，返回当前跨工程阶段允许调度的子 Agent。"""
        if state.get("agent_id") != "jarvis_commander":
            return None
        task_state = state.get("task_state") or {}
        if not bool(task_state.get("strict_flow", True)):
            return None
        if not bool(task_state.get("step_confirm", True)):
            return None
        stage = str(task_state.get("current_step") or "").split("|")[0]
        return {
            "PAGE_SHOW": {"boot_agent"},
            "ORDER_SPLIT": {"customer_order_agent"},
            "ORDER_ACCEPT": {"family_order_agent"},
            "RULE_CHECK": {"rule_center_agent"},
            "CUSTOMER_CHECK": {"customer_center_agent"},
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
        （子 Agent 不经过 artifact 节点），并返回写入的文件清单——这样每个业务域 Agent
        的报告按产出者入库（boot_report.md / order_report.md 等），不再挂指挥官名下。
        """
        cfg = self.agent_svc.get(agent_id)
        if not cfg:
            return {"ok": False, "error": f"Agent {agent_id} 不存在"}
        if not cfg.get("enabled", True):
            return {"ok": False, "error": f"Agent {agent_id} 已停用"}
        system = (cfg.get("default_prompt") or "").strip() or self._agent_base_prompt(cfg)
        _project_dir = str(cfg.get("project_dir") or "").strip()
        if _project_dir:
            system += f"\n\n工程目录：{_project_dir}"
            system += self._project_tool_discipline(_project_dir)
        if agent_id == "rule_center_agent":
            system += _rule_center_agent_input_discipline()
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
        messages = [SystemMessage(content=system + UI_FORM_RULE)]
        code_context = self._code_presearch_context(
            agent_id, question, state=state,
        )
        if code_context:
            messages.append(SystemMessage(content=code_context))
        # 子 Agent 同样注入历史上下文（最近 10 轮），否则二次提问丢失上下文
        for h in (state or {}).get("history", [])[-10:]:
            if h.get("role") == "user":
                messages.append(HumanMessage(content=h.get("content", "")))
            elif h.get("role") == "assistant":
                messages.append(AIMessage(
                    content=_strip_control_blocks(_strip_leading_parse_json(h.get("content", "")))))
        messages.append(HumanMessage(content=question))
        chunks, iterations = [], 0
        _started = time.monotonic()
        while iterations < self.max_iterations:
            self._check_cancelled()
            iterations += 1
            llm = self.llm
            if hasattr(llm, "bind_tools"):
                try:
                    llm = llm.bind_tools(self._tool_schemas(
                        include_agents=False, current_agent_id=agent_id))
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
                out = self._dispatch_tool(name, args, state=state,
                                          current_agent_id=agent_id)
                messages.append(ToolMessage(content=out, tool_call_id=tc.get("id", ""), name=name))
        full_reply = "\n".join(chunks) or "（该 Agent 未给出回答）"
        self._check_cancelled()
        ui_render = _extract_ui_render(full_reply)
        full_reply = _strip_control_blocks(full_reply)
        full_reply = _strip_bare_ui_render(full_reply)
        if agent_id == "customer_order_agent":
            full_reply = _sanitize_change_artifact(full_reply)
        if agent_id == "family_order_agent":
            full_reply = _sanitize_plan_artifact(full_reply)
            if (str((state.get("task_state") or {}).get("current_step") or "")
                    == "ORDER_ACCEPT"
                    and (_EXPLICIT_ARTIFACT_RE.search(str(state.get("user_input") or ""))
                         or str(state.get("user_input") or "").strip() in ("开始执行", "开始迭代"))
                    and not _is_core_delivery(agent_id, full_reply)):
                full_reply = _mock_change_plan_reply(state)
        if agent_id == "rule_center_agent":
            full_reply = _sanitize_change_artifact(full_reply)
            if (str((state.get("task_state") or {}).get("current_step") or "") == "RULE_CHECK"
                    and not _is_core_delivery(agent_id, full_reply)):
                full_reply = _mock_change_reply(state)
        reply = full_reply
        produced: List[Dict] = []
        # 子 Agent 自行入库：只有业务交付物才落盘。Markdown 标题代表报告。
        if (cfg.get("gen_artifact", False) and self.artifacts is not None
                and state is not None
                and _is_artifact_request(question, state.get("user_input"))):
            stripped = full_reply.strip()
            if _is_core_delivery(agent_id, stripped):
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
                if agent_id == "rule_center_agent":
                    report_name = "跨工程代码改动清单.md"
                files: Dict[str, Any] = {report_name: stripped}
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

    def _dispatch_tool(self, name: str, args: Dict, state: Optional[Dict],
                       current_agent_id: str = "") -> str:
        """工具分发：返回工具结果 JSON 字符串（供主图与子 Agent 共用）"""
        user_input = state.get("user_input", "") if state else ""
        agent_for_tools = current_agent_id or str(state.get("agent_id") or "") if state else current_agent_id
        if name == "code_search":
            result = self._code_search(
                agent_for_tools, str(args.get("query", "")),
                top_k=int(args.get("top_k", 20) or 20))
            self._trace(state or {}, "code", name,
                        f"搜索工程代码: {args.get('query', '')}"
                        f"（命中 {len(result.get('matches', []))} 个文件）",
                        agent_id=agent_for_tools)
            return json.dumps(result, ensure_ascii=False)
        if name == "code_read":
            self._trace(state or {}, "code", name,
                        f"读取工程文件: {args.get('path', '')}",
                        agent_id=agent_for_tools)
            return json.dumps(self._code_read(
                agent_for_tools, str(args.get("path", ""))), ensure_ascii=False)
        if name == "rag_search" and self.rag_search and self.rag_enabled:
            _kb_spaces = self._kb_ids(str(state.get("agent_id") or "") if state else "")
            result = self.rag_search(args.get("query", user_input),
                                     top_k=args.get("top_k", 3),
                                     space_id=None if _kb_spaces
                                     else (state.get("space_id") if state else None),
                                     kb_ids=_kb_spaces or None)
            result_count = len(result) if isinstance(result, list) else 0
            self._trace(state or {}, "rag", name,
                        f"知识库检索: {args.get('query', user_input)}"
                        f"（命中 {result_count} 条）",
                        agent_id=agent_for_tools)
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
        # 仅当用户本轮输入为跨工程/任务指令时才注入任务状态并引导推进；非任务指令（你是谁/闲聊）
        # 不注入，避免指挥官凭空汇报"已收集基础信息"或主动推进（任务参数是历史断点续跑数据，非本轮采集）。
        _task_directive = _is_task_directive(state.get("user_input"))
        if state.get("agent_id") == "jarvis_commander" and state.get("task_state") is not None \
                and _task_directive:
            ts = state["task_state"] or {}
            ts_step_raw = str(ts.get("current_step") or "PAGE_SHOW").split("|")[0]
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
                    "2. 所选业务场景与关键参数已由后端记录（business_scene 一旦赋值不再询问），禁止重复弹出业务场景选择表单；\n"
                    "3. 状态跳转由后端状态机控制，你无权跳转节点，只能推进当前阶段："
                    "基础信息阶段收集参数、执行阶段依次编排对应子 Agent；\n"
                    "4. 需要用户补充当前阶段所需信息时，按当前动作指引输出交互式表单（UI_RENDER）；\n"
                    "5. 若本条回复完成了当前阶段的素材产出（如页面改动清单、接口改动点），"
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

        # ---- 代码级跨工程编排流水线（编排确定性保障） ----
        # 任务确认后（app.py 写入 pipeline_start=True），由后端注入强制调度计划，
        # 不再依赖指挥官模型自主决定「调几个子 Agent、调哪几个」。
        # 后续轮用户说「继续/接着/下一步」时同样激活，补齐剩余步骤。
        pipeline_active = False
        pipeline_block = ""
        if state.get("agent_id") == "jarvis_commander":
            _ts0 = state.get("task_state") or {}
            _step0 = _LEGACY_STEP_MAP.get(
                str(_ts0.get("current_step") or "").split("|")[0],
                str(_ts0.get("current_step") or "").split("|")[0])
            _continue = bool(re.search(r"继续|接着|下一步|开始执行|开始迭代", state.get("user_input", "")))
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
                    "\n\n## 当前跨工程阶段（逐级确认模式，后端已开启）\n"
                    f"你正处于「{status_label(_step0)}」阶段。\n"
                    "必须严格遵守：\n"
                    "1. 本轮只执行当前阶段对应的动作（按上方「当前动作指引」调用当前阶段的子 Agent / 产出当前阶段改动清单）；\n"
                    "2. 完成后立即停驻：向用户展示本阶段产物摘要，并明确请求用户确认（回复「继续 / 确认」）；\n"
                    "3. 在获得用户确认前，禁止编排下一个阶段的子 Agent，禁止输出后续阶段的结论或报告内容；\n"
                    "4. 用户确认后由后端自动推进到下一阶段，你无需也不得自行跳转。")
            else:
                plan_lines = "\n".join(
                    f"{i}. {p['agent_id']}（{p['label']}）：{p['desc']}"
                    for i, p in enumerate(self.pipeline.steps("jarvis_iter"), 1))
                pipeline_block = (
                    "\n\n## 强制调度计划（后端代码注入，必须完整执行）\n"
                    "用户已确认跨工程迭代任务。你必须按以下顺序编排子 Agent，把已采集参数（业务场景/订单来源等）"
                    "写入每个委派问题中：\n" + plan_lines +
                    "\n执行规则（必须严格遵守）：\n"
                    "1. 每个步骤必须真正发起工具调用：串行用 call_agent；互相独立的步骤"
                    "（boot_agent 与 customer_order_agent）优先用 call_agents_parallel 一次并行委派；\n"
                    "2. customer_center_agent 必须在其余步骤全部返回后最后调用；\n"
                    "3. 全部步骤完成前禁止输出面向用户的最终总结；\n"
                    "4. 全部完成后输出简要总结（禁止重复子 Agent 回答内容）。")

        # 非任务指令（你是谁/问候/闲聊/普通问答）：覆盖跨工程引导，指示纯回答，
        # 避免模型主动引导跨工程流程、列举工程或复读已输出内容。
        non_task_block = ""
        if state.get("agent_id") == "jarvis_commander" and not _task_directive:
            non_task_block = (
                "\n\n## 当前对话不是跨工程任务指令\n"
                "用户本轮输入未包含跨工程/任务推进意图（如自我介绍、问候、闲聊、普通问答）。请严格遵守：\n"
                "1. 直接针对用户的问题简洁回答，不要主动引导/启动跨工程流程；\n"
                "2. 不要主动列举可用工程、不要追问跨工程需求、不要重复能力介绍；\n"
                "3. 严禁复述或重复任何已输出的内容，同一内容只输出一次。")

        system = (state.get("prompt_text") + _role_boundary_block(state.get("agent_id", "")) +
                  "\n业务场景: " + (state["parse_result"].get("business_scene") or "") +
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
                    # 硬闸门：指挥官仅在状态机执行阶段（页面展示/下单拆单/订单受理/规则配置/客户数据）
                    # 才暴露 call_agent 工具；采集阶段（INIT/选源/基础信息）不暴露，
                    # 从工具层保证「后端状态机未放行前不调用子 Agent」
                    allow_agents = True
                    if state.get("agent_id") == "jarvis_commander":
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
                    pending = [p for p in self.pipeline.steps("jarvis_iter") if p["agent_id"] not in called_ids]
                    if pending:
                        plan_nudges += 1
                        remain = "、".join(p["agent_id"] for p in pending)
                        messages.append(AIMessage(content=text))
                        messages.append(HumanMessage(content=(
                            "（系统提醒，用户不可见）强制调度计划尚未完成：还未调用 "
                            f"{remain}。请继续按计划顺序通过 call_agent / call_agents_parallel "
                            "工具真正调用剩余子 Agent（customer_center_agent 最后调用），"
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
                    # 并行编排：互相独立的子任务（如 boot工程 ∥ 规则中心改动）一次并行委派。
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
                    out = self._dispatch_tool(name, args, state=state,
                                              current_agent_id=state.get("agent_id", ""))
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
                          "description": "检索离线知识库获取跨工程迭代开发/代码理解与生成资料，参数 query 为检索词，top_k 为返回条数（默认3）",
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
        if self._project_root(current_agent_id):
            schemas.extend([
                {"type": "function",
                 "function": {"name": "code_search",
                              "description": "在当前智能体配置的工程目录内搜索代码。query 为关键字，可空格分隔多个词；返回相对路径、行号和预览",
                              "parameters": {"type": "object",
                                             "properties": {"query": {"type": "string"}, "top_k": {"type": "integer"}},
                                             "required": ["query"]}}},
                {"type": "function",
                 "function": {"name": "code_read",
                              "description": "读取当前智能体配置的工程目录内的代码文件。path 必须是 code_search 返回的相对路径",
                              "parameters": {"type": "object",
                                             "properties": {"path": {"type": "string"}},
                                             "required": ["path"]}}},
            ])
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
                     if a.get("id") and a.get("id") != current_agent_id]
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
                                             "description": "并行多智能体编排：把多个**互相独立、无先后依赖**的子任务一次并行委派（如 boot工程与规则中心改动），全部执行完后统一返回结果。calls 为数组，每项 {agent_id, question}，最多 4 个；有先后依赖的任务必须用 call_agent 串行。可选 agent_id 同 call_agent。"
                                             + f" [{peer_desc}]；**同样禁止在最终回复中重复/复述子智能体的回答内容。**",
                                             "parameters": {"type": "object",
                                                            "properties": {"calls": {"type": "array",
                                                                                     "items": {"type": "object",
                                                                                               "properties": {"agent_id": {"type": "string"},
                                                                                                              "question": {"type": "string"}},
                                                                                               "required": ["agent_id", "question"]}}},
                                                            "required": ["calls"]}}})
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
        if agent_id == "jarvis_commander":
            return state

        # 其他 Agent：按 gen_artifact 开关决定是否落盘（直接对话场景，
        # 如用户直接和业务域 Agent 对话时由该 Agent 自行写对应改动报告）
        if not cfg.get("gen_artifact", False):
            return state
        if not _is_artifact_request(state.get("user_input")):
            return state
        text = state.get("reply", "")
        # 交付门控：反问/要参数类回复不落盘（与 _call_sub_agent 内联写盘一致）
        code_blocks = re.findall(
            r"```(?:java|js|ts|sql|xml|yaml|yml|json|python|vue)?\s*\n(.*?)\n```",
            text, re.DOTALL | re.IGNORECASE)
        if not _is_core_delivery(agent_id, text):
            return state
        files: Dict[str, str] = {}
        for idx, block in enumerate(code_blocks):
            files[f"改动点_{object_name}_{idx + 1}.txt" if idx else f"改动点_{object_name}.txt"] = block.strip()
        md = re.sub(r"```(sql|markdown|json|java|js|ts|xml|yaml|yml|python|vue)?\n.*?\n```", "", text, flags=re.DOTALL | re.IGNORECASE).strip() or text
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
                db_tools: Optional[DbTools] = None, kg=None,
                rag_enabled: bool = True, datasources_enabled: bool = True,
                jarvis_state: Any = None,
                observability: Any = None,
                cancellation_event: Optional[threading.Event] = None):
    rt = GraphRuntime(llm=llm, rag_search=rag_search, prompt_service=prompt_service,
                      artifact_service=artifact_service, skill_service=skill_service,
                      parse_schema=parse_schema, config=config or AppConfig(),
                      max_iterations=max_iterations, agent_service=agent_service,
                      pipeline_service=pipeline_service,
                      db_tools=db_tools, kg=kg,
                      rag_enabled=rag_enabled, datasources_enabled=datasources_enabled,
                      jarvis_state=jarvis_state,
                      observability=observability,
                      cancellation_event=cancellation_event)
    g = StateGraph(AgentState)
    g.add_node("jarvis_commander", rt._safe_node(
        "jarvis_commander", rt.commander))
    for agent_id in STAGE_AGENT_IDS:
        g.add_node(agent_id, rt._safe_node(agent_id, getattr(rt, agent_id)))
    g.add_node("qa", rt._safe_node("qa", rt.qa_node))
    g.add_node("artifact", rt._safe_node("artifact", rt.artifact_node))
    g.add_node("confirm", rt._safe_node("confirm", rt.confirm_node))
    g.add_node("error", rt.error_node)
    g.set_entry_point("jarvis_commander")
    route_map = {agent_id: agent_id for agent_id in STAGE_AGENT_IDS}
    route_map.update({"qa": "qa", "error": "error", END: END})
    g.add_conditional_edges("jarvis_commander", rt.route_agent, route_map)
    for agent_id in STAGE_AGENT_IDS:
        g.add_conditional_edges(
            agent_id, rt.stage_route, {"artifact": "artifact", "error": "error"})
    g.add_conditional_edges("qa", rt.qa_route, {
        "artifact": "artifact", "error": "error", END: END})
    g.add_conditional_edges("artifact", rt.artifact_route, {
        "confirm": "confirm", "error": "error", END: END})
    confirm_map = {agent_id: agent_id for agent_id in STAGE_AGENT_IDS}
    confirm_map.update({"jarvis_commander": "jarvis_commander",
                        "error": "error", END: END})
    g.add_conditional_edges("confirm", rt.confirm_route, confirm_map)
    error_map = {node: node for node in ROUTABLE_NODES}
    error_map[END] = END
    g.add_conditional_edges("error", rt.error_route, error_map)
    return g.compile()
