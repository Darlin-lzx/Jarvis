"""安全网关：可选 API Key 鉴权 + 分钟级令牌桶限流 + 审计日志落库"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional, Tuple


class SecurityGateway:
    """集中式安全中间件逻辑（无第三方依赖，纯内存限流）。

    - authorize(remote_ip, headers) -> Optional[str]：返回拦截原因；None 表示放行
    - audit(db, method, path, ip, status, duration_ms, notes)：审计落库
    - sql_note(sql)：SQL 操作审计的备注前缀（只读校验）由 DbTools 调用
    """

    def __init__(self, api_key: str = "", rate_limit_per_min: int = 0,
                 security_log: bool = True):
        self.api_key = (api_key or "").strip()
        self.rate_limit = max(0, int(rate_limit_per_min or 0))
        self.security_log = security_log
        self._buckets: Dict[str, Tuple[int, float]] = {}  # ip -> (count, window_start)

    def _check_rate(self, ip: str) -> bool:
        """固定窗口限流：窗口内请求数不超过上限，返回 True 表示超限。"""
        if self.rate_limit <= 0:
            return False
        now = time.time()
        count, start = self._buckets.get(ip, (0, now))
        if now - start >= 60:  # 新窗口
            self._buckets[ip] = (1, now)
            return False
        if count >= self.rate_limit:
            return True
        self._buckets[ip] = (count + 1, start)
        return False

    def authorize(self, ip: str = "", headers: Any = None) -> Optional[str]:
        """返回 None 表示放行；否则返回 401/429 的拦截原因。"""
        # 1) 鉴权：X-API-Key 或 Authorization: Bearer <key>
        if self.api_key:
            key = ""
            h = headers or {}
            key = h.get("x-api-key", "") or ""
            if not key:
                auth = h.get("authorization", "")
                if auth.lower().startswith("bearer "):
                    key = auth[7:].strip()
            if key != self.api_key:
                return "invalid_api_key"
        # 2) 限流
        if self._check_rate(ip or "unknown"):
            return "rate_limited"
        return None

    def audit(self, db: Any, method: str, path: str, ip: str,
              status: int, duration_ms: int = 0, notes: str = "") -> None:
        if not self.security_log or db is None:
            return
        try:
            from jarvis_agent.db import SecurityLog
            with db.session() as s:
                s.add(SecurityLog(method=method[:10], path=(path or "")[:500], ip=(ip or "")[:64],
                                  status=int(status), duration_ms=int(duration_ms),
                                  notes=(notes or "")[:1000]))
                s.commit()
        except Exception:
            pass  # 审计失败不影响主流程