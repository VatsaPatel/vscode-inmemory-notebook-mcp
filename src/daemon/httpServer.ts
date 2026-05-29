import * as http from "http";

import { DaemonHealth, DaemonStatus } from "../common/types.js";
import {
  AUTH_TOKEN_HEADER,
  DAEMON_SERVER_NAME,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  EXTENSION_VERSION,
  HEALTH_PATH,
  MCP_PATH,
  SHUTDOWN_PATH,
  SHUTDOWN_TOKEN_HEADER,
  STATUS_PATH
} from "../common/protocol.js";
import { ErrorCode, NotebookMcpError, serializeError } from "../common/errors.js";
import { createLogger, Logger } from "../common/logger.js";
import { DaemonLifecycle } from "./lifecycle.js";
import { allowedCorsOrigin, isAllowedRequestOrigin, isAuthorizedShutdownToken, isSafeLocalHostHeader } from "./auth.js";

const MAX_HTTP_BODY_BYTES = 1_000_000;

export interface DaemonHttpServerOptions {
  port?: number;
  shutdownToken: string;
  lifecycle?: DaemonLifecycle;
  logger?: Logger;
  stats?: () => {
    windowCount: number;
    bridgeCount: number;
    executionCount: number;
  };
  onServerCreated?: (server: http.Server) => void;
  mcpHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  onShutdown?: () => void | Promise<void>;
}

export class DaemonHttpServer {
  private readonly portValue: number;
  private readonly lifecycle: DaemonLifecycle;
  private readonly logger: Logger;
  private server?: http.Server;

  constructor(private readonly options: DaemonHttpServerOptions) {
    this.portValue = options.port ?? DEFAULT_DAEMON_PORT;
    this.lifecycle = options.lifecycle ?? new DaemonLifecycle();
    this.logger = options.logger ?? createLogger("daemon:http");
  }

  get port(): number {
    return this.portValue;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.options.onServerCreated?.(this.server);

      this.server.once("error", reject);
      this.server.listen(this.portValue, DEFAULT_DAEMON_HOST, () => {
        this.server?.off("error", reject);
        this.logger.info("daemon listening", { port: this.portValue });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  health(): DaemonHealth {
    const stats = this.options.stats?.() ?? {
      windowCount: 0,
      bridgeCount: 0,
      executionCount: 0
    };

    return {
      status: "ok",
      server: DAEMON_SERVER_NAME,
      version: EXTENSION_VERSION,
      pid: process.pid,
      uptimeMs: this.lifecycle.uptimeMs,
      windowCount: stats.windowCount
    };
  }

  status(): DaemonStatus {
    const stats = this.options.stats?.() ?? {
      windowCount: 0,
      bridgeCount: 0,
      executionCount: 0
    };

    return {
      ...this.health(),
      port: this.portValue,
      startedAt: this.lifecycle.startedAt,
      bridgeCount: stats.bridgeCount,
      executionCount: stats.executionCount
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      this.setCommonHeaders(res);
      const url = new URL(req.url ?? "/", `http://${DEFAULT_DAEMON_HOST}:${this.portValue}`);

      if (!this.isSafeHost(req)) {
        this.sendJson(res, 403, { error: { code: ErrorCode.Unauthorized, message: "Invalid host header." } });
        return;
      }

      if (!this.isAllowedOrigin(req)) {
        this.sendJson(res, 403, { error: { code: ErrorCode.Unauthorized, message: "Invalid request origin." } });
        return;
      }
      this.setCorsOrigin(req, res);

      if (req.method === "OPTIONS") {
        this.sendJson(res, 204, {});
        return;
      }

      if (req.method === "GET" && url.pathname === HEALTH_PATH) {
        this.sendJson(res, 200, this.health());
        return;
      }

      if (req.method === "GET" && url.pathname === STATUS_PATH) {
        this.sendJson(res, 200, this.status());
        return;
      }

      if (req.method === "POST" && url.pathname === SHUTDOWN_PATH) {
        await this.handleShutdown(req, res);
        return;
      }

      if (url.pathname === MCP_PATH) {
        if (!this.isAuthorized(req, url)) {
          this.sendJson(res, 401, { error: { code: ErrorCode.Unauthorized, message: "Missing or invalid daemon token." } });
          return;
        }

        if (this.options.mcpHandler) {
          await this.options.mcpHandler(req, res);
        } else {
          this.sendJson(res, 501, {
            error: {
              code: ErrorCode.InvalidRequest,
              message: "Daemon MCP endpoint is not wired yet."
            }
          });
        }
        return;
      }

      this.sendJson(res, 404, {
        error: {
          code: ErrorCode.InvalidRequest,
          message: "Not found"
        }
      });
    } catch (error) {
      this.logger.error("request failed", serializeError(error));
      this.sendJson(res, this.statusCodeForError(error), { error: serializeError(error) });
    }
  }

  private async handleShutdown(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${DEFAULT_DAEMON_HOST}:${this.portValue}`);
    const token = this.tokenFromRequest(req, url);

    if (!isAuthorizedShutdownToken(this.options.shutdownToken, token)) {
      this.sendJson(res, 401, {
        error: {
          code: ErrorCode.Unauthorized,
          message: "Invalid shutdown token."
        }
      });
      return;
    }

    this.sendJson(res, 200, { shuttingDown: true });
    req.socket.end();

    setImmediate(() => {
      void (async () => {
        await this.options.onShutdown?.();
        await this.stop();
      })();
    });
  }

  private setCommonHeaders(res: http.ServerResponse): void {
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${SHUTDOWN_TOKEN_HEADER}, ${AUTH_TOKEN_HEADER}`);
  }

  private setCorsOrigin(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = allowedCorsOrigin(req.headers.origin);
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  }

  private isSafeHost(req: http.IncomingMessage): boolean {
    return isSafeLocalHostHeader(req.headers.host);
  }

  private isAllowedOrigin(req: http.IncomingMessage): boolean {
    return isAllowedRequestOrigin(req.headers.origin);
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    return isAuthorizedShutdownToken(this.options.shutdownToken, this.tokenFromRequest(req, url));
  }

  private tokenFromRequest(req: http.IncomingMessage, url: URL): string | undefined {
    return (req.headers[AUTH_TOKEN_HEADER] as string | undefined)
      ?? (req.headers[SHUTDOWN_TOKEN_HEADER] as string | undefined)
      ?? url.searchParams.get("token")
      ?? undefined;
  }

  private async readJson<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_HTTP_BODY_BYTES) {
        throw new NotebookMcpError(ErrorCode.InvalidRequest, "Request body is too large.", { maxBytes: MAX_HTTP_BODY_BYTES });
      }
      chunks.push(buffer);
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new NotebookMcpError(ErrorCode.InvalidRequest, "Request body must be valid JSON.");
    }
  }

  private statusCodeForError(error: unknown): number {
    if (error instanceof NotebookMcpError) {
      if (error.code === ErrorCode.InvalidRequest) {
        return 400;
      }
      if (error.code === ErrorCode.Unauthorized) {
        return 401;
      }
    }
    return 500;
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    if (res.headersSent) {
      return;
    }

    res.writeHead(statusCode, { "Content-Type": "application/json" });

    if (statusCode === 204) {
      res.end();
      return;
    }

    res.end(JSON.stringify(body));
  }
}
