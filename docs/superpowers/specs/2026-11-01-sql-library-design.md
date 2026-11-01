# 数据源 SQL 库设计（SQL 查询页）

日期：2026-11-01
状态：已评审通过，待实现

## 背景与目标

SQL 查询页目前每次都要手写 SQL。日常高频场景（按客户订单号查 `his_HALL_TASK`、
`his_HALL_TASK_FLOW_INS` 等）重复输入成本高。目标：

- 每个数据源绑定一个 SQL 文件，文件内放常用 SQL；
- 选中数据源即加载对应文件，点选某条 SQL 即可执行；
- SQL 支持 `{param}` 参数占位符，执行时填参替换。

对齐旧工具平台（tool_platform）按数据源组织 SQL 脚本库的模式，轻量实现。

## 关键决策（已确认）

| 决策点 | 结论 | 否备选 |
| --- | --- | --- |
| 存储位置 | 服务器目录 `data/sql_library/<数据源名>.sql`，前端编辑器读写 | 存 Jarvis 库表 / 仅浏览器本地 |
| 参数占位 | 支持 `{param}`，执行时弹框填参替换 | 纯回填不替换 |
| 绑定关系 | 数据源 ↔ 单文件，文件名即绑定（约定优先，零 schema 变更） | `data_sources` 加 `sql_file` 列 |

## 文件格式

`-- name: 名称` 注释分段，一段一条 SQL；无标记的文件整体为一条「未命名」。
不按分号切分（避免切断字符串/函数体内的分号）。首个标记前的非空内容单独算一条未命名。

```sql
-- name: 历史工单查询
SELECT * FROM ORDER4.his_HALL_TASK WHERE CUST_ORDER_ID = '{cust_order_id}';

-- name: 历史流程实例
SELECT * FROM ORDER4.his_HALL_TASK_FLOW_INS WHERE CUST_ORDER_ID = '{cust_order_id}';
```

## 后端设计

新模块 `jarvis_agent/sql_library.py`，纯函数 + Path 注入，不依赖 DB：

- `safe_name(datasource)`：数据源名 → 安全文件名。仅保留 `\w` 与 `-`，其余替换为 `_`
  （点号被替换，天然杜绝路径穿越）；空/全替换后为空报 `ValueError`。
- `parse_statements(content)` → `[{name, sql}]`：按 `-- name:` 正则分段，规则见上。
- `library_dir` 解析：`cfg.sql_library_dir`（新增配置，环境变量 `JARVIS_SQL_LIBRARY_DIR`），
  缺省 `<db_path 所在目录>/sql_library`（即 `data/sql_library`）。
- `list_library(dir)` → `[{datasource, statement_count, updated_at}]`，扫描 `*.sql`，按名称排序。
- `get_file(dir, datasource)` → `{datasource, content, entries, exists}`（读时即解析出 entries）。
- `save_file(dir, datasource, content)`：UTF-8 编码后 ≤ 256KB；目录不存在自动创建；tmp+rename 原子写。

API（`app.py`，自动走现有登录鉴权中间件，只读执行复用现有 `/api/datasources/{name}/query`）：

- `GET /api/sql-library` → 文件列表
- `GET /api/sql-library/{datasource}` → 内容 + 解析条目
- `PUT /api/sql-library/{datasource}` → 保存，body `{"content": "..."}`

生命周期联动：数据源改名接口同步 rename 对应文件；删除数据源不删文件（保用户数据）。
参数替换在前端完成，后端不感知参数概念。

## 前端设计（sql-panel.tsx）

数据源下拉选中后，编辑器卡片下方渲染「SQL 库」卡片：

- 列表每行：条目名称 + SQL 首行摘要（单行截断）；
- 点击行：检测 `{param}`（正则 `\{([A-Za-z_]\w*)\}`）→ 有参数则弹参数填写框
  （空值拦截；每个参数按 `数据源+条目名+参数名` 记住上次值于 localStorage），
  填完替换 → 回填编辑器并自动执行；无参数直接回填执行；
- 每行「编辑」图标 + 卡片常驻「编辑文件」入口 → 展开整文件 textarea + 保存/收起；
- 无绑定文件时显示提示与「新建 <数据源名>.sql」按钮（写入带示例模板的初始内容）。

`run()` 重构为可接受 SQL 覆盖参数，避免 setState 时序问题。

## 错误处理

- 非法文件名 / 路径穿越：后端 400（`ValueError` → `HTTPException`）；
- 文件超 256KB：保存拒绝并提示；
- 参数留空：前端拦截，不执行；
- 保存不做 SQL 语法校验（只有执行才有意义）；
- 并发写不加锁，最后写入生效（小团队场景）。

## 测试

- 后端 `tests/test_sql_library.py`：`parse_statements`（有标记 / 无标记 / 空文件 / 首标记前有内容）、
  `safe_name`（中文、`/`、`..`、空串）、save/get 往返、列表排序、256KB 上限、tmp 原子写不留残片。
- 前端 `tests/sql-panel.test.ts`：源码断言（SQL 库列表渲染、参数替换流程、localStorage 记忆、
  编辑保存调用 PUT、API client 覆盖三个端点）。
- 回归：`tsc --noEmit`、`npm run build`、后端 pytest 全量不新增失败。
