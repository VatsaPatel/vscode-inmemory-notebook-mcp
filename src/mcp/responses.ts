import { ResponseFormat } from "../schemas/index.js";
import { serializeError } from "../common/errors.js";

export interface McpTextResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function jsonResponse(value: unknown): McpTextResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

export function textResponse(text: string): McpTextResponse {
  return {
    content: [{ type: "text", text }]
  };
}

export function errorResponse(error: unknown): McpTextResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: serializeError(error) }, null, 2) }],
    isError: true
  };
}

export function formatResponse(value: unknown, responseFormat: ResponseFormat = ResponseFormat.MARKDOWN): McpTextResponse {
  if (responseFormat === ResponseFormat.JSON) {
    return jsonResponse(value);
  }

  if (typeof value === "string") {
    return textResponse(value);
  }

  return jsonResponse(value);
}
