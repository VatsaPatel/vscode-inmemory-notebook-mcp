import * as vscode from "vscode";

import { NotebookSummary } from "../common/types.js";
import {
  deleteCells,
  editCellContent,
  generateCellId,
  getNotebookEditor,
  insertCells,
  moveCell
} from "../utils/notebook.js";
import { formatOutputsAsMarkdown, parseOutputs } from "../utils/output.js";

export interface BackendParams {
  notebook_uri: string;
  [key: string]: unknown;
}

type CellType = "code" | "markdown";
type JsonRecord = Record<string, unknown>;

const LONG_RUNNING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error("")).mime;

function fileName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.toString();
}

export function listOpenNotebooks(): NotebookSummary[] {
  const activeUri = vscode.window.activeNotebookEditor?.notebook.uri.toString();
  const visibleUris = new Set(vscode.window.visibleNotebookEditors.map((editor) => editor.notebook.uri.toString()));

  return vscode.workspace.notebookDocuments.map((notebook) => ({
    uri: notebook.uri.toString(),
    fileName: fileName(notebook.uri),
    notebookType: notebook.notebookType,
    cellCount: notebook.cellCount,
    visible: visibleUris.has(notebook.uri.toString()),
    active: notebook.uri.toString() === activeUri,
    dirty: notebook.isDirty,
    language: notebook.getCells().find((cell) => cell.kind === vscode.NotebookCellKind.Code)?.document.languageId
  }));
}

export async function handleNotebookRequest(method: string, params: BackendParams): Promise<unknown> {
  switch (method) {
    case "notebook/open":
      return openNotebook(String(params.path ?? ""));
    case "notebook/create":
      return createNotebook(params);
    case "notebook/listCells":
      return listCells(await requireNotebook(params.notebook_uri));
    case "notebook/read":
      return readNotebook(await requireNotebook(params.notebook_uri), params);
    case "notebook/resolveCell":
      return { index: resolveCellIndex(await requireNotebook(params.notebook_uri), params) };
    case "notebook/getCellContent":
      return getCellContent(await requireNotebook(params.notebook_uri), Number(params.index));
    case "notebook/getCellOutput":
      return getCellOutput(await requireNotebook(params.notebook_uri), Number(params.index));
    case "notebook/getExecutionSnapshot":
      return getExecutionSnapshot(await requireNotebook(params.notebook_uri), Number(params.index));
    case "notebook/getOutline":
      return getOutline(await requireNotebook(params.notebook_uri));
    case "notebook/search":
      return searchNotebook(await requireNotebook(params.notebook_uri), params);
    case "notebook/getKernelInfo":
      return getKernelInfo(await requireNotebook(params.notebook_uri));
    case "notebook/getKernelContext":
      return getKernelContext(await requireNotebook(params.notebook_uri), params);
    case "notebook/getCellMetadata":
      return getCellMetadata(await requireNotebook(params.notebook_uri), Number(params.index));
    case "notebook/getNotebookMetadata":
      return getNotebookMetadata(await requireNotebook(params.notebook_uri));
    case "notebook/export":
      return exportNotebook(await requireNotebook(params.notebook_uri), params);
    case "notebook/insertCell":
      return insertCell(await requireNotebook(params.notebook_uri), params);
    case "notebook/editCells":
      return editCells(await requireNotebook(params.notebook_uri), params);
    case "notebook/editCell":
      return editCell(await requireNotebook(params.notebook_uri), params);
    case "notebook/deleteCell":
      return deleteCell(await requireNotebook(params.notebook_uri), Number(params.index));
    case "notebook/moveCell":
      return moveNotebookCell(await requireNotebook(params.notebook_uri), Number(params.from_index), Number(params.to_index));
    case "notebook/moveCells":
      return moveNotebookCells(await requireNotebook(params.notebook_uri), params);
    case "notebook/changeCellType":
      return changeCellType(await requireNotebook(params.notebook_uri), params);
    case "notebook/bulkAddCells":
      return bulkAddCells(await requireNotebook(params.notebook_uri), params);
    case "notebook/setCellMetadata":
      return setCellMetadata(await requireNotebook(params.notebook_uri), params);
    case "notebook/setNotebookMetadata":
      return setNotebookMetadata(await requireNotebook(params.notebook_uri), params);
    case "notebook/findReplace":
      return findReplace(await requireNotebook(params.notebook_uri), params);
    case "notebook/clearOutputs":
      return clearOutputsScoped(await requireNotebook(params.notebook_uri), params);
    case "notebook/clearAllOutputs":
      return clearAllOutputs(await requireNotebook(params.notebook_uri));
    case "notebook/stripOutputs":
      return stripOutputs(await requireNotebook(params.notebook_uri));
    case "notebook/save":
      return saveNotebook(await requireNotebook(params.notebook_uri), params);
    case "notebook/lockCell":
      return lockCell(await requireNotebook(params.notebook_uri), params);
    case "notebook/runCell":
      return runCell(await requireNotebook(params.notebook_uri), Number(params.index), Number(params.timeout_ms ?? 60_000));
    case "notebook/runAllCells":
      return runCellsInRange(await requireNotebook(params.notebook_uri), 0, undefined, Number(params.timeout_ms ?? 300_000));
    case "notebook/runCellsInRange":
      return runCellsInRange(await requireNotebook(params.notebook_uri), Number(params.start_index), Number(params.end_index), Number(params.timeout_ms ?? 300_000));
    case "notebook/run":
      return runNotebook(await requireNotebook(params.notebook_uri), params);
    case "notebook/runCode":
      return runCode(await requireNotebook(params.notebook_uri), params);
    case "notebook/cancelExecution":
      return cancelExecution(await requireNotebook(params.notebook_uri), Number(params.index));
    case "notebook/restartKernel":
      return executeJupyterKernelCommand(await requireNotebook(params.notebook_uri), "jupyter.restartkernel", "restart");
    case "notebook/interruptKernel":
      return executeJupyterKernelCommand(await requireNotebook(params.notebook_uri), "jupyter.interruptkernel", "interrupt");
    case "notebook/inspectVariable":
      return inspectVariable(await requireNotebook(params.notebook_uri), params);
    case "notebook/complete":
      return completePrefix(await requireNotebook(params.notebook_uri), params);
    case "notebook/history":
      return kernelHistory(await requireNotebook(params.notebook_uri), params);
    case "notebook/kernelInfo":
      return getKernelInfoCombined(await requireNotebook(params.notebook_uri), params);
    case "notebook/kernelControl":
      return executeKernelControl(await requireNotebook(params.notebook_uri), params);
    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}

async function requireNotebook(notebookUri: string): Promise<vscode.NotebookDocument> {
  if (!notebookUri) {
    throw new Error("Bridge request missing notebook_uri.");
  }

  const existing = vscode.workspace.notebookDocuments.find((notebook) => notebook.uri.toString() === notebookUri);
  if (existing) {
    return existing;
  }

  const opened = await vscode.workspace.openNotebookDocument(vscode.Uri.parse(notebookUri));
  if (!opened) {
    throw new Error(`Notebook not found: ${notebookUri}`);
  }
  return opened;
}

async function openNotebook(filePath: string): Promise<unknown> {
  const uri = pathToUri(filePath);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: false });
  return { notebook: summarizeNotebook(notebook), opened: true };
}

async function createNotebook(params: BackendParams): Promise<unknown> {
  const initialContent = String(params.initial_content ?? "");
  const language = String(params.kernel_language ?? "python");
  const metadata = notebookMetadata(language);
  let notebook: vscode.NotebookDocument;

  if (params.path) {
    const uri = pathToUri(String(params.path));
    const notebookJson = {
      cells: [{
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: initialContent.split(/(?<=\n)/)
      }],
      metadata,
      nbformat: 4,
      nbformat_minor: 5
    };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(notebookJson, null, 2)}\n`, "utf8"));
    notebook = await vscode.workspace.openNotebookDocument(uri);
  } else {
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, initialContent, language)
    ]);
    data.metadata = metadata;
    notebook = await vscode.workspace.openNotebookDocument("jupyter-notebook", data);
  }

  await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: false });
  return { notebook: summarizeNotebook(notebook), created: true };
}

function pathToUri(value: string): vscode.Uri {
  if (!value) {
    throw new Error("path is required.");
  }
  return value.startsWith("file:") ? vscode.Uri.parse(value) : vscode.Uri.file(value);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function cellType(cell: vscode.NotebookCell): CellType {
  return cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown";
}

function notebookMetadata(language: string): JsonRecord {
  return {
    kernelspec: {
      display_name: language === "python" ? "Python 3" : language,
      language,
      name: language === "python" ? "python3" : language
    },
    language_info: { name: language }
  };
}

function summarizeNotebook(notebook: vscode.NotebookDocument): NotebookSummary {
  return {
    uri: notebook.uri.toString(),
    fileName: fileName(notebook.uri),
    notebookType: notebook.notebookType,
    cellCount: notebook.cellCount,
    visible: vscode.window.visibleNotebookEditors.some((editor) => editor.notebook.uri.toString() === notebook.uri.toString()),
    active: vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString(),
    dirty: notebook.isDirty,
    language: notebook.getCells().find((cell) => cell.kind === vscode.NotebookCellKind.Code)?.document.languageId
  };
}

function assertCellIndex(notebook: vscode.NotebookDocument, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= notebook.cellCount) {
    throw new Error(`Cell index ${index} out of range (0-${notebook.cellCount - 1}).`);
  }
}

function assertCellUnlocked(notebook: vscode.NotebookDocument, index: number): void {
  assertCellIndex(notebook, index);
  if (isCellLocked(notebook.cellAt(index))) {
    throw new Error(`Cell ${index} is locked for Notebook MCP agent edits.`);
  }
}

function isCellLocked(cell: vscode.NotebookCell): boolean {
  return asRecord(cell.metadata?.notebookMcp).locked === true;
}

function withAgentAction(metadata: unknown, action: string, extra: JsonRecord = {}): JsonRecord {
  const base = asRecord(metadata);
  return {
    ...base,
    notebookMcp: {
      ...asRecord(base.notebookMcp),
      ...extra,
      lastAgentAction: action,
      lastAgentActionAt: Date.now()
    }
  };
}

async function applyNotebookEdits(notebook: vscode.NotebookDocument, edits: vscode.NotebookEdit[]): Promise<void> {
  if (edits.length === 0) {
    return;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(notebook.uri, edits);
  if (!await vscode.workspace.applyEdit(workspaceEdit)) {
    throw new Error("VS Code refused the notebook edit.");
  }
}

async function applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<void> {
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error("VS Code refused the workspace edit.");
  }
}

function cellDataFromCell(
  cell: vscode.NotebookCell,
  options: {
    kind?: vscode.NotebookCellKind;
    languageId?: string;
    metadata?: JsonRecord;
    outputs?: vscode.NotebookCellOutput[];
    executionSummary?: vscode.NotebookCellExecutionSummary;
  } = {}
): vscode.NotebookCellData {
  const kind = options.kind ?? cell.kind;
  const data = new vscode.NotebookCellData(kind, cell.document.getText(), options.languageId ?? (kind === vscode.NotebookCellKind.Code ? cell.document.languageId : "markdown"));
  data.metadata = options.metadata ?? asRecord(cell.metadata);
  data.outputs = "outputs" in options ? options.outputs : cell.outputs.slice();
  data.executionSummary = "executionSummary" in options ? options.executionSummary : cell.executionSummary;
  return data;
}

async function replaceCells(notebook: vscode.NotebookDocument, replacements: Array<{ index: number; data: vscode.NotebookCellData }>): Promise<void> {
  await applyNotebookEdits(notebook, replacements.map(({ index, data }) =>
    vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [data])
  ));
}

async function markAgentAction(notebook: vscode.NotebookDocument, index: number, action: string): Promise<void> {
  assertCellIndex(notebook, index);
  const cell = notebook.cellAt(index);
  await applyNotebookEdits(notebook, [
    vscode.NotebookEdit.updateCellMetadata(index, withAgentAction(cell.metadata, action))
  ]);
}

async function ensureCellId(notebook: vscode.NotebookDocument, index: number): Promise<string> {
  assertCellIndex(notebook, index);
  const cell = notebook.cellAt(index);
  const cellId = cell.metadata.id ?? generateCellId();
  if (!cell.metadata.id) {
    const edit = vscode.NotebookEdit.updateCellMetadata(index, { ...cell.metadata, id: cellId });
    await applyNotebookEdits(notebook, [edit]);
  }
  return cellId;
}

function serializeCell(cell: vscode.NotebookCell, index: number): unknown {
  return {
    index,
    cell_id: cellIdentifier(cell, index),
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    language: cell.document.languageId,
    lineCount: cell.document.lineCount,
    preview: cell.document.getText().substring(0, 100).replace(/\n/g, "↵"),
    hasOutput: cell.outputs.length > 0,
    executionOrder: cell.executionSummary?.executionOrder ?? null
  };
}

function cellIdentifier(cell: vscode.NotebookCell, index: number): string {
  return typeof cell.metadata?.id === "string" && cell.metadata.id.length > 0 ? cell.metadata.id : `index:${index}`;
}

function resolveCellIndex(notebook: vscode.NotebookDocument, params: Record<string, unknown>): number {
  if (params.cell_id !== undefined) {
    const cellId = String(params.cell_id);
    const index = notebook.getCells().findIndex((cell, candidateIndex) => cellIdentifier(cell, candidateIndex) === cellId);
    if (index < 0) {
      throw new Error(`Cell id not found: ${cellId}`);
    }
    return index;
  }
  const index = Number(params.index);
  assertCellIndex(notebook, index);
  return index;
}

function outputSummary(cell: vscode.NotebookCell, includeOutputs: string, maxOutputChars: number): unknown[] | undefined {
  if (includeOutputs === "none") {
    return undefined;
  }
  const outputs = parseOutputs(cell.outputs);
  if (includeOutputs === "full") {
    return truncateOutputs(outputs, maxOutputChars);
  }
  return outputs.map((output) => {
    if (output.type === "text") {
      return {
        type: output.type,
        stream: output.stream,
        mimeType: output.mimeType,
        text: output.text.length > maxOutputChars ? `${output.text.slice(0, maxOutputChars)}…` : output.text
      };
    }
    if (output.type === "error") {
      return { type: output.type, name: output.name, message: output.message };
    }
    if (output.type === "image") {
      return { type: output.type, mimeType: output.mimeType, bytes: output.data.length };
    }
    if (output.type === "html") {
      return { type: output.type, mimeType: output.mimeType, html: output.html.slice(0, maxOutputChars) };
    }
    return { type: output.type, mimeType: output.mimeType, data: output.data };
  });
}

function truncateOutputs(outputs: ReturnType<typeof parseOutputs>, maxOutputChars: number): unknown[] {
  return outputs.map((output) => {
    if (output.type === "text" && output.text.length > maxOutputChars) {
      return { ...output, text: `${output.text.slice(0, maxOutputChars)}…` };
    }
    if (output.type === "html" && output.html.length > maxOutputChars) {
      return { ...output, html: `${output.html.slice(0, maxOutputChars)}…` };
    }
    return output;
  });
}

function readNotebook(notebook: vscode.NotebookDocument, params: BackendParams): unknown {
  const includeOutputs = String(params.include_outputs ?? "summary");
  const includeMetadata = params.include_metadata === true;
  const maxOutputChars = Number(params.max_output_chars ?? 2000);
  const requestedCellIds = Array.isArray(params.cell_ids) ? new Set(params.cell_ids.map(String)) : undefined;
  const requestedIndexes = Array.isArray(params.indexes) ? new Set(params.indexes.map(Number)) : undefined;
  const cells = notebook.getCells()
    .filter((cell, index) => {
      if (requestedCellIds && !requestedCellIds.has(cellIdentifier(cell, index))) {
        return false;
      }
      if (requestedIndexes && !requestedIndexes.has(index)) {
        return false;
      }
      return true;
    })
    .map((cell, index) => {
      const actualIndex = cell.index;
      const serialized: JsonRecord = {
        index: actualIndex,
        cell_id: cellIdentifier(cell, actualIndex),
        type: cellType(cell),
        language: cell.document.languageId,
        source: cell.document.getText(),
        line_count: cell.document.lineCount,
        locked: isCellLocked(cell),
        execution_order: cell.executionSummary?.executionOrder ?? null,
        execution_success: cell.executionSummary?.success,
        output_count: cell.outputs.length
      };
      const outputs = outputSummary(cell, includeOutputs, maxOutputChars);
      if (outputs !== undefined) {
        serialized.outputs = outputs;
      }
      if (includeMetadata) {
        serialized.metadata = cell.metadata ?? {};
      }
      return serialized;
    });

  return {
    notebook: {
      ...summarizeNotebook(notebook),
      metadata: includeMetadata ? notebook.metadata ?? {} : undefined
    },
    total: notebook.cellCount,
    cells
  };
}

function listCells(notebook: vscode.NotebookDocument): unknown {
  const cells = notebook.getCells().map((cell, index) => serializeCell(cell, index));
  return { total: cells.length, cells };
}

function getCellContent(notebook: vscode.NotebookDocument, index: number): unknown {
  assertCellIndex(notebook, index);
  const cell = notebook.cellAt(index);
  return {
    index,
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    language: cell.document.languageId,
    content: cell.document.getText()
  };
}

function getCellOutput(notebook: vscode.NotebookDocument, index: number): unknown {
  assertCellIndex(notebook, index);
  const cell = notebook.cellAt(index);
  const outputs = parseOutputs(cell.outputs);
  return {
    index,
    hasOutput: outputs.length > 0,
    executionOrder: cell.executionSummary?.executionOrder ?? null,
    outputs,
    markdown: outputs.length > 0 ? formatOutputsAsMarkdown(outputs) : ""
  };
}

function getExecutionSnapshot(notebook: vscode.NotebookDocument, index: number): unknown {
  assertCellIndex(notebook, index);
  const cell = notebook.cellAt(index);
  const outputs = parseOutputs(cell.outputs);
  return {
    index,
    executionOrder: cell.executionSummary?.executionOrder ?? null,
    success: cell.executionSummary?.success,
    timing: cell.executionSummary?.timing,
    outputs,
    markdown: outputs.length > 0 ? formatOutputsAsMarkdown(outputs) : "",
    outputCount: outputs.length,
    capturedAt: Date.now()
  };
}

async function insertCell(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const type = params.type === "markdown" ? "markdown" : "code";
  const cellKind = type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
  const cellId = generateCellId();
  const cellData = new vscode.NotebookCellData(cellKind, String(params.content ?? ""), type === "code" ? String(params.language ?? "python") : "markdown");
  cellData.metadata = {
    id: cellId,
    notebookMcp: {
      lastAgentAction: "insert",
      lastAgentActionAt: Date.now()
    }
  };

  const insertIndex = params.index === undefined ? notebook.cellCount : Math.min(Number(params.index), notebook.cellCount);
  await insertCells(notebook.uri, insertIndex, [cellData]);

  const cell = notebook.getCells().find((candidate) => candidate.metadata.id === cellId);
  if (!cell) {
    throw new Error("Failed to create cell.");
  }

  const cellIndex = notebook.getCells().indexOf(cell);
  getNotebookEditor(notebook)?.revealRange(new vscode.NotebookRange(cellIndex, cellIndex + 1), vscode.NotebookEditorRevealType.InCenter);
  const inserted = { cellIndex, type, language: cell.document.languageId };
  if (params.execute === true) {
    if (type !== "code") {
      throw new Error("Only code cells can be executed after insertion.");
    }
    return {
      ...inserted,
      execution: await runCell(notebook, cellIndex, Number(params.timeout_ms ?? 60_000))
    };
  }
  return inserted;
}

async function editCell(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const index = Number(params.index);
  assertCellUnlocked(notebook, index);
  await editCellContent(notebook.cellAt(index), String(params.content ?? ""));
  await markAgentAction(notebook, index, "edit");
  return { index, updated: true };
}

async function deleteCell(notebook: vscode.NotebookDocument, index: number): Promise<unknown> {
  assertCellUnlocked(notebook, index);
  await deleteCells(notebook.uri, index, 1);
  return { deletedIndex: index, newCellCount: notebook.cellCount };
}

async function moveNotebookCell(notebook: vscode.NotebookDocument, fromIndex: number, toIndex: number): Promise<unknown> {
  assertCellUnlocked(notebook, fromIndex);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= notebook.cellCount) {
    throw new Error(`Target cell index ${toIndex} out of range.`);
  }
  await moveCell(notebook, fromIndex, toIndex);
  await markAgentAction(notebook, toIndex, "move");
  return { fromIndex, toIndex, moved: true };
}

async function bulkAddCells(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const cells = params.cells as Array<{ content: string; type?: "code" | "markdown"; language?: string }>;
  const insertIndex = params.index === undefined ? notebook.cellCount : Math.min(Number(params.index), notebook.cellCount);
  const cellData = cells.map((cell) => {
    const type = cell.type ?? "code";
    return new vscode.NotebookCellData(
      type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
      cell.content,
      type === "code" ? cell.language ?? "python" : "markdown"
    );
  });
  const timestamp = Date.now();
  cellData.forEach((cell) => {
    cell.metadata = {
      ...(cell.metadata ?? {}),
      id: generateCellId(),
      notebookMcp: {
        lastAgentAction: "bulk_insert",
        lastAgentActionAt: timestamp
      }
    };
  });
  await insertCells(notebook.uri, insertIndex, cellData);
  return { insertedAt: insertIndex, count: cellData.length };
}

function insertionIndex(notebook: vscode.NotebookDocument, params: JsonRecord): number {
  const anchors = [params.before_cell_id, params.after_cell_id, params.index, params.position].filter((value) => value !== undefined);
  if (anchors.length > 1) {
    throw new Error("Insert operation accepts only one position: before_cell_id, after_cell_id, index, or position.");
  }
  if (params.before_cell_id !== undefined) {
    return resolveCellIndex(notebook, { cell_id: params.before_cell_id });
  }
  if (params.after_cell_id !== undefined) {
    return resolveCellIndex(notebook, { cell_id: params.after_cell_id }) + 1;
  }
  if (params.index !== undefined) {
    return Math.min(Number(params.index), notebook.cellCount);
  }
  return params.position === "start" ? 0 : notebook.cellCount;
}

async function editCells(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const operations = params.operations as JsonRecord[];
  const results: unknown[] = [];

  for (const operation of operations) {
    if (operation.op === "insert") {
      const cells = operation.cells as Array<{ content: string; type?: "code" | "markdown"; language?: string }>;
      const index = insertionIndex(notebook, operation);
      const cellData = cells.map((cell) => {
        const type = cell.type ?? "code";
        const data = new vscode.NotebookCellData(
          type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
          cell.content,
          type === "code" ? cell.language ?? "python" : "markdown"
        );
        data.metadata = {
          id: generateCellId(),
          notebookMcp: {
            lastAgentAction: "insert",
            lastAgentActionAt: Date.now()
          }
        };
        return data;
      });
      await insertCells(notebook.uri, index, cellData);
      results.push({
        op: "insert",
        inserted_at: index,
        cells: cellData.map((cell, offset) => ({
          index: index + offset,
          cell_id: cell.metadata?.id,
          type: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown"
        }))
      });
      continue;
    }

    if (operation.op === "update") {
      if (operation.content === undefined && operation.type === undefined) {
        throw new Error("Update operation requires content, type, or both.");
      }
      const index = resolveCellIndex(notebook, operation);
      assertCellUnlocked(notebook, index);
      const cell = notebook.cellAt(index);
      const nextType = operation.type === "markdown" ? "markdown" : operation.type === "code" ? "code" : cellType(cell);
      const nextContent = operation.content === undefined ? cell.document.getText() : String(operation.content);
      const nextData = new vscode.NotebookCellData(
        nextType === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
        nextContent,
        nextType === "code" ? String(operation.language ?? cell.document.languageId ?? "python") : "markdown"
      );
      nextData.metadata = withAgentAction(cell.metadata, nextType === cellType(cell) ? "edit" : "edit_change_type");
      nextData.outputs = nextType === "code" ? cell.outputs.slice() : [];
      nextData.executionSummary = nextType === "code" ? cell.executionSummary : undefined;
      await replaceCells(notebook, [{ index, data: nextData }]);
      results.push({ op: "update", index, cell_id: cellIdentifier(notebook.cellAt(index), index), updated: true });
      continue;
    }

    if (operation.op === "delete") {
      const index = resolveCellIndex(notebook, operation);
      assertCellUnlocked(notebook, index);
      await deleteCells(notebook.uri, index, 1);
      results.push({ op: "delete", deleted_index: index });
    }
  }

  return { applied: results.length, results, cell_count: notebook.cellCount };
}

async function moveNotebookCells(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  if (!Array.isArray(params.cell_ids) && !Array.isArray(params.indexes)) {
    throw new Error("Provide cell_ids or indexes to move.");
  }
  if ([params.before_cell_id, params.after_cell_id, params.to_index].filter((value) => value !== undefined).length !== 1) {
    throw new Error("Provide exactly one destination: before_cell_id, after_cell_id, or to_index.");
  }
  const indexes = params.cell_ids !== undefined
    ? (params.cell_ids as unknown[]).map((cellId) => resolveCellIndex(notebook, { cell_id: cellId }))
    : (params.indexes as unknown[]).map(Number);
  const uniqueIndexes = [...new Set(indexes)].sort((a, b) => a - b);
  if (uniqueIndexes.length === 0) {
    throw new Error("No cells selected for move.");
  }
  for (const index of uniqueIndexes) {
    assertCellUnlocked(notebook, index);
  }

  const destination = params.before_cell_id !== undefined
    ? resolveCellIndex(notebook, { cell_id: params.before_cell_id })
    : params.after_cell_id !== undefined
      ? resolveCellIndex(notebook, { cell_id: params.after_cell_id }) + 1
      : Number(params.to_index);
  if (!Number.isInteger(destination) || destination < 0 || destination > notebook.cellCount) {
    throw new Error(`Target cell index ${destination} out of range.`);
  }
  if (uniqueIndexes.some((index) => index === destination || index + 1 === destination)) {
    throw new Error("Move destination must be outside the moved cell block.");
  }

  const data = uniqueIndexes.map((index) => cellDataFromCell(notebook.cellAt(index), {
    metadata: withAgentAction(notebook.cellAt(index).metadata, "move")
  }));
  await applyNotebookEdits(notebook, uniqueIndexes.slice().reverse().map((index) =>
    vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(index, index + 1))
  ));

  const deletedBeforeDestination = uniqueIndexes.filter((index) => index < destination).length;
  const insertIndex = Math.max(0, Math.min(destination - deletedBeforeDestination, notebook.cellCount));
  await insertCells(notebook.uri, insertIndex, data);
  return {
    moved: data.length,
    inserted_at: insertIndex,
    cells: data.map((cell, offset) => ({
      index: insertIndex + offset,
      cell_id: cell.metadata?.id
    }))
  };
}

async function clearOutputs(notebook: vscode.NotebookDocument, index: number): Promise<unknown> {
  assertCellUnlocked(notebook, index);
  const cell = notebook.cellAt(index);
  await replaceCells(notebook, [{
    index,
    data: cellDataFromCell(cell, {
      metadata: withAgentAction(cell.metadata, "clear_outputs"),
      outputs: [],
      executionSummary: cell.executionSummary
    })
  }]);
  return { index, cleared: true };
}

async function clearOutputsScoped(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const scope = String(params.scope ?? "cell");
  const clearExecutionCounts = params.clear_execution_counts === true;
  if (scope === "notebook") {
    return clearExecutionCounts ? stripOutputs(notebook) : clearAllOutputs(notebook);
  }
  const index = resolveCellIndex(notebook, params);
  if (!clearExecutionCounts) {
    return clearOutputs(notebook, index);
  }
  assertCellUnlocked(notebook, index);
  const cell = notebook.cellAt(index);
  await replaceCells(notebook, [{
    index,
    data: cellDataFromCell(cell, {
      metadata: withAgentAction(cell.metadata, "clear_outputs"),
      outputs: [],
      executionSummary: undefined
    })
  }]);
  return { index, cleared: true, executionCountCleared: true };
}

async function clearAllOutputs(notebook: vscode.NotebookDocument): Promise<unknown> {
  const edits = notebook.getCells()
    .filter((cell) => cell.outputs.length > 0)
    .map((cell) => {
      if (isCellLocked(cell)) {
        throw new Error(`Cell ${cell.index} is locked for Notebook MCP agent edits.`);
      }
      return {
        index: cell.index,
        data: cellDataFromCell(cell, {
          metadata: withAgentAction(cell.metadata, "clear_all_outputs"),
          outputs: [],
          executionSummary: cell.executionSummary
        })
      };
    });
  await replaceCells(notebook, edits);
  return { cleared: true, cellCount: edits.length };
}

async function stripOutputs(notebook: vscode.NotebookDocument): Promise<unknown> {
  const edits = notebook.getCells()
    .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
    .map((cell) => {
      if (isCellLocked(cell)) {
        throw new Error(`Cell ${cell.index} is locked for Notebook MCP agent edits.`);
      }
      return {
        index: cell.index,
        data: cellDataFromCell(cell, {
          metadata: withAgentAction(cell.metadata, "strip_outputs"),
          outputs: [],
          executionSummary: undefined
        })
      };
    });
  await replaceCells(notebook, edits);
  return { cleared: true, cellCount: edits.length };
}

async function saveNotebook(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  if (params.path) {
    const target = pathToUri(String(params.path));
    if (notebook.uri.scheme === "file") {
      const saved = await notebook.save();
      if (!saved) {
        throw new Error(`Notebook save was not completed before copying ${notebook.uri.toString()}.`);
      }
      await vscode.workspace.fs.copy(notebook.uri, target, { overwrite: true });
      return { saved, copiedTo: target.toString() };
    } else {
      const content = renderNotebookJson(notebook);
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      return { saved: false, copiedTo: target.toString(), bytes: Buffer.byteLength(content) };
    }
  }
  const saved = await notebook.save();
  return { saved, uri: notebook.uri.toString() };
}

async function changeCellType(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const index = Number(params.index);
  assertCellUnlocked(notebook, index);
  const cell = notebook.cellAt(index);
  const type = params.type === "markdown" ? "markdown" : "code";
  const data = cellDataFromCell(cell, {
    kind: type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
    languageId: type === "code" ? String(params.language ?? cell.document.languageId ?? "python") : "markdown",
    metadata: withAgentAction(cell.metadata, "change_cell_type"),
    outputs: type === "code" ? cell.outputs.slice() : [],
    executionSummary: type === "code" ? cell.executionSummary : undefined
  });
  await replaceCells(notebook, [{ index, data }]);
  return { index, type, changed: true };
}

function getCellMetadata(notebook: vscode.NotebookDocument, index: number): unknown {
  assertCellIndex(notebook, index);
  return { index, metadata: notebook.cellAt(index).metadata ?? {} };
}

function getNotebookMetadata(notebook: vscode.NotebookDocument): unknown {
  return { metadata: notebook.metadata ?? {} };
}

async function setCellMetadata(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const index = Number(params.index);
  assertCellUnlocked(notebook, index);
  const metadata = asRecord(params.metadata);
  const cell = notebook.cellAt(index);
  const nextMetadata = withAgentAction(params.replace === true ? metadata : { ...asRecord(cell.metadata), ...metadata }, "set_cell_metadata");
  await applyNotebookEdits(notebook, [vscode.NotebookEdit.updateCellMetadata(index, nextMetadata)]);
  return { index, metadata: nextMetadata };
}

async function setNotebookMetadata(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const metadata = asRecord(params.metadata);
  const nextMetadata = params.replace === true ? metadata : { ...asRecord(notebook.metadata), ...metadata };
  await applyNotebookEdits(notebook, [vscode.NotebookEdit.updateNotebookMetadata(nextMetadata)]);
  return { metadata: nextMetadata };
}

async function findReplace(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const query = String(params.query ?? "");
  if (!query) {
    throw new Error("find_replace query must not be empty.");
  }
  const replacement = String(params.replacement ?? "");
  const caseSensitive = params.case_sensitive === true;
  const targetCellType = String(params.cell_type ?? "all");
  const edit = new vscode.WorkspaceEdit();
  const flags = caseSensitive ? "g" : "gi";
  const pattern = new RegExp(escapeRegExp(query), flags);
  let replacements = 0;
  const changedCells: number[] = [];

  for (const cell of notebook.getCells()) {
    const kind = cellType(cell);
    if (targetCellType !== "all" && kind !== targetCellType) {
      continue;
    }
    const text = cell.document.getText();
    const matches = text.match(pattern)?.length ?? 0;
    if (matches === 0) {
      continue;
    }
    assertCellUnlocked(notebook, cell.index);
    const nextText = text.replace(pattern, () => {
      return replacement;
    });
    replacements += matches;
    changedCells.push(cell.index);
    edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), nextText);
  }

  if (changedCells.length > 0) {
    await applyWorkspaceEdit(edit);
    for (const index of changedCells) {
      await markAgentAction(notebook, index, "find_replace");
    }
  }

  return { replacements, changedCells };
}

async function lockCell(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const index = resolveCellIndex(notebook, params);
  assertCellIndex(notebook, index);
  const locked = params.locked === true;
  const cell = notebook.cellAt(index);
  const metadata = withAgentAction(cell.metadata, locked ? "lock_cell" : "unlock_cell", { locked });
  await applyNotebookEdits(notebook, [vscode.NotebookEdit.updateCellMetadata(index, metadata)]);
  return { index, cell_id: cellIdentifier(notebook.cellAt(index), index), locked };
}

interface ExecutionBaseline {
  executionOrder?: number;
  endTime?: number;
  outputSignature: string;
  hadSummary: boolean;
}

function executionBaseline(cell: vscode.NotebookCell): ExecutionBaseline {
  return {
    executionOrder: cell.executionSummary?.executionOrder,
    endTime: cell.executionSummary?.timing?.endTime,
    outputSignature: outputSignature(cell),
    hadSummary: typeof cell.executionSummary?.success === "boolean"
  };
}

function outputSignature(cell: vscode.NotebookCell): string {
  return cell.outputs.map((output) =>
    output.items.map((item) => `${item.mime}:${item.data.byteLength}`).join(",")
  ).join("|");
}

function isFreshExecutionResult(cell: vscode.NotebookCell, baseline: ExecutionBaseline, requestedAt: number): boolean {
  const summary = cell.executionSummary;
  if (typeof summary?.success !== "boolean") {
    return false;
  }
  if (!baseline.hadSummary) {
    return true;
  }
  if (summary.timing?.endTime !== undefined && summary.timing.endTime >= requestedAt) {
    return true;
  }
  if (summary.executionOrder !== undefined && summary.executionOrder !== baseline.executionOrder) {
    return true;
  }
  return outputSignature(cell) !== baseline.outputSignature;
}

async function waitForFreshCellExecution(
  notebook: vscode.NotebookDocument,
  cellId: string,
  baseline: ExecutionBaseline,
  requestedAt: number,
  timeoutMs: number
): Promise<vscode.NotebookCell> {
  const timeout = timeoutMs <= 0 ? LONG_RUNNING_TIMEOUT_MS : timeoutMs;
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const cell = notebook.getCells().find((candidate) => candidate.metadata.id === cellId);
      if (!cell) {
        clearInterval(interval);
        reject(new Error("Cell not found while waiting for execution."));
        return;
      }

      if (isFreshExecutionResult(cell, baseline, requestedAt)) {
        clearInterval(interval);
        resolve(cell);
        return;
      }

      if (Date.now() - startedAt > timeout) {
        clearInterval(interval);
        reject(new Error("Cell execution timed out."));
      }
    }, 100);
  });
}

async function executeNotebookRange(notebook: vscode.NotebookDocument, start: number, end: number): Promise<void> {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start, end }],
    document: notebook.uri
  });
}

async function runCell(notebook: vscode.NotebookDocument, index: number, timeoutMs: number): Promise<unknown> {
  assertCellIndex(notebook, index);
  const cell = notebook.cellAt(index);
  if (cell.kind !== vscode.NotebookCellKind.Code) {
    throw new Error(`Cell ${index} is a markdown cell. Only code cells can be executed.`);
  }

  const cellId = await ensureCellId(notebook, index);
  const baseline = executionBaseline(notebook.cellAt(index));
  await markAgentAction(notebook, index, "run");

  const requestedAt = Date.now();
  await executeNotebookRange(notebook, index, index + 1);

  const executedCell = await waitForFreshCellExecution(notebook, cellId, baseline, requestedAt, timeoutMs);
  const outputs = parseOutputs(executedCell.outputs);
  return {
    success: executedCell.executionSummary?.success ?? false,
    executionOrder: executedCell.executionSummary?.executionOrder ?? null,
    outputs
  };
}

async function cancelExecution(notebook: vscode.NotebookDocument, index: number): Promise<unknown> {
  assertCellIndex(notebook, index);
  try {
    await vscode.commands.executeCommand("notebook.cell.cancelExecution", {
      ranges: [{ start: index, end: index + 1 }],
      document: notebook.uri
    });
    return { cancelled: true };
  } catch (error) {
    throw new Error(`Notebook cancellation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCellsInRange(notebook: vscode.NotebookDocument, startIndex: number, endIndex: number | undefined, timeoutMs: number): Promise<unknown> {
  const end = endIndex === undefined ? notebook.cellCount : endIndex;
  if (!Number.isInteger(startIndex) || !Number.isInteger(end) || startIndex < 0 || end > notebook.cellCount || startIndex > end) {
    throw new Error(`Invalid cell range: ${startIndex}-${end}.`);
  }

  const runnableIndexes = notebook.getCells(new vscode.NotebookRange(startIndex, end))
    .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
    .map((cell) => cell.index);
  const ids: Array<{ index: number; id: string; baseline: ExecutionBaseline }> = [];
  for (const index of runnableIndexes) {
    ids.push({
      index,
      id: await ensureCellId(notebook, index),
      baseline: executionBaseline(notebook.cellAt(index))
    });
    await markAgentAction(notebook, index, "run");
  }

  if (runnableIndexes.length === 0) {
    return { ran: 0, results: [] };
  }

  const requestedAt = Date.now();
  await executeNotebookRange(notebook, startIndex, end);

  const deadline = Date.now() + (timeoutMs <= 0 ? LONG_RUNNING_TIMEOUT_MS : timeoutMs);
  const results = [];
  for (const entry of ids) {
    const remaining = Math.max(1, deadline - Date.now());
    const executedCell = await waitForFreshCellExecution(notebook, entry.id, entry.baseline, requestedAt, remaining);
    results.push({
      index: entry.index,
      success: executedCell.executionSummary?.success ?? false,
      executionOrder: executedCell.executionSummary?.executionOrder ?? null,
      outputs: parseOutputs(executedCell.outputs)
    });
  }

  return { ran: results.length, results };
}

async function runNotebook(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const scope = String(params.scope ?? "cell");
  const waitMs = Number(params.wait_ms ?? 60_000);
  if (scope === "all") {
    return runCellsInRange(notebook, 0, undefined, waitMs);
  }
  if (scope === "range") {
    const start = params.start_cell_id !== undefined
      ? resolveCellIndex(notebook, { cell_id: params.start_cell_id })
      : Number(params.start_index ?? 0);
    const end = params.end_cell_id !== undefined
      ? resolveCellIndex(notebook, { cell_id: params.end_cell_id }) + 1
      : Number(params.end_index ?? notebook.cellCount);
    return runCellsInRange(notebook, start, end, waitMs);
  }
  if (scope === "code") {
    return runCode(notebook, {
      ...params,
      code: String(params.code ?? ""),
      language: "python",
      timeout_ms: waitMs
    });
  }
  const index = resolveCellIndex(notebook, params);
  return runCell(notebook, index, waitMs);
}

async function runCode(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const code = String(params.code ?? "");
  if (!code) {
    throw new Error("run_code code must not be empty.");
  }
  const cellId = generateCellId();
  const insertIndex = notebook.cellCount;
  const cellData = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, String(params.language ?? "python"));
  cellData.metadata = {
    id: cellId,
    notebookMcp: {
      scratch: true,
      lastAgentAction: "run_code",
      lastAgentActionAt: Date.now()
    }
  };
  await insertCells(notebook.uri, insertIndex, [cellData]);
  try {
    const result = await runCell(notebook, insertIndex, Number(params.timeout_ms ?? 60_000));
    return { ...result as Record<string, unknown>, scratchCellDeleted: true };
  } finally {
    const scratchIndex = notebook.getCells().findIndex((cell) => cell.metadata.id === cellId);
    if (scratchIndex >= 0) {
      await deleteCells(notebook.uri, scratchIndex, 1);
    }
  }
}

async function executeJupyterKernelCommand(notebook: vscode.NotebookDocument, command: string, action: string): Promise<unknown> {
  await vscode.window.showNotebookDocument(notebook, { preserveFocus: true, preview: false });
  try {
    await vscode.commands.executeCommand(command, notebook.uri);
  } catch (error) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      throw new Error(`Jupyter kernel ${action} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { action, requested: true, notebookUri: notebook.uri.toString() };
}

async function inspectVariable(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const name = String(params.name ?? "");
  if (!name.trim()) {
    throw new Error("inspect_variable name must not be empty.");
  }
  const code = [
    "import json",
    `__mcp_name = ${JSON.stringify(name)}`,
    "try:",
    "    __mcp_value = globals()[__mcp_name]",
    "    __mcp_info = {",
    "        'name': __mcp_name,",
    "        'type': f'{type(__mcp_value).__module__}.{type(__mcp_value).__name__}',",
    "        'repr': repr(__mcp_value)[:2000],",
    "        'shape': getattr(__mcp_value, 'shape', None),",
    "        'dtype': str(getattr(__mcp_value, 'dtype', '')) or None,",
    "        'dtypes': str(getattr(__mcp_value, 'dtypes', ''))[:2000] or None,",
    "        'columns': [str(c) for c in getattr(__mcp_value, 'columns', [])][:100],",
    "    }",
    "except Exception as __mcp_error:",
    "    __mcp_info = {'name': __mcp_name, 'error': f'{type(__mcp_error).__name__}: {__mcp_error}'}",
    "print('__NOTEBOOK_MCP_JSON__' + json.dumps(__mcp_info, default=str))"
  ].join("\n");
  return extractScratchJson(await runCode(notebook, { ...params, code }));
}

async function completePrefix(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const prefix = String(params.prefix ?? "");
  const code = [
    "import json, rlcompleter",
    `__mcp_prefix = ${JSON.stringify(prefix)}`,
    "__mcp_completer = rlcompleter.Completer(namespace=globals())",
    "__mcp_matches = sorted(set(__mcp_completer.global_matches(__mcp_prefix) + __mcp_completer.attr_matches(__mcp_prefix)))",
    "print('__NOTEBOOK_MCP_JSON__' + json.dumps({'prefix': __mcp_prefix, 'matches': __mcp_matches[:200]}))"
  ].join("\n");
  return extractScratchJson(await runCode(notebook, { ...params, code }));
}

async function kernelHistory(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const limit = Number(params.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("history limit must be an integer from 1 to 100.");
  }
  const code = [
    "import json",
    "try:",
    "    __mcp_ip = get_ipython()",
    `    __mcp_items = list(__mcp_ip.history_manager.get_tail(${limit}, include_latest=True)) if __mcp_ip else []`,
    "    __mcp_history = [{'session': s, 'line': l, 'source': src} for s, l, src in __mcp_items]",
    "except Exception as __mcp_error:",
    "    __mcp_history = []",
    "print('__NOTEBOOK_MCP_JSON__' + json.dumps({'history': __mcp_history}, default=str))"
  ].join("\n");
  return extractScratchJson(await runCode(notebook, { ...params, code }));
}

function getOutline(notebook: vscode.NotebookDocument): unknown {
  const outline = notebook.getCells().map((cell) => {
    const text = cell.document.getText();
    const lines = text.split("\n");
    const items: Array<{ type: string; level?: number; name: string; line: number }> = [];

    lines.forEach((line, lineNumber) => {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      const func = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      const klass = line.match(/^class\s+(\w+)/);
      if (heading) {
        items.push({ type: "heading", level: heading[1].length, name: heading[2].trim(), line: lineNumber });
      } else if (func) {
        items.push({ type: "function", name: func[1], line: lineNumber });
      } else if (klass) {
        items.push({ type: "class", name: klass[1], line: lineNumber });
      }
    });

    return {
      cellIndex: cell.index,
      cellType: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
      lineCount: lines.length,
      items
    };
  });

  return { outline };
}

async function searchNotebook(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const query = String(params.query ?? "");
  const caseSensitive = params.case_sensitive === true;
  const contextLines = Number(params.context_lines ?? 1);
  const action = String(params.action ?? "search");
  const replacement = String(params.replacement ?? "");
  const apply = params.apply === true;
  const targetCellType = String(params.cell_type ?? "all");
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const results: Array<{ cellIndex: number; cell_id: string; cellType: string; matches: Array<{ line: number; start: number; end: number; text: string; context?: string[] }> }> = [];
  const replaceEdit = new vscode.WorkspaceEdit();
  const changedCells: number[] = [];
  let replacementCount = 0;

  for (const cell of notebook.getCells()) {
    const kind = cellType(cell);
    if (targetCellType !== "all" && kind !== targetCellType) {
      continue;
    }
    const lines = cell.document.getText().split("\n");
    const matches: Array<{ line: number; start: number; end: number; text: string; context?: string[] }> = [];

    lines.forEach((line, lineNumber) => {
      const haystack = caseSensitive ? line : line.toLowerCase();
      let startAt = 0;
      while (query.length > 0) {
        const matchIndex = haystack.indexOf(searchQuery, startAt);
        if (matchIndex < 0) {
          break;
        }
        const start = Math.max(0, lineNumber - contextLines);
        const end = Math.min(lines.length, lineNumber + contextLines + 1);
        matches.push({
          line: lineNumber,
          start: matchIndex,
          end: matchIndex + query.length,
          text: line.trim().substring(0, 200),
          context: contextLines > 0 ? lines.slice(start, end) : undefined
        });
        startAt = matchIndex + Math.max(1, query.length);
      }
    });

    if (matches.length > 0) {
      if (action === "replace") {
        assertCellUnlocked(notebook, cell.index);
        replacementCount += matches.length;
        changedCells.push(cell.index);
        if (apply) {
          const flags = caseSensitive ? "g" : "gi";
          const nextText = cell.document.getText().replace(new RegExp(escapeRegExp(query), flags), replacement);
          replaceEdit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), nextText);
        }
      }
      results.push({
        cellIndex: cell.index,
        cell_id: cellIdentifier(cell, cell.index),
        cellType: kind,
        matches
      });
    }
  }

  if (action === "replace" && apply && changedCells.length > 0) {
    await applyWorkspaceEdit(replaceEdit);
    for (const index of changedCells) {
      await markAgentAction(notebook, index, "search_replace");
    }
  }

  return {
    query,
    action,
    applied: action === "replace" && apply,
    replacements: action === "replace" ? replacementCount : undefined,
    changedCells: action === "replace" ? changedCells : undefined,
    totalMatches: results.reduce((sum, result) => sum + result.matches.length, 0),
    results
  };
}

async function exportNotebook(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const format = String(params.format ?? "markdown");
  let content: string;
  let extension: string;

  if (format === "python") {
    extension = "py";
    content = notebook.getCells().map((cell) => {
      const text = cell.document.getText();
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        return `# %% [markdown]\n${text.split("\n").map((line) => `# ${line}`).join("\n")}`;
      }
      return `# %%\n${text}`;
    }).join("\n\n");
  } else if (format === "html") {
    extension = "html";
    const body = notebook.getCells().map((cell) => {
      const tag = cell.kind === vscode.NotebookCellKind.Markup ? "section" : "pre";
      return `<${tag} data-cell-index="${cell.index}">${escapeHtml(cell.document.getText())}</${tag}>`;
    }).join("\n");
    content = `<!doctype html>\n<html><body>\n${body}\n</body></html>\n`;
  } else {
    extension = "md";
    content = notebook.getCells().map((cell) => {
      const text = cell.document.getText();
      return cell.kind === vscode.NotebookCellKind.Code ? `\`\`\`${cell.document.languageId}\n${text}\n\`\`\`` : text;
    }).join("\n\n");
  }

  if (params.path) {
    const uri = pathToUri(String(params.path));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return { format, path: uri.toString(), bytes: Buffer.byteLength(content) };
  }

  return { format, suggestedExtension: extension, content };
}

async function getKernelInfo(notebook: vscode.NotebookDocument): Promise<unknown> {
  const kernel = await getKernel(notebook);
  return {
    language: kernel?.language || "unknown",
    status: kernel?.status || "unknown",
    notebookUri: notebook.uri.toString()
  };
}

async function getKernelInfoCombined(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const include = new Set(Array.isArray(params.include) ? params.include.map(String) : ["spec", "context"]);
  const payload: JsonRecord = {};
  if (include.has("spec")) {
    payload.spec = await getKernelInfo(notebook);
  }
  if (include.has("context") || include.has("variables") || include.has("history")) {
    payload.context = await getKernelContext(notebook, {
      ...params,
      include_variables: include.has("variables") || include.has("context"),
      include_history: include.has("history") || include.has("context")
    });
  }
  return payload;
}

async function executeKernelControl(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const action = String(params.action ?? "");
  if (action === "restart") {
    return executeJupyterKernelCommand(notebook, "jupyter.restartkernel", "restart");
  }
  if (action === "interrupt") {
    return executeJupyterKernelCommand(notebook, "jupyter.interruptkernel", "interrupt");
  }
  throw new Error(`Unknown kernel control action: ${action}`);
}

function extractScratchJson(result: unknown): unknown {
  const outputs = (result as { outputs?: Array<{ type: string; text?: string }> }).outputs ?? [];
  for (const output of outputs) {
    if (output.type !== "text" || !output.text) {
      continue;
    }
    const markerIndex = output.text.indexOf("__NOTEBOOK_MCP_JSON__");
    if (markerIndex >= 0) {
      const remainder = output.text.slice(markerIndex + "__NOTEBOOK_MCP_JSON__".length);
      const jsonText = remainder.split(/\r?\n/, 1)[0].trim();
      return JSON.parse(jsonText);
    }
  }
  return { error: "Scratch execution did not return structured JSON.", result };
}

function renderNotebookJson(notebook: vscode.NotebookDocument): string {
  return `${JSON.stringify({
    cells: notebook.getCells().map((cell) => ({
      cell_type: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
      execution_count: cell.executionSummary?.executionOrder ?? null,
      metadata: cell.metadata ?? {},
      outputs: cell.kind === vscode.NotebookCellKind.Code ? cell.outputs.map((output) => serializeNotebookOutput(output, cell)) : [],
      source: cell.document.getText().split(/(?<=\n)/)
    })),
    metadata: notebook.metadata ?? {},
    nbformat: 4,
    nbformat_minor: 5
  }, null, 2)}\n`;
}

function serializeNotebookOutput(output: vscode.NotebookCellOutput, cell: vscode.NotebookCell): JsonRecord {
  const errorItem = output.items.find((item) => item.mime === ERROR_MIME);
  if (errorItem) {
    const error = parseErrorOutput(errorItem);
    return {
      output_type: "error",
      ename: error.name,
      evalue: error.message,
      traceback: error.stack ? error.stack.split("\n") : []
    };
  }

  const outputMetadata = asRecord(output.metadata);
  const outputType = String(outputMetadata.outputType ?? outputMetadata.name ?? "").toLowerCase();
  const streamName = outputType.includes("stderr") ? "stderr" : outputType.includes("stdout") ? "stdout" : undefined;
  if (streamName) {
    return {
      output_type: "stream",
      name: streamName,
      text: splitLinesKeepEnds(output.items.map(decodeOutputItem).join(""))
    };
  }

  const data: JsonRecord = {};
  for (const item of output.items) {
    data[item.mime] = serializeMimeItem(item);
  }
  const executionOrder = cell.executionSummary?.executionOrder ?? null;
  return {
    output_type: executionOrder === null ? "display_data" : "execute_result",
    execution_count: executionOrder,
    data,
    metadata: asRecord(outputMetadata.metadata)
  };
}

function parseErrorOutput(item: vscode.NotebookCellOutputItem): { name: string; message: string; stack: string } {
  try {
    const parsed = JSON.parse(decodeOutputItem(item)) as Partial<{ name: string; message: string; stack: string }>;
    return {
      name: parsed.name ?? "Error",
      message: parsed.message ?? "Unknown error",
      stack: parsed.stack ?? ""
    };
  } catch {
    return { name: "Error", message: decodeOutputItem(item), stack: "" };
  }
}

function serializeMimeItem(item: vscode.NotebookCellOutputItem): unknown {
  if (item.mime === "application/json" || item.mime.endsWith("+json")) {
    try {
      return JSON.parse(decodeOutputItem(item));
    } catch {
      return decodeOutputItem(item);
    }
  }
  if (item.mime.startsWith("image/")) {
    return Buffer.from(item.data).toString("base64");
  }
  return decodeOutputItem(item);
}

function decodeOutputItem(item: vscode.NotebookCellOutputItem): string {
  return new TextDecoder().decode(item.data);
}

function splitLinesKeepEnds(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getKernelContext(notebook: vscode.NotebookDocument, params: BackendParams): Promise<unknown> {
  const history = params.include_history === false ? [] : notebook.getCells()
    .filter((cell) => cell.kind === vscode.NotebookCellKind.Code && cell.executionSummary?.executionOrder)
    .sort((a, b) => (a.executionSummary?.executionOrder ?? 0) - (b.executionSummary?.executionOrder ?? 0))
    .slice(-10)
    .map((cell) => ({
      index: cell.index,
      executionOrder: cell.executionSummary?.executionOrder ?? null,
      code: cell.document.getText().substring(0, 500),
      hasOutput: cell.outputs.length > 0,
      outputs: parseOutputs(cell.outputs).slice(0, 1)
    }));

  return {
    kernel: await getKernelInfo(notebook),
    recent_cells: history
  };
}

async function getKernel(notebook: vscode.NotebookDocument): Promise<any> {
  const extension = vscode.extensions.getExtension("ms-toolsai.jupyter");
  if (!extension) {
    return undefined;
  }
  const jupyter = extension.isActive ? extension.exports : await extension.activate();
  return jupyter?.kernels?.getKernel?.(notebook) ?? jupyter?.kernels?.getKernel?.(notebook.uri);
}
