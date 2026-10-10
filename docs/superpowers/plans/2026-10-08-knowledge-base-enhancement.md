# 知识库能力增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build design-document-compliant knowledge classification, hybrid retrieval, confidence gating, provenance, and feedback while preserving existing FAISS data.

**Architecture:** Extend `DocumentRecord` and RAG metadata with governance fields, implement scoring inside `RAGStore`, expose a unified knowledge API, and enhance the existing knowledge management page. Existing APIs and indexes remain compatible.

**Tech Stack:** SQLAlchemy + SQLite migrations, FAISS `IndexFlatIP`, FastAPI, React + TypeScript.

---

### Task 1: Knowledge Metadata and Scoring

**Files:**
- Modify: `db_loc_agent/db.py`
- Modify: `db_loc_agent/rag.py`
- Test: `tests/test_rag.py`

- [ ] Add failing tests for domain filtering, confidence scoring, low-similarity filtering, and feedback degradation.
- [ ] Add document columns and lightweight migrations.
- [ ] Add confidence constants, metadata defaults, fusion scoring, candidate expansion, and feedback methods.
- [ ] Run `pytest tests/test_rag.py -q`.

### Task 2: Unified Knowledge API

**Files:**
- Modify: `db_loc_agent/app.py`
- Test: `tests/test_api.py`

- [ ] Add failing API tests for `/api/knowledge/search` and `/api/knowledge/feedback`.
- [ ] Normalize request filters and return provenance plus degradation metadata.
- [ ] Keep `/api/kb/search` behavior compatible.
- [ ] Run focused API tests.

### Task 3: Knowledge Management UI

**Files:**
- Modify: `web-ui/src/lib/types.ts`
- Modify: `web-ui/src/lib/api.ts`
- Modify: `web-ui/src/components/workbench/kb-panel.tsx`
- Test: `web-ui/tests/knowledge-enhancement.test.ts`

- [ ] Add source-level tests for upload classification fields and search result rendering.
- [ ] Extend types and API clients.
- [ ] Add business-domain/type filters and upload metadata controls.
- [ ] Show similarity, fused score, confidence, review status, and provenance.
- [ ] Add negative feedback action.
- [ ] Run `npm test`, `npx tsc --noEmit`, and `npx vite build`.

### Task 4: Integration Verification

**Files:**
- No production files.

- [ ] Run backend RAG and API tests.
- [ ] Run frontend tests and type/build checks.
- [ ] Load the knowledge page in a real browser and verify filters, search, and feedback controls render.
