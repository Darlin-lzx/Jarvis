import pytest

from jarvis_agent.config import ReliabilitySettings
from jarvis_agent.reliability import CircuitBreaker, CircuitOpenError, ReliableChatModel


def test_circuit_breaker_opens_and_half_open_recovers():
    breaker = CircuitBreaker(failure_threshold=3, recovery_seconds=30, clock=lambda: 100.0)
    assert breaker.state == "closed"
    for _ in range(3):
        breaker.record_failure()
    assert breaker.state == "open"
    assert breaker.allow_call() is False
    with pytest.raises(CircuitOpenError):
        breaker.check_allowed()
    breaker.clock = lambda: 131.0
    assert breaker.state == "half_open"
    breaker.record_success()
    assert breaker.state == "closed"
    assert breaker.failure_count == 0


def test_circuit_breaker_half_open_failure_reopens():
    breaker = CircuitBreaker(failure_threshold=2, recovery_seconds=10, clock=lambda: 50.0)
    breaker.record_failure()
    breaker.record_failure()
    breaker.clock = lambda: 61.0
    breaker.record_failure()
    assert breaker.state == "open"


class FlakyModel:
    def __init__(self):
        self.calls = 0

    def invoke(self, messages):
        self.calls += 1
        if self.calls < 3:
            raise TimeoutError("model timeout")
        return {"content": "ok"}


def test_reliable_chat_model_retries_transient_failure():
    settings = ReliabilitySettings(llm_retry_count=3, llm_retry_backoff_seconds=0)
    model = FlakyModel()
    reliable = ReliableChatModel(model, settings, sleeper=lambda seconds: None)
    assert reliable.invoke("hello") == {"content": "ok"}
    assert model.calls == 3


def test_reliable_chat_model_opens_after_failure_threshold():
    class TimeoutModel:
        def invoke(self, messages):
            raise TimeoutError("always timeout")

    settings = ReliabilitySettings(
        llm_failure_threshold=1, llm_retry_count=1, llm_retry_backoff_seconds=0
    )
    reliable = ReliableChatModel(TimeoutModel(), settings, sleeper=lambda seconds: None)
    with pytest.raises(TimeoutError):
        reliable.invoke("one")
    with pytest.raises(CircuitOpenError):
        reliable.invoke("two")


def test_reliable_chat_model_does_not_advertise_missing_parse():
    class ChatModelWithoutParse:
        def invoke(self, messages):
            return messages

    settings = ReliabilitySettings(llm_retry_count=1, llm_retry_backoff_seconds=0)
    reliable = ReliableChatModel(
        ChatModelWithoutParse(), settings, sleeper=lambda seconds: None
    )
    assert hasattr(reliable, "parse") is False


def test_db_tools_guard_connections_with_circuit_breaker(tmp_path):
    from jarvis_agent.db import Database
    from jarvis_agent.db_tools import DbTools

    class Recorder:
        def __init__(self):
            self.allowed = 0
            self.successes = 0

        def check_allowed(self):
            self.allowed += 1

        def record_success(self):
            self.successes += 1

    breaker = Recorder()
    db = Database(str(tmp_path / "meta.db"))
    tools = DbTools(db, circuit_breaker=breaker)
    source = tmp_path / "source.db"
    source.write_text("", encoding="utf-8")
    tools.create("guarded", kind="sqlite", location=str(source))

    with tools.connect("guarded"):
        pass

    assert breaker.allowed == 1
    assert breaker.successes == 1
