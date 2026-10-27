"""OCR 文字提取：阿里云百炼 qwen-vl-ocr（扫描件 PDF / 图片降级方案）"""
from __future__ import annotations

import base64
import logging
from io import BytesIO
from typing import Optional

logger = logging.getLogger(__name__)


def ocr_available() -> bool:
    from jarvis_agent.config import load_config
    s = load_config().ocr
    return bool(s.api_key and s.model and s.base_url)


def _ocr_image_b64(client, base_url: str, api_key: str, model: str,
                   img_b64: str, mime: str = "image/png") -> str:
    r = client.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url",
                     "image_url": {"url": f"data:{mime};base64,{img_b64}"}},
                ],
            }],
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"] or ""


def ocr_image(data: bytes, mime: str = "image/png") -> Optional[str]:
    """对单张图片做 OCR，返回提取的文本；服务不可用时返回 None。"""
    if not ocr_available():
        return None
    from jarvis_agent.config import load_config
    s = load_config().ocr
    import httpx
    b64 = base64.b64encode(data).decode()
    try:
        with httpx.Client() as client:
            return _ocr_image_b64(client, s.base_url, s.api_key, s.model, b64, mime)
    except Exception:
        logger.exception("OCR image failed")
        return None


def ocr_pdf(data: bytes) -> Optional[str]:
    """对扫描件 PDF 做 OCR：提取每页内嵌图片发送给 qwen-vl-ocr，拼接文本。"""
    if not ocr_available():
        return None
    from jarvis_agent.config import load_config
    s = load_config().ocr

    from pypdf import PdfReader
    reader = PdfReader(BytesIO(data))
    texts = []
    import httpx
    try:
        with httpx.Client() as client:
            for page in reader.pages:
                page_images = page.images
                if not page_images:
                    texts.append(page.extract_text() or "")
                    continue
                page_text = []
                for img in page_images:
                    raw = img.data
                    mime = "image/png" if img.name.lower().endswith(".png") else "image/jpeg"
                    t = _ocr_image_b64(client, s.base_url, s.api_key, s.model, base64.b64encode(raw).decode(), mime)
                    if t.strip():
                        page_text.append(t.strip())
                texts.append("\n".join(page_text))
    except Exception:
        logger.exception("OCR pdf failed")
        return None
    return "\n".join(t for t in texts if t.strip())
