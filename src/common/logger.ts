import * as fs from "fs";
import * as path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

let configuredLogFile: string | undefined;

export function configureLogFile(logFile: string | undefined): void {
  configuredLogFile = logFile;
}

export function createLogger(scope: string): Logger {
  function write(level: LogLevel, message: string, details?: unknown): void {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    const line = `[${new Date().toISOString()}] [${scope}] [${level}] ${message}${suffix}`;

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    appendToLogFile(line);
  }

  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details)
  };
}

function appendToLogFile(line: string): void {
  if (!configuredLogFile) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(configuredLogFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(configuredLogFile, `${line}\n`, { mode: 0o600 });
  } catch {
    // File logging is diagnostic only; logging failures must not break daemon operation.
  }
}
