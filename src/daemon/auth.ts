import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";

import { getShutdownTokenPath } from "../common/paths.js";

export async function ensureShutdownToken(): Promise<string> {
  const tokenPath = getShutdownTokenPath();

  try {
    return (await fs.readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const token = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function isAuthorizedShutdownToken(actualToken: string, providedToken: string | undefined): boolean {
  if (!providedToken) {
    return false;
  }

  const actual = Buffer.from(actualToken, "utf8");
  const provided = Buffer.from(providedToken, "utf8");
  const actualHash = createHash("sha256").update(actual).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(actualHash, providedHash) && actual.length === provided.length;
}

export function isSafeLocalHostHeader(host: string | string[] | undefined): boolean {
  if (typeof host !== "string") {
    return false;
  }

  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function allowedCorsOrigin(origin: string | string[] | undefined): string | undefined {
  if (typeof origin !== "string") {
    return undefined;
  }

  if (origin.startsWith("vscode-webview://")) {
    return origin;
  }

  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHostname(parsed.hostname)) {
      return origin;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function isAllowedRequestOrigin(origin: string | string[] | undefined): boolean {
  return origin === undefined || allowedCorsOrigin(origin) !== undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}
