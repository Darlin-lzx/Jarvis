"""Parsing for workflow template XML stored in vm_template_version."""
from __future__ import annotations

import re
import json
from typing import Any
from datetime import datetime
import xml.etree.ElementTree as ET

from sqlalchemy import Connection, text


CONTENT_COLUMNS = ("content", *(f"content{i}" for i in range(1, 16)))
_XML_DECLARATION = re.compile(r"^\s*<\?xml[^>]*\?>")
_XML_START = re.compile(r"<\?xml\b", re.I)


def normalize_template_content(*chunks: str | None) -> str:
    """Concatenate chunks and remove SQL-export artifacts around embedded XML."""
    combined = "".join(chunk or "" for chunk in chunks).replace("','", "")
    start = _XML_START.search(combined)
    end = combined.rfind("</workflow>")
    if start is not None and end != -1:
        return combined[start.start():end + len("</workflow>")]
    return combined.strip()


def _text(element: ET.Element | None) -> str:
    return (element.text or "").strip() if element is not None else ""


def _boolean(value: str) -> bool | None:
    lowered = value.strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    return None


def _default_geometry(task_type: str) -> tuple[float, float, float, float]:
    if task_type in {"csf_start", "csf_finish", "fork", "and"}:
        return 0, 0, 30, 30
    return 0, 0, 120, 60


def _parse_uiinfo(node: ET.Element, node_id: str, label: str,
                  warnings: list[str]) -> tuple[float, float, float, float]:
    raw = _text(node.find("uiinfo"))
    x, y, width, height = _default_geometry(node.attrib.get("tasktype", ""))
    if not raw:
        return x, y, width, height
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            return (
                float(data["x"]),
                float(data["y"]),
                float(data.get("width", width)),
                float(data.get("height", height)),
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            warnings.append(f"{label or node_id} uiinfo JSON 坐标格式无效: {raw}")
            return x, y, width, height
    try:
        values = [float(item.strip()) for item in raw.split(",")]
        if len(values) != 4:
            raise ValueError("expected four fields")
    except ValueError:
        warnings.append(f"{label or node_id} uiinfo 坐标格式无效: {raw}")
        return x, y, width, height
    return values[0], values[1], values[2], values[3]


def _parse_service(node: ET.Element) -> dict[str, Any] | None:
    auto = node.find("autodeal")
    if auto is None:
        return None
    cross_center = _boolean(_text(auto.find("crossCenter")))
    return {
        "runtype": _text(auto.find("runtype")),
        "cross_center": cross_center,
        "centercode": _text(auto.find("centercode")),
        "servicecode": _text(auto.find("servicecode")),
        "servicename": _text(auto.find("servicename")),
    }


def _parse_links(node: ET.Element) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    for link in node.findall("./relationship/task_/link"):
        default = link.find("defaultValue")
        links.append({
            "direction": link.attrib.get("name", ""),
            "left": _text(link.find("left")),
            "right": _text(link.find("right")),
            "default_value": _text(default),
            "default_value_type": default.attrib.get("dataType", "") if default is not None else "",
        })
    return links


def parse_workflow_xml(xml_text: str) -> dict[str, Any]:
    """Convert one workflow XML document into the API graph model."""
    if not xml_text or not xml_text.strip():
        raise ValueError("模板内容为空")
    text_without_declaration = _XML_DECLARATION.sub("", xml_text, count=1)
    try:
        root = ET.fromstring(text_without_declaration)
    except ET.ParseError as exc:
        raise ValueError(f"XML 解析失败: {exc}") from exc
    if root.tag != "workflow":
        raise ValueError(f"XML 根节点必须是 workflow，实际为 {root.tag}")

    warnings: list[str] = []
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    edge_pairs: set[tuple[str, str]] = set()

    def add_edge(source: str, target: str, source_kind: str) -> None:
        pair = (source, target)
        if pair in edge_pairs:
            return
        edge_pairs.add(pair)
        edges.append({
            "id": f"edge-{source}-{target}",
            "source": source,
            "target": target,
            "source_kind": source_kind,
        })

    for task in root.findall("task"):
        node_id = task.attrib.get("id", "")
        label = task.attrib.get("label", "")
        x, y, width, height = _parse_uiinfo(task, node_id, label, warnings)
        nodes.append({
            "id": node_id,
            "label": label,
            "type": task.attrib.get("tasktype", ""),
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "goto": [item.attrib.get("goto", "") for item in task.findall("gotoitem")],
            "service": _parse_service(task),
            "links": _parse_links(task),
        })
        for goto in task.findall("gotoitem"):
            add_edge(node_id, goto.attrib.get("goto", ""), "goto")

    node_ids = {node["id"] for node in nodes}
    for join in root.findall("join"):
        source = join.attrib.get("taska", "")
        target = join.attrib.get("taskb", "")
        add_edge(source, target, "join")
        if source and source not in node_ids:
            warnings.append(f"连线 {join.attrib.get('id', source)} 的来源节点不存在: {source}")
        if target and target not in node_ids:
            warnings.append(f"连线 {join.attrib.get('id', target)} 的目标节点不存在: {target}")

    resolved_edges = [edge for edge in edges
                      if edge["source"] in node_ids and edge["target"] in node_ids]
    if len(resolved_edges) != len(edges):
        warnings.append("已忽略存在无效端点的连线")

    bounds_width = max((node["x"] + node["width"] for node in nodes), default=0)
    bounds_height = max((node["y"] + node["height"] for node in nodes), default=0)
    return {
        **root.attrib,
        "description": _text(root.find("description")),
        "variables": [
            {
                "name": item.attrib.get("name", ""),
                "datatype": item.attrib.get("datatype", ""),
                "defaultvalue": item.attrib.get("defaultvalue", ""),
                "inouttype": item.attrib.get("inouttype", ""),
                "description": item.attrib.get("description", ""),
            }
            for item in root.findall("vars")
        ],
        "nodes": nodes,
        "edges": resolved_edges,
        "warnings": warnings,
        "width": bounds_width,
        "height": bounds_height,
    }


DEFAULT_VERSION_TABLE = "aif_comframe.vm_template_version"
_TABLE_NAME_RE = re.compile(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$")


def _validated_table_name(table_name: str) -> str:
    name = (table_name or "").strip() or DEFAULT_VERSION_TABLE
    if not _TABLE_NAME_RE.match(name):
        raise ValueError(f"工作流版本表名不合法: {table_name}")
    return name


def select_workflow_template_versions(connection: Connection, template_tag: str,
                                      table_name: str = DEFAULT_VERSION_TABLE) -> list[dict[str, Any]]:
    """Read all stored chunks for each version of one template tag."""
    sql = text(f"""
        SELECT template_version_id, order_num, template_tag, create_staff_id,
               create_date, modify_desc, valid_date, expire_date,
               content, content1, content2, content3, content4, content5,
               content6, content7, content8, content9, content10,
               content11, content12, content13, content14, content15
        FROM {_validated_table_name(table_name)}
        WHERE template_tag = :template_tag
        ORDER BY valid_date DESC, template_version_id DESC
    """)
    return [dict(row._mapping) for row in connection.execute(sql, {"template_tag": template_tag})]


def _time_value(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="milliseconds")
    return str(value)


def _as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return datetime.min


def build_workflow_template_response(connection: Connection, template_tag: str,
                                     table_name: str = DEFAULT_VERSION_TABLE) -> dict[str, Any]:
    """Parse every matching version and select a usable default."""
    rows = select_workflow_template_versions(connection, template_tag, table_name)
    versions: list[dict[str, Any]] = []
    now = datetime.now()

    for row in rows:
        content = normalize_template_content(*(row.get(column) for column in CONTENT_COLUMNS))
        graph: dict[str, Any] | None = None
        parse_error: str | None = None
        try:
            graph = parse_workflow_xml(content)
        except ValueError as exc:
            parse_error = str(exc)

        valid_date = _time_value(row.get("valid_date"))
        expire_date = _time_value(row.get("expire_date"))
        versions.append({
            "template_version_id": row.get("template_version_id"),
            "order_num": row.get("order_num"),
            "template_tag": row.get("template_tag", template_tag),
            "create_staff_id": row.get("create_staff_id"),
            "create_date": _time_value(row.get("create_date")),
            "modify_desc": row.get("modify_desc"),
            "valid_date": valid_date,
            "expire_date": expire_date,
            "is_expired": expire_date is not None and _as_datetime(expire_date) < now,
            "content": content,
            "workflow": graph,
            "parse_error": parse_error,
        })

    parseable = [version for version in versions if version["workflow"] is not None]
    active = [version for version in parseable if not version["is_expired"]]
    candidates = active or parseable or versions
    selected = max(
        candidates,
        key=lambda version: (
            _as_datetime(version.get("valid_date")),
            version.get("template_version_id") or 0,
        ),
        default=None,
    )
    return {
        "template_tag": template_tag,
        "version_table": _validated_table_name(table_name),
        "selected_version_id": selected.get("template_version_id") if selected else None,
        "versions": versions,
    }
