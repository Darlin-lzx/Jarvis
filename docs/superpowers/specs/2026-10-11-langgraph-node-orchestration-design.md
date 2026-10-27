# LangGraph 节点化编排改造设计

日期：2026-10-11  
范围：P0 + P1  
状态：已确认

## 1. 背景与目标

当前工作区已经完成了部分节点化改造：六个迁移智能体已是 LangGraph 节点，`commander` 后存在意图路由条件边，阶段智能体后存在阶段推进条件边，@指定和阶段门控也已接入。

本次改造补齐 P1 控制流，使编排能力在图上可见：

- 六个迁移智能体继续作为独立图节点：小枢、小采、小评、小方、小改、小测。
- 新增四个系统节点：`qa`、`artifact`、`confirm`、`error`。
- 普通问答、产物入库、逐级确认、回退和异常处理不再散落在执行节点内部，而是由节点与条件边表达。
- 智能体提示词、DB 智能体配置、产物服务、RAG/规则引擎/MCP 工具层、`db_migrate_task` 状态机、现有 REST API、SSE 事件和前端契约保持兼容。

本设计采用薄系统节点改造：优先复用现有执行与产物逻辑，只移动路由决策和控制流边界，不大规模拆分 `_run_stage_agent` 或工具循环。

## 2. 目标图

```text
START
  -> migration_commander
     -> migration_collector
     -> migration_assessor
     -> migration_planner
     -> code_migrator
     -> migration_verifier
     -> qa
        -> END
        -> artifact

migration_collector      -> artifact
migration_assessor       -> artifact
migration_planner        -> artifact
code_migrator            -> artifact
migration_verifier       -> artifact

artifact -> confirm

confirm -> next stage expert
confirm -> rollback target expert
confirm -> END

agent / artifact / confirm 的失败出口 -> error
error -> retry target
error -> END
```

图实际包含 10 个节点：

| 节点 | 类型 | 职责 |
| --- | --- | --- |
| `migration_commander` | Agent | 解析意图、执行阶段门控、选择入口目标；不再内联执行非迁移智能体 |
| `migration_collector` | Agent | 执行数据采集，复用现有采集与 Excel 本地扫描逻辑 |
| `migration_assessor` | Agent | 执行迁移评估，复用现有评估与规则注入逻辑 |
| `migration_planner` | Agent | 执行迁移方案，复用现有方案生成与演示兜底 |
| `code_migrator` | Agent | 执行代码改造，复用现有 SQL 分析与改造产物逻辑 |
| `migration_verifier` | Agent | 执行迁移验证，复用现有静态校验与报告逻辑 |
| `qa` | 系统 | 执行低置信度问答、普通知识问答和其他非迁移智能体；不推进状态机；普通问答直接结束，明确产物请求进入 `artifact` |
| `artifact` | 系统 | 统一执行交付判定、去重、落盘和产物事件；失败进入错误处理 |
| `confirm` | 系统 | 统一执行阶段推进、逐级确认、显式回退和终态判断 |
| `error` | 系统 | 记录异常、执行最多一次同节点重试、超过阈值后写 `ERROR` |

## 3. 状态与控制字段

`AgentState` 增加图内部控制字段：

| 字段 | 用途 |
| --- | --- |
| `control_target` | 当前节点返回的确定性控制出口，例如 `artifact`、`error`、`confirm` |
| `retry_target` | 错误处理重试时要返回的节点 |
| `error_source` | 首次发生异常的节点名 |
| `error_message` | 面向状态与日志的异常描述 |
| `retry_count` | 当前节点连续失败次数 |
| `confirm_decision` | `wait_user`、`next`、`back`、`finish`、`error` |

这些字段只用于一次图调用内的路由与可观测性，不替代 `db_migrate_task.status`。阶段仍以 DB 状态机为权威；图每次通过 `current_step` 读取注入状态，终态与异常使用现有状态机服务写库。

## 4. 路由与边设计

### 条件边 A：意图路由

`commander` 只负责解析和选择目标：

1. 前端显式指定智能体时，先校验智能体存在与启用状态。
2. 迁移任务上下文中的迁移指令映射到 `STAGE_AGENT_BY_STATUS` 对应专家。
3. `strict_flow=true` 时，非当前阶段专家被拦截并返回提示。
4. 低置信度、未知意图或非迁移对话进入 `qa`。
5. `commander` 自身的解析异常进入 `error`。

普通问答和低置信度对话在 `qa` 后直接结束，不创建任务状态、不触发产物入库。用户明确要求报告、脚本、文件等交付物，或选择的是已配置 `gen_artifact=true` 的非迁移业务智能体时，`qa` 通过条件边进入 `artifact`，由产物节点统一判定是否落盘。

### 普通边：专家到产物节点

五个阶段专家完成后进入 `artifact`。专家节点只负责执行和标记交付结果，不再在节点尾部决定是否推进下一阶段。

现有 `_call_sub_agent` 已有内联产物写入能力。为兼容这一行为，`artifact` 节点会识别已写入的产物：

- 已有产物只做合并、校验和事件归一，不重复写盘。
- 尚未写入但符合 `_is_core_delivery()` 和业务请求门控的回复，由 `artifact` 统一写入。
- 交互式问询、职责说明、普通知识回答不落盘。
- 产物写入失败进入 `error`。

### 条件边 B：确认与推进

`confirm` 读取流程表和 `task_state`，复用现有 `should_advance()` 语义：

| 条件 | 出口 |
| --- | --- |
| `step_confirm=true` 且缺少当前阶段 `task_confirm` | 设置 `waiting_confirm=true`，返回 `END` |
| 当前阶段必填字段缺失 | 停驻当前阶段，等待用户补充 |
| 存在显式 `rollback_target` 或验证失败 | 回退到指定阶段专家 |
| `task_confirm` 通过且存在下一阶段 | 进入下一阶段专家 |
| 当前阶段是验证且成功通过 | 结束本轮；`FINISHED` 仍由现有状态机/API 确认 |
| `step_confirm=false` 且字段齐备 | 自动进入下一阶段专家 |

确认令牌必须保持一次性：进入专家执行前移除旧 `task_confirm`，避免上一阶段确认令牌在产物生成后再次放行下一阶段。

### 条件边 C：异常处理

智能体、产物和确认节点由统一的节点包装器保护：

1. `ChatRunCancelled` 不重试，保持原语义向外传播。
2. 其他异常记录 `error_source`、`error_message`、`trace_id`。
3. 同一节点连续失败不超过一次时，`error` 路由回 `retry_target`。
4. 重试仍失败时调用 `MigrateStateService.set_error()`，任务进入 `ERROR`，释放执行锁，图返回 `END`。
5. 没有关联迁移任务的普通对话异常只设置错误回复，不改状态机。

## 5. 节点边界

### commander

继续承载现有解析、RAG 上下文选择、阶段映射和越级拦截。非迁移智能体执行从 `commander` 内部移动到 `qa` 节点。`commander` 输出 `graph_route_target` 或 `control_target`，由条件边路由。

### 专家节点

专家节点继续复用 `_run_stage_agent()`，但该函数尾部的推进判断移交给 `confirm`。专家节点负责：

- 设置当前 `agent_id` 和阶段执行状态。
- 调用提示词、RAG、工具循环、领域工具和本地确定性兜底。
- 记录 `agent_calls`、`artifacts`、执行耗时和错误。

### qa

`qa` 节点包装现有非迁移智能体执行路径，保留技能调用、RAG、数据源探查和产物请求语义。普通问答默认直接结束且不落盘；用户明确要求产物，或智能体配置 `gen_artifact=true` 且回复符合交付门控时，进入 `artifact` 判定。

### artifact

`artifact` 是唯一产物出口。它复用 `_is_core_delivery()`、产物文件名映射、中文产物名、版本管理和 `ArtifactService`。阶段专家已内联写盘的产物不会重复创建版本。

### confirm

`confirm` 是唯一阶段推进出口。它复用流程表、必填字段和确认开关，只做图内路由；除终态和异常外，不直接修改 `db_migrate_task.status`。应用层现有的 `/advance`、表单提交和聊天确认流程继续作为 DB 权威写入入口。

### error

`error` 是唯一异常出口。取消事件不进入重试；普通异常先重试一次，再调用现有状态机错误写入。所有异常尽量保留原始 `trace_id` 和观测日志。

## 6. 错误处理

| 场景 | 行为 |
| --- | --- |
| 用户取消 | 向外抛出 `ChatRunCancelled`，不重试，不写 `ERROR` |
| LLM 调用异常 | 记录后重试同节点一次 |
| 工具或数据源异常 | 记录后重试同节点一次 |
| 产物写盘异常 | 进入 `error`，重试失败后写 `ERROR` |
| 状态缺失或流程配置异常 | `confirm` 停驻当前阶段并输出提示，不自动跳阶段 |
| 无迁移任务上下文异常 | 返回用户可读错误，不改 `db_migrate_task` |

## 7. 兼容性

- `build_graph()` 的函数签名不变。
- `AgentState` 旧字段全部保留。
- `app.py` 继续使用同一个图对象执行聊天流。
- SSE 的 `route_preflight`、`calling_agent`、`sub_agent`、`artifact`、`system` 事件保持兼容。
- `/api/migrate/tasks/{tid}/advance` 仍是显式确认推进 DB 的入口。
- 前端不需要为本次改造强制更新；图状态事件只是后端编排的可见性增强。

## 8. 测试与验收

新增或更新测试覆盖：

1. 编译后的图包含 10 个目标节点。
2. 低置信度普通提问路由到 `qa`，不产生任务产物；明确产物请求经 `artifact` 判定。
3. 迁移指令根据 `current_step` 进入当前阶段专家。
4. @指定未到达阶段专家被拦截。
5. 专家执行后到达 `artifact`，符合交付条件的报告只落盘一次。
6. `step_confirm=true` 时阶段完成后等待确认。
7. 用户确认后进入下一阶段专家。
8. `step_confirm=false` 且必填字段齐备时自动推进。
9. 异常节点重试一次后进入 `error`。
10. 重试再次失败时任务进入 `ERROR`。
11. 用户取消不触发重试。

回归验证命令：

```bash
pytest tests/ -q
```

如后续需要验证前端不受影响，可运行现有前端测试和构建：

```bash
cd web-ui && npm test -- --run
cd web-ui && npm run build
```

## 9. 非目标

本设计不包含 P2 内容：

- 不实现智能体注册表驱动的运行时动态注册。
- 不重构 LangGraph Studio 接入和前端实时图渲染。
- 不扩大自由流程模式能力。
- 不改变产物表、状态机表和迁移 API 契约。
- 不拆分 `app.py`。
