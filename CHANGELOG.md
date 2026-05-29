# Changelog

All notable changes to this project will be documented in this file.

## [0.5.3] - 2026-05-29

### Changed

- Expanded the Marketplace README with tool coverage, architecture, and long-running execution details.
- Restored Marketplace icon and README imagery.

## [0.5.2] - 2026-05-29

### Changed

- Added Marketplace and README imagery for Notebook MCP for VS Code.

## [0.5.0] - 2026-05-12

### Changed

- Switched to one global MCP endpoint for all windows and notebooks.
- Notebook-specific tools now require explicit `notebook_uri`; agents should get it from `notebook_status` or `notebook_open`.
- Removed the public per-notebook session workflow and session MCP tools.
- Renamed the extension to **Notebook MCP for VS Code** with the `notebook-mcp-for-vscode` command/configuration namespace.
- Tightened input validation for `notebook_run` and `notebook_clear_outputs` so missing cell targets fail before bridge dispatch.
- Simplified daemon persistence to execution operations only.

### Migration from older tool surfaces

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
