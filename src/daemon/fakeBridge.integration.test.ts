import { createServer } from "net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ErrorCode, NotebookMcpError } from "../common/errors.js";
import { formatMcpUrl } from "../common/protocol.js";
import { BridgeServer } from "./bridgeServer.js";
import { ExecutionStore } from "./executions.js";
import { DaemonHttpServer } from "./httpServer.js";
import { DaemonMcpHandler } from "./mcpServer.js";
import { DaemonRegistry } from "./registry.js";
import { NotebookRouter } from "./router.js";

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

describe("daemon fake bridge integration", () => {
  it("routes global MCP tool calls by explicit notebook_uri", async () => {
    const port = await freePort();
    const registry = new DaemonRegistry();
    const executions = new ExecutionStore();
    const bridge = new BridgeServer(registry, {
      onDisconnect: (windowId) => executions.markBackendLost(windowId)
    });
    const router = new NotebookRouter(registry, bridge);
    let daemon: DaemonHttpServer;
    const mcp = new DaemonMcpHandler({
      port,
      registry,
      router,
      executions,
      status: () => daemon.status()
    });

    daemon = new DaemonHttpServer({
      port,
      shutdownToken: "test-token",
      stats: () => ({
        windowCount: registry.windowCount,
        sessionCount: 0,
        bridgeCount: bridge.bridgeCount,
        executionCount: executions.executionCount
      }),
      onServerCreated: (server) => bridge.attach(server),
      mcpHandler: (req, res) => mcp.handle(req, res)
    });

    await daemon.start();
    cleanup.push(async () => {
      mcp.close();
      await bridge.close();
      await daemon.stop();
    });

    const fakeBridge = await connectFakeBridge(port, (request) => ({
      total: 1,
      cells: [{
        index: 0,
        kind: "code",
        language: "python",
        preview: "x = 1"
      }]
    }));
    cleanup.push(() => fakeBridge.close());

    await waitFor(async () => (await getJson<any>(port, "/status")).bridgeCount === 1);
    const client = new Client({ name: "fake-bridge-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(formatMcpUrl(port, "test-token")));
    await client.connect(transport);
    cleanup.push(() => client.close());

    const result = await client.callTool({
      name: "notebook_read",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        response_format: "json"
      }
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0].type === "text" ? content[0].text ?? "" : "";
    expect(JSON.parse(text)).toEqual({
      total: 1,
      cells: [{
        index: 0,
        kind: "code",
        language: "python",
        preview: "x = 1"
      }]
    });
  });

  it("keeps execution operations queryable across MCP reconnect", async () => {
    const port = await freePort();
    const registry = new DaemonRegistry();
    const executions = new ExecutionStore();
    const bridge = new BridgeServer(registry);
    const router = new NotebookRouter(registry, bridge);
    let daemon: DaemonHttpServer;
    const mcp = new DaemonMcpHandler({
      port,
      registry,
      router,
      executions,
      status: () => daemon.status()
    });

    daemon = new DaemonHttpServer({
      port,
      shutdownToken: "test-token",
      stats: () => ({
        windowCount: registry.windowCount,
        sessionCount: 0,
        bridgeCount: bridge.bridgeCount,
        executionCount: executions.executionCount
      }),
      onServerCreated: (server) => bridge.attach(server),
      mcpHandler: (req, res) => mcp.handle(req, res)
    });

    await daemon.start();
    cleanup.push(async () => {
      mcp.close();
      await bridge.close();
      await daemon.stop();
    });

    const fakeBridge = await connectFakeBridge(port, async (request) => {
      if (request.method === "notebook/runCell") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          success: true,
          executionOrder: 3,
          outputs: [{ type: "text", text: "finished" }]
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });
    cleanup.push(() => fakeBridge.close());

    await waitFor(async () => (await getJson<any>(port, "/status")).bridgeCount === 1);
    const firstClient = new Client({ name: "first-client", version: "0.0.0" });
    await firstClient.connect(new StreamableHTTPClientTransport(new URL(formatMcpUrl(port, "test-token"))));
    const started = await firstClient.callTool({
      name: "notebook_run",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        scope: "cell",
        index: 0,
        wait_ms: 0,
        response_format: "json"
      }
    });
    const operationId = JSON.parse(textContent(started)).operation.id;
    await firstClient.close();

    const secondClient = new Client({ name: "second-client", version: "0.0.0" });
    await secondClient.connect(new StreamableHTTPClientTransport(new URL(formatMcpUrl(port, "test-token"))));
    cleanup.push(() => secondClient.close());

    const waited = await secondClient.callTool({
      name: "notebook_operation",
      arguments: {
        operation_id: operationId,
        wait_ms: 1000,
        response_format: "json"
      }
    });

    expect(JSON.parse(textContent(waited)).operation).toMatchObject({
      id: operationId,
      status: "succeeded",
      executionOrder: 3,
      outputs: [{ type: "text", text: "finished" }]
    });
  });

  it("routes two explicit notebook URIs to their own bridge windows", async () => {
    const harness = await startHarness();
    const received: string[] = [];

    const bridgeA = await connectFakeBridge(harness.port, (request) => {
      received.push(`${request.method}:${request.params.notebook_uri}:win_a`);
      return { windowId: "win_a", notebookUri: request.params.notebook_uri };
    }, { windowId: "win_a", notebookUri: "file:///tmp/a.ipynb" });
    const bridgeB = await connectFakeBridge(harness.port, (request) => {
      received.push(`${request.method}:${request.params.notebook_uri}:win_b`);
      return { windowId: "win_b", notebookUri: request.params.notebook_uri };
    }, { windowId: "win_b", notebookUri: "file:///tmp/b.ipynb" });
    cleanup.push(() => bridgeA.close(), () => bridgeB.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 2);
    const clientA = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "client-a");
    const clientB = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "client-b");
    cleanup.push(() => clientA.close(), () => clientB.close());

    const resultA = await clientA.callTool({ name: "notebook_read", arguments: { notebook_uri: "file:///tmp/a.ipynb", response_format: "json" } });
    const resultB = await clientB.callTool({ name: "notebook_read", arguments: { notebook_uri: "file:///tmp/b.ipynb", response_format: "json" } });

    expect(JSON.parse(textContent(resultA))).toEqual({ windowId: "win_a", notebookUri: "file:///tmp/a.ipynb" });
    expect(JSON.parse(textContent(resultB))).toEqual({ windowId: "win_b", notebookUri: "file:///tmp/b.ipynb" });
    expect(received).toEqual([
      "notebook/read:file:///tmp/a.ipynb:win_a",
      "notebook/read:file:///tmp/b.ipynb:win_b"
    ]);
  });

  it("keeps a ping/pong responsive bridge fresh during stale pruning", async () => {
    let now = 0;
    const harness = await startHarness({ now: () => now, heartbeatIntervalMs: 10, staleWindowMs: 100 });
    const bridge = await connectFakeBridge(harness.port, () => ({ ok: true }), {
      windowId: "win_ping",
      notebookUri: "file:///tmp/ping.ipynb"
    });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    now = 50;
    await waitFor(async () => harness.registry.getWindow("win_ping")?.lastSeenAt === 50);

    now = 140;
    expect(harness.bridge.pruneStaleWindows(100)).toEqual([]);
    expect(harness.registry.windowCount).toBe(1);
  });

  it("fails pending and future explicit global calls when a stale bridge is pruned without replacement", async () => {
    let now = 0;
    let resolveRequestSeen: () => void = () => {};
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequestSeen = resolve;
    });
    const harness = await startHarness({ now: () => now, heartbeatIntervalMs: 0 });
    const bridge = await connectFakeBridge(harness.port, () => {
      resolveRequestSeen();
      return new Promise(() => undefined);
    });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const client = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "stale-backend-client");
    cleanup.push(() => client.close());

    const pendingCall = client.callTool({
      name: "notebook_read",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        response_format: "json"
      }
    });
    await requestSeen;

    now = 100;
    expect(harness.bridge.pruneStaleWindows(50)).toEqual(["win_fake"]);
    expect(harness.bridge.bridgeCount).toBe(0);

    const failedPending = await pendingCall;
    expect(failedPending.isError).toBe(true);
    expect(textContent(failedPending)).toContain("Bridge became stale for window win_fake");

    const failedFuture = await client.callTool({
      name: "notebook_read",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        response_format: "json"
      }
    });
    expect(failedFuture.isError).toBe(true);
    expect(textContent(failedFuture)).toContain("Notebook is not registered");
  });

  it("rejects direct pending bridge RPCs as backend unavailable when their window is pruned", async () => {
    let now = 0;
    let resolveRequestSeen: () => void = () => {};
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequestSeen = resolve;
    });
    const harness = await startHarness({ now: () => now, heartbeatIntervalMs: 0 });
    const bridge = await connectFakeBridge(harness.port, () => {
      resolveRequestSeen();
      return new Promise(() => undefined);
    });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const pendingRequest = harness.bridge.sendRequest("win_fake", "notebook/read", {
      notebook_uri: "file:///tmp/a.ipynb"
    });
    await requestSeen;

    now = 100;
    expect(harness.bridge.pruneStaleWindows(50)).toEqual(["win_fake"]);
    expect(harness.bridge.bridgeCount).toBe(0);

    const error = await pendingRequest.then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(NotebookMcpError);
    expect((error as NotebookMcpError).code).toBe(ErrorCode.BackendUnavailable);
  });

  it("marks active execution operations backend_lost when the bridge disconnects", async () => {
    const harness = await startHarness();
    const bridge = await connectFakeBridge(harness.port, () => new Promise(() => undefined));
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const client = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "backend-loss-client");
    cleanup.push(() => client.close());

    const started = await client.callTool({
      name: "notebook_run",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        scope: "cell",
        index: 0,
        wait_ms: 0,
        response_format: "json"
      }
    });
    const operationId = JSON.parse(textContent(started)).operation.id;

    bridge.close();

    await waitFor(async () => harness.executions.get(operationId).status === "backend_lost");
    expect(harness.executions.get(operationId).error).toBe("Bridge worker disconnected before execution completed.");
  });

  it("routes every core notebook tool through the explicit notebook_uri target", async () => {
    const harness = await startHarness();
    const received: Array<{ method: string; notebookUri: string }> = [];
    const bridge = await connectFakeBridge(harness.port, (request) => {
      received.push({
        method: request.method,
        notebookUri: request.params.notebook_uri
      });
      if (request.method === "notebook/runCell") {
        return {
          success: true,
          executionOrder: 9,
          outputs: [{ type: "text", text: "ran" }]
        };
      }
      if (request.method === "notebook/getExecutionSnapshot") {
        return {
          executionOrder: 9,
          outputs: [{ type: "text", text: "live spark progress", stream: "stdout" }]
        };
      }
      return {
        method: request.method,
        notebookUri: request.params.notebook_uri
      };
    }, { notebookUri: "file:///tmp/parity.ipynb" });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const client = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "parity-client");
    cleanup.push(() => client.close());

    const calls = [
      ["notebook_read", { notebook_uri: "file:///tmp/parity.ipynb", response_format: "json" }],
      ["notebook_search", { notebook_uri: "file:///tmp/parity.ipynb", query: "x", response_format: "json" }],
      ["notebook_get_kernel_info", { notebook_uri: "file:///tmp/parity.ipynb", response_format: "json" }],
      ["notebook_edit_cells", { notebook_uri: "file:///tmp/parity.ipynb", operations: [{ op: "insert", cells: [{ content: "x = 1", type: "code" }] }], response_format: "json" }],
      ["notebook_edit_cells", { notebook_uri: "file:///tmp/parity.ipynb", operations: [{ op: "update", index: 0, content: "x = 2" }], response_format: "json" }],
      ["notebook_edit_cells", { notebook_uri: "file:///tmp/parity.ipynb", operations: [{ op: "delete", index: 0 }], response_format: "json" }],
      ["notebook_move_cells", { notebook_uri: "file:///tmp/parity.ipynb", indexes: [0], to_index: 1, response_format: "json" }],
      ["notebook_clear_outputs", { notebook_uri: "file:///tmp/parity.ipynb", scope: "cell", index: 0, response_format: "json" }],
      ["notebook_clear_outputs", { notebook_uri: "file:///tmp/parity.ipynb", scope: "notebook", response_format: "json" }],
      ["notebook_run", { notebook_uri: "file:///tmp/parity.ipynb", scope: "cell", index: 0, wait_ms: 1000, response_format: "json" }]
    ] as const;

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(textContent(result)).not.toContain("Error:");
    }

    expect(received).toEqual([
      "notebook/read",
      "notebook/search",
      "notebook/kernelInfo",
      "notebook/editCells",
      "notebook/editCells",
      "notebook/editCells",
      "notebook/moveCells",
      "notebook/clearOutputs",
      "notebook/clearOutputs",
      "notebook/runCell"
    ].map((method) => ({ method, notebookUri: "file:///tmp/parity.ipynb" })));
  });

  it("polls live outputs for a running execution operation", async () => {
    const harness = await startHarness();
    const bridge = await connectFakeBridge(harness.port, async (request) => {
      if (request.method === "notebook/runCell") {
        await new Promise(() => undefined);
      }
      if (request.method === "notebook/getExecutionSnapshot") {
        return {
          executionOrder: 11,
          outputs: [{ type: "text", text: "stage 12 running", stream: "stderr" }]
        };
      }
      return { ok: true };
    });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const client = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "stream-client");
    cleanup.push(() => client.close());

    const started = await client.callTool({
      name: "notebook_run",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        scope: "cell",
        index: 0,
        wait_ms: 0,
        response_format: "json"
      }
    });
    const operationId = JSON.parse(textContent(started)).operation.id;

    const streamed = await client.callTool({
      name: "notebook_operation",
      arguments: {
        operation_id: operationId,
        wait_ms: 0,
        include_partial: true,
        response_format: "json"
      }
    });

    expect(JSON.parse(textContent(streamed))).toMatchObject({
      streaming: true,
      outputCount: 1,
      operation: {
        id: operationId,
        status: "running",
        executionOrder: 11,
        outputs: [{ type: "text", text: "stage 12 running", stream: "stderr" }]
      }
    });
  });

  it("returns a retained running operation when notebook_run times out before the cell finishes", async () => {
    const harness = await startHarness();
    const bridge = await connectFakeBridge(harness.port, async (request) => {
      if (request.method === "notebook/runCell") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          success: true,
          executionOrder: 4,
          outputs: [{ type: "text", text: "late output" }]
        };
      }
      return { ok: true };
    });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const client = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "timeout-client");
    cleanup.push(() => client.close());

    const result = await client.callTool({
      name: "notebook_run",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        scope: "cell",
        index: 0,
        wait_ms: 1,
        response_format: "json"
      }
    });
    const operation = JSON.parse(textContent(result)).operation;

    expect(operation).toMatchObject({
      status: "running",
      notebookUri: "file:///tmp/a.ipynb",
      cellIndex: 0
    });
    expect(harness.executions.get(operation.id).status).toBe("running");

    const waited = await client.callTool({
      name: "notebook_operation",
      arguments: {
        operation_id: operation.id,
        wait_ms: 1000,
        response_format: "json"
      }
    });

    expect(JSON.parse(textContent(waited)).operation).toMatchObject({
      id: operation.id,
      status: "succeeded",
      executionOrder: 4,
      outputs: [{ type: "text", text: "late output" }]
    });
  });

  it("does not mark an execution cancelled unless the bridge acknowledges cancellation", async () => {
    const harness = await startHarness();
    const bridge = await connectFakeBridge(harness.port, (request) => {
      if (request.method === "notebook/runCell") {
        return new Promise(() => undefined);
      }
      if (request.method === "notebook/cancelExecution") {
        return {
          cancelled: false,
          note: "kernel declined cancellation"
        };
      }
      return { ok: true };
    });
    cleanup.push(() => bridge.close());

    await waitFor(async () => (await getJson<any>(harness.port, "/status")).bridgeCount === 1);
    const client = await connectMcpClient(formatMcpUrl(harness.port, "test-token"), "cancel-unack-client");
    cleanup.push(() => client.close());

    const started = await client.callTool({
      name: "notebook_run",
      arguments: {
        notebook_uri: "file:///tmp/a.ipynb",
        scope: "cell",
        index: 0,
        wait_ms: 0,
        response_format: "json"
      }
    });
    const operation = JSON.parse(textContent(started)).operation;

    const cancelled = await client.callTool({
      name: "notebook_cancel_execution",
      arguments: {
        operation_id: operation.id,
        response_format: "json"
      }
    });

    expect(cancelled.isError).toBe(true);
    expect(textContent(cancelled)).toContain("kernel declined cancellation");
    expect(harness.executions.get(operation.id).status).toBe("running");
  });
});

type FakeBridgeHandler = (request: any) => unknown | Promise<unknown>;
interface FakeBridgeOptions {
  windowId?: string;
  notebookUri?: string;
}

interface HarnessOptions {
  now?: () => number;
  heartbeatIntervalMs?: number;
  staleWindowMs?: number;
}

async function connectFakeBridge(port: number, handler: FakeBridgeHandler, options: FakeBridgeOptions = {}): Promise<WebSocket> {
  const windowId = options.windowId ?? "win_fake";
  const notebookUri = options.notebookUri ?? "file:///tmp/a.ipynb";
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=test-token`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") {
      return;
    }

    void Promise.resolve().then(() => {
      if (message.request.method === "notebook/resolveCell") {
        return { index: Number(message.request.params.index ?? 0) };
      }
      return handler(message.request);
    }).then((result) => {
      socket.send(JSON.stringify({
        type: "response",
        response: {
          id: message.request.id,
          ok: true,
          result
        }
      }));
    }).catch((error) => {
      socket.send(JSON.stringify({
        type: "response",
        response: {
          id: message.request.id,
          ok: false,
          error: {
            code: "internal",
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }));
    });
  });

  socket.send(JSON.stringify({
    type: "register",
    registration: {
      windowId,
      bridgeVersion: "0.1.0",
      extensionVersion: "0.3.0",
      pid: process.pid,
      workspaceFolders: ["/tmp/workspace"],
      notebooks: [fakeNotebook(notebookUri)]
    }
  }));

  return socket;
}

function sendFakeHeartbeat(socket: WebSocket, windowId: string, notebookUri: string): void {
  socket.send(JSON.stringify({
    type: "heartbeat",
    windowId,
    notebooks: [fakeNotebook(notebookUri)]
  }));
}

function fakeNotebook(notebookUri: string) {
  return {
    uri: notebookUri,
    fileName: notebookUri.split("/").pop() ?? "notebook.ipynb",
    notebookType: "jupyter-notebook",
    cellCount: 1,
    visible: true,
    active: false,
    dirty: false,
    language: "python"
  };
}

async function connectMcpClient(url: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function startHarness(options: HarnessOptions = {}): Promise<{
  port: number;
  registry: DaemonRegistry;
  executions: ExecutionStore;
  bridge: BridgeServer;
}> {
  const port = await freePort();
  const registry = new DaemonRegistry(options.now);
  const executions = new ExecutionStore();
  const bridge = new BridgeServer(registry, {
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    staleWindowMs: options.staleWindowMs,
    onDisconnect: (windowId) => {
      executions.markBackendLost(windowId);
    }
  });
  const router = new NotebookRouter(registry, bridge);
  let daemon: DaemonHttpServer;
  const mcp = new DaemonMcpHandler({
    port,
    registry,
      router,
    executions,
    status: () => daemon.status()
  });

  daemon = new DaemonHttpServer({
    port,
    shutdownToken: "test-token",
    stats: () => ({
      windowCount: registry.windowCount,
      sessionCount: 0,
      bridgeCount: bridge.bridgeCount,
      executionCount: executions.executionCount
    }),
    onServerCreated: (server) => bridge.attach(server),
    mcpHandler: (req, res) => mcp.handle(req, res)
  });

  await daemon.start();
  cleanup.push(async () => {
    mcp.close();
    await bridge.close();
    await daemon.stop();
  });

  return { port, registry, executions, bridge };
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0].type === "text" ? content[0].text ?? "" : "";
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function getJson<T>(port: number, path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return await response.json() as T;
}

async function postJson<T>(port: number, path: string, body: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-notebook-mcp-token": "test-token"
    },
    body: JSON.stringify(body)
  });
  return await response.json() as T;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}
