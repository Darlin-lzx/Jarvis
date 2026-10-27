"""RAG 知识库：解析、分块、FAISS 向量化与检索"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import faiss
import numpy as np

from jarvis_agent.db import Database, DocumentRecord

CONFIDENCE_SCORES = {
    "verified": 1.0,
    "human_authority": 1.0,
    "pending_review": 0.6,
    "model_generated": 0.4,
}
DEFAULT_BUSINESS_DOMAIN = "db_migrate"


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
            # 超长单行按 max_chars 硬切，避免单 chunk 超过 embedding 上限
            for start in range(0, len(line), max_chars):
                piece = line[start:start + max_chars]
                buf.append(piece)
                size += len(piece)
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
        self._index = self._create_index(vecs.shape[1])
        self._index.add(vecs)
        self._save()

    @staticmethod
    def _create_index(dim: int) -> faiss.Index:
        """新索引用 HNSW；存量 Flat 索引继续兼容读取。"""
        index = faiss.IndexHNSWFlat(dim, 16, faiss.METRIC_INNER_PRODUCT)
        index.hnsw.efConstruction = 200
        return index

    def _settle_index(self, dim: int) -> None:
        """确保索引维度为 dim；不一致时重建，避免 faiss.search 维度断言崩溃。"""
        if self._index is None:
            return
        if self._index.ntotal == 0:
            if self._index.d != dim:
                self._index = self._create_index(dim)
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
            self._index = self._create_index(dim)
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
                     kb_id: Optional[int] = None,
                     kb_type: Optional[str] = None,
                     business_domain: str = DEFAULT_BUSINESS_DOMAIN,
                     target_db: str = "", stage: str = "", object_type: str = "",
                     confidence: str = "verified", source: str = "upload",
                     source_ref: str = "",
                     effective_time: Optional[datetime] = None) -> Dict:
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
                 "space_id": space_id, "kb_id": kb_id, "kb_type": kb_type or "doc",
                 "business_domain": business_domain or DEFAULT_BUSINESS_DOMAIN,
                 "target_db": target_db or "", "stage": stage or "",
                 "object_type": object_type or "",
                 "confidence": confidence if confidence in CONFIDENCE_SCORES else "verified",
                 "source": source or "upload", "source_ref": source_ref or "",
                 "effective_time": effective_time.isoformat() if effective_time else None,
                 "negative_feedback_count": 0, "review_required": False}
                for i, chunk in enumerate(chunks)
            ]
            self._index.add(vecs)
            self._metadata.extend(metas)
            self._save()
        with self.db.session() as s:
            row = s.get(DocumentRecord, doc_id)
            if row:
                row.chunk_count = len(chunks)
                row.business_domain = business_domain or DEFAULT_BUSINESS_DOMAIN
                row.target_db = target_db or ""
                row.stage = stage or ""
                row.object_type = object_type or ""
                row.confidence = confidence if confidence in CONFIDENCE_SCORES else "verified"
                row.source = source or "upload"
                row.source_ref = source_ref or ""
                row.effective_time = effective_time
                s.commit()
        return {"doc_id": doc_id, "chunks": len(chunks)}

    def search(self, query: str, top_k: int = 4,
               space_id: Optional[int] = None,
               space_ids: Optional[List[int]] = None,
               kb_ids: Optional[List[int]] = None,
               kb_types: Optional[List[str]] = None,
               source_db: str = "", target_db: str = "",
               business_domain: str = DEFAULT_BUSINESS_DOMAIN,
               stage: str = "", object_type: str = "",
               candidate_k: int = 20, min_similarity: float = 0.35) -> List[Dict]:
        """兼容旧调用方，返回增强检索结果列表。"""
        return self._search_core(
            query, top_k=top_k, space_id=space_id, space_ids=space_ids,
            kb_ids=kb_ids, kb_types=kb_types,
            source_db=source_db, target_db=target_db,
            business_domain=business_domain, stage=stage,
            object_type=object_type, candidate_k=candidate_k,
            min_similarity=min_similarity,
        )["results"]

    def _search_core(self, query: str, top_k: int = 4,
                     space_id: Optional[int] = None,
                     space_ids: Optional[List[int]] = None,
                     kb_ids: Optional[List[int]] = None,
                     kb_types: Optional[List[str]] = None,
                     source_db: str = "", target_db: str = "",
                     business_domain: str = DEFAULT_BUSINESS_DOMAIN,
                     stage: str = "", object_type: str = "",
                     candidate_k: int = 20,
                     min_similarity: float = 0.35) -> Dict:
        """过滤、Top20 语义候选、可信度与域匹配融合排序。

        - space_id 非 None 时仅返回该空间的分块（无 space_id 的历史分块视为全局文档）；
        - space_ids 非 None 时返回这些空间的分块并集（智能体专属知识库跨空间检索）；
        - kb_types（方向4 分层）：rules 规则库 / cases 案例库 / doc 归档文档，按任务阶段定向检索；
        - source_db / target_db：元数据关键词过滤（源库类型/目标国产库类型），缩小检索范围；
        - 关键词混合：候选命中检索词的分块权重加成（规则库关键词检索兜底，结果可复现）。
        """
        started = time.monotonic()
        if self._index is None or self._index.ntotal == 0:
            return {"results": [], "degraded": False, "elapsed_ms": 0,
                    "no_hit_reason": "empty_index"}
        if kb_ids is not None and not kb_ids:
            return {"results": [], "degraded": False, "elapsed_ms": 0,
                    "no_hit_reason": "empty_authorized_kb_filter"}
        try:
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="rag-search") as pool:
                q = pool.submit(self._embed, [query]).result(timeout=0.5)
            if q.shape[1] != self._index.d:
                # 索引由旧模型构建（维度不匹配）：用当前模型重建后重试
                self._settle_index(q.shape[1])
                if self._index is None or self._index.ntotal == 0:
                    return {"results": [], "degraded": False, "elapsed_ms": 0,
                            "no_hit_reason": "empty_index"}
            if isinstance(self._index, faiss.IndexHNSWFlat):
                self._index.hnsw.efSearch = 128
            allowed_spaces = None
            if space_ids:
                allowed_spaces = {int(x) for x in space_ids}
            elif space_id is not None:
                allowed_spaces = {int(space_id)}
            has_post_filter = any((allowed_spaces is not None, bool(kb_types), bool(target_db),
                                   bool(business_domain), bool(stage), bool(object_type)))
            search_k = min(max(candidate_k * 5 if has_post_filter else candidate_k, candidate_k),
                           self._index.ntotal)
            scores, idxs = self._index.search(q, search_k)
        except Exception as e:
            # 检索失败（embedding 服务不可用等）时安全降级为空，避免阻断整个对话
            return {"results": [], "degraded": True,
                    "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                    "no_hit_reason": f"vector_search_failed:{type(e).__name__}"}
        with self.db.session() as s:
            enabled_doc_ids = {str(row[0]) for row in s.query(DocumentRecord.id).filter(
                DocumentRecord.enabled == True)}
            # 文档 → 知识库映射（以库表为准，兼容历史分块 metadata 无 kb_id）
            kb_map = {int(row[0]): row[1] for row in
                      s.query(DocumentRecord.id, DocumentRecord.kb_id).all()
                      if row[1] is not None}
            allowed_kbs = None
            if kb_ids is not None:
                allowed_kbs = {int(x) for x in kb_ids}
        domain_filters = {
            "target_db": (target_db or "").lower(),
            "stage": (stage or "").lower(),
            "object_type": (object_type or "").lower(),
        }
        expected_dimensions = [value for value in domain_filters.values() if value]
        out = []
        ql = query.lower()
        q_tokens = [t for t in re.split(r"[\s,，。；;：:()<>=]+", ql) if len(t) >= 2]
        semantic_candidates = 0
        for rank, j in enumerate(idxs[0]):
            if j < 0 or j >= len(self._metadata):
                continue
            meta = self._metadata[j]
            if meta.get("doc_id") not in enabled_doc_ids:
                continue
            if allowed_kbs is not None:
                doc_kb = kb_map.get(int(meta.get("doc_id")))
                if doc_kb is None or int(doc_kb) not in allowed_kbs:
                    continue
            if allowed_spaces is not None:
                meta_space = meta.get("space_id")
                if meta_space is not None and int(meta_space) not in allowed_spaces:
                    continue
            if kb_types is not None:
                # 元数据过滤：无 kb_type 的旧分块视为 doc
                if (meta.get("kb_type") or "doc") not in kb_types:
                    continue
            meta_domain = (meta.get("business_domain") or DEFAULT_BUSINESS_DOMAIN).lower()
            if business_domain and meta_domain != business_domain.lower():
                continue
            matched_dimensions = []
            if expected_dimensions:
                for dimension, expected in domain_filters.items():
                    actual = (meta.get(dimension) or "").lower()
                    if actual == expected:
                        matched_dimensions.append(dimension)
                    elif actual and expected:
                        continue
                # 业务元数据允许为空（历史知识），但一旦填写就必须匹配。
                if len(matched_dimensions) != len(expected_dimensions):
                    continue
            if source_db or target_db:
                meta_db = (meta.get("kb_type") or "") + " " + (meta.get("content") or "")
                if source_db and source_db.lower() not in meta_db.lower():
                    if target_db and target_db.lower() not in meta_db.lower():
                        continue
            if semantic_candidates >= candidate_k:
                continue
            semantic_candidates += 1
            content = meta.get("content", "") or ""
            similarity = max(0.0, min(1.0, float(scores[0][rank])))
            if similarity < min_similarity:
                continue
            confidence = (meta.get("confidence") if meta.get("confidence") in
                          CONFIDENCE_SCORES else "verified")
            confidence_score = CONFIDENCE_SCORES[confidence]
            domain_match = (
                len(matched_dimensions) / len(expected_dimensions)
                if expected_dimensions else 1.0
            )
            fused_score = (
                0.4 * domain_match
                + 0.3 * confidence_score
                + 0.3 * similarity
            )
            kw_hits = sum(1 for t in q_tokens if t in content.lower())
            exact = bool(q_tokens) and all(t in content.lower() for t in q_tokens)
            out.append({
                "doc_id": int(meta.get("doc_id", 0) or 0),
                "chunk_id": f"{meta['doc_id']}-{meta['chunk_index']}",
                "doc_name": meta.get("doc_name", ""),
                "chunk_index": meta.get("chunk_index", 0),
                "type": meta.get("type", ""),
                "kb_type": meta.get("kb_type", "doc"),
                "business_domain": meta_domain,
                "target_db": meta.get("target_db", "") or "",
                "stage": meta.get("stage", "") or "",
                "object_type": meta.get("object_type", "") or "",
                "confidence": confidence,
                "confidence_score": confidence_score,
                "source": meta.get("source", "") or "",
                "source_ref": meta.get("source_ref", "") or "",
                "effective_time": meta.get("effective_time"),
                "negative_feedback_count": int(meta.get("negative_feedback_count", 0) or 0),
                "review_required": bool(meta.get("review_required", False)),
                "needs_review": bool(meta.get("review_required", False))
                or confidence in ("pending_review", "model_generated"),
                "domain_match": round(domain_match, 4),
                "matched_dimensions": matched_dimensions,
                "similarity": round(similarity, 4),
                "content": content,
                "score": round(fused_score, 4),
                "fused_score": round(fused_score, 4),
                "keyword_hits": kw_hits,
                "match_type": "exact" if exact else "semantic",
            })
        out.sort(key=lambda x: (-x["fused_score"], -x["similarity"], -x["keyword_hits"]))
        elapsed_ms = round((time.monotonic() - started) * 1000, 2)
        return {
            "results": out[:top_k],
            "degraded": False,
            "elapsed_ms": elapsed_ms,
            "no_hit_reason": None if out else "no_match",
        }

    def record_feedback(self, doc_id: int, feedback: str, reason: str = "") -> Dict:
        """记录检索结果反馈：负反馈降级并标记复核，正反馈可转 verified。"""
        feedback = feedback.lower()
        if feedback not in ("positive", "negative"):
            raise ValueError("feedback must be positive or negative")
        with self.db.session() as s:
            row = s.get(DocumentRecord, doc_id)
            if not row:
                raise ValueError(f"document not found: {doc_id}")
            current = row.confidence if row.confidence in CONFIDENCE_SCORES else "verified"
            if feedback == "negative":
                row.negative_feedback_count = int(row.negative_feedback_count or 0) + 1
                if current == "verified":
                    row.confidence = "pending_review"
                elif current in ("pending_review", "human_authority"):
                    row.confidence = "model_generated"
                row.review_required = True
            elif current == "pending_review":
                row.confidence = "verified"
                row.review_required = False
            s.commit()
            result = {
                "doc_id": row.id,
                "confidence": row.confidence,
                "negative_feedback_count": row.negative_feedback_count,
                "review_required": row.review_required,
                "feedback": feedback,
                "reason": reason,
            }
        sid = str(doc_id)
        for meta in self._metadata:
            if meta.get("doc_id") != sid:
                continue
            meta["confidence"] = result["confidence"]
            meta["negative_feedback_count"] = result["negative_feedback_count"]
            meta["review_required"] = result["review_required"]
        if any(meta.get("doc_id") == sid for meta in self._metadata):
            self._save()
        return result

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
        # FAISS 不支持按位置删除；metadata 存有原文，直接重建
        new_meta = [self._metadata[i] for i in keep_idx]
        contents = [m.get("content", "") for m in new_meta]
        dim = self._index.d
        if any(contents):
            vecs = self._embed(contents)
            dim = vecs.shape[1]
            self._index = self._create_index(dim)
            self._index.add(vecs)
        else:
            self._index = self._create_index(dim)
        self._metadata = new_meta
        self._save()
        with self.db.session() as s:
            row = s.get(DocumentRecord, doc_id)
            if row:
                s.delete(row)
                s.commit()

    def count(self) -> int:
        return self._index.ntotal if self._index else 0
