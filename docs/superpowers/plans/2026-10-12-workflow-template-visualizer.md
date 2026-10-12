# Workflow Template Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Query workflow template versions by `template_tag`, parse concatenated XML content, and render an interactive SVG workflow in the existing web workbench.

**Architecture:** Keep XML normalization, database selection, and response assembly in a dedicated Python module. Add one FastAPI endpoint that returns all matching versions and selects a usable default. Add a focused React panel that renders original task coordinates and node details without introducing a graph dependency.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, `xml.etree.ElementTree`, pytest, React 19, TypeScript, Tailwind CSS, SVG, Node's built-in test runner.

---

### Task 1: Workflow XML Parser

**Files:**

- Create: `jarvis_agent/workflow_template.py`
- Test: `tests/test_workflow_template.py`

- [x] **Step 1: Write parser tests**

Create tests for chunk concatenation, export-artifact repair, XML parsing, service mappings, duplicate goto/join edges, and invalid XML.

```python
import pytest

from jarvis_agent.workflow_template import (
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


def test_normalize_template_content_concatenates_chunks_in_order():
    assert normalize_template_content(None, "<workflow>", None, "</workflow>") == "<workflow></workflow>"


def test_normalize_template_content_repairs_export_artifacts():
    assert normalize_template_content("<workflow>','</workflow>") == "<workflow></workflow>"


def test_parse_workflow_xml_returns_complete_graph():
    result = parse_workflow_xml(XML)
    assert result["label"] == "测试调度"
    assert result["description"] == "测试描述"
    assert result["variables"][0]["name"] == "custOrderId"
    assert {node["id"] for node in result["nodes"]} == {"3", "6", "5"}
    service = next(n for n in result["nodes"] if n["id"] == "5")
    assert service["service"]["servicecode"] == "demo_service"
    assert service["links"][0]["direction"] == "IN"
    assert len(result["edges"]) == 2


def test_parse_workflow_xml_reports_invalid_xml():
    with pytest.raises(ValueError, match="XML 解析失败"):
        parse_workflow_xml("<workflow><task>")
```

- [x] **Step 2: Verify tests fail**

Run: `pytest tests/test_workflow_template.py -v`

Expected: import failure because `jarvis_agent.workflow_template` does not exist.

- [x] **Step 3: Implement the parser**

Implement:

```python
CONTENT_COLUMNS = ("content", *(f"content{i}" for i in range(1, 16)))

def normalize_template_content(*chunks: str | None) -> str:
    return "".join(chunk or "" for chunk in chunks).replace("','", "")


def parse_workflow_xml(xml_text: str) -> dict:
    # Parse with ElementTree, require workflow root, then extract:
    # attributes, description, vars, tasks, uiinfo rectangles, autodeal,
    # relationship links, goto edges, join edges, warnings, and dimensions.
```

Use `Decimal`/float only for numbers that must be serialized, and keep IDs as strings. Add coordinate parsing warnings for malformed `uiinfo`.

- [x] **Step 4: Verify parser tests pass**

Run: `pytest tests/test_workflow_template.py -v`

Expected: all listed tests pass.

- [x] **Step 5: Commit parser**

```bash
git add jarvis_agent/workflow_template.py tests/test_workflow_template.py
git commit -m "feat: parse workflow template XML"
```

### Task 2: Version Query and API Endpoint

**Files:**

- Modify: `jarvis_agent/workflow_template.py`
- Modify: `jarvis_agent/app.py`
- Test: `tests/test_workflow_template.py`

- [x] **Step 1: Write endpoint and selection tests**

Add database-selection tests using a temporary SQLite file attached as schema `aif_comframe`, then create `vm_template_version` in that attached schema. Test empty tag validation, bind parameters, version ordering, and per-row parse errors. For endpoint success shape, monkeypatch `jarvis_agent.app.build_workflow_template_response` so the route test does not require production MySQL.

```python
def test_select_workflow_template_versions_uses_bind_parameter(engine):
    rows = select_workflow_template_versions(engine, "demo.tag")
    assert len(rows) == 2
    assert {row["template_version_id"] for row in rows} == {10, 11}


def test_workflow_api_returns_versions_and_default(tmp_path):
    c = _workflow_client(tmp_path)
    r = c.get("/api/workflow-templates", params={"template_tag": "demo.tag"})
    body = r.json()
    assert r.status_code == 200
    assert body["success"] is True
    assert body["data"]["selected_version_id"] == 11
```

- [x] **Step 2: Verify API tests fail**

Run: `pytest tests/test_workflow_template.py -v`

Expected: selection/API tests fail before implementation.

- [x] **Step 3: Implement database selection**

Add:

```python
def select_workflow_template_versions(engine, template_tag: str) -> list[dict]:
    sql = text("""
        SELECT template_version_id, order_num, template_tag, create_staff_id,
               create_date, modify_desc, valid_date, expire_date,
               content, content1, content2, content3, content4, content5,
               content6, content7, content8, content9, content10,
               content11, content12, content13, content14, content15
        FROM aif_comframe.vm_template_version
        WHERE template_tag = :template_tag
        ORDER BY valid_date DESC, template_version_id DESC
    """)
    with engine.connect() as conn:
        return [dict(row._mapping) for row in conn.execute(sql, {"template_tag": template_tag})]
```

Add a response builder that parses each row, carries `parse_error` on failures, and chooses the default with the documented valid/expire/ID ordering.

- [x] **Step 4: Add FastAPI endpoint**

In `create_app`, add:

```python
@app.get("/api/workflow-templates")
def workflow_templates(template_tag: str = ""):
    tag = template_tag.strip()
    if not tag:
        raise HTTPException(400, "template_tag 不能为空")
    try:
        return {"success": True, "data": build_workflow_template_response(db.engine, tag)}
    except SQLAlchemyError as exc:
        raise HTTPException(503, f"工作流模板查询失败: {exc}") from exc
```

Import the parser helpers and `SQLAlchemyError` at the top of `app.py`.

- [x] **Step 5: Verify API tests pass**

Run: `pytest tests/test_workflow_template.py -v`

Expected: parser and API tests pass.

- [x] **Step 6: Commit API**

```bash
git add jarvis_agent/workflow_template.py jarvis_agent/app.py tests/test_workflow_template.py
git commit -m "feat: expose parsed workflow templates"
```

### Task 3: Frontend Types, API Client, and Workflow Panel

**Files:**

- Modify: `web-ui/src/lib/types.ts`
- Modify: `web-ui/src/lib/api.ts`
- Create: `web-ui/src/components/workbench/workflow-panel.tsx`
- Test: `web-ui/tests/workflow-panel.test.ts`

- [x] **Step 1: Write frontend behavior tests**

Use source-level assertions consistent with existing Node tests for query construction, original-coordinate rendering, version switching, node details, and parse errors.

```ts
assert.equal(source.includes("api.getWorkflowTemplate(tag)"), true)
assert.equal(source.includes("data-nodes"), true)
assert.equal(source.includes("node.x"), true)
assert.equal(source.includes("selectedVersionId"), true)
assert.equal(source.includes("v.parse_error"), true)
assert.equal(source.includes("servicecode"), true)
```

- [x] **Step 2: Verify frontend tests fail**

Run: `cd web-ui && npm test -- tests/workflow-panel.test.ts`

Expected: missing component/test file failure.

- [x] **Step 3: Add response types and API method**

Define `WorkflowVariable`, `WorkflowLink`, `WorkflowService`, `WorkflowNode`, `WorkflowEdge`, `WorkflowGraph`, `WorkflowTemplateVersion`, and `WorkflowTemplateResponse` in `types.ts`.

Add:

```ts
getWorkflowTemplate: (tag: string) =>
  request<WorkflowTemplateResponse>(`/api/workflow-templates?template_tag=${encodeURIComponent(tag)}`),
```

- [x] **Step 4: Implement the workflow panel**

Create a single focused panel containing:

- tag form and loading state
- version select
- SVG viewport with zoom controls
- original-coordinate node rendering
- directed edge paths
- node search and selection
- detail panel for service and mappings
- empty, database-error, and parse-error states

Use stable node dimensions, SVG clipping, and type-specific colors. No nested cards.

- [x] **Step 5: Verify frontend tests pass**

Run: `cd web-ui && npm test -- tests/workflow-panel.test.ts`

Expected: workflow panel test passes.

- [x] **Step 6: Commit frontend panel**

```bash
git add web-ui/src/lib/types.ts web-ui/src/lib/api.ts web-ui/src/components/workbench/workflow-panel.tsx web-ui/tests/workflow-panel.test.ts
git commit -m "feat: render workflow templates"
```

### Task 4: Workbench Navigation

**Files:**

- Modify: `web-ui/src/components/workbench/workbench-view.tsx`
- Modify: `web-ui/src/components/layout/sidebar.tsx`
- Modify: `web-ui/src/App.tsx`
- Test: `web-ui/tests/workflow-panel.test.ts`

- [x] **Step 1: Extend navigation test**

Assert the workbench imports/cases `WorkflowPanel`, sidebar exposes value `workflows`, and App's hash allowlist includes `workflows`.

- [x] **Step 2: Verify navigation test fails**

Run: `cd web-ui && npm test -- tests/workflow-panel.test.ts`

Expected: navigation assertions fail.

- [x] **Step 3: Register the panel**

Import `WorkflowPanel`, add `case 'workflows': return <WorkflowPanel />`, add a sidebar menu item labeled `工作流` with value `workflows`, and append `'workflows'` to `workbenchTabs`.

- [x] **Step 4: Verify navigation test passes**

Run: `cd web-ui && npm test -- tests/workflow-panel.test.ts`

Expected: all workflow panel assertions pass.

- [x] **Step 5: Commit navigation**

```bash
git add web-ui/src/components/workbench/workbench-view.tsx web-ui/src/components/layout/sidebar.tsx web-ui/src/App.tsx web-ui/tests/workflow-panel.test.ts
git commit -m "feat: add workflow workbench tab"
```

### Task 5: Full Verification and Runtime Check

**Files:**

- No new source files.

- [x] **Step 1: Run focused backend tests**

Run: `pytest tests/test_workflow_template.py -v`

Expected: all tests pass.

- [x] **Step 2: Run frontend tests**

Run: `cd web-ui && npm test`

Expected: existing suite and new tests pass.

- [x] **Step 3: Type-check and build frontend**

Run: `cd web-ui && npm run build`

Expected: TypeScript and Vite build pass.

- [x] **Step 4: Run backend smoke tests**

Run: `pytest tests/test_api.py tests/test_smoke.py -v`

Expected: API and smoke tests pass.

- [x] **Step 5: Start development services**

Run backend and Vite dev server, open `#/workspace/workflows`, query the sample tag from `file/workflow.txt`, and verify nodes, edges, version selection, search, zoom, and details. Fix any visual or interaction issue found.

- [x] **Step 6: Final commit if runtime fixes were needed**

```bash
git status --short
git add jarvis_agent/workflow_template.py jarvis_agent/app.py tests/test_workflow_template.py web-ui/src/lib/types.ts web-ui/src/lib/api.ts web-ui/src/components/workbench/workflow-panel.tsx web-ui/src/components/workbench/workbench-view.tsx web-ui/src/components/layout/sidebar.tsx web-ui/src/App.tsx web-ui/tests/workflow-panel.test.ts
git commit -m "fix: polish workflow template visualization"
```
