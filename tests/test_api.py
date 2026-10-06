from fastapi.testclient import TestClient

from db_loc_agent.app import create_app


class FakeEmbedding:
    """确定性向量：按文本长度/序号生成，无需网络"""

    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


def _client(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        config_override={"llm": {"provider": "ollama",
                                 "model": "qwen2.5",
                                 "base_url": "http://127.0.0.1:1"},
                         "mysql_url": ""},  # 强制 SQLite 隔离，不污染生产 MySQL
        embedding_function=FakeEmbedding(),
    )
    return TestClient(app)


def test_health_and_static(tmp_path):
    c = _client(tmp_path)
    assert c.get("/api/health").json()["status"] == "ok"
    assert c.get("/").status_code == 200


def test_conversation_crud(tmp_path):
    c = _client(tmp_path)
    r = c.post("/api/conversations", json={"title": "会话A"})
    assert r.status_code == 200
    conv = r.json()["data"]
    assert conv["id"] > 0
    assert c.get("/api/conversations").json()["data"]
    assert c.delete(f"/api/conversations/{conv['id']}").json()["success"] is True


def test_prompt_skill_pipeline(tmp_path):
    c = _client(tmp_path)
    r = c.post("/api/prompts", json={"name": "p1", "category": "agent", "content": "内容"})
    assert r.status_code == 200
    r = c.post("/api/skills", json={"name": "Oracle转换", "description": "d",
                                    "content": "规则"})
    assert r.status_code == 200
    sid = r.json()["data"]["skill_id"]
    assert c.post(f"/api/skills/{sid}/toggle", json={"enabled": True}).json()["success"] is True
    r = c.post("/api/mcp/servers", json={"name": "demo", "kind": "http",
                                         "command_or_url": "http://127.0.0.1:1"})
    assert r.status_code == 200
    assert c.get("/api/mcp/servers").json()["data"]


def test_conversation_trace_api(tmp_path):
    """trace 查询 API：空会话返回空列表，不 500"""
    c = _client(tmp_path)
    r = c.post("/api/conversations", json={"title": "trace会话"})
    cid = r.json()["data"]["id"]
    tr = c.get(f"/api/conversations/{cid}/trace")
    assert tr.status_code == 200
    assert tr.json()["success"] is True
    assert tr.json()["data"] == []


def test_upload_pdf(tmp_path):
    from fpdf import FPDF

    c = _client(tmp_path)
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("helvetica", size=12)
    pdf.cell(text="PDF knowledge doc")
    r = c.post("/api/kb/documents",
               files={"file": ("guide.pdf", bytes(pdf.output()), "application/pdf")})
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["data"]["chunks"] >= 1
    docs = c.get("/api/kb/documents").json()["data"]
    assert any(d["name"] == "guide.pdf" for d in docs)

    # 扫描件/图片 PDF 不报崩溃，仍应明确报错
    bad_data = b"%PDF-1.4 \n1 0 obj\n%fake" + b"x" * 20
    bad = c.post("/api/kb/documents",
                 files={"file": ("scan.pdf", bad_data, "application/pdf")})
    assert bad.status_code == 400