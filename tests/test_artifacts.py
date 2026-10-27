import pytest

from jarvis_agent.artifacts import (ArtifactService, NamespaceError,
                                    make_namespace, primary_object_name,
                                    safe_object_name)
from jarvis_agent.db import Database


def test_make_namespace_ok():
    ns = make_namespace("sess_a1", "ddl_converter", "user_order", "20260928T103000")
    assert ns == "sess_a1/ddl_converter/user_order/20260928T103000"


def test_make_namespace_rejects_bad_segments():
    with pytest.raises(NamespaceError):
        make_namespace("../../etc", "ddl", "obj")
    with pytest.raises(NamespaceError):
        make_namespace("sess", "ddl", "a/b")


def test_safe_object_name():
    assert safe_object_name("User.账ORDER表")  # 可用字符保留
    assert safe_object_name("   ").startswith("artifact") or safe_object_name("   ") == "artifact"


def test_primary_object_name():
    assert primary_object_name("") == "artifact"
    assert primary_object_name("USER_ORDER, ORDER_ITEM") == "USER_ORDER"
    assert primary_object_name("V_USER_ORDER_SUMMARY, PRC_ORDER_SYNC, TRG_ORDER_BI") == "V_USER_ORDER_SUMMARY"
    assert len(primary_object_name("A" * 80)) == 40
    assert primary_object_name("TABLE_NAME", max_len=8) == "TABLE_NA"


def test_write_and_list(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    svc = ArtifactService(db, str(tmp_path / "artifacts"))
    ns = make_namespace("sess_a1", "ddl_converter", "user_order", "20260928T103000")
    res = svc.write(ns, conv_id=1, agent_id="ddl_converter", object_name="user_order",
                    files={"DDL_USER_ORDER.sql": "create table ...", "result.json": "{}"})
    assert len(res["files"]) == 2
    assert (tmp_path / "artifacts" / ns / "DDL_USER_ORDER.sql").exists()
    assert svc.list_namespaces(conv_id=1) == [ns]
    assert len(svc.list_files(ns)) == 2
    content = svc.read(res["files"][0]["id"])
    assert "create table" in content


def test_write_and_read_binary_xlsx(tmp_path):
    from io import BytesIO
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "改造清单"
    ws.append(["对象名称"])
    ws.append(["user_order"])

    buf = BytesIO()
    wb.save(buf)
    db = Database(str(tmp_path / "t.db"))
    svc = ArtifactService(db, str(tmp_path / "artifacts"))
    ns = make_namespace("sess_xlsx", "boot_agent", "user_order", "20260928T103000")
    res = svc.write(ns, conv_id=1, agent_id="boot_agent", object_name="user_order",
                    files={"改造清单.xlsx": buf.getvalue()})

    assert svc.read_bytes(res["files"][0]["id"]) == buf.getvalue()
