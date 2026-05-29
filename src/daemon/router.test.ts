import { describe, expect, it } from "vitest";

import { ErrorCode, NotebookMcpError } from "../common/errors.js";
import { BridgeServer } from "./bridgeServer.js";
import { DaemonRegistry } from "./registry.js";
import { NotebookRouter } from "./router.js";

function registration(windowId: string, notebookUri: string, options: { active?: boolean; allowActiveNotebookWrites?: boolean } = {}) {
  return {
    windowId,
    bridgeVersion: "0.1.0",
    extensionVersion: "0.3.0",
    pid: 1,
    workspaceFolders: [],
    notebooks: [{
      uri: notebookUri,
      fileName: "a.ipynb",
      notebookType: "jupyter-notebook",
      cellCount: 1,
      visible: true,
      active: options.active ?? false,
      dirty: false
    }],
    allowActiveNotebookWrites: options.allowActiveNotebookWrites
  };
}

function setup() {
  const registry = new DaemonRegistry();
  const bridge = new BridgeServer(registry);
  const router = new NotebookRouter(registry, bridge);
  return { registry, router };
}

function expectErrorCode(action: () => unknown, code: ErrorCode): void {
  expect(action).toThrow(NotebookMcpError);
  try {
    action();
  } catch (error) {
    expect((error as NotebookMcpError).code).toBe(code);
  }
}

describe("NotebookRouter", () => {
  it("routes explicit notebook_uri targets", () => {
    const { registry, router } = setup();
    registry.registerWindow(registration("win_a", "file:///a.ipynb"));

    expect(router.resolveTarget({
      notebookUri: "file:///a.ipynb",
      context: {},
      allowSingleNotebookFallback: false,
      access: "read"
    })).toEqual({
      notebookUri: "file:///a.ipynb",
      windowId: "win_a"
    });
  });

  it("rejects ambiguous read fallback", () => {
    const { registry, router } = setup();
    registry.registerWindow(registration("win_a", "file:///a.ipynb"));
    registry.registerWindow(registration("win_b", "file:///b.ipynb"));

    expectErrorCode(() => router.resolveTarget({ context: {}, allowSingleNotebookFallback: true, access: "read" }), ErrorCode.AmbiguousTarget);
  });

  it("rejects writes without explicit notebook_uri", () => {
    const { registry, router } = setup();
    registry.registerWindow(registration("win_a", "file:///a.ipynb"));

    expectErrorCode(() => router.resolveTarget({ context: {}, allowSingleNotebookFallback: false, access: "write" }), ErrorCode.MissingTarget);
  });

  it("does not use active notebook fallback unless explicitly requested", () => {
    const { registry, router } = setup();
    registry.registerWindow(registration("win_a", "file:///a.ipynb", { active: true }));

    expectErrorCode(() => router.resolveTarget({
      context: {},
      allowSingleNotebookFallback: false,
      allowActiveNotebookFallback: false,
      access: "write"
    }), ErrorCode.MissingTarget);
  });

  it("can still support explicit active notebook fallback for compatibility callers", () => {
    const { registry, router } = setup();
    registry.registerWindow(registration("win_a", "file:///a.ipynb", {
      active: true,
      allowActiveNotebookWrites: true
    }));

    expect(router.resolveTarget({
      context: {},
      allowSingleNotebookFallback: false,
      allowActiveNotebookFallback: true,
      access: "write"
    })).toEqual({
      notebookUri: "file:///a.ipynb",
      windowId: "win_a"
    });
  });
});
