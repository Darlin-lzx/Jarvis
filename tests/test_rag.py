from db_loc_agent.db import DocumentRecord, Database
from db_loc_agent.rag import RAGStore, extract_pdf_text, split_markdown, split_sql


class FakeEmbedding:
    """确定性向量：按文本长度/序号生成，无需网络"""

    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        vectors = []
        for text in texts:
            vec = [0.0] * 8
            for token in text.lower().split():
                vec[hash(token) % 8] += 1.0
            norm = sum(v * v for v in vec) ** 0.5 or 1.0
            vectors.append([v / norm for v in vec])
        return vectors


def test_split_markdown_by_heading():
    md = "# 达梦概述\n达梦兼容 Oracle。\n## 语法差异\n数据类型 INTEGER。\n# 分页\n使用 LIMIT。"
    chunks = split_markdown(md)
    assert len(chunks) >= 3


def test_split_sql_by_object():
    sql = "CREATE TABLE A (id INT);\nCREATE PROCEDURE P() BEGIN END;\nCREATE TABLE B (x INT);"
    blocks = split_sql(sql)
    assert len(blocks) == 3


def test_extract_pdf_text():
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("helvetica", size=12)
    pdf.cell(text="Hello PDF test 123")
    text = extract_pdf_text(pdf.output())
    assert "PDF" in text and "123" in text


def _store(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    return db, RAGStore(db, str(tmp_path / "chroma"), "kb",
                        FakeEmbedding())


def test_add_search_delete(tmp_path):
    db, store = _store(tmp_path)
    doc = DocumentRecord(name="达梦手册.md", source_type="md", doc_path="")
    with db.session() as s:
        s.add(doc)
        s.commit()
        s.refresh(doc)
    p = tmp_path / "dm.md"
    p.write_text("# 达梦\n达梦数据库兼容 Oracle 常用语法。\n## LIMIT\ndm 支持 LIMIT 子句。", encoding="utf-8")
    store.add_document(doc.id, doc.name, "md", str(p))
    assert store.count() > 0
    hits = store.search("达梦 支持 LIMIT", top_k=2)
    assert len(hits) >= 1
    assert "dm.md" == hits[0]["doc_name"]
    store.delete_document(doc.id)
    assert store.count() == 0


def test_search_uses_domain_confidence_and_fusion_scoring(tmp_path):
    db, store = _store(tmp_path)
    docs = []
    for name, text, meta in (
        ("dm-nvl.md", "达梦 DM 转换 函数 NVL 规则", {
            "business_domain": "db_migrate", "kb_type": "rules",
            "target_db": "dm", "stage": "transform", "object_type": "function",
            "confidence": "verified", "source": "human",
        }),
        ("audit-nvl.md", "SQL 审计 NVL 规则", {
            "business_domain": "sql_audit", "kb_type": "rules",
            "target_db": "dm", "stage": "transform", "object_type": "function",
            "confidence": "verified", "source": "human",
        }),
        ("dm-case.md", "达梦 DM 转换 函数 案例", {
            "business_domain": "db_migrate", "kb_type": "cases",
            "target_db": "dm", "stage": "transform", "object_type": "function",
            "confidence": "model_generated", "source": "model",
        }),
    ):
        row = DocumentRecord(name=name, source_type="md", doc_path="")
        with db.session() as s:
            s.add(row)
            s.commit()
            s.refresh(row)
        path = tmp_path / name
        path.write_text(text, encoding="utf-8")
        store.add_document(row.id, name, "md", str(path), **meta)
        docs.append(row.id)

    hits = store.search(
        "达梦 DM 转换 函数 NVL",
        top_k=3,
        candidate_k=20,
        min_similarity=0.35,
        business_domain="db_migrate",
        target_db="dm",
        stage="transform",
        object_type="function",
    )

    assert hits
    assert all(h["business_domain"] == "db_migrate" for h in hits)
    assert hits[0]["confidence"] == "verified"
    assert hits[0]["confidence_score"] == 1.0
    assert hits[0]["domain_match"] == 1.0
    assert 0 <= hits[0]["similarity"] <= 1
    assert hits[0]["fused_score"] >= 0.7
    assert any(h["needs_review"] for h in hits)


def test_negative_feedback_downgrades_confidence_and_marks_review(tmp_path):
    db, store = _store(tmp_path)
    row = DocumentRecord(name="规则.md", source_type="md", doc_path="", confidence="verified")
    with db.session() as s:
        s.add(row)
        s.commit()
        s.refresh(row)
    path = tmp_path / "rule.md"
    path.write_text("达梦 DM NVL 转换规则", encoding="utf-8")
    store.add_document(row.id, "规则.md", "md", str(path), confidence="verified")

    result = store.record_feedback(row.id, feedback="negative", reason="规则导致转换失败")

    assert result["confidence"] == "pending_review"
    assert result["review_required"] is True
    assert result["negative_feedback_count"] == 1
    with db.session() as s:
        fresh = s.get(DocumentRecord, row.id)
        assert fresh.confidence == "pending_review"
        assert fresh.review_required is True
    assert store._metadata[0]["confidence"] == "pending_review"
