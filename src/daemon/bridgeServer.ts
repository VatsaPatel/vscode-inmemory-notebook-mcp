import * as http from "http";
import { WebSocket, WebSocketServer } from "ws";

import { ErrorCode, NotebookMcpError, serializeError } from "../common/errors.js";
import { createRpcId } from "../common/ids.js";
import { createLogger, Logger } from "../common/logger.js";
import { AUTH_TOKEN_HEADER, BRIDGE_PATH, SHUTDOWN_TOKEN_HEADER } from "../common/protocol.js";
import {
  BridgeClientMessage,
  BridgeDaemonMessage,
  BridgeRequest,
  BridgeResponse,
  BridgeWindowRegistration
} from "../common/types.js";
import { DaemonRegistry } from "./registry.js";
import { isAllowedRequestOrigin, isAuthorizedShutdownToken, isSafeLocalHostHeader } from "./auth.js";

interface PendingRequest {
  windowId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface BridgeServerOptions {
  logger?: Logger;
  authToken?: string;
  onConnect?: (windowId: string) => void;
  onDisconnect?: (windowId: string) => void;
  heartbeatIntervalMs?: number;
  staleWindowMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALE_WINDOW_MS = 30_000;
const MAX_WS_PAYLOAD_BYTES = 1_000_000;

export class BridgeServer {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly logger: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly staleWindowMs: number;
  private wsServer?: WebSocketServer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private onDisconnect?: (windowId: string) => void;
  private onConnect?: (windowId: string) => void;
  private authToken?: string;

  constructor(
    private readonly registry: DaemonRegistry,
    options: BridgeServerOptions = {}
  ) {
    this.logger = options.logger ?? createLogger("daemon:bridge");
    this.authToken = options.authToken;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleWindowMs = options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;
  }

  attach(httpServer: http.Server): void {
    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_PAYLOAD_BYTES
    });

    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== BRIDGE_PATH) {
        return;
      }

      if (!this.isSafeHost(request) || !this.isAllowedOrigin(request) || !this.isAuthorized(request, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wsServer!.handleUpgrade(request, socket, head, (ws) => {
        this.wsServer!.emit("connection", ws, request);
      });
    });

    this.wsServer.on("connection", (socket) => {
      this.handleConnection(socket);
    });

    this.startHeartbeat();
  }

  async close(): Promise<void> {
    this.stopHeartbeat();

    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new NotebookMcpError(ErrorCode.BackendUnavailable, `Bridge request was cancelled: ${id}`));
    }
    this.pending.clear();

    await new Promise<void>((resolve) => {
      this.wsServer?.close(() => resolve());
      if (!this.wsServer) {
        resolve();
      }
    });
    this.wsServer = undefined;
  }

  async sendRequest<TResult>(
    windowId: string,
    method: string,
    params: unknown,
    timeoutMs = 60_000
  ): Promise<TResult> {
    const socket = this.sockets.get(windowId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new NotebookMcpError(ErrorCode.BackendUnavailable, `Bridge is not connected for window ${windowId}`);
    }

    const id = createRpcId();
    const request: BridgeRequest = {
      id,
      method,
      params,
      deadlineAt: Date.now() + timeoutMs
    };

    const result = await new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new NotebookMcpError(ErrorCode.BridgeTimeout, `Bridge request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        windowId,
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout
      });

      this.send(socket, {
        type: "request",
        request
      });
    });

    return result;
  }

  get bridgeCount(): number {
    return this.sockets.size;
  }

  pruneStaleWindows(staleWindowMs = this.staleWindowMs): string[] {
    const staleWindowIds = this.registry.pruneStaleWindows(staleWindowMs);

    for (const windowId of staleWindowIds) {
      this.rejectPendingForWindow(
        windowId,
        new NotebookMcpError(ErrorCode.BackendUnavailable, `Bridge became stale for window ${windowId}`)
      );
      const socket = this.sockets.get(windowId);
      this.sockets.delete(windowId);
      socket?.terminate();
      this.logger.warn("bridge pruned as stale", { windowId });
      this.onDisconnect?.(windowId);
    }

    return staleWindowIds;
  }

  private handleConnection(socket: WebSocket): void {
    let windowId: string | undefined;

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as BridgeClientMessage;

        if (message.type === "register") {
          windowId = this.registerSocket(socket, message.registration);
        } else if (message.type === "heartbeat") {
          if (this.sockets.get(message.windowId) === socket) {
            this.registry.updateNotebooks(message.windowId, message.notebooks);
          }
        } else if (message.type === "response") {
          this.handleResponse(message.response);
        }
      } catch (error) {
        this.logger.warn("invalid bridge message", serializeError(error));
      }
    });

    socket.on("pong", () => {
      if (windowId && this.sockets.get(windowId) === socket) {
        this.registry.touchWindow(windowId);
      }
    });

    socket.on("close", () => {
      if (!windowId) {
        return;
      }

      if (this.sockets.get(windowId) !== socket) {
        return;
      }

      this.disconnectWindow(windowId, new NotebookMcpError(ErrorCode.BackendUnavailable, `Bridge disconnected for window ${windowId}`));
    });
  }

  private registerSocket(socket: WebSocket, registration: BridgeWindowRegistration): string {
    const existing = this.sockets.get(registration.windowId);
    if (existing && existing !== socket) {
      this.rejectPendingForWindow(registration.windowId, new NotebookMcpError(ErrorCode.BackendUnavailable, `Bridge reconnected for window ${registration.windowId}`));
      existing.close();
    }

    this.registry.registerWindow(registration);
    this.sockets.set(registration.windowId, socket);
    this.logger.info("bridge registered", { windowId: registration.windowId, notebooks: registration.notebooks.length });
    this.onConnect?.(registration.windowId);
    return registration.windowId;
  }

  private handleResponse(response: BridgeResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    const code = (response.error?.code as ErrorCode | undefined) ?? ErrorCode.Internal;
    pending.reject(new NotebookMcpError(code, response.error?.message ?? "Bridge request failed", response.error?.details));
  }

  private send(socket: WebSocket, message: BridgeDaemonMessage): void {
    socket.send(JSON.stringify(message));
  }

  private disconnectWindow(windowId: string, error: Error): void {
    this.rejectPendingForWindow(windowId, error);
    this.sockets.delete(windowId);
    this.registry.markDisconnected(windowId);
    this.onDisconnect?.(windowId);
  }

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) {
      return;
    }

    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.pingSockets();
      this.pruneStaleWindows();
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private pingSockets(): void {
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }
  }

  private rejectPendingForWindow(windowId: string, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.windowId !== windowId) {
        continue;
      }
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private isSafeHost(req: http.IncomingMessage): boolean {
    return isSafeLocalHostHeader(req.headers.host);
  }

  private isAllowedOrigin(req: http.IncomingMessage): boolean {
    return isAllowedRequestOrigin(req.headers.origin);
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    if (!this.authToken) {
      return true;
    }
    const token = (req.headers[AUTH_TOKEN_HEADER] as string | undefined)
      ?? (req.headers[SHUTDOWN_TOKEN_HEADER] as string | undefined)
      ?? url.searchParams.get("token")
      ?? undefined;
    return isAuthorizedShutdownToken(this.authToken, token);
  }
}
