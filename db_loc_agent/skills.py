"""技能管理：skills/<id>/SKILL.md 文件 + SQLite 索引 + 可选 scripts/ 脚本执行（沙箱化）"""
from __future__ import annotations

import ast
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from db_loc_agent.db import Database, Skill

SKILL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
FIELD_RE = re.compile(r"^(name|description|script|chain)[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*$", re.MULTILINE)
SCRIPT_MAX_OUTPUT = 20000       # 脚本输出截断上限（字符）
DEFAULT_TIMEOUT = 30            # 脚本执行超时（秒）
SCRIPT_MEM_LIMIT = 512 * 1024 * 1024  # 子进程内存上限 512MB
SCRIPT_BLOCKED_MODULES = {"socket", "http", "urllib", "requests", "subprocess",
                          "os.system", "shutil"}  # 预编译时禁止的危险 import/调用

# 沙箱环境：仅保留最小变量，防止泄露宿主 API Key 等敏感信息
SANDBOX_ENV_KEEP = {"PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ"}
SANDBOX_ENV_DENY_PREFIX = ("API_", "KEY", "SECRET", "TOKEN", "PASSWORD", "PRIVATE")


def _limit_rss_if_possible(limit_bytes: int):
    """返回 preexec 回调：尽力限制子进程 RSS（macOS 用 RLIMIT_AS，Linux 用 RLIMIT_RSS）。"""
    def _limiter():
        try:
            resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))
            resource.setrlimit(resource.RLIMIT_RSS, (limit_bytes, limit_bytes))
        except (ValueError, OSError):
            pass  # 平台不支持时忽略（仍有超时兜底）
    return _limiter


class SkillService:
    def __init__(self, db: Database, skill_dir: str):
        self.db = db
        self.skill_dir = Path(skill_dir)
        self.skill_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _parse_md(text: str):
        """解析 SKILL.md 文本：返回 (name, description, body, script_name, chain)"""
        name, description, body, script, chain = "skill", "", text, None, []
        m = FRONTMATTER_RE.match(text)
        if m:
            body = text[m.end():].lstrip("\n")
            for key, value in FIELD_RE.findall(m.group(1)):
                if key == "name":
                    name = value.strip().strip("\"'")
                elif key == "description":
                    description = value.strip().strip("\"'")
                elif key == "script":
                    script = value.strip().strip("\"'") or None
                elif key == "chain":
                    raw = value.strip().strip("\"'").strip("[]")
                    chain = [x.strip() for x in re.split(r"[,\s]+", raw) if x.strip()]
        return name, description, body.strip(), script, chain

    def _file(self, skill_id: str) -> Path:
        if not SKILL_ID_RE.match(skill_id or ""):
            raise ValueError(f"非法技能 ID: {skill_id!r}")
        p = (self.skill_dir / skill_id).resolve()
        if not str(p).startswith(str(self.skill_dir.resolve())):
            raise ValueError("技能路径越界")
        return p / "SKILL.md"

    def _scripts_dir(self, skill_id: str) -> Path:
        f = self._file(skill_id)
        d = f.parent / "scripts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _sync_from_file(self, session, skill_id: str) -> Optional[Dict]:
        f = self._file(skill_id)
        if not f.exists():
            return None
        text = f.read_text(encoding="utf-8")
        name, description, body, _script, chain = self._parse_md(text)
        row = session.scalars(select(Skill).where(Skill.skill_id == skill_id)).first()
        if row is None:
            row = Skill(skill_id=skill_id, name=name, description=description, content=body)
            session.add(row)
        else:
            row.name, row.description, row.content = name, description, body
        session.commit()
        session.refresh(row)
        return self._to_dict(row, script=_script, chain=chain)

    def list(self) -> List[Dict]:
        with self.db.session() as s:
            for d in sorted(p for p in self.skill_dir.iterdir() if p.is_dir()):
                self._sync_from_file(s, d.name)
            rows = list(s.scalars(select(Skill).order_by(Skill.id)))
            return [self._to_dict(r, script=self._script_name(r.skill_id),
                                  chain=self._chain_name(r.skill_id)) for r in rows]

    def get(self, skill_id: str) -> Optional[Dict]:
        with self.db.session() as s:
            return self._sync_from_file(s, skill_id)

    def create(self, name: str, description: str, content: str,
               script: Optional[str] = None, chain: Optional[List[str]] = None) -> Dict:
        front = f"name: {name}\ndescription: {description}"
        if script:
            front += f"\nscript: {script}"
        if chain:
            front += f"\nchain: {', '.join(chain)}"
        md = f"---\n{front}\n---\n\n{content}\n"
        return self.create_from_md(md)

    def create_from_md(self, text: str) -> Dict:
        """直接以 SKILL.md 文本创建技能（frontmatter 支持 name/description/script/chain）"""
        name, description, body, script, chain = self._parse_md(text)
        slug = re.sub(r"[^A-Za-z0-9]+", "-", (name or "").strip().lower()).strip("-")[:64]
        if not slug:
            slug = f"skill-{uuid.uuid4().hex[:8]}"
        d = self.skill_dir / slug
        if (d / "SKILL.md").exists():
            raise ValueError(f"技能 ID '{slug}' 已存在（名称生成的 ID 冲突），请换一个名称")
        d.mkdir(parents=True, exist_ok=True)
        front = f"name: {name}\ndescription: {description}"
        if script:
            front += f"\nscript: {script}"
        if chain:
            front += f"\nchain: {', '.join(chain)}"
        (d / "SKILL.md").write_text(f"---\n{front}\n---\n\n{body}\n", encoding="utf-8")
        self._scripts_dir(slug)  # 脚本目录
        if script:  # 处理内嵌脚本（## 代码块）
            self._write_inline_script(slug, body, script)
        with self.db.session() as s:
            return self._sync_from_file(s, slug)

    def _write_inline_script(self, skill_id: str, body: str, script: str):
        """若 frontmatter 声明 script，且 SKILL.md 正文含对应语言的代码块，则把代码块落盘为脚本文件；
        不匹配时保留（用户可后续通过 API 上传脚本文件）。"""
        fname = Path(script).name
        if fname != script or not fname:  # 不接受带路径的脚本名
            return
        block_re = re.compile(
            r"```(?:python|python3|bash|sh)\s*\n(.*?)```", re.S)
        blocks = block_re.findall(body)
        for code in blocks:
            if script.endswith(".py"):
                self._scripts_dir(skill_id).joinpath(fname).write_text(code.lstrip("\n"), encoding="utf-8")
                return
            if script.endswith((".sh", ".bash")):
                self._scripts_dir(skill_id).joinpath(fname).write_text(
                    code.lstrip("\n"), encoding="utf-8")
                (self._scripts_dir(skill_id) / fname).chmod(0o755)
                return

    def run_script(self, skill_id: str, script_name: Optional[str] = None,
                   args: str = "", timeout: int = DEFAULT_TIMEOUT,
                   env_extra: Optional[Dict[str, str]] = None) -> Dict:
        """沙箱化执行技能脚本，返回 {ok, stdout, stderr, returncode, timed_out}。
        安全措施：仅允许运行 scripts/<脚本名>；Python 脚本做 AST 预编译（禁用危险 import/调用）；
        子进程限制内存与超时；环境变量最小化（去掉宿主敏感变量）。
        env_extra 仅允许注入以 CHAIN_ 前缀命名的键（供技能链传递上下文）。"""
        if not SKILL_ID_RE.match(skill_id or ""):
            raise ValueError(f"非法技能 ID: {skill_id!r}")
        if script_name:
            fname = Path(script_name).name
            if fname != script_name:
                raise ValueError("脚本名不得包含路径")
        else:
            info = self.get(skill_id)
            fname = (info or {}).get("script")
            if not fname:
                raise ValueError(f"技能 '{skill_id}' 未声明 script")
        script_path = (self._scripts_dir(skill_id) / fname).resolve()
        base = self._scripts_dir(skill_id).resolve()
        if not str(script_path).startswith(str(base)) or not script_path.exists():
            raise ValueError(f"脚本不存在: {fname}")
        # Python 脚本预编译校验（只准导入安全模块）
        if script_path.suffix == ".py":
            self._verify_python_script(script_path)
        cmd: List[str]
        if script_path.suffix == ".py":
            cmd = [sys.executable, str(script_path)]
        elif script_path.suffix in (".sh", ".bash"):
            cmd = ["bash", str(script_path)]
        else:
            cmd = [script_path] if os.access(script_path, os.X_OK) else [sys.executable, str(script_path)]
        cmd += re.split(r"\s+", args.strip()) if args.strip() else []
        # 沙箱环境：最小化变量，剔除宿主敏感信息
        env = {k: v for k, v in os.environ.items()
               if k in SANDBOX_ENV_KEEP and not any(v and v.lower().startswith(p.lower())
                                                   for p in SANDBOX_ENV_DENY_PREFIX)}
        # 链上下文白名单注入（仅 CHAIN_ 前缀，供技能链传递上下游数据）
        if env_extra:
            for k, v in env_extra.items():
                if k.startswith("CHAIN_"):
                    env[k] = str(v)
        try:
            proc = subprocess.run(cmd, cwd=script_path.parent, capture_output=True,
                                  text=True, timeout=timeout, env=env,
                                  preexec_fn=_limit_rss_if_possible(SCRIPT_MEM_LIMIT),
                                  start_new_session=True)
            out = proc.stdout or ""
            err = proc.stderr or ""
            if len(out) > SCRIPT_MAX_OUTPUT:
                out = out[:SCRIPT_MAX_OUTPUT] + "\n…(输出已截断)"
            if len(err) > SCRIPT_MAX_OUTPUT:
                err = err[:SCRIPT_MAX_OUTPUT] + "\n…(输出已截断)"
            return {"ok": proc.returncode == 0, "stdout": out, "stderr": err,
                    "returncode": proc.returncode, "timed_out": False}
        except subprocess.TimeoutExpired as e:
            return {"ok": False, "stdout": (e.stdout or "")[:SCRIPT_MAX_OUTPUT],
                    "stderr": f"脚本执行超时（>{timeout}s）", "returncode": -1, "timed_out": True}

    @staticmethod
    def _verify_python_script(path: Path) -> None:
        """AST 预编译校验：语法正确 + 不 import 危险模块 + 不调用 os.system 等"""
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as e:
            raise ValueError(f"脚本语法错误: {e}") from e
        risky = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.split(".")[0].lower() in SCRIPT_BLOCKED_MODULES:
                        risky.append(f"import {a.name}")
            elif isinstance(node, ast.ImportFrom) and node.module:
                if node.module.split(".")[0].lower() in SCRIPT_BLOCKED_MODULES:
                    risky.append(f"from {node.module} import ...")
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) \
                    and node.value.id in ("os", "subprocess") and node.attr in ("system", "popen", "run", "call"):
                risky.append(f"{node.value.id}.{node.attr}")
        if risky:
            raise ValueError(f"脚本包含被禁用的不安全调用: {'; '.join(dict.fromkeys(risky))[:300]}")

    def _script_name(self, skill_id: str) -> Optional[str]:
        f = self._file(skill_id)
        if not f.exists():
            return None
        m = FRONTMATTER_RE.match(f.read_text(encoding="utf-8") or "")
        if not m:
            return None
        fm = re.search(r"^script[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*$", m.group(1), re.MULTILINE)
        return fm.group(1).strip().strip("\"'") if fm else None

    def _chain_name(self, skill_id: str) -> List[str]:
        f = self._file(skill_id)
        if not f.exists():
            return []
        m = FRONTMATTER_RE.match(f.read_text(encoding="utf-8") or "")
        if not m:
            return []
        fm = re.search(r"^chain[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*$", m.group(1), re.MULTILINE)
        if not fm:
            return []
        raw = fm.group(1).strip().strip("\"'").strip("[]")
        return [x.strip() for x in re.split(r"[,\s]+", raw) if x.strip()]

    def run_chain(self, skill_id: str, args: str = "", timeout: int = DEFAULT_TIMEOUT) -> Dict:
        """顺序执行技能链：依次运行 chain 中声明的子技能脚本，把各步骤结果累积到
        .chain.json 上下文文件，子脚本可通过环境变量 CHAIN_CTX_FILE 读取上游结果。
        无 chain 声明时退化为单脚本执行。任一步失败即中断返回。"""
        info = self.get(skill_id)
        chain = (info or {}).get("chain") or []
        if not chain:
            if info and info.get("script"):
                return self.run_script(skill_id, args=args, timeout=timeout)
            return {"ok": False, "error": f"技能 {skill_id} 未声明 chain 或 script"}
        steps: List[Dict] = []
        ctx_file = self._file(skill_id).parent / f".chain-{skill_id}.json"
        ctx = {"root": skill_id, "args": args, "steps": steps}
        failed = False
        for sub in chain:
            if not SKILL_ID_RE.match(sub or ""):
                steps.append({"skill": sub, "ok": False, "error": f"非法技能 ID: {sub!r}"})
                failed = True
                break
            sub_info = self.get(sub)
            if not sub_info:
                steps.append({"skill": sub, "ok": False, "error": f"子技能 {sub} 不存在"})
                failed = True
                break
            step: Dict[str, Any] = {"skill": sub}
            if sub_info.get("script"):
                # 先写入含历史步骤的上下文，再执行子脚本
                try:
                    ctx_file.write_text(json.dumps(ctx, ensure_ascii=False), encoding="utf-8")
                except OSError:
                    pass
                srun = self.run_script(sub, args=args, timeout=timeout,
                                       env_extra={"CHAIN_CTX_FILE": str(ctx_file)})
                step.update({"ok": bool(srun.get("ok")), "stdout": srun.get("stdout", ""),
                             "stderr": srun.get("stderr", ""),
                             "timed_out": bool(srun.get("timed_out"))})
                if srun.get("stderr"):
                    step["stderr"] = srun["stderr"][:2000]
                if not srun.get("ok"):
                    steps.append(step)
                    return {"ok": False, "error": f"子技能 {sub} 执行失败（{srun.get('stderr', '')[:200]}）",
                            "steps": steps}
            else:
                # 无脚本的子技能：正文说明作为上游上下文的一部分
                step.update({"ok": True, "content": (sub_info.get("content") or "")[:4000]})
            steps.append(step)
        if failed:
            return {"ok": False, "error": steps[-1].get("error", "技能链执行失败"), "steps": steps}
        outs = []
        for st in steps:
            if st.get("stdout"):
                outs.append(f"### {st['skill']}\n{st['stdout']}")
            elif st.get("content"):
                outs.append(f"### {st['skill']}（说明）\n{st['content']}")
        return {"ok": True, "stdout": "\n\n".join(outs), "steps": steps,
                "chain": chain, "timed_out": False}

    def update(self, skill_id: str, name: str, description: str = "", content: str = "") -> Dict:
        if not self._file(skill_id).exists():
            raise KeyError(f"技能不存在: {skill_id}")
        # 保留原有 script / chain 声明，仅更新 name/description/body
        _name, _desc, _body, script, chain = self._parse_md(
            self._file(skill_id).read_text(encoding="utf-8"))
        front = f"name: {name}\ndescription: {description}"
        if script:
            front += f"\nscript: {script}"
        if chain:
            front += f"\nchain: {', '.join(chain)}"
        self._file(skill_id).write_text(
            f"---\n{front}\n---\n\n{content}\n", encoding="utf-8")
        with self.db.session() as s:
            return self._sync_from_file(s, skill_id)

    def update_md_script(self, skill_id: str, script: str) -> None:
        """更新 SKILL.md frontmatter 的 script 字段（保留 name/description/body/chain）"""
        f = self._file(skill_id)
        if not f.exists():
            raise KeyError(f"技能不存在: {skill_id}")
        text = f.read_text(encoding="utf-8")
        name, description, body, _old, chain = self._parse_md(text)
        front = f"name: {name}\ndescription: {description}"
        if script:
            front += f"\nscript: {script}"
        if chain:
            front += f"\nchain: {', '.join(chain)}"
        f.write_text(f"---\n{front}\n---\n\n{body}\n", encoding="utf-8")

    def set_enabled(self, skill_id: str, enabled: bool) -> Dict:
        with self.db.session() as s:
            row = s.scalars(select(Skill).where(Skill.skill_id == skill_id)).first()
            if row is None:
                self._sync_from_file(s, skill_id)
                row = s.scalars(select(Skill).where(Skill.skill_id == skill_id)).first()
            if row is None:
                raise KeyError(f"技能不存在: {skill_id}")
            row.enabled = bool(enabled)
            s.commit()
            return self._to_dict(row)

    def delete(self, skill_id: str) -> None:
        with self.db.session() as s:
            row = s.scalars(select(Skill).where(Skill.skill_id == skill_id)).first()
            if row:
                s.delete(row)
                s.commit()
        shutil.rmtree(self.skill_dir / skill_id, ignore_errors=True)

    @staticmethod
    def _to_dict(r: Skill, script: Optional[str] = None,
                 chain: Optional[List[str]] = None) -> Dict:
        return {"id": r.id, "skill_id": r.skill_id, "name": r.name,
                "description": r.description, "content": r.content, "enabled": r.enabled,
                "script": script,
                "chain": chain or []}