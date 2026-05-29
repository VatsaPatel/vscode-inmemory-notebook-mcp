import * as vscode from "vscode";

import { DEFAULT_DAEMON_PORT } from "../common/protocol.js";
import { registerAgentStatusItems } from "./agentStatus.js";
import { BridgeClient } from "./bridgeClient.js";
import { registerCommands } from "./commands.js";
import { DaemonSupervisor } from "./daemonSupervisor.js";
import { registerNotebookEvents } from "./notebookEvents.js";
import { NotebookMcpStatusBar } from "./statusBar.js";

let bridge: BridgeClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const port = vscode.workspace.getConfiguration("notebook-mcp-for-vscode").get<number>("port", DEFAULT_DAEMON_PORT);
  const status = new NotebookMcpStatusBar(port);
  status.setState("starting");
  context.subscriptions.push(status);

  const supervisor = new DaemonSupervisor();
  context.subscriptions.push(supervisor);
  registerAgentStatusItems(context);
  registerCommands(context, supervisor, port, {
    connectBridge: () => bridge?.connect(),
    stopBridge: () => {
      bridge?.dispose();
      status.setState("disconnected");
    }
  });

  try {
    await supervisor.ensureRunning(port);
    bridge = new BridgeClient(
      port,
      (state) => status.setState(state === "connecting" ? "starting" : state),
      async () => {
        await supervisor.ensureRunning(port);
      },
      async () => await supervisor.readDaemonToken()
    );
    context.subscriptions.push(bridge);
    registerNotebookEvents(context, bridge);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("notebook-mcp-for-vscode.allowActiveNotebookWrites")) {
        bridge?.refreshRegistration();
      }
    }));
    bridge.connect();
  } catch (error) {
    status.setState("error");
    vscode.window.showErrorMessage(`Notebook MCP daemon failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function deactivate(): Promise<void> {
  bridge?.dispose();
  bridge = undefined;
}
