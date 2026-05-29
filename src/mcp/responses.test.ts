import { describe, expect, it } from "vitest";

import { ErrorCode, NotebookMcpError } from "../common/errors.js";
import { errorResponse } from "./responses.js";

describe("MCP responses", () => {
  it("preserves structured notebook error codes", () => {
    const response = errorResponse(new NotebookMcpError(
      ErrorCode.BackendUnavailable,
      "Backend is gone.",
      { notebook_uri: "file:///tmp/a.ipynb" }
    ));

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      error: {
        code: ErrorCode.BackendUnavailable,
        message: "Backend is gone.",
        details: { notebook_uri: "file:///tmp/a.ipynb" },
        next_action: "Open the target notebook in VS Code/Cursor and wait for the bridge to reconnect, then retry.",
        discoverable_via: ["notebook_status"]
      }
    });
  });
});
