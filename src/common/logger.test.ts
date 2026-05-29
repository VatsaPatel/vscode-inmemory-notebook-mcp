import { promises as fs } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { configureLogFile, createLogger } from "./logger.js";

const tempDirs: string[] = [];

async function tempLogPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "notebook-mcp-logger-"));
  tempDirs.push(dir);
  return path.join(dir, "daemon.log");
}

afterEach(async () => {
  configureLogFile(undefined);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createLogger", () => {
  it("appends log lines to the configured file", async () => {
    const logPath = await tempLogPath();
    configureLogFile(logPath);

    createLogger("test").info("hello", { value: 1 });

    await expect(fs.readFile(logPath, "utf8")).resolves.toContain("[test] [info] hello {\"value\":1}");
  });

  it("does not require file logging to be configured", () => {
    expect(() => createLogger("test").warn("console only")).not.toThrow();
  });
});
