export const EXTENSION_ID = "notebook-mcp-for-vscode";
export const DAEMON_SERVER_NAME = "notebook-mcp-for-vscode-daemon";
export const PROTOCOL_VERSION = "0.1.0";
export const EXTENSION_VERSION = "0.5.0";
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 49777;

export const HEALTH_PATH = "/health";
export const STATUS_PATH = "/status";
export const SHUTDOWN_PATH = "/shutdown";
export const MCP_PATH = "/mcp";
export const BRIDGE_PATH = "/bridge";

export const SHUTDOWN_TOKEN_HEADER = "x-notebook-mcp-shutdown-token";
export const AUTH_TOKEN_HEADER = "x-notebook-mcp-token";

export function formatMcpUrl(port: number = DEFAULT_DAEMON_PORT, token?: string): string {
  const url = `http://${DEFAULT_DAEMON_HOST}:${port}${MCP_PATH}`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}
