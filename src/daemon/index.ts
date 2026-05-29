import { createLogger } from "../common/logger.js";
import { DEFAULT_DAEMON_PORT } from "../common/protocol.js";
import { startDaemonRuntime } from "./runtime.js";

const logger = createLogger("daemon");

async function main(): Promise<void> {
  const port = Number(
    process.env.NOTEBOOK_MCP_FOR_VSCODE_PORT
    ?? process.env.VSCODE_IN_MEMORY_COMPLETE_JUPYTER_MCP_PORT
    ?? process.env.INMEMORY_NOTEBOOK_MCP_PORT
    ?? DEFAULT_DAEMON_PORT
  );
  const idleTimeoutMs = Number(
    process.env.NOTEBOOK_MCP_FOR_VSCODE_IDLE_TIMEOUT_MS
    ?? process.env.VSCODE_IN_MEMORY_COMPLETE_JUPYTER_MCP_IDLE_TIMEOUT_MS
    ?? process.env.INMEMORY_NOTEBOOK_MCP_IDLE_TIMEOUT_MS
    ?? 5 * 60 * 1000
  );
  const runtime = await startDaemonRuntime({ port, idleTimeoutMs });

  process.once("SIGINT", () => {
    void runtime.stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runtime.stop().finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  logger.error("daemon failed", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
