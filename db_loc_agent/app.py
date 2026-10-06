"""FastAPI 应用：REST + SSE 对话流 + 静态页"""
from __future__ import annotations

import asyncio
import functools
import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from db_loc_agent.agents import AgentService, PipelineService
from db_loc_agent.artifacts import ArtifactService, NamespaceError
from db_loc_agent.assets import MigrateAssetService, REPORT_TEMPLATE
from db_loc_agent.attachments import SUPPORTED_EXT, create_attachment, extract_text
from db_loc_agent.config import AppConfig, LLMSettings, load_config
from db_loc_agent.db import Conversation, Database, Message, ProjectTask, Space, SpaceSubsystem, TemplateRecord
from db_loc_agent.db_tools import DbTools
from db_loc_agent.embedding import create_embedding_function
from db_loc_agent.gov import GovService
from db_loc_agent.graph import AgentState, build_graph
from db_loc_agent.kg import KnowledgeGraph
from db_loc_agent.llm import create_chat_model
from db_loc_agent.ops import OpsService
from db_loc_agent.project import ProjectError, ProjectService
from db_loc_agent.prompts import PromptService
from db_loc_agent.rag import RAGStore
from db_loc_agent.rule_engine import RuleEngine
from db_loc_agent.skills import SkillService
from db_loc_agent.state_machine import (MigrateStateError, MigrateStateService,
                                        normalize_db_type, parse_migrate_params,
                                        status_label)


def _conv_key(conv: Conversation) -> str:
    return f"sess_{conv.id if conv.id is not None else 0}"


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


def create_app(db_path: str = "data/db.sqlite3", artifact_root: str = "artifacts",
               faiss_dir: str = "data/faiss", config_override: Optional[Dict] = None,
               static_dir: Optional[str] = None,
               embedding_function: Optional[Any] = None):
    cfg = load_config()
    if config_override:
        for key, value in config_override.items():
            if key == "llm" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.llm, k):
                        setattr(cfg.llm, k, v)
            elif hasattr(cfg, key):
                setattr(cfg, key, value)
    cfg.db_path, cfg.artifact_root, cfg.faiss_dir = db_path, artifact_root, faiss_dir

    db = Database(db_path, cfg.mysql_url or None)
    prompts = PromptService(db)
    skills = SkillService(db, str(Path(db_path).parent / "skills"))
    artifacts = ArtifactService(db, artifact_root)
    proj = ProjectService(db)
    agents_svc = AgentService(db)
    db_tools = DbTools(db)
    from db_loc_agent.schema_diff import SchemaDiffService
    schema_diff = SchemaDiffService(db_tools, db)
    kg = KnowledgeGraph(db)
    gov = GovService(db, db_tools, kg)
    ops = OpsService(db, db_tools, slow_threshold_ms=500)
    # 只读查询耗时观测：慢查询落库（喂给运维慢 SQL 诊断/性能基线）
    db_tools.obs_query = ops.record_query
    embed_fn = embedding_function or create_embedding_function(cfg.llm)
    rag = RAGStore(db, faiss_dir, cfg.kb_collection, embed_fn)

    # ---- 数据库迁移拔高能力：状态机 / 规则引擎 / 结构化资产 ----
    from db_loc_agent.agents import SysDictService
    rule_engine = RuleEngine(SysDictService(db))
    migrate_state = MigrateStateService(db)
    migrate_assets = MigrateAssetService(db)
    migrate_assets.rule_engine = rule_engine  # 装配：扫描结果直接写资产表

    # 迁移对象扫描演示样例（规则引擎素材兜底：无真实对象可扫时保证演示稳定）
    _DEMO_MIGRATE_OBJECTS = [
        {"asset_type": "table", "asset_name": "t_user_order",
         "original_sql": "CREATE TABLE t_user_order (\n"
                         "  order_id NUMBER(12) PRIMARY KEY,\n  user_id NUMBER(10) NOT NULL,\n"
                         "  order_amount NUMBER(10,2),\n  create_time DATE DEFAULT SYSDATE,\n"
                         "  remark VARCHAR2(200),\n status VARCHAR2(20)\n)"},
        {"asset_type": "table", "asset_name": "t_biz_account",
         "original_sql": "CREATE TABLE t_biz_account (\n"
                         "  id NUMBER(12) PRIMARY KEY,\n  account_no VARCHAR2(50) NOT NULL,\n"
                         "  balance NUMBER(14,2) DEFAULT 0,\n  txn_count NUMBER(10),\n"
                         "  update_time DATE DEFAULT SYSDATE\n)"},
        {"asset_type": "procedure", "asset_name": "p_calc_balance",
         "original_sql": "CREATE OR REPLACE PROCEDURE p_calc_balance(p_uid NUMBER) AS\n"
                         "  v_bal NUMBER;\nBEGIN\n"
                         "  SELECT NVL(SUM(amount), 0) INTO v_bal FROM t_ledger WHERE uid = p_uid;\n"
                         "  UPDATE t_biz_account SET balance = v_bal WHERE id = p_uid;\n"
                         "  COMMIT;\nEND;"},
        {"asset_type": "function", "asset_name": "f_get_rowexist",
         "original_sql": "CREATE OR REPLACE FUNCTION f_get_rowexist(p_tab VARCHAR2) RETURN NUMBER AS\n"
                         "  v_cnt NUMBER;\nBEGIN\n"
                         "  SELECT COUNT(*) INTO v_cnt FROM t_user_order WHERE ROWNUM = 1;\n"
                         "  RETURN v_cnt;\nEND;"},
        {"asset_type": "trigger", "asset_name": "trg_order_no",
         "original_sql": "CREATE OR REPLACE TRIGGER trg_order_no BEFORE INSERT ON t_user_order\n"
                         "FOR EACH ROW\nBEGIN\n  :NEW.order_id := seq_order.NEXTVAL;\nEND;"},
        {"asset_type": "view", "asset_name": "v_order_report",
         "original_sql": "CREATE OR REPLACE VIEW v_order_report AS\n"
                         "SELECT o.*, ROWNUM rn FROM t_user_order o WHERE o.status = 'N';"},
        {"asset_type": "procedure", "asset_name": "p_org_tree",
         "original_sql": "CREATE OR REPLACE PROCEDURE p_org_tree(p_root NUMBER) AS\nBEGIN\n"
                         "  SELECT * FROM t_org WHERE CONNECT BY PRIOR org_id = parent_id START WITH org_id = p_root;\nEND;"},
        {"asset_type": "function", "asset_name": "f_grade",
         "original_sql": "CREATE OR REPLACE FUNCTION f_grade(p_score NUMBER) RETURN VARCHAR2 AS BEGIN\n"
                         "  RETURN DECODE(SIGN(p_score - 90), 1, 'A', 0, 'A', 'B');\nEND;"},
    ]

    def _gen_create_ddl(obj_name: str, cols: List[Dict], flavor: str = "oracle") -> str:
        """由探查到的列定义生成 CREATE TABLE DDL（Oracle/MySQL 风格），供规则引擎静态扫描。"""
        up = (flavor or "oracle").lower()
        lines = [f"CREATE TABLE {obj_name} ("]
        for c in cols:
            cname = str(c.get("name") or "")
            ctype = str(c.get("type") or "VARCHAR2(255)")
            parts = [cname, ctype]
            if c.get("pk"):
                parts.append("PRIMARY KEY")
            lines.append("  " + ", ".join(parts) + ",")
        lines[-1] = lines[-1].rstrip(",")
        lines.append(")")
        if up == "mysql":
            lines.append("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
        return "\n".join(lines)

    def _scan_migrate_objects(task_db_id: int, source_ds_name: str,
                              source_db_type: str) -> Dict:
        """扫描数据源对象 → 规则引擎打风险 → 结构化资产落库（真实对象优先，样例兜底）。"""
        objs: List[Dict] = []
        if source_ds_name:
            try:
                res = db_tools.inspect_schema(source_ds_name)
                if res.get("ok"):
                    for t in (res.get("tables") or [])[:80]:
                        try:
                            detail = db_tools.inspect_schema(source_ds_name, str(t))
                            if detail.get("ok") and detail.get("columns"):
                                objs.append({
                                    "asset_type": "table", "asset_name": str(t),
                                    "original_sql": _gen_create_ddl(
                                        str(t), detail["columns"], source_db_type),
                                })
                        except Exception:
                            objs.append({"asset_type": "table", "asset_name": str(t),
                                         "original_sql": f"-- 表 {t}（结构探查失败）\nSELECT * FROM {t};"})
                    for v in (res.get("views") or [])[:30]:
                        objs.append({"asset_type": "view", "asset_name": str(v),
                                     "original_sql": f"CREATE OR REPLACE VIEW {v} AS\nSELECT * FROM {v};"})
            except Exception:
                objs = []
        if not objs:
            objs = [dict(x) for x in _DEMO_MIGRATE_OBJECTS]
        findings_total = 0
        for obj in objs:
            scan = rule_engine.scan(obj["original_sql"], obj["asset_name"], obj["asset_type"])
            if scan["findings"]:
                findings_total += len(scan["findings"])
                migrate_assets.upsert(task_db_id, {
                    "asset_type": obj["asset_type"], "asset_name": obj["asset_name"],
                    "risk_level": ("高" if scan["summary"]["high"] else
                                   ("中" if scan["summary"]["medium"] else "低")),
                    "incompatible_detail": json.dumps(scan["findings"], ensure_ascii=False),
                    "rule_ids": json.dumps(scan["hit_rules"], ensure_ascii=False),
                    "original_sql": obj["original_sql"],
                    "suggestion": "；".join(dict.fromkeys(f["suggest"] for f in scan["findings"]))[:500],
                    "source": "rule_engine", "status": "待改造",
                })
        return {"object_count": len(objs), "findings": findings_total,
                "assets": migrate_assets.stats(task_db_id)}

    app = FastAPI(title=cfg.name, version="0.1.0")
    if static_dir is None:
        static_dir = str(Path(__file__).resolve().parent / "web")
    Path(static_dir).mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    # ---------- 健康与设置 ----------
    @app.get("/api/health")
    def health():
        return {"status": "ok", "name": cfg.name}

    @app.get("/api/me")
    def current_user():
        """当前登录用户信息（轻量：仅展示用，不做真实鉴权）。从 DB user_profiles 读取。"""
        from sqlalchemy import select
        from db_loc_agent.db import UserProfile
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
        - bailian / deepseek：尝试 OpenAI 兼容 /models 接口，失败时回退内置预设列表
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

        # bailian / deepseek：OpenAI 兼容 /models
        from db_loc_agent.llm import DEEPSEEK_BASE, BAILIAN_BASE
        base_map = {"deepseek": DEEPSEEK_BASE, "bailian": BAILIAN_BASE}
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

    # ---------- 会话 ----------
    @app.get("/api/conversations")
    def list_conversations(space_id: Optional[int] = None,
                           sub_system_id: Optional[int] = None):
        with db.session() as s:
            from sqlalchemy import func, select
            q = select(Conversation)
            if space_id:
                q = q.where(Conversation.space_id == space_id)
            if sub_system_id:
                q = q.where(Conversation.sub_system_id == sub_system_id)
            rows = list(s.scalars(q.order_by(Conversation.id.desc())))
            data = []
            for c in rows:
                task = s.get(ProjectTask, c.task_id) if c.task_id else None
                task_name = task.name if task else ""
                # 归属任务的会话，若未显式记录空间/子系统则从任务继承
                eff_space_id = c.space_id or (task.space_id if task else None)
                eff_sub_id = c.sub_system_id or (task.sub_system_id if task else None)
                space_name = ""
                if eff_space_id:
                    sp = s.get(Space, eff_space_id)
                    space_name = sp.name if sp else ""
                sub_name = ""
                if eff_sub_id:
                    ss = s.get(SpaceSubsystem, eff_sub_id)
                    sub_name = ss.name if ss else ""
                msg_count = s.query(func.count(Message.id)).filter(Message.conv_id == c.id).scalar() or 0
                data.append({"id": c.id, "title": c.title,
                             "space_id": eff_space_id, "space_name": space_name,
                             "sub_system_id": eff_sub_id, "sub_system_name": sub_name,
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
            sub_system_id = payload.get("sub_system_id")
            # 归属任务时自动继承任务的空间与子系统（未显式指定时）
            if task_id and (space_id is None or sub_system_id is None):
                t = s.get(ProjectTask, int(task_id))
                if t:
                    space_id = space_id if space_id is not None else t.space_id
                    sub_system_id = sub_system_id if sub_system_id is not None else t.sub_system_id
            c = Conversation(title=payload.get("title") or "新会话",
                             space_id=space_id,
                             sub_system_id=sub_system_id,
                             task_id=task_id,
                             agent_id=str(payload.get("agent_id") or ""))
            s.add(c)
            s.commit()
            s.refresh(c)
            return {"success": True, "data": {"id": c.id, "title": c.title,
                                              "task_id": c.task_id}}

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
        """快速问答会话 → 项目会话：为会话绑定空间与（可选）子系统归属"""
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
            sub_id = payload.get("sub_system_id")
            if sub_id:
                ss = s.get(SpaceSubsystem, sub_id)
                if not ss or ss.space_id != space_id:
                    raise HTTPException(400, "子系统不属于该空间")
            c.space_id = space_id
            c.sub_system_id = sub_id or None
            s.commit()
            space_name = sp.name or ""
            sub_name = ""
            if c.sub_system_id:
                sub_name = (s.get(SpaceSubsystem, c.sub_system_id) or type("_", (), {"name": ""})).name
            task_name = ""
            if c.task_id:
                t = s.get(ProjectTask, c.task_id)
                task_name = t.name if t else ""
            return {"success": True, "data": {
                "id": c.id, "title": c.title, "space_id": c.space_id, "space_name": space_name,
                "sub_system_id": c.sub_system_id, "sub_system_name": sub_name,
                "task_id": c.task_id, "task_name": task_name, "agent_id": c.agent_id}}

    @app.delete("/api/conversations/{cid}")
    def delete_conversation(cid: int):
        """删除会话：级联清理消息、trace 与本地产物（知识库已入库副本保留隔离）"""
        import shutil
        from pathlib import Path as _Path
        from sqlalchemy import select
        from db_loc_agent.db import ArtifactRecord, ChatTrace, Message
        with db.session() as s:
            c = s.get(Conversation, cid)
            if not c:
                raise HTTPException(404, "会话不存在")
            s.query(Message).filter(Message.conv_id == cid).delete(synchronize_session=False)
            s.query(ChatTrace).filter(ChatTrace.conv_id == cid).delete(synchronize_session=False)
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
    def list_api_agents():
        return {"success": True, "data": agents_svc.all()}

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
                alias=str(payload.get("alias", "")).strip())}
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

    # ---------- 数据源（只读） ----------
    @app.get("/api/datasources")
    def list_datasources(space_id: Optional[int] = None,
                         sub_system_id: Optional[int] = None):
        if sub_system_id is not None and space_id is None:
            raise HTTPException(400, "按子系统过滤数据源时须同时指定空间")
        return {"success": True, "data": db_tools.list(space_id, sub_system_id)}

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
        try:
            r = db_tools.query(name, sql)
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

    # ---------- 双库 Schema Diff（确定性比对） ----------
    @app.post("/api/schema-diff")
    def schema_diff_compare(payload: Dict):
        source = str(payload.get("source", "")).strip()
        target = str(payload.get("target", "")).strip()
        if not source or not target:
            raise HTTPException(400, "需同时提供 source 与 target 数据源名称")
        if source == target:
            raise HTTPException(400, "源库与目标库不能相同")
        try:
            return {"success": True, "data": schema_diff.compare(source, target)}
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(400, f"比对失败: {e}")

    # ---------- 迁移后运维（第二级） ----------
    @app.get("/api/ops/health/history")
    def ops_check_history(limit: int = 50):
        return {"success": True, "data": ops.check_history(limit)}

    @app.post("/api/ops/health")
    def ops_health_check(payload: Optional[Dict] = None):
        """对（指定或全部启用）数据源执行健康巡检"""
        return ops.health_check(str((payload or {}).get("ds", "")))

    @app.get("/api/ops/slow-sql")
    def ops_slow_sql(threshold_ms: int = 0, limit: int = 50):
        return ops.slow_queries(threshold_ms, limit)

    @app.get("/api/ops/baseline")
    def ops_baseline():
        return ops.baseline()

    # ---------- 多数据库统一管理与数据治理（第三级） ----------
    @app.post("/api/gov/catalog")
    def gov_catalog(payload: Optional[Dict] = None):
        """抽取（指定或全部启用）数据源元数据资产目录"""
        return gov.catalog(str((payload or {}).get("ds", "")))

    @app.get("/api/gov/assets")
    def gov_assets(ds: str = ""):
        return {"success": True, "data": gov.assets(ds)}

    @app.post("/api/gov/quality")
    def gov_quality(payload: Optional[Dict] = None):
        """对已建资产目录的表生成数据质量评分"""
        return gov.quality(str((payload or {}).get("ds", "")))

    @app.get("/api/gov/quality/rows")
    def gov_quality_rows(ds: str = ""):
        return {"success": True, "data": gov.quality_rows(ds)}

    @app.post("/api/gov/kgsync")
    def gov_kgsync():
        """将治理资产目录同步为知识图谱实体/关系"""
        return gov.kg_sync()

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
        from db_loc_agent.db import DocumentRecord
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
        from db_loc_agent.db import Space, DocumentRecord
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
        from db_loc_agent.db import Space
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
        from db_loc_agent.db import Space
        with db.session() as s:
            sp = s.get(Space, space_id)
            if not sp:
                raise HTTPException(404, "空间不存在")
            s.delete(sp)
            s.commit()
            return {"success": True}

    @app.get("/api/kb/documents")
    def list_docs(space_id: Optional[int] = None, sub_system_id: Optional[int] = None):
        with db.session() as s:
            from sqlalchemy import select
            from db_loc_agent.db import DocumentRecord
            q = select(DocumentRecord)
            if space_id:
                q = q.where(DocumentRecord.space_id == space_id)
            if sub_system_id:
                q = q.where(DocumentRecord.sub_system_id == sub_system_id)
            rows = list(s.scalars(q.order_by(DocumentRecord.id.desc())))
            return {"success": True, "data": [{"id": r.id, "name": r.name, "source_type": r.source_type,
                                               "chunk_count": r.chunk_count, "enabled": r.enabled,
                                               "space_id": r.space_id, "sub_system_id": r.sub_system_id,
                                               "kb_type": r.kb_type if hasattr(r, "kb_type") else "doc",
                                               "created_at": r.created_at.isoformat()} for r in rows]}

    @app.post("/api/kb/documents")
    async def upload_doc(file: UploadFile = File(...),
                         space_id: Optional[int] = Form(None),
                         sub_system_id: Optional[int] = Form(None),
                         kb_type: Optional[str] = Form("doc")):
        name = file.filename or "unnamed"
        ext = Path(name).suffix.lstrip(".").lower()
        if ext not in ("md", "sql", "txt", "pdf"):
            raise HTTPException(400, f"不支持的文档类型: {ext}（支持 md/sql/txt/pdf）")
        kb_type = (kb_type or "doc").strip()
        if kb_type not in ("rules", "cases", "doc", "ops"):
            kb_type = "doc"  # 分层知识库：rules 规则库 / cases 案例库 / doc 归档文档 / ops 运维手册
        raw = await file.read()
        if len(raw) > 5 * 1024 * 1024:
            raise HTTPException(400, "文件超过 5MB")
        kb_dir = Path(db_path).parent / "kb_files"
        kb_dir.mkdir(parents=True, exist_ok=True)
        target = kb_dir / name
        if ext == "pdf":
            # 保存原始 PDF 用于溯源，同时提取文本供向量化（落盘为同名 .txt）
            target.write_bytes(raw)
            from db_loc_agent.rag import extract_pdf_text
            try:
                text = extract_pdf_text(raw)
            except Exception:
                raise HTTPException(400, "PDF 文件解析失败（文件可能损坏或加密）")
            if not text.strip():
                raise HTTPException(400, "未能从 PDF 中提取到文本（可能是扫描件/图片型 PDF）")
            target = kb_dir / f"{Path(name).stem}.txt"
            target.write_text(text, encoding="utf-8")
        else:
            target.write_bytes(raw)
        with db.session() as s:
            from db_loc_agent.db import DocumentRecord
            rec = DocumentRecord(name=name, source_type=ext, doc_path=str(target),
                                 space_id=space_id, sub_system_id=sub_system_id,
                                 kb_type=kb_type)
            s.add(rec)
            s.commit()
            s.refresh(rec)
            doc_id = rec.id
        info = rag.add_document(doc_id, name, ext, str(target), space_id=space_id,
                                kb_type=kb_type)
        return {"success": True, "data": {"id": doc_id, "chunks": info["chunks"]}}

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
    def kb_search(q: str, top_k: int = 4, space_id: Optional[int] = None):
        return {"success": True, "data": rag.search(q, top_k, space_id=space_id)}

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
        from db_loc_agent.db import KGEntity
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
            payload.get("sub_system_id"), str(payload.get("description", "")),
            payload.get("kb_ids"), str(payload.get("agent_id", "")),
            str(payload.get("creator", "")))}

    @app.get("/api/tasks/{tid}")
    @_project_handler
    def get_task(tid: int):
        return {"success": True, "data": proj.get_task(tid)}

    @app.get("/api/tasks/{tid}/migrate-task")
    def get_task_migrate_task(tid: int):
        """通过业务任务 ID 查找关联的迁移任务，返回与工作台迁移面板一致的任务详情：
        优先级：
        1. 任务下会话 task_state JSON 中的 migrate_task_id（权威关联）；
        2. 任务下会话按 conv_id 匹配（若迁移任务 conv_id 存的是会话 ID）；
        3. 兜底：按 DbMigrateTask.conv_id == tid 匹配（若 conv_id 存的是业务任务 ID）。"""
        import json as _json
        from db_loc_agent.db import Conversation, DbMigrateTask
        from sqlalchemy import select

        def _pack(row) -> Dict:
            data = migrate_state.to_dict(row)
            data["assets"] = migrate_assets.list(row.id)
            data["assets_stats"] = migrate_assets.stats(row.id)
            return data

        with db.session() as s:
            convs = list(s.scalars(
                select(Conversation).where(Conversation.task_id == tid).order_by(Conversation.id)))
        for c in convs:
            # 1. 权威：会话 task_state JSON 中的 migrate_task_id
            ts_raw = (c.task_state or "").strip()
            if ts_raw:
                try:
                    ts = _json.loads(ts_raw)
                    mid = ts.get("migrate_task_id") if isinstance(ts, dict) else None
                    if mid:
                        row = migrate_state.get(int(mid))
                        if row is not None:
                            return {"success": True, "data": _pack(row)}
                except Exception:
                    pass
            # 2. 迁移任务 conv_id 若存的是会话 ID
            row = migrate_state.get_by_conv(c.id)
            if row is not None:
                return {"success": True, "data": _pack(row)}
        # 3. 兜底：迁移任务 conv_id 若存的是业务任务 ID
        with db.session() as s:
            row = s.scalar(select(DbMigrateTask).where(
                DbMigrateTask.conv_id == tid).order_by(DbMigrateTask.id.desc()))
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
        from db_loc_agent.db import ArtifactRecord
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

    @app.put("/api/artifacts/{rid}")
    def rename_artifact(rid: int, payload: Dict):
        """重命名产物（仅改展示名 object_name；文件、知识库副本不受影响）"""
        name = str(payload.get("object_name", "")).strip()
        if not name:
            raise HTTPException(400, "产物名称不能为空")
        from sqlalchemy import select
        from db_loc_agent.db import ArtifactRecord
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
        from db_loc_agent.db import ArtifactRecord, DocumentRecord
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
        from db_loc_agent.db import ArtifactRecord
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
        from db_loc_agent.db import MCPRecord
        with db.session() as s:
            rows = list(s.scalars(select(MCPRecord).order_by(MCPRecord.id)))
            return {"success": True, "data": [
                {"id": r.id, "name": r.name, "kind": r.kind,
                 "command_or_url": r.command_or_url, "enabled": r.enabled} for r in rows]}

    @app.post("/api/mcp/servers")
    def create_mcp_server(payload: Dict):
        from db_loc_agent.db import MCPRecord
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
        from db_loc_agent.db import MCPRecord
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
        from db_loc_agent.db import ModelDef
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
        from db_loc_agent.db import ModelDef
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
        from db_loc_agent.db import ModelDef
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
        from db_loc_agent.db import ModelDef
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
        from db_loc_agent.db import ModelDef
        with db.session() as s:
            r = s.get(ModelDef, mid)
            if not r:
                raise HTTPException(404, "模型不存在")
            r.status = "已启用" if payload.get("enabled", True) else "已停用"
            s.commit()
            return {"success": True, "data": {"id": r.id, "status": r.status}}

    @app.delete("/api/models/{mid}")
    def delete_model(mid: int):
        from db_loc_agent.db import ModelDef
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
                            from db_loc_agent.db import DocumentRecord
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
        from db_loc_agent.db import ChatTrace
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
        from db_loc_agent.db import Message
        with db.session() as s:
            rows = list(s.scalars(select(Message)
                                  .where(Message.conv_id == cid)
                                  .order_by(Message.id)))
            return {"success": True, "data": [{
                "id": r.id, "role": r.role, "content": r.content,
                "agent_id": r.agent_id,
                "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows]}

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
        llm = create_chat_model(cfg.llm)
        graph = build_graph(llm=llm, rag_search=rag.search, prompt_service=prompts,
                            artifact_service=artifacts, skill_service=skills, config=cfg,
                            agent_service=agents_svc, pipeline_service=PipelineService(db),
                            db_tools=db_tools, kg=kg,
                            ops=ops, gov=gov,
                            rag_enabled=not _quick, datasources_enabled=not _quick,
                            migrate_assets=migrate_assets, migrate_state=migrate_state,
                            max_iterations=8)  # 迁移流水线需串行编排 4-5 个子 Agent，默认 3 会中途截断

        def event(name: str, content: Any) -> str:
            return f"data: {json.dumps({'type': name, 'content': content}, ensure_ascii=False)}\n\n"

        def trace(node: str, content: Any, agent_id: str = ""):
            from db_loc_agent.db import ChatTrace
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

        async def gen():
            from db_loc_agent.db import Message

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
                # 会话绑定的业务任务 ID：迁移任务 conv_id 优先记录业务任务 ID（「空间>任务」详情页反查用），
                # 未绑定业务任务时回退会话 ID（记录最近活跃会话）
                biz_task_id = _c.task_id if _c else None
                _conv_ref = biz_task_id if biz_task_id is not None else conv_id

            # ---- 领域状态机：确定性流转（不依赖 LLM 记忆，支持断点续跑） ----
            # 迁移流程由后端硬编码状态机控制：INIT→选源→采集基础信息→扫对象→评估→
            # SQL转换→方案→验证→完成。指挥官只负责对话/渲染表单/调度子 Agent，无权跳转。
            # 断点续跑：任务中途关闭会话再打开，从 db_migrate_task 当前状态继续，不重复采集。
            migrate_evt: Optional[Dict] = None  # 本轮状态机推进事件（前端进度展示用）
            _MIGRATE_INTENT_RE = re.compile(r"迁移|国产化|兼容性评估|数据迁移|数据库改造|选仓|选达梦")
            is_migration_flow = bool(
                agent_id == "migration_commander"
                or task_state.get("migrate_task_id")
                or _MIGRATE_INTENT_RE.search(user_input))
            if is_migration_flow:
                _M_EXEC_STATES = ("OBJECT_SCANNING", "ASSESSMENT_RUNNING", "SQL_TRANSFORM",
                                  "SOLUTION_GENERATE", "VERIFY_STAGE", "FINISHED")
                mpr = parse_migrate_params(user_input)
                # 别名归一：source_data_id / datasource → source_ds_id
                if not mpr.get("source_ds_id"):
                    for _alias in ("source_data_id", "datasource", "source_db"):
                        if mpr.get(_alias):
                            mpr["source_ds_id"] = mpr[_alias]
                            break
                # 合并会话历史参数（断点续跑：已采集参数跨轮保留）
                merged_params = dict(task_state.get("task_params") or {})
                for _k, _v in mpr.items():
                    merged_params[_k] = _v
                # 解析数据源 ID → 名称（用于状态机权威回写）
                def _resolve_ds_name(ds_ident: str) -> str:
                    try:
                        for d in db_tools.list():
                            if str(d["id"]) == str(ds_ident) or d["name"] == ds_ident:
                                return d["name"]
                    except Exception:
                        pass
                    return str(ds_ident)
                # 断点续跑：优先加载既有迁移任务；无则按已选数据源查找进行中的任务
                migrate_row = None
                if task_state.get("migrate_task_id"):
                    try:
                        migrate_row = migrate_state.get(int(task_state["migrate_task_id"]))
                    except Exception:
                        migrate_row = None
                if migrate_row is None and merged_params.get("source_ds_id"):
                    try:
                        migrate_row = migrate_state.get_by_source_ds(
                            str(merged_params["source_ds_id"]))
                        # 多会话共享：一个迁移任务可被多个会话共同推进（任务级状态），
                        # 不复用他人任务 / 已完成任务；接入后记录最近活跃会话。
                        if migrate_row:
                            migrate_state.bind_conv(migrate_row.id, _conv_ref)
                    except Exception:
                        migrate_row = None
                # 多会话共享兜底：新会话说「继续推进迁移」但未指明数据源 → 接入最近活跃任务
                if migrate_row is None and is_migration_flow \
                        and not merged_params.get("source_ds_id"):
                    try:
                        migrate_row = migrate_state.get_recent_active()
                        if migrate_row:
                            migrate_state.bind_conv(migrate_row.id, _conv_ref)
                    except Exception:
                        migrate_row = None
                # 首次发起迁移（命中 迁移/国产化 意图且无进行中任务）：无论是否已提供数据源都创建迁移任务。
                # 未提供数据源时建 INIT 空任务，进入「选择数据源」阶段由指挥官下发选源表单；提供则直接带源创建。
                if migrate_row is None and is_migration_flow:
                    migrate_row = migrate_state.create(
                        conv_id=_conv_ref, space_id=conv_space_id,
                        source_ds_id=str(merged_params.get("source_ds_id") or ""),
                        source_ds_name=(_resolve_ds_name(str(merged_params["source_ds_id"]))
                                        if merged_params.get("source_ds_id") else ""))
                    task_state["migrate_task_id"] = migrate_row.id
                # ---- 执行锁（多会话互斥）：本轮有实质状态变更意图时抢锁 ----
                # 纯只读问答（无参数/确认词）不抢锁，任何会话随时可查看资产/报告/问答。
                # 锁被其他会话持有 → 不推进状态机，注入只读提示，仅允许本轮问答。
                _migrate_lock_tid = None
                if migrate_row is not None and mpr:
                    _lk = migrate_state.try_acquire_lock(
                        migrate_row.id, str(conv_id), owner_user_id=f"会话{conv_id}")
                    if _lk["ok"]:
                        _migrate_lock_tid = migrate_row.id
                    else:
                        task_state["last_warning"] = _lk["message"]
                        migrate_row = None  # 阻止状态机推进/扫描/编排（只读模式）
                if migrate_row is not None:
                    # 逐级确认开关（DB 配置化，从任务读取）：注入 task_state 供 graph 编排决策
                    task_state["step_confirm"] = bool(getattr(migrate_row, "step_confirm", True))
                    # 数据源防重复硬拦截：一旦选定，后续轮次传入不同 source_ds_id 一律忽略
                    if migrate_row.source_ds_id and merged_params.get("source_ds_id") \
                            and str(merged_params["source_ds_id"]) != str(migrate_row.source_ds_id):
                        merged_params.pop("source_ds_id", None)
                        merged_params.pop("source_db", None)
                        task_state["last_warning"] = (
                            f"数据源已选定为「{migrate_row.source_ds_name or migrate_row.source_ds_id}」，"
                            "后端已记录，无需重复选择数据源")
                    # 源/目标库类型冲突拦截：源 == 目标（国产化语义不合法）
                    _st = normalize_db_type(str(merged_params.get("source_db_type") or ""))
                    _tt = normalize_db_type(str(merged_params.get("target_db_type") or ""))
                    if _st and _tt and _st == _tt:
                        merged_params.pop("target_db_type", None)
                        task_state["last_warning"] = (
                            f"目标数据库类型与源数据库类型相同（{_st}），后端已拦截，请重新选择不同的目标国产数据库")
                    try:
                        _res_upd = migrate_state.update_params(migrate_row.id, merged_params)
                    except MigrateStateError as _e:
                        _res_upd = None
                        task_state["last_warning"] = str(_e)
                    if _res_upd:
                        _mt = _res_upd["task"]
                        task_state["current_step"] = _mt["status"]
                        if _res_upd["advanced"]:
                            migrate_evt = {"task_id": migrate_row.id, "from": _res_upd["from"],
                                           "to": _res_upd["to"], "label": status_label(_res_upd["to"])}
                        # 状态机硬拦截提示（如源/目标库类型冲突）透传指挥官，禁止继续该阶段
                        if _res_upd.get("warning"):
                            task_state["last_warning"] = _res_upd["warning"]
                        # 状态机权威回写已采集参数（供 graph 注入与前端展示）
                        _saved_params = {k: v for k, v in _mt.items()
                                         if k in ("source_ds_id", "source_ds_name", "source_db_type",
                                                  "target_db_type", "db_business_level", "db_capacity",
                                                  "stop_window", "object_count") and v}
                        task_state["task_params"] = {**(task_state.get("task_params") or {}),
                                                     **{k: v for k, v in _saved_params.items()}}
                        # 进入对象扫描阶段：自动扫描数据源对象 → 规则引擎打风险 → 资产落库
                        if (_mt["status"] == "OBJECT_SCANNING"
                                and int(_mt.get("object_count") or 0) == 0):
                            _scan_res = _scan_migrate_objects(
                                migrate_row.id,
                                _mt.get("source_ds_name") or task_state["task_params"].get("source_ds_name"),
                                _mt.get("source_db_type") or task_state["task_params"].get("source_db_type"))
                            if _scan_res["object_count"]:
                                try:
                                    _res2 = migrate_state.update_params(
                                        migrate_row.id, {"object_count": _scan_res["object_count"]})
                                    task_state["current_step"] = _res2["task"]["status"]
                                except Exception:
                                    pass
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
                        from db_loc_agent.db import DocumentRecord
                        with db.session() as s:
                            rec = s.get(DocumentRecord, int(rid)) \
                                if rid is not None and str(rid).isdigit() else None
                        if not rec or not rec.doc_path:
                            return None
                        return _read_text(rec.doc_path, 3000)
                    if rtype == "history":  # Message.content，截断 2000
                        from db_loc_agent.db import Message as _Msg
                        with db.session() as s:
                            rec = s.get(_Msg, int(rid)) if rid is not None and str(rid).isdigit() else None
                        if not rec or not rec.content:
                            return None
                        return rec.content[:2000]
                    if rtype == "artifact":  # ArtifactRecord.path 文本，截断 3000
                        from db_loc_agent.db import ArtifactRecord as _ArtRec
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
                from db_loc_agent.db import ArtifactRecord as _ArtRec
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
                                 task_state=task_state)
            assistant_parts: List[str] = []
            reply_started = False      # 是否已进入真正的回复正文
            pending_prefix = ""        # 最前可能为解析 JSON 前缀的文本缓冲区

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
                            ui_render = obj
                    else:  # TASK_STATE：取首个合法 dict 写库
                        if task_state_evt is None and isinstance(obj, dict):
                            task_state_evt = obj
                    continue
            try:
                # messages 模式提供 LLM token 级增量（打字机效果），updates 模式提供节点事件，
                # custom 模式提供 graph 内实时自定义事件（子 Agent 调度 + 子 Agent 输出）
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
                            yield event("text", _seg)
                            assistant_parts.append(_seg)
                        continue
                    # custom 模式：graph 内实时事件（子 Agent 调度系统事件 + 子 Agent 输出消息）
                    if mode == "custom":
                        ev = payload if isinstance(payload, dict) else {}
                        etype = ev.get("type")
                        aid = ev.get("agent_id") or ""
                        if etype == "system":
                            ev_body = {"message": ev.get("message", ""),
                                       "event": ev.get("event", "calling_agent")}
                            yield event("system", ev_body)
                            trace("system", ev_body, aid)
                        elif etype == "sub_agent":
                            ev_body = {k: ev.get(k) for k in
                                       ("agent_id", "agent_name", "dispatcher_id",
                                        "dispatcher_name", "reply", "error")}
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
                    # updates 模式：parse/route/skill/artifact/error 节点事件
                    for node, update in payload.items():
                        if node == "parse":
                            pr = update.get("parse_result", {})
                            yield event("parse", pr)
                            trace("parse", pr)
                        elif node == "route":
                            yield event("route", {"agent_id": update.get("agent_id"),
                                                  "reason": update.get("route_reason")})
                            trace("route", update.get("route_reason", ""), update.get("agent_id", ""))
                        elif node == "execute":
                            # 若本轮发起了工具调用（技能/检索），record 为 skill 步骤
                            # 正文文本已由 messages 流逐 token 下发，此处不再重复发送
                            skill_calls = update.get("skill_calls") or []
                            for sc in skill_calls:
                                yield event("skill", sc)
                                trace("skill", sc, update.get("agent_id", ""))
                        elif node == "artifact":
                            if update.get("namespace"):
                                yield event("artifact", {"namespace": update["namespace"],
                                                         "files": update.get("artifacts", [])})
                                trace("artifact", {"namespace": update["namespace"]},
                                      update.get("agent_id", ""))
                        elif node == "reply" and update.get("error"):
                            _update_task_status("failed")
                            yield event("error", update["error"])
                            trace("error", update["error"])
                # 流结束后若仍有未判定内容（非解析 JSON 的文本）则正常下发
                if pending_prefix:
                    yield event("text", pending_prefix)
                    assistant_parts.append(pending_prefix)
                # 处理缓冲中的残余文本（可能是不完整的 UI_RENDER 标签或尾部文本），
                # 残余标签丢弃，残余纯文本照常下发
                for _seg in _ui_emit(""):
                    if not _seg:
                        continue
                    yield event("text", _seg)
                    assistant_parts.append(_seg)
                _update_task_status("done")
                if ui_render is not None:
                    yield event("ui_render", _resolve_ui_placeholders(ui_render, db_tools))
                if migrate_evt is not None:
                    yield event("migrate", migrate_evt)
                yield event("done", None)
            except Exception as e:  # 覆盖 LLM 未启动等运行错误
                _update_task_status("failed")
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
                                  agent_id=agent_id or None))
                    s.commit()

            # 会话任务状态落库：以状态机（后端确定性逻辑）为准；LLM 的 <TASK_STATE> 声明
            # 仅作参数提示，其 current_step 一律忽略（状态跳转由后端控制，LLM 无权决定）。
            if is_migration_flow or task_state_evt:
                if isinstance(task_state_evt, dict) and not is_migration_flow:
                    _evt_params = task_state_evt.get("task_params")
                    if isinstance(_evt_params, dict):
                        _ts_p = task_state.setdefault("task_params", {})
                        for _k, _v in _evt_params.items():
                            if _k in ("source_ds_id", "source_ds_name", "source_db_type",
                                      "target_db_type", "db_business_level", "db_capacity",
                                      "stop_window") and not _ts_p.get(_k):
                                _ts_p[_k] = _v
                with db.session() as s:
                    _c = s.get(Conversation, conv_id)
                    if _c is not None:
                        _c.task_state = json.dumps(task_state, ensure_ascii=False)
                        s.commit()

            # 本轮结束：释放执行锁（若本会话持有）——阶段推进完成即释放，便于他人接管
            if is_migration_flow and _migrate_lock_tid is not None:
                try:
                    migrate_state.release_lock(_migrate_lock_tid, str(conv_id))
                except Exception:
                    pass

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})

    # ---------- 数据库迁移：状态机 / 规则引擎 / 结构化资产 ----------
    @app.get("/api/migrate/tasks")
    def migrate_tasks(space_id: Optional[int] = None, status: Optional[str] = None,
                      limit: int = 100):
        return {"success": True, "data": migrate_state.list(space_id, status, limit)}

    @app.post("/api/migrate/tasks")
    def migrate_task_create(payload: Dict):
        row = migrate_state.create(
            conv_id=payload.get("conv_id"), space_id=payload.get("space_id"),
            sub_system_id=payload.get("sub_system_id"),
            source_ds_id=str(payload.get("source_ds_id") or ""),
            source_ds_name=str(payload.get("source_ds_name") or ""),
            task_name=str(payload.get("task_name") or "数据库迁移评估"))
        return {"success": True, "data": migrate_state.to_dict(row)}

    @app.get("/api/migrate/tasks/{tid}")
    def migrate_task_get(tid: int):
        row = migrate_state.get(tid)
        if row is None:
            raise HTTPException(404, f"迁移任务不存在: {tid}")
        data = migrate_state.to_dict(row)
        data["assets"] = migrate_assets.list(tid)
        data["assets_stats"] = migrate_assets.stats(tid)
        return {"success": True, "data": data}

    @app.delete("/api/migrate/tasks/{tid}")
    def migrate_task_delete(tid: int):
        migrate_state.delete(tid)
        return {"success": True}

    @app.post("/api/migrate/tasks/{tid}/reset")
    def migrate_task_reset(tid: int, payload: Dict = None):
        """重置整个任务：状态回到 INIT，清空已采集参数与已生成资产（二次确认在页面侧）。
        执行锁：重置需抢占锁，任务正在被其他会话执行时拒绝重置。"""
        payload = payload or {}
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            _lk = migrate_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise MigrateStateError(_lk["message"])
            res = migrate_state.reset(tid)
            try:
                migrate_assets.delete_by_task(tid)
            except Exception:
                pass
        except MigrateStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}

    @app.post("/api/migrate/tasks/{tid}/resume")
    def migrate_task_resume(tid: int, payload: Dict = None):
        """断点续跑：仅 ERROR 状态可调用，清错误并恢复到可继续推进的阶段，不从头重跑。
        ERROR 状态锁已自动释放，任意会话可抢占接管（重新获取执行锁）。"""
        payload = payload or {}
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            _lk = migrate_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise MigrateStateError(_lk["message"])
            res = migrate_state.resume(tid)
        except MigrateStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}

    @app.post("/api/migrate/tasks/{tid}/advance")
    def migrate_task_advance(tid: int, payload: Dict = None):
        """确定性推进状态机（后端硬编码流转，LLM 无权跳转）：
        传入已采集参数（source_ds_id/db_capacity/task_confirm 等），状态机校验后合法流转。
        执行锁：状态变更动作需先抢占锁，被其他会话占用时拒绝（只读）。"""
        payload = payload or {}
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            _lk = migrate_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise MigrateStateError(_lk["message"])
            res = migrate_state.update_params(tid, payload)
        except MigrateStateError as e:
            raise HTTPException(400, str(e))
        # 状态推进完成后释放锁（阶段完成即释放，便于下一会话接管）
        try:
            migrate_state.release_lock(tid, sid)
        except Exception:
            pass
        return {"success": True, "data": res}

    @app.post("/api/migrate/tasks/{tid}/step-confirm")
    def migrate_task_step_confirm(tid: int, payload: Dict = None):
        """切换逐级确认开关（DB 配置化，从任务读取）：
        step_confirm=True 时每个执行阶段完成后停驻等待用户确认，False 时一次性编排跑完。"""
        payload = payload or {}
        try:
            res = migrate_state.set_step_confirm(tid, bool(payload.get("step_confirm", True)))
        except MigrateStateError as e:
            raise HTTPException(400, str(e))
        return {"success": True, "data": res}

    @app.post("/api/migrate/tasks/{tid}/scan")
    def migrate_task_scan(tid: int, payload: Dict = None):
        """扫描数据源对象 → 规则引擎打风险 → 结构化资产落库
        执行锁：扫描属状态变更动作，需先抢占锁；被占用时拒绝。"""
        payload = payload or {}
        task = migrate_state.get(tid)
        if task is None:
            raise HTTPException(404, "迁移任务不存在")
        sid = str(payload.get("session_id") or "panel")
        owner = str(payload.get("owner") or "")
        try:
            _lk = migrate_state.try_acquire_lock(tid, sid, owner_user_id=owner)
            if not _lk["ok"]:
                raise MigrateStateError(_lk["message"])
            result = _scan_migrate_objects(
                tid, str(payload.get("source_ds_name") or task.source_ds_name or ""),
                str(payload.get("source_db_type") or task.source_db_type or ""))
            if result["object_count"]:
                try:
                    migrate_state.update_params(tid, {"object_count": result["object_count"]})
                except Exception:
                    pass
        except MigrateStateError as e:
            raise HTTPException(400, str(e))
        try:
            migrate_state.release_lock(tid, sid)
        except Exception:
            pass
        return {"success": True, "data": result if 'result' in locals() else {"object_count": 0}}

    @app.get("/api/migrate/tasks/{tid}/assets")
    def migrate_assets_list(tid: int):
        return {"success": True, "data": migrate_assets.list(tid),
                "stats": migrate_assets.stats(tid)}

    @app.post("/api/migrate/tasks/{tid}/assets")
    def migrate_assets_add(tid: int, payload: Dict = None):
        payload = payload or {}
        assets = payload.get("assets") or payload.get("findings") or []
        saved = [migrate_assets.upsert(tid, a) for a in assets
                 if isinstance(a, dict) and a.get("asset_name")]
        return {"success": True, "data": saved, "stats": migrate_assets.stats(tid)}

    @app.delete("/api/migrate/assets/{aid}")
    def migrate_asset_delete(aid: int):
        migrate_assets.delete(aid)
        return {"success": True}

    @app.get("/api/migrate/tasks/{tid}/assets/report")
    def migrate_assets_report(tid: int):
        task = migrate_state.get(tid)
        if task is None:
            raise HTTPException(404, "迁移任务不存在")
        markdown = migrate_assets.render_report(migrate_state.to_dict(task))
        return {"success": True, "data": {"task_id": tid,
                                          "title": task.task_name or "数据库迁移评估报告",
                                          "markdown": markdown}}

    @app.get("/api/migrate/tasks/{tid}/assets/export")
    def migrate_assets_export(tid: int):
        """导出 Excel 资产清单（供工程实施人员直接使用）"""
        try:
            blob = migrate_assets.export_excel(tid)
        except Exception as e:
            raise HTTPException(500, f"Excel 导出失败: {e}")
        from fastapi.responses import Response
        return Response(
            content=blob,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition":
                     f'attachment; filename="migrate_assets_{tid}.xlsx"'})

    @app.post("/api/migrate/scan")
    def migrate_rule_scan(payload: Dict):
        """规则引擎静态扫描单条 SQL/DDL → 结构化风险标签（高/中/低）"""
        payload = payload or {}
        sql = str(payload.get("sql") or "")
        if not sql.strip():
            raise HTTPException(400, "sql 不能为空")
        result = rule_engine.scan(sql, str(payload.get("object_name") or ""),
                                  str(payload.get("asset_type") or "table"))
        return {"success": True, "data": result}

    @app.get("/api/migrate/rules")
    def migrate_rules_list():
        return {"success": True, "data": rule_engine.rules()}

    @app.post("/api/migrate/rules")
    def migrate_rules_save(payload: Dict):
        """保存规则全集（覆盖 sys_dict 持久化，支持竞赛现场扩展规则）"""
        rules = payload.get("rules")
        if not isinstance(rules, list):
            raise HTTPException(400, "rules 必须为数组")
        try:
            rule_engine.save_rules(rules)
        except Exception as e:
            raise HTTPException(500, f"规则保存失败: {e}")
        return {"success": True, "data": rule_engine.rules()}

    # ---------- 任务流程静态表（页面可编排，状态机按此表驱动） ----------
    @app.get("/api/migrate/flow")
    def migrate_flow_get():
        """获取任务流程编排（按 sort_order 排序；空表返回默认流程）"""
        try:
            return {"success": True, "data": migrate_state.get_flow()}
        except MigrateStateError as e:
            raise HTTPException(400, str(e))

    @app.put("/api/migrate/flow")
    def migrate_flow_save(payload: Dict):
        """全量保存流程编排：按传入顺序重建节点（支持增删/排序/开关确认闸门/启停）"""
        nodes = payload.get("nodes")
        if not isinstance(nodes, list):
            raise HTTPException(400, "nodes 必须为数组")
        try:
            return {"success": True, "data": migrate_state.save_flow(nodes)}
        except MigrateStateError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/migrate/flow/reset")
    def migrate_flow_reset():
        """恢复默认流程（清空编排记录）"""
        try:
            return {"success": True, "data": migrate_state.reset_flow()}
        except MigrateStateError as e:
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
    from db_loc_agent.security import SecurityGateway
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
            from db_loc_agent.db import SecurityLog
            rows = list(s.scalars(select(SecurityLog)
                                  .order_by(SecurityLog.id.desc()).limit(min(limit, 500))))
            return {"success": True, "data": [{
                "id": r.id, "method": r.method, "path": r.path, "ip": r.ip,
                "status": r.status, "duration_ms": r.duration_ms, "notes": r.notes,
                "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows]}

    return app