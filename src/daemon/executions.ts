import { ErrorCode, NotebookMcpError } from "../common/errors.js";
import { createExecutionId } from "../common/ids.js";
import { CellOutput, ExecutionOperation } from "../common/types.js";

const EXECUTION_RETENTION_MS = 60 * 60 * 1000;
const MAX_OPERATIONS_PER_SESSION = 100;
const RESTART_LOST_ERROR = "Daemon restarted before execution completed.";

export interface ExecutionCompletion {
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "backend_lost";
  executionOrder?: number | null;
  outputs?: CellOutput[];
  error?: string;
}

export class ExecutionStore {
  private readonly operations = new Map<string, ExecutionOperation>();
  private readonly waiters = new Map<string, Array<(operation: ExecutionOperation) => void>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    initialOperations: ExecutionOperation[] = [],
    private readonly onChange: (operations: ExecutionOperation[]) => void = () => {}
  ) {
    for (const operation of initialOperations) {
      this.operations.set(operation.id, this.restoreOperation(operation));
    }
    this.collectGarbage();
  }

  create(params: {
    notebookUri: string;
    cellIndex: number;
    windowId: string;
  }): ExecutionOperation {
    const timestamp = this.now();
    const operation: ExecutionOperation = {
      id: createExecutionId(),
      notebookUri: params.notebookUri,
      cellIndex: params.cellIndex,
      windowId: params.windowId,
      status: "queued",
      startedAt: timestamp,
      updatedAt: timestamp
    };
    this.operations.set(operation.id, operation);
    this.notifyChanged();
    return operation;
  }

  markRunning(operationId: string): ExecutionOperation {
    const operation = this.get(operationId);
    if (this.isTerminal(operation)) {
      return operation;
    }
    operation.status = "running";
    operation.updatedAt = this.now();
    this.notifyChanged();
    return operation;
  }

  complete(operationId: string, completion: ExecutionCompletion): ExecutionOperation {
    const operation = this.get(operationId);
    if (this.isTerminal(operation)) {
      return operation;
    }
    operation.status = completion.status;
    operation.updatedAt = this.now();
    operation.completedAt = operation.updatedAt;
    operation.executionOrder = completion.executionOrder;
    operation.outputs = completion.outputs;
    operation.error = completion.error;
    this.resolveWaiters(operation);
    this.notifyChanged();
    return operation;
  }

  updateLiveSnapshot(operationId: string, snapshot: { executionOrder?: number | null; outputs?: CellOutput[]; error?: string }): ExecutionOperation {
    const operation = this.get(operationId);
    if (this.isTerminal(operation)) {
      return operation;
    }
    operation.updatedAt = this.now();
    operation.executionOrder = snapshot.executionOrder;
    operation.outputs = snapshot.outputs;
    operation.error = snapshot.error;
    this.notifyChanged();
    return operation;
  }

  get(operationId: string): ExecutionOperation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new NotebookMcpError(ErrorCode.InvalidRequest, `Execution operation not found: ${operationId}`);
    }
    return operation;
  }

  list(): ExecutionOperation[] {
    return [...this.operations.values()]
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async waitFor(operationId: string, timeoutMs: number): Promise<ExecutionOperation> {
    const operation = this.get(operationId);
    if (this.isTerminal(operation)) {
      return operation;
    }

    return await new Promise<ExecutionOperation>((resolve) => {
      const waiter = (completed: ExecutionOperation) => {
        clearTimeout(timeout);
        resolve(completed);
      };
      const timeout = setTimeout(() => {
        this.removeWaiter(operationId, waiter);
        resolve(this.get(operationId));
      }, timeoutMs);

      const waiters = this.waiters.get(operationId) ?? [];
      waiters.push(waiter);
      this.waiters.set(operationId, waiters);
    });
  }

  markBackendLost(windowId: string): void {
    for (const operation of this.operations.values()) {
      if (operation.windowId === windowId && (operation.status === "queued" || operation.status === "running")) {
        this.complete(operation.id, {
          status: "backend_lost",
          error: "Bridge worker disconnected before execution completed."
        });
      }
    }
  }

  get executionCount(): number {
    return this.operations.size;
  }

  snapshot(): ExecutionOperation[] {
    return this.sortedOperations().map((operation) => cloneOperation(operation));
  }

  private isTerminal(operation: ExecutionOperation): boolean {
    return operation.status === "succeeded"
      || operation.status === "failed"
      || operation.status === "cancelled"
      || operation.status === "timed_out"
      || operation.status === "backend_lost";
  }

  private resolveWaiters(operation: ExecutionOperation): void {
    const waiters = this.waiters.get(operation.id);
    if (!waiters) {
      return;
    }

    this.waiters.delete(operation.id);
    for (const resolve of waiters) {
      resolve(operation);
    }
  }

  private removeWaiter(operationId: string, waiter: (operation: ExecutionOperation) => void): void {
    const waiters = this.waiters.get(operationId);
    if (!waiters) {
      return;
    }
    const remaining = waiters.filter((candidate) => candidate !== waiter);
    if (remaining.length === 0) {
      this.waiters.delete(operationId);
    } else {
      this.waiters.set(operationId, remaining);
    }
  }

  private restoreOperation(operation: ExecutionOperation): ExecutionOperation {
    const restored = cloneOperation(operation);
    if (!this.isTerminal(restored)) {
      const timestamp = this.now();
      restored.status = "backend_lost";
      restored.updatedAt = timestamp;
      restored.completedAt = timestamp;
      restored.error = RESTART_LOST_ERROR;
    }
    return restored;
  }

  private notifyChanged(): void {
    this.collectGarbage();
    this.onChange(this.snapshot());
  }

  private collectGarbage(): void {
    const keepByCount = new Set<string>();
    const byNotebook = new Map<string, ExecutionOperation[]>();

    for (const operation of this.operations.values()) {
      const notebookOperations = byNotebook.get(this.notebookKey(operation)) ?? [];
      notebookOperations.push(operation);
      byNotebook.set(this.notebookKey(operation), notebookOperations);
    }

    for (const notebookOperations of byNotebook.values()) {
      notebookOperations
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_OPERATIONS_PER_SESSION)
        .forEach((operation) => keepByCount.add(operation.id));
    }

    const cutoff = this.now() - EXECUTION_RETENTION_MS;
    for (const operation of this.operations.values()) {
      if (!this.isTerminal(operation) || operation.updatedAt >= cutoff || keepByCount.has(operation.id)) {
        continue;
      }
      this.operations.delete(operation.id);
    }
  }

  private sortedOperations(): ExecutionOperation[] {
    return [...this.operations.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  private notebookKey(operation: ExecutionOperation): string {
    return operation.notebookUri;
  }
}

function cloneOperation(operation: ExecutionOperation): ExecutionOperation {
  return {
    ...operation,
    outputs: operation.outputs?.map((output) => ({ ...output }))
  };
}
