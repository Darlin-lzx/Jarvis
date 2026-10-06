"""多数据库统一管理与数据治理（第三级）测试：资产目录 / 质量评分 / 图谱同步"""
import sqlite3

from db_loc_agent.db import Database, GovAsset, GovQuality, KGEntity, KGRelation
from db_loc_agent.db_tools import DbTools
from db_loc_agent.gov import GovService
from db_loc_agent.kg import KnowledgeGraph


def _mk(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    db_file = str(tmp_path / "x.db")
    conn = sqlite3.connect(db_file)
    conn.execute("CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT, phone TEXT)")
    conn.execute("INSERT INTO customer VALUES (1,'a','100'),(2,'b',NULL),(3,'c','300')")
    conn.execute("CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL)")
    conn.execute("INSERT INTO orders VALUES (1,1,10.0),(2,2,NULL)")
    conn.commit()
    conn.close()
    tools = DbTools(db)
    tools.create("demo", "sqlite", db_file)
    return db, tools


def test_catalog_extracts_assets(tmp_path):
    db, tools = _mk(tmp_path)
    gov = GovService(db, tools)
    r = gov.catalog("demo")
    assert r["success"] is True
    assert len(r["data"]["assets"]) == 2  # customer + orders
    with db.session() as s:
        from sqlalchemy import select
        rows = list(s.scalars(select(GovAsset)))
        assert len(rows) == 2
        cust = [x for x in rows if x.object_name == "customer"][0]
        assert cust.row_count == 3 and cust.pk == "id"
        import json
        cols = json.loads(cust.columns)
        assert any(c["name"] == "phone" for c in cols)


def test_catalog_unknown_ds_no_assets(tmp_path):
    db, tools = _mk(tmp_path)
    gov = GovService(db, tools)
    r = gov.catalog("nope")
    assert r["data"]["assets"] == []


def test_quality_scores(tmp_path):
    db, tools = _mk(tmp_path)
    gov = GovService(db, tools)
    gov.catalog("demo")
    r = gov.quality("demo")
    assert r["success"] is True
    assert len(r["data"]["scored"]) == 2
    with db.session() as s:
        from sqlalchemy import select
        rows = list(s.scalars(select(GovQuality)))
        assert len(rows) == 2
        cust = [x for x in rows if x.object_name == "customer"][0]
        assert cust.row_count == 3
        # phone 列有 NULL → 空值率 > 0，评分 < 100
        assert cust.null_rate > 0 and cust.score < 100
        # id 主键唯一 → unique_rate == 100
        assert cust.unique_rate == 100


def test_kg_sync_adds_entities_and_relations(tmp_path):
    db, tools = _mk(tmp_path)
    gov = GovService(db, tools, kg=KnowledgeGraph(db))
    gov.catalog("demo")
    r = gov.kg_sync()
    assert r["success"] is True
    assert r["data"]["entities"] >= 2 and r["data"]["relations"] >= 3
    with db.session() as s:
        from sqlalchemy import select
        tables = list(s.scalars(select(KGEntity).where(KGEntity.etype == "table")))
        assert {t.name for t in tables} >= {"customer", "orders"}
        rels = list(s.scalars(select(KGRelation).where(
            KGRelation.relation == "HAS_OBJECT")))
        assert len(rels) >= 1 and rels[0].subject == "demo"


def test_quality_before_catalog(tmp_path):
    """未抽取目录时评分返回空，不报错"""
    db, tools = _mk(tmp_path)
    gov = GovService(db, tools)
    r = gov.quality("demo")
    assert r["success"] is True and r["data"]["scored"] == []