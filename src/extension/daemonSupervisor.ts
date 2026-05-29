import * as fs from "fs/promises";
import * as http from "http";
import * as vscode from "vscode";

import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  HEALTH_PATH,
  SHUTDOWN_PATH,
  SHUTDOWN_TOKEN_HEADER
} from "../common/protocol.js";
import { DaemonHealth } from "../common/types.js";
import { getShutdownTokenPath } from "../common/paths.js";
import { DaemonRuntime, startDaemonRuntime } from "../daemon/runtime.js";

export class DaemonSupervisor implements vscode.Disposable {
  private readonly startups = new Map<number, Promise<DaemonHealth>>();
  private runtime: DaemonRuntime | undefined;

  async ensureRunning(port = DEFAULT_DAEMON_PORT): Promise<DaemonHealth> {
    const existing = await this.health(port);
    if (existing) {
      return existing;
    }

    const pending = this.startups.get(port);
    if (pending) {
      return pending;
    }

    const startup = this.startDaemon(port).finally(() => {
      this.startups.delete(port);
    });
    this.startups.set(port, startup);
    return startup;
  }

  async waitUntilStopped(port = DEFAULT_DAEMON_PORT, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.health(port))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Notebook MCP daemon did not stop on port ${port}.`);
  }

  async status(port = DEFAULT_DAEMON_PORT): Promise<DaemonHealth | undefined> {
    return this.health(port);
  }

  async shutdown(port = DEFAULT_DAEMON_PORT): Promise<void> {
    const token = await this.readDaemonToken();
    await requestJson<unknown>(port, SHUTDOWN_PATH, "POST", token);
  }

  async readDaemonToken(): Promise<string> {
    return (await fs.readFile(getShutdownTokenPath(), "utf8")).trim();
  }

  private async startDaemon(port: number): Promise<DaemonHealth> {
    const existing = await this.health(port);
    if (existing) {
      return existing;
    }

    this.runtime = await startDaemonRuntime({ port });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const health = await this.health(port);
      if (health) {
        return health;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Notebook MCP daemon did not become healthy on port ${port}.`);
  }

  private async health(port: number): Promise<DaemonHealth | undefined> {
    try {
      return await requestJson<DaemonHealth>(port, HEALTH_PATH, "GET");
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    void this.runtime?.stop();
    this.runtime = undefined;
  }
}

async function requestJson<T>(port: number, requestPath: string, method: string, shutdownToken?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = http.request({
      hostname: DEFAULT_DAEMON_HOST,
      port,
      path: requestPath,
      method,
      timeout: 1000,
      headers: shutdownToken ? { [SHUTDOWN_TOKEN_HEADER]: shutdownToken } : undefined
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(formatHttpError(response.statusCode ?? 500, response.statusMessage, data)));
          return;
        }
        if (!data) {
          resolve(undefined as T);
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch (error) {
          reject(new Error(`Invalid daemon response: ${errorMessage(error)}`));
        }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Request timed out"));
    });
    request.end();
  });
}

function formatHttpError(statusCode: number, statusMessage: string | undefined, body: string): string {
  const parsed = parseErrorBody(body);
  const status = `HTTP ${statusCode}${statusMessage ? ` ${statusMessage}` : ""}`;
  return parsed ? `${status}: ${parsed}` : `${status}${body ? `: ${body}` : ""}`;
}

function parseErrorBody(body: string): string | undefined {
  if (!body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string }; message?: string };
    if (parsed.error?.message) {
      return parsed.error.code ? `${parsed.error.code}: ${parsed.error.message}` : parsed.error.message;
    }
    return parsed.message;
  } catch {
    return body;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
