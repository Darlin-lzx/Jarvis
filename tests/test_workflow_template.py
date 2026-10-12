import pytest

from jarvis_agent.workflow_template import (
    normalize_template_content,
    parse_workflow_xml,
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
