import { describe, expect, it } from "vitest";

import { createExecutionId, createRpcId, createWindowId } from "./ids.js";

describe("id generation", () => {
  it("uses stable prefixes", () => {
    expect(createWindowId()).toMatch(/^win_[a-f0-9]{32}$/);
    expect(createExecutionId()).toMatch(/^exec_[a-f0-9]{32}$/);
    expect(createRpcId()).toMatch(/^rpc_[a-f0-9]{32}$/);
  });

  it("creates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createExecutionId()));
    expect(ids.size).toBe(100);
  });
});
