# Migration Guide

## Global MCP Endpoint

The current product uses one MCP endpoint for all windows and notebooks:

```text
http://127.0.0.1:49777/mcp?token=...
```

Agents should not use per-notebook session URLs. Instead:

1. Connect the MCP client once to the global URL.
2. Call `notebook_status`.
3. Choose a `notebook_uri` from `open_notebooks`, or call `notebook_open`.
4. Pass that `notebook_uri` on every notebook-specific tool call.

## Removed Session Workflow

The following MCP tools are not part of the current surface:

- `notebook_create_session`
- `notebook_get_session`
- `notebook_delete_session`
- `notebook_set_session_access`
- `notebook_set_session_paused`

The following routes are not part of the normal product flow:

- `/sessions`
- `/mcp/session/<session-id>`

## Replacing Old Tool Names

| Old tool | Current replacement |
|---|---|
| `notebook_list_cells` | `notebook_read({notebook_uri, include_outputs: "summary"})` |
| `notebook_get_cell_content` | `notebook_read({notebook_uri, cell_ids: [...], include_outputs: "none"})` |
| `notebook_get_cell_output` | `notebook_read({notebook_uri, cell_ids: [...], include_outputs: "full"})` |
| `notebook_get_outline` | No exact replacement. Use `notebook_read` for full source context. |
| `notebook_get_cell_metadata` / `notebook_get_notebook_metadata` | `notebook_read({notebook_uri, include_metadata: true})` |
| `notebook_insert_cell` / `notebook_bulk_add_cells` | `notebook_edit_cells({notebook_uri, operations: [{op: "insert", cells: [...]}]})` |
| `notebook_edit_cell` / `notebook_change_cell_type` | `notebook_edit_cells({notebook_uri, operations: [{op: "update", cell_id, content, type}]})` |
| `notebook_delete_cell` | `notebook_edit_cells({notebook_uri, operations: [{op: "delete", cell_id}]})` |
| `notebook_move_cell` | `notebook_move_cells({notebook_uri, cell_ids: [...], to_index})` |
| `notebook_find_replace` | `notebook_search({notebook_uri, action: "replace", apply: true, query, replacement})` |
| `notebook_clear_all_outputs` / `notebook_strip_outputs` | `notebook_clear_outputs({notebook_uri, scope: "notebook", clear_execution_counts: true})` |
| `notebook_run_cell` / `notebook_start_cell` | `notebook_run({notebook_uri, scope: "cell", cell_id, wait_ms})` |
| `notebook_run_cells_in_range` | `notebook_run({notebook_uri, scope: "range", start_cell_id, end_cell_id})` |
| `notebook_run_all_cells` | `notebook_run({notebook_uri, scope: "all"})` |
| `notebook_run_code` | `notebook_run({notebook_uri, scope: "code", code})` |
| `notebook_get_execution` / `notebook_wait_execution` / `notebook_stream_execution` / `notebook_list_executions` | `notebook_operation({operation_id, wait_ms, include_partial})` |
| `notebook_restart_kernel` / `notebook_interrupt_kernel` | `notebook_kernel_control({notebook_uri, action: "restart" | "interrupt"})` |

## Recommended Agent Prompt

```text
Use the Notebook MCP server. First call notebook_status, resolve the notebook_uri for /path/to/notebook.ipynb, and pass that notebook_uri on every notebook tool call.
```

## Common Errors

`missing_target` usually means a notebook tool was called without `notebook_uri`.

`notebook_not_found` means the URI is not currently registered by any connected VS Code/Cursor bridge. Open the notebook or call `notebook_open`.
