import { describe, expect, it, vi } from "vitest";

import { DaemonLifecycle } from "./lifecycle.js";

describe("DaemonLifecycle", () => {
  it("tracks start time and uptime", () => {
    let now = 1000;
    const lifecycle = new DaemonLifecycle({ now: () => now });

    expect(lifecycle.startedAt).toBe(1000);

    now = 1750;
    expect(lifecycle.uptimeMs).toBe(750);
  });

  it("schedules and cancels idle shutdown", () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new DaemonLifecycle();
      const onIdle = vi.fn();

      lifecycle.scheduleIdleShutdown(1000, onIdle);
      vi.advanceTimersByTime(999);
      expect(onIdle).not.toHaveBeenCalled();

      lifecycle.cancelIdleShutdown();
      vi.advanceTimersByTime(1);
      expect(onIdle).not.toHaveBeenCalled();

      lifecycle.scheduleIdleShutdown(1000, onIdle);
      vi.advanceTimersByTime(1000);
      expect(onIdle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs shutdown cleanup once for concurrent callers", async () => {
    const lifecycle = new DaemonLifecycle();
    let resolveCleanup: () => void;
    const cleanup = vi.fn(() => new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    }));

    const first = lifecycle.runShutdownOnce(cleanup);
    const second = lifecycle.runShutdownOnce(cleanup);

    expect(first).toBe(second);
    expect(cleanup).toHaveBeenCalledTimes(1);

    resolveCleanup!();
    await Promise.all([first, second]);
  });
});
