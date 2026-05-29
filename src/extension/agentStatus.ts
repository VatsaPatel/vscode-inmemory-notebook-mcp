import * as vscode from "vscode";

export function registerAgentStatusItems(context: vscode.ExtensionContext): void {
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    provideCellStatusBarItems(cell) {
      const metadata = parseNotebookMcpMetadata(cell.metadata?.notebookMcp);
      if (!metadata) {
        return [];
      }

      const items: vscode.NotebookCellStatusBarItem[] = [];
      if (metadata.lastAgentAction && metadata.lastAgentAction !== "lock_cell") {
        const action = describeAgentAction(metadata.lastAgentAction);
        const item = new vscode.NotebookCellStatusBarItem(action.text, vscode.NotebookCellStatusBarAlignment.Right);
        item.tooltip = `Notebook MCP ${action.tooltip} ${formatAge(metadata.lastAgentActionAt)}`;
        item.priority = 20;
        item.command = cellStatusCommand(cell, metadata);
        item.accessibilityInformation = {
          label: `Notebook MCP ${action.tooltip}`,
          role: "button"
        };
        items.push(item);
      }

      if (metadata.locked === true) {
        const item = new vscode.NotebookCellStatusBarItem("$(lock) MCP locked", vscode.NotebookCellStatusBarAlignment.Right);
        item.tooltip = metadata.lastAgentAction === "lock_cell"
          ? `Notebook MCP locked this cell ${formatAge(metadata.lastAgentActionAt)}. Agents cannot edit it.`
          : "Notebook MCP agents cannot edit this cell.";
        item.priority = 30;
        item.command = cellStatusCommand(cell, metadata);
        item.accessibilityInformation = {
          label: "Notebook MCP locked cell",
          role: "button"
        };
        items.push(item);
      }

      return items;
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand("notebook-mcp-for-vscode.showCellStatus", (status: CellTrustStatus) => {
    const action = status.lastAgentAction ? describeAgentAction(status.lastAgentAction).tooltip : "no recorded action";
    const parts = [
      `Cell ${status.cellIndex}: ${action}`,
      status.lastAgentActionAt ? formatAge(status.lastAgentActionAt) : "recently",
      status.locked ? "locked for Notebook MCP edits" : "editable by Notebook MCP"
    ];
    vscode.window.showInformationMessage(`Notebook MCP ${parts.join(" · ")}`);
  }));
  context.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider("jupyter-notebook", provider));
}

interface NotebookMcpCellMetadata {
  lastAgentAction?: string;
  lastAgentActionAt?: number;
  locked?: boolean;
}

interface CellTrustStatus extends NotebookMcpCellMetadata {
  cellIndex: number;
  notebookUri: string;
}

interface AgentActionDisplay {
  text: string;
  tooltip: string;
}

function parseNotebookMcpMetadata(value: unknown): NotebookMcpCellMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const metadata = value as Record<string, unknown>;
  const lastAgentAction = typeof metadata.lastAgentAction === "string" ? metadata.lastAgentAction : undefined;
  const lastAgentActionAt = typeof metadata.lastAgentActionAt === "number" ? metadata.lastAgentActionAt : undefined;
  const locked = typeof metadata.locked === "boolean" ? metadata.locked : undefined;
  if (!lastAgentAction && locked !== true) {
    return undefined;
  }
  return { lastAgentAction, lastAgentActionAt, locked };
}

function describeAgentAction(action: string): AgentActionDisplay {
  if (RUN_ACTIONS.has(action)) {
    return { text: "$(run) MCP ran", tooltip: "ran this cell" };
  }
  if (action === "lock_cell") {
    return { text: "$(lock) MCP locked", tooltip: "locked this cell" };
  }
  if (action === "unlock_cell") {
    return { text: "$(unlock) MCP unlocked", tooltip: "unlocked this cell" };
  }
  if (EDIT_ACTIONS.has(action)) {
    return { text: "$(edit) MCP edited", tooltip: EDIT_ACTIONS.get(action) ?? "edited this cell" };
  }
  return { text: "$(hubot) MCP touched", tooltip: formatActionTooltip(action) };
}

function cellStatusCommand(cell: vscode.NotebookCell, metadata: NotebookMcpCellMetadata): vscode.Command {
  return {
    command: "notebook-mcp-for-vscode.showCellStatus",
    title: "Show Notebook MCP Cell Status",
    arguments: [{
      cellIndex: cell.index,
      notebookUri: cell.notebook.uri.toString(),
      ...metadata
    } satisfies CellTrustStatus]
  };
}

function formatAge(timestamp: number | undefined): string {
  if (!timestamp) {
    return "recently";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatActionTooltip(action: string): string {
  return `${action.replace(/_/g, " ")} this cell`;
}

const RUN_ACTIONS = new Set(["run", "run_code"]);
const EDIT_ACTIONS = new Map<string, string>([
  ["insert", "inserted this cell"],
  ["bulk_insert", "inserted this cell"],
  ["edit", "edited this cell"],
  ["move", "moved this cell"],
  ["change_cell_type", "changed this cell type"],
  ["set_cell_metadata", "updated metadata for this cell"],
  ["find_replace", "replaced text in this cell"],
  ["clear_outputs", "cleared outputs for this cell"],
  ["strip_outputs", "stripped outputs from this cell"]
]);
