# 平台化 P0 增量加固设计

## 背景

《易迁联 · 平台化改造设计方案》将平台化改造拆为 P0、P1、P2。P0 的目标是在不改现有架构、不迁移存量数据、不破坏现有接口的前提下，补齐产物版本、全链路追踪、可靠性保护和状态事件化四项基础能力。

本设计对应 P0 范围，不包含插件注册、四级状态模型重构、对象级并行分片、知识自学习和新业务插件。

## 目标

1. 迁移状态变化产生结构化事件，并通过现有 WebSocket 实时推送。
2. 同一产物可多版本共存，支持历史版本读取和 SQL Diff。
3. 一次迁移任务拥有全局 TraceID，节点调度、LLM 调用、关键数据库操作和产物写入可统一查询。
4. 数据库连接与大模型调用具备重试、熔断和半开恢复能力。
5. 现有 REST、聊天 SSE、WebSocket 与迁移流程保持兼容。

## 非目标

- 不重构现有 `db_migrate_task` 为通用任务表。
- 不引入 `plugins` 表和 `BasePlugin`。
- 不实现任务、阶段、节点、分组四级模型。
- 不实现对象依赖拓扑分片和分组并行执行。
- 不实现知识自动沉淀、自动降权和自学习闭环。
- 不新增业务插件管理页面。

## 总体原则

- 存量表和记录一律不动，仅做可空字段或带默认值字段的增量迁移。
- 现有状态字段仍是权威执行状态；事件记录只描述状态变化过程。
- 插件化与并行能力进入 P1 后，事件、Trace、版本产物可被底座直接复用。
- 所有新接口保持现有错误结构 `{success: false, detail: ...}`。
- 对旧数据读取时自动补默认值：产物版本为 `1`，TraceID 为空时可按任务维度延迟生成。

## 模块设计

### 1. 状态机事件化

新增迁移状态事件表 `migrate_state_events`，记录 `task_id`、`conv_id`、`event_type`、`from_status`、`to_status`、`node_id`、`message`、`trace_id`、`created_at`。

事件类型包括 `TASK_STARTED`、`NODE_SUCCESS`、`NODE_FAILED`、`USER_INPUT`、`USER_CANCEL`、`TASK_COMPLETED`。事件在状态机成功更新、异常中断、用户确认输入和任务取消时写入。事件写入失败不阻断主状态更新，但记录错误日志。

WebSocket 继续发送现有状态快照，并追加兼容事件帧：

```json
{
  "event": "state_event",
  "task_id": 13,
  "data": {
    "event_type": "NODE_SUCCESS",
    "from_status": "DATA_COLLECTION",
    "to_status": "DATA_COLLECTION",
    "node_id": "migration_collector",
    "message": "数据采集完成"
  }
}
```

现有前端继续消费状态快照；新增执行提示只依赖事件帧，不再从对话文本里猜测执行状态。

### 2. 产物版本中心

`artifacts` 增量扩展 `version`、`parent_version`、`trace_id`。历史数据读取时默认 `version=1`。

版本归属键使用 `task_id + agent_id + object_name + file_type`。没有任务 ID 的普通会话产物保持现状，不做强制版本合并。

写入规则：

1. 首次生成写入 `version=1`。
2. 同一归属键再次生成时查询最大版本，写入 `version=N+1`、`parent_version=N`。
3. 每个版本文件独立保存，禁止覆盖历史文件。
4. 版本号分配与文件写入处于同一数据库事务边界内，避免并发执行产生重复版本号。

新增接口：

- `GET /api/products/{id}/versions`
- `GET /api/products/{id}/versions/{version}`
- `GET /api/products/{id}/diff?left=1&right=2`

Diff 返回 `summary` 与 `blocks`。`summary` 包含 `added`、`removed`、`changed` 数量；`blocks` 使用 `context`、`added`、`removed`、`changed` 标记行级差异，并保留左右侧行号。Diff 使用标准库 `difflib` 计算，不引入外部依赖。

前端产物面板提供版本选择、历史内容查看和 SQL Diff 视图。

### 3. 全局 TraceID 与 trace_logs

`db_migrate_task` 增量扩展 `task_type`、`trace_id`、`plugin_version`，默认值分别为 `db_migrate`、空字符串、`builtin-v1`。创建迁移任务时生成 UUID 形式 TraceID。存量任务读取时如果 TraceID 为空，可在首次状态变化时补齐。

新增 `trace_logs` 表，记录 `trace_id`、`conv_id`、`task_id`、`phase`、`span`、`level`、`message`、`duration_ms`、`created_at`。`phase` 覆盖 `schedule`、`node`、`llm`、`db`、`artifact`、`state`、`error`。

新增接口：

- `GET /api/trace/{trace_id}`
- `GET /api/migrate/tasks/{task_id}` 响应增加 `trace_id`

现有 `chat_trace` 保留，用于会话步骤调试；`trace_logs` 是跨模块任务追踪。LLM 与数据库日志只记录调用摘要、状态和耗时，不记录 API Key、密码、完整业务 SQL 大结果集。

### 4. 熔断与重试

新增配置组：

```yaml
reliability:
  db_failure_threshold: 3
  db_recovery_seconds: 30
  llm_failure_threshold: 3
  llm_recovery_seconds: 60
  llm_retry_count: 3
  llm_retry_backoff_seconds: 1
  node_timeout_seconds: 300
```

数据库熔断在连续失败达到阈值后进入 `open`；冷却期结束后进入 `half_open`，下一次调用作为试探。试探成功进入 `closed` 并清零失败计数，失败则回到 `open`。

LLM 保护对网络异常、超时和可重试服务端错误按指数退避重试；达到阈值后熔断，冷却后半开试探。配置读取失败时使用内置默认值，保证服务可启动。

P0 对同步节点调用增加超时保护。超时后释放执行锁、写状态事件和错误 Trace，任务状态置为 `ERROR`，允许用户从原阶段重试。

## API 兼容

新增字段均为可选展示字段，前端旧版本可忽略。现有接口路径不变，不增加 `v2` 前缀。若新能力初始化失败，系统保持原有迁移执行路径可用。

## 测试设计

后端测试覆盖状态事件写入与 WebSocket 推送、产物递增版本、历史文件保留、指定版本读取、SQL Diff、TraceID 贯穿、DB 熔断状态流转、LLM 重试熔断、旧库字段补齐。

前端测试覆盖产物版本列表、指定版本内容、SQL Diff 高亮、WebSocket 事件提示、TraceID 时间线。

回归范围包含状态机推进、严格与自由流程开关、会话 SSE、子 Agent 输出、产物入库、聊天页、任务详情页和空间任务链路。

## 上线与回滚

1. 增量表和字段由现有轻量迁移机制创建。
2. 后端重启后自动补列，历史数据默认值在读取层兼容。
3. 前端仅在产物面板和任务详情页增量渲染新字段。
4. 如新能力异常，可通过配置阈值暂时关闭熔断触发路径；版本产物和 Trace 查询失败不影响原任务执行。

## 验收标准

1. 同一产物多次生成后多版本共存，Diff 正确标记增删改。
2. 一个任务从调度、LLM、数据库到产物写入可用同一个 TraceID 查询。
3. 数据库连续失败自动熔断，冷却后半开恢复。
4. LLM 异常按配置重试，达到阈值后熔断降级。
5. 状态开始、完成、失败实时推送，页面展示与实际状态一致。
6. 现有后端与前端回归测试通过。
