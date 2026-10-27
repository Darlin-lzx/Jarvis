# 数据库国产化迁移智能编排平台（DB Loc Agent）

一个基于 LLM 的多智能体（Multi-Agent）系统，帮助用户完成数据库从 Oracle、MySQL、SQL Server 等传统数据库向国产数据库（达梦 DM、人大金仓 KingBase、华为 GaussDB、OceanBase 等）的迁移工作。系统以**数据迁移**为核心场景，通过「后端硬编码状态机 + 多智能体编排 + 确定性校验工具」的组合，把迁移流程固化、可复现、可审计。

> 工程架构与实现细节见 
>
> [docs/architecture.md](docs/architecture.md)
>
> 。



***

## 目录



* [核心能力](#核心能力)

* [数据迁移功能](#数据迁移功能)

* [技术栈](#技术栈)

* [系统架构](#系统架构)

* [目录结构](#目录结构)

* [部署](#部署)

* [测试](#测试)

* [P0 平台化加固](#p0-平台化加固)

* [安全设计](#安全设计)

* [扩展点](#扩展点)

* [已知注意事项](#已知注意事项)



***

## 核心能力



| 能力    | 说明                                     | 对应 Agent                       |
| ----- | -------------------------------------- | ------------------------------ |
| 迁移总调度 | 识别需求环节、拆解任务、按序调度子 Agent、汇总完整迁移方案       | `migration_commander`（主 Agent） |
| 数据采集  | 采集源库元数据、表结构、索引约束与对象清单，为评估与方案提供输入       | `migration_collector`          |
| 迁移评估  | 分析源库 Schema 与对象清单，输出兼容性 / 风险 / 工作量评估报告 | `migration_assessor`           |
| 迁移方案  | 汇总评估、转换与搬迁结果，生成国产化迁移落地实施方案             | `migration_planner`            |
| 代码改造  | 分析 JDBC / ORM / 存储过程代码，输出适配改造建议        | `code_migrator`                |
| 迁移验证  | 校验转换后 SQL 语法与源目标结构一致性，输出失败清单           | `migration_verifier`           |

> 说明：当前仅列出系统中
>
> **已启用**
>
> 的智能体；被禁用的智能体不参与对话路由与编排。



***

## 数据迁移功能

本平台围绕「传统库 → 国产库」迁移全流程设计，核心设计原则是：**迁移流程由后端状态机固化，LLM 无权决定跳转节点，只负责对话、渲染表单与调度子 Agent**，从而保证迁移结果可复现、可审计、可断点续跑。

### 迁移编排流程

后端状态机（`state_machine.py`）硬编码了迁移任务的完整流转，每一级都需用户显式确认（继续 / 确认）后，后端才跨闸门进入下一阶段：



```
DATA\_COLLECTION  数据采集

&#x20;     │  \[确认]

&#x20;     ▼

ASSESSMENT\_RUNNING  迁移评估

&#x20;     │  \[确认]

&#x20;     ▼

SOLUTION\_GENERATE  方案生成

&#x20;     │  \[确认]

&#x20;     ▼

CODE\_MIGRATE  代码改造

&#x20;     │  \[确认]

&#x20;     ▼

VERIFY\_STAGE  迁移验证

&#x20;     │  \[确认]

&#x20;     ▼

FINISHED  完成

任意节点均可进入 ERROR（保存已采集参数与资产，支持断点续跑）
```

### 迁移环节



| 环节   | 职责                                                  | 对应 Agent              |
| ---- | --------------------------------------------------- | --------------------- |
| 数据采集 | 连接源库，采集表结构、字段、索引、约束、视图与存储过程，输出结构化对象清单               | `migration_collector` |
| 迁移评估 | 基于采集结果与知识库兼容性资料，输出兼容性 / 风险 / 工作量评估报告                | `migration_assessor`  |
| 迁移方案 | 汇总评估、转换与搬迁结果，产出可执行的落地实施方案（步骤、对象清单、停机窗口、回滚与验收口径）     | `migration_planner`   |
| 代码改造 | 分析 JDBC / ORM / 存储过程调用代码，输出驱动、连接串、SQL 方言、事务与分页的适配建议 | `code_migrator`       |
| 迁移验证 | 校验转换后 DDL/SQL 语法与源目标结构一致性，标记失败语句并给出原因与修复建议          | `migration_verifier`  |

### 确定性能力（不依赖 LLM）

这些能力与 LLM 互补，保证迁移结论中「找问题、比对、校验」部分可复现、可审计：



* **迁移状态机**（`state_machine.py`）：业务流程固化在后端，硬编码流转规则；状态与已采集参数持久化到 `db_migrate_task` 表，断点续跑，重新打开任务从上次状态继续。

* **静态规则引擎**（`rule_engine.py`）：用 JSON 规则做词法扫描，识别 SQL / DDL 不兼容项并打上结构化风险标签（高 / 中 / 低）。**规则负责找问题，LLM 负责解释问题、写方案**。

* **Schema Diff 引擎**（`schema_diff.py`）：同时连接源库 / 目标库，确定性比对表 / 视图、列、类型、可空性、主键、索引的差异，结果可复现、可审计。

* **结构化迁移资产**（`assets.py`）：每个风险项结构化存储（对象名称、风险等级、不兼容点、原始 SQL、转换 SQL、改造建议、来源、状态、负责人）；最终报告由后端读取资产表按模板渲染，LLM 只负责填充业务描述；支持导出 Excel 资产清单，供工程实施人员直接使用。

### 数据源接入



| 数据源        | 驱动 / 连接方式                            | 默认端口  |
| ---------- | ------------------------------------ | ----- |
| SQLite     | `sqlite:///file:...?mode=ro`（只读 URI） | -     |
| MySQL      | `mysql+pymysql`                      | 3306  |
| PostgreSQL | `postgresql+psycopg2`                | 5432  |
| KingBase   | `postgresql+psycopg2`                | 54321 |
| GaussDB    | `postgresql+psycopg2`                | 8000  |
| Oracle     | `oracle+oracledb`（service\_name）     | 1521  |
| DM         | `dm+dmPy`                            | 5236  |

所有数据源接入均为**只读**：仅允许 `SELECT` / `WITH` 语句，黑名单拦截写操作；SQLite 强制 `mode=ro`，其他方言事务统一 `rollback()`；单次查询最多 100 行、单格最多 500 字符。

### 产物交付

迁移过程中生成的报告、SQL 与结构化数据自动落盘归档，namespace 形如 `sess_{id}/{agent_id}/{object}/{stamp}/`，产出包括：



* `result.json`（agent\_id / intent / object\_name / reply / rag\_refs）

* 评估 / 方案 / 验证报告（Markdown）

* 采集对象清单（`collected_data.md` / `object_list.json`）

* 结构化迁移资产（风险项表 + Excel 导出）

* SQL / DDL 脚本

产物支持**版本管理**（见 [P0 平台化加固](#p0-平台化加固)），旧版本不可变、可回溯。



***

## 技术栈



| 层级    | 技术选型                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------ |
| 前端    | Vite 8 + React 19 + TypeScript 6 + Tailwind CSS 3 + shadcn/ui（Radix UI）+ lucide-react + react-markdown |
| 后端    | Python 3.13 + FastAPI + LangGraph + LangChain                                                          |
| LLM   | Ollama（本地）/ DeepSeek / 阿里云百炼（OpenAI 兼容模式）/ 智谱                                                          |
| 向量检索  | FAISS（`IndexFlatIP` 内积 + L2 归一化，等价余弦相似度）                                                               |
| 业务数据库 | SQLite（SQLAlchemy 2.0 ORM，经连接串可切 MySQL）                                                                |
| 数据源接入 | SQLite / MySQL / PostgreSQL / Oracle / DM / KingBase / GaussDB（**只读**）                                 |



***

## 系统架构



```
前端 SPA (web-ui/dist)

&#x20; 对话界面 (SSE 流式/动态表单/引用)   工作台 (知识/智能/数据/治理)

&#x20; 项目空间 (空间-子系统-任务)          产物交付 (报告/SQL/JSON)

&#x20;         │  HTTP / SSE

&#x20;         ▼

后端 (FastAPI · app.py)

&#x20; /api/chat/stream (SSE) + 大量 REST 路由 + WebSocket 状态广播

&#x20; 安全网关中间件: API Key 鉴权 + 分钟级限流 + 审计落库

&#x20;         │

&#x20;         ▼

LangGraph 主图 (graph.py · GraphRuntime)

&#x20; parse → route → execute → artifact → reply

&#x20; 意图解析   路由决策   Agent执行/工具循环   产物生成    回复输出

&#x20;         │

&#x20;         ▼

服务层

&#x20; AgentService  RAGStore  KnowledgeGraph  SkillService  DbTools

&#x20; GovService  OpsService  ArtifactService  PromptService  ProjectService

&#x20; MigrateStateService  Reliability  Observability  SecurityGateway

&#x20;         │

&#x20;         ▼

数据层

&#x20; SQLite (业务数据)   FAISS (向量索引)   文件系统 (artifacts/skills)
```

LangGraph 主图节点为直线串联：`parse → route → execute → artifact → reply → END`，路由决策在 `route` 节点内部完成，执行节点内含工具调用循环（`max_iterations=3`）。



***

## 目录结构



```
db\_loc\_agent/

├── db\_loc\_agent/            # 后端源码

│   ├── app.py               # FastAPI 应用入口（REST + SSE + WebSocket + 安全中间件）

│   ├── graph.py             # LangGraph 主图：parse→route→execute→artifact→reply

│   ├── agents.py            # Agent 注册中心（内置 Agent + DB 扩展）

│   ├── state\_machine.py     # 迁移领域状态机（硬编码流转，LLM 无权跳转）

│   ├── state\_stream.py      # WebSocket 状态广播

│   ├── rule\_engine.py       # 静态 SQL/DDL 规则引擎

│   ├── schema\_diff.py       # 双库 Schema Diff 确定性比对

│   ├── assets.py            # 结构化迁移资产服务（落库/报告渲染/Excel 导出）

│   ├── observability.py     # 全局 trace 与迁移状态事件持久化

│   ├── reliability.py       # DB/LLM 熔断与重试原语

│   ├── llm.py / embedding.py# LLM 与 Embedding 工厂（Ollama/DeepSeek/百炼）

│   ├── rag.py / kg.py       # RAG 知识库（FAISS）/ 知识图谱（规则式提取）

│   ├── db\_tools.py          # 数据源工具（只读查询/执行计划/Schema 探查）

│   ├── gov.py / ops.py      # 数据治理 / 运维监控

│   ├── skills.py            # 技能管理（SKILL.md 解析 + 沙箱执行 + 技能链）

│   ├── artifacts.py         # 产物管理（namespace 校验 + 版本 + 越界防护）

│   ├── attachments.py       # 附件解析（md/sql/pdf/docx/xlsx 等）

│   ├── project.py / prompts.py / security.py / config.py / db.py

│   └── bootstrap.py         # 把 data/seed/\*.json 幂等导入业务库

├── web-ui/                  # 前端源码（src + dist 已构建）

├── data/                    # 业务库、FAISS 索引、知识库文件、技能、seed 数据

├── artifacts/               # 产物输出（sess\_{id}/{agent\_id}/{object}/{stamp}/）

├── tests/                   # pytest 用例

├── docs/                    # 架构文档与设计文档

├── examples/demo\_agents.py  # 本地演示脚本

├── config.yaml              # 配置

├── requirements.txt         # Python 依赖

├── deploy.sh                # 一键部署脚本

├── run.py / run\_server.py / run\_seed.py
```



***

## 部署

提供一键部署脚本 `deploy.sh`，自动完成：创建 / 复用 `.venv`、安装后端依赖、构建前端、准备数据库（按 `config.yaml` 的 `mysql_url` 自动建库或使用 SQLite）、导入种子数据并启动服务。



```
./deploy.sh                # 部署并前台启动（默认 0.0.0.0:5010）

./deploy.sh --daemon       # 后台启动，日志 logs/deploy\_\*.log

./deploy.sh --build-front  # 部署前强制重新构建前端
```

> 更多参数（
>
> `--skip-build`
>
>  跳过前端构建、
>
> `--port=<端口>`
>
>  自定义端口等）见 
>
> `./deploy.sh --help`
>
> 。



***

## 测试



```
pytest tests/ -v
```

测试覆盖 Agent 注册、LangGraph 主图、RAG/KG、数据模型与项目、API 冒烟、技能与技能链、附件解析、产物版本、提示词、运维 / 治理、安全网关、配置、LLM 工厂、状态机、可靠性、可观测性等模块。



***

## P0 平台化加固

在保持既有状态机与页面路由不变的前提下，旁路补充可靠性、版本与可观测能力：



* **产物版本**：任务产物按 `task_id + agent_id + object_name + file_type` 递增版本，旧文件写入 `vN` 目录后不可变。可通过 `GET /api/products/{id}/versions` 查看版本，`GET /api/products/{id}/versions/{version}` 读取指定版本，`GET /api/products/{id}/diff?left=&right=` 查看 SQL Diff。历史产物展示为 v1。

* **全局追踪**：迁移任务创建时生成 `trace_id`；存量任务在下一轮状态变化时回填。任务详情与产物记录携带该 ID，可通过 `GET /api/trace/{trace_id}` 查询执行日志。

* **状态事件**：状态机持久化 `TASK_STARTED`、`USER_INPUT`、`NODE_SUCCESS`、`NODE_FAILED`、`TASK_COMPLETED`。WebSocket 在原 `state` 快照外追加 `state_event` 帧，前端保留最近 100 条事件。

* **可靠性**：`config.yaml` 的 `reliability` 配置 DB/LLM 熔断阈值、恢复时间、LLM 重试次数与退避时长。数据源连接失败会计入 DB 熔断；LLM 瞬时超时 / 连接失败会重试，重试耗尽后保留原始异常。

> 修改可靠性配置或升级数据库结构后需重启后端；SQLite/MySQL 会自动补新增列。观测事件与 trace 日志只做旁路记录，写入失败不影响状态机权威状态。



***

## 安全设计



| 层面   | 措施                                                                        |
| ---- | ------------------------------------------------------------------------- |
| 数据源  | 仅只读（SELECT/WITH/EXPLAIN）；SQLite `mode=ro`；其他方言事务统一回滚；行数 100 上限；单元格 500 字符 |
| API  | 可选 API Key 鉴权（`X-API-Key` / Bearer）；分钟级固定窗口限流；审计日志落库（默认鉴权与限流关闭）           |
| 技能沙箱 | 子进程隔离 + 30s 超时 + 512MB 内存上限 + AST 危险模块校验 + 环境变量最小化                        |
| 产物   | namespace 段白名单校验 + 读写路径越界防护 + 文件名非法字符拦截                                   |



***

## 扩展点



* **新增 Agent**：修改 `agents.py::AGENTS` 内置注册，或通过前端「智能体」页面创建（写入 `agents` 表）；可用 `prompts` 表配置 `category=agent`、`name == agent_id` 的提示词覆盖默认值。

* **新增数据源类型**：在 `db_tools.py::DIALECTS` 添加类型并补充连接串分支，同时安装对应驱动。

* **新增技能**：在 `data/skills/{skill_id}/` 下创建 `SKILL.md`（frontmatter 支持 `name/description/script/chain`）与可选 `scripts/`。

* **新增治理 / 运维能力**：在 `gov.py` / `ops.py` 增加方法 → 在 `graph.py::_tool_schemas()` 注册工具 → 在 `_dispatch_tool()` 增加分发分支。

* **MCP**：`mcp_servers` 表 CRUD 已完成，尚未接入 Agent 执行流程（预留）。



***

## 已知注意事项



* **端口**：`config.yaml` / `run.py` 用 **5010**；`run_server.py` 与前端代理用 **8000**。

* **密钥**：`config.yaml` 中的 LLM `api_key` 为明文，建议改为环境变量注入并轮换。

* **明文凭据**：数据源密码当前为明文存储（演示环境），生产建议加密。

* `agents`**&#x20;表覆盖**：DB 行的 `gen_artifact` 会覆盖内置默认值，需按需确认产物落盘开关。

* **依赖**：`requirements.txt` 与实际依赖存在出入（缺 `faiss-cpu`/`numpy`/`PyMySQL`，多 `chromadb` 遗留）。