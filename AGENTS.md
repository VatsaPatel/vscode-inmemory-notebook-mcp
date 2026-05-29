# AGENTS.md

This file provides guidance to Codex when working in this repository.

## Build And Test Commands

```bash
npm run build         # Build extension and daemon bundles
npm test              # Run unit tests with vitest
npm run test:e2e      # Run VS Code E2E tests
npm run watch         # Build the extension bundle in watch mode
```

## Architecture

The extension exposes live VS Code/Cursor notebooks through a detached localhost daemon. The daemon owns the public MCP endpoint and VS Code windows connect back as bridge workers.

```text
MCP client
  -> Streamable HTTP MCP on 127.0.0.1:49777
  -> detached notebook MCP daemon
  -> WebSocket bridge to VS Code/Cursor extension hosts
  -> VS Code Notebook API
```

Current source layout:

- `src/extension.ts` re-exports activation from `src/extension/activate.ts`.
- `src/extension/` owns activation, daemon supervision, bridge client wiring, notebook event reporting, commands, status bar state, and Notebook API request handlers.
- `src/daemon/` owns the HTTP server, MCP transport, bridge server, notebook registry, sessions, execution operations, lifecycle, auth, and persistence.
- `src/mcp/` owns MCP tool schemas, response formatting, and tool registration against the daemon.
- `src/common/` owns shared protocol constants, types, ids, errors, logging, and app data paths.
- `src/utils/` owns reusable notebook and output helpers.
- `docs/architecture.md`, `docs/migration.md`, and `docs/troubleshooting.md` describe the daemon/session model.

## Core Design Rules

- Agent sessions bind to notebook URIs, not tabs, focus, or windows.
- Write and execution tools require a session URL or explicit `notebook_uri`; do not reintroduce active-tab write fallback.
- Read-only single-notebook fallback is allowed only when target resolution is unambiguous.
- Session access must be enforced consistently for targeted tools: `read_only` allows reads only, `read_run` allows reads and run/kernel tools, `full` allows writes, and `paused` blocks write/run tools.
- Cell execution must remain visible in the notebook UI and return outputs to the agent.
- Long-running execution should use daemon operation ids: `notebook_start_cell`, then `notebook_get_execution` or `notebook_wait_execution`.
- Locked cells (`metadata.notebookMcp.locked`) must reject agent mutation tools and show the MCP lock status marker.
- Scratch execution tools may create temporary cells, but docs and tool descriptions must make kernel side effects clear.

## Critical Implementation Details

### Cell Execution Wait Condition

`waitForCellExecution` in `src/utils/notebook.ts` must wait until `cell.executionSummary?.success` is a boolean. VS Code creates `executionSummary` when execution starts, but `success` is only set when the kernel finishes.

```typescript
if (typeof cell.executionSummary?.success === "boolean") {
  // execution finished
}
```

### Targeting And Sessions

The daemon registry tracks connected windows and the notebooks they report. Session ids use the `sess_` prefix and pin a notebook URI. If a bridge disconnects, sessions can become `backend_unavailable` until another connected bridge reports the same notebook URI.

When adding tools, use the shared router/session flow instead of reaching directly for the active notebook. Keep agent-facing APIs index-based unless an existing tool contract uses an id.

### Outputs And Status Markers

Output parsing should preserve structured text, error, image, JSON, and HTML records. Large text-like outputs are intentionally truncated before returning to MCP clients, and image data is base64 encoded.

Agent-visible cell status items are driven by `metadata.notebookMcp.lastAgentAction`, `lastAgentActionAt`, and `locked`. If you add a write/run path, mark affected cells so users can see recent MCP activity.

## Release Process

1. Update `version` in `package.json` and `package-lock.json`.
2. Add a concise entry to `CHANGELOG.md`.
3. Commit and tag:

   ```bash
   git add -A && git commit -m "Release vX.Y.Z: Description"
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin master --tags
   ```

4. CI builds the VSIX, creates the GitHub Release, and publishes to marketplaces.
5. Verify with `gh run list --limit 3` and `gh release view vX.Y.Z`.

Do not publish from local; CI handles release publishing on tag push.
