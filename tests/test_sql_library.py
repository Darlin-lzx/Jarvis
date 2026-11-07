"""数据源 SQL 库：文件解析 / 安全命名 / 读写往返 / API 端点。"""
import pytest
from fastapi.testclient import TestClient

from jarvis_agent import sql_library as lib
from jarvis_agent.app import create_app


SAMPLE = """-- name: 历史工单
SELECT * FROM his_hall_task WHERE CUST_ORDER_ID = '{order}';

-- name: 流程实例
SELECT * FROM his_hall_task_flow_ins WHERE CUST_ORDER_ID = '{order}';
"""


class FakeEmbedding:
    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


def _client(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "t.db"),
        artifact_root=str(tmp_path / "artifacts"),
        faiss_dir=str(tmp_path / "faiss"),
        config_override={"llm": {"provider": "ollama", "model": "demo",
                                 "base_url": "http://127.0.0.1:1"},
                         "mysql_url": ""},
        embedding_function=FakeEmbedding(),
    )
    return TestClient(app)


# ---------- parse_statements ----------

def test_parse_statements_with_markers():
    statements = lib.parse_statements(SAMPLE)
    assert [item["name"] for item in statements] == ["历史工单", "流程实例"]
    assert "{order}" in statements[0]["sql"]


def test_parse_statements_without_markers():
    assert lib.parse_statements("SELECT 1 FROM dual") == [
        {"name": "未命名", "sql": "SELECT 1 FROM dual"}]


def test_parse_statements_empty():
    assert lib.parse_statements("") == []
    assert lib.parse_statements("   \n\t ") == []


def test_parse_statements_preamble_becomes_unnamed():
    statements = lib.parse_statements("PREAMBLE;\n-- name: a\nSELECT 1;")
    assert [item["name"] for item in statements] == ["未命名", "a"]
    assert statements[1]["sql"] == "SELECT 1;"


def test_parse_statements_drops_empty_section():
    statements = lib.parse_statements("-- name: a\n-- name: b\nSELECT 1;")
    assert [item["name"] for item in statements] == ["b"]


def test_parse_statements_accepts_fullwidth_colon():
    statements = lib.parse_statements("-- name：全角\nSELECT 1;")
    assert [item["name"] for item in statements] == ["全角"]


# ---------- safe_name ----------

def test_safe_name_keeps_cjk_wordchars_and_dash():
    assert lib.safe_name("客户订单库") == "客户订单库"
    assert lib.safe_name(" order-4 ") == "order-4"


def test_safe_name_neutralizes_traversal():
    cleaned = lib.safe_name("../../etc/passwd")
    assert "/" not in cleaned and "." not in cleaned


def test_safe_name_rejects_blank():
    for bad in ("", "   ", "...", "..", "."):
        with pytest.raises(ValueError):
            lib.safe_name(bad)


# ---------- 文件读写 ----------

def test_save_get_roundtrip(tmp_path):
    result = lib.save_file(tmp_path, "客户订单库", SAMPLE)
    assert [item["name"] for item in result["entries"]] == ["历史工单", "流程实例"]
    got = lib.get_file(tmp_path, "客户订单库")
    assert got["exists"] is True
    assert got["content"] == SAMPLE
    assert len(got["entries"]) == 2
    missing = lib.get_file(tmp_path, "家庭订单库")
    assert missing["exists"] is False
    assert missing["content"] == "" and missing["entries"] == []


def test_list_library_sorted_with_counts(tmp_path):
    lib.save_file(tmp_path, "b库", "SELECT 1;")
    lib.save_file(tmp_path, "a库", SAMPLE)
    items = lib.list_library(tmp_path)
    assert [item["datasource"] for item in items] == ["a库", "b库"]
    assert items[0]["statement_count"] == 2
    assert items[1]["statement_count"] == 1
    assert isinstance(items[0]["updated_at"], int)
    assert lib.list_library(tmp_path / "not_exists") == []


def test_save_rejects_oversize(tmp_path):
    oversized = "SELECT 1;" * (lib.MAX_FILE_BYTES // 8 + 1)
    with pytest.raises(ValueError):
        lib.save_file(tmp_path, "big", oversized)


def test_save_atomic_no_tmp_leftover(tmp_path):
    lib.save_file(tmp_path, "x", "SELECT 1;")
    assert [p.name for p in tmp_path.iterdir()] == ["x.sql"]


def test_rename_file_moves_and_never_overwrites(tmp_path):
    lib.save_file(tmp_path, "old", SAMPLE)
    lib.save_file(tmp_path, "occupied", "SELECT 9;")
    lib.rename_file(tmp_path, "old", "occupied")  # 目标已存在 → 不动
    assert lib.get_file(tmp_path, "old")["exists"] is True
    assert lib.get_file(tmp_path, "occupied")["content"] == "SELECT 9;"
    lib.rename_file(tmp_path, "old", "fresh")
    assert lib.get_file(tmp_path, "old")["exists"] is False
    assert lib.get_file(tmp_path, "fresh")["exists"] is True
    lib.rename_file(tmp_path, "ghost", "any")  # 旧文件不存在 → 静默跳过


# ---------- API ----------

def test_api_list_get_save(tmp_path):
    c = _client(tmp_path)
    library_dir = tmp_path / "sql_library"
    assert c.get("/api/sql-library").json()["data"] == []

    saved = c.put("/api/sql-library/客户订单库", json={"content": SAMPLE})
    assert saved.status_code == 200
    assert saved.json()["data"]["entries"][0]["name"] == "历史工单"

    got = c.get("/api/sql-library/客户订单库").json()["data"]
    assert got["exists"] is True and len(got["entries"]) == 2

    items = c.get("/api/sql-library").json()["data"]
    assert items == [{"datasource": "客户订单库", "statement_count": 2,
                      "updated_at": items[0]["updated_at"]}]


def test_api_missing_file_returns_empty_exists_false(tmp_path):
    c = _client(tmp_path)
    got = c.get("/api/sql-library/未配置库").json()["data"]
    assert got == {"datasource": "未配置库", "content": "", "entries": [], "exists": False}


def test_api_rejects_bad_name_and_oversize(tmp_path):
    c = _client(tmp_path)
    # `..` 在路由层即被规范化为 404；纯下划线名能到达端点，safe_name 归空 → 400
    assert c.get("/api/sql-library/___").status_code == 400
    oversized = "SELECT 1;" * (lib.MAX_FILE_BYTES // 8 + 1)
    assert c.put("/api/sql-library/big", json={"content": oversized}).status_code == 400


def test_api_datasource_rename_moves_file(tmp_path):
    c = _client(tmp_path)
    library_dir = tmp_path / "sql_library"
    c.post("/api/datasources", json={
        "name": "旧名", "kind": "sqlite", "location": str(tmp_path / "x.db")})
    c.put("/api/sql-library/旧名", json={"content": SAMPLE})
    # 数据源改名（PUT /api/datasources/{name}，payload.name 为新名）→ 文件跟随移动
    c.put("/api/datasources/旧名", json={
        "name": "新名", "kind": "sqlite", "location": str(tmp_path / "x.db")})
    assert lib.get_file(library_dir, "旧名")["exists"] is False
    assert lib.get_file(library_dir, "新名")["exists"] is True
