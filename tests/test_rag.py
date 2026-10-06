from db_loc_agent.db import DocumentRecord, Database
from db_loc_agent.rag import RAGStore, extract_pdf_text, split_markdown, split_sql


class FakeEmbedding:
    """确定性向量：按文本长度/序号生成，无需网络"""

    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


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