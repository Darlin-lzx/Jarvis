"""附件解析与产物写入：+ 上传 与 @ 引用 的文本抽取 / 落盘。

- SUPPORTED_EXT: 支持的附件扩展名（md/markdown/sql/ddl/txt/pdf/docx/xlsx/xls，ddl 按 sql 解析、
  markdown 按 md 解析、xls 旧版二进制格式给出友好报错并提示另存为 xlsx）
- extract_text(name, raw): 按扩展名解析文本（大小上限 10MB 由调用方保证），
  解析失败抛 ValueError（含友好中文错误）
- create_attachment(...): 把解析文本写入产物（复用 ArtifactRecord），供 app.py 上传接口使用
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Dict, Optional

from jarvis_agent.artifacts import ArtifactService, make_namespace, safe_object_name
from jarvis_agent.rag import extract_pdf_text

SUPPORTED_EXT = {"md", "markdown", "sql", "ddl", "txt", "pdf", "docx", "xlsx", "xls"}

# 纯文本解码类扩展（ddl 按 sql 语义、markdown 按 md 语义做文本抽取）
_TEXT_EXT = {"md", "markdown", "sql", "ddl", "txt"}

# xlsx 解析上限：最多 200 行 / 5000 单元格
_XLSX_MAX_ROWS = 200
_XLSX_MAX_CELLS = 5000

_SUPPORTED_HINT = "支持 " + "/".join(sorted(SUPPORTED_EXT))


def _decode_text(raw: bytes) -> str:
    """utf-8 优先解码，失败回退 gbk / latin-1"""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def extract_text(name: str, raw: bytes) -> str:
    """按扩展名解析附件文本；解析失败抛 ValueError（含友好中文错误）。

    调用方负责保证大小上限（10MB）。
    """
    ext = Path(name or "").suffix.lstrip(".").lower()
    if ext not in SUPPORTED_EXT:
        raise ValueError(f"不支持的附件类型: {ext or '(无扩展名)'}（{_SUPPORTED_HINT}）")
    if ext == "xls":
        # 务实处理：xls 为 Excel 97-2003 旧版二进制格式，openpyxl 无法直接解析，
        # 给出友好中文提示（不引 pandas 等重量级依赖）
        raise ValueError("暂不支持解析 .xls（旧版 Excel 二进制格式），请用 WPS/Excel 另存为 .xlsx 后再上传")
    if ext in _TEXT_EXT:
        text = _decode_text(raw)
        if not text.strip():
            raise ValueError("附件内容为空，未提取到文本")
        return text
    if ext == "pdf":
        try:
            text = extract_pdf_text(raw)
        except Exception as e:
            raise ValueError(f"PDF 解析失败（文件可能损坏或加密）: {e}") from e
        if not text.strip():
            raise ValueError("未能从 PDF 中提取到文本（可能是扫描件/图片型 PDF）")
        return text
    if ext == "docx":
        return _extract_docx(raw)
    if ext == "xlsx":
        return _extract_xlsx(raw)
    raise ValueError(f"不支持的附件类型: {ext}（{_SUPPORTED_HINT}）")


def _extract_docx(raw: bytes) -> str:
    """docx：取所有段落 + 表格单元格文本，空行分隔"""
    try:
        from docx import Document
    except ImportError as e:
        raise ValueError("解析 docx 需要安装 python-docx，请先执行 pip install \"python-docx>=1.1\"") from e
    try:
        doc = Document(BytesIO(raw))
        parts: list = []
        for p in doc.paragraphs:
            t = (p.text or "").strip()
            if t:
                parts.append(t)
        for table in doc.tables:
            for row in table.rows:
                cells = [(c.text or "").strip() for c in row.cells]
                parts.append(" | ".join(x for x in cells if x))
        text = "\n".join(parts)
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"docx 解析失败: {e}") from e
    if not text.strip():
        raise ValueError("docx 中未提取到文本内容（文档可能为空）")
    return text


def _extract_xlsx(raw: bytes) -> str:
    """xlsx：openpyxl 只读模式取第一个 sheet，最多 200 行 / 5000 单元格，按行 tab 连接"""
    try:
        from openpyxl import load_workbook
    except ImportError as e:
        raise ValueError("解析 xlsx 需要安装 openpyxl，请先执行 pip install \"openpyxl>=3.1\"") from e
    try:
        wb = load_workbook(BytesIO(raw), read_only=True, data_only=True)
        ws = wb.worksheets[0] if wb.worksheets else None
        if ws is None:
            raise ValueError("xlsx 中没有工作表，未提取到文本")
        lines: list = []
        cell_count = 0
        try:
            for row in ws.iter_rows(values_only=True):
                if len(lines) >= _XLSX_MAX_ROWS:
                    break
                vals = ["" if v is None else str(v) for v in row]
                if not any(x.strip() for x in vals):
                    continue
                lines.append("\t".join(vals))
                cell_count += len(vals)
                if cell_count > _XLSX_MAX_CELLS:
                    break
        finally:
            wb.close()
        text = "\n".join(x for x in lines if x.strip())
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"xlsx 解析失败: {e}") from e
    if not text.strip():
        raise ValueError("xlsx 中未提取到文本内容（工作表可能为空）")
    return text


def create_attachment(artifacts: ArtifactService, conv_id: Optional[int], name: str,
                      text: str, space_id=None, sub_system_id=None,
                      agent_id: str = "attachment") -> Dict:
    """把解析后的附件文本写入产物（ArtifactRecord）。

    - object_name = safe_object_name(文件名去后缀)
    - files      = {f"{safe_object_name(stem)}.txt": text}
    - namespace  = make_namespace(f"conv{conv_id or 0}", "attachment", object_name)

    返回 ArtifactService.write 的产物记录 dict（含 id/type/path 等，供响应组装）。
    注：产物归属（space/sub_system/task）由 ArtifactService.write 按 conv 反查会话获得，
    space_id/sub_system_id 参数保留以兼容未来直接归属的场景。
    """
    stem = safe_object_name(Path(name or "").stem)
    object_name = stem or "attachment"
    namespace = make_namespace(f"conv{conv_id or 0}", agent_id, object_name)
    res = artifacts.write(namespace, conv_id, agent_id, object_name,
                          files={f"{object_name}.txt": text})
    records = res.get("files") or []
    rec = records[0] if records else {"namespace": namespace, "object_name": object_name}
    rec.setdefault("attachment_id", rec.get("id"))
    return rec