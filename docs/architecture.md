# 数据库国产化智能体 - 工程架构设计文档

> 本文档以**代码实现为准**编写（最后核对：2026-10-03，对应 `db_loc_agent` 工程当前工作区状态）。
> 与代码不一致时以代码为准；文末第 13 章集中列出「已知不一致与注意事项」。

## 1. 项目概述

**数据库国产化智能体** 是一个基于 LLM 的多智能体（Multi-Agent）系统，专注于帮助用户完成数据库从 Oracle、MySQL、SQL Server 等传统数据库向国产数据库（达梦 DM、人大金仓 KingBase、华为 GaussDB、OceanBase 等）的迁移工作，并覆盖迁移后的运维与数据治理。

### 1.1 核心能力

| 能力 | 说明 | 对应 Agent |
|------|------|-----------|
| 迁移总调度 | 识别需求环节、拆解任务、串联子 Agent、汇总完整迁移方案 | `migration_commander` |
| 迁移评估 | 分析源库对象清单与表结构，输出兼容性/风险/工作量评估报告 | `migration_assessor` |
| DDL/DML 转换 | 将源库 SQL 语法转换为目标国产库语法 | `ddl_converter` |
| 代码改造 | 分析 JDBC/ORM/存储过程代码，输出适配改造建议 | `code_migrator` |
| 迁移验证 | 校验转换后 SQL 语法与源目标结构一致性，输出失败清单 | `migration_verifier` |
| 自然语言查数 | 结合知识库问答，可对已接入数据源生成并执行**只读** SQL | `nl2sql_qa` |
| 运维监控 | 健康巡检、慢 SQL 诊断、性能基线与超标告警 | `ops_monitor` |
| 数据治理 | 元数据资产目录、数据质量评分、图谱同步 | `gov_manager` |

### 1.2 技术栈（实际版本）

| 层级 | 技术选型 |
|------|----------|
| 前端 | Vite 8 + React 19 + TypeScript 6 + Tailwind CSS 3 + shadcn/ui（Radix UI 子集）+ lucide-react + react-markdown |
| 后端 | Python 3.13 + FastAPI + LangGraph + LangChain |
| LLM | Ollama（本地）/ DeepSeek / 阿里云百炼（OpenAI 兼容模式） |
| 向量检索 | **FAISS**（`IndexFlatIP` 内积 + L2 归一化，等价余弦相似度） |
| 业务数据库 | SQLite（SQLAlchemy 2.0 ORM，经连接串可切 MySQL） |
| 数据源接入 | SQLite / MySQL / PostgreSQL / Oracle / DM / KingBase / GaussDB |
| 前端构建产物 | `web-ui/dist`（已构建） |

关键运行依赖（`.venv` 实测）：`faiss-cpu 1.15.1`、`numpy 2.5.3`、`langgraph 1.2.12`、`langchain 1.4.2`、`langchain-openai 1.6.6`、`langchain-ollama 1.1.0`、`fastapi 0.141.1`、`SQLAlchemy 2.1.1`、`PyMySQL 1.2.3`、`pypdf`、`python-docx`、`openpyxl`。

---

## 2. 系统架构

### 2.1 整体架构图

```
+-------------------------------------------------------------------+
|                        前端 SPA (web-ui/dist)                     |
|   对话界面 (SSE 流式 / 动态表单 / 引用)   工作台 (知识/智能/数据)    |
|   项目空间 (空间-子系统-任务)             产物交付 (报告/SQL/JSON)  |
+--------------------------------+----------------------------------+
                                 | HTTP / SSE
                                 v
+-------------------------------------------------------------------+
|                        后端 (FastAPI · app.py)                    |
|   /api/chat/stream (SSE)  +  ~70 个 REST 路由                     |
|   安全网关中间件: API Key 鉴权 + 分钟级限流 + 审计落库             |
+--------------------------------+----------------------------------+
                                 v
+-------------------------------------------------------------------+
|               LangGraph 主图 (graph.py · GraphRuntime)             |
|                                                                   |
|   parse --> route --> execute --> artifact --> reply              |
|   意图解析   路由决策   Agent执行/工具循环  产物生成    回复输出     |
+--------------------------------+----------------------------------+
                                 v
+-------------------------------------------------------------------+
|                            服务层                                  |
|  AgentService  RAGStore  KnowledgeGraph  SkillService             |
|  DbTools  GovService  OpsService  ArtifactService  PromptService   |
|  ProjectService  Attachment  MySQLAgentService  SecurityGateway    |
+--------------------------------+----------------------------------+
                                 v
+-------------------------------------------------------------------+
|                            数据层                                  |
|  SQLite (业务数据)   FAISS (向量索引)   文件系统 (artifacts/skills) |
+-------------------------------------------------------------------+
```

### 2.2 核心流程图

```
用户输入 (+ 附件 / @ 引用)
  |
  v
+-------------------------------------------------------------+
| parse 节点：LLM 解析意图为结构化 JSON                         |
| { intent, agent_id, object_name, source_db, target_db,      |
|   skill_id, params, confidence }                            |
+--------------------------+----------------------------------+
                           v
+-------------------------------------------------------------+
| route 节点                                                   |
| - 前端已指定 agent_id -> 直接采用（route_reason 记录来源）    |
| - 否则按 intent 解析；confidence < 0.5 或 intent 未知         |
|   -> 回退 nl2sql_qa（不自由发挥）                            |
| - 组装提示词：Agent 提示词（prompts 表 category=agent 覆盖）  |
|   + 系统角色提示词前置（type=system_role 且启用）             |
| - RAG 检索注入（rag_top_k=4）+ KG 一跳扩展注入               |
+--------------------------+----------------------------------+
                           v
+-------------------------------------------------------------+
| execute 节点：构建 system prompt + 工具调用循环（max 3 轮）   |
|                                                             |
| system = Agent提示词 + 目标库 + 引用块 + RAG块 + 技能块       |
|        + 可用技能清单 + 数据源信息 + KG块                    |
|        + 任务状态块（仅 migration_commander）                 |
|        + UI_FORM_RULE（全局交互式表单规则）                  |
|                                                             |
| 工具：rag_search / use_skill / db_schema / db_query /        |
|      db_explain / call_agent / ops_health / ops_slow_sql /   |
|      ops_baseline / gov_catalog / gov_quality / gov_kgsync   |
+--------------------------+----------------------------------+
                           v
+-------------------------------------------------------------+
| artifact 节点：仅 gen_artifact=True 的 Agent 落盘            |
| namespace = sess_{conv_id}/{agent_id}/{object_name}/{stamp}  |
| 产出：result.json + DDL_<OBJECT>.sql + <报告>.md             |
+--------------------------+----------------------------------+
                           v
+-------------------------------------------------------------+
| reply 节点：返回最终回复（SSE 逐 token 流式下发）             |
+-------------------------------------------------------------+
```

---

## 3. 后端模块设计

### 3.1 模块清单

| 模块 | 文件 | 职责 |
|------|------|------|
| **app.py** | FastAPI 应用入口（约 88KB 单体） | REST API + SSE 流式对话 + 引用/附件注入 + 静态文件服务 + 安全中间件 |
| **graph.py** | LangGraph 主图（约 45KB） | parse → route → execute → artifact → reply；工具调用循环；多 Agent 编排；任务状态注入 |
| **agents.py** | Agent 注册中心 | 8 个内置 Agent 定义 + DB `agents` 表覆盖/扩展 + 集群元数据 |
| **llm.py** | LLM 工厂 | Ollama / DeepSeek / 百炼适配 |
| **embedding.py** | Embedding 工厂 | Ollama `/api/embeddings` / 百炼 `/compatible-mode/v1/embeddings` |
| **rag.py** | RAG 知识库 | 文档分块 + FAISS 向量化 + 检索（含维度不匹配自动重建） |
| **kg.py** | 知识图谱 | 规则式实体/关系提取 + 一跳扩展 + 实体匹配 |
| **db_tools.py** | 数据源工具 | 数据源 CRUD + 连接串构建 + Schema 探查 + 只读查询/执行计划 |
| **gov.py** | 数据治理 | 资产目录抽取 + 质量评分 + 图谱同步 |
| **ops.py** | 运维监控 | 健康巡检 + 慢 SQL 诊断 + 性能基线/告警 |
| **skills.py** | 技能管理 | SKILL.md 解析 + SQLite 索引 + 沙箱脚本执行 + 技能链 |
| **artifacts.py** | 产物管理 | namespace 校验 + 产物写入 + 越界防护 |
| **attachments.py** | 附件处理 | `+` 上传 / `@` 引用的文本抽取（md/sql/ddl/txt/pdf/docx/xlsx） |
| **project.py** | 项目服务 | 空间 - 子系统 - 任务 三级归属 CRUD 与统计 |
| **prompts.py** | 提示词服务 | 提示词 CRUD（system/router/agent）+ 系统角色绑定校验 |
| **security.py** | 安全网关 | API Key 鉴权 + 分钟级固定窗口限流 + 审计日志 |
| **config.py** | 配置管理 | `config.yaml` 加载 + 代码默认值 |
| **db.py** | 数据模型 | SQLAlchemy ORM 全量模型 + 建表 + 轻量列迁移 + `TaskService` |

### 3.2 LangGraph 主图（graph.py）

#### AgentState 状态定义

```python
class AgentState(TypedDict, total=False):
    user_input: str                 # 用户输入
    conv_id: int                    # 会话 ID
    history: List[Dict[str, str]]   # 历史对话（取最近 10 条注入）
    parse_result: Dict[str, Any]    # 意图解析结果
    route_reason: str               # 路由决策说明
    rag_context: List[Dict]         # RAG 检索结果
    kg_context: List[Dict]          # 知识图谱一跳扩展结果
    agent_id: str                   # 当前 Agent ID
    prompt_text: str                # Agent 提示词
    skill_id: str                   # 用户指定的技能 ID
    reply: str                      # 最终回复
    artifacts: List[Dict]           # 生成的产物列表
    namespace: str                  # 产物 namespace
    skill_calls: List[Dict]         # 技能调用记录
    agent_calls: List[Dict]         # 子 Agent 调用记录
    error: str                      # 错误信息
    extra_context: str              # @ 引用 / + 上传 注入的额外上下文（最高优先级）
    task_state: Dict                # 会话级任务状态 {current_step, task_params}
```

#### 节点流程

| 节点 | 函数 | 职责 |
|------|------|------|
| **parse** | `GraphRuntime.parse()` | 调用 LLM 输出结构化 JSON 解析意图 |
| **route** | `GraphRuntime.route()` | 路由到 Agent；组装提示词；RAG + KG 注入 |
| **execute** | `GraphRuntime.execute()` | 构建 system prompt，工具调用循环（`max_iterations=3`） |
| **artifact** | `GraphRuntime.artifact()` | 落盘 `result.json` / `DDL_*.sql` / 报告 md |
| **reply** | 恒等函数 | 透传 state 并结束 |

图的边为直线串联：`parse → route → execute → artifact → reply → END`，无条件分支（路由决策在 `route` 节点内部完成）。

#### 暴露给 LLM 的工具

| 工具 | 说明 | 暴露条件 |
|------|------|----------|
| `rag_search` | 检索知识库获取迁移/语法资料 | 始终 |
| `use_skill` | 调用已启用技能并执行其脚本/技能链 | 始终 |
| `db_schema` | 探查数据源表/视图/列结构 | 已归属空间且配了数据源 |
| `db_query` | 只读 SELECT/WITH 查询（最多 100 行） | 同上 |
| `db_explain` | 只读语法校验/执行计划 | 同上 |
| `call_agent` | 委派其他已启用 Agent（默认排除自身，避免自循环） | 多 Agent 场景（指挥官另有硬闸门，见 3.4） |
| `ops_health` / `ops_slow_sql` / `ops_baseline` | 健康巡检 / 慢 SQL / 性能基线 | 配了数据源 |
| `gov_catalog` / `gov_quality` / `gov_kgsync` | 资产目录 / 质量评分 / 图谱同步 | 始终 |

### 3.3 Agent 注册中心（agents.py）

#### 内置 Agent 定义（8 个）

| Agent ID | 名称 | Intent | 类型 | 产物 |
|----------|------|--------|------|------|
| `migration_commander` | 迁移指挥官 | `migration_overall` | **主 Agent（commander）** | 总迁移方案.md, result.json |
| `migration_assessor` | 迁移评估专家 | `migration_assess` | 子 Agent | assessment_report.md, result.json |
| `ddl_converter` | SQL 转换助手 | `ddl_convert` | 子 Agent | DDL_&lt;OBJECT&gt;.sql, convert_report.md, result.json |
| `code_migrator` | 代码改造助手 | `code_migrate` | 子 Agent | migration_guide.md, result.json |
| `migration_verifier` | 迁移验证助手 | `migration_verify` | 子 Agent | verify_report.md, result.json |
| `nl2sql_qa` | 知识问答助手 | `nl2sql` | 子 Agent | answer.md, result.json |
| `ops_monitor` | 运维巡检助手 | `ops_inspect` | 子 Agent | ops_report.md, result.json |
| `gov_manager` | 数据治理助手 | `gov_assess` | 子 Agent | governance_report.md, result.json |

#### 集群编排关系

```python
_CLUSTER_ROLE = {"migration_commander": "commander"}
_CLUSTER_SUB_AGENTS = {
    "migration_commander": ["migration_assessor", "ddl_converter", "code_migrator",
                            "migration_verifier", "ops_monitor", "gov_manager"],
}
```

指挥官通过 `call_agent` 工具委派子 Agent（如「评估 → 转换 → 验证」串行）。委派时向前端推送 `calling_agent` / `sub_agent` 事件，用于渲染「正在调用子 Agent」与子 Agent 独立消息气泡。

#### 统一输出约束

`OUTPUT_FORMAT_RULES` 追加到所有内置 Agent 的默认提示词：禁止重复能力介绍、Markdown 结构化排版、四段式（【分析结果】【风险】【输出文件】【下一步建议】）、产物在【输出文件】列名、关键词加粗。

#### 配置优先级

```
prompts 表（category=agent，按 name == agent_id 命中，取最后一条启用项）
  > agents 表 default_prompt
    > agents.py 内置 default_prompt
```

系统角色提示词（`prompts.type == "system_role"` 且启用）会**前置**拼接到上述结果之前；未绑定/未启用则静默跳过。

### 3.4 会话级任务状态机（迁移指挥官专用）

这是「主 Agent 不再失忆」的关键机制，分布在 `app.py` 与 `graph.py`：

**状态存储**：`conversations.task_state`（TEXT，JSON），持久化 `{current_step, task_params, last_warning}`。

**采集步骤**：

```
step1 选择源数据源 → step2 选择目标数据源(≠源) → step3 确认 → complete 可执行
```

**后端确定性推进（不依赖 LLM）**：`app.py` 每轮从用户输入解析形如 `source_data_id：本地` / `task_confirm：确认` 的键值对（正则 `_TS_PARAM_RE`，仅接受 `source|target|task_confirm|datasource` 前缀键），经 `_derive_next_step()` 推导下一步：

| 条件 | 结果 |
|------|------|
| `task_confirm` ∈ 确认词集 | `complete` |
| `task_confirm` ∈ 返回修改词集 | 清空目标数据源，回退 `step2` |
| 目标数据源 == 源数据源 | **后端拦截**，清除无效目标，置 `step2_conflict` 并写 `last_warning` |
| 有目标数据源 | `step3` |
| 仅有源数据源 | `step2` |
| 都没有 | `step1` |

**LLM 侧配合**：`graph.py` 每轮把状态块注入指挥官 system 上下文（当前步骤、已收集参数、当前动作指引、推进规则），模型通过 `<TASK_STATE>{...}</TASK_STATE>` 声明块回写状态。`<UI_RENDER>` / `<TASK_STATE>` 块会在流式下发时从正文**整体剥离**，用户不可见。

**硬闸门**：`execute` 中仅当 `current_step == "complete"` 时才向 LLM 暴露 `call_agent` 工具 —— 从工具层保证「用户确认后才允许创建任务链路调用评估专家」。

### 3.5 交互式表单（UI_RENDER）

`graph.py` 的 `UI_FORM_RULE` 追加到**所有** Agent 的 system 提示词（不受 DB 提示词覆盖影响），要求模型在需要用户补充带候选选项的信息时输出：

```html
<UI_RENDER>
{"title": "请选择数据源", "fields": [
  {"name": "datasource", "label": "数据源", "type": "select",
   "options": ["{{system_data_source_list}}"]}
], "submit": "确认选择"}
</UI_RENDER>
```

- 前端 `ui-form.tsx` 渲染为可交互表单，支持 `text / textarea / number / select / checkbox / radio`。
- 系统占位符 `{{system_data_source_list}}` 由 `app.py::_resolve_ui_placeholders()` 替换为真实启用数据源名称（精确匹配替换为数组，文本内嵌替换为顿号拼接）。
- 若 `select/radio` 的 options 为空且字段名/标题含「数据源 / datasource / source」，后端兜底填入启用数据源，避免前端显示「暂无可选项」。

### 3.6 RAG 知识库（rag.py）

**处理流程**：`文档上传 → 类型识别 → 分块 → Embedding → FAISS 索引 → 检索`

| 文档类型 | 分块策略 |
|----------|----------|
| Markdown (`md`) | 按标题分块，每块 ≤1200 字符 |
| SQL (`sql`) | 按 CREATE 语句分块 |
| 文本 (`txt`) | 滑动窗口，800 字符/块，80 字符重叠 |
| PDF (`pdf`) | 逐页提取文本后按文本分块 |

**检索**：`IndexFlatIP` + L2 归一化；`_settle_index()` 在查询向量维度与索引不一致时自动重建，避免 FAISS 维度断言崩溃；embedding 服务不可用等异常时**安全降级返回空列表**，不阻断对话。

### 3.7 知识图谱（kg.py）

**规则式提取**（不依赖 LLM）：

| 规则 | 提取内容 |
|------|----------|
| `CREATE TABLE` | 表实体（etype=table） |
| `REFERENCES t(c)` | `表 REFERENCES 表`、`表 HAS_COLUMN 列` |
| 中文关系句式 | 「A 兼容/支持/等价于/对应/包含/基于/使用/提供 B」→ (A, 兼容, B) |
| SQL 大写标识符 | `A-Z0-9_` 且 ≥2 字符，etype=object（仅 source_type=sql） |

**能力**：`build_from_documents()` 清空后全量重建；`match_entities()` 在 RAG 语料中做子串命中取候选；`expand()` 返回一跳邻居三元组（subject/object LIKE 命中）注入 system prompt 辅助多跳推理。

### 3.8 技能系统（skills.py）

**目录结构**：

```
data/skills/{skill_id}/
├── SKILL.md          # YAML frontmatter(name/description/script/chain) + Markdown 内容
└── scripts/          # 可选脚本目录
```

**沙箱安全措施**：

| 措施 | 实现 |
|------|------|
| 脚本路径约束 | 仅允许 `scripts/<脚本名>`，禁止含路径分隔符 |
| Python 静态校验 | AST 解析，禁止 import `socket/http/urllib/requests/subprocess/shutil`，禁止 `os.system/popen/run/call` |
| 资源限制 | 超时 30s（`DEFAULT_TIMEOUT`）；子进程 RSS/AS 上限 512MB |
| 输出截断 | stdout/stderr 各截断 20000 字符 |
| 环境变量最小化 | 仅保留 `PATH/HOME/USER/LANG/LC_ALL/TZ`，并剔除值以 `API_/KEY/SECRET/TOKEN/PASSWORD/PRIVATE` 开头的变量 |
| 进程隔离 | `start_new_session=True`，独立进程组 |

**技能链**：frontmatter 的 `chain: a,b` 声明顺序执行；中间上下文写入 `.chain-{skill_id}.json`，子脚本通过 `CHAIN_CTX_FILE` 环境变量读取上游结果；仅允许注入 `CHAIN_` 前缀的环境变量；任一步失败即中断。

### 3.9 数据源工具（db_tools.py）

**安全边界**：

- 仅允许 `SELECT` / `WITH` 开头语句；黑名单关键字 `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/MERGE/REPLACE/ATTACH/DETACH/VACUUM`
- SQLite 强制只读 URI：`sqlite:///file:{path}?mode=ro&uri=true`（防写、防新建）
- 其他方言：连接后开启事务，**统一 `rollback()`**，从机制上只读
- 单次查询最大返回 100 行（`QUERY_ROW_LIMIT`，可传参上限 500）
- 单格最大展示 500 字符（`QUERY_CELL_LIMIT`，超出加省略号）
- `explain()` 走 `EXPLAIN QUERY PLAN`（失败回退 `EXPLAIN`），不返回数据

**支持方言与默认端口**：

| kind | 驱动 / 连接串 | 默认端口 |
|------|---------------|----------|
| `sqlite` | `sqlite:///file:...?mode=ro` | - |
| `mysql` | `mysql+pymysql` | 3306 |
| `postgresql` | `postgresql+psycopg2` | 5432 |
| `kingbase` | `postgresql+psycopg2` | 54321 |
| `gaussdb` | `postgresql+psycopg2` | 8000 |
| `oracle` | `oracle+oracledb`（service_name） | 1521 |
| `dm` | `dm+dmPy` | 5236 |

**连接串格式**：远程库 `host:port/database`（如 `127.0.0.1:3306/nexusdb`）；SQLite 为文件路径；可选 `dsn` 完整串优先级最高。

**观测挂钩**：`db_tools.obs_query` 由 app.py 绑定到 `ops.record_query`，查询耗时 ≥500ms 自动落 `slow_queries`。

### 3.10 数据治理（gov.py）

- `catalog()`：逐数据源抽取表/视图元数据落 `gov_assets`。出于只读边界与性能考虑，**仅 SQLite 统计行数**（`COUNT(*)`，上限 999999），其他方言只记录列定义与主键。
- `quality()`：对表评分 —— `filled_rate`（前 3 列平均非空率）、`unique_rate`（主键去重率，无主键用首列粗估）、`null_rate`（最空列空值率）；综合分 `score = 0.5*filled + 0.3*unique + 0.2*(100-null)`；空值 >5% 或存在重复主键时写入 `issues`。
- `kg_sync()`：把资产目录的表/列同步为 KG 实体，以及 `数据源 HAS_OBJECT 表`、`表 HAS_COLUMN 列` 关系（幂等）。

### 3.11 运维监控（ops.py）

| 能力 | 实现 |
|------|------|
| 健康巡检 | 对指定/全部启用数据源执行 `SELECT 1` 探活，记录延迟与失败原因，每次落 `ops_checks` |
| 慢 SQL 诊断 | 由 `db_tools` 查询回调写入；`slow_queries()` 按阈值（默认 500ms）与耗时倒序返回 |
| 性能基线 | 按数据源聚合慢查询（样本数/均值/最大）与探活延迟；告警条件：慢查询最大耗时 > 阈值，或探活最大延迟 > 1000ms |

### 3.12 产物管理（artifacts.py）

- **namespace 格式**：`{conv_key}/{agent_id}/{object_name}/{timestamp}`，如 `sess_17/ddl_converter/USER_ORDER/20260928T202738`
- 每段需匹配 `^[A-Za-z0-9_-]{1,128}$`（`SEGMENT_RE`），否则抛 `NamespaceError`
- 写入与读取均做**目录越界校验**（`resolve()` 后必须以 `artifact_root` 为前缀）
- 文件名禁止含 `/`、`\`、`.`、`..`
- 落盘同时写 `artifacts` 表记录，并从会话反向继承 `space_id / sub_system_id / task_id`
- 产物内容：`result.json`（agent_id / intent / object_name / reply / rag_refs）+ 从回复中提取的 ```sql 代码块（`DDL_<OBJECT>.sql`）+ 剥离代码块后的正文（报告名取 Agent `output_files` 中首个不含 `<` 的 `.md`）

### 3.13 附件处理（attachments.py）

| 项 | 说明 |
|----|------|
| 支持扩展名 | `md / markdown / sql / ddl / txt / pdf / docx / xlsx / xls` |
| 大小上限 | 10MB（调用方保证） |
| 文本解码 | utf-8 → gbk → latin-1 依次回退 |
| `.xls` 旧格式 | 不支持解析，返回友好中文提示「请另存为 .xlsx」 |
| `.xlsx` 解析 | 最多 200 行 / 5000 单元格 |
| 自动入库 | 上传接口 `auto_import=1` 且带 `space_id` 时，解析文本写 `.txt` 后走 `rag.add_document` 入库，并返回 `kb_doc_id` |

### 3.14 安全网关（security.py + app.py 中间件）

| 功能 | 实现 |
|------|------|
| API Key 鉴权 | `X-API-Key` 或 `Authorization: Bearer <key>`；`api_key` 为空则**关闭鉴权**（默认关闭） |
| 限流 | 固定窗口（60s）按 IP 计数，`rate_limit=0` 关闭（默认关闭） |
| 审计日志 | 中间件对 `/api/*` 记录 方法/路径/IP/状态码/耗时到 `security_logs`；被拒请求记录 `deny:<reason>` |
| SQL 审计 | `db_tools.audit` 挂钩，记录只读放行与拦截原因 |

拦截响应：`401`（invalid_api_key）/ `429`（rate_limited）。

### 3.15 LLM / Embedding 适配

| 提供商 | 实现 | 默认模型 / 端点 |
|--------|------|-----------------|
| Ollama | `langchain_ollama.ChatOllama` | `qwen2.5`，`http://localhost:11434` |
| DeepSeek | `langchain_openai.ChatOpenAI` | `https://api.deepseek.com/v1` |
| 百炼 | `langchain_openai.ChatOpenAI` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

Embedding：Ollama `POST /api/embeddings`；百炼 `POST /compatible-mode/v1/embeddings`（默认 `text-embedding-v3`）。

### 3.16 模型管理（ModelDef）

`models` 表持久化 LLM/Embedding 模型配置（名称、标识、类型、提供方、状态、API 地址/密钥、版本、超时、max_tokens、调用统计、被引用 Agent）。首次查询时幂等写入 4 条内置模型（通义千问4 / 本地DeepSeek / GLM-4 / 向量化模型v1）。

> 注意：该模块是**配置管理界面**，对话运行时仍由 `config.yaml` 的 `llm` 段决定实际模型（见 13.4）。

### 3.17 MCP（预留）

已完成 `mcp_servers` 表的 CRUD；`POST /api/mcp/servers/{rid}/test` 仅对 `command_or_url` 发一次 3 秒超时的 `httpx.get` 判断可达性。**尚未接入 Agent 执行流程**（未初始化 MCP 客户端、未注入工具列表）。

---

## 4. 数据模型

### 4.1 数据库表结构（共 23 张）

| 表名 | 模型类 | 说明 |
|------|--------|------|
| `conversations` | Conversation | 会话（含 agent_id / space_id / sub_system_id / task_id / **task_state**） |
| `messages` | Message | 对话消息（user/assistant/tool） |
| `chat_trace` | ChatTrace | 步骤级追踪（parse/route/execute/skill/artifact/reply/error） |
| `prompts` | Prompt | 提示词（category: system/router/agent；type: system_role/task_instruction/domain） |
| `agents` | AgentDef | Agent 定义（可配置化扩展，含 system_role_prompt_id） |
| `skills` | Skill | 技能索引 |
| `models` | ModelDef | 模型管理配置（LLM / Embedding） |
| `kb_documents` | DocumentRecord | 知识库文档（含 space_id / sub_system_id） |
| `artifacts` | ArtifactRecord | 产物记录（含 space_id / sub_system_id / task_id） |
| `data_sources` | DataSource | 数据源配置（含 space_id / sub_system_id） |
| `mcp_servers` | MCPRecord | MCP 服务配置（预留） |
| `kg_entities` | KGEntity | 知识图谱实体 |
| `kg_relations` | KGRelation | 知识图谱三元组 |
| `security_logs` | SecurityLog | 安全审计日志 |
| `ops_checks` | OpsCheck | 健康巡检记录 |
| `slow_queries` | SlowQuery | 慢 SQL 记录 |
| `gov_assets` | GovAsset | 治理资产目录 |
| `gov_quality` | GovQuality | 治理质量评分 |
| `spaces` | Space | 业务空间（顶层容器） |
| `space_subsystems` | SpaceSubsystem | 空间内子系统 |
| `project_tasks` | ProjectTask | 业务任务（强绑定空间，可选归属子系统） |
| `tasks` | Task | 会话内子任务编排记录（parent_task_id 依赖、sort_order 顺序） |

### 4.2 核心关系

```
Space 1──N SpaceSubsystem
Space 1──N ProjectTask
SpaceSubsystem 1──N ProjectTask
ProjectTask 1──N Conversation
ProjectTask 1──N ArtifactRecord
Conversation 1──N Message
Conversation 1──N ChatTrace
Conversation 1──N ArtifactRecord
Conversation 1──N Task
AgentDef N──1 Prompt (system_role_prompt_id)
DataSource 1──N GovAsset / GovQuality / OpsCheck
DocumentRecord 1──N KGEntity / KGRelation（来源 doc_name）
```

### 4.3 建表与迁移

`Database.__init__` 调用 `Base.metadata.create_all()` 建表；SQLite 下额外执行两个**幂等轻量迁移**（`_migrate_agents` / `_migrate_project`），用 `ALTER TABLE ADD COLUMN` 补齐存量库缺失列（如 `task_state`、`system_role_prompt_id`、`space_id` 等）。`seed_demo_space()` 幂等预置演示空间「浙江移动国产化」+ 营业系统 / 开通系统。

---

## 5. 前端架构

### 5.1 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Vite | ^8.3.0 | 构建 + 开发服务器 |
| React | ^19.2.8 | UI 框架 |
| TypeScript | ~6.0.2 | 类型安全 |
| Tailwind CSS | ^3.4.19 | 原子化 CSS |
| Radix UI | dialog / label / scroll-area / select / separator / slot / tabs / tooltip | shadcn/ui 基础组件 |
| 其他 | lucide-react、react-markdown、class-variance-authority、clsx、tailwind-merge | 图标 / Markdown / 样式工具 |
| 代码检查 | oxlint | `npm run lint` |

### 5.2 目录结构

```
web-ui/src/
├── App.tsx                       # 根组件（视图切换）
├── main.tsx                      # 入口
├── index.css                     # 全局样式 + CSS 变量
├── assets/hero.png
├── components/
│   ├── chat/
│   │   ├── chat-view.tsx         # 对话主界面
│   │   ├── message.tsx           # 消息气泡
│   │   ├── composer.tsx          # 输入框 + 发送/停止
│   │   ├── agent-tabs.tsx        # 智能体切换
│   │   ├── ui-form.tsx           # UI_RENDER 动态表单渲染
│   │   ├── chain-panel.tsx       # 执行链路（parse/route/skill/agent 节点）
│   │   ├── delivery-panel.tsx    # 产物交付面板（生成中/已保存/已入库）
│   │   ├── artifact-sidebar.tsx  # 产物侧边栏
│   │   ├── reference-picker.tsx  # @ 引用选择器
│   │   ├── convert-to-project-dialog.tsx  # 会话转任务
│   │   └── md-highlight.tsx / welcome-page.tsx
│   ├── layout/                   # sidebar.tsx / top-bar.tsx
│   ├── project/                  # task-list-page / task-detail-page / task-flow-panel
│   │                             # new-task-dialog / attach-task-dialog / task-breadcrumb
│   ├── space/                    # space-detail-panel / sub-system-detail-page
│   ├── settings/settings-dialog.tsx
│   ├── workbench/
│   │   ├── workbench-view.tsx    # 工作台容器
│   │   ├── kb-panel.tsx / kg-panel.tsx / vector-panel.tsx
│   │   ├── agents-panel.tsx / skills-panel.tsx / prompts-panel.tsx
│   │   ├── datasources-panel.tsx / mcp-panel.tsx / models-panel.tsx
│   │   ├── ops-panel.tsx / gov-panel.tsx / security-panel.tsx
│   │   ├── artifacts-panel.tsx / conversations-panel.tsx
│   │   └── workspace-panel.tsx / template-panel.tsx
│   └── ui/                       # badge / button / card / dialog / input / label
│                                 # scroll-area / select / textarea / tooltip
├── hooks/
│   ├── use-chat-stream.ts        # SSE 流式对话 + AbortController 中止
│   ├── use-conversations.ts      # 会话 CRUD + 切换
│   └── use-health.ts             # 健康检查
└── lib/
    ├── api.ts                    # API 客户端（全量接口封装）
    ├── types.ts                  # TS 类型定义
    ├── task-status.tsx           # 任务状态呈现
    └── utils.ts                  # cn 等工具
```

### 5.3 视图组织

```
工作台（WorkbenchView）                     对话（ChatView）
├── 资源：知识库 / 知识图谱 / 向量 / 产物 / 会话
├── 智能：智能体 / 技能 / 提示词 / 模板 / MCP / 模型
├── 数据：数据源
└── 治理：运维 / 治理 / 安全

项目：空间详情 → 子系统详情 → 任务列表 → 任务详情（含任务流面板）
```

### 5.4 关键 Hook

- `use-chat-stream`：`fetch('/api/chat/stream')` 逐行解析 `data: {...}` SSE 事件，支持中止。
- `use-conversations`：会话列表 / 创建 / 删除 / 切换。
- `use-health`：`/api/health` 轮询。

### 5.5 开发代理

```ts
// web-ui/vite.config.ts
server: {
  host: '0.0.0.0',
  proxy: { '/api': { target: 'http://localhost:8000', changeOrigin: true } },
}
```

> 代理目标是 **8000**，而 `run.py` 默认监听 `config.yaml` 的 **5010**（见 13.1）。

---

## 6. API 设计

### 6.1 健康与设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/ollama/models` | Ollama 模型列表 |
| GET | `/api/settings` | 获取设置 |
| PUT | `/api/settings` | 更新设置 |

### 6.2 会话与对话

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/conversations` | 会话列表（可按 space_id 过滤） |
| POST | `/api/conversations` | 创建会话 |
| GET | `/api/conversations/{cid}` | 会话详情 |
| DELETE | `/api/conversations/{cid}` | 删除会话 |
| POST | `/api/conversations/{cid}/attach-task` | 会话绑定任务 |
| POST | `/api/conversations/{cid}/attach-space` | 会话归属空间 |
| GET | `/api/conversations/{cid}/messages` | 消息列表 |
| GET | `/api/conversations/{cid}/trace` | 步骤级 trace |
| POST | `/api/chat/stream` | **SSE 流式对话** |
| POST | `/api/chat/attachments` | 附件上传（解析 → 产物 → 可选入库） |

### 6.3 智能体 / 提示词 / 技能 / 模型

| 模块 | 路径 |
|------|------|
| 智能体 | GET/POST `/api/agents`；PUT/DELETE `/api/agents/{aid}`；POST `/api/agents/{aid}/toggle` |
| 提示词 | GET/POST `/api/prompts`；PUT/DELETE `/api/prompts/{pid}`；GET `/api/prompts/{pid}/agents` |
| 技能 | GET/POST `/api/skills`；PUT/DELETE `/api/skills/{sid}`；POST `/api/skills/{sid}/run`、`/script`、`/toggle` |
| 模型 | GET/POST `/api/models`；PUT/DELETE `/api/models/{mid}`；POST `/api/models/{mid}/toggle` |

### 6.4 数据源 / 运维 / 治理

| 模块 | 路径 |
|------|------|
| 数据源 | GET/POST `/api/datasources`；PUT/DELETE `/api/datasources/{name}`；POST `/api/datasources/{name}/toggle`、`/test`、`/query`、`/explain` |
| 运维 | POST `/api/ops/health`；GET `/api/ops/health/history`、`/api/ops/slow-sql`、`/api/ops/baseline` |
| 治理 | POST `/api/gov/catalog`、`/api/gov/quality`、`/api/gov/kgsync`；GET `/api/gov/assets`、`/api/gov/quality/rows` |

### 6.5 知识库 / 知识图谱

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/kb/documents` | 文档列表 / 上传（向量化入库） |
| DELETE | `/api/kb/documents/{doc_id}` | 删除文档 |
| GET | `/api/kb/search` | 知识库检索 |
| GET | `/api/kg/overview` | 图谱概览（实体/关系统计） |
| POST | `/api/kg/rebuild` | 重建图谱 |
| GET | `/api/kg/expand` | 图谱一跳扩展 |
| GET | `/api/kg/entities` | 实体搜索 |

### 6.6 空间 / 子系统 / 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/spaces` | 空间列表 / 创建 |
| GET/PUT/DELETE | `/api/spaces/{sid}` | 空间详情 / 更新 / 删除 |
| POST | `/api/spaces/{sid}/subsystems` | 创建子系统 |
| GET/PUT/DELETE | `/api/spaces/{sid}/subsystems/{ssid}` | 子系统详情 / 更新 / 删除 |
| GET | `/api/spaces/{sid}/subsystems/{ssid}/stats` | 子系统统计（任务/会话/产物/文档/数据源数） |
| GET/POST | `/api/tasks` | 任务列表 / 创建 |
| GET/PUT/DELETE | `/api/tasks/{tid}` | 任务详情（含会话与产物）/ 更新 / 删除 |

### 6.7 产物 / MCP / 安全 / 首页

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/artifacts` | 产物列表（按 conv_id / namespace / task_id 过滤） |
| GET | `/api/artifacts/{rid}/file` | 产物文件内容 |
| PUT | `/api/artifacts/{rid}` | 重命名产物 |
| DELETE | `/api/artifacts/{rid}` | 删除产物 |
| GET/POST | `/api/mcp/servers` | MCP 服务列表 / 创建 |
| POST | `/api/mcp/servers/{rid}/test` | MCP 连通性测试（HTTP 可达性） |
| GET | `/api/security/logs` | 安全审计日志 |
| GET | `/` | 返回 `web/index.html`（不存在时返回占位 JSON） |

---

## 7. 配置管理

### 7.1 配置文件（`config.yaml`）

```yaml
name: 数据库国产化智能体
host: 0.0.0.0
port: 5010
artifact_root: artifacts
db_path: data/db.sqlite3
chroma_dir: data/chroma        # 遗留字段：未参与 FAISS 初始化（见 13.3）
kb_collection: migration_kb
rag_top_k: 4
llm:
  provider: bailian            # ollama | deepseek | bailian
  base_url: ""
  model: qwen-max
  api_key: "sk-..."
  embedding_model: qwen3.7-text-embedding
  temperature: 0.2
  max_tokens: 4096
```

`AppConfig` 另有代码内默认值：`faiss_dir=data/faiss`、`api_key=""`（鉴权关闭）、`rate_limit=0`（限流关闭）、`security_log=True`。

### 7.2 配置优先级

```
config.yaml > AppConfig 代码默认值
```

`create_app()` 的 `config_override` 参数可在测试中覆盖任意字段（含 `llm` 子字段）。

---

## 8. 文件存储

```
db_loc_agent/
├── data/
│   ├── db.sqlite3          # 业务数据库
│   ├── faiss/              # FAISS 向量索引（migration_kb.faiss）
│   ├── kb_files/           # 知识库原始文件
│   ├── skills/{skill_id}/  # SKILL.md + scripts/
│   ├── chroma/             # 历史遗留（当前未使用）
│   └── db_loc.db / loc_agent.db  # 历史遗留库文件
├── artifacts/
│   └── sess_{id}/{agent_id}/{object_name}/{timestamp}/
│       ├── result.json
│       ├── DDL_<OBJECT>.sql
│       └── <报告>.md
├── db_loc_agent/           # 后端源码（web/index.html 为静态占位）
├── web-ui/                 # 前端源码（src + dist 已构建）
├── demo_data/              # 演示数据（kb / data / artifacts）
├── examples/demo_agents.py # 本地演示脚本
├── docs/                   # 本文档
├── tests/                  # pytest 用例
├── config.yaml             # 配置
├── requirements.txt        # Python 依赖
├── run.py / run_server.py  # 启动脚本
```

---

## 9. 安全设计

| 层面 | 措施 |
|------|------|
| 数据源 | 仅只读（SELECT/WITH/EXPLAIN）；SQLite `mode=ro`；其他方言事务统一回滚；行数 100 上限；单元格 500 字符 |
| API | 可选 API Key 鉴权；分钟级固定窗口限流；审计日志落库 |
| 技能沙箱 | 子进程隔离 + 30s 超时 + 512MB 内存上限 + AST 危险模块校验 + 环境变量最小化 |
| 产物 | namespace 段白名单校验 + 读写路径越界防护 + 文件名非法字符拦截 |
| 凭据 | 数据源密码仅在连接时读取，列表接口不回传；**当前为明文存储**（演示环境，生产建议加密） |

---

## 10. 扩展点

### 10.1 新增 Agent

1. 修改 `agents.py::AGENTS` 字典（内置注册），或
2. 通过前端「智能体」页面创建（写入 `agents` 表）；同时可在「提示词」页配置 `category=agent`、`name == agent_id` 的提示词覆盖默认值。

> 注意 `gen_artifact` / `output_files` / `intent` 的 DB 覆盖语义（见 13.5）。

### 10.2 新增数据源类型

在 `db_tools.py::DIALECTS` 元组添加类型，并在 `_conn_str()` 中补充连接串构建分支；同时安装对应驱动（requirements 未声明，需手动加入）。

### 10.3 新增技能

在 `data/skills/{skill_id}/` 下创建 `SKILL.md`（frontmatter 支持 `name/description/script/chain`）与可选 `scripts/`。

### 10.4 新增治理 / 运维能力

在 `gov.py` / `ops.py` 增加方法 → 在 `graph.py::_tool_schemas()` 注册工具定义 → 在 `graph.py::_dispatch_tool()` 增加分发分支。

### 10.5 MCP 完整集成（待办）

1. 初始化 MCP 客户端（stdio / http）
2. 拉取远端工具列表并注入 `_tool_schemas()`
3. 在 `_dispatch_tool()` 中转发工具调用并回填结果

---

## 11. 部署与运行

```bash
# 后端依赖
pip install -r requirements.txt

# 方式 A：run.py（监听 config.yaml 的 host:port，默认 0.0.0.0:5010）
python run.py

# 方式 B：run_server.py（监听 0.0.0.0:8000，reload=True）
python run_server.py

# 前端开发（默认 0.0.0.0:5173，代理 /api → localhost:8000）
cd web-ui && npm install && npm run dev

# 前端构建（产物 web-ui/dist，可部署到任意静态服务器）
cd web-ui && npm run build

# 本地演示脚本（需 export BAILIAN_API_KEY=sk-...）
.venv/bin/python examples/demo_agents.py
```

---

## 12. 测试

测试用例位于 `tests/`（20 个文件，约 90 个用例）：

```bash
cd db_loc_agent
pytest tests/ -v
```

| 测试文件 | 覆盖模块 |
|----------|----------|
| `test_agents.py` / `test_agents_db_tools.py` | Agent 注册中心、Agent 与数据源工具联动 |
| `test_graph.py` | LangGraph 主图（parse/route/execute/artifact） |
| `test_rag.py` / `test_kg.py` | RAG 知识库、知识图谱 |
| `test_db.py` / `test_project.py` | 数据模型、空间-子系统-任务 |
| `test_api.py` / `test_smoke.py` | API 接口、冒烟 |
| `test_skills.py` / `test_skill_chain.py` | 技能管理、技能链 |
| `test_attachments.py`（19 例，最多） | 附件解析与上传 |
| `test_artifacts.py` / `test_prompts.py` | 产物管理、提示词管理 |
| `test_ops.py` / `test_gov.py` | 运维监控、数据治理 |
| `test_security.py` / `test_config.py` / `test_llm.py` | 安全网关、配置、LLM 工厂 |

---

## 13. 已知不一致与注意事项

> 以下均为核对代码时确认的**实际状态**，供维护者决策，不属于「设计意图」。

### 13.1 端口不一致

| 位置 | 端口 |
|------|------|
| `config.yaml` / `config.py` 默认 / `run.py` | **5010** |
| `run_server.py` | 8000 |
| `web-ui/vite.config.ts` 代理目标 | 8000 |

使用 `python run.py` 启动时，前端开发代理需同步改为 5010，否则 `/api` 请求打不通。

### 13.2 `requirements.txt` 与实际依赖不符

- **缺失**：`faiss-cpu`、`numpy`（`rag.py` 直接 import，缺失则 RAG 无法工作）、`PyMySQL`（MySQL 数据源必需）。
- **多余**：`chromadb`（代码已不引用 Chroma）。
- 其他方言驱动（`psycopg2` / `oracledb` / `dmPy`）**未安装也未声明**，当前开箱可用仅 SQLite 与 MySQL。

### 13.3 Chroma 遗留

`config.yaml` 的 `chroma_dir`、`data/chroma/`、`demo_data/data/chroma/`，以及 `examples/demo_agents.py` 中把 FAISS 目录命名为 `chroma`，均为早期 Chroma 版本遗留。实际向量库为 FAISS。

### 13.4 `models` 表未参与运行时选型

`ModelDef` 仅提供管理界面与持久化；对话实际使用 `config.yaml` 的 `llm` 配置（`create_chat_model(cfg.llm)`）。两者目前未打通。

### 13.5 `agents` 表覆盖内置默认值（重要）

`AgentService.all()` 中，DB 行存在时 `gen_artifact` 取 `bool(r.gen_artifact)`。而当前 `data/db.sqlite3` 的 8 行 `agents` 记录 `gen_artifact` 均为 `0`，**导致这 8 个 Agent 的产物生成全部被关闭**（`artifact` 节点直接返回）。同理 DB 的 `name` 会覆盖内置名称（如 `migration_assessor` 显示为「评估专家」）。若需恢复产物落盘，把对应行 `gen_artifact` 置 1，或清空该行让内置默认值生效。

### 13.6 其他

- `data/skills/oracle/scripts/` 为空目录（技能目录磁盘残留）。
- `space_subsystems` 现存数据中「营业系统」属空间 1、「开通系统」属空间 2，而 `seed_demo_space()` 的预置逻辑是把两者都放在「浙江移动国产化」下，属手工数据漂移。
- `app.py` 单文件约 88KB、`graph.py` 约 45KB，路由与业务逻辑高度集中，后续扩展建议按域拆分路由模块。
- 工程当前**不是 git 仓库**，但目录内含 `.venv`、`__pycache__`、`.pytest_cache`，建议尽快初始化版本控制并补 `.gitignore`。
- `config.yaml` 中百炼 `api_key` 为**明文真实密钥**，建议改为环境变量注入并轮换该密钥。
- 遗留二进制文档 `docs/db_loc_agent_设计文档.doc` 已过时，以本文档为准。
