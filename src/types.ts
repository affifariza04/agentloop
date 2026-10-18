/**
 * Provider-neutral conversation model. Providers translate to and from their
 * own wire formats, so the agent loop never depends on a vendor SDK.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  isError: boolean;
}

export type Message =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /**
       * The provider's original content blocks. Replayed verbatim on the next
       * request so provider-specific state (thinking blocks, signatures)
       * survives the round trip.
       */
      raw?: unknown;
      provider?: string;
    }
  | { role: "tool"; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage?: Usage;
  raw?: unknown;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<ModelTurn>;
}
