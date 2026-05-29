import { describe, expect, it } from "vitest";

import { DaemonRegistry } from "./registry.js";

function registration(windowId: string, notebookUri: string) {
  return {
    windowId,
    bridgeVersion: "0.1.0",
    extensionVersion: "0.3.0",
    pid: 1,
    workspaceFolders: [`/workspace/${windowId}`],
    notebooks: [{
      uri: notebookUri,
      fileName: notebookUri.split("/").pop() ?? "notebook.ipynb",
      notebookType: "jupyter-notebook",
      cellCount: 1,
      visible: true,
      active: false,
      dirty: false
    }]
  };
}

describe("DaemonRegistry", () => {
  it("registers windows and indexes notebooks", () => {
    const registry = new DaemonRegistry();

    registry.registerWindow(registration("win_b", "file:///b.ipynb"));
    registry.registerWindow(registration("win_a", "file:///a.ipynb"));

    expect(registry.windowCount).toBe(2);
    expect(registry.listOpenNotebooks().map((notebook) => notebook.uri)).toEqual(["file:///a.ipynb", "file:///b.ipynb"]);
    expect(registry.findWindowsForNotebook("file:///a.ipynb")[0].registration.windowId).toBe("win_a");
  });

  it("removes disconnected windows from routing candidates", () => {
    const registry = new DaemonRegistry();

    registry.registerWindow(registration("win_a", "file:///a.ipynb"));
    registry.markDisconnected("win_a");

    expect(registry.windowCount).toBe(0);
    expect(registry.findWindowsForNotebook("file:///a.ipynb")).toEqual([]);
  });

  it("touches windows when bridge liveness is observed", () => {
    let now = 1000;
    const registry = new DaemonRegistry(() => now);

    registry.registerWindow(registration("win_a", "file:///a.ipynb"));
    now = 1500;
    registry.touchWindow("win_a");

    expect(registry.getWindow("win_a")?.lastSeenAt).toBe(1500);
    expect(registry.getWindow("win_a")?.connected).toBe(true);
  });

  it("prunes stale windows from routing candidates", () => {
    let now = 0;
    const registry = new DaemonRegistry(() => now);

    registry.registerWindow(registration("win_stale", "file:///stale.ipynb"));
    now = 90;
    registry.registerWindow(registration("win_fresh", "file:///fresh.ipynb"));
    now = 100;

    expect(registry.pruneStaleWindows(50)).toEqual(["win_stale"]);
    expect(registry.windowCount).toBe(1);
    expect(registry.findWindowsForNotebook("file:///stale.ipynb")).toEqual([]);
    expect(registry.findWindowsForNotebook("file:///fresh.ipynb")[0].registration.windowId).toBe("win_fresh");
  });
});
