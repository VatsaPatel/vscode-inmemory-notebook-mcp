import * as vscode from "vscode";

const CHARACTER_LIMIT = 25000;

// Get error MIME type dynamically
const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error("")).mime;

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

/**
 * Parse notebook cell outputs into a structured format
 */
export function parseOutputs(
  outputs: readonly vscode.NotebookCellOutput[]
): CellOutput[] {
  const decoder = new TextDecoder();
  const results: CellOutput[] = [];

  for (const output of outputs) {
    for (const item of output.items) {
      if (item.mime === ERROR_MIME) {
        try {
          const error = JSON.parse(decoder.decode(item.data));
          results.push({
            type: "error",
            name: error.name || "Error",
            message: error.message || "Unknown error",
            stack: error.stack || ""
          });
        } catch {
          // If JSON parsing fails, treat as text
          results.push({ type: "text", text: decoder.decode(item.data) });
        }
      } else if (item.mime === "application/json" || item.mime.endsWith("+json")) {
        const text = decoder.decode(item.data);
        try {
          results.push({ type: "json", data: JSON.parse(text), mimeType: item.mime });
        } catch {
          results.push({ type: "text", text: truncateText(text), mimeType: item.mime });
        }
      } else if (item.mime === "text/html") {
        results.push({ type: "html", html: truncateText(decoder.decode(item.data)), mimeType: item.mime });
      } else if (item.mime === "image/png" || item.mime.startsWith("image/")) {
        const base64 = Buffer.from(item.data).toString("base64");
        results.push({ type: "image", data: base64, mimeType: item.mime });
      } else {
        results.push({
          type: "text",
          text: truncateText(decoder.decode(item.data)),
          mimeType: item.mime,
          stream: streamName(output, item)
        });
      }
    }
  }

  return results;
}

/**
 * Format execution results as markdown
 */
export function formatOutputsAsMarkdown(outputs: CellOutput[]): string {
  const lines: string[] = [];

  for (const output of outputs) {
    if (output.type === "text") {
      lines.push("```");
      lines.push(output.text);
      lines.push("```");
    } else if (output.type === "error") {
      lines.push(`**Error**: ${output.name}: ${output.message}`);
      if (output.stack) {
        lines.push("```");
        lines.push(output.stack);
        lines.push("```");
      }
    } else if (output.type === "image") {
      lines.push(`[Image output: ${output.mimeType}]`);
    } else if (output.type === "json") {
      lines.push("```json");
      lines.push(JSON.stringify(output.data, null, 2));
      lines.push("```");
    } else if (output.type === "html") {
      lines.push("```html");
      lines.push(output.html);
      lines.push("```");
    }
  }

  return lines.join("\n");
}

function truncateText(text: string): string {
  if (text.length <= CHARACTER_LIMIT) {
    return text;
  }
  return `${text.substring(0, CHARACTER_LIMIT)}\n\n[Output truncated. Total length: ${text.length} characters]`;
}

function streamName(output: vscode.NotebookCellOutput, item: vscode.NotebookCellOutputItem): "stdout" | "stderr" | undefined {
  const metadata = output.metadata as Record<string, unknown> | undefined;
  const outputType = String(metadata?.outputType ?? metadata?.name ?? item.mime).toLowerCase();
  if (outputType.includes("stderr")) {
    return "stderr";
  }
  if (outputType.includes("stdout")) {
    return "stdout";
  }
  return undefined;
}
