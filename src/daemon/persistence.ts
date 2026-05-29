import { promises as fs } from "fs";
import * as path from "path";

import { getAppDataDir } from "../common/paths.js";
import { ExecutionOperation } from "../common/types.js";

const EXECUTION_SNAPSHOT_VERSION = 1;

interface ExecutionSnapshot {
  version: typeof EXECUTION_SNAPSHOT_VERSION;
  operations: ExecutionOperation[];
}

export class DaemonPersistence {
  private writeQueue = Promise.resolve();
  private tempCounter = 0;

  constructor(
    private readonly executionSnapshotPath = executionSnapshotPathFor()
  ) {}

  async loadExecutions(): Promise<ExecutionOperation[]> {
    try {
      const text = await fs.readFile(this.executionSnapshotPath, "utf8");
      const parsed = JSON.parse(text) as Partial<ExecutionSnapshot>;
      if (parsed.version !== EXECUTION_SNAPSHOT_VERSION) {
        throw new Error(`Unsupported execution snapshot version: ${String(parsed.version)}`);
      }
      if (!Array.isArray(parsed.operations)) {
        throw new Error("Invalid execution snapshot: operations must be an array.");
      }
      return parsed.operations.map((operation) => cloneOperation(operation));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async saveExecutions(operations: ExecutionOperation[]): Promise<void> {
    const snapshot: ExecutionSnapshot = {
      version: EXECUTION_SNAPSHOT_VERSION,
      operations: operations.map((operation) => cloneOperation(operation))
    };
    const write = this.writeQueue
      .catch(() => {})
      .then(() => this.writeSnapshot(this.executionSnapshotPath, snapshot));
    this.writeQueue = write;
    await write;
  }

  private async writeSnapshot(snapshotPath: string, snapshot: ExecutionSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
    const tempPath = `${snapshotPath}.${process.pid}.${++this.tempCounter}.tmp`;

    try {
      const handle = await fs.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, snapshotPath);
      await this.syncParentDirectory(snapshotPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  private async syncParentDirectory(snapshotPath: string): Promise<void> {
    try {
      const handle = await fs.open(path.dirname(snapshotPath), "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is best-effort across supported platforms/filesystems.
    }
  }
}

function executionSnapshotPathFor(): string {
  return path.join(getAppDataDir(), "executions.snapshot.json");
}

function cloneOperation(operation: ExecutionOperation): ExecutionOperation {
  return {
    ...operation,
    outputs: operation.outputs?.map((output) => ({ ...output }))
  };
}
