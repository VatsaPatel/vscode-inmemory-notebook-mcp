import { formatMcpUrl } from "../../common/protocol.js";
import { HelpInputSchema, StatusInputSchema } from "../schemas.js";
import { errorResponse, formatResponse } from "../responses.js";
import { NotebookMcpServer } from "../server.js";
import type { DaemonToolDependencies } from "../../daemon/mcpServer.js";

export function registerUtilityTools(server: NotebookMcpServer, deps: DaemonToolDependencies): void {
  server.tool("notebook_help", "Use when unsure how to proceed. Returns short recipes for explore, edit, run, long_running, recover, and save workflows.", HelpInputSchema.shape, async (params) => {
    try {
      const parsed = HelpInputSchema.parse(params);
      return formatResponse(helpPayload(parsed.task), parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });

  server.tool("notebook_status", "Use first after connecting to the global MCP URL. Returns daemon health and open notebooks; choose a notebook_uri and pass it to every notebook tool.", StatusInputSchema.shape, async (params) => {
    try {
      const parsed = StatusInputSchema.parse(params);
      const include = new Set(parsed.include);
      const payload: Record<string, unknown> = {
        mcpUrl: formatMcpUrl(deps.port, deps.token)
      };
      if (include.has("health")) {
        payload.health = deps.status();
      }
      if (include.has("open_notebooks")) {
        payload.open_notebooks = deps.registry.listOpenNotebooks();
      }
      if (include.has("executions")) {
        payload.executions = deps.executions.list();
      }
      payload.targeting = "No implicit target on the global endpoint. Pass notebook_uri explicitly on notebook tools.";
      return formatResponse(payload, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });
}

function helpPayload(task: string | undefined): unknown {
  const recipes = [
    {
      name: "explore_unknown_notebook",
      task: "explore",
      when: "First contact with a notebook.",
      steps: [
        "notebook_status({include:['open_notebooks','health']})",
        "Pick a notebook_uri from open_notebooks, or call notebook_open({path})",
        "notebook_read({notebook_uri, include_outputs:'summary'})",
        "notebook_search({notebook_uri, query:'term'}) when looking for a specific section"
      ]
    },
    {
      name: "add_or_reorder_cells",
      task: "edit",
      when: "Adding analysis or reorganizing notebook flow.",
      steps: [
        "notebook_read({notebook_uri}) to get cell_id anchors",
        "notebook_edit_cells({notebook_uri, operations:[{op:'insert', after_cell_id, cells:[...]}]})",
        "notebook_move_cells({notebook_uri, cell_ids:[...], before_cell_id}) if order needs correction"
      ]
    },
    {
      name: "run_long_python_or_spark_cell",
      task: "long_running",
      when: "Running Spark or any long job where progress matters.",
      steps: [
        "Insert a visible diagnostic/work cell with notebook_edit_cells({notebook_uri, ...})",
        "notebook_run({notebook_uri, scope:'cell', cell_id, wait_ms:1000})",
        "notebook_operation({operation_id, include_partial:true}) until terminal",
        "notebook_cancel_execution({operation_id}) only when cancellation is intended"
      ]
    },
    {
      name: "debug_failed_cell",
      task: "run",
      when: "A cell failed or produced unexpected output.",
      steps: [
        "notebook_get_kernel_info({notebook_uri, include:['spec','context']})",
        "notebook_read({notebook_uri, cell_ids:[...], include_outputs:'full'})",
        "Edit a visible cell, then rerun with notebook_run({notebook_uri, ...})"
      ]
    },
    {
      name: "save_or_share",
      task: "save",
      when: "Work should persist or be shared.",
      steps: [
        "notebook_save({notebook_uri})",
        "notebook_export({notebook_uri, format:'markdown'|'python'|'html'})"
      ]
    }
  ].filter((recipe) => !task || recipe.task === task);

  return {
    default_targeting: "Connect once to the global /mcp URL. Pick a notebook_uri with notebook_status or notebook_open, then pass notebook_uri on every notebook-specific tool call.",
    recipes
  };
}
