# Workflow Template Visualizer Design

## Goal

Add a Jarvis workbench page where a user enters a `template_tag`, queries `aif_comframe.vm_template_version`, concatenates the stored XML chunks, parses the workflow, and renders it as an interactive workflow diagram.

## Scope

- Backend endpoint for querying and parsing workflow template versions.
- Frontend workbench tab and API client method.
- SVG diagram using the original coordinates from each task's `uiinfo`.
- Node details panel for service calls and input/output mappings.
- Version selection when one `template_tag` has multiple rows.
- No workflow editing or persistence in this iteration.

## Data Flow

1. The user enters a `template_tag` on the workflow workbench page.
2. The frontend calls `GET /api/workflow-templates?template_tag=<value>`.
3. The backend executes a parameterized query against `aif_comframe.vm_template_version` using the application database engine.
4. For each returned row, the backend concatenates `content`, `content1` through `content15` in order, skipping null and empty chunks.
5. The backend removes known SQL export artifacts such as embedded `','` separators, strips excess wrapper text if present, and parses the XML.
6. The backend returns workflow metadata, variables, nodes, edges, service details, mapping details, parse diagnostics, and version metadata.
7. The frontend renders the selected version as an SVG workflow graph and lets the user inspect nodes and edges.

## Backend Design

Create a focused parser module rather than embedding XML traversal in the route. The module exposes:

- `normalize_template_content(*chunks)`: concatenate chunks and repair known export artifacts before XML parsing.
- `parse_workflow_xml(xml_text)`: convert a workflow XML document into the API response model.
- `select_workflow_template_versions(engine, template_tag)`: query template version rows with bind parameters.

The endpoint returns all versions matching the tag. The frontend receives `template_tag`, `versions`, and `selected_version_id`. Rows with parse failures include structured `parse_error` metadata instead of breaking the whole response.

Default selection order:

1. Highest `valid_date` among rows where `expire_date` is null or later than now.
2. Highest `valid_date`.
3. Highest `template_version_id`.

XML parsing uses Python's standard `xml.etree.ElementTree`. The parser preserves workflow attributes and description; reads every `vars` item; reads task id, label, type, rectangle, goto targets, service metadata, and relationship links; reads `join` metadata; and includes each logical edge once unless the same source-target pair already comes from a `gotoitem`. It reports invalid XML and invalid coordinates with concise messages and marks unresolved edge endpoints as warnings.

Database access uses SQLAlchemy `text()` with a bound `template_tag`; user input is never concatenated into SQL.

## Frontend Design

Add a `workflows` workbench tab routed as `#/workspace/workflows`.

The page has:

- Template tag input and query button.
- Version selector and basic template metadata.
- Search box that highlights matching nodes.
- SVG canvas with zoom in, zoom out, fit, and reset controls.
- Node details panel showing type, service center/code/name, inputs, outputs, defaults, and outgoing edges.
- Error and empty states for query failure, no rows, and invalid XML.

The diagram uses original `uiinfo` x/y coordinates and dimensions. It visually distinguishes start, finish, fork, and, service, and automatic nodes; uses directed SVG paths with arrowheads; keeps labels inside stable node dimensions; and supports click selection plus search highlighting. Nodes without coordinates use fallback dimensions and are positioned below the original canvas.

## Error Handling

- Empty `template_tag`: return an API validation error without querying.
- Database failure: return a clear API error and retain the user's input.
- No rows: return an empty version list; the page shows a no-result state.
- Invalid XML in one version: return that version with `parse_error`; other versions remain usable.
- Missing node coordinates: render with fallback geometry and show a warning.
- Unresolvable edges: omit from the graph but expose them in node details and diagnostics.

## Testing

Backend tests cover ordered chunk concatenation, SQL export artifact repair, metadata and node parsing, goto and join edges, service and link mappings, invalid XML errors, bind-parameter querying, and default version selection.

Frontend tests cover API request construction, version switching, diagram geometry, node details, search highlighting, parse errors, and empty states.

## Non-Goals

- No workflow editing, publishing, or database writes.
- No new graph-layout dependency; original coordinates are authoritative.
- No generic arbitrary SQL query UI in this feature.
