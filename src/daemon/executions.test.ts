import { describe, expect, it } from "vitest";

import { ExecutionOperation } from "../common/types.js";
import { ExecutionStore } from "./executions.js";

const HOUR_MS = 60 * 60 * 1000;

describe("ExecutionStore", () => {
  it("transitions operations and retains outputs", () => {
    const store = new ExecutionStore();
    const operation = store.create({
      notebookUri: "file:///a.ipynb",
      cellIndex: 0,
      windowId: "win_a"
    });

    expect(operation.status).toBe("queued");
    expect(store.markRunning(operation.id).status).toBe("running");

    const completed = store.complete(operation.id, {
      status: "succeeded",
      executionOrder: 7,
      outputs: [{ type: "text", text: "ok" }]
    });

    expect(completed.status).toBe("succeeded");
    expect(completed.executionOrder).toBe(7);
    expect(completed.outputs).toEqual([{ type: "text", text: "ok" }]);
  });

  it("waits for terminal state", async () => {
    const store = new ExecutionStore();
    const operation = store.create({
      notebookUri: "file:///a.ipynb",
      cellIndex: 0,
      windowId: "win_a"
    });
    store.markRunning(operation.id);

    const waiting = store.waitFor(operation.id, 1000);
    store.complete(operation.id, { status: "failed", error: "boom" });

    await expect(waiting).resolves.toMatchObject({
      id: operation.id,
      status: "failed",
      error: "boom"
    });
  });

  it("returns the current operation and removes the waiter when waitFor times out", async () => {
    const store = new ExecutionStore();
    const operation = store.create({
      notebookUri: "file:///a.ipynb",
      cellIndex: 0,
      windowId: "win_a"
    });
    store.markRunning(operation.id);

    await expect(store.waitFor(operation.id, 1)).resolves.toMatchObject({
      id: operation.id,
      status: "running"
    });
    expect((store as any).waiters.size).toBe(0);
  });

  it("does not overwrite terminal operations", () => {
    const store = new ExecutionStore(() => 100);
    const operation = store.create({
      notebookUri: "file:///a.ipynb",
      cellIndex: 0,
      windowId: "win_a"
    });

    const completed = store.complete(operation.id, {
      status: "succeeded",
      executionOrder: 7,
      outputs: [{ type: "text", text: "ok" }]
    });

    const afterFailedCompletion = store.complete(operation.id, {
      status: "failed",
      error: "late failure"
    });
    const afterRunningMark = store.markRunning(operation.id);

    expect(afterFailedCompletion).toBe(completed);
    expect(afterRunningMark).toBe(completed);
    expect(store.get(operation.id)).toMatchObject({
      status: "succeeded",
      executionOrder: 7,
      outputs: [{ type: "text", text: "ok" }]
    });
    expect(store.get(operation.id).error).toBeUndefined();
  });

  it("updates live snapshots for running operations but not terminal operations", () => {
    const store = new ExecutionStore(() => 100);
    const operation = store.create({
      notebookUri: "file:///a.ipynb",
      cellIndex: 0,
      windowId: "win_a"
    });
    store.markRunning(operation.id);

    const live = store.updateLiveSnapshot(operation.id, {
      executionOrder: 2,
      outputs: [{ type: "text", text: "spark stage 1", stream: "stdout" }]
    });
    expect(live).toMatchObject({
      status: "running",
      executionOrder: 2,
      outputs: [{ type: "text", text: "spark stage 1", stream: "stdout" }]
    });

    store.complete(operation.id, { status: "succeeded", outputs: [{ type: "text", text: "done" }] });
    store.updateLiveSnapshot(operation.id, { outputs: [{ type: "text", text: "late" }] });
    expect(store.get(operation.id).outputs).toEqual([{ type: "text", text: "done" }]);
  });

  it("marks active operations backend_lost when a bridge disconnects", () => {
    const store = new ExecutionStore();
    const operation = store.create({
      notebookUri: "file:///a.ipynb",
      cellIndex: 0,
      windowId: "win_a"
    });
    store.markRunning(operation.id);

    store.markBackendLost("win_a");

    expect(store.get(operation.id)).toMatchObject({
      status: "backend_lost",
      error: "Bridge worker disconnected before execution completed."
    });
  });

  it("restores active operations as backend_lost after daemon restart", () => {
    const store = new ExecutionStore(() => 500, [
      operation({
        id: "exec_running",
        status: "running",
        startedAt: 100,
        updatedAt: 200
      })
    ]);

    expect(store.get("exec_running")).toMatchObject({
      status: "backend_lost",
      updatedAt: 500,
      completedAt: 500,
      error: "Daemon restarted before execution completed."
    });
  });

  it("garbage-collects completed operations older than retention except the last 100 per notebook", () => {
    let now = 0;
    const store = new ExecutionStore(() => now);
    let oldestOperationId = "";

    for (let index = 0; index < 101; index++) {
      now = index;
      const created = store.create({
        notebookUri: "file:///a.ipynb",
        cellIndex: index,
        windowId: "win_a"
      });
      oldestOperationId ||= created.id;
      store.complete(created.id, { status: "succeeded" });
    }

    now = HOUR_MS + 200;
    const otherNotebookOperation = store.create({
      notebookUri: "file:///b.ipynb",
      cellIndex: 0,
      windowId: "win_b"
    });
    store.complete(otherNotebookOperation.id, { status: "succeeded" });

    const operations = store.list();
    const notebookAOperations = operations.filter((operation) => operation.notebookUri === "file:///a.ipynb");
    const notebookBOperations = operations.filter((operation) => operation.notebookUri === "file:///b.ipynb");
    expect(notebookAOperations).toHaveLength(100);
    expect(notebookAOperations[0].cellIndex).toBe(1);
    expect(notebookBOperations).toHaveLength(1);
    expect(() => store.get(oldestOperationId)).toThrow("Execution operation not found");
  });
});

function operation(overrides: Partial<ExecutionOperation> = {}): ExecutionOperation {
    return {
      id: "exec_saved",
      notebookUri: "file:///saved.ipynb",
    cellIndex: 0,
    windowId: "win_saved",
    status: "succeeded",
    startedAt: 100,
    updatedAt: 200,
    completedAt: 200,
    ...overrides
  };
}
