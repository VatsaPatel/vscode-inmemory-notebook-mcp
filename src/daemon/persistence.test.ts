import { promises as fs } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionOperation } from "../common/types.js";
import { ExecutionStore } from "./executions.js";
import { DaemonPersistence } from "./persistence.js";

let tempDirs: string[] = [];

async function tempSnapshotPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "notebook-mcp-persistence-"));
  tempDirs.push(dir);
  return path.join(dir, "executions.json");
}

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
    executionOrder: 3,
    outputs: [{ type: "text", text: "ok" }],
    ...overrides
  };
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("DaemonPersistence", () => {
  it("saves and loads execution snapshots", async () => {
    const executionSnapshotPath = await tempSnapshotPath();
    const persistence = new DaemonPersistence(executionSnapshotPath);
    const savedOperation = operation();

    await persistence.saveExecutions([savedOperation]);

    await expect(persistence.loadExecutions()).resolves.toEqual([savedOperation]);
    await expect(fs.readFile(executionSnapshotPath, "utf8").then(JSON.parse)).resolves.toMatchObject({ version: 1 });
  });

  it("returns no executions when the execution snapshot file is missing", async () => {
    const persistence = new DaemonPersistence(await tempSnapshotPath());

    await expect(persistence.loadExecutions()).resolves.toEqual([]);
  });

  it("rejects unsupported execution snapshot versions", async () => {
    const executionSnapshotPath = await tempSnapshotPath();
    await fs.writeFile(executionSnapshotPath, JSON.stringify({ version: 999, operations: [] }));
    const persistence = new DaemonPersistence(executionSnapshotPath);

    await expect(persistence.loadExecutions()).rejects.toThrow("Unsupported execution snapshot version");
  });

  it("serializes concurrent execution snapshot writes so the latest call wins", async () => {
    const executionSnapshotPath = await tempSnapshotPath();
    const persistence = new DaemonPersistence(executionSnapshotPath);
    const first = operation({ id: "exec_first", startedAt: 1 });
    const second = operation({ id: "exec_second", startedAt: 2 });

    await Promise.all([
      persistence.saveExecutions([first]),
      persistence.saveExecutions([second])
    ]);

    await expect(persistence.loadExecutions()).resolves.toEqual([second]);
    await expect(fs.readdir(path.dirname(executionSnapshotPath))).resolves.toEqual(["executions.json"]);
  });

  it("captures the execution state passed to saveExecutions", async () => {
    const executionSnapshotPath = await tempSnapshotPath();
    const persistence = new DaemonPersistence(executionSnapshotPath);
    const savedOperation = operation();

    const save = persistence.saveExecutions([savedOperation]);
    savedOperation.outputs?.push({ type: "text", text: "mutated" });
    savedOperation.status = "failed";
    await save;

    await expect(persistence.loadExecutions()).resolves.toEqual([operation()]);
  });
});

describe("ExecutionStore restart persistence", () => {
  it("loads persisted execution operations after restart", async () => {
    const executionSnapshotPath = await tempSnapshotPath();
    const persistence = new DaemonPersistence(executionSnapshotPath);
    const beforeRestart = new ExecutionStore(() => 200);
    const created = beforeRestart.create({
      notebookUri: "file:///saved.ipynb",
      cellIndex: 0,
      windowId: "win_saved"
    });
    beforeRestart.complete(created.id, {
      status: "succeeded",
      executionOrder: 3,
      outputs: [{ type: "text", text: "ok" }]
    });

    await persistence.saveExecutions(beforeRestart.snapshot());
    const afterRestart = new ExecutionStore(() => 300, await persistence.loadExecutions());

    expect(afterRestart.get(created.id)).toMatchObject({
      id: created.id,
      status: "succeeded",
      executionOrder: 3,
      outputs: [{ type: "text", text: "ok" }]
    });
  });
});
