"""Reliability primitives for database and model calls."""
from __future__ import annotations

import time
from typing import Any, Callable


class CircuitOpenError(RuntimeError):
    """Raised when a circuit is open and the caller must back off."""


class CircuitBreaker:
    def __init__(self, failure_threshold: int, recovery_seconds: int,
                 clock: Callable[[], float] | None = None) -> None:
        self.failure_threshold = max(1, int(failure_threshold))
        self.recovery_seconds = max(1, int(recovery_seconds))
        self.failure_count = 0
        self.opened_at = 0.0
        self._state = "closed"
        self.clock = clock or time.monotonic

    @property
    def state(self) -> str:
        if self._state == "open" and self.clock() - self.opened_at >= self.recovery_seconds:
            self._state = "half_open"
        return self._state

    def allow_call(self) -> bool:
        return self.state != "open"

    def check_allowed(self) -> None:
        if not self.allow_call():
            raise CircuitOpenError("circuit breaker is open")

    def record_success(self) -> None:
        self.failure_count = 0
        self._state = "closed"
        self.opened_at = 0.0

    def record_failure(self) -> None:
        self.failure_count += 1
        if self._state == "half_open" or self.failure_count >= self.failure_threshold:
            self._state = "open"
            self.opened_at = self.clock()


class ReliableChatModel:
    """Invoke adapter adding retries and a circuit breaker around a chat model."""

    def __init__(self, model: Any, settings: Any,
                 sleeper: Callable[[float], None] = time.sleep) -> None:
        self.model = model
        self.settings = settings
        self.sleeper = sleeper
        self.breaker = CircuitBreaker(
            failure_threshold=settings.llm_failure_threshold,
            recovery_seconds=settings.llm_recovery_seconds,
        )

    def __getattr__(self, name: str) -> Any:
        # graph.py 的 _stream_llm 走流式调用 llm.stream()；parse 走结构化输出。
        # 这两个方法须透传到底层模型，否则会抛 AttributeError(name)，
        # 被 app.py 外层 except 原样作为 "stream"/"parse" 错误事件下发。
        if name in ("stream", "parse") and hasattr(self.model, name):
            return getattr(self.model, name)
        raise AttributeError(name)

    def invoke(self, messages: Any, **kwargs: Any) -> Any:
        self.breaker.check_allowed()
        attempts = max(1, int(self.settings.llm_retry_count))
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                result = self.model.invoke(messages, **kwargs)
                self.breaker.record_success()
                return result
            except (TimeoutError, ConnectionError) as exc:
                last_error = exc
                self.breaker.record_failure()
                if attempt + 1 >= attempts:
                    break
                self.breaker.check_allowed()
                delay = float(self.settings.llm_retry_backoff_seconds) * (2 ** attempt)
                self.sleeper(delay)
        assert last_error is not None
        raise last_error
