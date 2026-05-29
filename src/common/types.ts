export interface KernelSummary {
  id?: string;
  label?: string;
  language?: string;
  state?: string;
}

export interface BridgeWindowRegistration {
  windowId: string;
  bridgeVersion: string;
  extensionVersion: string;
  pid: number;
  workspaceFolders: string[];
  notebooks: NotebookSummary[];
  allowActiveNotebookWrites?: boolean;
}

export interface NotebookSummary {
  uri: string;
  fileName: string;
  notebookType: string;
  cellCount: number;
  visible: boolean;
  active: boolean;
  dirty: boolean;
  language?: string;
  kernel?: KernelSummary;
}

export interface TextOutput {
  type: "text";
  text: string;
  mimeType?: string;
  stream?: "stdout" | "stderr";
}

export interface ErrorOutput {
  type: "error";
  name: string;
  message: string;
  stack: string;
}

export interface ImageOutput {
  type: "image";
  data: string;
  mimeType: string;
}

export interface JsonOutput {
  type: "json";
  data: unknown;
  mimeType: string;
}

export interface HtmlOutput {
  type: "html";
  html: string;
  mimeType: string;
}

export type CellOutput = TextOutput | ErrorOutput | ImageOutput | JsonOutput | HtmlOutput;

export interface ExecutionOperation {
  id: string;
  notebookUri: string;
  cellIndex: number;
  windowId: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "backend_lost";
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  executionOrder?: number | null;
  outputs?: CellOutput[];
  error?: string;
}

export interface BridgeRequest<TParams = unknown> {
  id: string;
  method: string;
  params: TParams;
  deadlineAt?: number;
}

export interface BridgeResponse<TResult = unknown> {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type BridgeClientMessage =
  | {
      type: "register";
      registration: BridgeWindowRegistration;
    }
  | {
      type: "heartbeat";
      windowId: string;
      notebooks: NotebookSummary[];
    }
  | {
      type: "response";
      response: BridgeResponse;
    };

export type BridgeDaemonMessage = {
  type: "request";
  request: BridgeRequest;
};

export interface ToolContext {
  notebookUri?: string;
}

export interface RoutedNotebookTarget {
  notebookUri: string;
  windowId: string;
}

export interface DaemonHealth {
  status: "ok";
  server: "notebook-mcp-for-vscode-daemon";
  version: string;
  pid: number;
  uptimeMs: number;
  windowCount: number;
}

export interface DaemonStatus extends DaemonHealth {
  port: number;
  startedAt: number;
  bridgeCount: number;
  executionCount: number;
}
