"""LangGraph 主图：parse → route → execute → artifact → reply"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional

from langgraph.graph import END, StateGraph
from typing_extensions import TypedDict

from db_loc_agent.agents import AgentService, PipelineService
from db_loc_agent.artifacts import (ArtifactService, NamespaceError,
                                    make_namespace, primary_object_name)
from db_loc_agent.config import AppConfig
from db_loc_agent.db_tools import DbTools
from db_loc_agent.prompts import PromptService
from db_loc_agent.state_machine import (STATE_GUIDANCE, STAGE_KB_TYPES,
                                        status_label)

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
    if agent_id == "migration_collector" and has_md:
        has_table = any(line.lstrip().startswith("|") for line in stripped.splitlines())
        has_list = any(re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line)
                       for line in stripped.splitlines())
        if has_table or has_list:
            return True
    return ((has_md or bool(sql_blocks))
            and not _NON_DELIVERY_RE.search(stripped))


_NON_DELIVERY_RE = re.compile(
    r"我需要以下|需要明确|请提供上述|请提供.{0,12}参数|请给出.{0,12}选项|"
    r"关键信息确认|缺失信息清单|请选择以下信息|提供以上信息后|"
    r"需要以下关键.{0,8}信息|请确认以下关键.{0,8}信息|"
    r"无法.{0,6}评估|无法.{0,6}完成|暂时无法|若.{0,10}条件.{0,6}无法|"
    r"请通过.{0,10}提供|缺少.{0,8}参数|请补充.{0,8}信息|"
    r"暂.{0,4}无法确定|无法准确.{0,6}评估"
)


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
        )
    return ""

PARSE_KEYS = {"intent", "agent_id", "object_name", "source_db",
              "target_db", "skill_id", "params", "confidence"}
CORE_KEYS = {"intent", "agent_id", "confidence"}

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
                 migrate_assets: Any = None, migrate_state: Any = None):
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
        # 快速问答（无空间归属会话）：禁用知识库检索与数据源/运维探活能力
        self.rag_enabled = rag_enabled
        self.datasources_enabled = datasources_enabled
        self.max_iterations = max_iterations

    def get_prompt(self, category: str) -> str:
        rows = [p for p in self.prompts.list(category=category) if p["enabled"]]
        if not rows:
            return ""
        # 同 category 取最近更新的（id 最大）
        return max(rows, key=lambda p: p["id"])["content"]

    def parse(self, state: AgentState) -> AgentState:
        text = state.get("user_input", "")
        if hasattr(self.llm, "parse"):
            result = self.llm.parse(text)
        else:  # 真模型：结构化输出
            from langchain_core.messages import HumanMessage, SystemMessage
            pmt = _default_parse_schema_prompt(self.agent_svc.intents(),
                                               {a["id"]: a for a in self.agent_svc.enabled()})
            resp = self.llm.invoke([SystemMessage(content=pmt), HumanMessage(content=text)])
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
        return state

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
        while iterations < self.max_iterations:
            iterations += 1
            llm = self.llm
            if hasattr(llm, "bind_tools"):
                try:
                    llm = llm.bind_tools(self._tool_schemas(include_agents=False))
                except Exception:
                    llm = self.llm
            # callbacks=[] 切断父图 messages 流对嵌套子 Agent token 的捕获；
            # 子 Agent 完整回复只通过 sub_agent custom event 下发一次。
            resp = llm.invoke(messages, config={"callbacks": []})
            text = resp.content if hasattr(resp, "content") else str(resp)
            tool_calls = getattr(resp, "tool_calls", None) or []
            if not tool_calls:
                chunks.append(text)
                break
            messages.append(resp)
            for tc in tool_calls:
                name = tc.get("name", "")
                args = tc.get("args", {}) if isinstance(tc.get("args"), dict) else {}
                out = self._dispatch_tool(name, args, state=state)
                messages.append(ToolMessage(content=out, tool_call_id=tc.get("id", ""), name=name))
        full_reply = "\n".join(chunks) or "（该 Agent 未给出回答）"
        ui_render = _extract_ui_render(full_reply)
        full_reply = _strip_control_blocks(full_reply)
        reply = full_reply
        produced: List[Dict] = []
        # 子 Agent 自行入库：只有业务交付物才落盘。Markdown 标题代表报告，
        # SQL 代码块代表转换脚本；小采的结构化失败报告也保留为采集产物。
        if (cfg.get("gen_artifact", False) and self.artifacts is not None
                and state is not None):
            stripped = full_reply.strip()
            sql_blocks = re.findall(
                r"```sql\s*\n(.*?)\n```", stripped, re.DOTALL | re.IGNORECASE)
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
                files: Dict[str, str] = {report_name: stripped}
                # SQL 转换专家等：额外抽取 SQL 代码块单独存为 .sql
                for idx, block in enumerate(sql_blocks):
                    files[f"转换脚本_{obj}_{idx + 1}.sql" if idx else f"转换脚本_{obj}.sql"] = block.strip()
                try:
                    res = self.artifacts.write(
                        ns, int(state.get("conv_id", 0)), agent_id, obj, files)
                    produced = res.get("files", [])
                    reply = "已生成核心产物：" + "、".join(
                        str(f.get("path", "")).split("/")[-1] for f in produced)
                    # 实时事件：通知前端产物已生成（按产出 Agent 分组）
                    self._emit({"type": "artifact", "agent_id": agent_id,
                                "agent_name": self._agent_name(agent_id),
                                "namespace": ns, "files": produced})
                except NamespaceError as e:
                    reply += f"\n\n（产物入库失败：{e}）"
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
            return json.dumps(self.db_tools.inspect_schema(
                str(args.get("ds", "")), str(args.get("object", ""))), ensure_ascii=False)
        if name == "db_query" and self.db_tools is not None:
            return json.dumps(self.db_tools.query(
                str(args.get("ds", "")), str(args.get("sql", ""))), ensure_ascii=False)
        if name == "db_explain" and self.db_tools is not None:
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
            return json.dumps(self.ops.health_check(str(args.get("ds", ""))), ensure_ascii=False)
        if name == "ops_slow_sql" and self.ops is not None:
            return json.dumps(self.ops.slow_queries(
                threshold_ms=int(args.get("threshold_ms", 0)),
                limit=int(args.get("limit", 20))), ensure_ascii=False)
        if name == "ops_baseline" and self.ops is not None:
            return json.dumps(self.ops.baseline(), ensure_ascii=False)
        if name == "gov_catalog" and self.gov is not None:
            return json.dumps(self.gov.catalog(str(args.get("ds", ""))), ensure_ascii=False)
        if name == "gov_quality" and self.gov is not None:
            return json.dumps(self.gov.quality(str(args.get("ds", ""))), ensure_ascii=False)
        if name == "gov_kgsync" and self.gov is not None:
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
        _M_EXEC_STATES = ("DATA_COLLECTION", "ASSESSMENT_RUNNING", "SOLUTION_GENERATE",
                          "CODE_MIGRATE", "VERIFY_STAGE", "FINISHED")
        _LEGACY_STEP_MAP = {  # 兼容旧会话历史（旧状态值/step → 新阶段）
            "step1": "DATA_COLLECTION", "step2": "DATA_COLLECTION",
            "step3": "DATA_COLLECTION", "complete": "DATA_COLLECTION",
            "step2_conflict": "DATA_COLLECTION",
            "INIT": "DATA_COLLECTION", "DATA_SOURCE_SELECTED": "DATA_COLLECTION",
            "BASIC_INFO_COLLECTED": "DATA_COLLECTION", "OBJECT_SCANNING": "DATA_COLLECTION",
            "SQL_TRANSFORM": "CODE_MIGRATE",
        }
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
            final_text_parts: List[str] = []
            agg: Any = None
            for chunk in llm.stream(messages):
                if hasattr(chunk, "content") and chunk.content:
                    final_text_parts.append(chunk.content)
                # 逐块累加（AIMessageChunk 支持 + 聚合）：流式模式下工具调用参数
                # 分布在中间块上，只取最后一块会丢掉 tool_calls —— 曾导致
                # 「模型发起工具调用时整轮回复为空」（表现为识别意图后直接结束、无任何回复）
                agg = chunk if agg is None else agg + chunk
            resp = agg
            text = "".join(final_text_parts) if final_text_parts else (
                resp.content if hasattr(resp, "content") else str(resp) if resp else "")
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
                        self._emit({"type": "sub_agent",
                                    "agent_id": sub_id,
                                    "agent_name": sub_name,
                                    "dispatcher_id": state.get("agent_id", ""),
                                   "dispatcher_name": self._agent_name(state.get("agent_id", "")),
                                   "reply": sub.get("reply", ""),
                                   "error": sub.get("error", ""),
                                   "artifacts": sub.get("artifacts", []),
                                   "ui_render": sub.get("ui_render")})
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
                            self._emit({"type": "sub_agent",
                                        "agent_id": sub_id,
                                        "agent_name": sub_name,
                                        "dispatcher_id": state.get("agent_id", ""),
                                        "dispatcher_name": self._agent_name(state.get("agent_id", "")),
                                        "reply": sub.get("reply", ""),
                                        "error": sub.get("error", ""),
                                        "artifacts": sub.get("artifacts", []),
                                        "ui_render": sub.get("ui_render")})
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
            res = self.artifacts.write(namespace, conv_id, agent_id, object_name, files)
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
                migrate_assets: Any = None, migrate_state: Any = None):
    rt = GraphRuntime(llm=llm, rag_search=rag_search, prompt_service=prompt_service,
                      artifact_service=artifact_service, skill_service=skill_service,
                      parse_schema=parse_schema, config=config or AppConfig(),
                      max_iterations=max_iterations, agent_service=agent_service,
                      pipeline_service=pipeline_service,
                      db_tools=db_tools, kg=kg, ops=ops, gov=gov,
                      rag_enabled=rag_enabled, datasources_enabled=datasources_enabled,
                      migrate_assets=migrate_assets, migrate_state=migrate_state)
    g = StateGraph(AgentState)
    g.add_node("parse", rt.parse)
    g.add_node("route", rt.route)
    g.add_node("execute", rt.execute)
    g.add_node("artifact", rt.artifact)
    g.add_node("reply", lambda s: s)
    g.set_entry_point("parse")
    g.add_edge("parse", "route")
    g.add_edge("route", "execute")
    g.add_edge("execute", "artifact")
    g.add_edge("artifact", "reply")
    g.add_edge("reply", END)
    return g.compile()
