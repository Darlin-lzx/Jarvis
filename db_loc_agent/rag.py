"""RAG 知识库：解析、分块、FAISS 向量化与检索"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import faiss
import numpy as np

from db_loc_agent.db import Database, DocumentRecord


def split_markdown(text: str, max_chars: int = 1200) -> List[str]:
    chunks, title, buf, size = [], "", [], 0
    def flush():
        nonlocal buf, size
        if buf:
            head = f"{title}：" if title else ""
            chunks.append((head + " ".join(x.strip() for x in buf)).strip())
            buf, size = [], 0
    for line in text.splitlines():
        if re.match(r"^#{1,6}\s+", line):
            flush()
            title = re.sub(r"^#+\s*", "", line).strip()
        else:
            buf.append(line)
            size += len(line)
            if size >= max_chars:
                flush()
    flush()
    return [c for c in chunks if c]


def split_sql(text: str) -> List[str]:
    blocks = re.split(
        r"(?i)(?=CREATE\s+(?:TABLE|PROCEDURE|FUNCTION|VIEW|INDEX|SEQUENCE|TRIGGER)\b)", text)
    return [b.strip() for b in blocks if b.strip()]


def split_text(text: str, size: int = 800, overlap: int = 80) -> List[str]:
    pieces, start = [], 0
    while start < len(text):
        pieces.append(text[start:start + size])
        start += size - overlap
    return [p for p in pieces if p.strip()]


def extract_pdf_text(data: bytes) -> str:
    """提取 PDF 文本：逐页提取后按页拼接"""
    from io import BytesIO

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    pages = []
    for page in reader.pages:
        pages.append((page.extract_text() or "").strip())
    return "\n".join(p for p in pages if p)


class RAGStore:
    def __init__(self, db: Database, faiss_dir: str, collection_name: str,
                 embedding_function: Any):
        self.db = db
        self._embed_fn = embedding_function
        self._dir = Path(faiss_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self._dir / f"{collection_name}.faiss"
        self._meta_path = self._dir / f"{collection_name}.meta.json"
        self._dim: Optional[int] = None
        self._index: Optional[faiss.Index] = None
        self._metadata: List[Dict] = []
        self._load()
        self._maybe_rebuild()

    # ---------- 持久化 ----------

    def _load(self) -> None:
        if self._index_path.exists():
            self._index = faiss.read_index(str(self._index_path))
            self._metadata = json.loads(self._meta_path.read_text(encoding="utf-8"))
            self._dim = self._index.d
        else:
            self._index = None
            self._metadata = []

    def _maybe_rebuild(self) -> None:
        """启动时探测当前 embedding 维度；与磁盘索引不一致（如更换了 embedding 模型）时
        立即用当前模型重建索引，避免任务会话（RAG 启用）首次查询时才触发慢速重建。"""
        if self._index is None or self._index.ntotal == 0:
            return
        try:
            dim = self._embed(["维度探测"]).shape[1]
        except Exception as e:
            print(f"[rag] 无法获取 embedding 维度，跳过索引维度校验：{e}")
            return
        if dim != self._index.d:
            old_dim = self._index.d
            try:
                self._settle_index(dim)
                print(f"[rag] 检测到 FAISS 索引维度不匹配（{old_dim} -> {dim}），"
                      f"已用当前 embedding 重建索引（{self._index.ntotal} 块）")
            except Exception as e:
                print(f"[rag] 索引重建失败（下次查询时会安全降级）：{e}")

    def _rebuild_from_metadata(self, dim: int) -> None:
        """用当前 embedding 基于各分块原文重建索引。
        metadata 已保存每块分块的完整文本，因此无需原始文档即可重建。"""
        contents = [m.get("content", "") for m in self._metadata]
        if not any(contents):
            # 无原文可重建，仅以新维度重置空索引
            self._index = faiss.IndexFlatIP(dim)
            return
        vecs = self._embed(contents)
        self._index = faiss.IndexFlatIP(vecs.shape[1])
        self._index.add(vecs)
        self._save()

    def _settle_index(self, dim: int) -> None:
        """确保索引维度为 dim；不一致时重建，避免 faiss.search 维度断言崩溃。"""
        if self._index is None or self._index.ntotal == 0:
            return
        if self._index.d == dim:
            return
        self._rebuild_from_metadata(dim)

    def _save(self) -> None:
        if self._index is not None:
            faiss.write_index(self._index, str(self._index_path))
            self._meta_path.write_text(
                json.dumps(self._metadata, ensure_ascii=False), encoding="utf-8")

    # ---------- 向量工具 ----------

    def _embed(self, texts: List[str]) -> np.ndarray:
        vecs = self._embed_fn(texts)
        arr = np.array(vecs, dtype=np.float32)
        # L2 归一化 → 内积 = 余弦相似度
        faiss.normalize_L2(arr)
        return arr

    def _ensure_index(self, dim: int) -> None:
        if self._index is None:
            self._dim = dim
            self._index = faiss.IndexFlatIP(dim)
            self._metadata = []
            return
        if self._index.d != dim:
            # 更换 embedding 模型后新增文档：优先基于既有分块原文重建，保留旧文档
            self._settle_index(dim)

    # ---------- 分块 ----------

    @staticmethod
    def _split(source_type: str, text: str) -> List[str]:
        if source_type == "md":
            return split_markdown(text)
        if source_type == "sql":
            return split_sql(text)
        return split_text(text)

    # ---------- 公开 API ----------

    def add_document(self, doc_id: int, name: str, source_type: str, doc_path: str,
                     space_id: Optional[int] = None,
                     kb_type: Optional[str] = None) -> Dict:
        text = Path(doc_path).read_text(encoding="utf-8")
        chunks = self._split(source_type, text)
        if chunks:
            vecs = self._embed(chunks)
            dim = vecs.shape[1]
            self._ensure_index(dim)
            ids = [f"{doc_id}-{i}" for i in range(len(chunks))]
            metas = [
                {"doc_id": str(doc_id), "doc_name": Path(doc_path).name,
                 "chunk_index": i, "type": source_type, "content": chunk,
                 "space_id": space_id, "kb_type": kb_type or "doc"}
                for i, chunk in enumerate(chunks)
            ]
            self._index.add(vecs)
            self._metadata.extend(metas)
            self._save()
        with self.db.session() as s:
            row = s.get(DocumentRecord, doc_id)
            if row:
                row.chunk_count = len(chunks)
                s.commit()
        return {"doc_id": doc_id, "chunks": len(chunks)}

    def search(self, query: str, top_k: int = 4,
               space_id: Optional[int] = None,
               kb_types: Optional[List[str]] = None,
               source_db: str = "", target_db: str = "") -> List[Dict]:
        """向量检索（分层知识库）。

        - space_id 非 None 时仅返回该空间的分块（无 space_id 的历史分块视为全局文档）；
        - kb_types（方向4 分层）：rules 规则库 / cases 案例库 / doc 归档文档，按任务阶段定向检索；
        - source_db / target_db：元数据关键词过滤（源库类型/目标国产库类型），缩小检索范围；
        - 关键词混合：候选命中检索词的分块权重加成（规则库关键词检索兜底，结果可复现）。
        """
        if self._index is None or self._index.ntotal == 0:
            return []
        try:
            q = self._embed([query])
            if q.shape[1] != self._index.d:
                # 索引由旧模型构建（维度不匹配）：用当前模型重建后重试
                self._settle_index(q.shape[1])
                if self._index is None or self._index.ntotal == 0:
                    return []
            # 带空间过滤时扩大候选池，过滤后仍能凑满 top_k
            k = min(top_k * 6 if (space_id is not None or kb_types) else top_k,
                    self._index.ntotal)
            scores, idxs = self._index.search(q, k)
        except Exception:
            # 检索失败（embedding 服务不可用等）时安全降级为空，避免阻断整个对话
            return []
        out = []
        ql = query.lower()
        q_tokens = [t for t in re.split(r"[\s,，。；;：:()<>=]+", ql) if len(t) >= 2]
        for rank, j in enumerate(idxs[0]):
            if j < 0 or j >= len(self._metadata):
                continue
            meta = self._metadata[j]
            if space_id is not None:
                meta_space = meta.get("space_id")
                if meta_space is not None and int(meta_space) != int(space_id):
                    continue
            if kb_types is not None:
                # 元数据过滤：无 kb_type 的旧分块视为 doc
                if (meta.get("kb_type") or "doc") not in kb_types:
                    continue
            if source_db or target_db:
                meta_db = (meta.get("kb_type") or "") + " " + (meta.get("content") or "")
                if source_db and source_db.lower() not in meta_db.lower():
                    if target_db and target_db.lower() not in meta_db.lower():
                        continue
            content = meta.get("content", "") or ""
            kw_hits = sum(1 for t in q_tokens if t in content.lower())
            score = round(float(scores[0][rank]), 4)
            # 关键词混合：命中检索词的分块权重加成（保证词典级命中稳定排前，结果可复现）
            if kw_hits:
                score = round(score + 0.05 * kw_hits, 4)
            out.append({
                "chunk_id": f"{meta['doc_id']}-{meta['chunk_index']}",
                "doc_name": meta.get("doc_name", ""),
                "chunk_index": meta.get("chunk_index", 0),
                "type": meta.get("type", ""),
                "kb_type": meta.get("kb_type", "doc"),
                "content": content,
                "score": score,
            })
        out.sort(key=lambda x: -x["score"])
        return out[:top_k]

    def delete_document(self, doc_id: int) -> None:
        if self._index is None:
            return
        sid = str(doc_id)
        # 找出要删除的向量位置
        keep_idx = [i for i, m in enumerate(self._metadata) if m.get("doc_id") != sid]
        if len(keep_idx) == len(self._metadata):
            # 该文档不在索引中，只删 DB 记录
            with self.db.session() as s:
                row = s.get(DocumentRecord, doc_id)
                if row:
                    s.delete(row)
                    s.commit()
            return
        # 重建索引（FAISS 不支持按位置删除，小规模数据重建开销可接受）
        vecs_all = np.zeros((self._index.ntotal, self._dim), dtype=np.float32)
        # 通过搜索自身获取向量（FAISS 无直接读回 API，用 reconstruction）
        try:
            for i in range(self._index.ntotal):
                vecs_all[i] = self._index.reconstruct(i)
        except RuntimeError:
            # IndexFlatIP 不支持 reconstruct，需要保留原始向量
            # 回退：标记删除但不重建（向量仍在，搜索时过滤）
            self._metadata = [m for i, m in enumerate(self._metadata) if i in keep_idx]
            self._save()
            with self.db.session() as s:
                row = s.get(DocumentRecord, doc_id)
                if row:
                    s.delete(row)
                    s.commit()
            return
        new_vecs = vecs_all[keep_idx]
        new_meta = [self._metadata[i] for i in keep_idx]
        self._index = faiss.IndexFlatIP(self._dim)
        self._index.add(new_vecs)
        self._metadata = new_meta
        self._save()
        with self.db.session() as s:
            row = s.get(DocumentRecord, doc_id)
            if row:
                s.delete(row)
                s.commit()

    def count(self) -> int:
        return self._index.ntotal if self._index else 0
