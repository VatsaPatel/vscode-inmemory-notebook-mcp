export interface DaemonLifecycleOptions {
  now?: () => number;
}

export class DaemonLifecycle {
  private readonly startedAtValue: number;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: DaemonLifecycleOptions = {}) {
    this.startedAtValue = this.now();
  }

  get startedAt(): number {
    return this.startedAtValue;
  }

  get uptimeMs(): number {
    return this.now() - this.startedAtValue;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  scheduleIdleShutdown(timeoutMs: number, onIdle: () => void): void {
    this.cancelIdleShutdown();
    if (timeoutMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(onIdle, timeoutMs);
  }

  cancelIdleShutdown(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  runShutdownOnce(onShutdown: () => Promise<void>): Promise<void> {
    if (!this.shutdownPromise) {
      this.cancelIdleShutdown();
      this.shutdownPromise = onShutdown();
    }
    return this.shutdownPromise;
  }
}
