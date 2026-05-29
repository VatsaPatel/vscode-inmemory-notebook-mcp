import * as http from "http";
import { createServer, Socket } from "net";

import { afterEach, describe, expect, it } from "vitest";

import { AUTH_TOKEN_HEADER, MCP_PATH } from "../common/protocol.js";
import { isAuthorizedShutdownToken } from "./auth.js";
import { BridgeServer } from "./bridgeServer.js";
import { DaemonHttpServer } from "./httpServer.js";
import { DaemonRegistry } from "./registry.js";

const TOKEN = "test-token";

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

describe("daemon localhost security", () => {
  it("compares daemon tokens with fixed-length timing-safe digests", () => {
    expect(isAuthorizedShutdownToken(TOKEN, TOKEN)).toBe(true);
    expect(isAuthorizedShutdownToken(TOKEN, undefined)).toBe(false);
    expect(isAuthorizedShutdownToken(TOKEN, "bad-token")).toBe(false);
    expect(isAuthorizedShutdownToken(TOKEN, `${TOKEN}-suffix`)).toBe(false);
  });

  it("rejects unsafe Host headers on HTTP routes", async () => {
    const port = await startHttpServer();

    const response = await request(port, "GET", "/status", {
      Host: "example.com"
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.message).toBe("Invalid host header.");
  });

  it("echoes allowed CORS origins and never uses wildcard CORS", async () => {
    const port = await startHttpServer();
    const origin = "http://localhost:3000";

    const response = await request(port, "OPTIONS", MCP_PATH, {
      Origin: origin
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("rejects unsafe HTTP origins before route handling", async () => {
    const port = await startHttpServer();

    const response = await request(port, "POST", MCP_PATH, {
      [AUTH_TOKEN_HEADER]: TOKEN,
      "Content-Type": "application/json",
      Origin: "https://example.com"
    }, JSON.stringify({ notebook_uri: "file:///tmp/a.ipynb" }));

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.message).toBe("Invalid request origin.");
  });

  it("token-gates MCP requests", async () => {
    const port = await startHttpServer();

    const missingMcpToken = await request(port, "GET", MCP_PATH);
    const authorizedMcp = await request(port, "GET", MCP_PATH, {
      [AUTH_TOKEN_HEADER]: TOKEN
    });

    expect(missingMcpToken.statusCode).toBe(401);
    expect(JSON.parse(authorizedMcp.body)).toEqual({ ok: true });
  });

  it("rejects bridge upgrades with missing tokens or unsafe Host/Origin headers", async () => {
    const port = await startBridgeServer();

    await expect(upgrade(port, "/bridge", {
      Host: `127.0.0.1:${port}`
    })).resolves.toContain("401 Unauthorized");
    await expect(upgrade(port, `/bridge?token=${TOKEN}`, {
      Host: "example.com"
    })).resolves.toContain("401 Unauthorized");
    await expect(upgrade(port, `/bridge?token=${TOKEN}`, {
      Host: `127.0.0.1:${port}`,
      Origin: "https://example.com"
    })).resolves.toContain("401 Unauthorized");
  });
});

async function startHttpServer(): Promise<number> {
  const port = await freePort();
  const daemon = new DaemonHttpServer({
    port,
    shutdownToken: TOKEN,
    mcpHandler: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await daemon.start();
  cleanup.push(() => daemon.stop());
  return port;
}

async function startBridgeServer(): Promise<number> {
  const port = await freePort();
  const registry = new DaemonRegistry();
  const bridge = new BridgeServer(registry, { authToken: TOKEN });
  const daemon = new DaemonHttpServer({
    port,
    shutdownToken: TOKEN,
    onServerCreated: (server) => bridge.attach(server)
  });
  await daemon.start();
  cleanup.push(async () => {
    await bridge.close();
    await daemon.stop();
  });
  return port;
}

async function request(
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
  body?: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function upgrade(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(2000);
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Timed out waiting for upgrade response."));
    });
    socket.connect(port, "127.0.0.1", () => {
      const headerLines = Object.entries({
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        ...headers
      }).map(([name, value]) => `${name}: ${value}`);
      socket.write(`GET ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(chunk.toString("utf8"));
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
