"""Embedding 工厂：Ollama 本地 / 百炼 / 智谱"""
from __future__ import annotations

from typing import Any, List

from jarvis_agent.config import LLMSettings

BAILIAN_EMBED_MODEL = "text-embedding-v3"
ZHIPU_BASE = "https://open.bigmodel.cn/api/paas/v4"
ZHIPU_EMBED_MODEL = "embedding-3"


class _OllamaEmbeddingFunction:
    def __init__(self, base_url: str, model: str):
        import httpx
        self._client = httpx.Client(base_url=base_url, timeout=60)
        self._model = model

    def __call__(self, input: Any) -> List[List[float]]:
        texts = input if isinstance(input, list) else [input]
        vectors = []
        for t in texts:
            r = self._client.post("/api/embeddings",
                                  json={"model": self._model, "prompt": t})
            r.raise_for_status()
            vectors.append(r.json()["embedding"])
        return vectors


class _BailianEmbeddingFunction:
    def __init__(self, api_key: str, model: str = BAILIAN_EMBED_MODEL):
        import httpx
        self._client = httpx.Client(base_url="https://dashscope.aliyuncs.com", timeout=60)
        self._api_key = api_key
        self._model = model

    def __call__(self, input: Any) -> List[List[float]]:
        texts = input if isinstance(input, list) else [input]
        vectors = []
        import time
        for t in texts:
            for attempt in range(3):
                r = self._client.post(
                    "/compatible-mode/v1/embeddings",
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json={"model": self._model, "input": [t]})
                if r.status_code in (429, 400):
                    time.sleep(1 * (attempt + 1))
                    continue
                r.raise_for_status()
                break
            else:
                r.raise_for_status()
            vectors.append(r.json()["data"][0]["embedding"])
        return vectors


class ZhipuEmbeddingFunction:
    def __init__(self, api_key: str, model: str = ZHIPU_EMBED_MODEL, base_url: str = ZHIPU_BASE):
        import httpx
        self._base = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self._base, timeout=60)
        self._api_key = api_key
        self._model = model

    def __call__(self, input: Any) -> List[List[float]]:
        texts = input if isinstance(input, list) else [input]
        vectors = []
        for t in texts:
            r = self._client.post(
                f"{self._base}/embeddings",
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"model": self._model, "input": [t]})
            r.raise_for_status()
            vectors.append(r.json()["data"][0]["embedding"])
        return vectors


def create_embedding_function(settings: LLMSettings) -> Any:
    provider = (settings.embedding_provider or settings.provider or "ollama").lower()
    api_key = settings.embedding_api_key or settings.api_key
    if provider == "bailian":
        return _BailianEmbeddingFunction(api_key, settings.embedding_model or BAILIAN_EMBED_MODEL)
    if provider == "zhipu":
        return ZhipuEmbeddingFunction(api_key, settings.embedding_model or ZHIPU_EMBED_MODEL,
                                      base_url=settings.base_url or ZHIPU_BASE)
    return _OllamaEmbeddingFunction(settings.base_url or "http://localhost:11434",
                                    settings.embedding_model or "nomic-embed-text")


def _create_embedding_function_legacy(settings: LLMSettings) -> Any:
    provider = (settings.provider or "ollama").lower()
    if provider == "bailian":
        return _BailianEmbeddingFunction(settings.api_key, settings.embedding_model or BAILIAN_EMBED_MODEL)
    if provider == "zhipu":
        return ZhipuEmbeddingFunction(settings.api_key, settings.embedding_model or ZHIPU_EMBED_MODEL,
                                      base_url=settings.base_url or ZHIPU_BASE)
    return _OllamaEmbeddingFunction(settings.base_url or "http://localhost:11434",
                                    settings.embedding_model or "nomic-embed-text")
