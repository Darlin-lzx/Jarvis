"""LLM 工厂：ollama / deepseek / bailian（阿里云百炼，OpenAI 兼容）"""
from __future__ import annotations

from typing import Any, Optional

from db_loc_agent.config import LLMSettings

DEEPSEEK_BASE = "https://api.deepseek.com/v1"
BAILIAN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def create_chat_model(settings: LLMSettings, temperature: Optional[float] = None) -> Any:
    provider = (settings.provider or "ollama").lower()
    temp = temperature if temperature is not None else settings.temperature
    if provider == "ollama":
        from langchain_ollama import ChatOllama
        return ChatOllama(model=settings.model or "qwen2.5",
                          base_url=settings.base_url or "http://localhost:11434",
                          temperature=temp, num_predict=settings.max_tokens)
    base_map = {"deepseek": DEEPSEEK_BASE, "bailian": BAILIAN_BASE}
    api_key = settings.api_key
    if not api_key:
        raise ValueError(f"提供商 {provider} 需要 api_key")
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=settings.model, api_key=api_key,
                      base_url=settings.base_url or base_map.get(provider),
                      temperature=temp, max_tokens=settings.max_tokens)