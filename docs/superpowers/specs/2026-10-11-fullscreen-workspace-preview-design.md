# Fullscreen Workspace Preview Design

## Summary

会话页的工程文件与差异预览从右侧 Workspace 栏底部的固定 48% 区域，升级为覆盖会话页的沉浸式全屏预览层。右侧 Workspace 保留 Changes / Project / Evidence 导航职责，不再承载内嵌文件内容。

## User Experience

点击以下入口时打开全屏预览：

- 聊天正文中的 `path` / `path:line` 文件引用。
- Workspace Changes 中的变更文件。
- Workspace Project 中的文件。
- Workspace Evidence 中可打开的读取记录。

预览层覆盖整个会话区域，顶部为紧凑工具栏，显示文件路径、目标行号与关闭按钮；正文占满剩余空间，可横向和纵向滚动。普通文件显示行号；从 `path:line` 打开时高亮目标行并自动滚动到该行。Git diff 继续 unified diff 展示。

关闭方式为点击关闭按钮或按 Esc。关闭后回到原聊天滚动位置，不切换当前 Agent、Workspace 页签或会话。

右侧 Workspace 的文件列表区域不再被预览压缩，导航和浏览高度随之增加。

## Frontend Design

在 `WorkspacePanel` 中将现有内嵌 preview 区域替换为全屏 overlay 组件：

- 预览状态继续包含 `WorkspaceFile | WorkspaceDiff`。
- `openFile` 与 `openChange` 保持现有 API 调用，只负责加载内容并打开 overlay。
- `openFileRequest` 继续自动展开 Workspace、切换 Project 页签并定位行号。
- 行号高亮与滚动逻辑复用现有 `data-line` 实现。
- overlay 挂载时监听键盘 Esc，卸载时移除监听。

后端接口与数据结构不变。

## Error Handling

API 请求失败时不打开空预览层，保留现有静默失败行为。预览层关闭时清空当前预览与目标行号，避免残留上一个文件的高亮状态。

## Testing

- Workspace 面板不再包含固定 48% 内嵌预览容器。
- 预览 overlay 使用全屏布局、工具栏和可滚动正文。
- 普通文件保留行号渲染与 `data-line` 定位。
- 聊天文件引用仍通过 `openFileRequest` 打开预览。
- Esc 与关闭按钮都会清理预览状态。
