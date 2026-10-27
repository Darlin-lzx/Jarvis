"""数据分析：配置驱动的级联查询引擎 + 家庭订单中心专用查询。

模型参考 Nexus 数据查询（业务中心 → 场景 → 级联节点），查询执行统一走
DbTools.query（只读校验 / 行数上限 / 审计 / 熔断），数据源按 Jarvis
数据源名称解析（如「家庭订单库」「工作流订单库」）。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from sqlalchemy import select

from jarvis_agent.db import AnalysisCenter, AnalysisNode, AnalysisScene, Database

FAMILY_ORDER_CENTER = "family_order"
FAMILY_DATASOURCE = "家庭订单库"
FAMILY_CONFIG_DATASOURCE = "家庭订单配置库"
LEGACY_FAMILY_DATASOURCE = "家庭订单B"
WORKFLOW_ORDER_DATASOURCE = "工作流订单库"
PRODUCT_CENTER = "product_center"
PRODUCT_DATASOURCE = "产品库"
RULE_CONFIG_DATASOURCE = "规则配置库"
FAMILY_BUSINESS_CONFIG_DATASOURCE = "家庭业务配置库"
INSTANCE_CENTER = "instance_center"
INSTANCE_DATASOURCE = "营业库"
PRODUCT_DRIVE_CENTER = "product_drive_center"
CUSTOMER_ORDER_CENTER = "hall_center"        # 客户订单中心（对齐 Nexus hall_center）
CUSTOMER_DATASOURCE = "客户订单库"            # 客户订单B中心（OceanBase order4）
CUSTOMER_CONFIG_DATASOURCE = "客户订单配置库"  # HALLCFG
WIRED_MESSAGE_TYPES = ("SEND_TO_IMEP", "IMEP_BACK", "SEND_TO_IRMS", "IRMS_BACK")
NODE_ROW_LIMIT = 100
# 密码服务（内网）：SM4 加密字段信封解密，入参 {"policy":"SM4","cipher":"..."}
DECRYPT_API_URL = "http://20.26.234.70:8080/api/decrypt"


def _norm_month(history_month: str) -> str:
    return (history_month or "").strip().replace("-", "")


def history_table_name(table: str, history_month: str) -> str:
    """历史表名转换（与原工具平台一致）：
    普通表 xxx_574 → xxx_h_574_YYYYMM；vm_ 工作流表 → h_vm_xxx_574_YYYYMM。"""
    month = _norm_month(history_month)
    if not month:
        return table
    if table.startswith("vm_"):
        return f"h_{table}_{month}"
    if "_574" in table:
        return table.replace("_574", f"_h_574_{month}", 1)
    return table


def convert_table_name(table: str, city: str, history_month: str) -> str:
    """在途表 {table}_{city}；历史表按 history_table_name 规则转换。"""
    base = f"{table}_{city}"
    return history_table_name(base, history_month)


def convert_table_name_for_center(center: AnalysisCenter, table: str, city: str,
                                  history_month: str) -> str:
    """按中心配置的表名规则生成实际表名，占位符 {table}/{city}/{month}。
    如家庭订单：在途 {table}_{city}、历史 {table}_h_{city}_{month}；
    客户订单：在途 {table}、历史 HIS_{table}。"""
    month = _norm_month(history_month)
    rule = center.history_table_rule if month else center.in_transit_table_rule
    return rule.format(table=table, city=city, month=month)


def _run_query(db_tools, datasource_name: str, sql: str, limit: int = NODE_ROW_LIMIT) -> dict[str, Any]:
    result = db_tools.query(datasource_name, sql, limit=limit)
    return {
        "success": bool(result.get("ok")),
        "columns": result.get("columns", []),
        "rows": result.get("rows", []),
        "row_count": result.get("row_count", 0),
        "error": "" if result.get("ok") else (result.get("message") or "查询失败"),
        "sql": sql,
    }


def _digit(value: str, field: str) -> str:
    value = (value or "").strip()
    if not value or not value.isdigit():
        raise ValueError(f"{field}格式错误，只能包含数字")
    return value


def _field_values(result: dict[str, Any], field: str) -> list[str]:
    """从查询结果列中取指定字段的全部取值（去重、去空）。"""
    columns = [str(column).lower() for column in result.get("columns", [])]
    if field.lower() not in columns:
        return []
    index = columns.index(field.lower())
    values: list[str] = []
    for row in result.get("rows", []):
        value = str(row[index]).strip() if index < len(row) else ""
        if value and value not in values:
            values.append(value)
    return values


# ---------- 配置读取 ----------

def _center(db: Database, center_code: str) -> AnalysisCenter:
    with db.session() as session:
        center = session.scalar(select(AnalysisCenter).where(
            AnalysisCenter.center_code == center_code, AnalysisCenter.enabled == True))  # noqa: E712
    if not center:
        raise ValueError(f"业务中心不存在或已停用: {center_code}")
    return center


def list_centers(db: Database) -> list[dict[str, Any]]:
    """业务中心及场景（前端初始化用）。"""
    with db.session() as session:
        centers = list(session.scalars(select(AnalysisCenter)
                                       .where(AnalysisCenter.enabled == True)  # noqa: E712
                                       .order_by(AnalysisCenter.sort_order, AnalysisCenter.id)))
        scenes = list(session.scalars(select(AnalysisScene)
                                      .where(AnalysisScene.enabled == True)  # noqa: E712
                                      .order_by(AnalysisScene.sort_order, AnalysisScene.id)))
    by_center: dict[int, list[dict[str, Any]]] = {}
    for scene in scenes:
        by_center.setdefault(scene.center_id, []).append({
            "scene_code": scene.scene_code,
            "scene_name": scene.scene_name,
            "render_mode": scene.render_mode,
        })
    return [{
        "center_code": center.center_code,
        "center_name": center.center_name,
        "icon": center.icon,
        "default_city": center.default_city,
        "scenes": by_center.get(center.id, []),
    } for center in centers]


def _scene_nodes(db: Database, center: AnalysisCenter, scene_code: str):
    with db.session() as session:
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == center.id,
            AnalysisScene.scene_code == scene_code,
            AnalysisScene.enabled == True))  # noqa: E712
        if not scene:
            raise ValueError(f"查询场景不存在: {center.center_code}/{scene_code}")
        node_stmt = select(AnalysisNode).where(
            AnalysisNode.scene_id == scene.id,
            AnalysisNode.enabled == True,  # noqa: E712
        ).order_by(AnalysisNode.sort_order, AnalysisNode.id)
        nodes = list(session.scalars(node_stmt))
    if not nodes:
        raise ValueError(f"该场景下未配置查询节点: {scene_code}")
    return scene, nodes


# ---------- 级联查询引擎 ----------

def _node_result(node: AnalysisNode, table: str, query: dict[str, Any]) -> dict[str, Any]:
    return {
        "node_code": node.node_code,
        "node_name": node.node_name,
        "table_name": table,
        "datasource_name": node.datasource_name,
        "color": node.color,
        "parent_node_code": node.parent_node_code or "",
        "parent_field": node.parent_field or "",
        "query_field": node.query_field,
        **{key: query[key] for key in ("success", "columns", "rows", "row_count", "error", "sql")},
    }


def execute_scene_query(db: Database, db_tools, center_code: str, scene_code: str,
                        business_key: str, city: str, in_transit: bool,
                        history_month: str) -> dict[str, Any]:
    """执行一个场景的级联查询：根节点按业务主键，子节点按父结果关联字段 IN 查询。"""
    key = _digit(business_key, "业务主键")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""

    center = _center(db, center_code)
    _, nodes = _scene_nodes(db, center, scene_code)

    results: list[dict[str, Any]] = []
    by_code: dict[str, dict[str, Any]] = {}
    for node in nodes:
        table = convert_table_name_for_center(center, node.table_name, city, month)
        if not node.parent_node_code:
            sql = f"SELECT * FROM {table} WHERE {node.query_field} = '{key}'"
            query = _run_query(db_tools, node.datasource_name, sql)
        else:
            parent = by_code.get(node.parent_node_code)
            values = _field_values(parent, node.parent_field) if parent else []
            if not values:
                query = {"success": True, "columns": [], "rows": [], "row_count": 0,
                         "error": "", "sql": ""}
            else:
                in_list = ", ".join(f"'{value}'" for value in values)
                sql = f"SELECT * FROM {table} WHERE {node.query_field} IN ({in_list})"
                query = _run_query(db_tools, node.datasource_name, sql)
        result = _node_result(node, table, query)
        results.append(result)
        by_code[node.node_code] = result
    return {
        "center_code": center_code,
        "scene_code": scene_code,
        "business_key": key,
        "city": city,
        "in_transit": in_transit,
        "history_month": month,
        "nodes": results,
    }


def execute_node_query(db: Database, db_tools, center_code: str, scene_code: str,
                       node_code: str, value: str, city: str, in_transit: bool,
                       history_month: str) -> dict[str, Any]:
    """单节点实时查询（如点击调度订单后实时查工单）。"""
    value = _digit(value, "查询值")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""

    center = _center(db, center_code)
    _, nodes = _scene_nodes(db, center, scene_code)
    node = next((item for item in nodes if item.node_code == node_code), None)
    if not node:
        raise ValueError(f"查询节点不存在: {node_code}")

    table = convert_table_name_for_center(center, node.table_name, city, month)
    sql = f"SELECT * FROM {table} WHERE {node.query_field} = '{value}'"
    return _node_result(node, table, _run_query(db_tools, node.datasource_name, sql))


# ---------- 家庭订单中心专用查询 ----------

def _query(db_tools, datasource: str, sql: str,
           cell_limit: int | None = None) -> dict[str, Any]:
    """cell_limit=None 不截断单元格（报文拼接场景必须，截断会破坏 JSON 完整性）。"""
    result = db_tools.query(datasource, sql, limit=NODE_ROW_LIMIT, cell_limit=cell_limit)
    return {
        "success": bool(result.get("ok")),
        "columns": result.get("columns", []),
        "rows": result.get("rows", []),
        "row_count": result.get("row_count", 0),
        "error": "" if result.get("ok") else (result.get("message") or "查询失败"),
        "sql": sql,
    }


def query_workflow(db_tools, order_id: str, scheduler_ids: str, city: str,
                   in_transit: bool, history_month: str) -> dict[str, Any]:
    """工作流信息：主工作流 → 调度；RBoss 工作流 → RBoss 调度 → RBoss 任务（工作流订单库）。"""
    order_id = _digit(order_id, "家庭订单编号")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""
    ds = WORKFLOW_ORDER_DATASOURCE

    def table(name: str) -> str:
        return convert_table_name(name, city, month)

    workflow = _query(db_tools, ds,
                      f"SELECT * FROM {table('vm_wf_order')} WHERE workflow_object_id = '{order_id}'")

    schedule: dict[str, Any] = {"success": True, "columns": [], "rows": [], "row_count": 0, "error": "", "sql": ""}
    workflow_ids = _field_values(workflow, "workflow_id")
    if workflow_ids:
        in_list = ", ".join(f"'{wid}'" for wid in workflow_ids)
        schedule = _query(db_tools, ds,
                          f"SELECT * FROM {table('vm_schedule_order')} WHERE workflow_id IN ({in_list})")

    rboss: dict[str, Any] = {"success": True, "columns": [], "rows": [], "row_count": 0, "error": "", "sql": ""}
    rboss_schedule = dict(rboss)
    rboss_task = dict(rboss)
    ids = [item.strip() for item in (scheduler_ids or "").split(",") if item.strip().isdigit()]
    if ids:
        in_list = ", ".join(f"'{item}'" for item in ids)
        rboss = _query(db_tools, ds,
                       f"SELECT * FROM {table('vm_wf_rboss')} WHERE workflow_object_id IN ({in_list})", )
        rboss_workflow_ids = _field_values(rboss, "workflow_id")
        if rboss_workflow_ids:
            in_list = ", ".join(f"'{wid}'" for wid in rboss_workflow_ids)
            rboss_schedule = _query(db_tools, ds,
                                    f"SELECT * FROM {table('vm_schedule_rboss')} WHERE workflow_id IN ({in_list})")
            task_workflow_ids = _field_values(rboss_schedule, "workflow_id")
            if task_workflow_ids:
                in_list = ", ".join(f"'{wid}'" for wid in task_workflow_ids)
                rboss_task = _query(db_tools, ds,
                                    f"SELECT * FROM {table('vm_task_rboss')} WHERE workflow_id IN ({in_list})")

    def block(name: str, result: dict[str, Any]) -> dict[str, Any]:
        return {"name": name, **result}

    return {
        "order_id": order_id,
        "scheduler_ids": ids,
        "results": [
            block("工作流订单", workflow),
            block("调度订单工作流", schedule),
            block("RBoss工作流", rboss),
            block("RBoss调度", rboss_schedule),
            block("RBoss任务", rboss_task),
        ],
    }


def query_wired_message(db_tools, task_id: str, done_date: str, message_type: str,
                        city: str, in_transit: bool, history_month: str) -> dict[str, Any]:
    """有线报文：ord_inter_msg_{city}_{YYYYMMDD}，按报文类型 + 任务ID 查询。
    日报表按天分表，历史数据仍在对应日期的表内，历史模式表名不变（不走月表 h 规则）。"""
    task_id = _digit(task_id, "任务ID")
    if message_type not in WIRED_MESSAGE_TYPES:
        raise ValueError(f"不支持的报文类型: {message_type}")
    city = (city or "").strip() or "574"
    date = (done_date or "").strip()
    if not (len(date) == 8 and date.isdigit()):
        date = datetime.now().strftime("%Y%m%d")

    table = f"ord_inter_msg_{city}_{date}"
    sql = (f"SELECT * FROM {table} WHERE receive_object_type = '{message_type}' "
           f"AND receive_object_value = '{task_id}'")
    return {"task_id": task_id, "message_type": message_type, **_query(db_tools, FAMILY_DATASOURCE, sql)}


def query_billing_message(db_tools, cust_order_id: str, key_ele_id: str, done_date: str,
                          city: str, in_transit: bool, history_month: str) -> dict[str, Any]:
    """计费报文：ord_message_log_{city}_{YYYYMMDD}，按客户订单 + 调度订单查询。
    日报表按天分表，历史数据仍在对应日期的表内，历史模式表名不变（不走月表 h 规则）。"""
    cust_order_id = _digit(cust_order_id, "客户订单ID")
    key_ele_id = _digit(key_ele_id, "调度订单ID")
    city = (city or "").strip() or "574"
    date = (done_date or "").strip()
    if not (len(date) == 8 and date.isdigit()):
        date = datetime.now().strftime("%Y%m%d")

    table = f"ord_message_log_{city}_{date}"
    sql = (f"SELECT * FROM {table} WHERE cust_order_id = '{cust_order_id}' "
           f"AND key_ele_id = '{key_ele_id}' AND msg_topic = 'OrdOuterOrder2Billing' "
           f"ORDER BY serial_id")
    return {"cust_order_id": cust_order_id, "key_ele_id": key_ele_id,
            **_query(db_tools, FAMILY_DATASOURCE, sql)}


def query_stage_reply(db_tools, task_id: str, city: str, in_transit: bool,
                      history_month: str) -> dict[str, Any]:
    """阶段性回复：aiorder.ORD_TASK_dealinfo_{city}，按任务ID 查询。"""
    task_id = _digit(task_id, "任务ID")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""

    table = history_table_name(f"ORD_TASK_dealinfo_{city}", month)
    sql = f"SELECT t.* FROM aiorder.{table} t WHERE task_id = '{task_id}'"
    return {"task_id": task_id, **_query(db_tools, FAMILY_DATASOURCE, sql)}


# 异步流程在途表为进程处理表，处理完成记录即移历史；在途查不到时自动回退扫近几个月历史表
ASYNC_FLOW_HISTORY_SCAN_MONTHS = 3


def _recent_months(count: int) -> list[str]:
    """从当月往前推 count 个月（含当月）的 YYYYMM 列表。"""
    now = datetime.now()
    index = now.year * 12 + now.month - 1
    return [f"{(index - offset) // 12}{(index - offset) % 12 + 1:02d}"
            for offset in range(count)]


def query_async_flow(db_tools, order_id: str, city: str,
                     in_transit: bool, history_month: str) -> dict[str, Any]:
    """异步流程：ord_async_method_deal_task_order_{city}，按客户订单号查询。
    在途/历史表名走家庭中心规则（历史 xxx_h_{city}_{month}）。
    在途查询成功但无记录时，自动回退查近 ASYNC_FLOW_HISTORY_SCAN_MONTHS 个月历史表，
    命中即返回（from_history/history_fallback 标记来源）；指定历史月则只查该月。
    在途查询本身失败（数据源需 VPN，未连通时连接超时）则直接返回，不连环扫历史表。
    历史模式未指定月份时默认查当月历史表。"""
    order_id = _digit(order_id, "家庭订单编号")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""
    if not in_transit and not month:
        month = datetime.now().strftime("%Y%m")

    def run(table: str) -> dict[str, Any]:
        return _query(db_tools, FAMILY_DATASOURCE,
                      f"SELECT * FROM {table} WHERE cust_order_id = '{order_id}'")

    if month:
        history_table = convert_table_name("ord_async_method_deal_task_order", city, month)
        return {"order_id": order_id, "table_name": history_table,
                "from_history": True, "history_fallback": False,
                "checked_tables": [history_table], **run(history_table)}

    in_transit_table = convert_table_name("ord_async_method_deal_task_order", city, "")
    checked = [in_transit_table]
    transit_result = run(in_transit_table)
    if transit_result["row_count"] > 0 or not transit_result["success"]:
        return {"order_id": order_id, "table_name": in_transit_table,
                "from_history": False, "history_fallback": False,
                "checked_tables": checked, **transit_result}

    for recent in _recent_months(ASYNC_FLOW_HISTORY_SCAN_MONTHS):
        history_table = convert_table_name("ord_async_method_deal_task_order", city, recent)
        checked.append(history_table)
        result = run(history_table)
        if result["row_count"] > 0:
            return {"order_id": order_id, "table_name": history_table,
                    "from_history": True, "history_fallback": True,
                    "checked_tables": checked, **result}

    return {"order_id": order_id, "table_name": in_transit_table,
            "from_history": False, "history_fallback": False,
            "checked_tables": checked, **transit_result}


# 档次类型：up_offer.offer_type 为该值才是档次，否则档次配置查询直接报错
PRODUCT_OFFER_TYPE_VAS_BIND = "OFFER_VAS_BIND"
# 角色信息（up_item_relat）关系类型：策划通用规格角色
PRODUCT_RELAT_KIND_SPEC_ROLE = "OFFER_PLAN_GENERAL_SPEC_ROLE"
# 业务关系（up_item_relat）关系类型：策划通用业务；relat_product_item_id → up_business.business_id
PRODUCT_RELAT_KIND_GENERAL_BUSINESS = "OFFER_PLAN_GENERAL_BUSINESS"
# 产品关系（up_plan_plan_rel）查询列，关系类型固定为 策划包含策划
PRODUCT_RELAT_KIND_INCLUDE = "OFFER_PLAN_INCLUDE_OFFER_PLAN"
# 策划关联产品（up_plan_prod_rel）关系类型：策划包含单产品
PRODUCT_RELAT_KIND_INCLUDE_SRVC = "OFFER_PLAN_INCLUDE_SRVC_SINGLE"
# 产品属性信息（up_item_relat）关系类型：单产品资费服务
PRODUCT_RELAT_KIND_PRICE_SERVICE = "SRVC_SINGLE_PRICE_SERVICE"
_PRODUCT_REL_COLUMNS = (
    "item_relat_id, product_item_id, relat_product_item_id, prod_item_relat_kind_id, "
    "extend_attr_a, extend_attr_b, extend_attr_c, extend_attr_d, extend_attr_e, "
    "extend_attr_f, extend_attr_g, extend_attr_h, extend_attr_i, extend_attr_j, "
    "extend_attr_k, extend_attr_l, extend_attr_m, extend_attr_n, extend_attr_o"
)


def query_up_rule(db_tools, rule_id: str) -> dict[str, Any]:
    """框架规则定义：busicfg.UP_RULE 按规则ID查询（家庭业务配置库）。
    产品驱动「框架规则」点击 RULE_ID 弹出展示。"""
    rule_id = (rule_id or "").strip()
    if not rule_id.isdigit():
        raise ValueError("规则ID格式错误，只能包含数字")
    sql = f"SELECT * FROM busicfg.UP_RULE WHERE RULE_ID = {rule_id}"
    return {"rule_id": rule_id, "table_name": "busicfg.UP_RULE",
            **_query(db_tools, FAMILY_BUSINESS_CONFIG_DATASOURCE, sql)}


def query_business_info(db_tools, business_id: str) -> dict[str, Any]:
    """业务信息：product.up_business 按业务ID查询（产品库）。
    档次/策划配置「业务关系」点击 relat_product_item_id 弹出展示。"""
    business_id = (business_id or "").strip()
    if not business_id.isdigit():
        raise ValueError("业务ID格式错误，只能包含数字")
    sql = f"SELECT * FROM product.up_business WHERE business_id = {business_id}"
    return {"business_id": business_id, "table_name": "product.up_business",
            **_query(db_tools, PRODUCT_DATASOURCE, sql)}


def query_product_config(db_tools, product_item_id: str) -> dict[str, Any]:
    """档次配置（产品库，按档次编号查询）：先查 up_offer 校验 offer_type=OFFER_VAS_BIND
    （是档次才继续，否则抛错），再查 up_product_item（档次配置）、up_item_feature
    （产品特性，有效记录）、up_plan_plan_rel（产品关系，策划包含策划）、
    up_item_relat（角色信息，策划通用规格角色；业务关系，策划通用业务，
    点击 relat_product_item_id 弹窗查业务信息，见 query_business_info）。
    产品表不区分地市、无在途/历史之分。"""
    product_item_id = _digit(product_item_id, "档次编号")
    offer = _query(db_tools, PRODUCT_DATASOURCE,
                   f"SELECT * FROM product.up_offer WHERE offer_id = {product_item_id}")
    offer_columns = [str(column).lower() for column in offer.get("columns", [])]
    offer_types = {str(dict(zip(offer_columns, row)).get("offer_type") or "").strip().upper()
                   for row in offer.get("rows", [])}
    if not offer.get("success"):
        raise ValueError(f"档次校验查询失败: {offer.get('error') or 'up_offer 查询失败'}")
    if not offer.get("rows"):
        raise ValueError(f"编号 {product_item_id} 在 product.up_offer 无记录，不是档次")
    if offer_types != {PRODUCT_OFFER_TYPE_VAS_BIND}:
        found = "、".join(sorted(offer_types)) or "(空)"
        raise ValueError(f"编号 {product_item_id} 不是档次："
                         f"offer_type={found}（要求 {PRODUCT_OFFER_TYPE_VAS_BIND}）")

    columns = ", ".join(f"a.{c.strip()}" for c in _PRODUCT_REL_COLUMNS.split(","))
    sqls = (
        ("档次信息", "up_offer", None),
        ("档次配置", "up_product_item",
         f"SELECT * FROM product.up_product_item "
         f"WHERE product_item_id = {product_item_id}"),
        ("产品特性", "up_item_feature",
         f"SELECT * FROM product.up_item_feature "
         f"WHERE product_item_id = {product_item_id} AND del_flag = '1'"),
        ("产品关系", "up_plan_plan_rel",
         f"SELECT {columns} FROM product.up_plan_plan_rel a "
         f"WHERE a.prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_INCLUDE}' "
         f"AND a.product_item_id = {product_item_id} AND a.del_flag = '1'"),
        ("角色信息", "up_item_relat",
         f"SELECT {columns} FROM product.up_item_relat a "
         f"WHERE a.prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_SPEC_ROLE}' "
         f"AND a.product_item_id = {product_item_id} AND a.del_flag = '1'"),
        ("业务关系", "up_item_relat",
         f"SELECT {columns} FROM product.up_item_relat a "
         f"WHERE a.prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_GENERAL_BUSINESS}' "
         f"AND a.product_item_id = {product_item_id} AND a.del_flag = '1'"),
    )
    results = []
    for label, table, sql in sqls:
        if sql is None:  # 档次信息复用校验时的 up_offer 查询结果
            results.append({"name": label, "table_name": f"product.{table}", **offer})
            continue
        results.append({"name": label, "table_name": f"product.{table}",
                        **_query(db_tools, PRODUCT_DATASOURCE, sql)})

    return {"product_item_id": product_item_id, "results": results}


def query_plan_config(db_tools, product_item_id: str) -> dict[str, Any]:
    """策划配置：product.up_product_item（档次配置）+ product.up_item_feature
    （产品特性，有效记录）+ product.up_plan_prod_rel（关联产品，策划包含单产品）
    + product.UP_OFFER_PRE_LIMIT（前项限制，OFFER_ID 即策划编号）
    + up_item_relat（业务关系，策划通用业务，点击 relat_product_item_id 弹窗查
    业务信息，见 query_business_info），按编号查询（产品库）。"""
    product_item_id = _digit(product_item_id, "产品编号")
    sqls = (
        ("档次配置", "up_product_item",
         f"SELECT * FROM product.up_product_item "
         f"WHERE product_item_id = {product_item_id}"),
        ("产品特性", "up_item_feature",
         f"SELECT * FROM product.up_item_feature "
         f"WHERE product_item_id = {product_item_id} AND del_flag = '1'"),
        ("关联产品", "up_plan_prod_rel",
         f"SELECT a.* FROM product.up_plan_prod_rel a "
         f"WHERE a.product_item_id = {product_item_id} "
         f"AND a.prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_INCLUDE_SRVC}' "
         f"AND a.del_flag = '1' ORDER BY a.sort_by"),
        ("前项限制", "UP_OFFER_PRE_LIMIT",
         f"SELECT * FROM product.UP_OFFER_PRE_LIMIT "
         f"WHERE OFFER_ID = {product_item_id} AND DEL_FLAG = '1'"),
        ("业务关系", "up_item_relat",
         f"SELECT {', '.join(f'a.{c.strip()}' for c in _PRODUCT_REL_COLUMNS.split(','))} "
         f"FROM product.up_item_relat a "
         f"WHERE a.prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_GENERAL_BUSINESS}' "
         f"AND a.product_item_id = {product_item_id} AND a.del_flag = '1'"),
    )
    results = []
    for label, table, sql in sqls:
        results.append({"name": label, "table_name": f"product.{table}",
                        **_query(db_tools, PRODUCT_DATASOURCE, sql)})
    return {"product_item_id": product_item_id, "results": results}


def query_item_relat(db_tools, product_item_id: str) -> dict[str, Any]:
    """属性信息：product.up_item_relat 按产品编号查询（单产品资费服务关系，
    有效记录，产品库）。策划配置「关联产品」点击产品编号后下钻查询。"""
    product_item_id = _digit(product_item_id, "产品编号")
    sql = (f"SELECT * FROM product.up_item_relat "
           f"WHERE product_item_id = {product_item_id} "
           f"AND prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_PRICE_SERVICE}' "
           f"AND del_flag = '1'")
    return {"product_item_id": product_item_id,
            "results": [{"name": "属性信息", "table_name": "product.up_item_relat",
                         **_query(db_tools, PRODUCT_DATASOURCE, sql)}]}


def _instance_bill_params(bill_id: str, city: str) -> tuple[str, str, str]:
    """实例中心公共入参校验：计费账号（字母数字混合）+ 地市（数字）→ (账号, 地市, schema前缀)。"""
    bill_id = (bill_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", bill_id):
        raise ValueError("计费账号格式错误，只能包含字母数字")
    city = (city or "").strip() or "574"
    if not city.isdigit():
        raise ValueError("地市格式错误，只能包含数字")
    return bill_id, city, f"so570{city}"


def query_instance_user(db_tools, bill_id: str, city: str = "") -> dict[str, Any]:
    """用户信息（实例中心）：so570{city}.ins_user_{city} 按计费账号查询（营业库）。
    结果行 cust_type=1 时级联查个人客户（cm_indiv_customer，indiv_cust_id=cust_id），
    family_cust_id 非空时级联查家庭客户（cm_family_customer）。不满足条件不查。
    bill_id 为字母数字混合账号（如 nbcxa06600382），不走通用级联引擎的纯数字校验。"""
    bill_id, city, prefix = _instance_bill_params(bill_id, city)
    user_table = f"{prefix}.ins_user_{city}"
    user = _query(db_tools, INSTANCE_DATASOURCE,
                  f"SELECT * FROM {user_table} WHERE bill_id = '{bill_id}'")
    results = [{"name": "用户信息", "table_name": user_table, **user}]

    columns = [str(column).lower() for column in user.get("columns", [])]
    indiv_ids: list[str] = []
    family_ids: list[str] = []
    for row in user.get("rows", []):
        values = dict(zip(columns, row))
        cust_id = str(values.get("cust_id") or "").strip()
        family_id = str(values.get("family_cust_id") or "").strip()
        if str(values.get("cust_type") or "").strip() == "1" \
                and cust_id.isdigit() and cust_id not in indiv_ids:
            indiv_ids.append(cust_id)
        if family_id.isdigit() and family_id not in family_ids:
            family_ids.append(family_id)

    if indiv_ids:
        table = f"{prefix}.cm_indiv_customer_{city}"
        sql = (f"SELECT * FROM {table} "
               f"WHERE indiv_cust_id IN ({', '.join(indiv_ids)})")
        results.append({"name": "个人客户信息", "table_name": table,
                        **_query(db_tools, INSTANCE_DATASOURCE, sql)})
    if family_ids:
        table = f"{prefix}.cm_family_customer_{city}"
        sql = (f"SELECT * FROM {table} "
               f"WHERE family_cust_id IN ({', '.join(family_ids)})")
        results.append({"name": "家庭客户信息", "table_name": table,
                        **_query(db_tools, INSTANCE_DATASOURCE, sql)})
    return {"bill_id": bill_id, "results": results}


def query_instance_order(db_tools, bill_id: str, city: str = "") -> dict[str, Any]:
    """订购信息（实例中心）：先按计费账号查 ins_user 取 user_id，再按 user_id 查订购表
    （营业库）。TODO 订购表名仍为占位（按实例库 ins_* 命名惯例暂定 ins_offer），待确认。"""
    bill_id, city, prefix = _instance_bill_params(bill_id, city)
    user = _query(db_tools, INSTANCE_DATASOURCE,
                  f"SELECT * FROM {prefix}.ins_user_{city} WHERE bill_id = '{bill_id}'")
    columns = [str(column).lower() for column in user.get("columns", [])]
    user_ids: list[str] = []
    for row in user.get("rows", []):
        uid = str(dict(zip(columns, row)).get("user_id") or "").strip()
        if uid.isdigit() and uid not in user_ids:
            user_ids.append(uid)

    order_table = f"{prefix}.ins_offer_{city}"
    if not user_ids:
        return {"bill_id": bill_id,
                "results": [{"name": "订购信息", "table_name": order_table,
                             "success": False, "columns": [], "rows": [], "row_count": 0,
                             "error": "该计费账号未查到用户信息（user_id 为空），无法查询订购信息",
                             "sql": ""}]}
    sql = f"SELECT * FROM {order_table} WHERE user_id IN ({', '.join(user_ids)})"
    return {"bill_id": bill_id,
            "results": [{"name": "订购信息", "table_name": order_table,
                         **_query(db_tools, INSTANCE_DATASOURCE, sql)}]}


def query_static_config(db_tools, code: str) -> dict[str, Any]:
    """静态配置（家庭订单中心·配置查询）：bs_para_detail(para_type) + bs_static_data(code_type)
    按同一配置编码查询（家庭订单配置库）。"""
    code = (code or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", code):
        raise ValueError("配置编码格式错误，只能包含字母数字")
    sqls = (
        ("参数明细", "bs_para_detail",
         f"SELECT * FROM bs_para_detail WHERE para_type = '{code}'"),
        ("静态数据", "bs_static_data",
         f"SELECT * FROM bs_static_data WHERE code_type = '{code}'"),
    )
    results = []
    for label, table, sql in sqls:
        results.append({"name": label, "table_name": table,
                        **_query(db_tools, FAMILY_CONFIG_DATASOURCE, sql)})
    return {"code": code, "results": results}


# 产品驱动四类：角色 / 策划 / 产品 / 终端（各类 SQL 待接入）
PRODUCT_DRIVE_CATEGORIES: dict[str, str] = {
    "role": "角色",
    "plan": "策划",
    "product": "产品",
    "terminal": "终端",
}


def query_product_drive(db_tools, product_item_id: str, offer_id: str,
                        category: str = "role") -> dict[str, Any]:
    """产品驱动（家庭业务中心）：按输入编号查 角色/策划/产品/终端 四类关系。
    档次编号(product_item_id) 供 角色/策划/产品/终端；策划编号(offer_id) 供 策划/产品/终端。
    策划 = up_offer 按策划编号查 → up_item_relat 按档次编号取 business_id →
    三条件查 busicfg.UP_FRAME（frame_level='OFFER' + offer_type + business_id）；
    角色/产品/终端 TODO 待接入（category 见 PRODUCT_DRIVE_CATEGORIES）。"""
    product_item_id = (product_item_id or "").strip()
    offer_id = (offer_id or "").strip()
    label = PRODUCT_DRIVE_CATEGORIES.get(category)
    if not label:
        raise ValueError(f"未知产品驱动分类: {category}（可选 {','.join(PRODUCT_DRIVE_CATEGORIES)}）")
    need_offer = category in ("plan", "product", "terminal")
    if category != "role" and not product_item_id:
        raise ValueError("请输入档次编号")
    if need_offer and not offer_id:
        raise ValueError("请输入策划编号")
    if product_item_id and not re.fullmatch(r"[A-Za-z0-9_\-]+", product_item_id):
        raise ValueError("档次编号格式错误，只能包含字母数字")
    if offer_id and not re.fullmatch(r"[A-Za-z0-9_\-]+", offer_id):
        raise ValueError("策划编号格式错误，只能包含字母数字")
    key = product_item_id
    if category == "plan":
        # 策划：先后台取数——up_offer 拿 offer_type、up_item_relat(策划通用业务)
        # 拿 relat_product_item_id 作 business_id（这两步不在页面展示）；
        # 展示三张框架卡（均为家庭业务配置库）：
        #   框架匹配 UP_FRAME（frame_level='OFFER' + offer_type + business_id）
        #   框架属性 UP_FRAME_ATTR（按匹配到的 frame_id）
        #   框架规则 UP_FRAME_RULE（按 frame_id + ATTR_ID 配对合并）
        offer = _query(db_tools, PRODUCT_DATASOURCE,
                       f"SELECT * FROM product.up_offer WHERE offer_id = {offer_id}")
        offer_type = ""
        if offer.get("success") and offer.get("rows"):
            offer_cols = [str(column).lower() for column in offer.get("columns", [])]
            offer_type = str(dict(zip(offer_cols, offer["rows"][0])).get("offer_type") or "").strip()
        if not offer_type:
            offer_type = "OFFER_VAS_OTHER"

        rel_columns = ", ".join(f"a.{c.strip()}" for c in _PRODUCT_REL_COLUMNS.split(","))
        rel = _query(db_tools, PRODUCT_DATASOURCE,
                     f"SELECT {rel_columns} FROM product.up_item_relat a "
                     f"WHERE a.prod_item_relat_kind_id = '{PRODUCT_RELAT_KIND_GENERAL_BUSINESS}' "
                     f"AND a.product_item_id = {product_item_id} AND a.del_flag = '1'")
        rel_cols = [str(column).lower() for column in rel.get("columns", [])]
        business_ids: list[str] = []
        for row in rel.get("rows", []):
            bid = str(dict(zip(rel_cols, row)).get("relat_product_item_id") or "").strip()
            if bid.isdigit() and bid not in business_ids:
                business_ids.append(bid)

        def _fail(message: str) -> dict[str, Any]:
            return {"category": category, "results": [{
                "name": "框架匹配", "table_name": "busicfg.UP_FRAME",
                "datasource": FAMILY_BUSINESS_CONFIG_DATASOURCE,
                "success": False, "columns": [], "rows": [], "row_count": 0,
                "error": message, "sql": ""}]}

        if not business_ids:
            return _fail("未查到业务关系（up_item_relat·OFFER_PLAN_GENERAL_BUSINESS），无法匹配框架")

        frame = _query(db_tools, FAMILY_BUSINESS_CONFIG_DATASOURCE,
                       f"SELECT * FROM busicfg.UP_FRAME "
                       f"WHERE frame_level = 'OFFER' AND offer_type = '{offer_type}' "
                       f"AND business_id IN ({', '.join(business_ids)})")
        results = [{"name": "框架匹配", "table_name": "busicfg.UP_FRAME",
                    "datasource": FAMILY_BUSINESS_CONFIG_DATASOURCE, **frame}]

        frame_cols = [str(column).lower() for column in frame.get("columns", [])]
        frame_ids: list[str] = []
        for row in frame.get("rows", []):
            fid = str(dict(zip(frame_cols, row)).get("frame_id") or "").strip()
            if fid.isdigit() and fid not in frame_ids:
                frame_ids.append(fid)
        if not frame.get("success"):
            results[0] = {**results[0], "success": False, "columns": [], "rows": [],
                          "row_count": 0, "error": f"框架匹配查询失败: {frame.get('error')}"}
            return {"category": category, "results": results}
        if not frame_ids:
            return {"category": category, "results": results}

        # 框架属性：按 frame_id 合并 IN 查询
        attr = _query(db_tools, FAMILY_BUSINESS_CONFIG_DATASOURCE,
                      f"SELECT * FROM busicfg.UP_FRAME_ATTR "
                      f"WHERE frame_id IN ({', '.join(frame_ids)})")
        results.append({"name": "框架属性", "table_name": "busicfg.UP_FRAME_ATTR",
                        "datasource": FAMILY_BUSINESS_CONFIG_DATASOURCE, **attr})

        # 框架规则：按 (frame_id, ATTR_ID) 配对逐对查询后合并（配对取自框架属性行）
        attr_cols = [str(column).lower() for column in attr.get("columns", [])]
        pairs: list[tuple[str, str]] = []
        for row in attr.get("rows", []):
            values = dict(zip(attr_cols, row))
            fid = str(values.get("frame_id") or "").strip()
            aid = str(values.get("attr_id") or "").strip()
            if fid.isdigit() and aid.isdigit() and (fid, aid) not in pairs:
                pairs.append((fid, aid))
        if not pairs:
            # 属性行没有 frame_id 时退化为 frame_ids × attr_id 叉乘
            attr_ids = [str(dict(zip(attr_cols, row)).get("attr_id") or "").strip()
                        for row in attr.get("rows", [])]
            for fid in frame_ids:
                for aid in attr_ids:
                    if fid.isdigit() and aid.isdigit() and (fid, aid) not in pairs:
                        pairs.append((fid, aid))
        if not pairs:
            return {"category": category, "results": results}
        columns: list[str] = []
        rows: list[list[Any]] = []
        rule_error = ""
        for fid, aid in pairs:
            rule = _query(db_tools, FAMILY_BUSINESS_CONFIG_DATASOURCE,
                          f"SELECT * FROM busicfg.UP_FRAME_RULE "
                          f"WHERE frame_id = {fid} AND ATTR_ID = {aid}")
            if not rule.get("success"):
                rule_error = f"框架规则查询失败(frame_id={fid}, attr_id={aid}): {rule.get('error')}"
                continue
            if not columns and rule.get("columns"):
                columns = rule.get("columns", [])
            rows.extend(rule.get("rows", []))
        if not columns and rule_error:
            results.append({"name": "框架规则", "table_name": "busicfg.UP_FRAME_RULE",
                            "datasource": FAMILY_BUSINESS_CONFIG_DATASOURCE,
                            "success": False, "columns": [], "rows": [], "row_count": 0,
                            "error": rule_error, "sql": ""})
            return {"category": category, "results": results}
        results.append({"name": "框架规则", "table_name": "busicfg.UP_FRAME_RULE",
                        "datasource": FAMILY_BUSINESS_CONFIG_DATASOURCE,
                        "success": True, "columns": columns, "rows": rows,
                        "row_count": len(rows), "error": "", "sql": ""})
        return {"category": category, "results": results}
    raise ValueError(f"产品驱动·{label} 查询待接入：请提供表名与查询条件")


def query_pre_lmt_param(db_tools, limit_code: str, param_id: str) -> dict[str, Any]:
    """限制参数：product.UP_PRE_LMT_PARAM 按 limit_code + param_id 查询（产品库）。
    策划配置「前项限制」点击 rule_exp（形如 TP1(300937)）拆分后下钻查询。"""
    limit_code = (limit_code or "").strip()
    param_id = (param_id or "").strip()
    if not limit_code or not limit_code.isalnum():
        raise ValueError("limit_code 格式错误，只能包含字母数字")
    if not param_id.isdigit():
        raise ValueError("param_id 格式错误，只能包含数字")
    sql = (f"SELECT * FROM product.UP_PRE_LMT_PARAM "
           f"WHERE limit_code = '{limit_code}' AND param_id = {param_id}")
    return {"limit_code": limit_code, "param_id": param_id,
            "results": [{"name": "限制参数", "table_name": "product.UP_PRE_LMT_PARAM",
                         **_query(db_tools, PRODUCT_DATASOURCE, sql)}]}


def query_so_pre_busi_limit(db_tools, limit_code: str) -> dict[str, Any]:
    """业务限制：rule_Cfg.SO_PRE_BUSI_LIMIT 按限制编码查询（规则配置库）。
    策划配置「限制参数」点击 limit_code 下钻，结果前端弹窗展示。"""
    limit_code = (limit_code or "").strip()
    if not limit_code or not limit_code.isalnum():
        raise ValueError("LIMIT_CODE 格式错误，只能包含字母数字")
    sql = f"SELECT * FROM rule_Cfg.SO_PRE_BUSI_LIMIT WHERE LIMIT_CODE = '{limit_code}'"
    return {"limit_code": limit_code, "table_name": "rule_Cfg.SO_PRE_BUSI_LIMIT",
            **_query(db_tools, RULE_CONFIG_DATASOURCE, sql)}


def query_customer_order_message(db_tools, cust_order_id: str, city: str,
                                  in_transit: bool, history_month: str) -> dict[str, Any]:
    """客户订单下单报文：客户订单库(OceanBase) hall_cust_dtl，按 SORT_ID 排序（排除 25/26），
    报文 = 各行 CUST_DTL_INFO_A~P 拼接；JSON 报文额外提取 originalData/transformedData。
    表名规则走中心配置（在途 {table} / 历史 HIS_{table}），对齐 Nexus customer_order/message。"""
    import json as _json

    cust_order_id = (cust_order_id or "").strip()
    if not cust_order_id:
        raise ValueError("客户订单编号不能为空")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""

    center = _center(db_tools.db, CUSTOMER_ORDER_CENTER)
    table = convert_table_name_for_center(center, "hall_cust_dtl", city, month)
    sql = (f"SELECT * FROM {table} WHERE CUST_ORDER_ID = '{cust_order_id}' "
           f"AND SORT_ID NOT IN (25, 26) ORDER BY SORT_ID")
    result = _query(db_tools, CUSTOMER_DATASOURCE, sql)

    columns = [str(c).lower() for c in result.get("columns", [])]
    parts: list[str] = []
    for row in result.get("rows", []):
        values = dict(zip(columns, row))
        for i in range(16):
            parts.append(str(values.get(f"cust_dtl_info_{chr(ord('a') + i)}") or ""))
    full_message = "".join(parts)

    original_data = None
    transformed_data = None
    try:
        parsed = _json.loads(full_message)
        if isinstance(parsed, dict):
            original_data = parsed.get("originalData")
            transformed_data = parsed.get("transformedData")
    except Exception:
        pass  # 非 JSON 报文，仅展示拼接全文

    return {"cust_order_id": cust_order_id, "table_name": table,
            "message": full_message,
            "original_data": original_data, "transformed_data": transformed_data,
            **result}


# 结构化订单信息表清单（表名, 中文说明），对齐 Nexus STRUCTURED_ORDER_TABLES；
# 查询条件统一为 CUST_ORDER_ID，历史表规则 HIS_ + 原表名
STRUCTURED_ORDER_TABLES: list[tuple[str, str]] = [
    ("HALL_ORD_CUSTOMER", "客户信息"),
    ("HALL_ORD_USER", "用户"),
    ("HALL_ORD_BUSI", "业务"),
    ("HALL_ORD_OFFER", "销售品/策划"),
    ("HALL_ORD_COMM_EXT", "公共扩展"),
    ("HALL_ORD_OFFER_INS", "销售品实例"),
    ("HALL_ORD_PROD", "产品"),
    ("HALL_ORD_CONTRACT", "合同"),
    ("HALL_ORD_COMM_ATTR", "公共属性"),
    ("HALL_ORD_ACCT", "账户"),
    ("HALL_ORD_PERSON", "个人"),
    ("HALL_ORD_PRICE_PLAN", "资费计划"),
    ("HALL_ORD_TERMINAL", "终端"),
    ("HALL_ORD_TERMINAL_AFTERSALES", "终端售后"),
    ("HALL_ORD_GROUP_SUBSCRIBER", "群组用户"),
    ("HALL_ORD_UNSTRUCT", "非结构化"),
    ("HALL_ORD_GROUP_MEMBER", "群组成员"),
]


def query_structured_order_info(db_tools, cust_order_id: str, city: str,
                                 in_transit: bool, history_month: str) -> dict[str, Any]:
    """结构化订单信息：按 CUST_ORDER_ID 并行查 17 张 HALL_ORD_* 结构化表
    （在途无前缀，历史 HIS_ 前缀，走客户订单库 OceanBase）。对齐 Nexus
    customer_order/structured-order-info。"""
    from concurrent.futures import ThreadPoolExecutor

    cust_order_id = (cust_order_id or "").strip()
    if not cust_order_id:
        raise ValueError("客户订单编号不能为空")
    city = (city or "").strip() or "574"
    month = _norm_month(history_month) if not in_transit else ""

    center = _center(db_tools.db, CUSTOMER_ORDER_CENTER)
    rule = center.history_table_rule if month else center.in_transit_table_rule
    prefix = rule.format(table="", city=city, month=month)

    def _one(table_def: tuple[str, str]) -> dict[str, Any]:
        table, label = table_def
        name = f"{prefix}{table}"
        sql = f"SELECT * FROM {name} WHERE CUST_ORDER_ID = '{cust_order_id}'"
        try:
            r = _query(db_tools, CUSTOMER_DATASOURCE, sql)
        except Exception as exc:  # 单表失败不影响其余表
            return {"label": label, "table_name": name, "sql": sql,
                    "success": False, "error": str(exc),
                    "columns": [], "rows": [], "row_count": 0}
        return {"label": label, "table_name": name, "sql": sql,
                "success": bool(r.get("success")), "error": r.get("error") or "",
                "columns": r.get("columns", []), "rows": r.get("rows", []),
                "row_count": r.get("row_count", 0)}

    with ThreadPoolExecutor(max_workers=min(8, len(STRUCTURED_ORDER_TABLES))) as pool:
        tables = list(pool.map(_one, STRUCTURED_ORDER_TABLES))
    return {"cust_order_id": cust_order_id, "tables": tables}


def decrypt_cipher_value(envelope: dict[str, Any]) -> dict[str, Any]:
    """调密码服务解密 SM4 字段信封：{"policy":"SM4","cipher":"..."} → 明文。
    服务出参契约：{"success": true, "plain": "<明文>"}（plain 本身可能是 JSON 字符串）。
    库内密文多为 base64段|二进制段 组合且二进制段经文本通道易变形，
    这里自动尝试两种形态：完整值 → 仅首段（base64），以服务解密成功为准。"""
    import httpx

    if not isinstance(envelope, dict) or not envelope.get("cipher"):
        raise ValueError("参数无效：需要包含 cipher 字段的密文信封")
    policy = envelope.get("policy") or "SM4"
    cipher = str(envelope["cipher"])

    # 密文为多段式（如 标记位|长base64|二进制段）。候选形态：完整值 + 各长段（按长度降序），
    # 逐个尝试；服务对无效输入可能原样回显，plain 等于输入时视为失败（防回显）。
    variants: list[tuple[str, str]] = [("full", cipher)]
    parts = [p for p in cipher.split("|") if p]
    for i, part in enumerate(sorted(parts, key=len, reverse=True)):
        if len(part) >= 20 and part != cipher and len(variants) < 4:
            variants.append((f"part{i+1}", part))

    last_error = ""
    last_raw: Any = ""
    for variant_name, variant_cipher in variants:
        try:
            response = httpx.post(DECRYPT_API_URL,
                                  json={"policy": policy, "cipher": variant_cipher},
                                  timeout=10)
        except Exception as exc:
            return {"ok": False, "plain": "", "raw": "",
                    "error": f"解密服务不可达（需内网/VPN）: {exc}"}
        if response.status_code != 200:
            last_error = f"解密服务返回 {response.status_code}"
            last_raw = response.text[:500]
            continue
        try:
            body: Any = response.json()
        except Exception:
            last_error = "解密服务响应不是 JSON"
            last_raw = {"raw_text": response.text}
            continue
        if isinstance(body, dict) and body.get("success"):
            plain = "" if body.get("plain") is None else str(body["plain"])
            if plain.strip() and plain.strip() != variant_cipher.strip():
                return {"ok": True, "plain": plain,
                        "raw": body, "error": "", "variant": variant_name}
            last_error = "解密服务返回内容为输入回显，视为解密失败"
            last_raw = body
            continue
        last_error = "解密服务返回 success=false"
        last_raw = body
    return {"ok": False, "plain": "", "raw": last_raw, "error": last_error}


def decrypt_cipher_batch(ciphers: list[str]) -> dict[str, Any]:
    """批量解密裸密文（SM4）：并行调密码服务，结果按入参顺序对齐返回。
    供客户订单属性查询后自动解密 attr_value 列使用。"""
    from concurrent.futures import ThreadPoolExecutor

    def one(cipher: str) -> dict[str, Any]:
        try:
            return decrypt_cipher_value({"policy": "SM4", "cipher": cipher})
        except Exception as exc:
            return {"ok": False, "plain": "", "raw": "", "error": str(exc)}

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(ciphers)))) as pool:
        results = list(pool.map(one, ciphers))
    return {"results": results}


def query_def_scene(db_tools, scene_id: str) -> dict[str, Any]:
    """展示场景：按 SCENE_ID 查客户订单配置库(HALLCFG)的 DEF_SCENE 场景定义。
    入口为工单信息 task_type=5 且 scene_id 不属于 20000002/20000005 的行。"""
    scene_id = (scene_id or "").strip()
    if not scene_id.isdigit():
        raise ValueError("场景ID格式错误，只能包含数字")
    sql = f"SELECT * FROM DEF_SCENE WHERE SCENE_ID = {scene_id}"
    result = _query(db_tools, CUSTOMER_CONFIG_DATASOURCE, sql)
    scene_name = ""
    columns = [str(c).lower() for c in result.get("columns", [])]
    if "scene_name" in columns:
        idx = columns.index("scene_name")
        rows = result.get("rows") or []
        if rows and idx < len(rows[0]):
            scene_name = str(rows[0][idx] or "")
    return {"scene_id": scene_id, "scene_name": scene_name, **result}


def query_scene_rules(db_tools, scene_id: str) -> dict[str, Any]:
    """配置查询：按场景ID查 规则定义(DEF_RULE) + 场景单元关系(SCENE_UNIT_REL)，客户订单配置库。
    业务组件经规则定义中可点击的 BUSI_CMPT_ID/RESULT 值按 ID 单查（见 query_busi_cmpt）。"""
    scene_id = (scene_id or "").strip()
    if not scene_id:
        raise ValueError("场景ID不能为空")
    if "'" in scene_id or not scene_id.isdigit():
        raise ValueError("场景ID格式错误，只能包含数字")

    rule_sql = f"SELECT * FROM DEF_RULE WHERE SCENE_ID = '{scene_id}'"
    unit_rel_sql = f"SELECT * FROM HALLCFG.SCENE_UNIT_REL WHERE SCENE_ID = '{scene_id}'"
    return {"scene_id": scene_id,
            "rule": {"node_name": "规则定义",
                     **_query(db_tools, CUSTOMER_CONFIG_DATASOURCE, rule_sql)},
            "unit_rel": {"node_name": "场景单元关系",
                         **_query(db_tools, CUSTOMER_CONFIG_DATASOURCE, unit_rel_sql)}}


def query_busi_cmpt(db_tools, busi_cmpt_id: str) -> dict[str, Any]:
    """业务组件定义：DEF_BUSI_CMPT 按 BUSI_CMPT_ID 查（客户订单配置库）。
    支持单个 ID（= 精确查）或逗号分隔多个 ID（IN 查询）。
    入口为规则定义/流程实例信息中可点击的 BUSI_CMPT_ID / RESULT 字段值。"""
    busi_cmpt_id = (busi_cmpt_id or "").strip()
    if not busi_cmpt_id:
        raise ValueError("业务组件ID不能为空")
    ids = [item.strip() for item in busi_cmpt_id.split(",") if item.strip()]
    if not ids or any((not item.isdigit()) or item == "0" for item in ids):
        raise ValueError("业务组件ID格式错误，只能包含数字（多个以逗号分隔）")
    if len(ids) == 1:
        sql = f"SELECT * FROM DEF_BUSI_CMPT WHERE BUSI_CMPT_ID = '{ids[0]}'"
    else:
        in_list = ", ".join(f"'{item}'" for item in ids)
        sql = f"SELECT * FROM DEF_BUSI_CMPT WHERE BUSI_CMPT_ID IN ({in_list})"
    return {"busi_cmpt_id": busi_cmpt_id,
            **_query(db_tools, CUSTOMER_CONFIG_DATASOURCE, sql)}


def retry_hall_task(db_tools, cust_order_id: str, task_id: str) -> dict[str, Any]:
    """工单重试（工单信息 task_type=5 场景）：在途表 HALL_TASK 的 TASK_STATE 置 2，
    并同步将 HALL_TASK_FLOW_INS 的 handle_type 置 2（流程实例重新处理）。
    两条固定模板写操作，经 DbTools.ob_execute 白名单通道执行；历史表不可重试。"""
    cust_order_id = (cust_order_id or "").strip()
    task_id = (task_id or "").strip()
    if not cust_order_id or "'" in cust_order_id:
        raise ValueError("客户订单ID不能为空且不能包含引号")
    if not task_id.isdigit():
        raise ValueError("任务ID格式错误，只能包含数字")

    center = _center(db_tools.db, CUSTOMER_ORDER_CENTER)
    rule = center.in_transit_table_rule
    task_table = rule.format(table="HALL_TASK", city="", month="")
    flow_table = rule.format(table="HALL_TASK_FLOW_INS", city="", month="")
    task_sql = (f"UPDATE {task_table} SET TASK_STATE = 2 "
                f"WHERE CUST_ORDER_ID = '{cust_order_id}' AND TASK_ID = {task_id}")
    flow_sql = f"UPDATE {flow_table} SET handle_type = 2 WHERE task_id = {task_id}"
    task_result = db_tools.ob_execute(CUSTOMER_DATASOURCE, task_sql)
    flow_result = db_tools.ob_execute(CUSTOMER_DATASOURCE, flow_sql)

    parts = []
    for table_name, result in ((task_table, task_result), (flow_table, flow_result)):
        parts.append(f"{table_name} 已更新 {result['rowcount']} 行"
                     if result["ok"] else f"{table_name}: {result['message']}")
    return {
        "cust_order_id": cust_order_id, "task_id": task_id,
        "ok": task_result["ok"] and flow_result["ok"],
        "rowcount": task_result["rowcount"] + flow_result["rowcount"],
        "task": task_result, "flow_ins": flow_result,
        "message": "；".join(parts),
    }


def query_accept_message(db_tools, cust_order_id: str, task_flow_ins_id: str) -> dict[str, Any]:
    """受理报文：HALL_ORDER_BUSI_LOG 最近一条（按 CREATE_DATE 取 MAX），
    请求报文 = HALL_REQ_INFO_A~G、响应报文 = ORDER_RESP_INFO_A~C（SQL 内 NVL 拼接）。
    对齐 Nexus customer_order/accept-message；该日志表不随在途/历史转换表名。"""
    cust_order_id = (cust_order_id or "").strip()
    if not cust_order_id:
        raise ValueError("客户订单ID不能为空")
    task_flow_ins_id = (task_flow_ins_id or "").strip()
    if not task_flow_ins_id:
        raise ValueError("流程实例ID不能为空")

    sql = (
        "SELECT TASK_FLOW_INS_ID, CUST_ORDER_ID, CREATE_DATE, CALL_INTERFACE, "
        "NVL(HALL_REQ_INFO_A,'') || NVL(HALL_REQ_INFO_B,'') || NVL(HALL_REQ_INFO_C,'') || "
        "NVL(HALL_REQ_INFO_D,'') || NVL(HALL_REQ_INFO_E,'') || NVL(HALL_REQ_INFO_F,'') || "
        "NVL(HALL_REQ_INFO_G,'') AS REQ_MESSAGE, "
        "NVL(ORDER_RESP_INFO_A,'') || NVL(ORDER_RESP_INFO_B,'') || NVL(ORDER_RESP_INFO_C,'') AS RESP_MESSAGE "
        "FROM HALL_ORDER_BUSI_LOG "
        f"WHERE CUST_ORDER_ID = '{cust_order_id}' AND TASK_FLOW_INS_ID = '{task_flow_ins_id}' "
        "AND CREATE_DATE = (SELECT MAX(CREATE_DATE) FROM HALL_ORDER_BUSI_LOG "
        f"WHERE CUST_ORDER_ID = '{cust_order_id}' AND TASK_FLOW_INS_ID = '{task_flow_ins_id}')")
    return {"cust_order_id": cust_order_id, "task_flow_ins_id": task_flow_ins_id,
            **_query(db_tools, CUSTOMER_DATASOURCE, sql)}


# ---------- 种子配置 ----------

_SEED_CENTERS: list[dict[str, Any]] = [
    {
        "center_code": FAMILY_ORDER_CENTER,
        "center_name": "家庭订单中心",
        "icon": "home",
        "default_city": "574",
        "in_transit_table_rule": "{table}_{city}",
        "history_table_rule": "{table}_h_{city}_{month}",
        "sort_order": 2,
        "scenes": [
            {
                "scene_code": "order_info", "scene_name": "订单信息", "render_mode": "cascade",
                "nodes": [
                    ("cust_order", "客户订单信息", "ord_cust", "customer_order_id", "", "", "blue"),
                    ("busi_order", "业务订单信息", "ord_busi", "cust_order_id", "cust_order", "customer_order_id", "green"),
                    ("scheduler_order", "调度订单信息", "ord_scheduler", "busi_order_id", "busi_order", "busi_order_id", "orange"),
                    ("work_order", "工单信息", "ord_task", "scheduler_order_id", "scheduler_order", "scheduler_order_id", "red"),
                ],
            },
            {
                "scene_code": "order_attr", "scene_name": "订单属性", "render_mode": "flat",
                "nodes": [
                    ("cust_attr", "客户订单属性", "ord_cust_attr", "cust_order_id", "", "", "blue"),
                    ("busi_attr", "业务订单属性", "ord_busi_attr", "cust_order_id", "", "", "green"),
                ],
            },
            {
                "scene_code": "order_items", "scene_name": "订单项", "render_mode": "flat",
                "nodes": [
                    ("customer", "客户订单项", "ord_customer", "customer_order_id", "", "", "green"),
                    ("user", "用户订单项", "ord_user", "customer_order_id", "", "", "blue"),
                    ("user_ext", "用户扩展订单项", "ord_user_ext", "customer_order_id", "", "", "red"),
                    ("plan", "策划订单项", "ord_offer", "customer_order_id", "", "", "orange"),
                    ("terminal", "设备订单项", "ord_device", "cust_order_id", "", "", "purple"),
                    ("device_rel", "设备策划关系", "ord_device_rel", "cust_order_id", "", "", "amber"),
                    ("contract", "合约订单项", "ord_contract", "cust_order_id", "", "", "cyan"),
                    ("price", "价格计划", "aiorder.ord_price_dtl", "customer_order_id", "", "", "blue"),
                ],
            },
        ],
    },
    {
        # 对齐 Nexus hall_center：在途 {table} 无地市后缀，历史表 HIS_{table}
        "center_code": CUSTOMER_ORDER_CENTER,
        "center_name": "客户订单中心",
        "icon": "shopping-cart",
        "default_city": "574",
        "in_transit_table_rule": "{table}",
        "history_table_rule": "HIS_{table}",
        "sort_order": 1,
        "scenes": [
            {
                "scene_code": "order_info", "scene_name": "订单信息", "render_mode": "cascade",
                "nodes": [
                    ("cust_order", "客户订单信息", "hall_cust", "CUST_ORDER_ID", "", "", "blue"),
                    ("task_order", "工单信息", "hall_task", "CUST_ORDER_ID", "cust_order", "CUST_ORDER_ID", "green"),
                    ("flowins_order", "流程实例信息", "hall_task_flow_ins", "cust_order_id", "cust_order", "cust_order_id", "orange"),
                ],
            },
            # 场景规则（DEF_RULE/DEF_BUSI_CMPT，配置库）不再作为并列场景 tab，
            # 由「配置查询」独立入口 query_scene_rules 提供
        ],
    },
    # —— 与家庭/客户订单中心同级的查询中心（部分场景待接 SQL） ——
    # 实例中心「用户信息」走专用查询 query_instance_user（so570{city}.ins_user_{city}），
    # 不配置级联场景
    {
        "center_code": "instance_center", "center_name": "实例", "icon": "box",
        "default_city": "574",
        "in_transit_table_rule": "{table}_{city}", "history_table_rule": "{table}_h_{city}_{month}",
        "sort_order": 3,
        "scenes": [],
    },
    {
        "center_code": "product_drive_center", "center_name": "家庭业务中心", "icon": "zap",
        "default_city": "574",
        "in_transit_table_rule": "{table}_{city}", "history_table_rule": "{table}_h_{city}_{month}",
        "sort_order": 4,
        "scenes": [],
    },
    {
        "center_code": "product_center", "center_name": "产品", "icon": "package",
        "default_city": "574",
        "in_transit_table_rule": "{table}_{city}", "history_table_rule": "{table}_h_{city}_{month}",
        "sort_order": 5,
        "scenes": [],
    },
    {
        "center_code": "rule_center", "center_name": "规则", "icon": "shield",
        "default_city": "574",
        "in_transit_table_rule": "{table}_{city}", "history_table_rule": "{table}_h_{city}_{month}",
        "sort_order": 6,
        "scenes": [],
    },
]


def _seed_datasource(center_code: str, scene_code: str) -> str:
    if center_code == CUSTOMER_ORDER_CENTER:
        return CUSTOMER_CONFIG_DATASOURCE if scene_code == "scene_rule" else CUSTOMER_DATASOURCE
    return FAMILY_DATASOURCE


def _seed_write_scene(session, center_id: int, scene_def: dict[str, Any],
                      order: int) -> AnalysisScene:
    scene = AnalysisScene(center_id=center_id, scene_code=scene_def["scene_code"],
                          scene_name=scene_def["scene_name"],
                          render_mode=scene_def["render_mode"],
                          sort_order=order, enabled=True)
    session.add(scene)
    session.flush()
    return scene


def _seed_write_nodes(session, scene_def: dict[str, Any], scene: AnalysisScene,
                      datasource: str, start: int = 1) -> None:
    for index, (code, name, table_name, query_field, parent, parent_field, color) \
            in enumerate(scene_def["nodes"], start=start):
        session.add(AnalysisNode(
            scene_id=scene.id, node_code=code, node_name=name, table_name=table_name,
            query_field=query_field, parent_node_code=parent, parent_field=parent_field,
            datasource_name=datasource, color=color, sort_order=index, enabled=True))


def _seed_upgrade_center(session, center_def: dict[str, Any], center: AnalysisCenter) -> None:
    """已建中心的升级同步：中心名/图标随种子配置更新（改名场景），
    并按 scene_code/node_code 查缺补漏新增场景/节点；
    不改动已有场景与节点配置（历史上被移除的场景不会被重新创建）。"""
    changed = False
    if center.center_name != center_def["center_name"] or center.icon != center_def["icon"]:
        center.center_name = center_def["center_name"]
        center.icon = center_def["icon"]
        changed = True
    for order, scene_def in enumerate(center_def["scenes"], start=1):
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == center.id,
            AnalysisScene.scene_code == scene_def["scene_code"]))
        if not scene:
            scene = _seed_write_scene(session, center.id, scene_def, order)
            changed = True
        existing_nodes = list(session.scalars(select(AnalysisNode)
                                              .where(AnalysisNode.scene_id == scene.id)))
        existing_codes = {node.node_code for node in existing_nodes}
        pending = [node_def for node_def in scene_def["nodes"] if node_def[0] not in existing_codes]
        if pending:
            # 新节点排在已有节点之后（sort_order 接续，避免与存量编号冲突）
            offset = max((node.sort_order for node in existing_nodes), default=0)
            _seed_write_nodes(session, {**scene_def, "nodes": pending}, scene,
                              _seed_datasource(center_def["center_code"], scene_def["scene_code"]),
                              start=offset + 1)
            changed = True
    if changed:
        session.commit()


def ensure_analysis_seed(db: Database) -> None:
    """首次启动时写入各业务中心的中心 / 场景 / 节点配置（按中心幂等）。
    已初始化过的库，将旧数据源名（家庭订单B）同步为当前配置的家庭订单库，
    并补齐后续版本新增的场景 / 节点（按 scene_code/node_code 幂等）。"""
    with db.session() as session:
        for center_def in _SEED_CENTERS:
            existing = session.scalar(select(AnalysisCenter).where(
                AnalysisCenter.center_code == center_def["center_code"]))
            if existing:
                scene_ids = list(session.scalars(select(AnalysisScene.id).where(
                    AnalysisScene.center_id == existing.id)))
                if scene_ids:
                    legacy_nodes = list(session.scalars(select(AnalysisNode).where(
                        AnalysisNode.scene_id.in_(scene_ids),
                        AnalysisNode.datasource_name == LEGACY_FAMILY_DATASOURCE)))
                    for node in legacy_nodes:
                        node.datasource_name = FAMILY_DATASOURCE
                    if legacy_nodes:
                        session.commit()
                _seed_upgrade_center(session, center_def, existing)
                continue
            center = AnalysisCenter(
                center_code=center_def["center_code"],
                center_name=center_def["center_name"],
                icon=center_def["icon"],
                default_city=center_def["default_city"],
                in_transit_table_rule=center_def["in_transit_table_rule"],
                history_table_rule=center_def["history_table_rule"],
                sort_order=center_def["sort_order"], enabled=True)
            session.add(center)
            session.flush()
            for order, scene_def in enumerate(center_def["scenes"], start=1):
                scene = _seed_write_scene(session, center.id, scene_def, order)
                _seed_write_nodes(session, scene_def, scene,
                                  _seed_datasource(center_def["center_code"], scene_def["scene_code"]))
            session.commit()
