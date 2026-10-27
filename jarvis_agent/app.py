"""FastAPI 应用：REST + SSE 对话流 + 静态页"""
from __future__ import annotations

import asyncio
import functools
import os
import json
import re
import threading
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import (FastAPI, File, Form, HTTPException, Query, Request, UploadFile,
                     WebSocket, WebSocketDisconnect)
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError

from jarvis_agent.agents import AgentService, PipelineService
from jarvis_agent.artifacts import ArtifactService, NamespaceError
from jarvis_agent.auth import (change_password, create_user, delete_user, display_name_of,
                               ensure_default_admin, get_role, list_users, logout as auth_logout,
                               login as auth_login, reset_password, validate as auth_validate)
from jarvis_agent.attachments import SUPPORTED_EXT, create_attachment, extract_text
from jarvis_agent.config import AppConfig, LLMSettings, load_config
from jarvis_agent.db import (ArtifactRecord, Conversation, Database, Message,
                             ProjectTask, Space, SpaceSubsystem, TemplateRecord)
from jarvis_agent.db_tools import DbTools
from jarvis_agent.embedding import create_embedding_function
from jarvis_agent.graph import AgentState, ChatRunCancelled, build_graph
from jarvis_agent.kg import KnowledgeGraph
from jarvis_agent.llm import create_chat_model
from jarvis_agent.observability import ObservabilityService
from jarvis_agent.project import DEFAULT_SPACE_NAME, ProjectError, ProjectService
from jarvis_agent.prompts import PromptService
from jarvis_agent.rag import RAGStore
from jarvis_agent.reliability import CircuitBreaker
from jarvis_agent.skills import SkillService
from jarvis_agent.state_machine import (JarvisStateError, JarvisStateService,
                                        parse_iter_params,
                                        status_label)
from jarvis_agent.state_stream import (JarvisStateBroadcaster,
                                       jarvis_state_event_frame,
                                       jarvis_state_snapshot)
from jarvis_agent.workflow_template import build_workflow_template_response, parse_workflow_xml
from jarvis_agent import analysis as _analysis
from jarvis_agent.analysis import (
    decrypt_cipher_batch, decrypt_cipher_value, ensure_analysis_seed,
    execute_node_query, execute_scene_query, list_centers, query_accept_message,
    query_billing_message, query_busi_cmpt, query_customer_order_message,
    query_def_scene, query_instance_order, query_instance_user, query_item_relat,
    query_business_info, query_plan_config, query_pre_lmt_param, query_up_rule,
    query_product_drive,
    query_static_config, query_product_config, query_scene_rules, query_so_pre_busi_limit,
    query_stage_reply,
    query_async_flow, query_structured_order_info, query_wired_message, query_workflow,
    retry_hall_task,
)
from jarvis_agent.workspace import WorkspaceError, WorkspaceService


def default_static_dir() -> str:
    """Return the canonical Vite build output served by the API process."""
    return str(Path(__file__).resolve().parent.parent / "web-ui" / "dist")


def _conv_key(conv: Conversation) -> str:
    return f"sess_{conv.id if conv.id is not None else 0}"


class ChatCancellationRegistry:
    """会话级服务端取消注册表：显式中止优先于依赖 SSE 断连感知。"""

    def __init__(self) -> None:
        self._events: Dict[int, threading.Event] = {}
        self._lock = threading.Lock()

    def start(self, conv_id: int) -> threading.Event:
        event = threading.Event()
        with self._lock:
            self._events[int(conv_id)] = event
        return event

    def cancel(self, conv_id: int) -> bool:
        with self._lock:
            event = self._events.get(int(conv_id))
        if event is None:
            return False
        event.set()
        return True


def _with_migrate_execution_state(data: Dict, db: Database) -> Dict:
    """补充会话内阶段执行态：主状态负责推进，step_status 负责节点完成展示。"""
    conv_id = data.get("conv_id")
    if conv_id is None:
        return data

    def _decode_state(conv: Conversation | None) -> Dict:
        try:
            decoded = json.loads((conv.task_state if conv else "") or "{}")
            return decoded if isinstance(decoded, dict) else {}
        except (TypeError, ValueError):
            return {}

    with db.session() as s:
        conv = s.get(Conversation, int(conv_id))
        task_state = _decode_state(conv)
        state_conv_id = int(conv_id)
        if not any(k in task_state for k in
                   ("current_step", "step_status", "awaiting_confirmation")):
            # 平台化改造后 conv_id 可能存业务任务 ID；阶段执行态在任务下的会话里。
            from sqlalchemy import select
            candidates = list(s.scalars(select(Conversation).where(
                Conversation.task_id == int(conv_id)).order_by(
                Conversation.id.desc())))
            fallback = next(
                (c for c in candidates
                 if _decode_state(c).get("migrate_task_id") == data.get("task_id")),
                candidates[0] if candidates else None,
            )
            if fallback is not None:
                task_state = _decode_state(fallback)
                state_conv_id = int(fallback.id)
    if isinstance(task_state, dict):
        for key in ("current_step", "step_status", "awaiting_confirmation"):
            if key in task_state:
                data[key] = task_state[key]
        legacy_collection_steps = {
            "PAGE_SHOW", "ORDER_SPLIT", "ORDER_ACCEPT",
            "RULE_CHECK", "CUSTOMER_CHECK",
        }
        if (data.get("status") == "PAGE_SHOW"
                and str(task_state.get("current_step") or "") in legacy_collection_steps
                and task_state.get("step_status") == "running"):
            # 兼容旧版本：报告已落库但 stay 分支把执行态覆盖回 running。
            with db.session() as s:
                has_report = s.query(ArtifactRecord.id).filter(
                    ArtifactRecord.conv_id == state_conv_id,
                    ArtifactRecord.agent_id == "boot_agent",
                    ArtifactRecord.file_type == "md",
                ).first() is not None
            if has_report:
                data["step_status"] = "done"
    return data


def _has_collector_report(db: Database, task_id: int, conv_ref: Any) -> bool:
    """判断跨工程迭代任务是否已有 boot 工程核心报告（业务任务与会话两种关联都兼容）。"""
    from sqlalchemy import or_, select

    with db.session() as s:
        conv_ids = list(s.scalars(select(Conversation.id).where(or_(
            Conversation.id == int(conv_ref or 0),
            Conversation.task_id == int(conv_ref or 0),
        ))))
        if not conv_ids:
            return False
        return s.query(ArtifactRecord.id).filter(
            ArtifactRecord.conv_id.in_(conv_ids),
            ArtifactRecord.agent_id == "boot_agent",
            ArtifactRecord.file_type == "md",
        ).first() is not None


def _collector_report_completion_params(row, params: Dict, db: Database) -> Dict:
    """用户确认推进时，以已生成的 boot 工程报告作为页面展示完成依据。"""
    confirmed = str(params.get("task_confirm") or "").strip() in ("确认", "继续", "同意")
    if (getattr(row, "status", "") != "PAGE_SHOW" or not confirmed
            or not (getattr(row, "business_scene", "") or params.get("business_scene"))):
        return {}
    if not _has_collector_report(db, int(row.id), getattr(row, "conv_id", None)):
        return {}
    return {
        "frontend_task": params.get("frontend_task")
        or getattr(row, "frontend_task", "") or "以页面展示方案为准",
        "order_source": params.get("order_source")
        or getattr(row, "order_source", "") or "以页面展示方案为准",
    }


def _resolve_ui_placeholders(obj: Dict, db_tools: Any) -> Dict:
    """把 UI 指令中的系统占位符替换为真实候选清单（递归处理 dict/list/str）。

    目前支持：{{system_data_source_list}} → 已启用的数据源名称列表。
    匹配容忍内部空格与大小写差异；精确匹配占位符时替换为 list，
    长文本中内嵌占位符时替换为逗号拼接文本。
    """
    import re as _re
    _ph_re = _re.compile(r"\{\{\s*system_data_source_list\s*\}\}", _re.I)

    def names() -> List[str]:
        try:
            return [str(d["name"]) for d in db_tools.list() if d.get("enabled")]
        except Exception:
            return []

    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, str) and _ph_re.search(v):
            if _ph_re.fullmatch(v.strip()):
                return names()
            return _ph_re.sub(lambda _m: "、".join(names()), v)
        return v

    res = walk(obj)
    # 兜底：数据源选择类组件（component/fields 均可）options 仍为空时，
    # 直接填入已启用数据源，避免前端渲染「暂无可选项」
    try:
        ds_names = names()
        if ds_names and isinstance(res, dict):
            t = f"{res.get('title', '')}{res.get('param_key', '')}"
            if res.get("component") and not res.get("options"):
                if any(k in t for k in ("数据源", "datasource", "source")):
                    res["options"] = ds_names
            for f in res.get("fields", []) or []:
                if isinstance(f, dict) and not f.get("options") and str(f.get("type", "")) in ("select", "radio"):
                    if any(k in f.get("name", "") + f.get("label", "") for k in ("数据源", "datasource", "source")):
                        f["options"] = ds_names
    except Exception:
        pass
    return res


_EMPTY_CONFIRMATION_RE = re.compile(
    r"(请确认以上|确认以上|请完成以上|完成以上)", re.I)
_EXPLICIT_FIELD_LIST_RE = re.compile(
    r"^\s*(?:[-*+]\s+\S+|\d+[.)]\s+\S+|\|.+\|)", re.M)


def _fallback_confirmation_form() -> Dict:
    """模型宣布要用户确认但未输出字段时的确定性兜底，避免空确认文案。"""
    return {
        "title": "请补充关键信息",
        "fields": [{
            "name": "pending_confirmation_details",
            "label": "请逐项填写具体待确认信息",
            "type": "textarea",
            "options": [],
            "placeholder": "例如：源数据源、目标数据库、停机窗口、迁移对象范围",
        }],
        "submit": "提交关键信息",
    }


def _needs_confirmation_fallback(text: str) -> bool:
    """仅拦截“指向以上内容但正文没有字段清单”的空确认。"""
    return bool(_EMPTY_CONFIRMATION_RE.search(text or "")
                and not _EXPLICIT_FIELD_LIST_RE.search(text or ""))


def create_app(db_path: str = "data/db.sqlite3", artifact_root: str = "artifacts",
               faiss_dir: str = "data/faiss", config_override: Optional[Dict] = None,
               static_dir: Optional[str] = None,
               embedding_function: Optional[Any] = None):
    cfg = load_config()
    if config_override:
        nested_sections = ("llm", "reliability", "ocr", "workflow")
        for key, value in config_override.items():
            if key in nested_sections and isinstance(value, dict):
                section = getattr(cfg, key)
                for k, v in value.items():
                    if hasattr(section, k):
                        setattr(section, k, v)
            elif hasattr(cfg, key):
                setattr(cfg, key, value)
    cfg.db_path, cfg.artifact_root, cfg.faiss_dir = db_path, artifact_root, faiss_dir

    db = Database(db_path, cfg.mysql_url or None)
    ensure_default_admin(db)
    if getattr(cfg, "decrypt_url", ""):
        _analysis.DECRYPT_API_URL = cfg.decrypt_url
    prompts = PromptService(db)
    skills = SkillService(db, str(Path(db_path).parent / "skills"))
    artifacts = ArtifactService(db, artifact_root)
    proj = ProjectService(db)
    agents_svc = AgentService(db)
    workspaces = WorkspaceService(db, agents_svc)
    observability = ObservabilityService(db)
    db_breaker = CircuitBreaker(
        failure_threshold=cfg.reliability.db_failure_threshold,
        recovery_seconds=cfg.reliability.db_recovery_seconds,
    )
    db_tools = DbTools(db, circuit_breaker=db_breaker)
    db_tools.migrate_password_encryption()  # 存量明文数据源密码统一加密
    try:
        ensure_analysis_seed(db)
    except Exception:  # 种子失败不影响服务启动，数据分析页会提示配置缺失
        pass
    kg = KnowledgeGraph(db)
    embed_fn = embedding_function or create_embedding_function(cfg.llm)
    rag = RAGStore(db, faiss_dir, cfg.kb_collection, embed_fn)

    # ---- 跨工程迭代编排能力：状态机 / 离线知识 ----
    chat_cancellations = ChatCancellationRegistry()
    from jarvis_agent.agents import SysDictService
    jarvis_state = JarvisStateService(db, observability=observability)
    jarvis_state_broadcaster = JarvisStateBroadcaster()

    def _persisted_iter_task_state(row) -> Dict:
        data = jarvis_state.to_dict(row)
        _with_migrate_execution_state(data, db)
        return {
            "current_step": data.get("current_step"),
            "step_status": data.get("step_status"),
            "awaiting_confirmation": data.get("awaiting_confirmation"),
        }

    def _broadcast_iter_state(task_id: int,
                              task_state: Dict | None = None) -> None:
        try:
            row = jarvis_state.get(int(task_id))
            if row is None:
                return
            effective_state = (
                task_state if isinstance(task_state, dict)
                else _persisted_iter_task_state(row))
            jarvis_state_broadcaster.broadcast(
                int(task_id),
                jarvis_state_snapshot(row, effective_state, status_label),
            )
        except Exception:
            pass

    def _broadcast_latest_iter_event(task_id: int) -> None:
        try:
            events = observability.list_state_events(task_id, limit=1)
            if events:
                jarvis_state_broadcaster.broadcast_event(
                    task_id, jarvis_state_event_frame(events[-1]))
        except Exception:
            pass

    app = FastAPI(title=cfg.name, version="0.1.0")
    if static_dir is None:
        static_dir = default_static_dir()
    Path(static_dir).mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    app.mount(
        "/assets",
        StaticFiles(directory=Path(static_dir) / "assets"),
        name="assets",
    )

    # ---------- 健康与设置 ----------
    # ---------- 登录鉴权 ----------
    # 测试/本地调试可设 JARVIS_AUTH_DISABLED=1 关闭（生产勿设）
    auth_disabled = os.environ.get("JARVIS_AUTH_DISABLED") == "1"

    @app.middleware("http")
    async def auth_middleware(request, call_next):
        path = request.url.path
        if not auth_disabled and path.startswith("/api") and path not in ("/api/auth/login", "/api/health"):
            header = request.headers.get("authorization", "")
            token = header[7:].strip() if header.lower().startswith("bearer ") else ""
            username = auth_validate(db, token)
            if not username:
                return JSONResponse({"success": False, "detail": "未登录或登录已过期"}, status_code=401)
            request.state.username = username
        return await call_next(request)

    @app.post("/api/auth/login")
    def auth_login_endpoint(payload: Dict = None):
        payload = payload or {}
        username = str(payload.get("username") or "").strip()
        token, error = auth_login(db, username, str(payload.get("password") or ""))
        if not token:
            raise HTTPException(401, error or "用户名或密码错误")
        return {"success": True, "data": {"token": token, "username": username,
                                          "role": get_role(db, username),
                                          "display_name": display_name_of(db, username)}}

    @app.post("/api/auth/change-password")
    def auth_change_password(request: Request, payload: Dict = None):
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        username = auth_validate(db, token)
        if not username:
            raise HTTPException(401, "未登录或登录已过期")
        payload = payload or {}
        ok, message = change_password(db, username, str(payload.get("old_password") or ""),
                                      str(payload.get("new_password") or ""))
        if not ok:
            raise HTTPException(400, message)
        return {"success": True, "data": {"message": message}}

    # ---------- 用户管理（仅管理员） ----------
    def _require_admin(request: Request) -> str:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        username = auth_validate(db, token)
        if not username:
            raise HTTPException(401, "未登录或登录已过期")
        if get_role(db, username) != "admin":
            raise HTTPException(403, "需要管理员权限")
        return username

    @app.get("/api/auth/users")
    def auth_users_list(request: Request):
        _require_admin(request)
        return {"success": True, "data": list_users(db)}

    @app.post("/api/auth/users")
    def auth_users_create(request: Request, payload: Dict = None):
        operator = _require_admin(request)
        payload = payload or {}
        ok, message = create_user(db, str(payload.get("username") or ""),
                                  str(payload.get("password") or ""),
                                  str(payload.get("display_name") or ""),
                                  str(payload.get("role") or "user"))
        if not ok:
            raise HTTPException(400, message)
        gateway.audit(db, "AUTH", "/api/auth/users",
                      request.client.host if request.client else "", 200, 0,
                      f"{operator} 创建用户: {payload.get('username')}")
        return {"success": True, "data": {"message": message}}

    @app.delete("/api/auth/users/{username}")
    def auth_users_delete(username: str, request: Request):
        operator = _require_admin(request)
        ok, message = delete_user(db, username, operator)
        if not ok:
            raise HTTPException(400, message)
        gateway.audit(db, "AUTH", f"/api/auth/users/{username}",
                      request.client.host if request.client else "", 200, 0,
                      f"{operator} 删除用户: {username}")
        return {"success": True, "data": {"message": message}}

    @app.post("/api/auth/users/{username}/reset-password")
    def auth_users_reset(username: str, request: Request, payload: Dict = None):
        operator = _require_admin(request)
        payload = payload or {}
        ok, message = reset_password(db, username, str(payload.get("new_password") or ""))
        if not ok:
            raise HTTPException(400, message)
        gateway.audit(db, "AUTH", f"/api/auth/users/{username}/reset-password",
                      request.client.host if request.client else "", 200, 0,
                      f"{operator} 重置用户密码: {username}")
        return {"success": True, "data": {"message": message}}

    @app.post("/api/auth/logout")
    def auth_logout_endpoint(request: Request):
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        auth_logout(db, token)
        return {"success": True}

    @app.get("/api/auth/me")
    def auth_me(request: Request):
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        username = auth_validate(db, token)
        if not username:
            raise HTTPException(401, "未登录或登录已过期")
        return {"success": True, "data": {"username": username, "role": get_role(db, username),
                                          "display_name": display_name_of(db, username)}}

    @app.get("/api/health")
    def health():
        return {"status": "ok", "name": cfg.name}

    @app.websocket("/ws/jarvis/{task_id}")
    async def jarvis_state_socket(task_id: int, websocket: WebSocket):
        ws_token = websocket.query_params.get("token") or ""
        if not auth_disabled and not auth_validate(db, ws_token):
            await websocket.close(code=1008)
            return
        """Push authoritative cross-project iteration state frames while the browser stays connected."""
        await websocket.accept()
        row = jarvis_state.get(task_id)
        if row is None:
            await websocket.send_json({"event": "not_found", "task_id": task_id})
            await websocket.close(code=1008)
            return
        try:
            initial_snapshot = jarvis_state_snapshot(
                row, _persisted_iter_task_state(row), status_label)
            await websocket.send_json(initial_snapshot)
            await jarvis_state_broadcaster.add(task_id, websocket)
            current_row = jarvis_state.get(task_id)
            if current_row is not None:
                current_snapshot = jarvis_state_snapshot(
                    current_row, _persisted_iter_task_state(current_row),
                    status_label)
                if current_snapshot != initial_snapshot:
                    jarvis_state_broadcaster.broadcast(task_id, current_snapshot)
            while True:
                message = await websocket.receive_text()
                if message == "ping":
                    await websocket.send_json({"event": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            await jarvis_state_broadcaster.remove(task_id, websocket)

    @app.get("/api/me")
    def current_user():
        """当前登录用户信息（轻量：仅展示用，不做真实鉴权）。从 DB user_profiles 读取。"""
        from sqlalchemy import select
        from jarvis_agent.db import UserProfile
        with db.session() as s:
            row = s.scalar(select(UserProfile).where(UserProfile.enabled == True).order_by(UserProfile.id).limit(1))
        if row is None:
            return {"name": "", "role": "", "title": "", "email": "",
                    "avatar_color": "#5b7cfa"}
        return {"name": row.name or "", "role": row.role or "",
                "title": row.title or "", "email": row.email or "",
                "avatar_color": row.avatar_color or "#5b7cfa"}

    @app.get("/api/ollama/models")
    def ollama_models():
        """按 LLM 提供商返回可用的模型列表（表单下拉数据源）。
        - ollama：读取本机 Ollama /api/tags
        - bailian / deepseek / zhipu：尝试 OpenAI 兼容 /models 接口，失败时回退内置预设列表
        返回列表始终包含当前配置的 model（避免下拉为空）。
        """
        import httpx
        provider = (cfg.llm.provider or "ollama").lower()
        current = (cfg.llm.model or "").strip()

        def _ensure(models, default=()):
            out = []
            for m in models:
                s = str(m).strip()
                if s and s not in out:
                    out.append(s)
            for m in default:
                s = str(m).strip()
                if s and s not in out:
                    out.append(s)
            if current and current not in out:
                out.insert(0, current)
            return out

        # 预设模型列表（OpenAI 兼容接口不可用时的回退）
        PRESET = {
            "bailian": ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long",
                        "qwen2.5-72b-instruct", "qwen3-235b-a22b-instruct",
                        "qwen3.7-plus"],
            "deepseek": ["deepseek-chat", "deepseek-reasoner"],
            "zhipu": ["glm-5.3"],
        }

        if provider == "ollama":
            try:
                base = (cfg.llm.base_url or "http://localhost:11434").rstrip("/")
                r = httpx.get(base + "/api/tags", timeout=3)
                r.raise_for_status()
                return {"success": True,
                        "data": _ensure([m["name"] for m in r.json().get("models", [])])}
            except Exception as e:
                # Ollama 不可达时仍返回当前 model，保证下拉不空
                return {"success": True,
                        "data": _ensure([]),
                        "fallback": True,
                        "error": f"无法连接 Ollama({cfg.llm.base_url}): {e}"}

        # OpenAI 兼容 /models
        from jarvis_agent.llm import DEEPSEEK_BASE, BAILIAN_BASE, ZHIPU_BASE
        base_map = {"deepseek": DEEPSEEK_BASE, "bailian": BAILIAN_BASE,
                    "zhipu": ZHIPU_BASE}
        api_key = (cfg.llm.api_key or "").strip()
        preset = PRESET.get(provider, [])
        if api_key:
            try:
                base = (cfg.llm.base_url or base_map.get(provider, "")).rstrip("/")
                r = httpx.get(base + "/models",
                              headers={"Authorization": f"Bearer {api_key}"},
                              timeout=5)
                r.raise_for_status()
                return {"success": True,
                        "data": _ensure([m.get("id") or m.get("name") for m in r.json().get("data", [])],
                                        default=[current] if current else preset)}
            except Exception:
                pass  # 回退预设
        return {"success": True, "data": _ensure([], default=[current] if current else preset), "fallback": True}

    @app.put("/api/settings")
    def update_settings(payload: Dict):
        for k in ("provider", "base_url", "model", "api_key", "embedding_model"):
            if k in payload:
                setattr(cfg.llm, k, payload[k])
        return {"success": True}

    @app.get("/api/settings")
    def get_settings():
        return {"success": True, "data": asdict(cfg.llm)}

    # 项目业务错误处理器：把 ProjectError 映射为 HTTP 异常（须先于其用户路由定义）
    def _project_handler(fn):
        @functools.wraps(fn)
        def wrap(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except ProjectError as e:
                raise HTTPException(e.status, e.message) from e
        return wrap

    # 工程只读访问器：统一把安全校验错误映射为 HTTP 状态
    def _workspace_handler(fn):
        @functools.wraps(fn)
        def wrap(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except WorkspaceError as e:
                raise HTTPException(e.status_code, str(e)) from e
        return wrap

    # ---------- 会话 ----------
    @app.get("/api/conversations")
    def list_conversations(space_id: Optional[int] = None,
                           sub_system_id: Optional[int] = None):
        with db.session() as s:
            from sqlalchemy import func, select
            q = select(Conversation)
            if space_id:
                q = q.where(Conversation.space_id == space_id)
            rows = list(s.scalars(q.order_by(Conversation.id.desc())))
            data = []
            for c in rows:
                task = s.get(ProjectTask, c.task_id) if c.task_id else None
                task_name = task.name if task else ""
                # 归属任务的会话，若未显式记录空间则从任务继承
                eff_space_id = c.space_id or (task.space_id if task else None)
                space_name = ""
                if eff_space_id:
                    sp = s.get(Space, eff_space_id)
                    space_name = sp.name if sp else ""
                msg_count = s.query(func.count(Message.id)).filter(Message.conv_id == c.id).scalar() or 0
                data.append({"id": c.id, "title": c.title,
                             "space_id": eff_space_id, "space_name": space_name,
                             "sub_system_id": None, "sub_system_name": "",
                             "task_id": c.task_id, "task_name": task_name,
                             "agent_id": c.agent_id, "message_count": msg_count,
                             "task_state": c.task_state or "",
                             "created_at": c.created_at.isoformat() if c.created_at else None})
            return {"success": True, "data": data}

    @app.post("/api/conversations")
    def create_conversation(payload: Dict):
        with db.session() as s:
            task_id = payload.get("task_id")
            space_id = payload.get("space_id")
            # 归属任务时自动继承任务的空间（未显式指定时）
            if task_id and space_id is None:
                t = s.get(ProjectTask, int(task_id))
                if t:
                    space_id = space_id if space_id is not None else t.space_id
            if space_id is None:
                from sqlalchemy import select
                space = s.scalar(select(Space).where(Space.name == DEFAULT_SPACE_NAME))
                if space is None:
                    space = Space(name=DEFAULT_SPACE_NAME,
                                  description="系统默认目录（新建会话默认落在此）")
                    s.add(space)
                    s.flush()
                space_id = space.id
            c = Conversation(title=payload.get("title") or "新会话",
                             space_id=space_id,
                             sub_system_id=None,
                             task_id=task_id,
                             agent_id=str(payload.get("agent_id") or ""))
            s.add(c)
            s.commit()
            s.refresh(c)
            space = s.get(Space, c.space_id) if c.space_id else None
            return {"success": True, "data": {"id": c.id, "title": c.title,
                                              "space_id": c.space_id,
                                              "space_name": space.name if space else None,
                                              "task_id": c.task_id}}

    @app.put("/api/conversations/{cid}")
    def rename_conversation(cid: int, payload: Dict):
        """重命名会话（仅改展示标题）"""
        title = str(payload.get("title", "")).strip()
        if not title:
            raise HTTPException(400, "会话名称不能为空")
        with db.session() as s:
            c = s.get(Conversation, cid)
            if not c:
                raise HTTPException(404, "会话不存在")
            c.title = title
            s.commit()
            return {"success": True, "data": {"id": c.id, "title": c.title}}

    # 注意：{cid} 详情路由需声明在其子路由（/{cid}/messages、/{cid}/trace）之前
    @app.get("/api/conversations/{cid}")
    def get_conversation(cid: int):
        with db.session() as s:
            c = s.get(Conversation, cid)
            if not c:
                raise HTTPException(404, "会话不存在")
            space_name = sub_name = task_name = ""
            task = s.get(ProjectTask, c.task_id) if c.task_id else None
            if c.task_id:
                task_name = task.name if task else ""
            # 归属任务的会话：空间/子系统缺失时从任务继承
            eff_space_id = c.space_id or (task.space_id if task else None)
            eff_sub_id = c.sub_system_id or (task.sub_system_id if task else None)
            if eff_space_id:
                sp = s.get(Space, eff_space_id)
                space_name = sp.name if sp else ""
            if eff_sub_id:
                ss = s.get(SpaceSubsystem, eff_sub_id)
                sub_name = ss.name if ss else ""
            return {"success": True, "data": {
                "id": c.id, "title": c.title, "space_id": eff_space_id, "space_name": space_name,
                "sub_system_id": eff_sub_id, "sub_system_name": sub_name,
                "task_id": c.task_id, "task_name": task_name, "agent_id": c.agent_id,
                "task_state": c.task_state or ""}}

    @app.post("/api/conversations/{cid}/attach-task")
    @_project_handler
    def attach_task(cid: int, payload: Dict):
        return {"success": True, "data": proj.attach_conversation_to_task(cid, payload)}

    @app.post("/api/conversations/{cid}/attach-space")
    def attach_space(cid: int, payload: Dict):
        """快速问答会话 → 项目会话：为会话绑定空间归属"""
        with db.session() as s:
            c = s.get(Conversation, cid)
            if not c:
                raise HTTPException(404, "会话不存在")
            space_id = payload.get("space_id")
            if not space_id:
                raise HTTPException(400, "请选择有效的空间")
            sp = s.get(Space, space_id)
            if not sp:
                raise HTTPException(400, "空间不存在")
            c.space_id = space_id
            c.sub_system_id = None
            s.commit()
            space_name = sp.name or ""
            task_name = ""
            if c.task_id:
                t = s.get(ProjectTask, c.task_id)
                task_name = t.name if t else ""
            return {"success": True, "data": {
                "id": c.id, "title": c.title, "space_id": c.space_id, "space_name": space_name,
                "sub_system_id": None, "sub_system_name": "",
                "task_id": c.task_id, "task_name": task_name, "agent_id": c.agent_id}}

    @app.delete("/api/conversations/{cid}")
    def delete_conversation(cid: int):
        """删除会话：级联清理消息、trace 与本地产物（知识库已入库副本保留隔离）"""
        import shutil
        from pathlib import Path as _Path
        from sqlalchemy import select
        from jarvis_agent.db import ArtifactRecord, ChatTrace, Message, Task
        with db.session() as s:
            c = s.get(Conversation, cid)
            if not c:
                raise HTTPException(404, "会话不存在")
            s.query(Message).filter(Message.conv_id == cid).delete(synchronize_session=False)
            s.query(ChatTrace).filter(ChatTrace.conv_id == cid).delete(synchronize_session=False)
            s.query(Task).filter(Task.conv_id == cid).delete(synchronize_session=False)
            # 会话产物记录与本地文件一并清理（知识库已入库副本保留）
            for rec in s.scalars(select(ArtifactRecord).where(ArtifactRecord.conv_id == cid)):
                if rec.path:
                    try:
                        _Path(rec.path).unlink(missing_ok=True)
                    except OSError:
                        pass
                s.delete(rec)
            s.delete(c)
            s.commit()
        return {"success": True}

    # ---------- 提示词 ----------
    @app.get("/api/prompts")
    def list_prompts(category: Optional[str] = None,
                     prompt_type: Optional[str] = Query(None, alias="type")):
        return {"success": True, "data": prompts.list(category, prompt_type)}

    @app.post("/api/prompts")
    def create_prompt(payload: Dict):
        try:
            return {"success": True, "data": prompts.create(payload["name"], payload.get("category", "agent"),
                                                            payload.get("content", ""), payload.get("enabled", True),
                                                            prompt_type=payload.get("type", "task_instruction"))}
        except Exception as e:
            raise HTTPException(400, str(e)) from e

    @app.put("/api/prompts/{pid}")
    def update_prompt(pid: int, payload: Dict):
        try:
            return {"success": True, "data": prompts.update(pid, **payload)}
        except KeyError as e:
            raise HTTPException(404, str(e)) from e

    @app.delete("/api/prompts/{pid}")
    def delete_prompt(pid: int):
        try:
            prompts.delete(pid)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        except KeyError as e:
            raise HTTPException(404, str(e)) from e
        return {"success": True}

    @app.get("/api/prompts/{pid}/agents")
    def prompt_bound_agents(pid: int):
        """查询绑定了该系统角色提示词的 Agent 列表"""
        return {"success": True, "data": prompts.get_bound_agents(pid)}

    # ---------- 智能体（配置化注册） ----------
    @app.get("/api/agents")
    def list_api_agents(enabled_only: Optional[bool] = None):
        """查询智能体列表；enabled_only=true 时只返回启用状态（会话页顶部标签用）"""
        return {"success": True, "data": agents_svc.all(enabled_only=bool(enabled_only))}

    @app.post("/api/agents")
    def create_api_agent(payload: Dict):
        try:
            return {"success": True, "data": agents_svc.create(
                str(payload.get("agent_id", "")).strip(),
                str(payload.get("name", "")).strip(),
                str(payload.get("description", "")).strip(),
                str(payload.get("intent", "")).strip(),
                default_prompt=str(payload.get("default_prompt", "")),
                output_files=payload.get("output_files"),
                gen_artifact=bool(payload.get("gen_artifact", False)),
                enabled=bool(payload.get("enabled", True)),
                system_role_prompt_id=payload.get("system_role_prompt_id"),
                agent_type=str(payload.get("agent_type", "子Agent")),
                tools=payload.get("tools"),
                bound_kbs=payload.get("bound_kbs"),
                alias=str(payload.get("alias", "")).strip(),
                project_dir=str(payload.get("project_dir", "")).strip())}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.put("/api/agents/{aid}")
    def update_api_agent(aid: str, payload: Dict):
        """更新 agent 配置（前端 api.updateAgent 即调用此接口）"""
        try:
            return {"success": True, "data": agents_svc.update(aid, **payload)}
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @app.post("/api/agents/{aid}/toggle")
    def toggle_api_agent(aid: str, payload: Dict):
        try:
            agents_svc.set_enabled(aid, bool(payload.get("enabled", False)))
            return {"success": True}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/agents/{aid}")
    def delete_api_agent(aid: str):
        agents_svc.delete(aid)
        return {"success": True}

    @app.get("/api/agents/{aid}/workspace/summary")
    @_workspace_handler
    def agent_workspace_summary(aid: str):
        return {"success": True, "data": workspaces.summary(aid)}

    @app.get("/api/agents/{aid}/workspace/changes")
    @_workspace_handler
    def agent_workspace_changes(aid: str):
        return {"success": True, "data": workspaces.changes(aid)}

    @app.get("/api/agents/{aid}/workspace/tree")
    @_workspace_handler
    def agent_workspace_tree(aid: str, path: str = ""):
        return {"success": True, "data": workspaces.tree(aid, path)}

    @app.get("/api/agents/{aid}/workspace/file")
    @_workspace_handler
    def agent_workspace_file(aid: str, path: str):
        return {"success": True, "data": workspaces.file(aid, path)}

    @app.get("/api/agents/{aid}/workspace/file/diff")
    @_workspace_handler
    def agent_workspace_diff(aid: str, path: str):
        return {"success": True, "data": workspaces.diff(aid, path)}

    @app.get("/api/agents/{aid}/workspace/evidence")
    @_workspace_handler
    def agent_workspace_evidence(aid: str, conv_id: Optional[int] = None,
                                 limit: int = 100):
        return {"success": True,
                "data": workspaces.evidence(aid, conv_id, limit)}

    # ---------- 数据源（只读） ----------
    @app.get("/api/datasources")
    def list_datasources(space_id: Optional[int] = None,
                         sub_system_id: Optional[int] = None):
        if sub_system_id is not None and space_id is None:
            raise HTTPException(400, "按子系统过滤数据源时须同时指定空间")
        return {"success": True, "data": db_tools.list(space_id, sub_system_id)}

    @app.post("/api/datasources/upload")
    async def upload_datasource_file(file: UploadFile = File(...),
                                     name: str = Form(""),
                                     space_id: Optional[int] = Form(None),
                                     sub_system_id: Optional[int] = Form(None)):
        """上传 Excel/CSV 文件创建数据源（用于导入工程结构、配置清单等离线资料）"""
        name = (name or "").strip()
        if not name:
            raise HTTPException(400, "请输入数据源名称")
        fname = file.filename or "upload.xlsx"
        ext = Path(fname).suffix.lstrip(".").lower()
        if ext not in ("xlsx", "xls", "csv"):
            raise HTTPException(400, f"不支持的 Excel 文件类型: .{ext}（支持 xlsx/xls/csv）")
        raw = await file.read()
        if len(raw) > 20 * 1024 * 1024:
            raise HTTPException(400, "文件超过 20MB")
        ds_dir = Path(db_path).parent / "datasource_files"
        ds_dir.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^\w\u4e00-\u9fff-]", "_", name)
        target = (ds_dir / f"{safe}_{int(datetime.now().timestamp())}.{ext}").resolve()
        target.write_bytes(raw)
        try:
            return {"success": True, "data": db_tools.create(
                name, kind="excel", location=str(target),
                space_id=space_id, sub_system_id=sub_system_id)}
        except ValueError as e:
            target.unlink(missing_ok=True)
            raise HTTPException(400, str(e))

    @app.post("/api/datasources")
    def create_datasource(payload: Dict):
        try:
            return {"success": True, "data": db_tools.create(
                str(payload.get("name", "")).strip(),
                str(payload.get("kind", "sqlite")).strip(),
                str(payload.get("location", "")),
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                str(payload.get("dsn", "")),
                bool(payload.get("enabled", True)),
                payload.get("space_id"), payload.get("sub_system_id"))}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/datasources/{name}/toggle")
    def toggle_datasource(name: str, payload: Dict):
        try:
            db_tools.set_enabled(name, bool(payload.get("enabled", False)))
            return {"success": True}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.put("/api/datasources/{name}")
    def update_datasource(name: str, payload: Dict):
        """更新数据源配置（支持改名：payload.name 为新名称，路径 name 为旧名称）"""
        try:
            return {"success": True, "data": db_tools.update(
                str(name).strip(),
                str(payload.get("name") or name or "").strip(),
                str(payload.get("kind", "sqlite")).strip(),
                str(payload.get("location", "")),
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                str(payload.get("dsn", "")),
                bool(payload.get("enabled", True)),
                payload.get("space_id"), payload.get("sub_system_id"))}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/datasources/{name}")
    def delete_datasource(name: str):
        db_tools.delete(name)
        return {"success": True}

    @app.post("/api/datasources/{name}/test")
    def test_datasource(name: str):
        """测试数据源连接并探查对象清单"""
        try:
            r = db_tools.inspect_schema(name)
            return {"success": True, "data": r}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/datasources/{name}/query")
    def query_datasource(name: str, payload: Dict):
        sql = str(payload.get("sql", ""))
        limit = payload.get("limit")
        try:
            r = db_tools.query(name, sql, limit=int(limit) if limit else 100)
            return {"success": True, "data": r}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/datasources/{name}/explain")
    def explain_datasource(name: str, payload: Dict):
        """只读语法校验（EXPLAIN，不返回数据），用于确认 SQL 合法"""
        sql = str(payload.get("sql", ""))
        try:
            r = db_tools.explain(name, sql)
            return {"success": True, "data": r}
        except ValueError as e:
            raise HTTPException(400, str(e))

    # ---------- 技能 ----------
    @app.get("/api/skills")
    def list_skills():
        return {"success": True, "data": skills.list()}

    @app.post("/api/skills")
    def create_skill(payload: Dict):
        try:
            if "text" in payload:  # 直接以 SKILL.md 文本创建（frontmatter 支持 name/description/script/chain）
                return {"success": True, "data": skills.create_from_md(payload["text"])}
            return {"success": True, "data": skills.create(
                payload["name"], payload.get("description", ""), payload.get("content", ""),
                script=payload.get("script"), chain=payload.get("chain"))}
        except (ValueError, KeyError) as e:
            raise HTTPException(400, str(e)) from e

    @app.post("/api/skills/{sid}/script")
    async def upload_skill_script(sid: str, file: UploadFile = File(...)):
        """上传技能脚本文件到 skills/<sid>/scripts/，并更新 SKILL.md 的 script 字段"""
        from pathlib import Path as _P
        fname = _P(file.filename or "").name
        if not fname or fname != (file.filename or ""):
            raise HTTPException(400, "脚本文件名不合法（不得含路径）")
        if len(fname) > 128:
            raise HTTPException(400, "脚本文件名过长")
        raw = await file.read()
        if len(raw) > 2 * 1024 * 1024:
            raise HTTPException(400, "脚本文件超过 2MB 限制")
        try:
            sdir = skills._scripts_dir(sid)
        except ValueError as e:
            raise HTTPException(400, str(e))
        script_path = (sdir / fname).resolve()
        if not str(script_path).startswith(str(sdir.resolve())):
            raise HTTPException(400, "脚本路径越界")
        script_path.write_bytes(raw)
        try:
            info = skills.get(sid)
            if info is None:
                raise KeyError(sid)
        except KeyError:
            raise HTTPException(404, "技能不存在")
        skills.update_md_script(sid, fname)
        return {"success": True, "data": {"skill_id": sid, "script": fname}}

    @app.post("/api/skills/{sid}/run")
    def run_skill_script(sid: str, payload: Dict):
        """执行技能脚本或技能链，返回 stdout/stderr"""
        try:
            info = skills.get(sid)
            if info is None:
                raise KeyError(sid)
            if info.get("chain"):
                return {"success": True, "data": skills.run_chain(
                    sid, args=payload.get("args", ""))}
            return {"success": True, "data": skills.run_script(sid, args=payload.get("args", ""),
                                                               timeout=payload.get("timeout", 30))}
        except (ValueError, KeyError) as e:
            raise HTTPException(400, str(e)) from e

    @app.put("/api/skills/{sid}")
    def update_skill(sid: str, payload: Dict):
        try:
            return {"success": True, "data": skills.update(sid, payload["name"],
                                                          payload.get("description", ""),
                                                          payload.get("content", ""))}
        except KeyError as e:
            raise HTTPException(404, str(e)) from e

    @app.post("/api/skills/{sid}/toggle")
    def toggle_skill(sid: str, payload: Dict):
        try:
            return {"success": True, "data": skills.set_enabled(sid, bool(payload.get("enabled", False)))}
        except KeyError as e:
            raise HTTPException(404, str(e)) from e

    @app.delete("/api/skills/{sid}")
    def delete_skill(sid: str):
        skills.delete(sid)
        return {"success": True}

    # ---------- 模板中心 ----------
    def _template_dict(r: TemplateRecord) -> Dict:
        return {
            "id": r.id, "name": r.name, "type": r.type or "task",
            "description": r.description or "",
            "tags": json.loads(r.tags) if r.tags else [],
            "is_public": bool(r.is_public), "creator": r.creator or "",
            "created_at": r.created_at.date().isoformat() if r.created_at else None,
            **(json.loads(r.config) if r.config else {}),
        }

    @app.get("/api/templates")
    def list_templates(type: Optional[str] = None):
        from sqlalchemy import select
        with db.session() as s:
            q = s.query(TemplateRecord)
            if type:
                q = q.filter(TemplateRecord.type == type)
            rows = list(q.order_by(TemplateRecord.id.desc()).all())
            return {"success": True, "data": [_template_dict(r) for r in rows]}

    @app.post("/api/templates")
    def create_template(payload: Dict):
        if not (payload.get("name") or "").strip():
            raise HTTPException(400, "模板名称不能为空")
        config_keys = ("default_name", "skill", "datasource_ids", "agent_ids",
                       "kb_ids", "mcp_ids", "auto_import", "prompt")
        config = {k: payload[k] for k in config_keys if k in payload}
        with db.session() as s:
            r = TemplateRecord(
                name=payload["name"].strip(),
                type=payload.get("type", "task"),
                description=payload.get("description", ""),
                tags=json.dumps(payload.get("tags", []), ensure_ascii=False),
                is_public=bool(payload.get("is_public", False)),
                creator=payload.get("creator", "admin"),
                config=json.dumps(config, ensure_ascii=False),
            )
            s.add(r)
            s.commit()
            return {"success": True, "data": _template_dict(r)}

    @app.put("/api/templates/{tid}")
    def update_template(tid: int, payload: Dict):
        config_keys = ("default_name", "skill", "datasource_ids", "agent_ids",
                       "kb_ids", "mcp_ids", "auto_import", "prompt")
        with db.session() as s:
            r = s.get(TemplateRecord, tid)
            if r is None:
                raise HTTPException(404, "模板不存在")
            if "name" in payload:
                r.name = (payload["name"] or "").strip() or r.name
            for k in ("type", "description"):
                if k in payload:
                    setattr(r, k, payload[k])
            if "tags" in payload:
                r.tags = json.dumps(payload["tags"], ensure_ascii=False)
            if "is_public" in payload:
                r.is_public = bool(payload["is_public"])
            config = json.loads(r.config) if r.config else {}
            for k in config_keys:
                if k in payload:
                    config[k] = payload[k]
            r.config = json.dumps(config, ensure_ascii=False)
            s.commit()
            return {"success": True, "data": _template_dict(r)}

    @app.delete("/api/templates/{tid}")
    def delete_template(tid: int):
        with db.session() as s:
            r = s.get(TemplateRecord, tid)
            if r is not None:
                s.delete(r)
                s.commit()
        return {"success": True}

    @app.post("/api/templates/{tid}/duplicate")
    def duplicate_template(tid: int):
        with db.session() as s:
            r = s.get(TemplateRecord, tid)
            if r is None:
                raise HTTPException(404, "模板不存在")
            dup = TemplateRecord(
                name=f"{r.name}（副本）", type=r.type, description=r.description,
                tags=r.tags, is_public=False, creator=r.creator, config=r.config)
            s.add(dup)
            s.commit()
            return {"success": True, "data": _template_dict(dup)}

    # ---------- 向量库 ----------
    @app.get("/api/vector/stats")
    def vector_stats():
        """FAISS 向量库真实统计：按知识库空间聚合（文档数/chunk 数/索引占用）"""
        from jarvis_agent.db import DocumentRecord
        from sqlalchemy import func, select
        # 全局索引状态
        ntotal = 0
        dim = 0
        index_files = list(rag._dir.glob("*.faiss")) if getattr(rag, "_dir", None) else []
        storage_bytes = sum(f.stat().st_size for f in index_files)
        try:
            if rag._index is not None and rag._index.ntotal:
                ntotal = int(rag._index.ntotal)
                dim = int(rag._index.d)
            status = "正常" if ntotal > 0 else "无向量数据"
        except Exception:
            status = "索引异常"
        # 按空间聚合 chunk 数（以 FAISS metadata 中 space_id 为准，入库时写入）
        per_space: Dict[int, int] = {}
        for m in (rag._metadata or []):
            sp = m.get("space_id")
            if sp is not None:
                per_space[int(sp)] = per_space.get(int(sp), 0) + 1
        with db.session() as s:
            spaces = list(s.query(Space).order_by(Space.id.asc()).all())
            doc_counts = dict(
                (row[0], row[1]) for row in s.query(
                    DocumentRecord.space_id, func.count(DocumentRecord.id)
                ).filter(DocumentRecord.enabled == True).group_by(DocumentRecord.space_id).all()
            )
            chunk_counts = dict(
                (row[0], row[1] or 0) for row in s.query(
                    DocumentRecord.space_id, func.sum(DocumentRecord.chunk_count)
                ).filter(DocumentRecord.enabled == True).group_by(DocumentRecord.space_id).all()
            )
        data = []
        for sp in spaces:
            kb_chunks = int(chunk_counts.get(sp.id, 0))
            data.append({
                "id": sp.id, "name": sp.name, "key": f"space_{sp.id}",
                "docCount": int(doc_counts.get(sp.id, 0)),
                "chunkCount": kb_chunks,
                "vectorCount": int(per_space.get(sp.id, kb_chunks)),
                "storageMB": round(storage_bytes / 1024 / 1024, 1),
                "status": status,
            })
        return {"success": True, "data": data, "summary": {
            "total_vectors": ntotal, "dimension": dim, "status": status,
            "storage_mb": round(storage_bytes / 1024 / 1024, 1),
        }}

    # ---------- 知识库 ----------
    @app.get("/api/kb/spaces")
    def list_kb_spaces():
        """知识库空间列表（含文档数/分块数统计）"""
        from jarvis_agent.db import Space, DocumentRecord
        from sqlalchemy import func, select
        with db.session() as s:
            spaces = list(s.query(Space).order_by(Space.id.asc()).all())
            result = []
            for sp in spaces:
                doc_count = s.query(func.count(DocumentRecord.id)).filter(
                    DocumentRecord.space_id == sp.id, DocumentRecord.enabled == True
                ).scalar() or 0
                chunk_count = s.query(func.sum(DocumentRecord.chunk_count)).filter(
                    DocumentRecord.space_id == sp.id, DocumentRecord.enabled == True
                ).scalar() or 0
                result.append({
                    "id": sp.id, "name": sp.name, "description": sp.description or "",
                    "doc_count": doc_count, "chunk_count": chunk_count,
                    "enabled": True, "created_at": sp.created_at.isoformat() if sp.created_at else None,
                })
            return {"success": True, "data": result}

    @app.post("/api/kb/spaces")
    def create_kb_space(payload: Dict):
        """创建知识库空间"""
        from jarvis_agent.db import Space
        name = (payload.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "空间名称不能为空")
        with db.session() as s:
            existing = s.query(Space).filter(Space.name == name).first()
            if existing:
                raise HTTPException(400, f"空间 {name} 已存在")
            sp = Space(name=name, description=payload.get("description", ""))
            s.add(sp)
            s.commit()
            s.refresh(sp)
            return {"success": True, "data": {"id": sp.id, "name": sp.name}}

    @app.delete("/api/kb/spaces/{space_id}")
    def delete_kb_space(space_id: int):
        """删除知识库空间（仅删除空间记录，不删除文档）"""
        from jarvis_agent.db import Space
        with db.session() as s:
            sp = s.get(Space, space_id)
            if not sp:
                raise HTTPException(404, "空间不存在")
            s.delete(sp)
            s.commit()
            return {"success": True}

    # ---------- 知识库（独立实体，绑定智能体，不属于空间） ----------
    @app.get("/api/kbs")
    def list_kbs():
        from sqlalchemy import func, select
        from jarvis_agent.db import AgentDef, AgentKB, DocumentRecord, KnowledgeBase
        with db.session() as s:
            rows = list(s.scalars(select(KnowledgeBase).order_by(KnowledgeBase.id)))
            kb_ids = [int(r.id) for r in rows]
            bindings: dict[int, list[tuple[str, str]]] = {kb_id: [] for kb_id in kb_ids}
            binding_rows = s.query(AgentKB, AgentDef).join(
                AgentDef, AgentDef.agent_id == AgentKB.agent_id
            ).filter(AgentKB.enabled == True).order_by(AgentDef.name.asc()).all()
            for binding, agent in binding_rows:
                bindings.setdefault(int(binding.kb_id), []).append(
                    (str(agent.agent_id), agent.name or agent.agent_id)
                )
            doc_counts: dict[int, int] = {}
            chunk_counts: dict[int, int] = {}
            if kb_ids:
                doc_rows = s.query(
                    DocumentRecord.kb_id, func.count(DocumentRecord.id)
                ).filter(
                    DocumentRecord.kb_id.in_(kb_ids), DocumentRecord.enabled == True
                ).group_by(DocumentRecord.kb_id).all()
                doc_counts = {int(kb_id): int(count) for kb_id, count in doc_rows}
                chunk_rows = s.query(
                    DocumentRecord.kb_id, func.sum(DocumentRecord.chunk_count)
                ).filter(
                    DocumentRecord.kb_id.in_(kb_ids), DocumentRecord.enabled == True
                ).group_by(DocumentRecord.kb_id).all()
                chunk_counts = {int(kb_id): int(total or 0) for kb_id, total in chunk_rows}
            return {"success": True, "data": [{
                "id": r.id, "name": r.name, "description": r.description or "",
                "owner_agent_id": r.owner_agent_id or "",
                "doc_count": doc_counts.get(int(r.id), 0),
                "chunk_count": chunk_counts.get(int(r.id), 0),
                "enabled": True,
                "bound_agent_ids": [agent_id for agent_id, _ in bindings.get(int(r.id), [])],
                "bound_agent_names": [name for _, name in bindings.get(int(r.id), [])],
                "created_at": r.created_at.isoformat() if r.created_at else None,
            } for r in rows]}

    @app.post("/api/kbs")
    def create_kb(payload: Dict):
        from sqlalchemy import select

        from jarvis_agent.db import KnowledgeBase
        name = str(payload.get("name", "")).strip()
        if not name:
            raise HTTPException(400, "知识库名称不能为空")
        with db.session() as s:
            if s.scalar(select(KnowledgeBase).where(KnowledgeBase.name == name)):
                raise HTTPException(400, f"知识库 {name} 已存在")
            row = KnowledgeBase(name=name,
                                description=str(payload.get("description", "")).strip(),
                                owner_agent_id=str(payload.get("owner_agent_id", "")).strip())
            s.add(row)
            s.commit()
            s.refresh(row)
            return {"success": True, "data": {"id": row.id, "name": row.name}}

    @app.delete("/api/kbs/{kid}")
    def delete_kb(kid: int):
        from sqlalchemy import delete as sa_delete

        from jarvis_agent.db import AgentKB, KnowledgeBase
        with db.session() as s:
            kb = s.get(KnowledgeBase, kid)
            if not kb:
                raise HTTPException(404, "知识库不存在")
            s.execute(sa_delete(AgentKB).where(AgentKB.kb_id == kid))
            s.delete(kb)
            s.commit()
        return {"success": True}

    @app.get("/api/kb/documents")
    def list_docs(space_id: Optional[int] = None, sub_system_id: Optional[int] = None,
                  kb_id: Optional[int] = None,
                  business_domain: str = "", kb_type: str = "", confidence: str = "",
                  review_required: Optional[bool] = None):
        with db.session() as s:
            from sqlalchemy import select
            from jarvis_agent.db import DocumentRecord
            q = select(DocumentRecord)
            if space_id:
                q = q.where(DocumentRecord.space_id == space_id)
            if sub_system_id:
                q = q.where(DocumentRecord.sub_system_id == sub_system_id)
            if kb_id:
                q = q.where(DocumentRecord.kb_id == kb_id)
            if business_domain:
                q = q.where(DocumentRecord.business_domain == business_domain)
            if kb_type:
                q = q.where(DocumentRecord.kb_type == kb_type)
            if confidence:
                q = q.where(DocumentRecord.confidence == confidence)
            if review_required is not None:
                q = q.where(DocumentRecord.review_required == review_required)
            rows = list(s.scalars(q.order_by(DocumentRecord.id.desc())))
            return {"success": True, "data": [{
                "id": r.id, "name": r.name, "source_type": r.source_type,
                "chunk_count": r.chunk_count, "enabled": r.enabled,
                "space_id": r.space_id, "sub_system_id": r.sub_system_id,
                "kb_id": r.kb_id,
                "kb_type": r.kb_type or "doc",
                "business_domain": r.business_domain or "jarvis_iter",
                "target_db": r.target_db or "", "stage": r.stage or "",
                "object_type": r.object_type or "",
                "confidence": r.confidence or "verified",
                "source": r.source or "upload", "source_ref": r.source_ref or "",
                "effective_time": r.effective_time.isoformat() if r.effective_time else None,
                "negative_feedback_count": int(r.negative_feedback_count or 0),
                "review_required": bool(r.review_required),
                "created_at": r.created_at.isoformat(),
            } for r in rows]}

    @app.post("/api/kb/documents")
    async def upload_doc(file: UploadFile = File(...),
                         space_id: Optional[int] = Form(None),
                         sub_system_id: Optional[int] = Form(None),
                         kb_id: Optional[int] = Form(None),
                         kb_type: Optional[str] = Form("doc"),
                         business_domain: str = Form("jarvis_iter"),
                         target_db: str = Form(""),
                         stage: str = Form(""),
                         object_type: str = Form(""),
                         confidence: str = Form("verified"),
                         source: str = Form("upload"),
                         source_ref: str = Form(""),
                         effective_time: Optional[str] = Form(None)):
        name = file.filename or "unnamed"
        ext = Path(name).suffix.lstrip(".").lower()
        if ext not in ("md", "sql", "txt", "pdf", "docx"):
            raise HTTPException(400, f"不支持的文档类型: {ext}（支持 md/sql/txt/pdf/docx）")
        kb_type = (kb_type or "doc").strip()
        if kb_type not in ("rules", "cases", "doc", "ops"):
            kb_type = "doc"  # 分层知识库：rules 规则库 / cases 案例库 / doc 归档文档 / ops 运维手册
        confidence = (confidence or "verified").strip()
        if confidence not in ("verified", "human_authority", "pending_review", "model_generated"):
            raise HTTPException(400, "无效的可信度标识")
        effective_at = None
        if effective_time:
            try:
                effective_at = datetime.fromisoformat(effective_time)
            except ValueError:
                raise HTTPException(400, "无效的生效时间")
        raw = await file.read()
        max_upload_mb = 50
        if len(raw) > max_upload_mb * 1024 * 1024:
            raise HTTPException(400, f"文件超过 {max_upload_mb}MB")
        kb_dir = Path(db_path).parent / "kb_files"
        kb_dir.mkdir(parents=True, exist_ok=True)
        target = kb_dir / name
        if ext == "pdf":
            # 保存原始 PDF 用于溯源，同时提取文本供向量化（落盘为同名 .txt）
            target.write_bytes(raw)
            from jarvis_agent.rag import extract_pdf_text
            try:
                text = extract_pdf_text(raw)
            except Exception:
                raise HTTPException(400, "PDF 文件解析失败（文件可能损坏或加密）")
            if not text.strip():
                # 文本型提取失败 → 尝试阿里云 OCR（扫描件/图片型 PDF 降级）
                from jarvis_agent.ocr import ocr_pdf
                text = ocr_pdf(raw) or ""
                if not text.strip():
                    raise HTTPException(400, "未能从 PDF 中提取到文本（OCR 服务不可用或文件为空）")
            target = kb_dir / f"{Path(name).stem}.txt"
            target.write_text(text, encoding="utf-8")
        elif ext == "docx":
            # 保存原始 docx 用于溯源，同时提取文本供向量化（落盘为同名 .txt）
            target.write_bytes(raw)
            from jarvis_agent.attachments import _extract_docx
            try:
                text = _extract_docx(raw)
            except Exception as e:
                raise HTTPException(400, str(e) or "DOCX 文件解析失败")
            target = kb_dir / f"{Path(name).stem}.txt"
            target.write_text(text, encoding="utf-8")
        else:
            target.write_bytes(raw)
        with db.session() as s:
            from jarvis_agent.db import DocumentRecord
            if kb_id:
                from jarvis_agent.db import KnowledgeBase
                if s.get(KnowledgeBase, kb_id) is None:
                    raise HTTPException(404, "知识库不存在")
            rec = DocumentRecord(name=name, source_type=ext, doc_path=str(target),
                                 space_id=space_id, sub_system_id=sub_system_id,
                                 kb_id=kb_id,
                                 kb_type=kb_type)
            s.add(rec)
            s.commit()
            s.refresh(rec)
            doc_id = rec.id
        chunks = 0
        embed_error = ""
        try:
            info = rag.add_document(doc_id, name, ext, str(target), space_id=space_id,
                                    kb_id=kb_id,
                                    kb_type=kb_type,
                                    business_domain=business_domain,
                                    target_db=target_db, stage=stage,
                                    object_type=object_type, confidence=confidence,
                                    source=source, source_ref=source_ref,
                                    effective_time=effective_at)
            chunks = info.get("chunks", 0)
        except Exception as e:
            embed_error = str(e)[:200]
        return {"success": True, "data": {"id": doc_id, "chunks": chunks, "embed_error": embed_error}}

    @app.delete("/api/kb/documents/{doc_id}")
    def delete_doc(doc_id: int):
        rag.delete_document(doc_id)
        return {"success": True}

    @app.get("/api/kb/documents/{doc_id}/chunks")
    def doc_chunks(doc_id: int):
        """文档 Chunk 列表（FAISS metadata 按文档过滤）"""
        out = []
        for m in (rag._metadata or []):
            if str(m.get("doc_id")) == str(doc_id):
                out.append({
                    "chunk_id": f"{m.get('doc_id')}-{m.get('chunk_index')}",
                    "chunk_index": m.get("chunk_index", 0),
                    "content": m.get("content", ""),
                    "chars": len(m.get("content", "") or ""),
                })
        out.sort(key=lambda c: c["chunk_index"])
        return {"success": True, "data": out}

    @app.get("/api/kb/search")
    def kb_search(q: str, top_k: int = 4, space_id: Optional[int] = None,
                  kb_id: Optional[int] = None):
        return {"success": True, "data": rag.search(
            q, top_k, space_id=space_id,
            kb_ids=[kb_id] if kb_id is not None else None,
        )}

    @app.post("/api/knowledge/search")
    def knowledge_search(payload: Dict):
        """统一知识检索 API：保留诊断信息、候选与溯源字段。"""
        query = (payload.get("query") or payload.get("q") or "").strip()
        if not query:
            raise HTTPException(400, "检索内容不能为空")
        kb_types = payload.get("kb_types")
        if kb_types is not None and not isinstance(kb_types, list):
            raise HTTPException(400, "kb_types 必须是数组")
        candidate_k = int(payload.get("candidate_k", 20))
        min_similarity = float(payload.get("min_similarity", 0.35))
        try:
            result = rag._search_core(
                query,
                top_k=int(payload.get("top_k", 4)),
                space_id=payload.get("space_id"),
                kb_ids=[payload["kb_id"]] if payload.get("kb_id") is not None else None,
                kb_types=kb_types,
                source_db=payload.get("source_db", ""),
                target_db=payload.get("target_db", ""),
                business_domain=payload.get("business_domain", "jarvis_iter"),
                stage=payload.get("stage", ""),
                object_type=payload.get("object_type", ""),
                candidate_k=candidate_k,
                min_similarity=min_similarity,
            )
        except (TypeError, ValueError):
            raise HTTPException(400, "检索参数无效")
        result.update({
            "query": query,
            "candidate_k": candidate_k,
            "min_similarity": min_similarity,
        })
        return {"success": True, "data": result}

    @app.post("/api/knowledge/feedback")
    def knowledge_feedback(payload: Dict):
        try:
            result = rag.record_feedback(
                int(payload.get("doc_id", 0)),
                feedback=str(payload.get("feedback", "")),
                reason=str(payload.get("reason", "")),
            )
        except (TypeError, ValueError) as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": result}

    # ---------- 知识图谱 ----------
    @app.get("/api/kg/overview")
    def kg_overview():
        return {"success": True, "data": kg.overview()}

    @app.post("/api/kg/rebuild")
    def kg_rebuild():
        stat = kg.build_from_documents()
        return {"success": True, "data": stat}

    @app.get("/api/kg/expand")
    def kg_expand(q: str = "", raw: str = "", limit: int = 15):
        corpus = (raw or "") or q
        terms = kg.match_entities(corpus, limit=10)
        triples = kg.expand(terms, limit=limit)
        return {"success": True, "data": {"terms": terms, "triples": triples}}

    @app.get("/api/kg/entities")
    def kg_entities(q: str = "", limit: int = 20):
        """知识图谱实体检索：按 name 模糊匹配（q 为空返回最近 N 条），供前端 @ 选择实体"""
        limit = max(1, min(int(limit or 20), 100))
        from sqlalchemy import select
        from jarvis_agent.db import KGEntity
        with db.session() as s:
            qs = (q or "").strip()
            if qs:
                rows = list(s.scalars(select(KGEntity)
                                      .where(KGEntity.name.like(f"%{qs}%"))
                                      .order_by(KGEntity.id.desc()).limit(limit)))
            else:
                rows = list(s.scalars(select(KGEntity)
                                      .order_by(KGEntity.id.desc()).limit(limit)))
            return {"success": True,
                    "data": [{"name": r.name, "etype": r.etype} for r in rows]}

    # ---------- 空间 / 子系统 / 业务任务（任务↔空间 归属体系） ----------
    @app.get("/api/spaces")
    def list_spaces():
        return {"success": True, "data": proj.list_spaces()}

    @app.post("/api/spaces")
    @_project_handler
    def create_space(payload: Dict):
        return {"success": True, "data": proj.create_space(
            str(payload.get("name", "")), str(payload.get("description", "")),
            payload.get("kb_ids"))}

    @app.get("/api/spaces/default")
    @_project_handler
    def get_default_space():
        return {"success": True, "data": proj.ensure_default_space()}

    @app.get("/api/spaces/{sid}")
    @_project_handler
    def get_space(sid: int):
        return {"success": True, "data": proj.get_space(sid)}

    @app.put("/api/spaces/{sid}")
    @_project_handler
    def update_space(sid: int, payload: Dict):
        return {"success": True, "data": proj.update_space(sid, payload)}

    @app.delete("/api/spaces/{sid}")
    @_project_handler
    def delete_space(sid: int):
        proj.delete_space(sid)
        return {"success": True}

    @app.post("/api/spaces/{sid}/subsystems")
    @_project_handler
    def create_subsystem(sid: int, payload: Dict):
        return {"success": True, "data": proj.create_subsystem(
            sid, str(payload.get("name", "")),
            str(payload.get("description", "")),
            str(payload.get("owner", "")),
            payload.get("tags"))}

    @app.get("/api/spaces/{sid}/subsystems/{ssid}")
    @_project_handler
    def get_subsystem(sid: int, ssid: int):
        return {"success": True, "data": proj.get_subsystem(sid, ssid)}

    @app.get("/api/spaces/{sid}/subsystems/{ssid}/stats")
    @_project_handler
    def subsystem_stats(sid: int, ssid: int):
        return {"success": True, "data": proj.subsystem_stats(sid, ssid)}

    @app.put("/api/spaces/{sid}/subsystems/{ssid}")
    @_project_handler
    def update_subsystem(sid: int, ssid: int, payload: Dict):
        return {"success": True, "data": proj.update_subsystem(sid, ssid, payload)}

    @app.delete("/api/spaces/{sid}/subsystems/{ssid}")
    @_project_handler
    def delete_subsystem(sid: int, ssid: int):
        proj.delete_subsystem(sid, ssid)
        return {"success": True}

    @app.get("/api/tasks")
    def list_tasks(space_id: Optional[int] = None, status: Optional[str] = None,
                   sub_system_id: Optional[int] = None):
        return {"success": True, "data": proj.list_tasks(space_id, status, sub_system_id)}

    @app.post("/api/tasks")
    @_project_handler
    def create_task(payload: Dict):
        return {"success": True, "data": proj.create_task(
            int(payload["space_id"]), str(payload.get("name", "")),
            sub_system_id=None, description=str(payload.get("description", "")),
            kb_ids=payload.get("kb_ids"), agent_id=str(payload.get("agent_id", "")),
            creator=str(payload.get("creator", "")))}

    @app.get("/api/tasks/{tid}")
    @_project_handler
    def get_task(tid: int):
        return {"success": True, "data": proj.get_task(tid)}

    @app.get("/api/tasks/{tid}/migrate-task")
    def get_task_migrate_task(tid: int):
        """通过业务任务 ID 查找关联的跨工程迭代任务，返回与工作台编排面板一致的任务详情：
        优先级：
        1. 任务下会话 task_state JSON 中的 migrate_task_id（权威关联）；
        2. 迭代任务的显式 project_task_id（状态机权威归属）。"""
        import json as _json
        from jarvis_agent.db import Conversation, JarvisTask
        from sqlalchemy import select

        def _pack(row) -> Dict:
            data = jarvis_state.to_dict(row)
            _with_migrate_execution_state(data, db)
            return data

        with db.session() as s:
            convs = list(s.scalars(
                select(Conversation).where(Conversation.task_id == tid).order_by(Conversation.id)))
        with db.session() as s:
            owned_row = s.scalar(select(JarvisTask).where(
                JarvisTask.project_task_id == tid
            ).order_by(JarvisTask.id.desc()))
        if owned_row is not None:
            return {"success": True, "data": _pack(owned_row)}
        for c in convs:
            # 1. 权威：会话 task_state JSON 中的 migrate_task_id
            ts_raw = (c.task_state or "").strip()
            if ts_raw:
                try:
                    ts = _json.loads(ts_raw)
                    mid = ts.get("migrate_task_id") if isinstance(ts, dict) else None
                    if mid:
                        row = jarvis_state.get(int(mid))
                        if row is not None:
                            return {"success": True, "data": _pack(row)}
                except Exception:
                    pass
            # 2. 迭代任务 conv_id 若存的是会话 ID
            row = jarvis_state.get_by_conv(c.id)
            if row is not None:
                return {"success": True, "data": _pack(row)}
        return {"success": True, "data": None}

    @app.put("/api/tasks/{tid}")
    @_project_handler
    def update_task(tid: int, payload: Dict):
        return {"success": True, "data": proj.update_task(tid, payload)}

    @app.delete("/api/tasks/{tid}")
    @_project_handler
    def delete_task(tid: int):
        proj.delete_task(tid)
        return {"success": True}

    # ---------- 产物 ----------
    @app.get("/api/artifacts")
    def list_artifacts(conv_id: Optional[int] = None, namespace: Optional[str] = None,
                       task_id: Optional[int] = None, space_id: Optional[int] = None,
                       sub_system_id: Optional[int] = None, all: Optional[int] = None):
        from jarvis_agent.db import ArtifactRecord
        if all:
            # 工作台产物面板：返回全部产物记录
            from sqlalchemy import select
            with db.session() as s:
                rows = list(s.scalars(select(ArtifactRecord).order_by(ArtifactRecord.id.desc())))
            return {"success": True, "data": [artifacts._to_dict(r) for r in rows]}
        if task_id:
            return {"success": True, "data": artifacts.list_by_task(task_id)}
        if space_id or sub_system_id:
            # 按空间/子系统过滤产物记录（子系统页产物 Tab）
            from sqlalchemy import select
            with db.session() as s:
                q = select(ArtifactRecord)
                if space_id:
                    q = q.where(ArtifactRecord.space_id == space_id)
                if sub_system_id:
                    q = q.where(ArtifactRecord.sub_system_id == sub_system_id)
                rows = list(s.scalars(q.order_by(ArtifactRecord.id.desc())))
            return {"success": True, "data": [artifacts._to_dict(r) for r in rows]}
        if namespace:
            return {"success": True, "data": artifacts.list_files(namespace)}
        if conv_id is not None:
            # 会话页产物面板：返回该会话的全部产物文件记录
            from sqlalchemy import select
            with db.session() as s:
                rows = list(s.scalars(select(ArtifactRecord)
                                      .where(ArtifactRecord.conv_id == conv_id)
                                      .order_by(ArtifactRecord.id.desc())))
            return {"success": True, "data": [artifacts._to_dict(r) for r in rows]}
        namespaces = artifacts.list_namespaces(conv_id)
        return {"success": True, "data": namespaces}

    @app.get("/api/artifacts/{rid}/file")
    def artifact_file(rid: int):
        content = artifacts.read(rid)
        if content is None:
            raise HTTPException(404, "产物不存在")
        return JSONResponse({"success": True, "content": content})

    @app.get("/api/artifacts/{rid}/download")
    def artifact_download(rid: int):
        try:
            path = artifacts.file_path(rid)
        except ValueError:
            raise HTTPException(404, "产物不存在")
        if not path.exists():
            raise HTTPException(404, "产物文件不存在")
        return FileResponse(
            path,
            filename=path.name,
            media_type=(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                if path.suffix.lower() == ".xlsx" else "application/octet-stream"
            ),
        )

    @app.get("/api/products/{rid}/versions")
    def list_product_versions(rid: int):
        try:
            return {"success": True, "data": artifacts.list_versions(rid)}
        except ValueError as exc:
            raise HTTPException(404, str(exc))

    @app.get("/api/products/{rid}/versions/{version}")
    def get_product_version(rid: int, version: int):
        try:
            record = artifacts.version_record(rid, version)
            return {
                "success": True,
                "data": {**artifacts._to_dict(record),
                         "content": artifacts.read_version(rid, version) or ""},
            }
        except ValueError as exc:
            raise HTTPException(404, str(exc))

    @app.get("/api/products/{rid}/diff")
    def diff_product(rid: int, left: int, right: int):
        try:
            return {"success": True, "data": artifacts.diff(rid, left, right)}
        except ValueError as exc:
            raise HTTPException(404, str(exc))

    @app.get("/api/trace/{trace_id}")
    def trace_detail(trace_id: str, limit: int = 500):
        return {"success": True, "data": observability.list_trace(trace_id, limit)}

    @app.put("/api/artifacts/{rid}")
    def rename_artifact(rid: int, payload: Dict):
        """重命名产物（仅改展示名 object_name；文件、知识库副本不受影响）"""
        name = str(payload.get("object_name", "")).strip()
        if not name:
            raise HTTPException(400, "产物名称不能为空")
        from sqlalchemy import select
        from jarvis_agent.db import ArtifactRecord
        with db.session() as s:
            rec = s.get(ArtifactRecord, rid)
            if not rec:
                raise HTTPException(404, "产物不存在")
            rec.object_name = name
            s.commit()
            s.refresh(rec)
            return {"success": True, "data": artifacts._to_dict(rec)}

    @app.post("/api/artifacts/{rid}/import")
    def import_artifact(rid: int, payload: Dict):
        """把产物真实入库：复制文件到 kb_files → 写 kb_documents 记录 → 切片向量化。
        入库成功后产物源文件保留，前端通过 kb_doc_id 标记「已入库」"""
        from jarvis_agent.db import ArtifactRecord, DocumentRecord
        with db.session() as s:
            rec = s.get(ArtifactRecord, rid)
            if not rec:
                raise HTTPException(404, "产物不存在")
            if not rec.path or not Path(rec.path).exists():
                raise HTTPException(400, "产物文件不存在，无法入库")
            space_id = payload.get("space_id") or rec.space_id
            if not space_id:
                raise HTTPException(400, "产物未绑定空间，无法入库")
            doc_name = (payload.get("doc_name") or "").strip() or Path(rec.path).name
            ext = Path(rec.path).suffix.lstrip(".").lower() or "txt"
            if ext == "pdf":
                ext = "txt"
        # 复制到 kb_files（独立副本，产物删除不影响已入库文档）
        import uuid
        kb_dir = Path(db_path).parent / "kb_files"
        kb_dir.mkdir(parents=True, exist_ok=True)
        target = kb_dir / f"art_{rec.id}_{uuid.uuid4().hex[:6]}_{Path(doc_name).stem}.{ext}"
        target.write_text(Path(rec.path).read_text(encoding="utf-8"), encoding="utf-8")
        with db.session() as s:
            doc = DocumentRecord(name=doc_name, source_type=ext, doc_path=str(target),
                                 space_id=space_id, sub_system_id=rec.sub_system_id)
            s.add(doc)
            s.commit()
            s.refresh(doc)
            doc_id = doc.id
        info = rag.add_document(doc_id, doc_name, ext, str(target), space_id=space_id)
        # 回写产物记录：标记已入库 + 关联知识库文档
        with db.session() as s:
            rec = s.get(ArtifactRecord, rid)
            rec.kb_doc_id = doc_id
            s.commit()
        return {"success": True,
                "data": {"doc_id": doc_id, "name": doc_name, "chunks": info.get("chunks", 0)}}

    @app.delete("/api/artifacts/{rid}")
    def delete_artifact(rid: int):
        """删除产物记录与本地文件；已入库到知识库的文档不会被删除（独立隔离）"""
        import shutil
        from pathlib import Path as _Path
        from jarvis_agent.db import ArtifactRecord
        with db.session() as s:
            rec = s.get(ArtifactRecord, rid)
            if not rec:
                raise HTTPException(404, "产物不存在")
            if rec.path:
                try:
                    _Path(rec.path).unlink(missing_ok=True)
                except OSError:
                    pass
                # 顺带清理已空的 namespace 目录链（保留 artifact_root）
                d = _Path(rec.path).parent
                try:
                    while d.resolve() != artifacts.root.resolve() and d.is_dir() and not any(d.iterdir()):
                        shutil.rmtree(d, ignore_errors=True)
                        d = d.parent
                except OSError:
                    pass
            s.delete(rec)
            s.commit()
            return {"success": True}

    # ---------- MCP server（配置化预留 + 接入层） ----------
    @app.get("/api/mcp/servers")
    def list_mcp_servers():
        from sqlalchemy import select
        from jarvis_agent.db import MCPRecord
        with db.session() as s:
            rows = list(s.scalars(select(MCPRecord).order_by(MCPRecord.id)))
            return {"success": True, "data": [
                {"id": r.id, "name": r.name, "kind": r.kind,
                 "command_or_url": r.command_or_url, "enabled": r.enabled} for r in rows]}

    @app.post("/api/mcp/servers")
    def create_mcp_server(payload: Dict):
        from jarvis_agent.db import MCPRecord
        with db.session() as s:
            r = MCPRecord(name=payload.get("name", ""), kind=payload.get("kind", "http"),
                          command_or_url=payload.get("command_or_url", ""),
                          args=payload.get("args", ""), enabled=payload.get("enabled", True))
            s.add(r)
            s.commit()
            s.refresh(r)
            return {"success": True, "data": {"id": r.id, "name": r.name}}

    @app.post("/api/mcp/servers/{rid}/test")
    def test_mcp_server(rid: int):
        from jarvis_agent.db import MCPRecord
        with db.session() as s:
            r = s.get(MCPRecord, rid)
            if not r:
                raise HTTPException(404, "MCP server 不存在")
            import httpx
            try:
                httpx.get(r.command_or_url, timeout=3)
                return {"success": True, "message": "可达"}
            except Exception as e:
                return {"success": False, "message": f"不可达: {e}"}

    # ---------- 模型管理（模型管理菜单 / 对话模型下拉共用的持久化数据源） ----------

    @app.get("/api/models")
    def list_models(type: Optional[str] = None, enabled: Optional[int] = None):
        """模型管理列表；enabled=1 且 type=LLM 时用于对话输入框模型下拉"""
        from sqlalchemy import select
        from jarvis_agent.db import ModelDef
        with db.session() as s:
            q = select(ModelDef).order_by(ModelDef.id)
            if type:
                q = q.where(ModelDef.type == type)
            if enabled is not None:
                q = q.where(ModelDef.status == ("已启用" if enabled == 1 else "已停用"))
            rows = list(s.scalars(q))
            return {"success": True, "data": [{
                "id": r.id, "name": r.name, "model_id": r.model_id, "type": r.type,
                "provider": r.provider, "status": r.status, "api_url": r.api_url,
                "api_key": r.api_key, "version": r.version, "timeout": r.timeout,
                "max_tokens": r.max_tokens, "description": r.description,
                "total_calls": r.total_calls, "fail_count": r.fail_count,
                "used_by_agents": json.loads(r.used_by_agents or "[]"),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            } for r in rows]}

    @app.post("/api/models")
    def create_model(payload: Dict):
        from sqlalchemy import select
        from jarvis_agent.db import ModelDef
        name = str(payload.get("name", "")).strip()
        mid = str(payload.get("model_id", "")).strip()
        if not name:
            raise HTTPException(400, "请输入模型名称")
        if not mid:
            raise HTTPException(400, "请输入模型标识")
        with db.session() as s:
            if s.scalar(select(ModelDef).where(ModelDef.model_id == mid)):
                raise HTTPException(400, "模型标识已存在")
            r = ModelDef(
                name=name, model_id=mid,
                type=str(payload.get("type", "LLM")),
                provider=str(payload.get("provider", "API接口")),
                status=str(payload.get("status", "已启用")),
                api_url=str(payload.get("api_url", "")),
                api_key=str(payload.get("api_key", "")),
                version=str(payload.get("version", "")),
                timeout=int(payload.get("timeout") or 60),
                max_tokens=int(payload.get("max_tokens") or 4096),
                description=str(payload.get("description", "")),
                total_calls=0, fail_count=0,
                used_by_agents=json.dumps(payload.get("used_by_agents", []), ensure_ascii=False))
            s.add(r)
            s.commit()
            s.refresh(r)
            return {"success": True, "data": {"id": r.id, "name": r.name, "model_id": r.model_id}}

    @app.put("/api/models/{mid}")
    def update_model(mid: int, payload: Dict):
        from jarvis_agent.db import ModelDef
        with db.session() as s:
            r = s.get(ModelDef, mid)
            if not r:
                raise HTTPException(404, "模型不存在")
            if "name" in payload:
                r.name = str(payload["name"]).strip() or r.name
            if "type" in payload:
                r.type = str(payload["type"])
            if "provider" in payload:
                r.provider = str(payload["provider"])
            if "status" in payload:
                r.status = str(payload["status"])
            if "api_url" in payload:
                r.api_url = str(payload["api_url"])
            if "api_key" in payload:
                r.api_key = str(payload["api_key"])
            if "version" in payload:
                r.version = str(payload["version"])
            if "timeout" in payload:
                r.timeout = int(payload["timeout"])
            if "max_tokens" in payload:
                r.max_tokens = int(payload["max_tokens"])
            if "description" in payload:
                r.description = str(payload["description"])
            if "used_by_agents" in payload:
                r.used_by_agents = json.dumps(payload["used_by_agents"], ensure_ascii=False)
            s.commit()
            return {"success": True, "data": {"id": r.id, "name": r.name}}

    def _probe_model(mtype: str, model_id: str, api_url: str, api_key: str, timeout) -> Dict:
        """向 OpenAI 兼容服务商发起最小真实请求（LLM=1 token 对话 / Embedding=1 条向量）"""
        import time as _t
        import urllib.request as _ur
        base = (api_url or "").rstrip("/")
        if not base:
            return {"ok": False, "latency_ms": 0, "message": "连接失败：未配置 API 地址"}
        if mtype == "Embedding":
            url, body = f"{base}/embeddings", {"model": model_id, "input": ["ping"]}
        else:
            url, body = f"{base}/chat/completions", {
                "model": model_id, "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1, "stream": False}
        data = json.dumps(body).encode("utf-8")
        req = _ur.Request(url, data=data, method="POST",
                          headers={"Content-Type": "application/json",
                                   "Authorization": f"Bearer {api_key or ''}"})
        t0 = _t.time()
        try:
            with _ur.urlopen(req, timeout=min(int(timeout or 30), 30)) as resp:
                resp.read()
            latency = int((_t.time() - t0) * 1000)
            return {"ok": True, "latency_ms": latency, "message": f"连接成功（{latency}ms）"}
        except Exception as e:
            latency = int((_t.time() - t0) * 1000)
            detail = str(e)
            if hasattr(e, "read"):  # HTTPError 读取响应体中的错误说明
                try:
                    detail = e.read().decode("utf-8", "ignore")[:300]
                except Exception:
                    pass
            return {"ok": False, "latency_ms": latency, "message": f"连接失败：{detail}"}

    @app.post("/api/models/{mid}/test")
    def test_model(mid: int):
        """模型连接测试：按已保存配置向服务商发起最小真实请求"""
        from jarvis_agent.db import ModelDef
        with db.session() as s:
            r = s.get(ModelDef, mid)
            if not r:
                raise HTTPException(404, "模型不存在")
            result = _probe_model(r.type, r.model_id, r.api_url, r.api_key, r.timeout)
            return {"success": True, "data": result}

    @app.post("/api/models/test")
    def test_model_config(payload: Dict):
        """模型连接测试（表单直测，无需先保存）：按提交的配置发起最小真实请求"""
        result = _probe_model(str(payload.get("type") or "LLM"),
                              str(payload.get("model_id") or ""),
                              str(payload.get("api_url") or ""),
                              str(payload.get("api_key") or ""),
                              payload.get("timeout"))
        return {"success": True, "data": result}

    @app.post("/api/models/{mid}/toggle")
    def toggle_model(mid: int, payload: Dict):
        from jarvis_agent.db import ModelDef
        with db.session() as s:
            r = s.get(ModelDef, mid)
            if not r:
                raise HTTPException(404, "模型不存在")
            r.status = "已启用" if payload.get("enabled", True) else "已停用"
            s.commit()
            return {"success": True, "data": {"id": r.id, "status": r.status}}

    @app.delete("/api/models/{mid}")
    def delete_model(mid: int):
        from jarvis_agent.db import ModelDef
        with db.session() as s:
            r = s.get(ModelDef, mid)
            if not r:
                raise HTTPException(404, "模型不存在")
            s.delete(r)
            s.commit()
            return {"success": True}

    # ---------- 附件上传（+ 上传 / @ 引用的文本抽取与产物落盘） ----------
    _MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

    @app.post("/api/chat/attachments")
    async def chat_attachments(files: Optional[List[UploadFile]] = File(None),
                               conv_id: Optional[int] = Form(None),
                               space_id: Optional[int] = Form(None),
                               auto_import: Optional[int] = Form(0)):
        """多选附件上传：逐文件解析文本 → 写产物（右侧产物面板）→ 可选自动入库空间知识库。

        - 扩展名须在 SUPPORTED_EXT、大小 ≤ 10MB；单个文件失败仅该项返回 error，不整体 500
        - auto_import == 1 且 space_id 时：解析文本写 .txt 后经 rag.add_document 入库，返回 kb_doc_id
        """
        files = files or []
        items: List[Dict] = []
        for f in files:
            name = f.filename if f.filename else "unnamed"
            ext = Path(name).suffix.lstrip(".").lower()
            item: Dict = {"name": name, "file_type": ext or ""}
            try:
                if ext not in SUPPORTED_EXT:
                    raise ValueError(f"不支持的附件类型: {ext or '(无扩展名)'}（支持 {'/'.join(sorted(SUPPORTED_EXT))}）")
                raw = await f.read()
                if len(raw) > _MAX_ATTACHMENT_BYTES:
                    raise ValueError("文件超过 10MB 限制")
                if not raw:
                    raise ValueError("文件内容为空")
                text = extract_text(name, raw)
                rec = create_attachment(artifacts, conv_id, name, text, space_id=space_id)
                item["id"] = rec.get("id")
                item["object_name"] = rec.get("object_name") or ""
                item["attachment_id"] = rec.get("id") or rec.get("attachment_id")
                item["text_len"] = len(text)
                # 可选自动入库：解析文本写临时 .txt 后向量化（参考 /api/kb/documents 的 rag.add_document 用法）
                if (auto_import or 0) == 1 and space_id:
                    try:
                        import uuid
                        kb_dir = Path(db_path).parent / "kb_files"
                        kb_dir.mkdir(parents=True, exist_ok=True)
                        target = kb_dir / f"att_{uuid.uuid4().hex[:8]}_{Path(name).stem}.txt"
                        target.write_text(text, encoding="utf-8")
                        with db.session() as s:
                            from jarvis_agent.db import DocumentRecord
                            rec_doc = DocumentRecord(name=name, source_type="txt",
                                                     doc_path=str(target), space_id=space_id,
                                                     sub_system_id=None)
                            s.add(rec_doc)
                            s.commit()
                            s.refresh(rec_doc)
                            doc_id = rec_doc.id
                        info = rag.add_document(doc_id, name, "txt", str(target),
                                                space_id=space_id)
                        item["kb_doc_id"] = doc_id
                        if not info.get("chunks"):
                            item["error"] = "自动入库完成但未生成分块（文本可能过短）"
                    except Exception as e:
                        item["error"] = f"自动入库失败: {e}"
            except Exception as e:
                item["error"] = str(e)
            items.append(item)
        if not items:
            return {"success": False, "detail": "未收到任何文件"}
        failed = [i for i in items if i.get("error")]
        if len(failed) == len(items):
            return {"success": False, "data": items,
                    "detail": "全部文件处理失败：" + "；".join(f"{i['name']}: {i['error']}" for i in failed)}
        return {"success": True, "data": items}

    # ---------- 对话（SSE） ----------
    @app.get("/api/conversations/{cid}/trace")
    def conversation_trace(cid: int):
        """查询会话的步骤级 trace（parse/route/skill/artifact/error 事件）"""
        from sqlalchemy import select
        from jarvis_agent.db import ChatTrace
        with db.session() as s:
            rows = list(s.scalars(select(ChatTrace).where(ChatTrace.conv_id == cid)
                                  .order_by(ChatTrace.id)))
            data = []
            for r in rows:
                try:
                    content = json.loads(r.content) if r.content else {}
                except json.JSONDecodeError:
                    content = r.content or ""
                data.append({"id": r.id, "node": r.node, "content": content,
                             "agent_id": r.agent_id,
                             "created_at": r.created_at.isoformat() if r.created_at else None})
            return {"success": True, "data": data}

    @app.get("/api/conversations/{cid}/messages")
    def conversation_messages(cid: int):
        """查询会话的消息正文（user/assistant），用于历史回看"""
        from sqlalchemy import select
        from jarvis_agent.db import ChatTrace, Message
        with db.session() as s:
            trace_rows = list(s.scalars(select(ChatTrace)
                                        .where(ChatTrace.conv_id == cid,
                                               ChatTrace.node == "agent")
                                        .order_by(ChatTrace.id)))
            displayed_replies = []
            for trace in trace_rows:
                try:
                    payload = json.loads(trace.content) if trace.content else {}
                except json.JSONDecodeError:
                    continue
                reply = payload.get("reply") if isinstance(payload, dict) else ""
                if isinstance(reply, str) and len(reply) >= 80:
                    displayed_replies.append(reply)

            rows = list(s.scalars(select(Message)
                                  .where(Message.conv_id == cid)
                                  .order_by(Message.id)))
            data = []
            for r in rows:
                content = r.content or ""
                ui_render = None
                if r.ui_render:
                    try:
                        parsed_ui = json.loads(r.ui_render)
                    except (TypeError, json.JSONDecodeError):
                        parsed_ui = None
                    if isinstance(parsed_ui, dict):
                        ui_render = parsed_ui
                if r.role == "assistant":
                    for reply in displayed_replies:
                        content = content.replace(reply, "")
                    content = re.sub(r"\n{3,}", "\n\n", content).strip()
                    if not content:
                        continue
                data.append({
                    "id": r.id, "role": r.role, "content": content,
                    "agent_id": r.agent_id,
                    "ui_render": ui_render,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                })
            return {"success": True, "data": data}

    @app.post("/api/chat/{cid}/cancel")
    def cancel_chat(cid: int):
        """显式中止会话当前执行；前端随后再断开 SSE 连接。"""
        cancelled = chat_cancellations.cancel(cid)
        return {"success": True, "data": {"cancelled": cancelled}}

    @app.post("/api/chat/stream")
    def chat_stream(payload: Dict):
        user_input = (payload.get("message") or "").strip()
        if not user_input:
            raise HTTPException(400, "请输入内容")
        conv_id = payload.get("conv_id")
        agent_id = payload.get("agent_id")  # 前端指定的智能体 ID
        # @ 引用 / + 上传 的可选注入（不影响既有调用）：
        # references: [{type: kb_doc|history|artifact|agent|skill|kg, id, name}]
        # attachment_ids: 上传附件写入产物的 ArtifactRecord id 列表
        references = payload.get("references") or []
        attachment_ids = payload.get("attachment_ids") or []
        skip_state_advance = bool(payload.get("skip_state_advance"))
        if conv_id is None:
            with db.session() as s:
                c = Conversation(title=user_input[:20])
                s.add(c)
                s.commit()
                s.refresh(c)
                conv_id = c.id
        else:
            # 验证会话是否存在，不存在则创建
            with db.session() as s:
                _c = s.get(Conversation, conv_id)
                if _c is None:
                    c = Conversation(id=conv_id, title=user_input[:20])
                    s.add(c)
                    s.commit()

        with db.session() as s:
            _c = s.get(Conversation, conv_id)
            _quick = (_c is None) or not _c.space_id
            conv_space_id = _c.space_id if _c else None
        # 显式指定子智能体时，即使无空间会话也启用 RAG（检索该智能体绑定的专属知识库）
        _explicit_sub_agent = bool(agent_id and agent_id != "jarvis_commander")
        llm = create_chat_model(cfg.llm, reliability=cfg.reliability)
        cancellation_event = chat_cancellations.start(int(conv_id))
        graph = build_graph(llm=llm, rag_search=rag.search, prompt_service=prompts,
                            artifact_service=artifacts, skill_service=skills, config=cfg,
                            agent_service=agents_svc, pipeline_service=PipelineService(db),
                            db_tools=db_tools, kg=kg,
                            rag_enabled=(not _quick) or _explicit_sub_agent,
                            datasources_enabled=not _quick,
                            jarvis_state=jarvis_state,
                            max_iterations=8, observability=observability,
                            cancellation_event=cancellation_event)  # 跨工程流水线需串行编排 5 个业务域子 Agent，默认 3 会中途截断

        def event(name: str, content: Any) -> str:
            return f"data: {json.dumps({'type': name, 'content': content}, ensure_ascii=False)}\n\n"

        def trace(node: str, content: Any, agent_id: str = ""):
            from jarvis_agent.db import ChatTrace
            with db.session() as s:
                s.add(ChatTrace(conv_id=conv_id, node=node,
                                content=json.dumps(content, ensure_ascii=False), agent_id=agent_id))
                s.commit()

        # 解析结果 JSON 字段集：LLM 偶发在回复正文前先吐出 `{"intent":...,"agent_id":...}`，
        # 需在流式下发时将其整体剥离（不展示、不落库）。键名可能含杂散空格，统一归一化后匹配。
        PARSE_KEYS = {"intent", "agent_id", "object_name", "source_db",
                      "target_db", "skill_id", "params", "confidence"}
        CORE_KEYS = {"intent", "agent_id", "confidence"}

        def _norm_key(k: str) -> str:
            return "".join(str(k).split())

        def _parse_json_prefix(acc: str):
            """判断累计文本 acc 是否以「解析结果 JSON」开头。
            返回 None   = 仍是该 JSON 的不完整前缀，需继续等待后续 chunk；
                 False  = 不是解析 JSON / 不是合法 JSON，正常输出；
                 字符串 = 解析 JSON 之后的剩余文本（已取得完整 JSON 并剥离）。"""
            t = acc.lstrip("\ufeff\u200b\u200c\u200d \t\r\n")
            if not t.startswith("{"):
                return False
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
                return None  # 尚未出现闭合括号，可能仍在输出 JSON 前缀
            try:
                obj = json.loads(t[: end + 1])
            except json.JSONDecodeError:
                return False
            if not isinstance(obj, dict):
                return False
            keys = {_norm_key(k) for k in obj}
            if not keys or not keys <= PARSE_KEYS or not CORE_KEYS <= keys:
                return False
            return t[end + 1:]

        def gen():
            from jarvis_agent.db import Message

            def _update_task_status(status: str):
                if conv_id is None:
                    return
                with db.session() as s:
                    c = s.get(Conversation, conv_id)
                    if c and c.task_id:
                        t = s.get(ProjectTask, c.task_id)
                        if t:
                            t.status = status
                            s.commit()

            # 加载历史消息（最近 20 条，作为上下文）+ 会话任务状态（current_step/task_params）
            task_state: Dict = {}
            with db.session() as s:
                rows = s.query(Message).filter(Message.conv_id == conv_id).order_by(Message.id.desc()).limit(20).all()
                history = [{"role": r.role, "content": r.content} for r in reversed(rows)]
                _c = s.get(Conversation, conv_id)
                if _c and (_c.task_state or "").strip():
                    try:
                        _ts = json.loads(_c.task_state)
                        if isinstance(_ts, dict):
                            task_state = _ts
                    except Exception:
                        task_state = {}
                # 会话绑定的业务任务 ID：跨工程迭代任务 conv_id 优先记录业务任务 ID（「空间>任务」详情页反查用），
                # 未绑定业务任务时回退会话 ID（记录最近活跃会话）
                biz_task_id = _c.task_id if _c else None
                _conv_ref = biz_task_id if biz_task_id is not None else conv_id
            trace_id = ""
            _migrate_task_id = task_state.get("migrate_task_id")
            if _migrate_task_id:
                try:
                    _iter_row = jarvis_state.get(int(_migrate_task_id))
                    if _iter_row is not None:
                        trace_id = (getattr(_iter_row, "trace_id", "") or "").strip()
                        if not trace_id:
                            trace_id = observability.new_trace_id()
                            _iter_row.trace_id = trace_id
                            with db.session() as s:
                                _row = s.get(type(_iter_row), _iter_row.id)
                                if _row is not None:
                                    _row.trace_id = trace_id
                                    s.commit()
                        task_state["trace_id"] = trace_id
                except (TypeError, ValueError):
                    pass

            # ---- 领域状态机：确定性流转（不依赖 LLM 记忆，支持断点续跑） ----
            # 跨工程迭代流程由后端硬编码状态机控制：页面展示→下单拆单→订单受理→
            # 规则配置→客户数据→完成。指挥官只负责对话/渲染表单/调度子 Agent，无权跳转。
            # 断点续跑：任务中途关闭会话再打开，从 jarvis_task 当前状态继续，不重复采集。
            iter_evt: Optional[Dict] = None  # 本轮状态机推进事件（前端进度展示用）
            _ITER_INTENT_RE = re.compile(r"跨工程|迭代开发|页面展示|下单|拆单|订单受理|规则配置|客户数据|业务编排|小前|小订|小受|小规|小客")
            # 用户显式指定子智能体时，直接由该智能体执行需求，不经状态机编排
            explicit_sub_agent = bool(agent_id and agent_id != "jarvis_commander")
            # 仅选择指挥官不等于发起跨工程任务；问候/自我介绍等普通问题应走普通问答。
            # 已有迭代任务或输入明确命中业务流程关键词时才启用状态机。
            is_iter_flow = (not explicit_sub_agent) and bool(
                task_state.get("migrate_task_id")
                or _ITER_INTENT_RE.search(user_input))
            if is_iter_flow:
                _M_EXEC_STATES = ("PAGE_SHOW", "ORDER_SPLIT", "ORDER_ACCEPT",
                                  "RULE_CHECK", "CUSTOMER_CHECK", "FINISHED")
                ipr = parse_iter_params(user_input)
                # 合并会话历史参数（断点续跑：已采集参数跨轮保留）
                merged_params = dict(task_state.get("task_params") or {})
                for _k, _v in ipr.items():
                    merged_params[_k] = _v
                # 断点续跑：优先加载既有迭代任务
                iter_row = None
                if task_state.get("migrate_task_id"):
                    try:
                        iter_row = jarvis_state.get(int(task_state["migrate_task_id"]))
                        if (iter_row is not None and biz_task_id is not None
                                and getattr(iter_row, "project_task_id", None) is None):
                            jarvis_state.bind_project_task(iter_row.id, biz_task_id)
                    except Exception:
                        iter_row = None
                    if (iter_row is not None and biz_task_id is not None
                            and getattr(iter_row, "project_task_id", None) != biz_task_id):
                        iter_row = None
                # 多会话共享兜底：新会话说「继续推进跨工程迭代」但无任务 → 接入最近活跃任务
                if iter_row is None and is_iter_flow and not task_state.get("migrate_task_id"):
                    try:
                        iter_row = jarvis_state.get_recent_active(
                            space_id=conv_space_id,
                            project_task_id=biz_task_id)
                        if iter_row:
                            jarvis_state.bind_conv(iter_row.id, _conv_ref)
                    except Exception:
                        iter_row = None
                # 首次发起跨工程迭代（命中 跨工程/迭代 意图且无进行中任务）：
                # 未提供业务场景时建 PAGE_SHOW 空任务，进入「业务场景选择」阶段由指挥官下发表单。
                if iter_row is None and is_iter_flow:
                    iter_row = jarvis_state.create(
                        conv_id=_conv_ref, space_id=conv_space_id,
                        project_task_id=biz_task_id)
                    task_state["migrate_task_id"] = iter_row.id
                # ---- 执行锁（多会话互斥）：本轮有实质状态变更意图时抢锁 ----
                # 纯只读问答（无参数/确认词）不抢锁，任何会话随时可查看产物/报告/问答。
                # 锁被其他会话持有 → 不推进状态机，注入只读提示，仅允许本轮问答。
                _iter_lock_tid = None
                if iter_row is not None and ipr:
                    _lk = jarvis_state.try_acquire_lock(
                        iter_row.id, str(conv_id), owner_user_id=f"会话{conv_id}")
                    if _lk["ok"]:
                        _iter_lock_tid = iter_row.id
                    else:
                        task_state["last_warning"] = _lk["message"]
                        iter_row = None  # 阻止状态机推进/编排（只读模式）
                if iter_row is not None and is_iter_flow:
                    # 逐级确认开关（DB 配置化，从任务读取）：注入 task_state 供 graph 编排决策
                    task_state["step_confirm"] = bool(getattr(iter_row, "step_confirm", True))
                    task_state["strict_flow"] = bool(getattr(iter_row, "strict_flow", True))
                    merged_params.update(_collector_report_completion_params(
                        iter_row, merged_params, db))
                    _res_upd = None
                    if skip_state_advance:
                        # /advance 已完成一次闸门确认；这里仅执行刚进入的阶段，
                        # 不能把“开始执行”再次解析成下一阶段的 task_confirm。
                        task_state["current_step"] = getattr(iter_row, "status", "")
                        task_state["step_status"] = "running"
                        task_state["awaiting_confirmation"] = False
                        task_state["pipeline_start"] = True
                        _broadcast_iter_state(iter_row.id, task_state)
                    else:
                        try:
                            _res_upd = jarvis_state.update_params(iter_row.id, merged_params)
                        except JarvisStateError as _e:
                            task_state["last_warning"] = str(_e)
                    if _res_upd:
                        _mt = _res_upd["task"]
                        task_state["current_step"] = _mt["status"]
                        _broadcast_iter_state(iter_row.id, task_state)
                        if _res_upd["advanced"]:
                            iter_evt = {"task_id": iter_row.id, "from": _res_upd["from"],
                                        "to": _res_upd["to"], "label": status_label(_res_upd["to"])}
                        # 状态机硬拦截提示透传指挥官，禁止继续该阶段
                        if _res_upd.get("warning"):
                            task_state["last_warning"] = _res_upd["warning"]
                        # 状态机权威回写已采集参数（供 graph 注入与前端展示）
                        _saved_params = {k: v for k, v in _mt.items()
                                         if k in ("frontend_task", "business_scene", "order_source",
                                                  "split_rule", "accept_system", "workflow_scene",
                                                  "rule_config", "config_branch", "customer_scope",
                                                  "data_range", "object_count") and v}
                        task_state["task_params"] = {**(task_state.get("task_params") or {}),
                                                     **{k: v for k, v in _saved_params.items()}}
                        # 进入执行阶段 → 注入强制编排计划（graph 据此调度子 Agent）
                        if task_state["current_step"] in _M_EXEC_STATES:
                            task_state["pipeline_start"] = True
                        _broadcast_iter_state(iter_row.id, task_state)
                    else:
                        try:
                            _res_upd = jarvis_state.update_params(iter_row.id, merged_params)
                        except JarvisStateError as _e:
                            task_state["last_warning"] = str(_e)
                    if _res_upd:
                        _mt = _res_upd["task"]
                        task_state["current_step"] = _mt["status"]
                        _broadcast_iter_state(iter_row.id, task_state)
                        if _res_upd["advanced"]:
                            iter_evt = {"task_id": iter_row.id, "from": _res_upd["from"],
                                           "to": _res_upd["to"], "label": status_label(_res_upd["to"])}
                        # 状态机硬拦截提示（如流程前置条件未满足）透传指挥官，禁止继续该阶段
                        if _res_upd.get("warning"):
                            task_state["last_warning"] = _res_upd["warning"]
                        # 状态机权威回写已采集参数（供 graph 注入与前端展示）
                        _saved_params = {k: v for k, v in _mt.items()
                                         if k in ("frontend_task", "business_scene", "order_source",
                                                  "split_rule", "accept_system", "workflow_scene",
                                                  "rule_config", "config_branch", "customer_scope",
                                                  "data_range", "object_count") and v}
                        task_state["task_params"] = {**(task_state.get("task_params") or {}),
                                                     **{k: v for k, v in _saved_params.items()}}
                        # 进入执行阶段 → 注入强制编排计划（graph 据此调度子 Agent）
                        if task_state["current_step"] in _M_EXEC_STATES:
                            task_state["pipeline_start"] = True
            # 落库用户消息
            with db.session() as s:
                s.add(Message(conv_id=conv_id, role="user", content=user_input))
                s.commit()
            _update_task_status("running")

            # ---- @ 引用 / + 上传 → 额外上下文（extra_context，不改变 user 消息原文） ----
            # 逐项读取被引用资源文本，组装为「本次引用/附件上下文」内容块；
            # 无有效内容项跳过，整块为空则返回空字符串（调用方不做拼接）。

            def _read_text(path_str: str, limit: int) -> Optional[str]:
                try:
                    p = Path(path_str)
                    if not p.exists():
                        return None
                    text = p.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    return None
                return text[:limit] if text and text.strip() else None

            def _resolve_reference(rtype: str, rid: Any, name: str) -> Optional[str]:
                try:
                    if rtype == "kb_doc":  # DocumentRecord.doc_path 文本，截断 3000
                        from jarvis_agent.db import DocumentRecord
                        with db.session() as s:
                            rec = s.get(DocumentRecord, int(rid)) \
                                if rid is not None and str(rid).isdigit() else None
                        if not rec or not rec.doc_path:
                            return None
                        return _read_text(rec.doc_path, 3000)
                    if rtype == "history":  # Message.content，截断 2000
                        from jarvis_agent.db import Message as _Msg
                        with db.session() as s:
                            rec = s.get(_Msg, int(rid)) if rid is not None and str(rid).isdigit() else None
                        if not rec or not rec.content:
                            return None
                        return rec.content[:2000]
                    if rtype == "artifact":  # ArtifactRecord.path 文本，截断 3000
                        from jarvis_agent.db import ArtifactRecord as _ArtRec
                        with db.session() as s:
                            rec = s.get(_ArtRec, int(rid)) if rid is not None and str(rid).isdigit() else None
                        if not rec or not rec.path:
                            return None
                        return _read_text(rec.path, 3000)
                    if rtype == "agent":  # 「名称：描述」无正文，截断 500
                        info = agents_svc.get(str(rid)) if rid is not None else None
                        if not info and name:
                            info = agents_svc.get(str(name))
                        if not info:
                            return None
                        return f"{info.get('name')}：{info.get('description', '')}"[:500]
                    if rtype == "skill":  # name + description + content，截断 1500
                        info = None
                        try:
                            info = skills.get(str(rid)) if rid is not None else None
                            if not info and name:
                                for row in skills.list():
                                    if row.get("name") == name or row.get("skill_id") == name:
                                        info = row
                                        break
                        except Exception:
                            info = None
                        if not info:
                            return None
                        body = f"{info.get('name')}：{info.get('description', '')}\n{info.get('content', '')}"
                        return body[:1500]
                    if rtype == "kg":  # 三元组文本，最多 10 条（格式同 graph.py kg_block）
                        if kg is None:
                            return None
                        try:
                            triples = kg.expand([name], limit=10) if name else []
                        except Exception:
                            triples = []
                        if not triples:
                            return None
                        return "\n".join(f"- {t['subject']} --{t['relation']}--> {t['object']}"
                                          for t in triples[:10])
                except Exception:
                    return None
                return None

            def _resolve_attachment(aid: Any) -> Optional[str]:
                try:
                    rid = int(aid)
                except (TypeError, ValueError):
                    return None
                from jarvis_agent.db import ArtifactRecord as _ArtRec
                with db.session() as s:
                    rec = s.get(_ArtRec, rid)
                    if not rec or not rec.path or (rec.file_type or "").lower() not in SUPPORTED_EXT:
                        return None
                    path_str = rec.path
                return _read_text(path_str, 5000)

            def _build_extra_context() -> str:
                blocks: List[str] = []
                for ref in references if isinstance(references, list) else []:
                    if not isinstance(ref, dict):
                        continue
                    rtype = str(ref.get("type") or "").strip()
                    if rtype not in {"kb_doc", "history", "artifact", "agent", "skill", "kg"}:
                        continue
                    rid = ref.get("id")
                    name = str(ref.get("name") or (rid if rid is not None else "")).strip()
                    content = _resolve_reference(rtype, rid, name)
                    if not content or not content.strip():
                        continue  # 无内容项跳过
                    blocks.append(f"- @{name}（{rtype}）: {content.strip()}")
                for aid in attachment_ids if isinstance(attachment_ids, list) else []:
                    content = _resolve_attachment(aid)
                    if not content or not content.strip():
                        continue
                    blocks.append(f"- @附件#{aid}（attachment）: {content.strip()}")
                if not blocks:
                    return ""  # 整块为空则空字符串，不做拼接
                return ("\n## 本次引用 / 附件上下文（用户通过 @ 或文件上传指定，回答务必优先使用，不得视作与任务无关）\n"
                        + "\n".join(blocks))

            extra_context = _build_extra_context()
            initial = AgentState(user_input=user_input, conv_id=conv_id,
                                 space_id=conv_space_id, history=history,
                                 agent_id=agent_id or "", extra_context=extra_context,
                                 task_state=task_state,
                                 trace_id=str(task_state.get("trace_id") or ""))
            assistant_parts: List[str] = []
            reply_started = False      # 是否已进入真正的回复正文
            pending_prefix = ""        # 最前可能为解析 JSON 前缀的文本缓冲区
            # 直接对话的产物型 Agent：正文必须先缓冲，等 artifact 节点确认是否为核心交付物。
            # 落产物 -> 只发文件卡片；未落产物（追问/普通说明）-> 流结束后恢复正文。
            direct_agent_id = str(agent_id or "")
            direct_cfg = agents_svc.get(direct_agent_id) or {} if direct_agent_id else {}
            buffer_direct_reply = bool(direct_cfg.get("gen_artifact", False))
            direct_reply_buffer = ""
            direct_artifacts: List[Dict] = []
            emitted_error_messages: set[str] = set()

            # ---- <UI_RENDER>/<TASK_STATE> 结构化指令提取（流式状态机） ----
            # 模型可在回复中嵌入 UI 指令（交互表单）与任务状态声明（采集进度）。
            # 规则：提取全部块 → UI_RENDER 只保留首个合法 JSON，TASK_STATE 取首个合法 JSON
            # 存入 task_state_evt 供写库；所有块连同标签一律从正文中剔除，用户不可见。
            _UI_OPEN_RE = re.compile(r"<(UI_RENDER|TASK_STATE)\s*>", re.I)
            _UI_CLOSE_BY_TAG = {
                "UI_RENDER": re.compile(r"</UI_RENDER\s*>", re.I),
                "TASK_STATE": re.compile(r"</TASK_STATE\s*>", re.I),
            }
            ui_buf = ""            # 尚未拆分的文本缓冲（可能跨 token 包含部分标签）
            ui_render = None       # 保留的首个合法 UI 对象
            task_state_evt = None  # 保留的首个合法任务状态声明（写库用）
            ui_taken = False       # 是否已取到首个 UI 块（后续块一律丢弃）
            _in_ui_block = False   # 是否正处于某个控制指令块内部
            _in_tag = ""           # 当前块标签：UI_RENDER / TASK_STATE
            _ui_block_body = ""

            def _tag_partial(buf: str, tag: str) -> str:
                """返回 buf 尾部与 tag（如 '<UI_RENDER'）大小写不敏感的部分前缀，否则空串。
                用于识别被 token 切开的标签，避免误当正文下发。"""
                if not buf:
                    return ""
                low = buf.lower()
                t = tag.lower()
                for i in range(min(len(t), len(buf)), 0, -1):
                    if low.endswith(t[:i]):
                        return buf[-i:]
                return ""

            def _pending_open(buf: str) -> str:
                """返回 buf 尾部与某个开标签（<UI_RENDER / <TASK_STATE）的部分前缀，否则空串。"""
                for t in ("<ui_render", "<task_state"):
                    p = _tag_partial(buf, t)
                    if p:
                        return p
                return ""

            def _ui_emit(chunk: str) -> List[str]:
                """处理一段原始文本增量，返回应作为纯文本下发的片段列表。
                副作用：<UI_RENDER> 首个合法 JSON 存入 ui_render（供前端表单），
                <TASK_STATE> 首个合法 JSON 存入 task_state_evt（供会话状态写库），全部块剔除。"""
                nonlocal ui_buf, ui_render, task_state_evt, ui_taken, _in_ui_block, _in_tag, _ui_block_body
                outs: List[str] = []
                ui_buf += chunk
                while True:
                    if not _in_ui_block:
                        m = _UI_OPEN_RE.search(ui_buf)
                        if m is None:
                            p = _pending_open(ui_buf)
                            if p:
                                body = ui_buf[:-len(p)]
                                if body:
                                    outs.append(body)
                                ui_buf = p
                            else:
                                outs.append(ui_buf)
                                ui_buf = ""
                            return outs
                        if m.start() > 0:
                            outs.append(ui_buf[:m.start()])
                        _in_ui_block = True
                        _in_tag = m.group(1).upper()
                        _ui_block_body = ""
                        ui_buf = ui_buf[m.end():]
                        continue
                    # 处于指令块内：寻找对应标签的闭合
                    cm = _UI_CLOSE_BY_TAG[_in_tag].search(ui_buf)
                    if cm is None:
                        p = _tag_partial(ui_buf, "</" + _in_tag)
                        if p:
                            _ui_block_body += ui_buf[:-len(p)]
                            ui_buf = p
                        else:
                            _ui_block_body += ui_buf
                            ui_buf = ""
                        return outs
                    _ui_block_body += ui_buf[:cm.start()]
                    body = _ui_block_body
                    ui_buf = ui_buf[cm.end():]
                    _ui_block_body = ""
                    _in_ui_block = False
                    tag = _in_tag
                    _in_tag = ""
                    try:
                        obj = json.loads(body)
                    except Exception:
                        obj = None
                    if tag == "UI_RENDER":
                        # 只取首个合法 dict，其后/非法一律丢弃（降级为纯文本）
                        if not ui_taken and isinstance(obj, dict):
                            ui_taken = True
                            if ui_render is None:
                                ui_render = obj
                    else:  # TASK_STATE：取首个合法 dict 写库
                        if task_state_evt is None and isinstance(obj, dict):
                            task_state_evt = obj
                    continue
            try:
                # messages 模式提供 LLM token 级增量（打字机效果），updates 模式提供节点事件，
                # custom 模式提供 graph 内实时自定义事件（子 Agent 调度 + 子 Agent 输出）
                stream_migrate_task_id = (
                    task_state.get("migrate_task_id")
                    if isinstance(task_state, dict) else None)
                for mode, payload in graph.stream(
                        initial, stream_mode=["updates", "messages", "custom"]):
                    if mode == "messages":
                        chunk, _meta = payload
                        # 跳过工具调用（arguments/JSON）产生的 chunk，只下发正文文本
                        if getattr(chunk, "tool_call_chunks", None):
                            continue
                        text = getattr(chunk, "content", "") or ""
                        if not text:
                            continue
                        if not reply_started:
                            # 剥离回复流最前面误输出的「解析结果 JSON」前缀，
                            # 避免用户看到 intent/agent_id 等 JSON（也保证不落库）
                            pending_prefix += text
                            rest = _parse_json_prefix(pending_prefix)
                            if rest is None:
                                continue  # JSON 前缀尚未输出完毕，暂不展示
                            buffered = pending_prefix
                            pending_prefix = ""
                            if rest is False:
                                text = buffered  # 不是解析 JSON，原样进入正文
                            else:
                                text = re.sub(r"^[\s\ufeff\u200b\u200c\u200d，,。；;：:\n\r*-]+", "", rest)
                                if not text:
                                    continue  # JSON 后接空白，忽略
                            reply_started = True
                        # 剥离 UI_RENDER 块，只下发纯自然语言正文
                        for _seg in _ui_emit(text):
                            if not _seg:
                                continue
                            if buffer_direct_reply:
                                direct_reply_buffer += _seg
                            else:
                                yield event("text", _seg)
                                assistant_parts.append(_seg)
                        continue
                    # custom 模式：graph 内实时事件（子 Agent 调度系统事件 + 子 Agent 输出消息）
                    if mode == "custom":
                        ev = payload if isinstance(payload, dict) else {}
                        etype = ev.get("type")
                        aid = ev.get("agent_id") or ""
                        if etype == "route_preflight":
                            direct_agent_id = str(ev.get("agent_id") or direct_agent_id)
                            routed_cfg = agents_svc.get(direct_agent_id) or {}
                            buffer_direct_reply = bool(routed_cfg.get("gen_artifact", False))
                            continue
                        if etype == "system":
                            ev_body = {"message": ev.get("message", ""),
                                       "event": ev.get("event", "calling_agent"),
                                       "agent_id": aid,
                                       "success": ev.get("success"),
                                       "artifact_count": ev.get("artifact_count")}
                            yield event("system", ev_body)
                            trace("system", ev_body, aid)
                        elif etype == "sub_agent":
                            ev_body = {k: ev.get(k) for k in
                                        ("agent_id", "agent_name", "dispatcher_id",
                                         "dispatcher_name", "reply", "error",
                                         "artifacts", "ui_render")}
                            sub_ui = ev.get("ui_render")
                            if isinstance(sub_ui, dict) and ui_render is None:
                                ui_render = sub_ui
                            yield event("sub_agent", ev_body)
                            trace("agent", ev_body, aid)
                        elif etype == "artifact":
                            # 子 Agent 内联执行时自行入库的产物（按产出 Agent 分组），
                            # 与 artifact 节点（updates 模式）下发的产物事件一致
                            ev_body = {"namespace": ev.get("namespace", ""),
                                       "agent_id": ev.get("agent_id", ""),
                                       "agent_name": ev.get("agent_name", ""),
                                       "files": ev.get("files", [])}
                            yield event("artifact", ev_body)
                            trace("artifact", ev_body, ev.get("agent_id", aid))
                        continue
                    # updates 模式：指挥官负责 parse/route/非迁移执行；阶段节点负责执行与产物
                    for node, update in payload.items():
                        graph_task_state = update.get("task_state")
                        if isinstance(graph_task_state, dict):
                            graph_task_id = (
                                graph_task_state.get("migrate_task_id")
                                or stream_migrate_task_id)
                            if graph_task_id:
                                _broadcast_iter_state(
                                    int(graph_task_id), graph_task_state)
                        if node == "jarvis_commander":
                            pr = update.get("parse_result", {})
                            routed_agent_id = str(update.get("agent_id") or direct_agent_id)
                            routed_cfg = agents_svc.get(routed_agent_id) or {}
                            direct_agent_id = routed_agent_id
                            buffer_direct_reply = bool(routed_cfg.get("gen_artifact", False))
                            if pr:
                                yield event("parse", pr)
                                trace("parse", pr)
                            if update.get("route_reason") is not None:
                                yield event("route", {"agent_id": update.get("agent_id"),
                                                      "reason": update.get("route_reason")})
                                trace("route", update.get("route_reason", ""),
                                      update.get("agent_id", ""))
                            if update.get("error"):
                                _update_task_status("failed")
                                yield event("error", update["error"])
                                trace("error", update["error"])
                            elif update.get("error_message"):
                                _update_task_status("failed")
                                if update["error_message"] not in emitted_error_messages:
                                    emitted_error_messages.add(update["error_message"])
                                    yield event("error", update["error_message"])
                                    trace("error", update["error_message"])
                            if update.get("graph_phase") == "blocked" and update.get("reply"):
                                yield event("text", update["reply"])
                                assistant_parts.append(update["reply"])
                            if update.get("generic_executed"):
                                # 非迁移智能体在小枢内执行；产物型回复只出文件卡片。
                                for sc in update.get("skill_calls") or []:
                                    yield event("skill", sc)
                                    trace("skill", sc, update.get("agent_id", ""))
                                artifact_files = update.get("artifacts") or []
                                if buffer_direct_reply:
                                    direct_artifacts.extend(
                                        f for f in artifact_files
                                        if str(f.get("agent_id", "")) == direct_agent_id
                                    )
                                if update.get("namespace"):
                                    yield event("artifact", {
                                        "namespace": update["namespace"],
                                        "files": artifact_files})
                                    trace("artifact", {"namespace": update["namespace"]},
                                          update.get("agent_id", ""))
                        elif node in {
                                "boot_agent", "customer_order_agent",
                                "family_order_agent", "rule_center_agent",
                                "customer_center_agent"}:
                            # 阶段产物已由 custom sub_agent/artifact 事件下发；
                            # 这里只透出执行错误，避免把核心报告重复发到对话框。
                            if update.get("error"):
                                _update_task_status("failed")
                                yield event("error", update["error"])
                                trace("error", update["error"])
                        elif update.get("error"):
                            _update_task_status("failed")
                            yield event("error", update["error"])
                            trace("error", update["error"])
                        elif update.get("error_message"):
                            _update_task_status("failed")
                            if update["error_message"] not in emitted_error_messages:
                                emitted_error_messages.add(update["error_message"])
                                yield event("error", update["error_message"])
                                trace("error", update["error_message"])
                # 流结束后若仍有未判定内容（非解析 JSON 的文本）则正常下发
                if pending_prefix:
                    if buffer_direct_reply:
                        direct_reply_buffer += pending_prefix
                    else:
                        yield event("text", pending_prefix)
                        assistant_parts.append(pending_prefix)
                    pending_prefix = ""
                # 处理缓冲中的残余文本（可能是不完整的 UI_RENDER 标签或尾部文本），
                # 残余标签丢弃，残余纯文本照常下发
                for _seg in _ui_emit(""):
                    if not _seg:
                        continue
                    if buffer_direct_reply:
                        direct_reply_buffer += _seg
                    else:
                        yield event("text", _seg)
                        assistant_parts.append(_seg)
                if buffer_direct_reply and direct_artifacts:
                    agent_cfg = agents_svc.get(direct_agent_id) or {}
                    card = {"agent_id": direct_agent_id,
                            "agent_name": agent_cfg.get("name") or direct_agent_id,
                            "dispatcher_id": direct_agent_id,
                            "dispatcher_name": agent_cfg.get("name") or direct_agent_id,
                            "reply": "", "error": "", "artifacts": direct_artifacts}
                    yield event("sub_agent", card)
                    trace("agent", card, direct_agent_id)
                elif buffer_direct_reply and direct_reply_buffer:
                    yield event("text", direct_reply_buffer)
                    assistant_parts.append(direct_reply_buffer)
                _update_task_status("done")
                if (ui_render is None
                        and _needs_confirmation_fallback("".join(assistant_parts))):
                    ui_render = _fallback_confirmation_form()
                if ui_render is not None:
                    ui_render = _resolve_ui_placeholders(ui_render, db_tools)
                    yield event("ui_render", ui_render)
                if iter_evt is not None:
                    yield event("migrate", iter_evt)
                yield event("done", None)
            except ChatRunCancelled:
                # 显式中止不是失败：释放执行锁，任务停在 paused，可从当前阶段继续。
                _update_task_status("paused")
                task_state["step_status"] = "paused"
                task_state["awaiting_confirmation"] = True
                task_state["pipeline_start"] = False
                with db.session() as s:
                    _c = s.get(Conversation, conv_id)
                    if _c is not None:
                        _c.task_state = json.dumps(task_state, ensure_ascii=False)
                        s.commit()
                if is_iter_flow and _iter_lock_tid is not None:
                    try:
                        _broadcast_iter_state(_iter_lock_tid, task_state)
                        jarvis_state.release_lock(_iter_lock_tid, str(conv_id))
                        _iter_lock_tid = None
                    except Exception:
                        pass
                trace("system", {"event": "run_cancelled",
                                 "message": "用户已中止本次智能体执行"})
                yield event("system", {"event": "run_cancelled",
                                       "message": "已中止本次智能体执行"})
                yield event("done", None)
                return
            except Exception as e:  # 覆盖 LLM 未启动等运行错误
                _update_task_status("failed")
                if buffer_direct_reply and direct_reply_buffer:
                    yield event("text", direct_reply_buffer)
                    assistant_parts.append(direct_reply_buffer)
                    direct_reply_buffer = ""
                # AssertionError 等异常 str 为空串，需生成有意义的提示，否则前端收不到可见错误
                msg = str(e) or f"处理出错：{type(e).__name__}"
                yield event("error", msg)
                trace("error", msg)
            # 落库助手回复（仅有正文时保存，错误仅见于 trace）。
            # 注意必须用 ''.join：text 段本身是流式 token 分片，此前用 '\n'.join
            # 导致历史消息每隔几个字一个换行，且污染后续轮次的对话上下文
            if assistant_parts:
                with db.session() as s:
                    s.add(Message(conv_id=conv_id, role="assistant",
                                  content="".join(assistant_parts),
                                  agent_id=agent_id or None,
                                  ui_render=json.dumps(
                                      ui_render, ensure_ascii=False)
                                  if ui_render is not None else None))
                    s.commit()

            # 会话任务状态落库：以状态机（后端确定性逻辑）为准；LLM 的 <TASK_STATE> 声明
            # 仅作参数提示，其 current_step 一律忽略（状态跳转由后端控制，LLM 无权决定）。
            if is_iter_flow or task_state_evt:
                if isinstance(task_state_evt, dict) and not is_iter_flow:
                    _evt_params = task_state_evt.get("task_params")
                    if isinstance(_evt_params, dict):
                        _ts_p = task_state.setdefault("task_params", {})
                        for _k, _v in _evt_params.items():
                            if _k in ("frontend_task", "business_scene", "order_source",
                                      "split_rule", "accept_system", "workflow_scene",
                                      "rule_config", "config_branch", "customer_scope",
                                      "data_range", "object_count") and not _ts_p.get(_k):
                                _ts_p[_k] = _v
                with db.session() as s:
                    _c = s.get(Conversation, conv_id)
                    if _c is not None:
                        _c.task_state = json.dumps(task_state, ensure_ascii=False)
                        s.commit()

            # 本轮结束：释放执行锁（若本会话持有）——阶段推进完成即释放，便于他人接管
            if is_iter_flow and _iter_lock_tid is not None:
                try:
                    jarvis_state.release_lock(_iter_lock_tid, str(conv_id))
                except Exception:
                    pass

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})

    # ---------- 跨工程迭代：状态机编排 ----------
    @app.get("/api/jarvis/tasks")
    def iter_tasks(space_id: Optional[int] = None, status: Optional[str] = None,
                      limit: int = 100):
        return {"success": True, "data": jarvis_state.list(space_id, status, limit)}

    @app.post("/api/jarvis/tasks")
    def iter_task_create(payload: Dict):
        conv_id = payload.get("conv_id")
        project_task_id = payload.get("project_task_id")
        if project_task_id is None and conv_id is not None:
            with db.session() as s:
                conv = s.get(Conversation, int(conv_id))
                project_task_id = conv.task_id if conv else None
        row = jarvis_state.create(
            conv_id=conv_id, space_id=payload.get("space_id"),
            sub_system_id=payload.get("sub_system_id"),
            project_task_id=project_task_id,
            task_name=str(payload.get("task_name") or "跨工程迭代开发"))
        _broadcast_latest_iter_event(row.id)
        return {"success": True, "data": jarvis_state.to_dict(row)}

    @app.get("/api/jarvis/tasks/{tid}")
    def iter_task_get(tid: int):
        row = jarvis_state.get(tid)
        if row is None:
            raise HTTPException(404, f"跨工程迭代任务不存在: {tid}")
        data = jarvis_state.to_dict(row)
        _with_migrate_execution_state(data, db)
        return {"success": True, "data": data}

    @app.delete("/api/jarvis/tasks/{tid}")
    def iter_task_delete(tid: int):
        jarvis_state.delete(tid)
        return {"success": True}

    @app.post("/api/jarvis/tasks/{tid}/reset")
    def iter_task_reset(tid: int, payload: Dict = None):
        """重置整个任务：状态回到 INIT，清空已采集参数与已生成资产（二次确认在页面侧）。
        执行锁：重置需抢占锁，任务正在被其他会话执行时拒绝重置。"""
        payload = payload or {}
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            _lk = jarvis_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise JarvisStateError(_lk["message"])
            res = jarvis_state.reset(tid)
        except JarvisStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}

    @app.post("/api/jarvis/tasks/{tid}/resume")
    def iter_task_resume(tid: int, payload: Dict = None):
        """断点续跑：仅 ERROR 状态可调用，清错误并恢复到可继续推进的阶段，不从头重跑。
        ERROR 状态锁已自动释放，任意会话可抢占接管（重新获取执行锁）。"""
        payload = payload or {}
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            _lk = jarvis_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise JarvisStateError(_lk["message"])
            res = jarvis_state.resume(tid)
            _broadcast_iter_state(tid)
            _broadcast_latest_iter_event(tid)
        except JarvisStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}

    @app.post("/api/jarvis/tasks/{tid}/retry-stage")
    def iter_task_retry_stage(tid: int, payload: Dict = None):
        """单节点重试：回退到指定执行节点，保留参数与产物。

        接口只负责状态回退与会话执行态复位；真正的 Agent 重跑由前端随后
        调用 /api/chat/stream 发起，避免把状态机指令和业务执行混在一起。
        """
        import json as _json
        from jarvis_agent.db import Conversation
        from sqlalchemy import select

        payload = payload or {}
        stage = str(payload.get("stage") or "").strip()
        sid = str(payload.get("session_id") or "").strip()
        owner = str(payload.get("owner") or "")
        row = jarvis_state.get(tid)
        if row is None:
            raise HTTPException(404, f"跨工程迭代任务不存在: {tid}")

        def _state_conv(c: Conversation | None):
            if c is None:
                return None
            try:
                state = _json.loads(c.task_state or "{}")
                return c if (isinstance(state, dict) and int(state.get("migrate_task_id") or 0) == tid) else None
            except (TypeError, ValueError):
                return None

        with db.session() as s:
            requested = s.get(Conversation, int(sid)) if sid.isdigit() else None
            owned = requested if requested and (
                _state_conv(requested)
                or (row.project_task_id and requested.task_id == row.project_task_id)
            ) else None
            candidates: list[Conversation] = []
            if row.project_task_id:
                candidates.extend(s.scalars(select(Conversation).where(
                    Conversation.task_id == row.project_task_id).order_by(Conversation.id.desc())))
            if row.conv_id is not None:
                direct = s.get(Conversation, row.conv_id)
                if direct is not None:
                    candidates.append(direct)
                candidates.extend(s.scalars(select(Conversation).where(
                    Conversation.task_id == row.conv_id).order_by(Conversation.id.desc())))
            state_conv = owned or next((_state_conv(c) for c in candidates if _state_conv(c)), None)
            if state_conv is None:
                state_conv = owned or next((c for c in candidates if c.id == row.conv_id), None)
            if state_conv is None:
                state_conv = owned or (candidates[0] if candidates else None)
            if state_conv is None:
                raise HTTPException(400, "该跨工程迭代任务没有关联会话，无法重新执行")
            conv_id = state_conv.id

        locked = False
        try:
            _lk = jarvis_state.try_acquire_lock(
                tid, str(conv_id), owner_user_id=owner or f"会话{conv_id}",
                allow_readonly=True)
            if not _lk["ok"]:
                raise JarvisStateError(_lk["message"])
            locked = True
            res = jarvis_state.retry_stage(tid, stage)
            with db.session() as s:
                target_conv = s.get(Conversation, conv_id)
                if target_conv is None:
                    raise JarvisStateError("该跨工程迭代任务没有关联会话，无法重新执行")
                try:
                    state = _json.loads(target_conv.task_state or "{}")
                    if not isinstance(state, dict):
                        state = {}
                except (TypeError, ValueError):
                    state = {}
                state.update({
                    "migrate_task_id": tid,
                    "current_step": stage,
                    "step_status": "running",
                    "awaiting_confirmation": False,
                    "pipeline_start": True,
                })
                target_conv.task_state = _json.dumps(state, ensure_ascii=False)
                s.commit()
            _broadcast_iter_state(tid, {
                "current_step": stage,
                "step_status": "running",
                "awaiting_confirmation": False,
            })
            _broadcast_latest_iter_event(tid)
            return {"success": True, "data": {"task": res, "conv_id": conv_id}}
        except JarvisStateError as e:
            raise HTTPException(400, str(e))
        finally:
            if locked:
                try:
                    jarvis_state.release_lock(tid, str(conv_id))
                except Exception:
                    pass

    @app.post("/api/jarvis/tasks/{tid}/advance")
    def iter_task_advance(tid: int, payload: Dict = None):
        """确定性推进状态机（后端硬编码流转，LLM 无权跳转）：
        传入已采集参数（business_scene/split_rule/task_confirm 等），状态机校验后合法流转。
        执行锁：状态变更动作需先抢占锁，被其他会话占用时拒绝（只读）。"""
        payload = payload or {}
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            row = jarvis_state.get(tid)
            if row is None:
                raise JarvisStateError(f"跨工程迭代任务不存在: {tid}")
            _lk = jarvis_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise JarvisStateError(_lk["message"])
            payload.update(_collector_report_completion_params(row, payload, db))
            res = jarvis_state.update_params(tid, payload)
            _broadcast_iter_state(tid, {
                "current_step": res["task"]["status"],
                "step_status": "running",
            })
            _broadcast_latest_iter_event(tid)
        except JarvisStateError as e:
            raise HTTPException(400, str(e))
        # 状态推进完成后释放锁（阶段完成即释放，便于下一会话接管）
        try:
            jarvis_state.release_lock(tid, sid)
        except Exception:
            pass
        return {"success": True, "data": res}

    @app.post("/api/jarvis/tasks/{tid}/step-confirm")
    def iter_task_step_confirm(tid: int, payload: Dict = None):
        """切换逐级确认开关（DB 配置化，从任务读取）：
        step_confirm=True 时每个执行阶段完成后停驻等待用户确认，False 时一次性编排跑完。"""
        payload = payload or {}
        try:
            res = jarvis_state.set_step_confirm(tid, bool(payload.get("step_confirm", True)))
        except JarvisStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}

    @app.post("/api/jarvis/tasks/{tid}/strict-flow")
    def iter_task_strict_flow(tid: int, payload: Dict = None):
        """切换流程强校验：True=严格顺序，False=允许按用户指派自由选择阶段。"""
        payload = payload or {}
        try:
            res = jarvis_state.set_strict_flow(tid, bool(payload.get("strict_flow", True)))
        except JarvisStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}



    # ---------- 工作流模板版本 ----------
    @app.get("/api/workflow-templates")
    def workflow_templates(template_tag: str = "", source: str = "remote"):
        """按模板编码查询并解析工作流模板版本；source=remote 远端配置库 / local 直读本地 jarvis 库"""
        tag = (template_tag or "").strip()
        if not tag:
            raise HTTPException(400, "template_tag 不能为空")
        if source not in ("remote", "local"):
            raise HTTPException(400, "source 仅支持 remote/local")
        try:
            if source == "local":
                # 本地模式直读应用自身元数据库（mysql_url 指向的 jarvis 库），无需注册数据源
                with db.engine.connect() as connection:
                    return {"success": True, "data": build_workflow_template_response(
                        connection, tag, cfg.workflow.local_version_table)}
            with db_tools.connect(cfg.workflow.datasource_name) as connection:
                return {"success": True, "data": build_workflow_template_response(
                    connection, tag, cfg.workflow.version_table)}
        except (SQLAlchemyError, ValueError) as exc:
            raise HTTPException(503, f"工作流模板查询失败: {exc}") from exc

    @app.post("/api/workflow-templates/parse")
    def workflow_templates_parse(payload: Dict = None):
        """解析工作流模板 XML 文本（图形编辑器编辑后重新解析、刷新图形用）"""
        payload = payload or {}
        xml_text = str(payload.get("xml") or "").strip()
        if not xml_text:
            raise HTTPException(400, "xml 不能为空")
        try:
            graph = parse_workflow_xml(xml_text)
        except ValueError as exc:
            return {"success": True, "data": {"workflow": None, "parse_error": str(exc)}}
        return {"success": True, "data": {"workflow": graph, "parse_error": None}}

    # ---------- 数据分析（家庭订单中心） ----------
    @app.get("/api/analysis/centers")
    def analysis_centers():
        """业务中心与场景配置（前端初始化）"""
        return {"success": True, "data": list_centers(db)}

    @app.post("/api/analysis/{center_code}/query")
    def analysis_query(center_code: str, payload: Dict = None):
        """执行场景级联查询：根节点按业务主键，子节点按父结果关联字段 IN 查询"""
        payload = payload or {}
        try:
            data = execute_scene_query(
                db, db_tools, center_code,
                str(payload.get("scene_code") or ""),
                str(payload.get("business_key") or ""),
                str(payload.get("city_code") or "574"),
                bool(payload.get("in_transit", True)),
                str(payload.get("history_month") or ""),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.post("/api/analysis/{center_code}/query-node")
    def analysis_query_node(center_code: str, payload: Dict = None):
        """单节点实时查询（如点击调度订单后实时查工单）"""
        payload = payload or {}
        try:
            data = execute_node_query(
                db, db_tools, center_code,
                str(payload.get("scene_code") or ""),
                str(payload.get("node_code") or ""),
                str(payload.get("value") or ""),
                str(payload.get("city_code") or "574"),
                bool(payload.get("in_transit", True)),
                str(payload.get("history_month") or ""),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    def _family_params(in_transit: str, history_month: str) -> tuple[bool, str]:
        transit = (in_transit or "yes").strip() != "no"
        return transit, history_month.strip() if not transit else ""

    @app.get("/api/analysis/family-order/workflow")
    def analysis_family_workflow(order_id: str = "", scheduler_ids: str = "",
                                 city_code: str = "574", in_transit: str = "yes",
                                 history_month: str = ""):
        """工作流信息：主工作流/RBoss 工作流级联（工作流订单库）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_workflow(db_tools, order_id, scheduler_ids, city_code, transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/family-order/wired-message")
    def analysis_family_wired_message(task_id: str = "", done_date: str = "",
                                      message_type: str = "SEND_TO_IMEP",
                                      city_code: str = "574", in_transit: str = "yes",
                                      history_month: str = ""):
        """有线报文（送/回 IMEP、送/回 IRMS）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_wired_message(db_tools, task_id, done_date, message_type,
                                       city_code, transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/family-order/billing-message")
    def analysis_family_billing_message(cust_order_id: str = "", key_ele_id: str = "",
                                        done_date: str = "", city_code: str = "574",
                                        in_transit: str = "yes", history_month: str = ""):
        """计费报文（sendToBilling，ord_message_log 日表）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_billing_message(db_tools, cust_order_id, key_ele_id, done_date,
                                         city_code, transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/family-order/stage-reply")
    def analysis_family_stage_reply(task_id: str = "", city_code: str = "574",
                                    in_transit: str = "yes", history_month: str = ""):
        """阶段性回复（ORD_TASK_dealinfo）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_stage_reply(db_tools, task_id, city_code, transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/family-order/static-config")
    def analysis_family_static_config(code: str = ""):
        """静态配置（bs_para_detail / bs_static_data 按编码，家庭订单库）"""
        try:
            data = query_static_config(db_tools, code)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.post("/api/analysis/family-order/decrypt")
    def analysis_family_decrypt(payload: Dict = None):
        """SM4 加密字段解密（密文信封 → 密码服务 /api/decrypt）"""
        try:
            data = decrypt_cipher_value(payload or {})
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.post("/api/analysis/family-order/decrypt-batch")
    def analysis_family_decrypt_batch(payload: Dict = None):
        """批量解密裸密文（客户订单属性自动解密；结果按入参顺序对齐）"""
        payload = payload or {}
        ciphers = payload.get("ciphers")
        if not isinstance(ciphers, list) or not ciphers:
            raise HTTPException(400, "ciphers 不能为空")
        if len(ciphers) > 100:
            raise HTTPException(400, "单次最多解密 100 条")
        return {"success": True, "data": decrypt_cipher_batch([str(c) for c in ciphers])}

    @app.get("/api/analysis/family-order/async-flow")
    def analysis_family_async_flow(order_id: str = "", city_code: str = "574",
                                   in_transit: str = "yes", history_month: str = ""):
        """异步流程（ord_async_method_deal_task_order，家庭订单库）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_async_flow(db_tools, order_id, city_code, transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-center/product-config")
    def analysis_product_config(product_item_id: str = ""):
        """档次配置（up_product_item/up_item_feature/up_plan_plan_rel，产品库）"""
        try:
            data = query_product_config(db_tools, product_item_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-center/plan-config")
    def analysis_plan_config(product_item_id: str = ""):
        """策划配置（档次配置/特性/预占限制/关联产品，产品库）"""
        try:
            data = query_plan_config(db_tools, product_item_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-drive-center/up-rule")
    def analysis_up_rule(rule_id: str = ""):
        """框架规则定义（busicfg.UP_RULE 按规则ID，家庭业务配置库；框架规则点击弹窗）"""
        try:
            data = query_up_rule(db_tools, rule_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-center/business-info")
    def analysis_business_info(business_id: str = ""):
        """业务信息（product.up_business 按业务ID，产品库；业务关系点击弹窗）"""
        try:
            data = query_business_info(db_tools, business_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-center/item-relat")
    def analysis_item_relat(product_item_id: str = ""):
        """属性信息（product.up_item_relat，单产品资费服务关系，产品库）"""
        try:
            data = query_item_relat(db_tools, product_item_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-center/pre-lmt-param")
    def analysis_pre_lmt_param(limit_code: str = "", param_id: str = ""):
        """限制参数（product.UP_PRE_LMT_PARAM，按 rule_exp 拆分的 limit_code + param_id）"""
        try:
            data = query_pre_lmt_param(db_tools, limit_code, param_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-center/so-pre-busi-limit")
    def analysis_so_pre_busi_limit(limit_code: str = ""):
        """业务限制（rule_Cfg.SO_PRE_BUSI_LIMIT，规则配置库；限制参数 limit_code 点击弹窗）"""
        try:
            data = query_so_pre_busi_limit(db_tools, limit_code)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/product-drive-center/product-drive")
    def analysis_product_drive(product_item_id: str = "", offer_id: str = "",
                               category: str = "role"):
        """产品驱动（家庭业务中心，角色/策划/产品/终端 四类；档次/策划编号入参）"""
        try:
            data = query_product_drive(db_tools, product_item_id, offer_id, category)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/instance-center/user-info")
    def analysis_instance_user(bill_id: str = "", city_code: str = ""):
        """用户信息（so570{city}.ins_user_{city} 按计费账号，营业库）"""
        try:
            data = query_instance_user(db_tools, bill_id, city_code)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/instance-center/order-info")
    def analysis_instance_order(bill_id: str = "", city_code: str = ""):
        """订购信息（按计费账号，营业库；表名待确认）"""
        try:
            data = query_instance_order(db_tools, bill_id, city_code)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/hall-center/order-message")
    def analysis_hall_order_message(cust_order_id: str = "", city_code: str = "574",
                                    in_transit: str = "yes", history_month: str = ""):
        """客户订单下单报文（hall_cust_dtl，客户订单库 OceanBase）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_customer_order_message(db_tools, cust_order_id, city_code,
                                                transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/hall-center/accept-message")
    def analysis_hall_accept_message(cust_order_id: str = "", task_flow_ins_id: str = ""):
        """流程实例受理报文（HALL_ORDER_BUSI_LOG 最近一条，客户订单库 OceanBase）"""
        try:
            data = query_accept_message(db_tools, cust_order_id, task_flow_ins_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/hall-center/structured-order-info")
    def analysis_hall_structured_order_info(cust_order_id: str = "", city_code: str = "574",
                                            in_transit: str = "yes", history_month: str = ""):
        """结构化订单信息（17 张 HALL_ORD_* 表并行查询，客户订单库 OceanBase）"""
        transit, month = _family_params(in_transit, history_month)
        try:
            data = query_structured_order_info(db_tools, cust_order_id, city_code,
                                               transit, month)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.post("/api/analysis/hall-center/retry-task")
    def analysis_hall_retry_task(payload: Dict = None):
        """工单重试（task_type=5）：在途 HALL_TASK 的 TASK_STATE 置 2（固定模板写操作）"""
        payload = payload or {}
        try:
            data = retry_hall_task(db_tools, str(payload.get("cust_order_id") or ""),
                                   str(payload.get("task_id") or ""))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if not data.get("ok"):
            raise HTTPException(502, data.get("message") or "重试失败")
        return {"success": True, "data": data}

    @app.get("/api/analysis/hall-center/def-scene")
    def analysis_hall_def_scene(scene_id: str = ""):
        """展示场景（DEF_SCENE 场景定义，客户订单配置库 HALLCFG）"""
        try:
            data = query_def_scene(db_tools, scene_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/hall-center/scene-rules")
    def analysis_hall_scene_rules(scene_id: str = ""):
        """配置查询：按场景ID查 规则定义(DEF_RULE)，客户订单配置库"""
        try:
            data = query_scene_rules(db_tools, scene_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}

    @app.get("/api/analysis/hall-center/busi-cmpt")
    def analysis_hall_busi_cmpt(busi_cmpt_id: str = ""):
        """业务组件定义（DEF_BUSI_CMPT 按 BUSI_CMPT_ID，客户订单配置库）"""
        try:
            data = query_busi_cmpt(db_tools, busi_cmpt_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"success": True, "data": data}





    # ---------- 任务流程静态表（页面可编排，状态机按此表驱动） ----------
    @app.get("/api/jarvis/flow")
    def iter_flow_get():
        """获取任务流程编排（按 sort_order 排序；空表返回默认流程）"""
        try:
            return {"success": True, "data": jarvis_state.get_flow()}
        except JarvisStateError as e:
            raise HTTPException(400, str(e))

    @app.put("/api/jarvis/flow")
    def iter_flow_save(payload: Dict):
        """全量保存流程编排：按传入顺序重建节点（支持增删/排序/开关确认闸门/启停）"""
        nodes = payload.get("nodes")
        if not isinstance(nodes, list):
            raise HTTPException(400, "nodes 必须为数组")
        try:
            return {"success": True, "data": jarvis_state.save_flow(nodes)}
        except JarvisStateError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/jarvis/flow/reset")
    def iter_flow_reset():
        """恢复默认流程（清空编排记录）"""
        try:
            return {"success": True, "data": jarvis_state.reset_flow()}
        except JarvisStateError as e:
            raise HTTPException(400, str(e))

    # ---------- 首页 ----------
    @app.get("/")
    def index():
        index_file = Path(static_dir) / "index.html"
        # Task 11 创建前端页面之前，index.html 尚不存在；先返回占位 JSON 保证 200
        if not index_file.exists():
            return JSONResponse({"success": True, "message": "前端尚未部署"})
        return FileResponse(str(index_file))

    # ---------- 安全网关 ----------
    from jarvis_agent.security import SecurityGateway
    gateway = SecurityGateway(api_key=cfg.api_key, rate_limit_per_min=cfg.rate_limit,
                              security_log=cfg.security_log)
    # 数据库只读操作审计挂接
    db_tools.audit = lambda kind, name, note: gateway.audit(
        db, "SQL", f"/api/datasources/{name}/{kind}", "", 200, 0, note)
    import time as _time

    @app.middleware("http")
    async def security_gateway_middleware(request, call_next):
        ip = request.client.host if request.client else ""
        denied = gateway.authorize(ip, request.headers)
        if denied:
            status, msg = ((401, "鉴权失败：无效的 API Key")
                           if denied == "invalid_api_key"
                           else (429, "请求过于频繁，请稍后再试"))
            gateway.audit(db, request.method, request.url.path, ip, status,
                          0, "" if not denied else f"deny:{denied}")
            return JSONResponse({"success": False, "detail": msg}, status_code=status)
        start = _time.time()
        response = await call_next(request)
        duration = int((_time.time() - start) * 1000)
        if request.url.path.startswith("/api/"):
            gateway.audit(db, request.method, request.url.path, ip,
                          response.status_code, duration)
        return response

    # 安全审计查询
    @app.get("/api/security/logs")
    def security_logs(limit: int = 100):
        if not cfg.security_log:
            return {"success": True, "data": []}
        with db.session() as s:
            from sqlalchemy import select
            from jarvis_agent.db import SecurityLog
            rows = list(s.scalars(select(SecurityLog)
                                  .order_by(SecurityLog.id.desc()).limit(min(limit, 500))))
            return {"success": True, "data": [{
                "id": r.id, "method": r.method, "path": r.path, "ip": r.ip,
                "status": r.status, "duration_ms": r.duration_ms, "notes": r.notes,
                "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows]}

    return app
