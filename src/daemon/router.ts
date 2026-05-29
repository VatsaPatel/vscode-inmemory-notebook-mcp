import { ErrorCode, NotebookMcpError } from "../common/errors.js";
import { RoutedNotebookTarget, ToolContext } from "../common/types.js";
import { BridgeServer } from "./bridgeServer.js";
import { DaemonRegistry } from "./registry.js";

export interface ResolveTargetOptions {
  notebookUri?: string;
  context: ToolContext;
  allowSingleNotebookFallback: boolean;
  allowActiveNotebookFallback?: boolean;
  access: "read" | "write" | "execute";
}

export class NotebookRouter {
  constructor(
    private readonly registry: DaemonRegistry,
    private readonly bridge: BridgeServer
  ) {}

  resolveTarget(options: ResolveTargetOptions): RoutedNotebookTarget {
    if (options.notebookUri) {
      const windowId = this.resolveWindowForNotebook(options.notebookUri);
      return {
        notebookUri: options.notebookUri,
        windowId
      };
    }

    if (options.context.notebookUri) {
      const windowId = this.resolveWindowForNotebook(options.context.notebookUri);
      return {
        notebookUri: options.context.notebookUri,
        windowId
      };
    }

    if (options.allowSingleNotebookFallback) {
      const notebooks = this.registry.listOpenNotebooks();
      if (notebooks.length === 1) {
        const notebookUri = notebooks[0].uri;
        return {
          notebookUri,
          windowId: this.resolveWindowForNotebook(notebookUri)
        };
      }

      if (notebooks.length > 1) {
        throw new NotebookMcpError(
          ErrorCode.AmbiguousTarget,
          "Multiple notebooks are registered. Connect through a notebook session URL or pass notebook_uri explicitly.",
          { notebooks: notebooks.map((notebook) => notebook.uri) }
        );
      }
    }

    if (options.allowActiveNotebookFallback) {
      const activeTargets = this.registry.listConnectedWindows()
        .filter((record) => record.registration.allowActiveNotebookWrites === true)
        .flatMap((record) => record.registration.notebooks
          .filter((notebook) => notebook.active)
          .map((notebook) => ({ notebook, windowId: record.registration.windowId })));

      if (activeTargets.length === 1) {
        return {
          notebookUri: activeTargets[0].notebook.uri,
          windowId: activeTargets[0].windowId
        };
      }

      if (activeTargets.length > 1) {
        throw new NotebookMcpError(
          ErrorCode.AmbiguousTarget,
          "Multiple active notebooks are available for compatibility write fallback. Connect through a notebook session URL or pass notebook_uri explicitly.",
          { notebooks: activeTargets.map((target) => target.notebook.uri) }
        );
      }
    }

    throw new NotebookMcpError(
      ErrorCode.MissingTarget,
      "No notebook target was provided. Call notebook_status, choose a notebook URI, then pass notebook_uri explicitly."
    );
  }

  async route<TResult>(target: RoutedNotebookTarget, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<TResult> {
    return this.bridge.sendRequest<TResult>(target.windowId, method, {
      ...params,
      notebook_uri: target.notebookUri
    }, timeoutMs);
  }

  private resolveWindowForNotebook(notebookUri: string): string {
    const window = this.registry.findWindowsForNotebook(notebookUri)[0];
    if (!window) {
      throw new NotebookMcpError(ErrorCode.NotebookNotFound, `Notebook is not registered: ${notebookUri}`);
    }
    return window.registration.windowId;
  }
}
