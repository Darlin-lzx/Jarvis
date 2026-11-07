"""接口调用调试代理：页面接口（JSON）与中台接口（XML）的统一转发。

浏览器直连业务系统/网关会有 CORS 限制，前端把目标 URL、请求体与
鉴权头参数交给后端，由后端用 httpx 转发并把真实响应原样带回页面。
安全边界：目标主机白名单（可配置，空=不限制）、响应体大小上限。
"""
from __future__ import annotations

import math
import time
from typing import Any, Dict, List
from urllib.parse import urlparse

import httpx

# 超时上限（秒）：防止填错地址把后端 worker 长时间挂死
MAX_TIMEOUT_SECONDS = 120
DEFAULT_TIMEOUT_SECONDS = 30
# 响应体大小上限：调试接口的响应远小于此，超限基本是打错了内网大文件接口
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _page_headers(payload: Dict) -> Dict[str, str]:
    """页面接口请求头：JSON + mainAcct/token（取值由页面输入）。"""
    return {
        "Content-Type": "application/json",
        "mainAcct": str(payload.get("main_acct") or "").strip(),
        "token": str(payload.get("token") or "").strip(),
    }


def _gateway_headers(payload: Dict) -> Dict[str, str]:
    """中台接口请求头：XML + 网关鉴权头；apiVersion/format 留空时给默认值。"""
    return {
        "Content-Type": "application/xml",
        "accessToken": str(payload.get("access_token") or "").strip(),
        "apiCode": str(payload.get("api_code") or "").strip(),
        "apiVersion": str(payload.get("api_version") or "").strip() or "1.0.0",
        "appCode": str(payload.get("app_code") or "").strip(),
        "format": str(payload.get("format") or "").strip() or "http+xml",
        "operatorId": str(payload.get("operator_id") or "").strip(),
    }


def host_allowed(url: str, allowed_hosts: List[str]) -> bool:
    """目标主机白名单校验：列表为空不限制（保持调试代理的开放性）；
    条目按主机名精确匹配（忽略端口与大小写），如 `gateway.example.com`。"""
    if not allowed_hosts:
        return True
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    return host in (item.strip().lower() for item in allowed_hosts if item.strip())


def call_interface(payload: Dict, allowed_hosts: List[str] | None = None) -> Dict[str, Any]:
    """按 kind 转发一次接口调用，返回状态码/耗时/响应体等原始信息。

    只要拿到 HTTP 响应就视为执行成功（ok=True），业务成败由前端按
    状态码与响应内容自行判断；ok=False 仅表示网络层失败（连不上、
    超时、URL 非法、目标不在白名单等）。参数缺失或不合法时抛
    ValueError，由端点映射为 HTTP 400。
    """
    kind = str(payload.get("kind") or "").strip()
    url = str(payload.get("url") or "").strip()
    body = str(payload.get("body") or "")
    if kind not in ("page", "gateway"):
        raise ValueError("接口类型必须是 page（页面接口）或 gateway（中台接口）")
    if not url:
        raise ValueError("请填写接口 URL")
    if not body.strip():
        raise ValueError("请填写请求体")
    # SSRF 边界：部署方可配置目标主机白名单（config.yaml 的 api_call_allowed_hosts）
    if not host_allowed(url, allowed_hosts or []):
        raise ValueError(f"目标主机不在白名单内: {url}")

    headers = _page_headers(payload) if kind == "page" else _gateway_headers(payload)

    # 超时：非法输入回退默认值，并夹在 [1, MAX_TIMEOUT_SECONDS] 区间
    try:
        timeout = float(payload.get("timeout") or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT_SECONDS
    if math.isnan(timeout):  # NaN 参与 min/max 夹取不生效，先归一
        timeout = DEFAULT_TIMEOUT_SECONDS
    timeout = min(max(timeout, 1), MAX_TIMEOUT_SECONDS)

    started = time.monotonic()
    try:
        # 流式接收：边读边累计大小，超限立即中断，防止超大响应占满内存
        with httpx.Client(timeout=timeout) as client:
            with client.stream("POST", url, content=body.encode("utf-8"),
                               headers=headers) as response:
                status = response.status_code
                response_headers = dict(response.headers)
                chunks: list[bytes] = []
                received = 0
                for chunk in response.iter_bytes():
                    received += len(chunk)
                    if received > MAX_RESPONSE_BYTES:
                        raise ValueError(
                            f"响应体超过上限 {MAX_RESPONSE_BYTES // (1024 * 1024)}MB，已中止")
                    chunks.append(chunk)
    except ValueError:
        # 白名单/响应超限的业务校验错误，交由端点映射 400
        raise
    except httpx.InvalidURL as e:
        # InvalidURL 不是 HTTPError 子类（httpx 0.28 实测），必须单独捕获
        return {"ok": False, "status": 0, "elapsed_ms": 0, "url": url,
                "request_headers": headers, "response_headers": {},
                "body": "", "message": f"URL 非法: {e}"}
    except httpx.HTTPError as e:
        return {"ok": False, "status": 0, "elapsed_ms": 0, "url": url,
                "request_headers": headers, "response_headers": {},
                "body": "", "message": f"请求失败: {e}"}
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return {
        "ok": True,
        "status": status,
        "elapsed_ms": elapsed_ms,
        "url": url,
        "request_headers": headers,
        "response_headers": response_headers,
        "body": b"".join(chunks).decode("utf-8", "replace"),
        "message": "",
    }
