# Jarvis Workbench Design

## Goal

Replace the default Jarvis workbench panel with a full-screen, cinematic command deck based on the approved HUD reference. The workbench should feel like Jarvis: a central AI core, direct natural-language command input, agent fleet status, system diagnostics, and quick access to operational modules.

The design must not show database migration copy, pipeline jargon, or migration-specific demo data.

## Layout

The workbench uses a three-column HUD layout over the approved background:

- Center: animated Jarvis core, global online status, and primary command input. The command input starts or routes a conversation. Suggested commands include agent dispatch, task creation, knowledge retrieval, and system inspection.
- Left: power/core summary, system diagnostics, and quick access modules.
- Right: current time, resource telemetry, agent fleet, and an AI-generated or rule-derived note.
- Background: the approved Iron Man-style HUD image with darkening, scan lines, cyan primary highlights, and red accents.

The layout is responsive. On narrow screens, columns stack and the page scrolls.

## Data And Interaction

The first implementation integrates real app data where it already exists:

- Agent fleet reads `/api/agents`; disabled agents use a dimmed state.
- Recent tasks and artifacts use existing task and artifact APIs.
- Model identity reads the current settings API.
- System health reads the existing health endpoint.
- Quick access links route to the existing workbench modules.
- The command input creates a new conversation and sends the entered text when that flow is available; otherwise it opens a new conversation.

No business names are hardcoded in production components. Sample copy may exist only as empty-state guidance, not as fake operational status.

## Scope

Included:

- Replace `WorkspacePanel` with the Jarvis command deck.
- Add the approved background asset to the frontend.
- Reuse existing sidebar routing and workbench tabs.
- Keep the design compatible with existing React and Tailwind code where practical.

Not included:

- No migration-specific text, pipeline status, or database migration metrics.
- No change to backend orchestration, agent authorization, or existing management panels.
- No fake CPU, memory, or latency telemetry unless a real source is added. If no source exists, show an idle or unavailable state.

## Visual Language

- Background: deep black with the approved HUD artwork.
- Primary color: cyan.
- Warning/accent color: red.
- Panels: translucent dark surfaces, corner brackets, scan lines, and subtle glow.
- Typography: compact sans-serif for Chinese text; monospaced uppercase labels for system terms.
- Motion: slow rotating rings, pulsing core, and non-blocking scanline animation.

Accessibility and readability take priority over decoration. All text must keep sufficient contrast over the background.
