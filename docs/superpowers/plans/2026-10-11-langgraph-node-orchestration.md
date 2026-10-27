# LangGraph Node Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit `qa`, `artifact`, `confirm`, and `error` LangGraph nodes while preserving the existing migration state machine and API behavior.

**Architecture:** Keep the six agent nodes and their current execution services. Introduce thin system nodes for routing boundaries: non-migration execution moves to `qa`, delivery gating moves to `artifact`, stage advancement moves to `confirm`, and exceptions route through `error`. `db_migrate_task.status` remains authoritative; the graph reads injected state and only writes terminal errors through `MigrateStateService.set_error()`.

**Tech Stack:** Python 3.13, FastAPI, LangGraph, SQLAlchemy, pytest.

---

## File Structure

- Modify `jarvis_agent/graph.py`: add graph-control state fields, system nodes, safe wrappers, route functions, and compile the 10-node graph.
- Modify `tests/test_graph.py`: add topology, QA routing, artifact/confirm traversal, auto-advance, retry/error, and cancellation tests.
- No change is planned for `app.py`; its existing task-state preparation and persistence remain the application boundary.

## Task 1: Graph Topology And Control State

**Files:**
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] **Step 1: Write failing topology test**

Add this test near the graph tests:

```python
def test_compiled_graph_has_explicit_system_nodes():
    graph = build_graph(
        llm=None, rag_search=lambda *args, **kwargs: [], prompt_service=None,
        artifact_service=None, skill_service=None, parse_schema={},
    )
    nodes = set(graph.get_graph().nodes)
    assert nodes == {
        "migration_commander", "migration_collector", "migration_assessor",
        "migration_planner", "code_migrator", "migration_verifier",
        "qa", "artifact", "confirm", "error",
    }
```

- [ ] **Step 2: Run and verify RED**

```bash
pytest tests/test_graph.py::test_compiled_graph_has_explicit_system_nodes -q
```

Expected failure: nodes include only the six current agent nodes.

- [ ] **Step 3: Add state and node methods**

Extend `AgentState`:

```python
control_target: str
retry_target: str
error_source: str
error_message: str
retry_count: int
confirm_decision: str
```

Implement thin methods that first call the existing behavior, then set the control target:

```python
def qa_node(self, state: AgentState) -> AgentState:
    state["generic_executed"] = False
    self.route(state)
    self._emit({"type": "route_preflight", "agent_id": state.get("agent_id", "")})
    self.execute(state)
    state["generic_executed"] = True
    state["control_target"] = (
        "artifact" if self._should_write_delivery(state) else END)
    return state
```

For now `_should_write_delivery` returns whether the selected agent has `gen_artifact`, the input is an artifact request, and `self.artifacts is not None`.

- [ ] **Step 4: Compile the new graph**

Replace current node registration and conditional edges with:

```python
g.add_node("qa", rt.qa_node)
g.add_node("artifact", rt.artifact_node)
g.add_node("confirm", rt.confirm_node)
g.add_node("error", rt.error_node)
```

Use `commander_route`, `qa_route`, `artifact_route`, `confirm_route`, `error_route`, and add the five stage experts to `artifact`. The exact route methods are defined by Tasks 2-5.

- [ ] **Step 5: Run topology test**

```bash
pytest tests/test_graph.py::test_compiled_graph_has_explicit_system_nodes -q
```

Expected: pass.

## Task 2: QA Routing And Artifact Compatibility

**Files:**
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] **Step 1: Write failing QA test**

```python
def test_low_confidence_question_runs_qa_without_artifact(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    from jarvis_agent.bootstrap import bootstrap
    bootstrap(db)
    artifacts = ArtifactService(db, str(tmp_path / "artifacts"))
    graph = build_graph(
        llm=FakeLLM(reply="回答"), rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db), artifact_service=artifacts,
        skill_service=None, parse_schema={}, agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(user_input="随便问问", conv_id=900))
    assert final["agent_id"] == "nl2sql_qa"
    assert final["generic_executed"] is True
    assert artifacts.list_namespaces(conv_id=900) == []
```

- [ ] **Step 2: Run and verify RED**

```bash
pytest tests/test_graph.py::test_low_confidence_question_runs_qa_without_artifact -q
```

Expected: current graph still executes QA inside commander or lacks `generic_executed`.

- [ ] **Step 3: Route generic agents through qa**

Change commander so non-stage selections set:

```python
state["graph_route_target"] = "qa"
```

Do not call `execute()` or `artifact()` inside `commander()`. Let `qa_node()` execute the existing `route()/execute()` path.

- [ ] **Step 4: Route delivery-capable QA to artifact**

Implement:

```python
def qa_route(self, state: Dict) -> str:
    if state.get("control_target") == "artifact":
        return "artifact"
    return END
```

Update `artifact_node()` to invoke the existing artifact logic, then set `control_target="confirm"`.

- [ ] **Step 5: Run focused tests**

```bash
pytest tests/test_graph.py::test_low_confidence_question_runs_qa_without_artifact \
  tests/test_graph.py::test_graph_full_flow \
  tests/test_graph.py::test_direct_core_agent_writes_only_business_document -q
```

Expected: all pass.

## Task 3: Move Stage Advancement To Confirm

**Files:**
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] **Step 1: Write failing confirm traversal test**

```python
def test_stage_expert_reaches_confirm_and_waits(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    from jarvis_agent.bootstrap import bootstrap
    bootstrap(db)
    artifacts = ArtifactService(db, str(tmp_path / "artifacts"))

    class AssessorLLM(FakeLLM):
        def parse(self, text):
            return {"intent": "migration_overall", "agent_id": "migration_commander",
                    "object_name": "营业库", "source_db": "excel", "target_db": "mysql",
                    "skill_id": "", "confidence": 1.0}

    graph = build_graph(
        llm=AssessorLLM(reply="# 迁移评估报告\n\n兼容性风险为中。"),
        rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db), artifact_service=artifacts,
        skill_service=None, parse_schema={}, agent_service=AgentService(db),
    )
    final = graph.invoke(AgentState(
        user_input="开始执行", conv_id=901, agent_id="migration_commander",
        task_state={"current_step": "ASSESSMENT_RUNNING", "step_confirm": True,
                    "pipeline_start": True, "task_params": {
                        "source_ds_id": "excel-1", "source_db_type": "excel",
                        "target_db_type": "mysql", "db_business_level": "核心",
                        "db_capacity": "500GB", "stop_window": "2小时"}}))
    assert final["graph_route_target"] == "migration_assessor"
    assert final["confirm_decision"] == "wait_user"
    assert final["task_state"]["awaiting_confirmation"] is True
```

- [ ] **Step 2: Run and verify RED**

```bash
pytest tests/test_graph.py::test_stage_expert_reaches_confirm_and_waits -q
```

Expected: `confirm_decision` is absent.

- [ ] **Step 3: Simplify `_run_stage_agent`**

Remove the `should_advance()` / `graph_next_step` block from the end of `_run_stage_agent()`. Keep execution status and failure markers. Set:

```python
state["control_target"] = "artifact"
```

All five expert nodes then use a common conditional edge to `artifact`.

- [ ] **Step 4: Implement confirm node**

Use existing `should_advance()` semantics, but do not mutate DB:

```python
def confirm_node(self, state: AgentState) -> AgentState:
    decision = self.should_advance(state)
    state["confirm_decision"] = decision
    ts = state.setdefault("task_state", {})
    stage = self._normalized_stage(state)
    nodes = self._flow_nodes()
    node = next((n for n in nodes if n["status"] == stage), None)
    if decision in ("stay", "wait_user"):
        ts["step_status"] = "waiting_confirm"
        ts["awaiting_confirmation"] = True
        state["reply"] = state.get("reply") or (
            f"{status_label(stage)}已完成，请确认后继续。")
    elif decision == "back":
        ts["step_status"] = "rollback_pending"
        ts["awaiting_confirmation"] = True
    elif decision == "next":
        next_stage = self._next_stage_status(state)
        state["graph_next_step"] = next_stage
        ts["awaiting_confirmation"] = False
        if next_stage not in STAGE_AGENT_BY_STATUS:
            state["confirm_decision"] = "finish"
    state["control_target"] = "confirm"
    return state
```

Route:

```python
def confirm_route(self, state: Dict) -> str:
    decision = state.get("confirm_decision") or self.should_advance(state)
    if decision == "back":
        target = (state.get("task_state") or {}).get("rollback_target")
        return STAGE_AGENT_BY_STATUS.get(target, "migration_commander")
    if decision == "next":
        return STAGE_AGENT_BY_STATUS.get(
            state.get("graph_next_step") or self._next_stage_status(state),
            "migration_commander")
    return END
```

- [ ] **Step 5: Run focused stage tests**

```bash
pytest tests/test_graph.py::test_stage_expert_reaches_confirm_and_waits \
  tests/test_graph.py::test_agent_graph_stage_node_creates_artifact_and_waits \
  tests/test_graph.py::test_stage_confirmation_token_is_not_reused_across_stages -q
```

Expected: all pass.

## Task 4: Error Wrapping And Retry

**Files:**
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] **Step 1: Write failing retry test**

```python
def test_node_failure_retries_once_then_marks_error(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    from jarvis_agent.bootstrap import bootstrap
    bootstrap(db)
    state_service = MigrateStateService(db)
    task = state_service.create(conv_id=902)

    class ExplodingAssessor(FakeLLM):
        def parse(self, text):
            return {"intent": "migration_overall", "agent_id": "migration_commander",
                    "object_name": "", "source_db": "", "target_db": "mysql",
                    "skill_id": "", "confidence": 1.0}

    calls = {"n": 0}

    # The test replaces the assessor method after graph construction.
    graph = build_graph(
        llm=ExplodingAssessor(), rag_search=lambda q, top_k=4, space_id=None: [],
        prompt_service=PromptService(db),
        artifact_service=ArtifactService(db, str(tmp_path / "artifacts")),
        skill_service=None, parse_schema={}, agent_service=AgentService(db),
        migrate_state=state_service,
    )
    def failing(_state):
        calls["n"] += 1
        raise RuntimeError("assessment failed")
    from jarvis_agent.graph import GraphRuntime
    GraphRuntime.migration_assessor = failing

    final = graph.invoke(AgentState(
        user_input="开始执行", conv_id=902, agent_id="migration_commander",
        task_state={"migrate_task_id": task.id,
                    "current_step": "ASSESSMENT_RUNNING",
                    "step_confirm": False, "pipeline_start": True,
                    "task_params": {"task_confirm": "确认"}}))
    assert calls["n"] == 2
    assert final["confirm_decision"] == "error"
    assert state_service.get(task.id).status == "ERROR"
```

- [ ] **Step 2: Run and verify RED**

```bash
pytest tests/test_graph.py::test_node_failure_retries_once_then_marks_error -q
```

Expected: `RuntimeError` propagates before the retry node exists.

- [ ] **Step 3: Add safe node wrapper**

Introduce:

```python
def _safe_node(self, name: str, fn: Callable[[AgentState], AgentState]):
    def run(state: AgentState) -> AgentState:
        try:
            return fn(state)
        except ChatRunCancelled:
            raise
        except Exception as exc:
            if state.get("retry_target") == name:
                state["retry_count"] = int(state.get("retry_count") or 0) + 1
            else:
                state["retry_target"] = name
                state["retry_count"] = 1
            state["error_source"] = name
            state["error_message"] = str(exc)
            state["confirm_decision"] = "error"
            state["control_target"] = "error"
            self._trace(state, "node", name, str(exc), level="error")
            return state
    return run
```

Wrap commander, experts, `qa`, `artifact`, and `confirm` in `build_graph()`:

```python
g.add_node("migration_assessor", rt._safe_node("migration_assessor", rt.migration_assessor))
```

Do not wrap `error`.

- [ ] **Step 4: Implement error node**

```python
def error_node(self, state: AgentState) -> AgentState:
    source = state.get("retry_target") or state.get("error_source") or ""
    count = int(state.get("retry_count") or 0)
    message = state.get("error_message") or "节点执行失败"
    if count < 1 and source in ROUTABLE_NODES:
        state["control_target"] = source
        return state
    task_state = state.get("task_state") or {}
    task_id = task_state.get("migrate_task_id")
    if task_id and self.migrate_state is not None:
        self.migrate_state.set_error(int(task_id), message)
    state["reply"] = f"执行失败：{message}"
    state["confirm_decision"] = "error"
    state["control_target"] = END
    return state
```

Define `ROUTABLE_NODES` as commander, five experts, `qa`, `artifact`, and `confirm`. Route on `control_target`.

- [ ] **Step 5: Run focused error and cancellation tests**

```bash
pytest tests/test_graph.py::test_node_failure_retries_once_then_marks_error \
  tests/test_graph.py::test_graph_llm_stream_stops_after_user_cancel -q
```

Expected: both pass.

## Task 5: Auto Advance And Full Regression

**Files:**
- Modify: `jarvis_agent/graph.py`
- Test: `tests/test_graph.py`

- [ ] **Step 1: Write failing auto-advance test**

Use a collector-to-assessor task with `step_confirm=False`, `task_confirm="确认"`, complete data-collection fields, and an artifact-producing collector reply. Assert the second expert's `agent_calls` contains `migration_assessor` and final `confirm_decision == "wait_user"`.

- [ ] **Step 2: Run and verify RED**

```bash
pytest tests/test_graph.py::test_auto_mode_advances_collector_to_assessor -q
```

Expected: current graph stops after collector or bypasses `confirm`.

- [ ] **Step 3: Preserve one-shot confirmation semantics**

In `_run_stage_agent()`, retain `params.pop("task_confirm", None)` so the token cannot advance a later stage. In `confirm_node()`, consume `task_confirm` only when routing `next`, then remove it from `task_params`.

- [ ] **Step 4: Add traversal assertion**

Extend the topology test with graph edges:

```python
edges = {(e.source, e.target) for e in graph.get_graph().edges}
for agent in STAGE_AGENT_IDS:
    assert (agent, "artifact") in edges
assert ("artifact", "confirm") in edges
assert ("qa", "artifact") in edges
```

- [ ] **Step 5: Run full backend suite**

```bash
pytest tests/ -q
```

Expected: all tests pass. If existing tests rely on commander directly ending after generic execution, update only their traversal assertions while preserving user-visible behavior.
