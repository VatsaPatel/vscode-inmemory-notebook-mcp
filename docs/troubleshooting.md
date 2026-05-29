# Troubleshooting

## Daemon Not Running

Symptoms:

- MCP client cannot connect to `http://127.0.0.1:49777/mcp`.
- Status bar shows disconnected or error.

Actions:

1. Run **Notebook MCP: Start Notebook MCP Server**.
2. Run **Notebook MCP: Show Notebook MCP Daemon Status**.
3. If needed, run **Notebook MCP: Restart Notebook MCP Daemon**.
4. Confirm your MCP client uses the same port as `notebook-mcp-for-vscode.port`.

## Agent Cannot Find A Notebook

Symptoms:

- `notebook_status` returns no open notebooks.
- `notebook_read` returns `notebook_not_found`.

Actions:

1. Open the notebook in VS Code/Cursor.
2. Wait a moment for the bridge heartbeat.
3. Call `notebook_status({include:["open_notebooks"]})`.
4. Use the exact returned `uri` as `notebook_uri`.

If the notebook is not open, call `notebook_open({path})` and use the returned notebook URI.

## Tool Requires notebook_uri

Symptoms:

- A tool returns `missing_target`.
- The error says `notebook_uri` is required.

Actions:

1. Call `notebook_status`.
2. Pick the target notebook URI from `open_notebooks`.
3. Retry the same tool with `notebook_uri`.

Agents should pass `notebook_uri` on every notebook-specific tool call.

## Wrong Notebook Was Edited

The current design should only edit the notebook whose URI was passed in the tool call. If the wrong notebook changed:

1. Check the last tool call arguments.
2. Confirm `notebook_uri` matched the intended file.
3. Call `notebook_read` with that same URI before making further edits.

Do not rely on the active tab.

## Long-Running Operation Looks Stuck

Symptoms:

- `notebook_run` returned an operation id.
- `notebook_operation` keeps reporting `running`.

Actions:

1. Call `notebook_operation({operation_id, include_partial:true})`.
2. Inspect partial outputs for progress or errors.
3. Check the notebook UI to see whether the kernel is still running.
4. Use `notebook_cancel_execution` only if the operation should stop.

## Backend Lost

Symptoms:

- Operation status becomes `backend_lost`.
- The daemon or VS Code window restarted while a cell was running.

Actions:

1. Reopen the target notebook.
2. Call `notebook_status` and verify the URI is listed.
3. Re-run the affected cell if needed.

Running bridge requests cannot survive a daemon process restart.

## Cell Is Locked

Symptoms:

- Edit, delete, move, output-clear, or find/replace rejects a cell as locked.

Actions:

1. Treat the lock as a human audit/control signal.
2. Unlock only when intended:

```json
{
  "notebook_uri": "file:///path/to/notebook.ipynb",
  "index": 0,
  "locked": false,
  "response_format": "json"
}
```

## Output Is Truncated

Large text and rich outputs are truncated to keep MCP responses usable. For full artifacts, save outputs to a file from the notebook or rerun with a focused diagnostic cell.
