"""知识图谱测试：规则提取（SQL DDL 外键/中英关系句式）、重建、图谱扩展"""
import pytest

from jarvis_agent.db import Database
from jarvis_agent.kg import KnowledgeGraph

SQL_DDL = """CREATE TABLE USER_ORDER (
  order_id NUMBER NOT NULL PRIMARY KEY,
  user_id NUMBER NOT NULL REFERENCES USER_ACCOUNT(user_id),
  amount NUMBER
);
CREATE TABLE USER_ACCOUNT (
  user_id NUMBER NOT NULL PRIMARY KEY
);
"""

MD_TEXT = """达梦 DM 兼容 Oracle 语法。
人大金仓 KingbaseES 兼容 PostgreSQL。
GaussDB 兼容 PostgreSQL 与 Oracle 方言。"""


@pytest.fixture()
def kg(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    return KnowledgeGraph(db)


def _seed_doc(kg, name, content, source_type="sql"):
    from pathlib import Path
    from jarvis_agent.db import DocumentRecord
    p = Path(kg.db.db_path).parent / name
    p.write_text(content, encoding="utf-8")
    with kg.db.session() as s:
        doc = DocumentRecord(name=name, source_type=source_type, doc_path=str(p), enabled=True)
        s.add(doc)
        s.commit()
        return doc


def test_extract_sql_foreign_keys(kg):
    ents, rels = kg._extract(SQL_DDL, "sql")
    names = set(ents)
    assert "USER_ORDER" in names and "USER_ACCOUNT" in names
    assert any(r == ("USER_ORDER", "REFERENCES", "USER_ACCOUNT") for r in rels)


def test_extract_cn_relations(kg):
    ents, rels = kg._extract(MD_TEXT, "md")
    assert any("Oracle" in o for s, r, o in rels if r == "兼容")
    assert any("达梦" in s for s, r, o in rels) or any("DM" == s for s, r, o in rels)


def test_build_and_expand(tmp_path):
    kg = KnowledgeGraph(Database(str(tmp_path / "t.db")))
    _seed_doc(kg, "ddl.sql", SQL_DDL, "sql")
    stat = kg.build_from_documents()
    assert stat["entities"] >= 2 and stat["relations"] >= 1
    ov = kg.overview()
    assert ov["entities"] == stat["entities"]
    # 扩展：候选实体命中 USER_ORDER，返回一跳关系
    terms = kg.match_entities("USER_ORDER related USER_ACCOUNT")
    assert "USER_ORDER" in terms
    triples = kg.expand(terms)
    assert any(t["subject"] == "USER_ORDER" and t["relation"] == "REFERENCES"
               and t["object"] == "USER_ACCOUNT" for t in triples)


def test_expand_no_terms(kg):
    assert kg.expand([]) == []
    assert kg.expand(["不存在实体XYZ"]) == []