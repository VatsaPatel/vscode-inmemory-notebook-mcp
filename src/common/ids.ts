import { randomUUID } from "crypto";

export const IdPrefix = {
  Window: "win_",
  Execution: "exec_",
  Rpc: "rpc_"
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

export function createId(prefix: IdPrefix): string {
  return `${prefix}${randomUUID().replace(/-/g, "")}`;
}

export function createWindowId(): string {
  return createId(IdPrefix.Window);
}

export function createExecutionId(): string {
  return createId(IdPrefix.Execution);
}

export function createRpcId(): string {
  return createId(IdPrefix.Rpc);
}
