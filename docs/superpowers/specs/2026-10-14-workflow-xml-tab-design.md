# Workflow XML View Tab Design

## Context

The workbench workflow panel visualizes the parsed graph of each `vm_template_version` row. The API response carries the parsed `workflow` graph plus `parse_error` but discards the raw XML, so users cannot inspect the source. When a version fails to parse, only the error message is visible, which is exactly when the raw content matters most.

## Goal

Add a read-only XML tab beside the graph view so users can inspect the raw XML of the selected version, including versions whose XML fails to parse.

## Design

### Backend

In `jarvis_agent/workflow_template.py`, `build_workflow_template_response` appends a `content` field to each version dict, holding the XML after `normalize_template_content` cleanup (SQL-export artifacts stripped). The `/api/workflow-templates` endpoint serializes the dict as-is, so `app.py` is unchanged.

### Types

`WorkflowTemplateVersion` in `web-ui/src/lib/types.ts` gains `content: string | null`.

### Frontend

`workflow-panel.tsx` gains a `viewMode: 'graph' | 'xml'` state with a two-segment toggle in the version card toolbar (between the version selector group and the zoom controls).

- The XML view renders `selectedVersion.content` in a scrollable monospace `<pre>` capped at the canvas height (`max-h-[min(78vh,800px)]`).
- A lightweight client-side indenter pretty-prints the XML by default with no new dependency; a "formatted / raw" toggle switches views, and formatting failures (unparseable XML) fall back to the raw text.
- A copy button copies the currently shown text.
- Switching versions preserves `viewMode`. The graph view keeps its current behavior, including the parse-error state; the XML tab stays available for any version with content. Empty content shows a "该版本无内容" placeholder.

## Error Handling

- Empty `content`: placeholder instead of an empty block.
- Unparseable XML (the version already carries `parse_error`): raw-text fallback for formatting; the view itself still renders.
- Large XML: the block scrolls within the same height cap as the canvas.

## Testing

- Backend: extend `tests/test_workflow_template.py` to assert each version in the response includes the cleaned `content` (artifacts stripped, XML declaration preserved).
- Frontend: extend `web-ui/tests/workflow-panel.test.ts` with source assertions for the view-mode toggle, `content` rendering, formatted/raw fallback, and copy action, following the existing string-assertion test style.

## Out of Scope

- Editing or saving XML back to the database (read-only by decision).
- Syntax highlighting beyond plain monospace text.
- Line numbers or diffing between versions.
