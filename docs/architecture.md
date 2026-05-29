# Architecture

Notebook MCP for VS Code uses one public daemon endpoint:

```text
http://127.0.0.1:49777/mcp?token=...
```

All notebook-specific tools require `notebook_uri`. Agents discover notebook URIs with `notebook_status` or by opening a file with `notebook_open`.

## Components

- `src/daemon/` owns the localhost HTTP MCP endpoint, bridge WebSocket routing, notebook registry, execution operations, lifecycle, auth, locks, and persistence.
- `src/extension/` owns VS Code activation, daemon supervision, bridge client, commands, status bar, cell status items, and notebook backend handlers.
- `src/mcp/` owns the compact MCP tool schemas, responses, and tool registration.
- `src/common/` owns shared protocol constants, errors, ids, logging, paths, and shared types.

## Data Flow

```text
MCP client
  -> daemon /mcp
  -> router resolves explicit notebook_uri
  -> bridge WebSocket request
  -> VS Code Notebook API
  -> bridge response
  -> MCP response
```

The daemon registry tracks connected windows and the notebooks reported by each window. If the same notebook URI is open in multiple windows, routing is deterministic and chooses the first registered candidate.

## Targeting

Targeting is explicit:

1. Agent calls `notebook_status`.
2. Agent picks `notebook_uri` from `open_notebooks`, or calls `notebook_open`.
3. Agent passes `notebook_uri` on every notebook read/write/run tool.

The active editor is diagnostic only. It is not the default write target.

## Execution Operations

Long-running execution is represented by daemon-owned operation records with ids generated using the `exec_` prefix.

`notebook_run` with `scope: "cell"` creates an operation and starts execution through the bridge. If the cell does not finish within `wait_ms`, the operation remains `running`.

Agents use:

- `notebook_operation` to list, get, wait, or poll live outputs.
- `notebook_cancel_execution` to request cancellation.

If a bridge disconnects while an operation is queued or running, the daemon marks the operation `backend_lost`. Completed operations and their outputs are persisted and retained by the daemon.

## Outputs And Cell Markers

Notebook outputs are parsed into text, error, image, JSON, and HTML records. Large text-like outputs are truncated, images are base64 encoded, and text outputs include `stdout`/`stderr` hints when VS Code exposes stream metadata.

Write and execution tools mark affected cells with `metadata.notebookMcp.lastAgentAction` and a timestamp. `notebook_lock_cell` sets `metadata.notebookMcp.locked`; locked cells show an MCP lock item and mutation tools reject edits until unlocked.

## Local State

The daemon writes local state under the app data directory:

- `daemon.pid`
- `daemon.lock`
- `shutdown.token`
- `daemon.log`
- `executions.snapshot.json`

`NOTEBOOK_MCP_FOR_VSCODE_HOME` can override the app data directory. `NOTEBOOK_MCP_FOR_VSCODE_PORT` can override the daemon port. The daemon still accepts the older pre-rename environment variables as silent local fallbacks.
