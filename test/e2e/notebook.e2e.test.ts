import * as assert from "assert";
import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface DaemonStatus {
  status: "ok";
  pid: number;
  startedAt: number;
  bridgeCount: number;
  windowCount: number;
  sessionCount: number;
}

suite("Notebook MCP daemon E2E", () => {
  let port = 0;
  let notebookA: vscode.NotebookDocument;
  let notebookB: vscode.NotebookDocument;
  let client: Client | undefined;
  let controller: vscode.NotebookController | undefined;
  let executionOrder = 0;
  let e2eHome: string | undefined;

  suiteSetup(async function () {
    this.timeout(120000);

    e2eHome = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-mcp-e2e-home-"));
    process.env.NOTEBOOK_MCP_FOR_VSCODE_HOME = e2eHome;
    port = await findFreePort();
    await vscode.workspace.getConfiguration("notebook-mcp-for-vscode").update("port", port, vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension("vatsapatel.notebook-mcp-for-vscode");
    assert.ok(ext, "Extension should be present");
    if (!ext.isActive) {
      await ext.activate();
    }

    notebookA = await createNotebook("print('a')\n");
    await vscode.window.showNotebookDocument(notebookA);
    notebookB = await createNotebook("print('b')\n");
    await vscode.window.showNotebookDocument(notebookB, { preserveFocus: false });
    controller = createTestController();
    controller.updateNotebookAffinity(notebookA, vscode.NotebookControllerAffinity.Preferred);
    controller.updateNotebookAffinity(notebookB, vscode.NotebookControllerAffinity.Preferred);

    await waitFor(async () => {
      const status = await getJson<DaemonStatus>("/status").catch(() => undefined);
      return status?.status === "ok" && status.bridgeCount >= 1;
    }, "daemon bridge registration");
  });

  teardown(async () => {
    await client?.close();
    client = undefined;
  });

  suiteTeardown(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    controller?.dispose();
    let stopped = port === 0;
    if (port !== 0) {
      await shutdownDaemon().catch(() => undefined);
      stopped = await waitForDaemonStopped().then(() => true).catch(() => false);
    }
    if (stopped && e2eHome) {
      await fs.rm(e2eHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("daemon reports a connected bridge", async () => {
    const status = await getJson<DaemonStatus>("/status");
    assert.strictEqual(status.status, "ok");
    assert.ok(status.bridgeCount >= 1, "daemon should have at least one bridge");
    assert.ok(status.windowCount >= 1, "daemon should have at least one registered window");
  });

  test("global endpoint routes reads with explicit notebook_uri", async function () {
    this.timeout(120000);

    client = await connectClient(await daemonMcpUrl());

    const result = await client.callTool({
      name: "notebook_read",
      arguments: {
        notebook_uri: notebookA.uri.toString(),
        response_format: "json"
      }
    });

    const data = JSON.parse(textContent(result));
    assert.strictEqual(data.total, notebookA.cellCount);
    assert.strictEqual(data.cells[0].source, "print('a')\n");
  });

  test("global endpoint requires notebook_uri for notebook tools", async function () {
    this.timeout(120000);

    client = await connectClient(await daemonMcpUrl());

    const read = await client.callTool({
      name: "notebook_read",
      arguments: {
        response_format: "json"
      }
    });
    assert.strictEqual((read as { isError?: boolean }).isError, true);
    assert.match(textContent(read), /notebook_uri/i);
  });

  test("copy global MCP URL command includes daemon token", async function () {
    this.timeout(120000);

    await vscode.commands.executeCommand("notebook-mcp-for-vscode.copyMcpUrl");

    const copied = await vscode.env.clipboard.readText();
    assert.match(copied, new RegExp(`^http://127\\.0\\.0\\.1:${port}/mcp\\?token=`));
    assert.ok(copied.endsWith(encodeURIComponent(await daemonToken())));
  });

  test("copy notebook uri command copies active notebook uri", async function () {
    this.timeout(120000);

    await vscode.window.showNotebookDocument(notebookA, { preserveFocus: false });
    await vscode.commands.executeCommand("notebook-mcp-for-vscode.copyNotebookUri");

    const copied = await vscode.env.clipboard.readText();
    assert.strictEqual(copied, notebookA.uri.toString());
  });

  test("global endpoint explicit writes ignore active tab changes", async function () {
    this.timeout(120000);

    const initialA = notebookA.cellCount;
    const initialB = notebookB.cellCount;
    client = await connectClient(await daemonMcpUrl());

    await vscode.window.showNotebookDocument(notebookB, { preserveFocus: false });

    const result = await client.callTool({
      name: "notebook_edit_cells",
      arguments: {
        notebook_uri: notebookA.uri.toString(),
        operations: [{ op: "insert", cells: [{ content: "# inserted through explicit notebook_uri", type: "markdown" }] }],
        response_format: "json"
      }
    });

    const data = JSON.parse(textContent(result));
    assert.strictEqual(data.results[0].inserted_at, initialA);
    assert.strictEqual(notebookA.cellCount, initialA + 1);
    assert.strictEqual(notebookB.cellCount, initialB);

    await deleteNotebookCells(notebookA, initialA, 1);
  });

  test("one global client routes independent writes by notebook_uri", async function () {
    this.timeout(120000);

    const initialA = notebookA.cellCount;
    const initialB = notebookB.cellCount;
    client = await connectClient(await daemonMcpUrl());

    try {
      await vscode.window.showNotebookDocument(notebookB, { preserveFocus: false });

      const markerA = `# explicit notebook A ${Date.now()}`;
      const markerB = `# explicit notebook B ${Date.now()}`;
      const insertedA = jsonContent<{ results: Array<{ inserted_at: number }> }>(await client.callTool({
        name: "notebook_edit_cells",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          operations: [{ op: "insert", cells: [{ content: markerA, type: "markdown" }] }],
          response_format: "json"
        }
      }));
      const insertedB = jsonContent<{ results: Array<{ inserted_at: number }> }>(await client.callTool({
        name: "notebook_edit_cells",
        arguments: {
          notebook_uri: notebookB.uri.toString(),
          operations: [{ op: "insert", cells: [{ content: markerB, type: "markdown" }] }],
          response_format: "json"
        }
      }));

      const indexA = insertedA.results[0].inserted_at;
      const indexB = insertedB.results[0].inserted_at;
      assert.strictEqual(notebookA.cellAt(indexA).document.getText(), markerA);
      assert.strictEqual(notebookB.cellAt(indexB).document.getText(), markerB);

      const readA = jsonContent<{ cells: Array<{ source: string }> }>(await client.callTool({
        name: "notebook_read",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          indexes: [indexA],
          response_format: "json"
        }
      }));
      const readB = jsonContent<{ cells: Array<{ source: string }> }>(await client.callTool({
        name: "notebook_read",
        arguments: {
          notebook_uri: notebookB.uri.toString(),
          indexes: [indexB],
          response_format: "json"
        }
      }));
      assert.strictEqual(readA.cells[0].source, markerA);
      assert.strictEqual(readB.cells[0].source, markerB);
    } finally {
      await deleteNotebookCells(notebookA, initialA, notebookA.cellCount - initialA);
      await deleteNotebookCells(notebookB, initialB, notebookB.cellCount - initialB);
    }
  });

  test("long-running execution can be awaited after MCP reconnect", async function () {
    this.timeout(120000);

    const originalSource = notebookA.cellAt(0).document.getText();
    await editNotebookCell(notebookA, 0, "long_running_test()\n");
    try {
      client = await connectClient(await daemonMcpUrl());

      const started = await client.callTool({
        name: "notebook_run",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          scope: "cell",
          index: 0,
          wait_ms: 0,
          response_format: "json"
        }
      });
      const operationId = JSON.parse(textContent(started)).operation.id;
      await client.close();

      client = await connectClient(await daemonMcpUrl());
      const waited = await client.callTool({
        name: "notebook_operation",
        arguments: {
          operation_id: operationId,
          wait_ms: 5000,
          response_format: "json"
        }
      });

      const operation = JSON.parse(textContent(waited)).operation;
      assert.strictEqual(operation.status, "succeeded");
      assert.strictEqual(operation.outputs[0].text, "long-running complete\n");
    } finally {
      await editNotebookCell(notebookA, 0, originalSource);
    }
  });

  test("long-running execution exposes live output while running", async function () {
    this.timeout(120000);

    const originalSource = notebookA.cellAt(0).document.getText();
    await editNotebookCell(notebookA, 0, "spark_progress_test()\n");
    try {
      client = await connectClient(await daemonMcpUrl());

      const started = await client.callTool({
        name: "notebook_run",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          scope: "cell",
          index: 0,
          wait_ms: 0,
          response_format: "json"
        }
      });
      const operationId = jsonContent<{ operation: { id: string } }>(started).operation.id;

      const streamed = await waitForValue(async () => {
        const result = await client!.callTool({
          name: "notebook_operation",
          arguments: {
            operation_id: operationId,
            wait_ms: 0,
            include_partial: true,
            response_format: "json"
          }
        });
        const data = jsonContent<{ operation: { outputs?: Array<{ text?: string }> } }>(result);
        return data.operation.outputs?.some((output) => output.text?.includes("spark progress")) ? data : undefined;
      }, "live execution output");

      assert.ok(streamed.operation.outputs?.some((output) => output.text?.includes("spark progress")));
    } finally {
      await editNotebookCell(notebookA, 0, originalSource);
    }
  });

  test("global endpoint permits run_code and explicit writes", async function () {
    this.timeout(120000);

    const initialA = notebookA.cellCount;
    client = await connectClient(await daemonMcpUrl());

    const result = await client.callTool({
      name: "notebook_run",
      arguments: {
        notebook_uri: notebookA.uri.toString(),
        scope: "code",
        code: "print('scratch')",
        wait_ms: 5000,
        response_format: "json"
      }
    });
    const data = jsonContent<{ result: { outputs: Array<{ text?: string }>; scratchCellDeleted: boolean } }>(result);
    assert.strictEqual(data.result.scratchCellDeleted, true);
    assert.strictEqual(data.result.outputs[0].text, "long-running complete\n");
    assert.strictEqual(notebookA.cellCount, initialA);
  });

  test("lock_cell blocks agent edits until unlocked", async function () {
    this.timeout(120000);

    const originalSource = notebookA.cellAt(0).document.getText();
    const originalMetadata = { ...notebookA.cellAt(0).metadata };
    client = await connectClient(await daemonMcpUrl());

    try {
      const locked = jsonContent<{ index: number; locked: boolean }>(await client.callTool({
        name: "notebook_lock_cell",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          index: 0,
          locked: true,
          response_format: "json"
        }
      }));
      assert.strictEqual(locked.index, 0);
      assert.strictEqual(locked.locked, true);
      assert.strictEqual(notebookA.cellAt(0).metadata?.notebookMcp?.locked, true);

      const blocked = await client.callTool({
        name: "notebook_edit_cells",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          operations: [{ op: "update", index: 0, content: "# lock should block this edit" }],
          response_format: "json"
        }
      });
      const blockedError = jsonContent<{ error: { message: string } }>(blocked);
      assert.strictEqual((blocked as { isError?: boolean }).isError, true);
      assert.match(blockedError.error.message, /locked for Notebook MCP agent edits/);
      assert.strictEqual(notebookA.cellAt(0).document.getText(), originalSource);

      const unlocked = jsonContent<{ locked: boolean }>(await client.callTool({
        name: "notebook_lock_cell",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          index: 0,
          locked: false,
          response_format: "json"
        }
      }));
      assert.strictEqual(unlocked.locked, false);
    } finally {
      await replaceCellMetadata(notebookA, 0, originalMetadata);
    }
  });

  test("whole-notebook read exposes lock state and metadata when requested", async function () {
    this.timeout(120000);

    const originalCellMetadata = { ...notebookA.cellAt(0).metadata };
    client = await connectClient(await daemonMcpUrl());

    try {
      await client.callTool({
        name: "notebook_lock_cell",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          index: 0,
          locked: true,
          response_format: "json"
        }
      });

      const read = jsonContent<{ cells: Array<{ locked: boolean; metadata?: { notebookMcp?: { locked?: boolean } } }> }>(await client.callTool({
        name: "notebook_read",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          indexes: [0],
          include_metadata: true,
          response_format: "json"
        }
      }));
      assert.strictEqual(read.cells[0].locked, true);
      assert.strictEqual(read.cells[0].metadata?.notebookMcp?.locked, true);
    } finally {
      await replaceCellMetadata(notebookA, 0, originalCellMetadata);
    }
  });

  test("create, open, and save file-backed notebooks", async function () {
    this.timeout(120000);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-mcp-e2e-file-"));
    const notebookPath = path.join(tempDir, "created.ipynb");
    const copyPath = path.join(tempDir, "saved-copy.ipynb");
    client = await connectClient(await daemonMcpUrl());

    const created = jsonContent<{ created: boolean; notebook: { uri: string; cellCount: number } }>(await client.callTool({
      name: "notebook_create",
      arguments: {
        path: notebookPath,
        initial_content: "print('created')\n",
        response_format: "json"
      }
    }));
    assert.strictEqual(created.created, true);
    assert.strictEqual(created.notebook.cellCount, 1);
    assert.strictEqual(created.notebook.uri, vscode.Uri.file(notebookPath).toString());

    const opened = jsonContent<{ opened: boolean; notebook: { uri: string; cellCount: number } }>(await client.callTool({
      name: "notebook_open",
      arguments: {
        path: notebookPath,
        response_format: "json"
      }
    }));
    assert.strictEqual(opened.opened, true);
    assert.strictEqual(opened.notebook.uri, created.notebook.uri);
    assert.strictEqual(opened.notebook.cellCount, 1);

    const marker = `# saved marker ${Date.now()}`;
    jsonContent<{ results: Array<{ inserted_at: number }> }>(await client.callTool({
      name: "notebook_edit_cells",
      arguments: {
        notebook_uri: created.notebook.uri,
        operations: [{ op: "insert", cells: [{ content: marker, type: "markdown" }] }],
        response_format: "json"
      }
    }));

    const saved = jsonContent<{ copiedTo: string }>(await client.callTool({
      name: "notebook_save",
      arguments: {
        notebook_uri: created.notebook.uri,
        path: copyPath,
        response_format: "json"
      }
    }));
    assert.strictEqual(saved.copiedTo, vscode.Uri.file(copyPath).toString());
    assert.match(await fs.readFile(copyPath, "utf8"), /saved marker/);
  });

  test("explicit notebook_uri still works after daemon restart", async function () {
    this.timeout(120000);

    const initialA = notebookA.cellCount;
    client = await connectClient(await daemonMcpUrl());
    await client.close();
    client = undefined;

    await restartDaemonAndWaitForBridge();

    client = await connectClient(await daemonMcpUrl());
    const marker = `# post-restart write ${Date.now()}`;
    try {
      const inserted = jsonContent<{ results: Array<{ inserted_at: number }> }>(await client.callTool({
        name: "notebook_edit_cells",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          operations: [{ op: "insert", cells: [{ content: marker, type: "markdown" }] }],
          response_format: "json"
        }
      }));
      const insertedIndex = inserted.results[0].inserted_at;
      assert.strictEqual(insertedIndex, initialA);

      const readBack = jsonContent<{ cells: Array<{ source: string }> }>(await client.callTool({
        name: "notebook_read",
        arguments: {
          notebook_uri: notebookA.uri.toString(),
          indexes: [insertedIndex],
          response_format: "json"
        }
      }));
      assert.strictEqual(readBack.cells[0].source, marker);
      assert.strictEqual(notebookA.cellAt(insertedIndex).document.getText(), marker);
    } finally {
      await deleteNotebookCells(notebookA, initialA, notebookA.cellCount - initialA);
    }
  });

  test("backend-unavailable notebook recovers when opened and targeted by uri", async function () {
    this.timeout(120000);

    const recoveryUri = await writeNotebookFile("print('recovery')\n");
    const previous = await getJson<DaemonStatus>("/status");
    await shutdownDaemon();
    await waitForRestartedDaemonWithBridge(previous);

    client = await connectClient(await daemonMcpUrl());
    const failedRead = await client.callTool({
      name: "notebook_read",
      arguments: {
        notebook_uri: recoveryUri.toString(),
        response_format: "json"
      }
    });
    assert.strictEqual((failedRead as { isError?: boolean }).isError, true);
    assert.strictEqual(jsonContent<{ error: { code: string } }>(failedRead).error.code, "notebook_not_found");

    const reopened = await vscode.workspace.openNotebookDocument(recoveryUri);
    await vscode.window.showNotebookDocument(reopened, { preserveFocus: false, preview: false });
    controller?.updateNotebookAffinity(reopened, vscode.NotebookControllerAffinity.Preferred);
    await waitFor(async () => {
      const status = await getJson<DaemonStatus>("/status").catch(() => undefined);
      return (status?.bridgeCount ?? 0) >= 1;
    }, "bridge after recovery notebook open");

    const marker = `# recovered write ${Date.now()}`;
    const inserted = jsonContent<{ results: Array<{ inserted_at: number }> }>(await client.callTool({
      name: "notebook_edit_cells",
      arguments: {
        notebook_uri: recoveryUri.toString(),
        operations: [{ op: "insert", cells: [{ content: marker, type: "markdown" }] }],
        response_format: "json"
      }
    }));
    const insertedIndex = inserted.results[0].inserted_at;
    const readBack = jsonContent<{ cells: Array<{ source: string }> }>(await client.callTool({
      name: "notebook_read",
      arguments: {
        notebook_uri: recoveryUri.toString(),
        indexes: [insertedIndex],
        response_format: "json"
      }
    }));
    assert.strictEqual(readBack.cells[0].source, marker);

    await deleteNotebookCells(reopened, insertedIndex, 1);
  });

  test("daemon shutdown is recovered by bridge reconnect", async function () {
    this.timeout(120000);

    await restartDaemonAndWaitForBridge();
  });

  async function createNotebook(source: string): Promise<vscode.NotebookDocument> {
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, "python")
    ]);
    return await vscode.workspace.openNotebookDocument("jupyter-notebook", data);
  }

  async function findFreePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert.ok(address && typeof address !== "string", "Expected TCP server to bind to a local port");
        const selectedPort = address.port;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(selectedPort);
        });
      });
    });
  }

  async function writeNotebookFile(source: string): Promise<vscode.Uri> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-mcp-e2e-"));
    const filePath = path.join(tempDir, "recovery.ipynb");
    await fs.writeFile(filePath, `${JSON.stringify({
      cells: [{
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [source]
      }],
      metadata: {
        kernelspec: {
          display_name: "Python 3",
          language: "python",
          name: "python3"
        },
        language_info: {
          name: "python"
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    }, null, 2)}\n`, "utf8");
    return vscode.Uri.file(filePath);
  }

  function createTestController(): vscode.NotebookController {
    const nextController = vscode.notebooks.createNotebookController(
      "notebook-mcp-for-vscode-e2e-controller",
      "jupyter-notebook",
      "Notebook MCP E2E Controller"
    );
    nextController.supportedLanguages = ["python"];
    nextController.supportsExecutionOrder = true;
    nextController.executeHandler = async (cells) => {
      for (const cell of cells) {
        const execution = nextController.createNotebookCellExecution(cell);
        execution.executionOrder = ++executionOrder;
        execution.start(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 100));
        await execution.appendOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text("spark progress: stage submitted\n")
          ], { outputType: "stdout" })
        ]);
        await new Promise((resolve) => setTimeout(resolve, 650));
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text("long-running complete\n")
          ])
        ]);
        execution.end(true, Date.now());
      }
    };
    return nextController;
  }

  async function editNotebookCell(notebook: vscode.NotebookDocument, index: number, content: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const cell = notebook.cellAt(index);
    edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), content);
    await vscode.workspace.applyEdit(edit);
  }

  async function deleteNotebookCells(notebook: vscode.NotebookDocument, start: number, count: number): Promise<void> {
    if (count <= 0) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(start, start + count))]);
    await vscode.workspace.applyEdit(edit);
  }

  async function replaceCellMetadata(notebook: vscode.NotebookDocument, index: number, metadata: Record<string, unknown>): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(index, metadata)]);
    await vscode.workspace.applyEdit(edit);
  }

  async function replaceNotebookMetadata(notebook: vscode.NotebookDocument, metadata: Record<string, unknown>): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
    await vscode.workspace.applyEdit(edit);
  }

  async function connectClient(url: string): Promise<Client> {
    const deadline = Date.now() + 10000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      const nextClient = new Client({ name: "notebook-mcp-e2e", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(url));
      try {
        await nextClient.connect(transport);
        return nextClient;
      } catch (error) {
        lastError = error;
        await nextClient.close().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.strictEqual(content[0].type, "text");
    return content[0].text ?? "";
  }

  function jsonContent<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
    return JSON.parse(textContent(result)) as T;
  }

  async function getJson<T>(path: string): Promise<T> {
    return await requestJson<T>("GET", path);
  }

  async function shutdownDaemon(): Promise<void> {
    await requestJson("POST", "/shutdown", undefined, {
      "x-notebook-mcp-shutdown-token": await daemonToken()
    });
  }

  async function restartDaemonAndWaitForBridge(): Promise<DaemonStatus> {
    const previous = await getJson<DaemonStatus>("/status");
    await shutdownDaemon();
    return await waitForRestartedDaemonWithBridge(previous);
  }

  async function waitForRestartedDaemonWithBridge(previous: DaemonStatus): Promise<DaemonStatus> {
    return await waitForValue(async () => {
      const status = await getJson<DaemonStatus>("/status").catch(() => undefined);
      if (!status) {
        return undefined;
      }
      const restarted = status.pid !== previous.pid || status.startedAt !== previous.startedAt;
      return restarted && status.bridgeCount >= 1 ? status : undefined;
    }, "daemon restart and bridge re-registration");
  }

  async function waitForDaemonStopped(): Promise<void> {
    await waitFor(async () => {
      return await getJson<DaemonStatus>("/status").then(() => false, () => true);
    }, "daemon shutdown");
  }

  async function daemonToken(): Promise<string> {
    const homeOverride = process.env.NOTEBOOK_MCP_FOR_VSCODE_HOME;
    const tokenPath = homeOverride
      ? path.join(homeOverride, "shutdown.token")
      : path.join(os.homedir(), "Library", "Application Support", "notebook-mcp-for-vscode", "shutdown.token");
    return (await fs.readFile(tokenPath, "utf8")).trim();
  }

  async function daemonMcpUrl(): Promise<string> {
    return `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(await daemonToken())}`;
  }

  async function requestJson<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path,
        method,
        timeout: 2000,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers
        }
      }, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(data));
            return;
          }
          resolve(JSON.parse(data) as T);
        });
      });
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy();
        reject(new Error("HTTP request timed out"));
      });
      if (body) {
        request.write(JSON.stringify(body));
      }
      request.end();
    });
  }

  async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
    await waitForValue(async () => (await predicate()) || undefined, label);
  }

  async function waitForValue<T>(loader: () => Promise<T | undefined>, label: string): Promise<T> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const value = await loader();
      if (value) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
});
