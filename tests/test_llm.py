import pytest

from db_loc_agent.config import LLMSettings
from db_loc_agent.llm import create_chat_model


def test_bailian_missing_key_raises():
    with pytest.raises(ValueError):
        create_chat_model(LLMSettings(provider="bailian", model="qwen-max", api_key=""))


def test_deepseek_missing_key_raises():
    with pytest.raises(ValueError):
        create_chat_model(LLMSettings(provider="deepseek", model="deepseek-chat", api_key=""))


def test_ollama_returns_chatmodel():
    from langchain_ollama import ChatOllama
    m = create_chat_model(LLMSettings(provider="ollama", model="qwen2.5"))
    assert isinstance(m, ChatOllama)