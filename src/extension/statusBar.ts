import * as vscode from "vscode";

import { formatMcpUrl } from "../common/protocol.js";

export class NotebookMcpStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly port: number) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "notebook-mcp-for-vscode.showDaemonStatus";
  }

  setState(state: "starting" | "connected" | "disconnected" | "error"): void {
    if (state === "connected") {
      this.item.text = `$(server) Notebook MCP`;
      this.item.tooltip = `Notebook MCP daemon connected\n${formatMcpUrl(this.port)}\nClick to copy the global MCP URL.`;
      this.item.backgroundColor = undefined;
      this.item.command = "notebook-mcp-for-vscode.showActivity";
    } else if (state === "starting") {
      this.item.text = `$(sync~spin) Notebook MCP`;
      this.item.tooltip = "Notebook MCP daemon starting";
      this.item.backgroundColor = undefined;
      this.item.command = "notebook-mcp-for-vscode.showDaemonStatus";
    } else if (state === "disconnected") {
      this.item.text = `$(plug) Notebook MCP`;
      this.item.tooltip = "Notebook MCP bridge disconnected. Click to restart the daemon.";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.command = "notebook-mcp-for-vscode.restartDaemon";
    } else {
      this.item.text = `$(error) Notebook MCP`;
      this.item.tooltip = "Notebook MCP daemon error. Click to restart the daemon.";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.command = "notebook-mcp-for-vscode.restartDaemon";
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
