"""数据源 SQL 库：每个数据源绑定一个 .sql 文件（data/sql_library/<数据源名>.sql）。

文件内用 `-- name: 名称` 注释分段，一段一条 SQL；无标记的文件整体算一条「未命名」。
不按分号切分（避免切断字符串/函数体内的分号）。前端选中数据源 → 列出该文件条目 →
点选执行；`{param}` 占位由前端替换后走现有只读查询通道。
"""
from __future__ import annotations

import re
from pathlib import Path

# 单文件上限：SQL 库文件远小于此；超限基本是误粘贴，保存时拒绝
MAX_FILE_BYTES = 256 * 1024

# `-- name: 名称`（兼容全角冒号）；整行匹配，行内其余内容为条目名
_NAME_MARK = re.compile(r"^--\s*name\s*[:：]\s*(.+?)\s*$", re.MULTILINE)
# 参数占位符 {param}：与前端替换共用同一形态
PARAM_PATTERN = re.compile(r"\{([A-Za-z_]\w*)\}")


def safe_name(datasource: str) -> str:
    """数据源名 → 安全文件名：仅保留 Unicode 字母数字/下划线/连字符，其余替换为 _。
    点号被替换，因此 `..` 等穿越序列天然不可能出现在结果中。"""
    name = (datasource or "").strip()
    cleaned = re.sub(r"[^\w-]+", "_", name).strip("_")
    if not cleaned:
        raise ValueError("数据源名称不能为空")
    return cleaned


def parse_statements(content: str) -> list[dict[str, str]]:
    """按 `-- name:` 标记拆分 SQL 文件为条目列表 [{name, sql}]。
    无标记 → 整文件一条「未命名」；首个标记前的非空内容单独算一条未命名；
    空段落（连续标记）丢弃。"""
    text = (content or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    marks = list(_NAME_MARK.finditer(text))
    if not marks:
        return [{"name": "未命名", "sql": text}]
    statements: list[dict[str, str]] = []
    preamble = text[:marks[0].start()].strip()
    if preamble:
        statements.append({"name": "未命名", "sql": preamble})
    for index, mark in enumerate(marks):
        start = mark.end()
        end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
        sql = text[start:end].strip()
        if sql:
            statements.append({"name": mark.group(1).strip(), "sql": sql})
    return statements


def file_path(base_dir: Path, datasource: str) -> Path:
    return base_dir / f"{safe_name(datasource)}.sql"


def list_library(base_dir: Path) -> list[dict]:
    """扫描目录下全部 .sql 文件 → [{datasource, statement_count, updated_at}]，按名称排序。
    目录不存在视为空库。"""
    if not base_dir.exists():
        return []
    items: list[dict] = []
    for path in sorted(base_dir.glob("*.sql"), key=lambda p: p.stem):
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue  # 不可读/非 UTF-8 的文件跳过，不阻塞整库列表
        items.append({
            "datasource": path.stem,
            "statement_count": len(parse_statements(content)),
            "updated_at": int(path.stat().st_mtime),
        })
    return items


def get_file(base_dir: Path, datasource: str) -> dict:
    """读取绑定文件：内容 + 解析条目。文件不存在时返回空内容与 exists=False（不报错，
    前端据「新建」态渲染）；非 UTF-8 文件（如手工放入的 GBK）按容错文本读取，
    避免端点直接 500 且无法通过 API 恢复。"""
    name = safe_name(datasource)
    path = base_dir / f"{name}.sql"
    if not path.exists():
        return {"datasource": name, "content": "", "entries": [], "exists": False}
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_bytes().decode("utf-8", "replace")
    return {"datasource": name, "content": content,
            "entries": parse_statements(content), "exists": True}


def save_file(base_dir: Path, datasource: str, content: str) -> dict:
    """保存绑定文件（tmp + rename 原子写），返回解析条目。"""
    raw = (content or "").encode("utf-8")
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError(f"SQL 文件超过上限 {MAX_FILE_BYTES // 1024}KB")
    name = safe_name(datasource)
    base_dir.mkdir(parents=True, exist_ok=True)
    path = base_dir / f"{name}.sql"
    tmp = base_dir / f"{name}.sql.tmp"
    tmp.write_bytes(raw)
    tmp.replace(path)
    return {"datasource": name, "entries": parse_statements(content)}


def rename_file(base_dir: Path, old_name: str, new_name: str) -> None:
    """数据源改名后同步移动绑定文件；旧文件不存在或目标已存在时静默跳过（不覆盖）。"""
    source = base_dir / f"{safe_name(old_name)}.sql"
    if not source.exists():
        return
    target = base_dir / f"{safe_name(new_name)}.sql"
    if target.exists():
        return
    source.rename(target)
