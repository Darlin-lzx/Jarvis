from db_loc_agent.config import AppConfig, load_config


def test_default_config():
    cfg = AppConfig()
    assert cfg.name == "数据库国产化智能体"
    assert cfg.port == 5010
    assert cfg.llm.provider == "ollama"


def test_load_missing_yaml_uses_defaults(tmp_path):
    cfg = load_config(tmp_path / "not_exist.yaml")
    assert isinstance(cfg, AppConfig)
    assert cfg.rag_top_k == 4