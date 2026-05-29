import type { DaemonToolDependencies } from "../../daemon/mcpServer.js";
import { errorResponse, formatResponse } from "../responses.js";
import { NotebookMcpServer } from "../server.js";
import {
  ClearOutputsInputSchema,
  validateClearOutputsInput,
  CreateNotebookInputSchema,
  EditCellsInputSchema,
  ExportNotebookInputSchema,
  KernelControlInputSchema,
  KernelInfoInputSchema,
  LockCellByRefInputSchema,
  MoveCellsInputSchema,
  OpenNotebookInputSchema,
  ReadNotebookInputSchema,
  SaveNotebookInputSchema,
  SearchNotebookInputSchema
} from "../schemas.js";

function resolveTarget(
  deps: DaemonToolDependencies,
  parsed: { notebook_uri: string },
  access: "read" | "write" | "execute"
) {
  return deps.router.resolveTarget({
    notebookUri: parsed.notebook_uri,
    context: deps.context,
    allowSingleNotebookFallback: false,
    allowActiveNotebookFallback: false,
    access
  });
}

function registerRoutedTool<TParams extends { notebook_uri: string; response_format: any }>(
  server: NotebookMcpServer,
  deps: DaemonToolDependencies,
  name: string,
  description: string,
  schema: { shape: any; parse: (params: unknown) => TParams },
  bridgeMethod: string,
  access: "read" | "write" | "execute",
  validate?: (parsed: TParams) => void
): void {
  server.tool(name, description, schema.shape, async (params: unknown) => {
    try {
      const parsed = schema.parse(params);
      validate?.(parsed);
      const target = resolveTarget(deps, parsed, access);
      const result = await deps.router.route(target, bridgeMethod, parsed as Record<string, unknown>);
      return formatResponse(result, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });
}

function registerBridgeTool<TParams extends { response_format: any }>(
  server: NotebookMcpServer,
  deps: DaemonToolDependencies,
  name: string,
  description: string,
  schema: { shape: any; parse: (params: unknown) => TParams },
  bridgeMethod: string
): void {
  server.tool(name, description, schema.shape, async (params: unknown) => {
    try {
      const parsed = schema.parse(params);
      const windows = deps.registry.listConnectedWindows();
      if (windows.length === 0) {
        throw new Error("No VS Code bridge worker is connected.");
      }
      const result = await deps.router.route({
        notebookUri: "__daemon_control__",
        windowId: windows[0].registration.windowId
      }, bridgeMethod, parsed as Record<string, unknown>);
      return formatResponse(result, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export function registerNotebookTools(server: NotebookMcpServer, deps: DaemonToolDependencies): void {
  registerRoutedTool(
    server,
    deps,
    "notebook_read",
    "Use first after notebook_status/open. Requires notebook_uri; reads all or selected cells with source, outputs, lock state, and cell_id anchors.",
    ReadNotebookInputSchema,
    "notebook/read",
    "read"
  );
  server.tool("notebook_search", "Use to find/replace text in one notebook. Requires notebook_uri; replacements are dry-run unless action:'replace' and apply:true.", SearchNotebookInputSchema.shape, async (params: unknown) => {
    try {
      const parsed = SearchNotebookInputSchema.parse(params);
      const target = resolveTarget(deps, parsed, parsed.action === "replace" && parsed.apply ? "write" : "read");
      const result = await deps.router.route(target, "notebook/search", parsed as Record<string, unknown>);
      return formatResponse(result, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });
  registerRoutedTool(
    server,
    deps,
    "notebook_edit_cells",
    "Use to insert, update, delete, or change cell type in one notebook. Requires notebook_uri; prefer cell_id anchors from notebook_read.",
    EditCellsInputSchema,
    "notebook/editCells",
    "write"
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_move_cells",
    "Use to reorder one or more cells as a block. Requires notebook_uri; prefer cell_id anchors and call notebook_read afterward.",
    MoveCellsInputSchema,
    "notebook/moveCells",
    "write"
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_clear_outputs",
    "Use to clear outputs for one cell or the notebook. Requires notebook_uri; set clear_execution_counts:true for clean commits.",
    ClearOutputsInputSchema,
    "notebook/clearOutputs",
    "write",
    validateClearOutputsInput
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_lock_cell",
    "Use to protect/unprotect a cell from agent edits. Requires notebook_uri; this is not a general metadata tool.",
    LockCellByRefInputSchema,
    "notebook/lockCell",
    "write"
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_save",
    "Use after meaningful edits or runs to persist the notebook. Requires notebook_uri; provide path only for save-as/copy.",
    SaveNotebookInputSchema,
    "notebook/save",
    "write"
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_export",
    "Use when the user asks for a shareable/exported copy. Requires notebook_uri; path writes an export file, not the source notebook.",
    ExportNotebookInputSchema,
    "notebook/export",
    "read"
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_get_kernel_info",
    "Use for Python kernel status and best-effort recent context. Requires notebook_uri; use visible diagnostic cells for variable details.",
    KernelInfoInputSchema,
    "notebook/kernelInfo",
    "read"
  );
  registerRoutedTool(
    server,
    deps,
    "notebook_kernel_control",
    "Use only to interrupt/restart the target notebook kernel. Requires notebook_uri; destructive and may stop work or clear state.",
    KernelControlInputSchema,
    "notebook/kernelControl",
    "execute"
  );

  registerBridgeTool(server, deps, "notebook_open", "Use when the target notebook is not already open. Opens an existing notebook file in VS Code/Cursor.", OpenNotebookInputSchema, "notebook/open");
  registerBridgeTool(server, deps, "notebook_create", "Use when the task needs a fresh notebook. Creates a Python notebook, optionally at a file path.", CreateNotebookInputSchema, "notebook/create");
}
