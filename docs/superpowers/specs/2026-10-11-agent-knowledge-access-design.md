# Agent Knowledge Access Design

## Goal

Limit each agent to explicitly authorized knowledge bases. The knowledge QA agent (`nl2sql_qa`, 小问) can access all enabled knowledge bases.

## Data Model

Create `agent_kbs` as the authoritative authorization table:

- `id`: primary key
- `agent_id`: executing agent identifier
- `kb_id`: knowledge-base id
- `permission`: `read` or `write`; retrieval requires `read`
- `enabled`: authorization switch
- `created_at`: creation time

Use a unique constraint on `(agent_id, kb_id)`. Keep `agents.bound_kbs` only as a legacy source for one-time migration into `agent_kbs`.

## Authorization Flow

1. Resolve the executing agent from `state.agent_id`.
2. Query `agent_kbs` for enabled `read` authorizations.
3. Pass the resolved `kb_ids` to RAG.
4. Do not fall back to the conversation space when authorization resolution succeeds but returns no knowledge bases.
5. Treat `nl2sql_qa` as a privileged QA role that resolves to all knowledge bases.
6. Ignore unknown knowledge-base names and reject authorization updates containing unknown knowledge bases.

## API And UI

Agent create/update APIs continue accepting `bound_kbs` as knowledge-base names, but persist those names in `agent_kbs`. The response continues returning `bound_kbs` names so the current UI contract remains stable. The agent editor displays and updates knowledge-base checkboxes through this same field.

## Testing

Backend tests cover migration, normal-agent isolation, privileged QA access, no implicit space fallback, and API persistence.
