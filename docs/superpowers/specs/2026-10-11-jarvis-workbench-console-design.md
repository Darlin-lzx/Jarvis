# Jarvis Workbench Console Design

## Summary

工作台输入指令后不再创建会话并跳转到会话页，而是在 Jarvis HUD 工作台中央展开一个持久内嵌控制台。对话对象固定为贾维斯智能体，用户留在驾驶舱内完成指令下达、流式回复、执行遥测和后续追问。

## User Experience

首次提交指令时，中央 JARVIS 反应堆收缩为紧凑状态并保留动效，下方展开 `JARVIS CONSOLE`：

- 对话双方固定显示为 `OPERATOR` 与 `JARVIS`，不提供智能体切换。
- 用户指令立即进入控制台，贾维斯回复在同一区域流式输出。
- 系统事件渲染为紧凑遥测行，如 `TRACE · 调度智能体`，保留执行感但不打断阅读。
- 输入框位于控制台底部；提交后不切换顶层页面、不改变 URL、不写 `#/chat/{id}`。
- 流式输出期间状态为 `PROCESSING`，反应堆动效加速；提交按钮变为 `ABORT`，可终止当前执行。
- 控制台占据中央栏剩余空间并内部滚动，长对话不挤压左右 HUD 面板。
- 左侧 AGENT CORE、OPERATIONS、QUICK ACCESS 与右侧 LOCAL TIME、AGENT FLEET、NOTES 保持可见。

控制台视觉延续现有 HUD 语言：深色透明面板、青色主色、细扫描线、角落标记、等宽系统字体和低强度辉光。用户与助手不做普通聊天气泡，而使用 `OPERATOR>` 与 `JARVIS>` 指令行样式。

## Conversation State

贾维斯控制台使用独立于顶层路由的持久会话：

- App 维护 `jarvisConvId`，与 `conv.currentId` 分离。
- `jarvisConvId` 持久化到 `localStorage` 的 `jarvis.console.convId` 键，刷新后继续复用。
- 首次输入创建默认空间下的会话，标题为 `贾维斯控制台`，`agent_id` 固定为 `jarvis_commander`。
- 后续命令全部发送到同一会话，由后端保持上下文和调度能力。
- 创建或复用会话后仅刷新侧边栏列表，不设置 `conv.currentId`，因此页面保持在工作台。
- 用户仍可从侧边栏显式打开这条会话查看完整会话页；这属于用户主动导航，不影响工作台内嵌行为。

## Frontend Architecture

新增独立的 JARVIS Console 组件，由 `JarvisWorkbench` 挂在中央栏：

- App 负责持久会话 ID 的读写、校验和创建。
- Console 负责历史加载、命令提交、流式展示、执行遥测和停止操作。
- 复用 `useChatStream` 处理 SSE、流式文本、系统事件、子智能体事件、UI 指令和取消。
- 复用现有 `getMessages`、`createConversation`、`getDefaultSpace` 与会话刷新链路。
- 不嵌套完整 `ChatView`，避免带入右侧 Workspace、任务状态板、智能体切换等重页面结构。
- 结构化 UI 表单在控制台内渲染；提交值继续发送到同一贾维斯会话。

历史消息通过会话消息接口加载。当前运行期间，控制台先渲染用户指令、实时助手文本和时间线；流结束后将最终助手回复追加到本地历史，后续刷新仍以服务端历史为准。

## Error Handling

| 场景 | 行为 |
| --- | --- |
| 本地会话 ID 已不存在 | 清除 `localStorage` 记录，下次提交自动重建 |
| 默认空间或会话创建失败 | 控制台显示 `FAULT · 会话创建失败`，保留输入内容 |
| 流式请求失败 | 显示具体错误，保留用户指令和已接收内容 |
| 用户终止 | 复用现有 cancel/abort 链路，状态回到待输入 |
| 后端返回结构化 UI | 在控制台内渲染表单，不在顶层切换页面 |

错误均显示在控制台内的 `FAULT` 行，不使用浏览器 alert。

## Scope

本设计只改前端工作台、会话复用和流式展示链路，不修改后端会话、聊天流、智能体调度和权限接口。

## Testing

- 工作台提交命令后不设置 `conv.currentId`、不触发 `isChatView`、不写 `#/chat/{id}`。
- `jarvisConvId` 创建后写入 `localStorage`，后续命令复用同一 ID。
- 会话创建参数固定包含默认空间、`agent_id: jarvis_commander` 和标题 `贾维斯控制台`。
- Console 展示历史用户/助手消息、流式回复、系统遥测和错误行。
- 流式期间提供停止操作，结束后追加助手回复。
- 既有 Jarvis workbench 设计测试更新为内嵌控制台契约，不再要求路由到 `ChatView`。
- 运行目标前端测试与生产构建；如全量测试仍受其他未提交改动影响，需用目标测试和提交基线说明差异。
