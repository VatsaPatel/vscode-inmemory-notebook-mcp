import * as vscode from "vscode";
import WebSocket from "ws";

import {
  BRIDGE_PATH,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  EXTENSION_VERSION,
  PROTOCOL_VERSION
} from "../common/protocol.js";
import { BridgeDaemonMessage, BridgeWindowRegistration } from "../common/types.js";
import { createWindowId } from "../common/ids.js";
import { handleBridgeRequest } from "./bridgeHandlers.js";
import { listOpenNotebooks } from "./notebookBackend.js";

export class BridgeClient implements vscode.Disposable {
  private readonly windowId = createWindowId();
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly port: number = DEFAULT_DAEMON_PORT,
    private readonly onStateChange: (state: "connecting" | "connected" | "disconnected" | "error") => void = () => {},
    private readonly ensureDaemon: () => Promise<void> = async () => {},
    private readonly getDaemonToken: () => Promise<string> = async () => ""
  ) {}

  connect(): void {
    this.disposed = false;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.refreshRegistration();
      return;
    }
    this.openSocket();
  }

  refreshRegistration(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendRegistration();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private openSocket(): void {
    this.onStateChange("connecting");
    void this.openSocketAsync();
  }

  private async openSocketAsync(): Promise<void> {
    let token: string;
    try {
      token = await this.getDaemonToken();
    } catch {
      this.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(`ws://${DEFAULT_DAEMON_HOST}:${this.port}${BRIDGE_PATH}?token=${encodeURIComponent(token)}`);
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      this.onStateChange("connected");
      this.sendRegistration();
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.sendHeartbeat(), 5000);
    });

    socket.on("message", (data) => {
      if (this.socket !== socket) {
        return;
      }
      void this.handleMessage(data.toString());
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      clearInterval(this.heartbeat);
      if (!this.disposed) {
        this.onStateChange("disconnected");
        this.scheduleReconnect();
      }
    });

    socket.on("error", () => {
      if (this.socket !== socket) {
        return;
      }
      this.onStateChange("error");
    });
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      void this.reconnectAfterDaemonCheck();
    }, 1500);
  }

  private async reconnectAfterDaemonCheck(): Promise<void> {
    try {
      await this.ensureDaemon();
      if (!this.disposed) {
        this.openSocket();
      }
    } catch {
      if (!this.disposed) {
        this.onStateChange("error");
        this.scheduleReconnect();
      }
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = parseDaemonMessage(raw);
    if (!message) {
      console.warn("Notebook MCP bridge ignored malformed daemon message");
      return;
    }

    try {
      const response = await handleBridgeRequest(message.request);
      this.socket?.send(JSON.stringify({
        type: "response",
        response
      }));
    } catch (error) {
      console.warn("Notebook MCP bridge ignored malformed daemon message", error);
    }
  }

  private sendRegistration(): void {
    this.socket?.send(JSON.stringify({
      type: "register",
      registration: this.registration()
    }));
  }

  private sendHeartbeat(): void {
    this.socket?.send(JSON.stringify({
      type: "heartbeat",
      windowId: this.windowId,
      notebooks: listOpenNotebooks()
    }));
  }

  private registration(): BridgeWindowRegistration {
    return {
      windowId: this.windowId,
      bridgeVersion: PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      pid: process.pid,
      workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      notebooks: listOpenNotebooks(),
      allowActiveNotebookWrites: vscode.workspace.getConfiguration("notebook-mcp-for-vscode").get<boolean>("allowActiveNotebookWrites", false)
    };
  }
}

function parseDaemonMessage(raw: string): BridgeDaemonMessage | undefined {
  try {
    const message = JSON.parse(raw) as Partial<BridgeDaemonMessage>;
    if (message.type === "request" && message.request) {
      return message as BridgeDaemonMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
