# Core Artifacts Design

## Goal

Only agent deliverables become artifacts. Conversational status, capability introductions, follow-up questions, orchestration indexes, and raw `result.json` files no longer pollute the artifact panel.

## Behavior

1. Artifact-producing agents write only their configured business documents and scripts, such as `assessment_report.md`, `migration_plan.md`, and extracted `.sql` files.
2. The commander does not write `任务索引.md` or `result.json` merely because it dispatched sub-agents.
3. A sub-agent's or directly consulted agent's full deliverable is not rendered in the chat transcript after it becomes an artifact. The chat event contains a short status and artifact file records.
4. Chat file names are clickable and open the existing artifact preview drawer.
5. The artifact panel remains the consolidated place for preview, download, import, and deletion.

## Non-Goals

- No database migration.
- No rewrite of artifact storage APIs.
- No change to uploaded attachments.

## Verification

Backend graph tests verify that non-delivery replies do not write files, core agent replies write one business document without `result.json`, and commander orchestration does not write an index. API/stream tests verify both orchestrated and direct artifact-producing agents suppress report text and emit artifact records. Frontend tests verify historical process files remain hidden while reports and scripts remain visible.
