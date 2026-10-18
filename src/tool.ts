import { z } from "zod";
import type { ToolSpec } from "./types.js";

export interface ToolContext {
  /** Aborted when the tool times out or the whole run is cancelled. */
  signal: AbortSignal;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Overrides the agent-wide tool timeout. */
  timeoutMs?: number;
  run(input: z.infer<S>, ctx: ToolContext): unknown;
}

/**
 * Identity helper that gives `run` a typed `input` inferred from the Zod
 * schema. The same schema validates model output at runtime and produces the
 * JSON Schema the model sees, so the two can never drift apart.
 */
export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

export function toSpec(tool: Tool): ToolSpec {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema: schema };
}
