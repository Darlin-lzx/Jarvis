"""配置加载：config.yaml -> AppConfig；文件不存在时使用默认值（测试友好）"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

BASE_DIR = Path(__file__).resolve().parent.parent  # db_loc_agent/ 模块根


@dataclass
class LLMSettings:
    provider: str = "ollama"          # ollama | deepseek | bailian | zhipu
    base_url: str = "http://localhost:11434"
    model: str = "qwen2.5"
    api_key: str = ""
    embedding_model: str = "nomic-embed-text"
    temperature: float = 0.2
    max_tokens: int = 4096


@dataclass
class ReliabilitySettings:
    db_failure_threshold: int = 3
    db_recovery_seconds: int = 30
    llm_failure_threshold: int = 3
    llm_recovery_seconds: int = 60
    llm_retry_count: int = 3
    llm_retry_backoff_seconds: float = 1
    llm_timeout_seconds: int = 120
    node_timeout_seconds: int = 300


@dataclass
class AppConfig:
    name: str = "数据库国产化智能体"
    host: str = "0.0.0.0"
    port: int = 5010
    artifact_root: str = "artifacts"
    db_path: str = "data/db.sqlite3"
    mysql_url: str = ""  # 非空则业务库使用 MySQL（SQLAlchemy 连接串），为空则用 SQLite
    faiss_dir: str = "data/faiss"
    kb_collection: str = "migration_kb"
    rag_top_k: int = 4
    # 安全网关：api_key 为空则关闭鉴权；rate_limit=0 关闭限流（分钟级窗口）
    api_key: str = ""
    rate_limit: int = 0
    security_log: bool = True
    llm: LLMSettings = field(default_factory=LLMSettings)
    reliability: ReliabilitySettings = field(default_factory=ReliabilitySettings)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["llm"] = asdict(self.llm)
        return d


def load_config(path: str | None = None) -> AppConfig:
    cfg = AppConfig()
    cfg_path = Path(path) if path else BASE_DIR / "config.yaml"
    if cfg_path.exists() and yaml is not None:
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        for key, value in data.items():
            if key == "llm" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.llm, k):
                        setattr(cfg.llm, k, v)
            elif key == "reliability" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.reliability, k):
                        setattr(cfg.reliability, k, v)
            elif hasattr(cfg, key):
                setattr(cfg, key, value)
    return cfg
