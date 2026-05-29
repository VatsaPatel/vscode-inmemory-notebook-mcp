import { promises as fs } from "fs";
import * as path from "path";

import { configureLogFile, createLogger } from "../common/logger.js";
import { getDaemonLogPath, getDaemonPidPath } from "../common/paths.js";
import { DEFAULT_DAEMON_PORT } from "../common/protocol.js";
import { ensureShutdownToken } from "./auth.js";
import { BridgeServer } from "./bridgeServer.js";
import { ExecutionStore } from "./executions.js";
import { DaemonHttpServer } from "./httpServer.js";
import { DaemonLifecycle } from "./lifecycle.js";
import { DaemonLock, acquireDaemonLock } from "./locks.js";
import { DaemonMcpHandler } from "./mcpServer.js";
import { DaemonPersistence } from "./persistence.js";
import { DaemonRegistry } from "./registry.js";
import { NotebookRouter } from "./router.js";

const logger = createLogger("daemon");

export interface DaemonRuntimeOptions {
  port?: number;
  idleTimeoutMs?: number;
}

export interface DaemonRuntime {
  stop(): Promise<void>;
}

export async function startDaemonRuntime(options: DaemonRuntimeOptions = {}): Promise<DaemonRuntime> {
  configureLogFile(getDaemonLogPath());
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const shutdownToken = await ensureShutdownToken();
  let lock: DaemonLock | undefined;
  const lifecycle = new DaemonLifecycle();
  const persistence = new DaemonPersistence();
  const registry = new DaemonRegistry();
  const executions = new ExecutionStore(
    () => Date.now(),
    await persistence.loadExecutions(),
    (snapshot) => {
      void persistence.saveExecutions(snapshot).catch((error) => {
        logger.warn("failed to persist executions", error instanceof Error ? error.message : String(error));
      });
    }
  );
  let stop: (() => Promise<void>) | undefined;
  const bridge = new BridgeServer(registry, {
    authToken: shutdownToken,
    onConnect: () => lifecycle.cancelIdleShutdown(),
    onDisconnect: (windowId) => {
      executions.markBackendLost(windowId);
      if (bridge.bridgeCount === 0) {
        lifecycle.scheduleIdleShutdown(idleTimeoutMs, () => {
          logger.info("idle timeout reached");
          void stop?.();
        });
      }
    }
  });
  const router = new NotebookRouter(registry, bridge);
  let daemon: DaemonHttpServer;
  const mcp = new DaemonMcpHandler({
    port,
    registry,
    router,
    executions,
    status: () => daemon.status(),
    token: shutdownToken
  });

  lock = await acquireDaemonLock();
  daemon = new DaemonHttpServer({
    port,
    shutdownToken,
    lifecycle,
    stats: () => ({
      windowCount: registry.windowCount,
      bridgeCount: bridge.bridgeCount,
      executionCount: executions.executionCount
    }),
    onServerCreated: (server) => bridge.attach(server),
    mcpHandler: (req, res) => mcp.handle(req, res),
    onShutdown: async () => {
      await stop?.();
    }
  });

  try {
    await writePidFile();
    await daemon.start();
  } catch (error) {
    mcp.close();
    await bridge.close();
    await daemon.stop();
    await lock?.release();
    await removePidFile();
    throw error;
  }

  lifecycle.scheduleIdleShutdown(idleTimeoutMs, () => {
    logger.info("idle timeout reached");
    void stop?.();
  });

  stop = async () => {
    await lifecycle.runShutdownOnce(async () => {
      logger.info("stopping daemon");
      mcp.close();
      await bridge.close();
      await daemon.stop();
      await lock?.release();
      await removePidFile();
    });
  };

  return {
    stop
  };
}

async function writePidFile(): Promise<void> {
  const pidPath = getDaemonPidPath();
  await fs.mkdir(path.dirname(pidPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });
}

async function removePidFile(): Promise<void> {
  const pidPath = getDaemonPidPath();
  try {
    const stats = await fs.lstat(pidPath);
    if (!stats.isFile()) {
      return;
    }
    const ownerPid = Number((await fs.readFile(pidPath, "utf8")).trim());
    if (ownerPid !== process.pid) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await fs.rm(pidPath, { force: true });
}
