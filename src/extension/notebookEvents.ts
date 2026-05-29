import * as vscode from "vscode";

import { BridgeClient } from "./bridgeClient.js";

export function registerNotebookEvents(context: vscode.ExtensionContext, bridge: BridgeClient): void {
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(() => bridge.refreshRegistration()),
    vscode.workspace.onDidCloseNotebookDocument(() => bridge.refreshRegistration()),
    vscode.workspace.onDidChangeNotebookDocument(() => bridge.refreshRegistration()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isNotebookCellDocument(event.document)) {
        bridge.refreshRegistration();
      }
    }),
    vscode.window.onDidChangeVisibleNotebookEditors(() => bridge.refreshRegistration()),
    vscode.window.onDidChangeActiveNotebookEditor(() => bridge.refreshRegistration())
  );
}

function isNotebookCellDocument(document: vscode.TextDocument): boolean {
  return vscode.workspace.notebookDocuments.some((notebook) => notebook.getCells().some((cell) => cell.document === document));
}
