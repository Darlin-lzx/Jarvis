# 数据库迁移状态 WebSocket 实时同步设计

## 目标

LangGraph 执行数据库迁移流程时，前端状态机看板不再依赖 5 秒轮询或流结束后的刷新，而是在节点状态变化后立即更新。聊天文本、子智能体事件与产物事件仍保留在现有 SSE 通道中，避免重构当前对话协议。

## 总体方案

采用“SSE 对话 + WebSocket 状态”的双通道架构：

1. 后端继续通过 `graph.stream(stream_mode=["updates", "messages", "custom"])` 消费 LangGraph 输出。
2. 后端从节点 update 中提取权威任务状态，形成轻量快照。
3. FastAPI 进程内按迁移任务 ID 维护 WebSocket 连接集合，并将状态快照广播给对应连接。
4. 前端进入任务页或会话页时先加载一次迁移任务详情，然后连接 `/ws/migrate/{task_id}` 接收增量快照。
5. WebSocket 断开或异常时保留现有 REST 轮询兜底，连接恢复后以 REST 快照对齐状态。

## 状态快照

每次推送使用完整快照而非增量字段，前端直接覆盖本地状态，避免乱序或丢包造成状态拼接错误。快照字段包括：

- `task_id`
- `status`
- `status_label`
- `current_step`
- `step_status`
- `awaiting_confirmation`
- `step_confirm`
- `strict_flow`
- `updated_at`
- `event`: `state`

推送时机包括：

- WebSocket 连接建立后的初始快照
- LangGraph 节点 update 产生状态变化
- 阶段执行完成、等待确认、失败或回滚
- 用户通过 REST 推进状态后

## 后端组件

新增进程内 `MigrateStateBroadcaster`：

- `add(task_id, websocket)` / `remove(task_id, websocket)`
- `broadcast(task_id, snapshot)`
- `broadcast_many(task_ids, snapshot)`

新增 WebSocket 路由：

`GET /ws/migrate/{task_id}`

连接时校验迁移任务存在，不存在则关闭连接并返回 `not_found`。发送初始快照后保持连接；服务端广播时序列化为 JSON。断开连接时清理注册表。

`chat_stream` 消费 LangGraph update 时，提取 `task_state` 并转换为快照广播。状态落库仍以现有 `migrate_state` 与 `Conversation.task_state` 为权威来源，WebSocket 只负责实时通知。

## 前端组件

新增 `useMigrateStateSocket(taskId | migrateTaskId)` Hook：

- 若存在任务 ID 则创建 WebSocket。
- 初始仍通过 REST 获取详情，保证历史会话打开即有完整数据。
- 收到 `state` 快照后合并到本地 `MigrateTaskDetail`。
- `onclose` 后启动现有 5 秒轮询；重连成功时停止轮询并重新拉取 REST 快照。
- 页面卸载时关闭连接，避免泄漏。

任务详情页与会话页的状态看板共用该 Hook。SSE 的 `migrate` 事件保留，作为直接运行路径的即时补充。

## 错误处理与兼容

- WebSocket 发送失败只记录并移除该连接，不影响 LangGraph 执行与 SSE 输出。
- 广播器锁粒度只覆盖连接集合和发送调度，不执行数据库操作。
- 快照序列化失败、任务缺失或字段为空时跳过本次推送。
- 浏览器不支持 WebSocket 或连接失败时自动走现有轮询。
- 现有 REST API、SSE 事件格式与页面行为保持兼容。

## 测试

后端：

- WebSocket 连接后能收到初始状态快照。
- 模拟 LangGraph update 后， broadcaster 能向对应任务连接推送最新 `current_step` / `step_status`。
- 一个连接发送失败不影响其他连接。
- 不存在任务时连接返回 `not_found`。
- REST `/advance` 推进后广播新状态。

前端：

- Hook 收到快照后更新状态。
- 断开后启动轮询兜底。
- 页面卸载后关闭连接。
- 状态看板渲染 WebSocket 快照，不再依赖流结束刷新。

## 非目标

- 不将聊天文本流迁移到 WebSocket。
- 不引入 Redis 或跨进程消息队列。
- 不改变状态机的权威落库规则。
- 不重构现有 SSE 事件协议。
