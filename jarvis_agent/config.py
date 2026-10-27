"""配置加载：config.yaml -> AppConfig；文件不存在时使用默认值（测试友好）"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

BASE_DIR = Path(__file__).resolve().parent.parent  # jarvis_agent/ 模块根


@dataclass
class LLMSettings:
    provider: str = "ollama"          # ollama | deepseek | bailian | zhipu
    base_url: str = "http://localhost:11434"
    model: str = "qwen2.5"
    api_key: str = ""
    embedding_model: str = "nomic-embed-text"
    embedding_provider: str = ""   # 为空时跟随 provider；可单独指定 bailian/zhipu/ollama
    embedding_api_key: str = ""    # 为空时跟随 api_key；可单独指定
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
class OCRSettings:
    provider: str = ""
    base_url: str = ""
    model: str = ""
    api_key: str = ""


@dataclass
class WorkflowSettings:
    # 工作流模板查询读取的数据源名称：默认远端工作流配置库，
    # 页面「本地库」开关则直读应用自身元数据库（mysql_url 指向的 jarvis 库）
    datasource_name: str = "工作流配置库"
    # 版本表名：远端带 aif_comframe 前缀；jarvis 库内为裸表名
    version_table: str = "aif_comframe.vm_template_version"
    local_version_table: str = "vm_template_version"


@dataclass
class AppConfig:
    name: str = "跨工程迭代开发多Agent智能编排平台"
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
    # 密码服务地址（SM4 字段解密，内网）；配置在 config.local.yaml（不入 git）
    decrypt_url: str = ""
    llm: LLMSettings = field(default_factory=LLMSettings)
    reliability: ReliabilitySettings = field(default_factory=ReliabilitySettings)
    ocr: OCRSettings = field(default_factory=OCRSettings)
    workflow: WorkflowSettings = field(default_factory=WorkflowSettings)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["llm"] = asdict(self.llm)
        d["ocr"] = asdict(self.ocr)
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
            elif key == "ocr" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.ocr, k):
                        setattr(cfg.ocr, k, v)
            elif key == "workflow" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.workflow, k):
                        setattr(cfg.workflow, k, v)
            elif hasattr(cfg, key):
                setattr(cfg, key, value)

    # 私有覆盖：config.local.yaml（不入 git）按相同结构合并，存放密钥等敏感配置
    local_path = BASE_DIR / "config.local.yaml"
    if local_path.exists() and yaml is not None:
        local = yaml.safe_load(local_path.read_text(encoding="utf-8")) or {}
        for key, value in local.items():
            if key == "llm" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.llm, k):
                        setattr(cfg.llm, k, v)
            elif key == "ocr" and isinstance(value, dict):
                for k, v in value.items():
                    if hasattr(cfg.ocr, k):
                        setattr(cfg.ocr, k, v)
            elif hasattr(cfg, key):
                setattr(cfg, key, value)

    # 环境变量最高优先级（CI/容器部署用）
    import os
    env_map = {
        "JARVIS_LLM_API_KEY": (cfg.llm, "api_key"),
        "JARVIS_EMBEDDING_API_KEY": (cfg.llm, "embedding_api_key"),
        "JARVIS_OCR_API_KEY": (cfg.ocr, "api_key"),
        "JARVIS_DECRYPT_URL": (cfg, "decrypt_url"),
        "JARVIS_MYSQL_URL": (cfg, "mysql_url"),
    }
    for env_key, (target, attr) in env_map.items():
        value = os.environ.get(env_key)
        if value:
            setattr(target, attr, value)
    return cfg
