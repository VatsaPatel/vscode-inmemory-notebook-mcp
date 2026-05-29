import { BridgeWindowRegistration, NotebookSummary } from "../common/types.js";

export interface WindowRecord {
  registration: BridgeWindowRegistration;
  connected: boolean;
  lastSeenAt: number;
}

export class DaemonRegistry {
  private readonly windows = new Map<string, WindowRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  registerWindow(registration: BridgeWindowRegistration): WindowRecord {
    const record = {
      registration,
      connected: true,
      lastSeenAt: this.now()
    };
    this.windows.set(registration.windowId, record);
    return record;
  }

  updateNotebooks(windowId: string, notebooks: NotebookSummary[]): void {
    const record = this.requireWindow(windowId);
    record.registration = {
      ...record.registration,
      notebooks
    };
    record.connected = true;
    record.lastSeenAt = this.now();
  }

  touchWindow(windowId: string): void {
    const record = this.requireWindow(windowId);
    record.connected = true;
    record.lastSeenAt = this.now();
  }

  markDisconnected(windowId: string): void {
    const record = this.windows.get(windowId);
    if (!record) {
      return;
    }
    record.connected = false;
    record.lastSeenAt = this.now();
  }

  pruneStaleWindows(staleAfterMs: number): string[] {
    const timestamp = this.now();
    const staleBefore = timestamp - staleAfterMs;
    const staleWindowIds: string[] = [];

    for (const record of this.windows.values()) {
      if (record.connected && record.lastSeenAt <= staleBefore) {
        record.connected = false;
        record.lastSeenAt = timestamp;
        staleWindowIds.push(record.registration.windowId);
      }
    }

    return staleWindowIds;
  }

  listWindows(): WindowRecord[] {
    return [...this.windows.values()];
  }

  listConnectedWindows(): WindowRecord[] {
    return this.listWindows().filter((record) => record.connected);
  }

  listOpenNotebooks(): NotebookSummary[] {
    const notebooks = new Map<string, NotebookSummary>();

    for (const record of this.listConnectedWindows()) {
      for (const notebook of record.registration.notebooks) {
        notebooks.set(notebook.uri, notebook);
      }
    }

    return [...notebooks.values()].sort((a, b) => a.uri.localeCompare(b.uri));
  }

  findWindowsForNotebook(notebookUri: string): WindowRecord[] {
    return this.listConnectedWindows()
      .filter((record) => record.registration.notebooks.some((notebook) => notebook.uri === notebookUri))
      .sort((a, b) => a.registration.windowId.localeCompare(b.registration.windowId));
  }

  hasNotebook(notebookUri: string): boolean {
    return this.findWindowsForNotebook(notebookUri).length > 0;
  }

  getWindow(windowId: string): WindowRecord | undefined {
    return this.windows.get(windowId);
  }

  get windowCount(): number {
    return this.listConnectedWindows().length;
  }

  private requireWindow(windowId: string): WindowRecord {
    const record = this.windows.get(windowId);
    if (!record) {
      throw new Error(`Unknown bridge window: ${windowId}`);
    }
    return record;
  }
}
