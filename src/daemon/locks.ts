import { promises as fs } from "fs";
import * as path from "path";

import { ErrorCode, NotebookMcpError } from "../common/errors.js";
import { getDaemonLockPath } from "../common/paths.js";

export interface DaemonLock {
  path: string;
  release(): Promise<void>;
}

export interface DaemonLockOptions {
  lockPath?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export async function acquireDaemonLock(options: DaemonLockOptions = {}): Promise<DaemonLock> {
  const lockPath = options.lockPath ?? getDaemonLockPath();
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${pid}\n`);
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        release: async () => {
          const ownerPid = await readLockPid(lockPath);
          if (ownerPid === pid) {
            await fs.rm(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const ownerPid = await readLockPid(lockPath);
      if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
        throw new NotebookMcpError(ErrorCode.PortInUse, `Notebook MCP daemon lock is already held by pid ${ownerPid}.`, {
          lockPath,
          ownerPid
        });
      }

      await removeLockIfOwnerUnchanged(lockPath, ownerPid);
    }
  }

  throw new NotebookMcpError(ErrorCode.PortInUse, `Notebook MCP daemon lock could not be acquired: ${lockPath}`);
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    if (!(await isRegularLockFile(lockPath))) {
      return undefined;
    }
    const text = await fs.readFile(lockPath, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (error instanceof NotebookMcpError) {
      throw error;
    }
    return undefined;
  }
}

async function removeLockIfOwnerUnchanged(lockPath: string, expectedOwnerPid: number | undefined): Promise<void> {
  if (!(await isRegularLockFile(lockPath))) {
    return;
  }
  const ownerPid = await readLockPid(lockPath);
  if (ownerPid === expectedOwnerPid) {
    await fs.rm(lockPath, { force: true });
  }
}

async function isRegularLockFile(lockPath: string): Promise<boolean> {
  let stats;
  try {
    stats = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new NotebookMcpError(ErrorCode.PortInUse, `Notebook MCP daemon lock is not a regular file: ${lockPath}`, {
      lockPath
    });
  }
  return true;
}

function defaultIsProcessAlive(_pid: number): boolean {
  return true;
}
