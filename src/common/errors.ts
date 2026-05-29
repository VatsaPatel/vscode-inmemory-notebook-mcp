export const ErrorCode = {
  InvalidRequest: "invalid_request",
  MissingTarget: "missing_target",
  AmbiguousTarget: "ambiguous_target",
  NotebookNotFound: "notebook_not_found",
  BackendUnavailable: "backend_unavailable",
  BridgeTimeout: "bridge_timeout",
  Unauthorized: "unauthorized",
  PermissionDenied: "permission_denied",
  PortInUse: "port_in_use",
  Internal: "internal"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class NotebookMcpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "NotebookMcpError";
  }
}

export function serializeError(error: unknown): { code: ErrorCode; message: string; details?: unknown; next_action?: string; discoverable_via?: string[] } {
  if (error instanceof NotebookMcpError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      ...errorHint(error.code)
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCode.Internal,
      message: error.message,
      ...errorHint(ErrorCode.Internal)
    };
  }

  return {
    code: ErrorCode.Internal,
    message: String(error),
    ...errorHint(ErrorCode.Internal)
  };
}

function errorHint(code: ErrorCode): { next_action?: string; discoverable_via?: string[] } {
  switch (code) {
    case ErrorCode.MissingTarget:
      return {
        next_action: "Call notebook_status, choose an open notebook URI, then retry with notebook_uri.",
        discoverable_via: ["notebook_status"]
      };
    case ErrorCode.AmbiguousTarget:
      return {
        next_action: "Pass notebook_uri from notebook_status.",
        discoverable_via: ["notebook_status"]
      };
    case ErrorCode.BackendUnavailable:
      return {
        next_action: "Open the target notebook in VS Code/Cursor and wait for the bridge to reconnect, then retry.",
        discoverable_via: ["notebook_status"]
      };
    case ErrorCode.PermissionDenied:
      return {
        next_action: "Check the tool arguments and target notebook state, then retry with notebook_uri.",
        discoverable_via: ["notebook_status"]
      };
    case ErrorCode.NotebookNotFound:
      return {
        next_action: "Open the notebook first with notebook_open or choose a URI from notebook_status.",
        discoverable_via: ["notebook_status", "notebook_open"]
      };
    default:
      return {
        next_action: "Inspect notebook_status and retry with notebook_uri."
      };
  }
}
