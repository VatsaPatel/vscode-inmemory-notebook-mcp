import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  getAppDataDir,
  getDaemonLockPath,
  getDaemonLogPath,
  getDaemonPidPath,
  getRegistrySnapshotPath,
  getShutdownTokenPath
} from "./paths.js";

describe("daemon paths", () => {
  it("honors an explicit app data override", () => {
    expect(getAppDataDir({ env: { NOTEBOOK_MCP_FOR_VSCODE_HOME: "/tmp/notebook-mcp" } })).toBe("/tmp/notebook-mcp");
    expect(getAppDataDir({ env: { VSCODE_IN_MEMORY_COMPLETE_JUPYTER_MCP_HOME: "/tmp/previous-name" } })).toBe("/tmp/previous-name");
    expect(getAppDataDir({ env: { INMEMORY_NOTEBOOK_MCP_HOME: "/tmp/original-name" } })).toBe("/tmp/original-name");
  });

  it("uses platform-specific app data roots", () => {
    expect(getAppDataDir({ platform: "darwin", homeDir: "/Users/test", env: {} })).toBe(
      "/Users/test/Library/Application Support/notebook-mcp-for-vscode"
    );

    expect(getAppDataDir({ platform: "linux", homeDir: "/home/test", env: {} })).toBe(
      "/home/test/.local/state/notebook-mcp-for-vscode"
    );

    expect(getAppDataDir({ platform: "win32", homeDir: "C:\\Users\\test", env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" } })).toBe(
      path.join("C:\\Users\\test\\AppData\\Roaming", "notebook-mcp-for-vscode")
    );
  });

  it("returns named daemon support files", () => {
    const options = { env: { NOTEBOOK_MCP_FOR_VSCODE_HOME: "/tmp/notebook-mcp" } };

    expect(getDaemonPidPath(options)).toBe("/tmp/notebook-mcp/daemon.pid");
    expect(getDaemonLockPath(options)).toBe("/tmp/notebook-mcp/daemon.lock");
    expect(getShutdownTokenPath(options)).toBe("/tmp/notebook-mcp/shutdown.token");
    expect(getDaemonLogPath(options)).toBe("/tmp/notebook-mcp/daemon.log");
    expect(getRegistrySnapshotPath(options)).toBe("/tmp/notebook-mcp/registry.snapshot.json");
  });
});
