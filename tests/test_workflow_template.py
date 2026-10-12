import pytest
from sqlalchemy import create_engine, text
from fastapi.testclient import TestClient

from jarvis_agent.workflow_template import (
    build_workflow_template_response,
    normalize_template_content,
    parse_workflow_xml,
    select_workflow_template_versions,
)


XML = """<?xml version="1.0" encoding="GBK" ?>
<workflow label="测试调度" tasktag="demo.tag" tasktype="workflow" owntype="CSF">
  <description>测试描述</description>
  <vars name="custOrderId" datatype="long" defaultvalue="" inouttype="in" description="订单号" />
  <join id="flow2" name="flow2" taska="6" taskb="5" />
  <task id="3" label="开始节点" tasktype="csf_start">
    <uiinfo>10,20,30,29</uiinfo>
    <gotoitem goto="6" />
  </task>
  <task id="6" label="Fork" tasktype="fork">
    <uiinfo>5,60,30,30</uiinfo>
    <gotoitem goto="5" />
  </task>
  <task id="5" label="业务流程" tasktype="csf_service">
    <uiinfo>0,120,120,60</uiinfo>
    <autodeal>
      <runtype>csfService</runtype>
      <crossCenter>false</crossCenter>
      <centercode>ord</centercode>
      <servicecode>demo_service</servicecode>
      <servicename>startWorkflow</servicename>
    </autodeal>
    <relationship>
      <task_>
        <link name="IN">
          <left>custOrderId</left>
          <right>custOrderId</right>
          <defaultValue dataType="java.lang.String">ORDER</defaultValue>
        </link>
        <link name="OUT">
          <left>return</left>
          <right>$IS_WAIT_USER</right>
        </link>
      </task_>
    </relationship>
  </task>
</workflow>"""


class FakeEmbedding:
    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(item + str(i)) % 2 == 0) else -1.0 for i in range(8)]
                for item in texts]


def _workflow_client(tmp_path):
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


@pytest.fixture
def template_engine(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'main.db'}")
    attach_path = str(tmp_path / "aif_comframe.db").replace("'", "''")
    with engine.begin() as conn:
        conn.execute(text(f"ATTACH DATABASE '{attach_path}' AS aif_comframe"))
        conn.execute(text("""
            CREATE TABLE aif_comframe.vm_template_version (
                template_version_id INTEGER PRIMARY KEY,
                order_num INTEGER,
                template_tag TEXT,
                create_staff_id TEXT,
                create_date TEXT,
                modify_desc TEXT,
                valid_date TEXT,
                expire_date TEXT,
                content TEXT, content1 TEXT, content2 TEXT, content3 TEXT,
                content4 TEXT, content5 TEXT, content6 TEXT, content7 TEXT,
                content8 TEXT, content9 TEXT, content10 TEXT, content11 TEXT,
                content12 TEXT, content13 TEXT, content14 TEXT, content15 TEXT
            )
        """))
        conn.execute(text("""
            INSERT INTO aif_comframe.vm_template_version
                (template_version_id, order_num, template_tag, create_staff_id,
                 create_date, modify_desc, valid_date, expire_date, content)
            VALUES (10, 0, 'demo.tag', NULL, '2024-01-01', NULL,
                    '2024-01-01', '2099-01-01', '<workflow>')
        """))
        conn.execute(text("""
            INSERT INTO aif_comframe.vm_template_version
                (template_version_id, order_num, template_tag, create_staff_id,
                 create_date, modify_desc, valid_date, expire_date, content, content1)
            VALUES (11, 0, 'demo.tag', NULL, '2025-01-01', NULL,
                    '2025-01-01', '2099-01-01',
                    '<?xml version="1.0" encoding="GBK" ?><workflow label="新版">', '</workflow>')
        """))
    return engine


def test_normalize_template_content_concatenates_chunks_in_order_and_repairs_artifacts():
    assert normalize_template_content(None, "<workflow>", "','", None, "</workflow>") == "<workflow></workflow>"


def test_normalize_template_content_extracts_embedded_xml_from_sql_export():
    source = "INSERT ... VALUES ('<?xml version=\"1.0\"?><workflow>','</workflow>',NULL);"
    assert normalize_template_content(source) == '<?xml version="1.0"?><workflow></workflow>'


def test_parse_workflow_xml_returns_complete_graph():
    result = parse_workflow_xml(XML)

    assert result["label"] == "测试调度"
    assert result["tasktag"] == "demo.tag"
    assert result["description"] == "测试描述"
    assert result["variables"] == [{
        "name": "custOrderId",
        "datatype": "long",
        "defaultvalue": "",
        "inouttype": "in",
        "description": "订单号",
    }]
    assert {node["id"] for node in result["nodes"]} == {"3", "6", "5"}
    assert result["width"] == 120
    assert result["height"] == 180


def test_parse_workflow_xml_extracts_task_details_and_deduplicates_edges():
    result = parse_workflow_xml(XML)
    service = next(node for node in result["nodes"] if node["id"] == "5")

    assert service["x"] == 0
    assert service["y"] == 120
    assert service["width"] == 120
    assert service["height"] == 60
    assert service["service"] == {
        "runtype": "csfService",
        "cross_center": False,
        "centercode": "ord",
        "servicecode": "demo_service",
        "servicename": "startWorkflow",
    }
    assert service["links"] == [{
        "direction": "IN",
        "left": "custOrderId",
        "right": "custOrderId",
        "default_value": "ORDER",
        "default_value_type": "java.lang.String",
    }, {
        "direction": "OUT",
        "left": "return",
        "right": "$IS_WAIT_USER",
        "default_value": "",
        "default_value_type": "",
    }]
    assert result["edges"] == [{
        "id": "edge-3-6",
        "source": "3",
        "target": "6",
        "source_kind": "goto",
    }, {
        "id": "edge-6-5",
        "source": "6",
        "target": "5",
        "source_kind": "goto",
    }]
    assert result["warnings"] == []


def test_parse_workflow_xml_reports_invalid_xml():
    with pytest.raises(ValueError, match="XML 解析失败"):
        parse_workflow_xml("<workflow><task>")


def test_parse_workflow_xml_rejects_wrong_root_and_warns_for_bad_coordinates():
    with pytest.raises(ValueError, match="workflow"):
        parse_workflow_xml("<not-workflow/>")

    result = parse_workflow_xml(
        '<workflow><task id="1" label="节点" tasktype="csf_service">'
        "<uiinfo>bad</uiinfo></task></workflow>"
    )
    assert result["nodes"][0]["x"] == 0
    assert result["nodes"][0]["y"] == 0
    assert result["nodes"][0]["width"] == 120
    assert result["nodes"][0]["height"] == 60
    assert "节点 uiinfo 坐标格式无效: bad" in result["warnings"]


def test_select_workflow_template_versions_queries_by_tag(template_engine):
    rows = select_workflow_template_versions(template_engine, "demo.tag")
    unknown = select_workflow_template_versions(template_engine, "missing.tag")

    assert [row["template_version_id"] for row in rows] == [11, 10]
    assert unknown == []


def test_build_workflow_template_response_preserves_parse_errors_and_default(template_engine):
    rows = select_workflow_template_versions(template_engine, "demo.tag")
    result = build_workflow_template_response(template_engine, "demo.tag")

    assert result["template_tag"] == "demo.tag"
    assert result["selected_version_id"] == 11
    assert len(result["versions"]) == len(rows)
    invalid = next(v for v in result["versions"] if v["template_version_id"] == 10)
    valid = next(v for v in result["versions"] if v["template_version_id"] == 11)
    assert "XML 解析失败" in invalid["parse_error"]
    assert invalid["workflow"] is None
    assert valid["parse_error"] is None
    assert valid["workflow"]["label"] == "新版"


def test_workflow_api_validates_tag_and_returns_parsed_response(tmp_path, monkeypatch):
    import jarvis_agent.app as app_module

    client = _workflow_client(tmp_path)
    empty = client.get("/api/workflow-templates", params={"template_tag": " "})
    assert empty.status_code == 400
    assert "template_tag" in empty.json()["detail"]

    fake_response = {
        "template_tag": "demo.tag",
        "selected_version_id": 11,
        "versions": [{"template_version_id": 11, "workflow": {"label": "新版"}}],
    }
    monkeypatch.setattr(
        app_module,
        "build_workflow_template_response",
        lambda engine, tag: fake_response,
        raising=False,
    )
    response = client.get("/api/workflow-templates", params={"template_tag": "demo.tag"})
    body = response.json()

    assert response.status_code == 200
    assert body == {"success": True, "data": fake_response}
