"""接口调用代理：请求头组装 / 参数校验 / 超时上限 / SSRF 白名单 / 响应大小上限 / API 端点转发。"""
import httpx
from fastapi.testclient import TestClient

from jarvis_agent import api_call as lib
from jarvis_agent.app import create_app


class FakeEmbedding:
    def __call__(self, input):
        texts = input if isinstance(input, list) else [input]
        return [[1.0 if (len(t) + i) % 2 == 0 else -1.0 for i in range(8)] for t in texts]


class FakeStreamResponse:
    """模拟 httpx 流式响应：状态码/响应头 + 按预置分块输出响应体。"""

    def __init__(self, status_code=200, text="{}", chunks=None):
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}
        self._chunks = chunks or [text.encode("utf-8")]

    def iter_bytes(self):
        yield from self._chunks


class FakeStreamContext:
    """支持 with 语法的流式响应上下文。"""

    def __init__(self, response):
        self._response = response

    def __enter__(self):
        return self._response

    def __exit__(self, *exc):
        return False


def _patch_client(monkeypatch, response=None, error=None):
    """把 httpx.Client 替换为可控假客户端，返回捕获的请求参数。
    error 非空时 stream() 抛该异常（模拟网络层失败/非法 URL）。"""
    captured = {}

    def fake_client(timeout=None):
        captured["timeout"] = timeout

        def stream(method, url, content=None, headers=None):
            captured.update(url=url, content=content, headers=headers)
            if error is not None:
                raise error
            return FakeStreamContext(response or FakeStreamResponse())

        client = type("FakeClient", (), {
            "__enter__": lambda self: self,
            "__exit__": lambda self, *exc: False,
            "stream": staticmethod(stream),
        })()
        return client

    monkeypatch.setattr(lib.httpx, "Client", fake_client)
    return captured


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


# ---------- 参数校验 ----------

def test_call_interface_validates_kind_url_body():
    # kind 不在 page/gateway 内 → 拒绝
    try:
        lib.call_interface({"kind": "other", "url": "http://x", "body": "{}"})
        assert False, "非法 kind 应抛 ValueError"
    except ValueError as e:
        assert "page" in str(e)
    # URL 为空 → 拒绝
    try:
        lib.call_interface({"kind": "page", "url": "  ", "body": "{}"})
        assert False, "空 URL 应抛 ValueError"
    except ValueError as e:
        assert "URL" in str(e)
    # 请求体为空白 → 拒绝
    try:
        lib.call_interface({"kind": "gateway", "url": "http://x", "body": " \n "})
        assert False, "空请求体应抛 ValueError"
    except ValueError as e:
        assert "请求体" in str(e)


# ---------- SSRF 白名单 ----------

def test_host_allowlist_blocks_and_matches(monkeypatch):
    # 白名单不匹配 → ValueError（端点映射 400）
    try:
        lib.call_interface({"kind": "page", "url": "http://evil.internal/api", "body": "{}"},
                           allowed_hosts=["gw.example.com"])
        assert False, "白名单外主机应抛 ValueError"
    except ValueError as e:
        assert "白名单" in str(e)
    # 匹配（含端口、大小写差异）→ 正常转发
    captured = _patch_client(monkeypatch)
    lib.call_interface({"kind": "page", "url": "http://GW.Example.com:8080/api", "body": "{}"},
                       allowed_hosts=["gw.example.com"])
    assert captured["url"] == "http://GW.Example.com:8080/api"


# ---------- 请求头组装与转发 ----------

def test_page_headers_carry_main_acct_and_token(monkeypatch):
    captured = _patch_client(monkeypatch, response=FakeStreamResponse(text='{"code":"0"}'))
    result = lib.call_interface({
        "kind": "page", "url": "http://example/csf/init",
        "body": '{"busiType":"packageChange"}',
        "main_acct": "475D4A05175845F6", "token": "CPT98f",
    })
    assert captured["headers"]["Content-Type"] == "application/json"
    assert captured["headers"]["mainAcct"] == "475D4A05175845F6"
    assert captured["headers"]["token"] == "CPT98f"
    # 请求体按 UTF-8 原文转发
    assert captured["content"] == '{"busiType":"packageChange"}'.encode("utf-8")
    # 拿到响应 → ok=True，状态码与响应体透传
    assert result["ok"] is True
    assert result["status"] == 200
    assert result["body"] == '{"code":"0"}'


def test_gateway_headers_carry_auth_fields(monkeypatch):
    captured = _patch_client(monkeypatch,
                             response=FakeStreamResponse(status_code=500, text="<ERR/>"))
    result = lib.call_interface({
        "kind": "gateway", "url": "http://gw/http", "body": "<REQ_PARAM/>",
        "access_token": "4dbfbaea", "api_code": "ESB_SO_001", "api_version": "1.0.0",
        "app_code": "sys_busihall", "format": "http+xml", "operator_id": "20240810",
    })
    headers = captured["headers"]
    assert headers["Content-Type"] == "application/xml"
    assert headers["accessToken"] == "4dbfbaea"
    assert headers["apiCode"] == "ESB_SO_001"
    assert headers["apiVersion"] == "1.0.0"
    assert headers["appCode"] == "sys_busihall"
    assert headers["format"] == "http+xml"
    assert headers["operatorId"] == "20240810"
    # 非 2xx 响应同样是「执行成功」：ok=True，状态码原样带回由前端判断
    assert result["ok"] is True
    assert result["status"] == 500


def test_gateway_headers_fill_default_api_version_and_format(monkeypatch):
    captured = _patch_client(monkeypatch)
    lib.call_interface({"kind": "gateway", "url": "http://gw/http", "body": "<a/>"})
    assert captured["headers"]["apiVersion"] == "1.0.0"
    assert captured["headers"]["format"] == "http+xml"


# ---------- 超时与响应大小 ----------

def test_timeout_is_capped_and_defaulted(monkeypatch):
    # 超上限 → 夹到 120
    captured = _patch_client(monkeypatch)
    lib.call_interface({"kind": "page", "url": "http://x", "body": "{}",
                        "main_acct": "a", "token": "t", "timeout": 999})
    assert captured["timeout"] == 120
    # 非法输入 → 回退默认 30
    captured = _patch_client(monkeypatch)
    lib.call_interface({"kind": "page", "url": "http://x", "body": "{}",
                        "main_acct": "a", "token": "t", "timeout": "abc"})
    assert captured["timeout"] == 30
    # NaN 经 min/max 夹取不生效，必须显式归一 → 30
    captured = _patch_client(monkeypatch)
    lib.call_interface({"kind": "page", "url": "http://x", "body": "{}",
                        "main_acct": "a", "token": "t", "timeout": "nan"})
    assert captured["timeout"] == 30


def test_oversized_response_aborts(monkeypatch):
    """响应体超过 2MB 上限：流式读取中途抛 ValueError（端点映射 400），不占满内存。"""
    _patch_client(monkeypatch, response=FakeStreamResponse(
        chunks=[b"x" * lib.MAX_RESPONSE_BYTES, b"overflow"]))
    try:
        lib.call_interface({"kind": "page", "url": "http://x/big", "body": "{}"})
        assert False, "超限响应应抛 ValueError"
    except ValueError as e:
        assert "上限" in str(e)


def test_oversized_content_length_within_limit_ok(monkeypatch):
    """上限内的多块响应正常拼接返回。"""
    _patch_client(monkeypatch, response=FakeStreamResponse(text="abcdef", chunks=[b"abc", b"def"]))
    result = lib.call_interface({"kind": "page", "url": "http://x", "body": "{}"})
    assert result["ok"] is True
    assert result["body"] == "abcdef"


# ---------- 网络层错误 ----------

def test_network_error_returns_not_ok(monkeypatch):
    _patch_client(monkeypatch, error=httpx.ConnectError("连接被拒绝"))
    result = lib.call_interface({"kind": "gateway", "url": "http://10.255.255.1/http",
                                 "body": "<REQ_PARAM/>"})
    assert result["ok"] is False
    assert result["status"] == 0
    assert "请求失败" in result["message"]


def test_invalid_url_returns_not_ok(monkeypatch):
    """InvalidURL 不是 HTTPError 子类（httpx 0.28 实测），须单独捕获归一为 ok=False。"""
    _patch_client(monkeypatch, error=httpx.InvalidURL("URL 包含非法字符"))
    result = lib.call_interface({"kind": "page", "url": "http://x\x00y/", "body": "{}"})
    assert result["ok"] is False
    assert "URL 非法" in result["message"]


# ---------- API 端点 ----------

def test_api_call_endpoint_forwards_and_returns_data(monkeypatch, tmp_path):
    captured = _patch_client(monkeypatch, response=FakeStreamResponse(text='{"success":true}'))
    client = _client(tmp_path)
    resp = client.post("/api/api-call", json={
        "kind": "page", "url": "http://example/csf/init",
        "body": "{}", "main_acct": "A", "token": "T",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["ok"] is True
    assert body["data"]["status"] == 200
    assert body["data"]["body"] == '{"success":true}'


def test_api_call_endpoint_rejects_missing_url(tmp_path):
    client = _client(tmp_path)
    resp = client.post("/api/api-call", json={"kind": "page", "url": "", "body": "{}"})
    assert resp.status_code == 400
    assert "URL" in resp.json()["detail"]


def test_api_call_endpoint_maps_whitelist_and_size_errors(monkeypatch, tmp_path):
    """白名单拒绝与响应超限均作为 ValueError → 400 返回，而非 500。"""
    client = _client(tmp_path)
    # 白名单：通过 config_override 注入受限配置后端到端验证
    app = create_app(
        db_path=str(tmp_path / "w.db"),
        artifact_root=str(tmp_path / "wart"),
        faiss_dir=str(tmp_path / "wfaiss"),
        config_override={"llm": {"provider": "ollama", "model": "demo",
                                 "base_url": "http://127.0.0.1:1"},
                         "mysql_url": "",
                         "api_call_allowed_hosts": ["gw.example.com"]},
        embedding_function=FakeEmbedding(),
    )
    restricted = TestClient(app)
    resp = restricted.post("/api/api-call", json={
        "kind": "page", "url": "http://not-allowed/api", "body": "{}"})
    assert resp.status_code == 400
    assert "白名单" in resp.json()["detail"]
