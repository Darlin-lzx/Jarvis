"""数据库国产化智能体 - 两个预置 Agent（迁移评估 / DDL转换）本地演示

用法（先导出百炼 Key）：
    export BAILIAN_API_KEY="sk-..."
    .venv/bin/python examples/demo_agents.py

演示内容：
1. 构造 mock 知识库（达梦语法差异 md + Oracle DDL 样例）并向量化入库
2. 导入 mock Oracle 对象清单 / USER_ORDER 表 DDL
3. 依次运行 migration_assessor / ddl_converter，输出 parse -> route -> RAG 引用 -> 回复 -> 产物落盘
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage

from db_loc_agent.agents import AGENTS
from db_loc_agent.artifacts import ArtifactService
from db_loc_agent.config import AppConfig, LLMSettings
from db_loc_agent.db import Database
from db_loc_agent.embedding import create_embedding_function
from db_loc_agent.graph import AgentState, build_graph
from db_loc_agent.llm import create_chat_model
from db_loc_agent.prompts import PromptService
from db_loc_agent.rag import RAGStore

DEMO_DIR = Path(__file__).resolve().parent.parent / "demo_data"

# ---------- mock 数据 ----------

KB_MD = """# Oracle 到达梦（DM8）迁移兼容性速查

## 数据类型兼容
- NUMBER(n) / NUMBER(n,m)：达梦兼容 Oracle，可原样使用 NUMBER。
- VARCHAR2(n)：达梦兼容 VARCHAR2；VARCHAR 按字节/字符长度语义与 Oracle 一致（UTF-8 下注意字符数）。
- CLOB / BLOB：达梦支持，名称语义兼容。
- NCLOB：达梦不直接支持 NCLOB，需转换为 CLOB。
- XMLTYPE：达梦建议转换为 CLOB 或使用达梦 XML 类型（兼容模式）。
- ROWID / ROWNUM：达梦兼容模式支持；分页推荐改用 LIMIT 语法（DM 8.1+ 支持）。

## 对象与特性
- SEQUENCE：达梦支持 CREATE SEQUENCE，语法与 Oracle 基本一致（INCREMENT BY / START WITH / CACHE）。
- SYNONYM/同义词：达梦支持。
- 索引：Oracle 位图索引、函数索引达梦均支持；部分 Oracle 特有存储参数忽略。
- 分区表：达梦支持 RANGE/LIST/HASH 分区。
- 触发器：达梦支持 BEFORE/AFTER 行级与语句级触发器；INSTEAD OF 需校验。

## DDL/DML 注意事项
- 分页：Oracle ROWNUM 写法改 LIMIT offset, rows 或 TOP。
- 连接：+ 外连接改 LEFT/RIGHT JOIN。
- NVL2/DUAL：达梦兼容模式下 NVL2、DUAL 均可用。
- 空字符串：Oracle 视 NULL，达梦默认同 Oracle 兼容参数，注意初始化参数 COMPATIBLE_MODE。
- 大对象批量写入：建议使用绑定变量与批量绑定。
"""

KB_SQL = """-- Oracle 常用 DDL 样例（达梦兼容模式可直接参考）
CREATE TABLE ORDERS (
    ORDER_ID    NUMBER(12)       NOT NULL,
    CUST_ID     NUMBER(10)       NOT NULL,
    AMOUNT      NUMBER(14,2)     DEFAULT 0,
    STATUS      VARCHAR2(16)     DEFAULT 'NEW',
    CREATE_TIME DATE,
    CONSTRAINT PK_ORDERS PRIMARY KEY (ORDER_ID)
);
CREATE SEQUENCE SEQ_ORDERS START WITH 1001 INCREMENT BY 1 NOCACHE;
CREATE INDEX IDX_ORDERS_CUST ON ORDERS (CUST_ID, STATUS);
"""

MOCK_INVENTORY = """-- Oracle 迁移对象清单（模拟导出）
表：
  USER_ORDER     行数 1,200,000  ；主键 PK_USER_ORDER(ORDER_ID)
  ORDER_ITEM     行数 4,800,000  ；外键 FK_ITEM_ORDER -> USER_ORDER(ORDER_ID)
  CUSTOMER       行数 350,000
索引：
  IDX_ORDER_STATUS(STATUS)
  IDX_ORDER_CUST(CUSTOMER_ID)
  UNIQ_CUST_MOBILE(CUSTOMER_ID, MOBILE) 唯一
序列：
  SEQ_USER_ORDER  START 1000000 INCREMENT 1 CACHE 20
视图：
  V_USER_ORDER_SUMMARY（含 DECODE、ROWNUM 分页）
存储过程：
  PRC_ORDER_SYNC（含自治事务 PRAGMA AUTONOMOUS_TRANSACTION、动态 SQL）
触发器：
  TRG_ORDER_BI（BEFORE INSERT，取 SEQ_USER_ORDER.NEXTVAL 回填）
约束：
  CHECK (STATUS IN ('NEW','PAID','SHIPPED','DONE','CANCEL'))
"""

MOCK_DDL = """-- 源库：Oracle 12c
CREATE TABLE USER_ORDER (
    ORDER_ID     NUMBER(16)       NOT NULL,
    ORDER_NO     VARCHAR2(32)     NOT NULL,
    CUSTOMER_ID  NUMBER(12)       NOT NULL,
    AMOUNT       NUMBER(12,2)     DEFAULT 0 NOT NULL,
    STATUS       VARCHAR2(16)     DEFAULT 'NEW',
    PAY_TIME     DATE,
    CREATE_TIME  DATE             DEFAULT SYSDATE,
    REMARK       VARCHAR2(500),
    CONSTRAINT PK_USER_ORDER PRIMARY KEY (ORDER_ID),
    CONSTRAINT UK_USER_ORDER_NO UNIQUE (ORDER_NO),
    CONSTRAINT CK_USER_ORDER_ST CHECK (STATUS IN ('NEW','PAID','SHIPPED','DONE','CANCEL'))
);
CREATE INDEX IDX_USER_ORDER_STATUS ON USER_ORDER (STATUS);
CREATE INDEX IDX_USER_ORDER_CUST ON USER_ORDER (CUSTOMER_ID);
CREATE SEQUENCE SEQ_USER_ORDER START WITH 1000001 INCREMENT BY 1 NOCACHE;
COMMENT ON TABLE USER_ORDER IS '用户订单主表';
COMMENT ON COLUMN USER_ORDER.ORDER_NO IS '订单号';
"""

AGENT_PROMPTS = {
    "migration_assessor": (
        "你是资深 DBA，专精国产数据库迁移评估。针对用户给出的源库对象清单，结合知识库中达梦/金仓/GaussDB 的兼容性资料输出《迁移评估报告》："
        "1) 兼容性矩阵（对象类型×风险等级）2) 高风险点与改造建议 3) 工作量估算（人日）。"
        "引用知识库时标注 [来源: doc.md#chunk]。不得编造知识库没有的结论。用 Markdown 输出。"
    ),
    "ddl_converter": (
        "你是国产数据库 DDL/DML 转换工程师。把用户给出的源库 DDL 严格转换为达梦（DM8）语法输出："
        "1) 先给出转换后的完整 SQL（```sql 代码块）2) 再列转换说明与疑点（按条）。"
        "必须依据知识库中的语法差异规则，不确定处明确标注『需人工确认』，不得自由发挥。"
    ),
}


def setup_store() -> tuple[Database, RAGStore, ArtifactService, PromptService]:
    db = Database(str(DEMO_DIR / "data" / "demo.db"))
    rag = RAGStore(db, str(DEMO_DIR / "data" / "chroma"), "migration_kb",
                   create_embedding_function(_llm_settings()))
    artifacts = ArtifactService(db, str(DEMO_DIR / "artifacts"))
    prompts = PromptService(db)
    # 准备 mock 知识库文档
    kb = DEMO_DIR / "kb"
    kb.mkdir(parents=True, exist_ok=True)
    docs = [("达梦兼容速查.md", "md", KB_MD), ("oracle_ddl_sample.sql", "sql", KB_SQL)]
    with db.session() as s:
        from db_loc_agent.db import DocumentRecord
        for name, typ, content in docs:
            doc = DocumentRecord(name=name, source_type=typ, doc_path=str(kb / name))
            (kb / name).write_text(content, encoding="utf-8")
            s.add(doc)
            s.commit()
            s.refresh(doc)
            rag.add_document(doc.id, name, typ, str(kb / name))
    # 注入两个 Agent 的受管提示词（route 阶段会优先命中）
    for agent_id, content in AGENT_PROMPTS.items():
        prompts.create(agent_id, "agent", content)
    return db, rag, artifacts, prompts


def _llm_settings() -> LLMSettings:
    key = os.environ.get("BAILIAN_API_KEY", "")
    if not key:
        raise SystemExit("请先 export BAILIAN_API_KEY=sk-...")
    return LLMSettings(
        provider="bailian",
        model="qwen-max",
        api_key=key,
        embedding_model="qwen3.7-text-embedding",
        base_url="",
        temperature=0.1,
        max_tokens=4096,
    )


def run_agent(rag, artifacts, prompts, settings: LLMSettings,
              user_input: str, conv_id: int) -> None:
    print("\n" + "=" * 72)
    print(f"[会话 {conv_id}] 输入需求：{user_input[:60]}...")
    print("=" * 72)
    llm = create_chat_model(settings)
    graph = build_graph(llm=llm, rag_search=rag.search, prompt_service=prompts,
                        artifact_service=artifacts, skill_service=None,
                        parse_schema={}, config=AppConfig(rag_top_k=4))
    state = AgentState(user_input=user_input, conv_id=conv_id)
    try:
        final = None
        for step in graph.stream(state, stream_mode="updates"):
            for node, update in step.items():
                if node == "parse":
                    print(f"\n🔍 parse → {json.dumps(update.get('parse_result'), ensure_ascii=False)}")
                elif node == "route":
                    print(f"🧭 route → {update.get('agent_id')}（{update.get('route_reason')}）")
                    ctx = update.get("rag_context") or []
                    if ctx:
                        print(f"📚 RAG 命中 {len(ctx)} 段：")
                        for c in ctx[:3]:
                            print(f"   · {c['doc_name']}#{c['chunk_index']} score={c['score']} | {c['content'][:60]}...")
                elif node == "artifact":
                    if update.get("namespace"):
                        print(f"📦 产物 namespace → {update['namespace']}")
                        for f in update.get("artifacts", []):
                            print(f"   - {f['path']}")
                final = update
        print("\n💬 Agent 回复（前 1500 字符）：")
        print((final or {}).get("reply", "")[:1500])
        # 展示产物内容
        if final and final.get("namespace"):
            ns = final["namespace"]
            files = artifacts.list_files(ns)
            for f in files:
                content = artifacts.read(f["id"])
                print(f"\n📄 [{f['type']}] {f['path']}（{len(content or '')} 字符）")
                print("   " + (content or "").replace("\n", "\n   ")[:1200])
    except Exception as e:
        print(f"\n❌ 运行失败：{type(e).__name__}: {e}")


def main() -> None:
    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    settings = _llm_settings()
    db, rag, artifacts, prompts = setup_store()
    # 仅使用 RAG 检索函数（embedding 走百炼），不再用 db 直连
    run_agent(rag, artifacts, prompts, settings,
              f"请评估以下 Oracle 对象清单国产化迁移到达梦的兼容性、风险和工作量：\n{MOCK_INVENTORY}",
              conv_id=1)
    run_agent(rag, artifacts, prompts, settings,
              f"请将以下 Oracle DDL 转换为达梦（DM8）语法：\n{MOCK_DDL}",
              conv_id=2)
    print("\n✅ 演示完成。产物目录：", DEMO_DIR / "artifacts")


if __name__ == "__main__":
    main()