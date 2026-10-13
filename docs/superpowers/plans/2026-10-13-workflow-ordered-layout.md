# Workflow Ordered Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a new workflow template SQL with execution-ordered, evenly spaced node coordinates.

**Architecture:** Parse the existing simplified SQL as XML, replace only each task's `<uiinfo>` coordinate object, and re-emit the SQL content columns. Topology and task configuration remain untouched.

**Tech Stack:** Python standard library, existing workflow XML parser.

---

### Task 1: Generate Ordered SQL

**Files:**

- Create: `file/vm_template_version_no_decision_no_shell_ordered.sql`

**Steps:**

- Parse `file/vm_template_version_no_decision_no_shell.sql`.
- Apply these top-left coordinates:
  - Start: `(505, 60)`
  - Fork: `(505, 148)`
  - Independent first-stage service `1790216116185`: `(120, 221)`
  - Sequential first-stage services `1790216253182`, `1790216330779`, `1790216397556`: `(800, 221)`, `(800, 309)`, `(800, 397)`
  - AND: `(505, 500)`
  - Sequential second-stage services `1790220539112`, `1790220704715`, `1790220802326`, `1790220850257`: `(460, 573)`, `(460, 661)`, `(460, 749)`, `(460, 837)`
  - Auto-complete: `(460, 925)`
  - Finish: `(505, 1028)`
- Set the new version ID to `1789959874520`, `order_num` to `5`, and `modify_desc` to `紧凑中轴等距布局`.
- Remove the direct Fork-to-AND edge by deleting its `gotoitem` and matching `join`.
- Split XML into 3900-character SQL content chunks.

### Task 2: Validate

**Steps:**

- Parse the generated SQL with `parse_workflow_xml`.
- Confirm 13 nodes, 28 edges, zero warnings, no decision or shell nodes, and no unresolved task/goto references.
- Assert all intended adjacent center distances equal 88.
- Render the graph in a mocked browser and inspect the screenshot.
