import * as vscode from "vscode";

import { DEFAULT_DAEMON_PORT, formatMcpUrl } from "../common/protocol.js";
import { DaemonSupervisor } from "./daemonSupervisor.js";

export interface CommandHooks {
  connectBridge?: () => void;
  stopBridge?: () => void;
}

export function registerCommands(context: vscode.ExtensionContext, supervisor: DaemonSupervisor, port = DEFAULT_DAEMON_PORT, hooks: CommandHooks = {}): void {
  context.subscriptions.push(
    registerNotebookCommand("notebook-mcp-for-vscode.startServer", async () => {
      await supervisor.ensureRunning(port);
      hooks.connectBridge?.();
      vscode.window.showInformationMessage(`Notebook MCP daemon running: ${formatMcpUrl(port)}`);
    }),
    registerNotebookCommand("notebook-mcp-for-vscode.showDaemonStatus", async () => {
      const status = await supervisor.status(port);
      vscode.window.showInformationMessage(status ? `Notebook MCP daemon healthy: ${formatMcpUrl(port)}` : "Notebook MCP daemon is not running.");
    }),
    registerNotebookCommand("notebook-mcp-for-vscode.showActivity", async () => {
      await showActivity(supervisor, port, hooks);
    }),
    registerNotebookCommand("notebook-mcp-for-vscode.restartDaemon", async () => {
      if (await supervisor.status(port)) {
        await supervisor.shutdown(port);
        await supervisor.waitUntilStopped(port);
      }
      await supervisor.ensureRunning(port);
      hooks.connectBridge?.();
      vscode.window.showInformationMessage("Notebook MCP daemon restarted.");
    }),
    registerNotebookCommand("notebook-mcp-for-vscode.stopDaemon", async () => {
      if (!(await supervisor.status(port))) {
        hooks.stopBridge?.();
        vscode.window.showInformationMessage("Notebook MCP daemon is not running.");
        return;
      }

      hooks.stopBridge?.();
      await supervisor.shutdown(port);
      await supervisor.waitUntilStopped(port);
      vscode.window.showInformationMessage("Notebook MCP daemon stopped.");
    }),
    registerNotebookCommand("notebook-mcp-for-vscode.copyMcpUrl", async () => {
      await supervisor.ensureRunning(port);
      const token = await supervisor.readDaemonToken();
      await vscode.env.clipboard.writeText(formatMcpUrl(port, token));
      vscode.window.showInformationMessage("Notebook MCP daemon URL copied.");
    }),
    registerNotebookCommand("notebook-mcp-for-vscode.copyNotebookUri", async () => {
      const notebookUri = activeNotebookUri();
      if (!notebookUri) {
        return;
      }
      await vscode.env.clipboard.writeText(notebookUri);
      vscode.window.showInformationMessage("Notebook URI copied. Pass this as notebook_uri in MCP tool calls.");
    })
  );
}

type ActivityItem = DaemonActivityItem | StartDaemonActivityItem | CopyUrlActivityItem;

interface DaemonActivityItem extends vscode.QuickPickItem {
  itemType: "daemon";
}

interface StartDaemonActivityItem extends vscode.QuickPickItem {
  itemType: "startDaemon";
}

interface CopyUrlActivityItem extends vscode.QuickPickItem {
  itemType: "copyUrl";
  url: string;
}

function registerNotebookCommand(command: string, task: () => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(command, async () => {
    try {
      await task();
    } catch (error) {
      await vscode.window.showErrorMessage(`Notebook MCP: ${errorMessage(error)}`);
    }
  });
}

async function showActivity(supervisor: DaemonSupervisor, port: number, hooks: CommandHooks): Promise<void> {
  const status = await supervisor.status(port);
  if (!status) {
    const selected = await vscode.window.showQuickPick<ActivityItem>([{
      itemType: "startDaemon",
      label: "$(debug-start) Start Notebook MCP daemon",
      description: "not running",
      detail: formatMcpUrl(port)
    }], {
      title: "Notebook MCP Activity",
      placeHolder: "Notebook MCP daemon is not running"
    });
    if (selected?.itemType === "startDaemon") {
      await supervisor.ensureRunning(port);
      hooks.connectBridge?.();
      vscode.window.showInformationMessage("Notebook MCP daemon started.");
    }
    return;
  }

  const token = await supervisor.readDaemonToken();
  const url = formatMcpUrl(port, token);
  const selected = await vscode.window.showQuickPick<ActivityItem>([{
    itemType: "daemon",
    label: "$(server) Daemon healthy",
    description: `${status.windowCount} window${plural(status.windowCount)} connected`,
    detail: `${url} · uptime ${formatDuration(status.uptimeMs)}`
  }, {
    itemType: "copyUrl",
    label: "$(copy) Copy global MCP URL",
    description: "recommended",
    detail: url,
    url
  }], {
    title: "Notebook MCP Activity",
    placeHolder: "Copy the global MCP URL"
  });

  if (selected?.itemType === "copyUrl") {
    await vscode.env.clipboard.writeText(selected.url);
    vscode.window.showInformationMessage("Notebook MCP daemon URL copied.");
  }
}

function activeNotebookUri(): string | undefined {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!notebook) {
    vscode.window.showErrorMessage("Open a notebook first.");
    return undefined;
  }
  return notebook.uri.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
