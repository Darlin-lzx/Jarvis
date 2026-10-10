import pytest

from db_loc_agent.config import LLMSettings
from db_loc_agent.embedding import (
    ZHIPU_EMBED_MODEL,
    ZhipuEmbeddingFunction,
    create_embedding_function,
)
from db_loc_agent.llm import ZHIPU_BASE, create_chat_model


def test_bailian_missing_key_raises():
    with pytest.raises(ValueError):
        create_chat_model(LLMSettings(provider="bailian", model="qwen-max", api_key=""))


def test_deepseek_missing_key_raises():
    with pytest.raises(ValueError):
        create_chat_model(LLMSettings(provider="deepseek", model="deepseek-chat", api_key=""))


def test_zhipu_missing_key_raises():
    with pytest.raises(ValueError):
        create_chat_model(LLMSettings(provider="zhipu", model="GLM-5.3", api_key=""))


def test_zhipu_uses_official_openai_compatible_base_url():
    from langchain_openai import ChatOpenAI

    m = create_chat_model(LLMSettings(provider="zhipu", base_url="",
                                      model="GLM-5.3", api_key="test-key"))
    assert isinstance(m, ChatOpenAI)
    assert ZHIPU_BASE == "https://open.bigmodel.cn/api/paas/v4"
    assert m.openai_api_base == ZHIPU_BASE
    assert m.model_name == "GLM-5.3"


def test_remote_chat_model_applies_reliability_timeout():
    from db_loc_agent.config import ReliabilitySettings
    from db_loc_agent.reliability import ReliableChatModel

    m = create_chat_model(
        LLMSettings(provider="zhipu", base_url="", model="GLM-5.3", api_key="test-key"),
        reliability=ReliabilitySettings(llm_timeout_seconds=17),
    )
    assert isinstance(m, ReliableChatModel)
    assert m.model.request_timeout == 17


def test_zhipu_uses_zhipu_embedding_function():
    fn = create_embedding_function(LLMSettings(provider="zhipu", base_url="",
                                                api_key="test-key",
                                                embedding_model=""))
    assert isinstance(fn, ZhipuEmbeddingFunction)
    assert ZHIPU_EMBED_MODEL == "embedding-3"
    assert fn._model == "embedding-3"
    assert str(fn._client.base_url).rstrip("/") == ZHIPU_BASE


def test_ollama_returns_chatmodel():
    from langchain_ollama import ChatOllama
    m = create_chat_model(LLMSettings(provider="ollama", model="qwen2.5"))
    assert isinstance(m, ChatOllama)
