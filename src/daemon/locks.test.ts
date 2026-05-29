import { promises as fs } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { NotebookMcpError } from "../common/errors.js";
import { acquireDaemonLock, type DaemonLock } from "./locks.js";

const tempDirs: string[] = [];

async function tempLockPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "notebook-mcp-lock-"));
  tempDirs.push(dir);
  return path.join(dir, "daemon.lock");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("acquireDaemonLock", () => {
  it("creates and releases a lock file", async () => {
    const lockPath = await tempLockPath();

    const lock = await acquireDaemonLock({ lockPath, pid: 123, isProcessAlive: () => false });

    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("123\n");
    await lock.release();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when another live process owns the lock", async () => {
    const lockPath = await tempLockPath();
    await fs.writeFile(lockPath, "456\n");

    await expect(acquireDaemonLock({
      lockPath,
      pid: 123,
      isProcessAlive: (pid) => pid === 456
    })).rejects.toBeInstanceOf(NotebookMcpError);

    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("456\n");
  });

  it("removes stale locks and acquires ownership", async () => {
    const lockPath = await tempLockPath();
    await fs.writeFile(lockPath, "456\n");

    const lock = await acquireDaemonLock({
      lockPath,
      pid: 789,
      isProcessAlive: () => false
    });

    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("789\n");
    await lock.release();
  });

  it("allows only one concurrent replacement of a stale lock", async () => {
    const lockPath = await tempLockPath();
    await fs.writeFile(lockPath, "456\n");

    const attempts = await Promise.allSettled([
      acquireDaemonLock({ lockPath, pid: 789, isProcessAlive: (pid) => pid !== 456 }),
      acquireDaemonLock({ lockPath, pid: 987, isProcessAlive: (pid) => pid !== 456 })
    ]);

    const acquired = attempts.filter((attempt): attempt is PromiseFulfilledResult<DaemonLock> => (
      attempt.status === "fulfilled"
    ));
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(["789\n", "987\n"]).toContain(await fs.readFile(lockPath, "utf8"));
    await acquired[0].value.release();
  });

  it("does not remove a lock that no longer belongs to the releasing process", async () => {
    const lockPath = await tempLockPath();
    const lock = await acquireDaemonLock({ lockPath, pid: 123, isProcessAlive: () => false });
    await fs.writeFile(lockPath, "456\n");

    await lock.release();

    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("456\n");
  });
});
