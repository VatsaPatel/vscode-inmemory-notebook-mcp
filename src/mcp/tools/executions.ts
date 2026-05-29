import { ErrorCode, NotebookMcpError } from "../../common/errors.js";
import type { DaemonToolDependencies } from "../../daemon/mcpServer.js";
import { errorResponse, formatResponse } from "../responses.js";
import { ExecutionIdInputSchema, OperationInputSchema, RunNotebookInputSchema, validateRunNotebookInput } from "../schemas.js";
import { NotebookMcpServer } from "../server.js";

export function registerExecutionTools(server: NotebookMcpServer, deps: DaemonToolDependencies): void {
  server.tool("notebook_run", "Use to execute cell/range/all or throwaway Python code. Requires notebook_uri; for Spark/long jobs, run a visible cell with short wait_ms, then poll notebook_operation.", RunNotebookInputSchema.shape, async (params) => {
    try {
      const parsed = RunNotebookInputSchema.parse(params);
      validateRunNotebookInput(parsed);
      const target = deps.router.resolveTarget({
        notebookUri: parsed.notebook_uri,
        context: deps.context,
        allowSingleNotebookFallback: false,
        allowActiveNotebookFallback: false,
        access: "execute"
      });

      if (parsed.scope === "cell") {
        const resolved = await deps.router.route<{ index: number }>(target, "notebook/resolveCell", {
          cell_id: parsed.cell_id,
          index: parsed.index
        }, 5000);
        const operation = await startCellOperation(deps, target, resolved.index, parsed.wait_ms, parsed.response_format);
        return operation;
      }

      if (parsed.scope === "code") {
        const result = await deps.router.route(target, "notebook/runCode", {
          code: parsed.code,
          language: "python",
          timeout_ms: parsed.wait_ms
        }, parsed.wait_ms <= 0 ? undefined : parsed.wait_ms + 1000);
        return formatResponse({ result }, parsed.response_format);
      }

      const result = await deps.router.route(target, "notebook/run", parsed as Record<string, unknown>, parsed.wait_ms <= 0 ? undefined : parsed.wait_ms + 1000);
      return formatResponse({ result }, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });

  server.tool("notebook_operation", "Use to list, get, wait for, or stream live output from operations. Safe/observational; it never cancels execution.", OperationInputSchema.shape, async (params) => {
    try {
      const parsed = OperationInputSchema.parse(params);
      if (!parsed.operation_id) {
        return formatResponse({ operations: deps.executions.list() }, parsed.response_format);
      }

      const baseOperation = parsed.wait_ms > 0
        ? await deps.executions.waitFor(parsed.operation_id, parsed.wait_ms)
        : deps.executions.get(parsed.operation_id);
      const operation = parsed.include_partial ? await hydrateLiveOperation(deps, baseOperation) : baseOperation;
      return formatResponse({
        operation,
        streaming: operation.status === "queued" || operation.status === "running",
        outputCount: operation.outputs?.length ?? 0
      }, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });

  server.tool("notebook_cancel_execution", "Use only when a running operation should stop. Destructive; call notebook_operation first if you only need status or output.", ExecutionIdInputSchema.shape, async (params) => {
    try {
      const parsed = ExecutionIdInputSchema.parse(params);
      const operation = deps.executions.get(parsed.operation_id);
      const target = {
        notebookUri: operation.notebookUri,
        windowId: operation.windowId
      };
      const result: any = await deps.router.route(target, "notebook/cancelExecution", {
        operation_id: operation.id,
        notebook_uri: operation.notebookUri,
        index: operation.cellIndex
      });
      if (result.cancelled !== true) {
        throw new Error(result.note ?? "Notebook cancellation was not acknowledged by the bridge.");
      }
      const cancelled = deps.executions.complete(operation.id, { status: "cancelled" });
      return formatResponse({ operation: cancelled }, parsed.response_format);
    } catch (error) {
      return errorResponse(error);
    }
  });
}

async function startCellOperation(
  deps: DaemonToolDependencies,
  target: { notebookUri: string; windowId: string },
  index: number,
  waitMs: number,
  responseFormat: any
) {
  const operation = deps.executions.create({
    notebookUri: target.notebookUri,
    cellIndex: index,
    windowId: target.windowId
  });

  deps.executions.markRunning(operation.id);
  void deps.router.route(target, "notebook/runCell", {
    index,
    timeout_ms: 0,
    operation_id: operation.id
  }, 24 * 60 * 60 * 1000).then((result: any) => {
    deps.executions.complete(operation.id, {
      status: result.success === false ? "failed" : "succeeded",
      executionOrder: result.executionOrder,
      outputs: result.outputs,
      error: result.error
    });
  }).catch((error) => {
    if (isTimeoutError(error)) {
      return;
    }
    deps.executions.complete(operation.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  });

  const waited = waitMs > 0 ? await deps.executions.waitFor(operation.id, waitMs) : operation;
  return formatResponse({ operation: waitMs > 0 ? await hydrateLiveOperation(deps, waited) : waited }, responseFormat);
}

async function hydrateLiveOperation(deps: DaemonToolDependencies, operation: ReturnType<DaemonToolDependencies["executions"]["get"]>) {
  if (operation.status !== "queued" && operation.status !== "running") {
    return operation;
  }

  try {
    const snapshot: any = await deps.router.route({
      notebookUri: operation.notebookUri,
      windowId: operation.windowId
    }, "notebook/getExecutionSnapshot", {
      operation_id: operation.id,
      notebook_uri: operation.notebookUri,
      index: operation.cellIndex
    }, 5000);
    return deps.executions.updateLiveSnapshot(operation.id, {
      executionOrder: snapshot.executionOrder,
      outputs: snapshot.outputs,
      error: snapshot.error
    });
  } catch {
    return operation;
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof NotebookMcpError && error.code === ErrorCode.BridgeTimeout) {
    return true;
  }
  return error instanceof Error && /timed?\s*out|timeout/i.test(error.message);
}
