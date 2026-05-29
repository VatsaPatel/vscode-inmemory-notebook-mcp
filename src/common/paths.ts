import * as os from "os";
import * as path from "path";

import { EXTENSION_ID } from "./protocol.js";

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export function getAppDataDir(options: PathEnvironment = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  if (env.NOTEBOOK_MCP_FOR_VSCODE_HOME) {
    return env.NOTEBOOK_MCP_FOR_VSCODE_HOME;
  }

  if (env.VSCODE_IN_MEMORY_COMPLETE_JUPYTER_MCP_HOME) {
    return env.VSCODE_IN_MEMORY_COMPLETE_JUPYTER_MCP_HOME;
  }

  if (env.INMEMORY_NOTEBOOK_MCP_HOME) {
    return env.INMEMORY_NOTEBOOK_MCP_HOME;
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", EXTENSION_ID);
  }

  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"), EXTENSION_ID);
  }

  return path.join(env.XDG_STATE_HOME ?? path.join(homeDir, ".local", "state"), EXTENSION_ID);
}

export function getDaemonPidPath(options: PathEnvironment = {}): string {
  return path.join(getAppDataDir(options), "daemon.pid");
}

export function getDaemonLockPath(options: PathEnvironment = {}): string {
  return path.join(getAppDataDir(options), "daemon.lock");
}

export function getShutdownTokenPath(options: PathEnvironment = {}): string {
  return path.join(getAppDataDir(options), "shutdown.token");
}

export function getDaemonLogPath(options: PathEnvironment = {}): string {
  return path.join(getAppDataDir(options), "daemon.log");
}

export function getRegistrySnapshotPath(options: PathEnvironment = {}): string {
  return path.join(getAppDataDir(options), "registry.snapshot.json");
}
