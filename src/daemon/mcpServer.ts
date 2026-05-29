import * as http from "http";

import { EXTENSION_VERSION } from "../common/protocol.js";
import { ToolContext } from "../common/types.js";
import { DaemonStatus } from "../common/types.js";
import { NotebookRouter } from "./router.js";
import { DaemonRegistry } from "./registry.js";
import { ExecutionStore } from "./executions.js";
import { registerUtilityTools } from "../mcp/tools/utility.js";
import { registerNotebookTools } from "../mcp/tools/notebooks.js";
import { registerExecutionTools } from "../mcp/tools/executions.js";
import { NotebookMcpServer } from "../mcp/server.js";

export interface DaemonToolDependencies {
  port: number;
  context: ToolContext;
  registry: DaemonRegistry;
  router: NotebookRouter;
  executions: ExecutionStore;
  status: () => DaemonStatus;
  token?: string;
}

interface TransportRecord {
  context: ToolContext;
}

export interface DaemonMcpHandlerOptions {
  port: number;
  registry: DaemonRegistry;
  router: NotebookRouter;
  executions: ExecutionStore;
  status: () => DaemonStatus;
  token?: string;
}

export class DaemonMcpHandler {
  private readonly transports = new Map<string, TransportRecord>();

  constructor(private readonly options: DaemonMcpHandlerOptions) {}

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const transportSessionId = req.headers["mcp-session-id"] as string | undefined;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const context: ToolContext = {
      notebookUri: url.searchParams.get("notebook_uri") ?? undefined
    };

    if (transportSessionId && this.transports.has(transportSessionId)) {
      const record = this.transports.get(transportSessionId)!;
      if (!sameContext(record.context, context)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP transport was initialized for a different notebook target." }));
        return;
      }
      await this.handleJsonRpc(req, res, transportSessionId, context);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing MCP transport session ID" }));
      return;
    }

    const initializedSessionId = cryptoRandomId();
    this.transports.set(initializedSessionId, { context });
    await this.handleJsonRpc(req, res, initializedSessionId, context);
  }

  close(): void {
    this.transports.clear();
  }

  private async handleJsonRpc(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, context: ToolContext): Promise<void> {
    const body = await readJsonBody(req);
    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    const server = this.createServer(context);

    for (const request of requests) {
      const response = await this.handleJsonRpcRequest(server, request);
      if (response) {
        responses.push(response);
      }
    }

    res.setHeader("mcp-session-id", sessionId);
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
  }

  private createServer(context: ToolContext): NotebookMcpServer {
    const server = new NotebookMcpServer();
    const deps: DaemonToolDependencies = {
      port: this.options.port,
      context,
      registry: this.options.registry,
      router: this.options.router,
      executions: this.options.executions,
      status: this.options.status,
      token: this.options.token
    };

    registerUtilityTools(server, deps);
    registerNotebookTools(server, deps);
    registerExecutionTools(server, deps);
    return server;
  }

  private async handleJsonRpcRequest(server: NotebookMcpServer, request: any): Promise<Record<string, unknown> | undefined> {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return jsonRpcError(request?.id ?? null, -32600, "Invalid Request");
    }

    if (request.id === undefined || request.id === null) {
      return undefined;
    }

    try {
      if (request.method === "initialize") {
        return jsonRpcResult(request.id, {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "notebook-mcp-for-vscode-daemon",
            version: EXTENSION_VERSION
          }
        });
      }

      if (request.method === "ping") {
        return jsonRpcResult(request.id, {});
      }

      if (request.method === "tools/list") {
        return jsonRpcResult(request.id, {
          tools: server.listTools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        });
      }

      if (request.method === "tools/call") {
        const params = request.params ?? {};
        const result = await server.callTool(params.name, params.arguments ?? {});
        return jsonRpcResult(request.id, result);
      }

      return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      return jsonRpcError(request.id, -32603, error instanceof Error ? error.message : String(error));
    }
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sameContext(left: ToolContext, right: ToolContext): boolean {
  return left.notebookUri === right.notebookUri;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}
