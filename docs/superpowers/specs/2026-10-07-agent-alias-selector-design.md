# Agent Alias Selector Design

## Goal

Make the chat composer agent selector visually consistent with the adjacent `@` and upload icon buttons, and make all agent selection/reference surfaces display the configured alias first.

## Design

- The composer agent trigger becomes a 28x28 icon-only `Bot` button. Its tooltip contains the current agent display name.
- The agent dropdown and `@` reference picker use `alias || name` as the display name and reference insertion name.
- Existing display-name behavior remains centralized through `agentDisplayName`, exposed from a React-free helper so it can be unit-tested.

## Verification

Add a Node test for alias-first display fallback. Run frontend unit tests and Vite build; TypeScript full build remains blocked only by pre-existing unrelated errors.
