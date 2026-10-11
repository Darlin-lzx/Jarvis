# Agent Review Workspace Design

## Summary

会话页右侧从“产物列表”升级为 Codex 风格的 **Agent Review Workspace**。工作区跟随当前选中的智能体切换，展示该智能体绑定工程的 Git 真实变更、只读工程目录，以及本次会话中的代码/知识库检索证据。

默认采用三页签结构：

1. **Changes**：当前智能体 `project_dir` 内的 Git working tree 真实差异。
2. **Project**：当前智能体工程目录的懒加载只读目录树和文件预览。
3. **Evidence**：当前会话中 `code_read`、`code_search`、`rag_search` 的可追溯痕迹。

读过或检索过的文件只进入 Evidence，不进入 Changes；Changes 只反映 Git working tree 中真实修改、新增、删除、重命名的文件。

## User Experience

### Workspace Header

右侧顶部显示当前智能体展示名和工程上下文：

- 智能体展示名：优先 `alias`，例如 `order-center`。
- 工程目录名：例如 `order-center`。
- 完整 `project_dir`。
- Git 分支和变更数量，例如 `feature/gsm-ydkj · 3 changed`。

未绑定有效工程目录时，显示空状态：当前智能体未绑定工程目录。此时 Project 和 Changes 不可用，但不影响聊天主区域。

### Changes Tab

Changes 使用 Git 读取当前智能体工程目录：

- 状态来源：`git status --porcelain=v1 --untracked-files=all`。
- 状态标记：`M` modified、`A` untracked/added、`D` deleted、`R` renamed、其他 Git 状态归入标准化状态展示。
- 文件项显示相对路径、状态标记和增删行数。
- 点击文件后显示 unified diff。
- Untracked 文件没有 `git diff HEAD` 输出，读取文件内容并按“全部新增”渲染预览。
- 非 Git 工程显示明确提示，不伪造 diff。

### Project Tab

Project 提供当前 `project_dir` 的只读浏览：

- 首次只加载目标目录一层，目录和文件分页或限量返回。
- 点击目录懒加载子级。
- 点击文件打开只读预览。
- 面包屑显示从工程根目录到当前目录的相对路径。
- 禁止写入、删除、执行和路径逃逸。

### Evidence Tab

Evidence 按会话和智能体过滤工具痕迹：

- `code_read` / 自动预读取：标记为 `READ`，可点击打开对应文件。
- `code_search` / 自动预检索：标记为 `SEARCH`，显示检索词和命中数量。
- `rag_search`：标记为 `KB`，显示检索词和知识库过滤范围。

Evidence 不代表工程已被修改，只用于解释智能体结论来源。

### Agent Switching

会话输入区当前选中的智能体决定右侧工作区：

- 选择 `boot`、`hall-center`、`order-center`、`rule-center`、`cust-center` 时，分别读取数据库中对应智能体的 `project_dir`。
- 智能体没有配置 `project_dir` 时显示空状态。
- 主控智能体不做多工程聚合，避免第一版信息过载；用户可显式切换到某个工程智能体。

## Backend Design

新增后端 Workspace 只读服务，并由 FastAPI 暴露接口：

```text
GET /api/agents/{agent_id}/workspace/summary?conv_id={conv_id}
GET /api/agents/{agent_id}/workspace/changes?conv_id={conv_id}
GET /api/agents/{agent_id}/workspace/tree?path={relative_path}
GET /api/agents/{agent_id}/workspace/file?path={relative_path}
GET /api/agents/{agent_id}/workspace/evidence?conv_id={conv_id}
```

`WorkspaceService` 负责路径校验、Git 读取、目录读取和 trace 提取：

- 从 `AgentService.get(agent_id)` 读取 `project_dir`。
- 将请求路径转成绝对路径后再 `resolve()`，并要求结果仍位于工程根目录内。
- 使用列表参数调用 Git 子进程，不经过 shell。
- Git 子进程设置超时，单文件 diff 和目录列表有最大返回限制。
- 返回结构保持现有 `ApiResponse` 风格。

`summary` 和 `changes` 返回 Git 分支、仓库状态和标准化文件列表。`file` 返回文本内容、语言后缀、截断标记；二进制文件返回明确错误。`evidence` 从 `trace_logs` 读取当前 `conv_id` 和 `agent_id` 的 `code` / `rag` 阶段记录。

需要在工具分发处补齐少量可观测信息：

- `code_search` trace message 记录命中文件数量。
- `rag_search` 新增 trace，记录查询和结果数量。
- 现有 `code_read` 和自动预读取 trace 保持兼容。

## State And Refresh

前端打开会话或切换智能体时加载 Workspace summary。发送消息后，收到 `sub_agent` 完成事件或流结束时刷新 Changes 和 Evidence；流式过程中不做高频 Git 轮询。Changes、Project、Evidence 各自维护加载、空态和错误态。

右侧面板保留可拖拽宽度和折叠能力，默认宽度约 340px，最小 260px，最大 520px。

## Error Handling

| 场景 | 行为 |
| --- | --- |
| 智能体未配置工程目录 | 显示未绑定工程空状态 |
| `project_dir` 不存在 | 显示工程目录不可用 |
| 目录不是 Git 仓库 | Changes 显示非 Git 工程；Project/Evidence 正常 |
| Git 未安装或执行超时 | Changes 显示局部错误，不阻塞其他页签 |
| 路径逃逸或不存在 | 返回 4xx ApiResponse 错误 |
| 大仓库 | 目录、变更和 diff 限量返回，并标记 truncated |

## Security

Workspace 是只读能力：

- 不提供创建、修改、删除文件接口。
- 不提供 Git 写操作或执行命令接口。
- 所有相对路径必须在当前智能体 `project_dir` 内。
- Git 命令只允许 status、branch、diff、log 类只读读取。

## Testing

### Backend

- `project_dir` 缺失或不存在时返回稳定空态。
- 路径逃逸被拒绝。
- Git 变更解析覆盖 modified、untracked、deleted、renamed。
- 非 Git 工程返回明确状态。
- 文件预览限制在工程根目录内。
- Evidence 能按会话和智能体过滤 `code_read`、`code_search`、`rag_search`。

### Frontend

- 三页签切换保持独立加载状态。
- 当前智能体变化时右侧工程上下文刷新。
- Changes 文件点击后展示 diff。
- 未绑定工程显示空状态。
- Evidence 不会渲染成修改文件。
