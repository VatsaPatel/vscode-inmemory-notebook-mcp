import { z } from "zod";

import { CellIndexSchema, ResponseFormatSchema } from "../schemas/index.js";

export const NotebookUriSchema = z.string().min(1).describe("Notebook URI from notebook_status or notebook_open.");

export const ExecutionIdInputSchema = z.object({
  operation_id: z.string().min(1),
  response_format: ResponseFormatSchema
}).strict();

export const OpenNotebookInputSchema = z.object({
  path: z.string().min(1),
  response_format: ResponseFormatSchema
}).strict();

export const CreateNotebookInputSchema = z.object({
  path: z.string().min(1).optional(),
  kernel_language: z.string().default("python"),
  initial_content: z.string().default(""),
  response_format: ResponseFormatSchema
}).strict();

export const SaveNotebookInputSchema = z.object({
  path: z.string().min(1).optional(),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export const ExportNotebookInputSchema = z.object({
  format: z.enum(["python", "markdown", "html"]).default("markdown"),
  path: z.string().min(1).optional(),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const CellIdSchema = z.string().min(1);
const CellRefShape = {
  cell_id: CellIdSchema.optional(),
  index: CellIndexSchema.optional()
};

const CellPayloadSchema = z.object({
  content: z.string(),
  type: z.enum(["code", "markdown"]).default("code"),
  language: z.string().default("python")
}).strict();

export const StatusInputSchema = z.object({
  include: z.array(z.enum(["health", "open_notebooks", "executions"])).default(["health", "open_notebooks"]),
  response_format: ResponseFormatSchema
}).strict();

export const HelpInputSchema = z.object({
  task: z.enum(["explore", "edit", "run", "long_running", "recover", "save"]).optional(),
  response_format: ResponseFormatSchema
}).strict();

export const ReadNotebookInputSchema = z.object({
  cell_ids: z.array(CellIdSchema).optional(),
  indexes: z.array(CellIndexSchema).optional(),
  include_outputs: z.enum(["none", "summary", "full"]).default("summary"),
  include_metadata: z.boolean().default(false),
  max_output_chars: z.number().int().min(100).max(20000).default(2000),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export const SearchNotebookInputSchema = z.object({
  query: z.string().min(1),
  action: z.enum(["search", "replace"]).default("search"),
  replacement: z.string().default(""),
  apply: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  context_lines: z.number().int().min(0).max(5).default(1),
  cell_type: z.enum(["code", "markdown", "all"]).default("all"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const InsertCellsOperationSchema = z.object({
  op: z.literal("insert"),
  cells: z.array(CellPayloadSchema).min(1),
  index: z.number().int().min(0).optional(),
  before_cell_id: CellIdSchema.optional(),
  after_cell_id: CellIdSchema.optional(),
  position: z.enum(["start", "end"]).optional()
}).strict();

const UpdateCellOperationSchema = z.object({
  op: z.literal("update"),
  ...CellRefShape,
  content: z.string().optional(),
  type: z.enum(["code", "markdown"]).optional(),
  language: z.string().default("python")
}).strict();

const DeleteCellOperationSchema = z.object({
  op: z.literal("delete"),
  ...CellRefShape
}).strict();

export const EditCellsInputSchema = z.object({
  operations: z.array(z.discriminatedUnion("op", [
    InsertCellsOperationSchema,
    UpdateCellOperationSchema,
    DeleteCellOperationSchema
  ])).min(1),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export const MoveCellsInputSchema = z.object({
  cell_ids: z.array(CellIdSchema).optional(),
  indexes: z.array(CellIndexSchema).optional(),
  before_cell_id: CellIdSchema.optional(),
  after_cell_id: CellIdSchema.optional(),
  to_index: z.number().int().min(0).optional(),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export const ClearOutputsInputSchema = z.object({
  scope: z.enum(["cell", "notebook"]).default("cell"),
  cell_id: CellIdSchema.optional(),
  index: CellIndexSchema.optional(),
  clear_execution_counts: z.boolean().default(false),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export function validateClearOutputsInput(value: z.infer<typeof ClearOutputsInputSchema>): void {
  if (value.scope === "cell" && value.cell_id === undefined && value.index === undefined) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: "scope='cell' requires cell_id or index", path: ["cell_id"] }]);
  }
}

export const LockCellByRefInputSchema = z.object({
  cell_id: CellIdSchema.optional(),
  index: CellIndexSchema.optional(),
  locked: z.boolean(),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export const RunNotebookInputSchema = z.object({
  scope: z.enum(["cell", "range", "all", "code"]).default("cell"),
  cell_id: CellIdSchema.optional(),
  index: CellIndexSchema.optional(),
  start_cell_id: CellIdSchema.optional(),
  start_index: CellIndexSchema.optional(),
  end_cell_id: CellIdSchema.optional(),
  end_index: z.number().int().min(0).optional(),
  code: z.string().optional(),
  wait_ms: z.number().int().min(0).max(3_600_000).default(60_000),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export function validateRunNotebookInput(value: z.infer<typeof RunNotebookInputSchema>): void {
  if (value.scope === "cell" && value.cell_id === undefined && value.index === undefined) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: "scope='cell' requires cell_id or index", path: ["cell_id"] }]);
  }
  if (value.scope === "range") {
    if (value.start_cell_id === undefined && value.start_index === undefined) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: "scope='range' requires start_cell_id or start_index", path: ["start_index"] }]);
    }
    if (value.end_cell_id === undefined && value.end_index === undefined) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: "scope='range' requires end_cell_id or end_index", path: ["end_index"] }]);
    }
  }
  if (value.scope === "code" && (value.code === undefined || value.code.length === 0)) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: "scope='code' requires a non-empty code string", path: ["code"] }]);
  }
}

export const OperationInputSchema = z.object({
  operation_id: z.string().min(1).optional(),
  wait_ms: z.number().int().min(0).max(3_600_000).default(0),
  include_partial: z.boolean().default(true),
  response_format: ResponseFormatSchema
}).strict();

export const KernelInfoInputSchema = z.object({
  include: z.array(z.enum(["spec", "context", "variables", "history"])).default(["spec", "context"]),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export const KernelControlInputSchema = z.object({
  action: z.enum(["restart", "interrupt"]),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();
