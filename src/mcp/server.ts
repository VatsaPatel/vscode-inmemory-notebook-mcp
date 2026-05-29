export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: unknown) => Promise<unknown>;
}

export class NotebookMcpServer {
  private readonly tools = new Map<string, RegisteredTool>();

  tool(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (params: unknown) => Promise<unknown>
  ): void {
    this.tools.set(name, {
      name,
      description,
      inputSchema: inputSchemaFromShape(shape),
      handler
    });
  }

  listTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args ?? {});
  }
}

function inputSchemaFromShape(shape: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = jsonSchemaForZod(schema);
    if (!isOptionalLike(schema)) {
      required.push(key);
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {})
  };
}

function jsonSchemaForZod(schema: unknown): Record<string, unknown> {
  const def = zodDef(schema);
  const typeName = def?.typeName;
  const description = typeof (schema as { description?: unknown }).description === "string"
    ? (schema as { description: string }).description
    : undefined;

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return withDescription(jsonSchemaForZod(def.innerType), description);
  }
  if (typeName === "ZodString") {
    return withDescription({ type: "string" }, description);
  }
  if (typeName === "ZodNumber") {
    return withDescription({ type: "number" }, description);
  }
  if (typeName === "ZodBoolean") {
    return withDescription({ type: "boolean" }, description);
  }
  if (typeName === "ZodEnum") {
    return withDescription({ type: "string", enum: def.values }, description);
  }
  if (typeName === "ZodLiteral") {
    const value = def.value;
    return withDescription({ const: value, type: typeof value }, description);
  }
  if (typeName === "ZodArray") {
    return withDescription({ type: "array", items: jsonSchemaForZod(def.type) }, description);
  }
  if (typeName === "ZodObject") {
    return withDescription(inputSchemaFromShape(def.shape()), description);
  }
  if (typeName === "ZodDiscriminatedUnion") {
    return withDescription({ oneOf: Array.from(def.options.values()).map(jsonSchemaForZod) }, description);
  }
  if (typeName === "ZodUnion") {
    return withDescription({ oneOf: def.options.map(jsonSchemaForZod) }, description);
  }

  return withDescription({}, description);
}

function withDescription(schema: Record<string, unknown>, description: string | undefined): Record<string, unknown> {
  return description ? { ...schema, description } : schema;
}

function isOptionalLike(schema: unknown): boolean {
  const typeName = zodDef(schema)?.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

function zodDef(schema: unknown): any {
  return (schema as { _def?: unknown } | undefined)?._def;
}
