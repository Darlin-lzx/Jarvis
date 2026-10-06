# Chat Assignment And Default Conversation Design

## Goal

Make the top agent tabs actionable, use Chinese filenames for newly generated deliverables, and make global conversation creation land in a server-guaranteed default space with the same chat page used from a space.

## Behavior

1. Agent tabs are selection controls. Clicking an enabled tab assigns that agent to the next message; switching is disabled while a stream is active.
2. New artifact files use Chinese display names, such as `评估报告.md`, `迁移方案.md`, and `转换脚本_对象.sql`. Existing files are not renamed.
3. `ProjectService` idempotently guarantees a space named `默认空间`.
4. The sidebar primary action becomes `新建会话`. It creates a conversation in the default space and immediately opens the normal `ChatView`, matching the space-entry path.
5. Quick QA remains a separate temporary mode.

## Verification

Backend tests cover idempotent default-space creation, the default-space API, and Chinese report/SQL filenames. Frontend Node tests cover assignment semantics and historical artifact filtering. Vite build verifies component integration.
