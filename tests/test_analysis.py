import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from jarvis_agent.analysis import (
    FAMILY_ORDER_CENTER, convert_table_name, ensure_analysis_seed, execute_node_query,
    execute_scene_query, history_table_name, list_centers, query_stage_reply,
    query_workflow, query_wired_message,
)
from jarvis_agent.db import Database


class FakeEmbedding:
    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(item + str(i)) % 2 == 0) else -1.0 for i in range(8)]
                for item in texts]


@pytest.fixture
def db(tmp_path):
    database = Database(str(tmp_path / "analysis.db"))
    ensure_analysis_seed(database)
    return database


class FakeDbTools:
    """按调用顺序返回预置结果的假 DbTools，记录 (数据源, SQL) 便于断言级联过程。
    writes 为 ob_execute（写操作）的预置出队结果，缺省成功更新 1 行。"""

    def __init__(self, results, db=None, writes=None):
        self.results = list(results)
        self.calls = []
        self.db = db
        self.writes = list(writes or [])

    def query(self, name, sql, limit=100, cell_limit=None):
        self.calls.append((name, sql))
        result = self.results.pop(0) if self.results else {}
        rows = result.get("rows", [])
        return {"ok": result.get("ok", True), "columns": result.get("columns", []),
                "rows": rows, "row_count": len(rows),
                "message": result.get("message", "")}

    def ob_execute(self, name, sql):
        self.calls.append((name, sql))
        return self.writes.pop(0) if self.writes else {"ok": True, "rowcount": 1,
                                                       "message": "已更新 1 行"}


def test_history_table_name_rules_match_legacy_platform():
    assert convert_table_name("ord_cust", "574", "") == "ord_cust_574"
    assert convert_table_name("ord_cust", "574", "2026-05") == "ord_cust_h_574_202605"
    assert convert_table_name("vm_wf_order", "574", "2026-05") == "h_vm_wf_order_574_202605"
    assert history_table_name("ord_inter_msg_574_20261014", "2026-05") \
        == "ord_inter_msg_h_574_202605_20261014"


def test_seed_creates_both_centers_and_is_idempotent(db):
    ensure_analysis_seed(db)
    ensure_analysis_seed(db)
    centers = list_centers(db)

    assert [center["center_code"] for center in centers] \
        == ["hall_center", FAMILY_ORDER_CENTER,
            "instance_center", "product_drive_center", "product_center", "rule_center"]
    hall, family = centers[0], centers[1]
    assert family["center_name"] == "家庭订单中心"
    assert [scene["scene_code"] for scene in family["scenes"]] \
        == ["order_info", "order_attr", "order_items"]
    assert hall["center_name"] == "客户订单中心"
    # scene_rule（配置查询）已移入独立入口，不再作为并列场景
    assert [scene["scene_code"] for scene in hall["scenes"]] == ["order_info"]
    # 产品驱动中心已更名 家庭业务中心（升级同步改名后的存量库）
    drive = next(c for c in centers if c["center_code"] == "product_drive_center")
    assert drive["center_name"] == "家庭业务中心"


def test_seed_upgrade_adds_missing_scenes_to_existing_center(db):
    """已建中心补齐新增场景：删掉家庭中心的订单属性场景后重跑种子，应幂等补回。"""
    from jarvis_agent.db import AnalysisCenter, AnalysisNode, AnalysisScene

    def _family_scenes():
        with db.session() as session:
            center = session.scalar(select(AnalysisCenter).where(
                AnalysisCenter.center_code == FAMILY_ORDER_CENTER))
            return sorted(scene.scene_code for scene in session.scalars(
                select(AnalysisScene).where(AnalysisScene.center_id == center.id)))

    ensure_analysis_seed(db)
    assert _family_scenes() == ["order_attr", "order_info", "order_items"]

    with db.session() as session:
        center = session.scalar(select(AnalysisCenter).where(
            AnalysisCenter.center_code == FAMILY_ORDER_CENTER))
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == center.id, AnalysisScene.scene_code == "order_attr"))
        session.query(AnalysisNode).filter(AnalysisNode.scene_id == scene.id) \
            .delete(synchronize_session=False)
        session.delete(scene)
        session.commit()

    ensure_analysis_seed(db)
    assert _family_scenes() == ["order_attr", "order_info", "order_items"]

    # 幂等：重复跑不重复建
    ensure_analysis_seed(db)
    assert _family_scenes() == ["order_attr", "order_info", "order_items"]


def test_seed_upgrade_appends_new_node_after_existing(db):
    """节点级补齐：新增节点 sort_order 接续存量最大值（排在已有节点之后）。"""
    from jarvis_agent.db import AnalysisCenter, AnalysisNode, AnalysisScene

    ensure_analysis_seed(db)
    with db.session() as session:
        center = session.scalar(select(AnalysisCenter).where(
            AnalysisCenter.center_code == FAMILY_ORDER_CENTER))
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == center.id, AnalysisScene.scene_code == "order_items"))
        session.query(AnalysisNode).filter(AnalysisNode.scene_id == scene.id,
                                           AnalysisNode.node_code == "price") \
            .delete(synchronize_session=False)
        session.commit()

    ensure_analysis_seed(db)  # 升级补齐 price 节点
    with db.session() as session:
        center = session.scalar(select(AnalysisCenter).where(
            AnalysisCenter.center_code == FAMILY_ORDER_CENTER))
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == center.id, AnalysisScene.scene_code == "order_items"))
        nodes = list(session.scalars(select(AnalysisNode).where(
            AnalysisNode.scene_id == scene.id).order_by(AnalysisNode.sort_order)))
    assert [node.node_code for node in nodes][-1] == "price"
    assert nodes[-1].sort_order == 8


def test_seed_upgrade_renames_existing_center(db):
    """存量库中心改名：seed 配置改名后重跑种子，已建中心名/图标同步更新。"""
    from jarvis_agent.db import AnalysisCenter

    ensure_analysis_seed(db)
    with db.session() as session:
        row = session.scalar(select(AnalysisCenter).where(
            AnalysisCenter.center_code == "product_drive_center"))
        row.center_name = "产品驱动"  # 模拟旧版本建的库
        session.commit()

    ensure_analysis_seed(db)
    with db.session() as session:
        row = session.scalar(select(AnalysisCenter).where(
            AnalysisCenter.center_code == "product_drive_center"))
    assert row.center_name == "家庭业务中心"


def test_seed_migrates_legacy_datasource_name(db):
    """已用旧名（家庭订单B）初始化过的库，重启后自动同步为家庭订单库。"""
    from jarvis_agent.db import AnalysisCenter, AnalysisNode, AnalysisScene

    family_id = None
    with db.session() as session:
        family_id = session.scalar(select(AnalysisCenter.id).where(
            AnalysisCenter.center_code == FAMILY_ORDER_CENTER))
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == family_id, AnalysisScene.scene_code == "order_info"))
        for node in session.scalars(select(AnalysisNode).where(AnalysisNode.scene_id == scene.id)):
            node.datasource_name = "家庭订单B"
        session.commit()

    ensure_analysis_seed(db)

    with db.session() as session:
        scene = session.scalar(select(AnalysisScene).where(
            AnalysisScene.center_id == family_id, AnalysisScene.scene_code == "order_info"))
        names = [node.datasource_name for node in session.scalars(
            select(AnalysisNode).where(AnalysisNode.scene_id == scene.id))]
    assert set(names) == {"家庭订单库"}


def test_customer_order_scene_uses_center_table_rules(db):
    """客户订单中心：在途 {table} 无地市后缀、历史 HIS_{table}；OceanBase 客户订单库"""
    tools = FakeDbTools([
        {"columns": ["CUST_ORDER_ID"], "rows": [["57400263717505"]]},   # hall_cust 根
        {"columns": ["CUST_ORDER_ID"], "rows": [["57400263717505"]]},   # hall_task 子
        {"columns": ["cust_order_id"], "rows": [["57400263717505"]]},   # hall_task_flow_ins 子
    ])
    result = execute_scene_query(db, tools, "hall_center", "order_info",
                                 "57400263717505", "574", True, "")

    sqls = [sql for _, sql in tools.calls]
    assert sqls[0] == "SELECT * FROM hall_cust WHERE CUST_ORDER_ID = '57400263717505'"
    assert sqls[1] == "SELECT * FROM hall_task WHERE CUST_ORDER_ID IN ('57400263717505')"
    assert sqls[2] == "SELECT * FROM hall_task_flow_ins WHERE cust_order_id IN ('57400263717505')"
    assert all(name == "客户订单库" for name, _ in tools.calls)
    assert [node["node_code"] for node in result["nodes"]] \
        == ["cust_order", "task_order", "flowins_order"]

    tools_history = FakeDbTools([
        {"columns": ["rule_id"], "rows": [["1001"]]},
        {"columns": ["scene_id"], "rows": [["2001"]]},
    ])
    from jarvis_agent.analysis import query_scene_rules
    rules = query_scene_rules(tools_history, "2001")
    assert tools_history.calls[0][1] == "SELECT * FROM DEF_RULE WHERE SCENE_ID = '2001'"
    assert tools_history.calls[0][0] == "客户订单配置库"
    assert rules["rule"]["node_name"] == "规则定义"
    # 配置查询同时查 场景单元关系（HALLCFG.SCENE_UNIT_REL）
    assert tools_history.calls[1][1] == \
        "SELECT * FROM HALLCFG.SCENE_UNIT_REL WHERE SCENE_ID = '2001'"
    assert tools_history.calls[1][0] == "客户订单配置库"
    assert rules["unit_rel"]["node_name"] == "场景单元关系"


def test_scene_query_cascades_by_parent_field(db):
    tools = FakeDbTools([
        {"columns": ["customer_order_id", "cust_order_id"], "rows": [["57400263", "57400263"]]},
        {"columns": ["busi_order_id", "cust_order_id"], "rows": [["8001", "57400263"], ["8002", "57400263"]]},
        {"columns": ["scheduler_order_id", "busi_order_id"], "rows": [["9001", "8001"]]},
        {"columns": ["task_id", "scheduler_order_id"], "rows": [["7001", "9001"]]},
    ])

    result = execute_scene_query(db, tools, FAMILY_ORDER_CENTER, "order_info",
                                 "57400263", "574", True, "")

    assert [node["node_code"] for node in result["nodes"]] \
        == ["cust_order", "busi_order", "scheduler_order", "work_order"]
    sqls = [sql for _, sql in tools.calls]
    assert sqls[0] == "SELECT * FROM ord_cust_574 WHERE customer_order_id = '57400263'"
    assert sqls[1] == "SELECT * FROM ord_busi_574 WHERE cust_order_id IN ('57400263')"
    assert sqls[2] == "SELECT * FROM ord_scheduler_574 WHERE busi_order_id IN ('8001', '8002')"
    assert sqls[3] == "SELECT * FROM ord_task_574 WHERE scheduler_order_id IN ('9001')"
    assert all(name == "家庭订单库" for name, _ in tools.calls)
    assert result["nodes"][3]["row_count"] == 1


def test_scene_query_history_month_and_flat_scene(db):
    tools = FakeDbTools([
        {"columns": ["cust_order_id"], "rows": [["57400263"]]},
        {"columns": ["cust_order_id"], "rows": [["57400263"]]},
    ])
    result = execute_scene_query(db, tools, FAMILY_ORDER_CENTER, "order_attr",
                                 "57400263", "574", False, "2026-05")
    assert "ord_cust_attr_h_574_202605" in tools.calls[0][1]
    assert "ord_busi_attr_h_574_202605" in tools.calls[1][1]
    assert [node["node_code"] for node in result["nodes"]] == ["cust_attr", "busi_attr"]


def test_order_items_includes_price_plan_node(db):
    """订单项场景含 价格计划 节点（aiorder.ord_price_dtl 按客户订单号，走通用级联引擎）。"""
    tools = FakeDbTools([{"columns": ["customer_order_id"], "rows": [["57400263680820"]]}] * 8)
    result = execute_scene_query(db, tools, FAMILY_ORDER_CENTER, "order_items",
                                 "57400263680820", "574", True, "")
    price = next(node for node in result["nodes"] if node["node_code"] == "price")
    assert price["node_name"] == "价格计划"
    assert price["table_name"] == "aiorder.ord_price_dtl_574"
    assert price["sql"] == ("SELECT * FROM aiorder.ord_price_dtl_574 "
                            "WHERE customer_order_id = '57400263680820'")
    assert all(name == "家庭订单库" for name, _ in tools.calls)


def test_scene_query_empty_parent_skips_children(db):
    tools = FakeDbTools([
        {"columns": ["customer_order_id"], "rows": []},  # 客户订单为空 → 子级全部跳过
    ])
    result = execute_scene_query(db, tools, FAMILY_ORDER_CENTER, "order_info",
                                 "1", "574", True, "")
    assert len(tools.calls) == 1
    assert [node["row_count"] for node in result["nodes"]] == [0, 0, 0, 0]
    assert result["nodes"][1]["success"] is True


def test_scene_query_rejects_non_numeric_key(db):
    with pytest.raises(ValueError, match="业务主键"):
        execute_scene_query(db, FakeDbTools([]), FAMILY_ORDER_CENTER, "order_info",
                            "abc", "574", True, "")


def test_node_query_runs_single_node_in_real_time(db):
    tools = FakeDbTools([
        {"columns": ["task_id"], "rows": [["7001"]]},
    ])
    result = execute_node_query(db, tools, FAMILY_ORDER_CENTER, "order_info",
                                "work_order", "9001", "574", True, "")
    assert tools.calls[0][1] == "SELECT * FROM ord_task_574 WHERE scheduler_order_id = '9001'"
    assert result["row_count"] == 1


def test_workflow_query_cascades_rboss_chain(db):
    tools = FakeDbTools([
        {"columns": ["workflow_id"], "rows": [["wf-1"]]},         # 主工作流
        {"columns": ["workflow_id"], "rows": [["wf-1"]]},         # 调度订单工作流
        {"columns": ["workflow_id"], "rows": [["rb-1"]]},         # RBoss 工作流
        {"columns": ["workflow_id"], "rows": [["rb-1"]]},         # RBoss 调度
        {"columns": ["task_id"], "rows": [["t-1"]]},              # RBoss 任务
    ])
    result = query_workflow(tools, "57400263", "9001,9002", "574", True, "")

    assert all(name == "工作流订单库" for name, _ in tools.calls)
    assert "vm_wf_order_574" in tools.calls[0][1]
    assert "workflow_id IN ('wf-1')" in tools.calls[1][1]
    assert "workflow_object_id IN ('9001', '9002')" in tools.calls[2][1]
    assert [block["name"] for block in result["results"]] \
        == ["工作流订单", "调度订单工作流", "RBoss工作流", "RBoss调度", "RBoss任务"]
    # 无调度单时 RBoss 链为空结果
    tools2 = FakeDbTools([
        {"columns": ["workflow_id"], "rows": [["wf-1"]]},
        {"columns": ["workflow_id"], "rows": [["wf-1"]]},
    ])
    result2 = query_workflow(tools2, "57400263", "", "574", True, "")
    assert len(tools2.calls) == 2
    assert result2["results"][2]["row_count"] == 0


def test_wired_message_validates_type_and_builds_daily_table():
    tools = FakeDbTools([{"columns": ["msg_id"], "rows": [["m1"]]}])
    result = query_wired_message(tools, "7001", "20261014", "SEND_TO_IMEP", "574", True, "")
    assert "ord_inter_msg_574_20261014" in tools.calls[0][1]
    assert "receive_object_type = 'SEND_TO_IMEP'" in tools.calls[0][1]
    assert "receive_object_value = '7001'" in tools.calls[0][1]
    assert result["row_count"] == 1

    # 日报表按天分表：历史模式表名不变（不加 h 月份前缀）
    tools_hist = FakeDbTools([{"columns": ["msg_id"], "rows": [["m1"]]}])
    query_wired_message(tools_hist, "7001", "20260114", "SEND_TO_IMEP", "574", False, "2026-01")
    assert tools_hist.calls[0][1].startswith(
        "SELECT * FROM ord_inter_msg_574_20260114 WHERE")
    assert "_h_" not in tools_hist.calls[0][1]

    with pytest.raises(ValueError, match="报文类型"):
        query_wired_message(tools, "7001", "", "DROP_TABLE", "574", True, "")


def test_billing_message_daily_table_name_unchanged_in_history_mode():
    from jarvis_agent.analysis import query_billing_message

    tools = FakeDbTools([{"columns": ["serial_id"], "rows": [["s1"]]}])
    query_billing_message(tools, "57400263", "9001", "20260114", "574", False, "2026-01")
    assert tools.calls[0][1].startswith(
        "SELECT * FROM ord_message_log_574_20260114 WHERE")
    assert "_h_" not in tools.calls[0][1]
    assert "msg_topic = 'OrdOuterOrder2Billing'" in tools.calls[0][1]


def test_stage_reply_queries_aiorder_schema():
    tools = FakeDbTools([{"columns": ["task_id"], "rows": [["7001"]]}])
    query_stage_reply(tools, "7001", "574", False, "2026-05")
    assert "aiorder.ORD_TASK_dealinfo_h_574_202605" in tools.calls[0][1]
    assert "task_id = '7001'" in tools.calls[0][1]


def _month_offset(months_back: int) -> str:
    from datetime import datetime
    from jarvis_agent.analysis import _recent_months
    return _recent_months(months_back + 1)[-1]


def test_async_flow_transit_hit_skips_history():
    from jarvis_agent.analysis import ASYNC_FLOW_HISTORY_SCAN_MONTHS, query_async_flow

    tools = FakeDbTools([{"columns": ["cust_order_id"], "rows": [["57400263"]]}])
    result = query_async_flow(tools, "57400263", "574", True, "")
    assert len(tools.calls) == 1
    assert "ord_async_method_deal_task_order_574" in tools.calls[0][1]
    assert result["from_history"] is False
    assert result["row_count"] == 1
    assert result["checked_tables"] == ["ord_async_method_deal_task_order_574"]
    assert ASYNC_FLOW_HISTORY_SCAN_MONTHS == 3


def test_async_flow_falls_back_to_history_tables():
    from jarvis_agent.analysis import query_async_flow

    # 在途空、当月历史空 → 上月历史命中
    tools = FakeDbTools([
        {"columns": ["cust_order_id"], "rows": []},
        {"columns": ["cust_order_id"], "rows": []},
        {"columns": ["cust_order_id"], "rows": [["57400263"]]},
    ])
    result = query_async_flow(tools, "57400263", "574", True, "")
    assert len(tools.calls) == 3
    assert f"ord_async_method_deal_task_order_h_574_{_month_offset(1)}" in tools.calls[2][1]
    assert result["from_history"] is True
    assert result["history_fallback"] is True
    assert result["row_count"] == 1
    assert result["table_name"] == f"ord_async_method_deal_task_order_h_574_{_month_offset(1)}"
    assert len(result["checked_tables"]) == 3


def test_async_flow_all_empty_reports_checked_tables():
    from jarvis_agent.analysis import ASYNC_FLOW_HISTORY_SCAN_MONTHS, query_async_flow

    tools = FakeDbTools([{"columns": ["cust_order_id"], "rows": []}] * 4)
    result = query_async_flow(tools, "57400263", "574", True, "")
    assert len(tools.calls) == 1 + ASYNC_FLOW_HISTORY_SCAN_MONTHS
    assert result["success"] is True
    assert result["row_count"] == 0
    assert result["from_history"] is False
    assert result["checked_tables"][0] == "ord_async_method_deal_task_order_574"
    assert result["checked_tables"][1] == \
        f"ord_async_method_deal_task_order_h_574_{_month_offset(0)}"


def test_async_flow_transit_query_error_skips_history_scan():
    """在途查询失败（如数据源需 VPN 未连通）直接返回错误，不连环扫历史表。"""
    from jarvis_agent.analysis import query_async_flow

    tools = FakeDbTools([{"ok": False, "message": "查询失败: can't connect", "rows": []}])
    result = query_async_flow(tools, "57400263", "574", True, "")
    assert len(tools.calls) == 1
    assert result["success"] is False
    assert "查询失败" in result["error"]
    assert result["checked_tables"] == ["ord_async_method_deal_task_order_574"]


def test_async_flow_history_mode_defaults_to_current_month():
    """历史模式未指定月份 → 默认查当月历史表，而非在途表。"""
    from datetime import datetime

    from jarvis_agent.analysis import query_async_flow

    tools = FakeDbTools([{"columns": ["cust_order_id"], "rows": [["57400263"]]}])
    result = query_async_flow(tools, "57400263", "574", False, "")
    assert len(tools.calls) == 1
    current = datetime.now().strftime("%Y%m")
    assert f"ord_async_method_deal_task_order_h_574_{current}" in tools.calls[0][1]
    assert result["from_history"] is True
    assert result["table_name"] == f"ord_async_method_deal_task_order_h_574_{current}"


def test_async_flow_explicit_history_month_queries_only_that_month():
    from jarvis_agent.analysis import query_async_flow

    tools = FakeDbTools([{"columns": ["cust_order_id"], "rows": [["57400263"]]}])
    result = query_async_flow(tools, "57400263", "574", False, "2026-05")
    assert len(tools.calls) == 1
    assert "ord_async_method_deal_task_order_h_574_202605" in tools.calls[0][1]
    assert result["from_history"] is True
    assert result["history_fallback"] is False
    assert result["checked_tables"] == ["ord_async_method_deal_task_order_h_574_202605"]


def test_product_config_validates_offer_type_then_queries():
    """档次配置：先查 up_offer 校验 offer_type=OFFER_VAS_BIND（是档次才继续），
    再查 up_product_item + up_item_feature(del_flag=1) + up_plan_plan_rel（产品库）。"""
    from jarvis_agent.analysis import query_product_config

    tools = FakeDbTools([
        {"columns": ["offer_id", "offer_type"], "rows": [["610007603200", "OFFER_VAS_BIND"]]},
        {"columns": ["product_item_id"], "rows": [["610007603200"]]},
        {"columns": ["feature_id"], "rows": [["f1"]]},
        {"columns": ["item_relat_id"], "rows": [["r1"]]},
        {"columns": ["item_relat_id"], "rows": [["role1"]]},
        {"columns": ["item_relat_id", "relat_product_item_id"], "rows": [["biz1", "500000020103"]]},
        {"columns": ["business_id"], "rows": [["500000020103"]]},
    ])
    result = query_product_config(tools, "610007603200")
    assert tools.calls[0] == ("产品库",
        "SELECT * FROM product.up_offer WHERE offer_id = 610007603200")
    assert tools.calls[1] == ("产品库",
        "SELECT * FROM product.up_product_item WHERE product_item_id = 610007603200")
    assert tools.calls[2] == ("产品库",
        "SELECT * FROM product.up_item_feature "
        "WHERE product_item_id = 610007603200 AND del_flag = '1'")
    assert tools.calls[3][0] == "产品库"
    assert "FROM product.up_plan_plan_rel a" in tools.calls[3][1]
    assert "OFFER_PLAN_INCLUDE_OFFER_PLAN" in tools.calls[3][1]
    assert tools.calls[4][0] == "产品库"
    assert "FROM product.up_item_relat a" in tools.calls[4][1]
    assert "OFFER_PLAN_GENERAL_SPEC_ROLE" in tools.calls[4][1]
    assert tools.calls[4][1].startswith("SELECT a.item_relat_id,")
    assert tools.calls[5][0] == "产品库"
    assert "FROM product.up_item_relat a" in tools.calls[5][1]
    assert "OFFER_PLAN_GENERAL_BUSINESS" in tools.calls[5][1]
    # 业务信息不再自动级联，改为点击 relat_product_item_id 弹窗查询（query_business_info）
    assert len(tools.calls) == 6
    assert [block["name"] for block in result["results"]] \
        == ["档次信息", "档次配置", "产品特性", "产品关系", "角色信息", "业务关系"]
    assert [block["row_count"] for block in result["results"]] == [1, 1, 1, 1, 1, 1]



def test_product_config_rejects_non_vas_bind_offer():
    """非档次（offer_type 非 OFFER_VAS_BIND 或无记录）：抛错，不查后续表。"""
    from jarvis_agent.analysis import query_product_config

    # offer_type 不符
    tools = FakeDbTools([
        {"columns": ["offer_id", "offer_type"], "rows": [["610000068502", "OFFER_PLAN"]]},
    ])
    with pytest.raises(ValueError, match="不是档次.*OFFER_VAS_BIND"):
        query_product_config(tools, "610000068502")
    assert len(tools.calls) == 1  # 未查后续表

    # up_offer 无记录
    tools_missing = FakeDbTools([
        {"columns": ["offer_id", "offer_type"], "rows": []},
    ])
    with pytest.raises(ValueError, match="无记录，不是档次"):
        query_product_config(tools_missing, "610000068502")

    with pytest.raises(ValueError, match="档次编号"):
        query_product_config(FakeDbTools([]), "abc")


def test_up_rule_queries_by_rule_id():
    """框架规则定义：busicfg.UP_RULE 按规则ID查（家庭业务配置库；框架规则点击弹窗）。"""
    from jarvis_agent.analysis import query_up_rule

    tools = FakeDbTools([{"columns": ["RULE_ID"], "rows": [["396"]]}])
    result = query_up_rule(tools, "396")
    assert tools.calls[0] == ("家庭业务配置库",
        "SELECT * FROM busicfg.UP_RULE WHERE RULE_ID = 396")
    assert result["row_count"] == 1
    assert result["table_name"] == "busicfg.UP_RULE"

    with pytest.raises(ValueError, match="规则ID"):
        query_up_rule(FakeDbTools([]), "abc'; drop")


def test_business_info_queries_by_business_id():
    """业务信息：product.up_business 按业务ID查（产品库；业务关系点击弹窗）。"""
    from jarvis_agent.analysis import query_business_info

    tools = FakeDbTools([{"columns": ["business_id"], "rows": [["500000020103"]]}])
    result = query_business_info(tools, "500000020103")
    assert tools.calls[0] == ("产品库",
        "SELECT * FROM product.up_business WHERE business_id = 500000020103")
    assert result["row_count"] == 1
    assert result["table_name"] == "product.up_business"

    with pytest.raises(ValueError, match="业务ID"):
        query_business_info(FakeDbTools([]), "abc'; drop")


def test_plan_config_queries_item_feature_pre_limit_and_relat():
    """策划配置：up_product_item + up_item_feature(有效) + up_plan_prod_rel(策划包含单产品)
    + UP_OFFER_PRE_LIMIT(OFFER_ID) + 业务关系 + 业务信息级联。"""
    from jarvis_agent.analysis import query_plan_config

    tools = FakeDbTools([
        {"columns": ["product_item_id"], "rows": [["610000068502"]]},
        {"columns": ["feature_id"], "rows": [["f1"]]},
        {"columns": ["relat_id"], "rows": [["r1"]]},
        {"columns": ["offer_id"], "rows": [["610000068502"]]},
        {"columns": ["item_relat_id", "relat_product_item_id"], "rows": [["biz1", "500000020103"]]},
        {"columns": ["business_id"], "rows": [["500000020103"]]},
    ])
    result = query_plan_config(tools, "610000068502")
    assert tools.calls[0] == ("产品库",
        "SELECT * FROM product.up_product_item WHERE product_item_id = 610000068502")
    assert tools.calls[1] == ("产品库",
        "SELECT * FROM product.up_item_feature "
        "WHERE product_item_id = 610000068502 AND del_flag = '1'")
    assert tools.calls[2] == ("产品库",
        "SELECT a.* FROM product.up_plan_prod_rel a "
        "WHERE a.product_item_id = 610000068502 "
        "AND a.prod_item_relat_kind_id = 'OFFER_PLAN_INCLUDE_SRVC_SINGLE' "
        "AND a.del_flag = '1' ORDER BY a.sort_by")
    assert tools.calls[3] == ("产品库",
        "SELECT * FROM product.UP_OFFER_PRE_LIMIT "
        "WHERE OFFER_ID = 610000068502 AND DEL_FLAG = '1'")
    assert tools.calls[4][0] == "产品库"
    assert "OFFER_PLAN_GENERAL_BUSINESS" in tools.calls[4][1]
    assert len(tools.calls) == 5
    assert [block["name"] for block in result["results"]] \
        == ["档次配置", "产品特性", "关联产品", "前项限制", "业务关系"]

    with pytest.raises(ValueError, match="产品编号"):
        query_plan_config(FakeDbTools([]), "abc")


def test_item_relat_queries_price_service_relation():
    """属性信息：product.up_item_relat 按产品编号 + SRVC_SINGLE_PRICE_SERVICE + 有效记录。"""
    from jarvis_agent.analysis import query_item_relat

    tools = FakeDbTools([{"columns": ["relat_id"], "rows": [["r1"]]}])
    result = query_item_relat(tools, "610007601256")
    assert tools.calls[0] == ("产品库",
        "SELECT * FROM product.up_item_relat "
        "WHERE product_item_id = 610007601256 "
        "AND prod_item_relat_kind_id = 'SRVC_SINGLE_PRICE_SERVICE' "
        "AND del_flag = '1'")
    assert [block["name"] for block in result["results"]] == ["属性信息"]
    assert result["product_item_id"] == "610007601256"

    with pytest.raises(ValueError, match="产品编号"):
        query_item_relat(FakeDbTools([]), "abc")


def test_pre_lmt_param_queries_by_limit_code_and_param_id():
    """限制参数：UP_PRE_LMT_PARAM 按 limit_code + param_id 查（rule_exp 拆分下钻）。"""
    from jarvis_agent.analysis import query_pre_lmt_param

    tools = FakeDbTools([{"columns": ["param_id"], "rows": [["300937"]]}])
    result = query_pre_lmt_param(tools, "TP1", "300937")
    assert tools.calls[0] == ("产品库",
        "SELECT * FROM product.UP_PRE_LMT_PARAM "
        "WHERE limit_code = 'TP1' AND param_id = 300937")
    assert [block["name"] for block in result["results"]] == ["限制参数"]
    assert result["limit_code"] == "TP1"
    assert result["param_id"] == "300937"

    with pytest.raises(ValueError, match="limit_code"):
        query_pre_lmt_param(FakeDbTools([]), "TP 1'; drop", "300937")
    with pytest.raises(ValueError, match="param_id"):
        query_pre_lmt_param(FakeDbTools([]), "TP1", "abc")


def test_so_pre_busi_limit_queries_rule_config():
    """业务限制：rule_Cfg.SO_PRE_BUSI_LIMIT 按 LIMIT_CODE 查（规则配置库）。"""
    from jarvis_agent.analysis import query_so_pre_busi_limit

    tools = FakeDbTools([{"columns": ["limit_code"], "rows": [["TP1"]]}])
    result = query_so_pre_busi_limit(tools, "TP1")
    assert tools.calls[0] == ("规则配置库",
        "SELECT * FROM rule_Cfg.SO_PRE_BUSI_LIMIT WHERE LIMIT_CODE = 'TP1'")
    assert result["row_count"] == 1
    assert result["table_name"] == "rule_Cfg.SO_PRE_BUSI_LIMIT"

    with pytest.raises(ValueError, match="LIMIT_CODE"):
        query_so_pre_busi_limit(FakeDbTools([]), "TP'; drop")


def test_instance_user_cascades_customer_info():
    """用户信息（实例中心）：ins_user 按计费账号查（营业库）；cust_type=1 的行级联查
    个人客户（indiv_cust_id=cust_id），family_cust_id 非空级联查家庭客户。"""
    from jarvis_agent.analysis import query_instance_user

    tools = FakeDbTools([
        {"columns": ["bill_id", "cust_id", "cust_type", "family_cust_id"],
         "rows": [["nbcxa06600382", "74330007813658", "1", "94331000146022"]]},
        {"columns": ["indiv_cust_id"], "rows": [["74330007813658"]]},
        {"columns": ["family_cust_id"], "rows": [["94331000146022"]]},
    ])
    result = query_instance_user(tools, "nbcxa06600382")
    assert tools.calls[0] == ("营业库",
        "SELECT * FROM so570574.ins_user_574 WHERE bill_id = 'nbcxa06600382'")
    assert tools.calls[1] == ("营业库",
        "SELECT * FROM so570574.cm_indiv_customer_574 "
        "WHERE indiv_cust_id IN (74330007813658)")
    assert tools.calls[2] == ("营业库",
        "SELECT * FROM so570574.cm_family_customer_574 "
        "WHERE family_cust_id IN (94331000146022)")
    assert [block["name"] for block in result["results"]] \
        == ["用户信息", "个人客户信息", "家庭客户信息"]

    # cust_type≠1 不查个人客户；family_cust_id 为空不查家庭客户
    tools_solo = FakeDbTools([
        {"columns": ["bill_id", "cust_id", "cust_type", "family_cust_id"],
         "rows": [["nbcxa06600382", "74330007813658", "2", ""]]},
    ])
    result_solo = query_instance_user(tools_solo, "nbcxa06600382")
    assert len(tools_solo.calls) == 1
    assert [block["name"] for block in result_solo["results"]] == ["用户信息"]

    with pytest.raises(ValueError, match="计费账号"):
        query_instance_user(FakeDbTools([]), "abc'; drop")


def test_instance_order_cascades_from_user_id():
    """订购信息（实例中心）：先按计费账号查 ins_user 取 user_id，再按 user_id 查订购表。"""
    from jarvis_agent.analysis import query_instance_order

    tools = FakeDbTools([
        {"columns": ["bill_id", "user_id"], "rows": [["nbcxa06600382", "9001"],
                                                     ["nbcxa06600382", "9002"]]},
        {"columns": ["order_id"], "rows": [["o1"]]},
    ])
    result = query_instance_order(tools, "nbcxa06600382")
    assert tools.calls[0] == ("营业库",
        "SELECT * FROM so570574.ins_user_574 WHERE bill_id = 'nbcxa06600382'")
    assert tools.calls[1] == ("营业库",
        "SELECT * FROM so570574.ins_offer_574 WHERE user_id IN (9001, 9002)")
    assert [block["name"] for block in result["results"]] == ["订购信息"]

    # 无用户信息：不查订购表，返回明确错误提示
    tools_empty = FakeDbTools([
        {"columns": ["bill_id", "user_id"], "rows": [["nbcxa06600382", ""]]},
    ])
    result_empty = query_instance_order(tools_empty, "nbcxa06600382")
    assert len(tools_empty.calls) == 1
    assert result_empty["results"][0]["success"] is False
    assert "user_id" in result_empty["results"][0]["error"]

    with pytest.raises(ValueError, match="计费账号"):
        query_instance_order(FakeDbTools([]), "abc'; drop")


def test_static_config_queries_para_and_static_data():
    """静态配置（家庭订单·配置查询）：bs_para_detail(para_type) + bs_static_data(code_type)。"""
    from jarvis_agent.analysis import query_static_config

    tools = FakeDbTools([
        {"columns": ["para_type"], "rows": [["SMART_HOME_SERVICE_TYPE"]]},
        {"columns": ["code_type"], "rows": [["YDKJ_INSTALL_SERVICE_ID"]]},
    ])
    result = query_static_config(tools, "SMART_HOME_SERVICE_TYPE")
    assert tools.calls[0] == ("家庭订单配置库",
        "SELECT * FROM bs_para_detail WHERE para_type = 'SMART_HOME_SERVICE_TYPE'")
    assert tools.calls[1] == ("家庭订单配置库",
        "SELECT * FROM bs_static_data WHERE code_type = 'SMART_HOME_SERVICE_TYPE'")
    assert [block["name"] for block in result["results"]] == ["参数明细", "静态数据"]

    with pytest.raises(ValueError, match="配置编码"):
        query_static_config(FakeDbTools([]), "a'; drop")


def test_product_drive_pending_real_sql():
    """产品驱动（家庭业务中心）：四类（角色/策划/产品/终端）均为待接入占位。"""
    from jarvis_agent.analysis import query_product_drive

    for category, label in (("role", "角色"), ("product", "产品"), ("terminal", "终端")):
        with pytest.raises(ValueError, match=f"产品驱动·{label} 查询待接入"):
            query_product_drive(FakeDbTools([]), "610007603200", "610007603200", category)
    with pytest.raises(ValueError, match="未知产品驱动分类"):
        query_product_drive(FakeDbTools([]), "610007603200", "610007603200", "other")
    # 入参校验按分类：role 只需档次编号；策划/产品/终端 两者都必填
    with pytest.raises(ValueError, match="请输入策划编号"):
        query_product_drive(FakeDbTools([]), "610007603200", "", "product")
    with pytest.raises(ValueError, match="请输入档次编号"):
        query_product_drive(FakeDbTools([]), "", "610007603200", "plan")
    with pytest.raises(ValueError, match="档次编号格式错误"):
        query_product_drive(FakeDbTools([]), "a'; drop", "", "role")


def test_product_drive_plan_shows_frame_tables():
    """产品驱动·策划：up_offer/up_item_relat 仅后台取数（offer_type/business_id，不展示），
    展示三张框架卡 框架匹配/框架属性/框架规则（家庭业务配置库）。"""
    from jarvis_agent.analysis import query_product_drive

    tools = FakeDbTools([
        {"columns": ["offer_id", "offer_type"], "rows": [["610007603200", "OFFER_VAS_OTHER"]]},
        {"columns": ["item_relat_id", "relat_product_item_id"], "rows": [["b1", "500000020103"]]},
        {"columns": ["frame_id"], "rows": [["1075"]]},
        {"columns": ["frame_id", "ATTR_ID"], "rows": [["1075", "990000000006"]]},
        {"columns": ["rule_id"], "rows": [["r1"]]},
    ])
    result = query_product_drive(tools, "610007603200", "610007603200", "plan")
    # 后台取数：up_offer（拿 offer_type）+ 业务关系（拿 business_id）
    assert tools.calls[0] == ("产品库",
        "SELECT * FROM product.up_offer WHERE offer_id = 610007603200")
    assert tools.calls[1][0] == "产品库"
    assert "product_item_id = 610007603200" in tools.calls[1][1]
    assert "OFFER_PLAN_GENERAL_BUSINESS" in tools.calls[1][1]
    # 展示三张框架卡
    assert tools.calls[2] == ("家庭业务配置库",
        "SELECT * FROM busicfg.UP_FRAME "
        "WHERE frame_level = 'OFFER' AND offer_type = 'OFFER_VAS_OTHER' "
        "AND business_id IN (500000020103)")
    assert tools.calls[3] == ("家庭业务配置库",
        "SELECT * FROM busicfg.UP_FRAME_ATTR WHERE frame_id IN (1075)")
    assert tools.calls[4] == ("家庭业务配置库",
        "SELECT * FROM busicfg.UP_FRAME_RULE "
        "WHERE frame_id = 1075 AND ATTR_ID = 990000000006")
    assert [block["name"] for block in result["results"]] \
        == ["框架匹配", "框架属性", "框架规则"]
    assert all(block["datasource"] == "家庭业务配置库" for block in result["results"])
    assert [block["row_count"] for block in result["results"]] == [1, 1, 1]


def test_product_drive_plan_no_business_relation_fails():
    """无业务关系：框架匹配卡报明确错误，后续框架表不查询。"""
    from jarvis_agent.analysis import query_product_drive

    tools = FakeDbTools([
        {"columns": ["offer_id", "offer_type"], "rows": [["610007603200", "OFFER_VAS_OTHER"]]},
        {"columns": ["item_relat_id", "relat_product_item_id"], "rows": []},
    ])
    result = query_product_drive(tools, "610007603200", "610007603200", "plan")
    assert len(tools.calls) == 2  # 未发起 UP_FRAME 查询
    assert len(result["results"]) == 1
    assert result["results"][0]["name"] == "框架匹配"
    assert result["results"][0]["success"] is False
    assert "未查到业务关系" in result["results"][0]["error"]


def test_product_drive_plan_frame_not_matched_skips_attrs():
    """框架未匹配到：无 框架属性/框架规则 卡。"""
    from jarvis_agent.analysis import query_product_drive

    tools = FakeDbTools([
        {"columns": ["offer_id", "offer_type"], "rows": [["610007603200", "OFFER_VAS_OTHER"]]},
        {"columns": ["item_relat_id", "relat_product_item_id"], "rows": [["b1", "500000020103"]]},
        {"columns": ["frame_id"], "rows": []},
    ])
    result = query_product_drive(tools, "610007603200", "610007603200", "plan")
    assert len(tools.calls) == 3
    assert [block["name"] for block in result["results"]] == ["框架匹配"]

    with pytest.raises(ValueError, match="档次编号格式错误"):
        query_product_drive(FakeDbTools([]), "a'; drop", "", "role")


def test_retry_hall_task_updates_task_and_flow_ins(db):
    """工单重试：HALL_TASK.TASK_STATE 置 2 + HALL_TASK_FLOW_INS.handle_type 置 2（同一 task_id）。"""
    from jarvis_agent.analysis import retry_hall_task

    tools = FakeDbTools([], db=db, writes=[
        {"ok": True, "rowcount": 1, "message": "已更新 1 行"},
        {"ok": True, "rowcount": 2, "message": "已更新 2 行"},
    ])
    result = retry_hall_task(tools, "57400263717505", "2000196857627405")
    assert [sql for _, sql in tools.calls] == [
        "UPDATE HALL_TASK SET TASK_STATE = 2 "
        "WHERE CUST_ORDER_ID = '57400263717505' AND TASK_ID = 2000196857627405",
        "UPDATE HALL_TASK_FLOW_INS SET handle_type = 2 WHERE task_id = 2000196857627405",
    ]
    assert all(name == "客户订单库" for name, _ in tools.calls)
    assert result["ok"] is True
    assert result["rowcount"] == 3
    assert "HALL_TASK 已更新 1 行" in result["message"]
    assert "HALL_TASK_FLOW_INS 已更新 2 行" in result["message"]


def test_retry_hall_task_partial_failure_reports_both(db):
    from jarvis_agent.analysis import retry_hall_task

    tools = FakeDbTools([], db=db, writes=[
        {"ok": True, "rowcount": 1, "message": "已更新 1 行"},
        {"ok": False, "rowcount": 0, "message": "执行失败: timeout"},
    ])
    result = retry_hall_task(tools, "57400263717505", "2000196857627405")
    assert result["ok"] is False
    assert "HALL_TASK 已更新 1 行" in result["message"]
    assert "HALL_TASK_FLOW_INS: 执行失败: timeout" in result["message"]


def test_retry_hall_task_validates_input(db):
    from jarvis_agent.analysis import retry_hall_task

    with pytest.raises(ValueError, match="任务ID"):
        retry_hall_task(FakeDbTools([], db=db), "57400263717505", "abc")
    with pytest.raises(ValueError, match="客户订单ID"):
        retry_hall_task(FakeDbTools([], db=db), "order'; drop", "123")


def _analysis_client(tmp_path):
    from jarvis_agent.app import create_app

    return TestClient(create_app(
        db_path=str(tmp_path / "api.db"),
        artifact_root=str(tmp_path / "artifacts"),
        faiss_dir=str(tmp_path / "faiss"),
        config_override={"llm": {"provider": "ollama", "model": "demo",
                                 "base_url": "http://127.0.0.1:1"},
                         "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    ))


def test_analysis_centers_api_returns_seeded_config(tmp_path):
    client = _analysis_client(tmp_path)
    response = client.get("/api/analysis/centers")
    body = response.json()

    assert response.status_code == 200
    assert body["success"] is True
    assert body["data"][0]["center_code"] == "hall_center"
    assert len(body["data"][0]["scenes"]) == 1
    assert body["data"][1]["center_code"] == FAMILY_ORDER_CENTER
    assert len(body["data"][1]["scenes"]) == 3


def test_analysis_query_api_validates_and_returns_nodes(tmp_path, monkeypatch):
    import jarvis_agent.app as app_module

    client = _analysis_client(tmp_path)

    def fake_query(db, db_tools, center_code, scene_code, business_key,
                   city, in_transit, history_month):
        assert center_code == FAMILY_ORDER_CENTER
        assert scene_code == "order_info"
        assert business_key == "57400263"
        assert in_transit is True
        return {"nodes": [{"node_code": "cust_order", "row_count": 1}]}

    monkeypatch.setattr(app_module, "execute_scene_query", fake_query)
    response = client.post(f"/api/analysis/{FAMILY_ORDER_CENTER}/query", json={
        "scene_code": "order_info", "business_key": "57400263", "city_code": "574",
        "in_transit": True,
    })
    assert response.status_code == 200
    assert response.json()["data"]["nodes"][0]["node_code"] == "cust_order"

    monkeypatch.setattr(app_module, "execute_scene_query",
                        lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("业务主键格式错误")))
    bad = client.post(f"/api/analysis/{FAMILY_ORDER_CENTER}/query", json={
        "scene_code": "order_info", "business_key": "abc",
    })
    assert bad.status_code == 400
    assert "业务主键" in bad.json()["detail"]


def test_analysis_family_order_apis_pass_params(tmp_path, monkeypatch):
    import jarvis_agent.app as app_module

    client = _analysis_client(tmp_path)
    seen = {}

    monkeypatch.setattr(app_module, "query_wired_message",
                        lambda tools, task_id, done_date, message_type, city, transit, month: (
                            seen.update(type=message_type, transit=transit, month=month),
                            {"row_count": 0})[1])
    response = client.get("/api/analysis/family-order/wired-message", params={
        "task_id": "7001", "message_type": "IMEP_BACK",
        "in_transit": "no", "history_month": "2026-05",
    })
    assert response.status_code == 200
    assert seen["type"] == "IMEP_BACK"
    assert seen["transit"] is False
    assert seen["month"] == "2026-05"
