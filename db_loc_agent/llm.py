"""LLM 工厂：ollama / deepseek / bailian / zhipu（OpenAI 兼容）"""
from __future__ import annotations

from typing import Any, Optional

from db_loc_agent.config import LLMSettings

DEEPSEEK_BASE = "https://api.deepseek.com/v1"
BAILIAN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
ZHIPU_BASE = "https://open.bigmodel.cn/api/paas/v4"


def create_chat_model(settings: LLMSettings, temperature: Optional[float] = None,
                      reliability: Any = None) -> Any:
    provider = (settings.provider or "ollama").lower()
    temp = temperature if temperature is not None else settings.temperature
    if provider == "ollama":
        from langchain_ollama import ChatOllama
        model = ChatOllama(model=settings.model or "qwen2.5",
                           base_url=settings.base_url or "http://localhost:11434",
                           temperature=temp, num_predict=settings.max_tokens)
    else:
        base_map = {"deepseek": DEEPSEEK_BASE, "bailian": BAILIAN_BASE,
                    "zhipu": ZHIPU_BASE}
        api_key = settings.api_key
        if not api_key:
            raise ValueError(f"提供商 {provider} 需要 api_key")
        from langchain_openai import ChatOpenAI
        timeout = max(1, int(reliability.llm_timeout_seconds)) if reliability is not None else None
        model = ChatOpenAI(model=settings.model, api_key=api_key,
                           base_url=settings.base_url or base_map.get(provider),
                           temperature=temp, max_tokens=settings.max_tokens,
                           timeout=timeout)
    if reliability is not None:
        from db_loc_agent.reliability import ReliableChatModel
        return ReliableChatModel(model, reliability)
    return model
