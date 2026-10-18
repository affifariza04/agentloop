import { z } from "zod";
import { type Tool, toSpec } from "./tool.js";
import type {
  Message,
  ModelProvider,
  ModelTurn,
  ToolCall,
  ToolResult,
  Usage,
} from "./types.js";

export type AgentEvent =
  | { type: "model"; step: number; turn: ModelTurn; ms: number }
  | { type: "tool_start"; step: number; call: ToolCall }
  | { type: "tool_end"; step: number; result: ToolResult; ms: number };

export interface AgentOptions {
  provider: ModelProvider;
  tools?: Tool[];
  system?: string;
  /** Hard cap on model calls per run; protects against tool-call loops. */
  maxSteps?: number;
  toolTimeoutMs?: number;
  /** Tool output is truncated to this many characters before the model sees it. */
  maxToolOutputChars?: number;
  onEvent?: (event: AgentEvent) => void;
}

export type RunStatus = "done" | "max_steps" | "max_tokens" | "refusal" | "aborted";

export interface RunResult {
  output: string;
  status: RunStatus;
  steps: number;
  toolCalls: number;
  usage: Usage;
  messages: Message[];
}

const DEFAULT_SYSTEM =
  "You are a careful assistant. Use the provided tools when they help; " +
  "if a tool returns an error, read it and try a corrected call instead of guessing.";

export class Agent {
  readonly provider: ModelProvider;
  readonly system: string;
  readonly maxSteps: number;
  readonly toolTimeoutMs: number;
  readonly maxToolOutputChars: number;
  private readonly tools = new Map<string, Tool>();
  private readonly onEvent?: (event: AgentEvent) => void;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.system = opts.system ?? DEFAULT_SYSTEM;
    this.maxSteps = opts.maxSteps ?? 8;
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 15_000;
    this.maxToolOutputChars = opts.maxToolOutputChars ?? 8_000;
    this.onEvent = opts.onEvent;
    for (const tool of opts.tools ?? []) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  async run(input: string | Message[], opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const messages: Message[] =
      typeof input === "string" ? [{ role: "user", content: input }] : [...input];
    const specs = [...this.tools.values()].map(toSpec);
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    let lastText = "";

    const finish = (status: RunStatus, steps: number): RunResult => ({
      output: lastText,
      status,
      steps,
      toolCalls,
      usage,
      messages,
    });

    for (let step = 1; step <= this.maxSteps; step++) {
      if (opts.signal?.aborted) return finish("aborted", step - 1);

      const started = performance.now();
      const turn = await this.provider.complete({
        system: this.system,
        messages,
        tools: specs,
        signal: opts.signal,
      });
      this.onEvent?.({ type: "model", step, turn, ms: performance.now() - started });

      usage.inputTokens += turn.usage?.inputTokens ?? 0;
      usage.outputTokens += turn.usage?.outputTokens ?? 0;
      if (turn.text) lastText = turn.text;
      messages.push({
        role: "assistant",
        text: turn.text,
        toolCalls: turn.toolCalls,
        raw: turn.raw,
        provider: this.provider.name,
      });

      // A truncated turn may carry half-written tool input; never execute it.
      if (turn.stop === "max_tokens") return finish("max_tokens", step);
      if (turn.stop === "refusal") return finish("refusal", step);
      if (turn.toolCalls.length === 0) return finish("done", step);

      // Independent calls run concurrently; results go back in one message.
      const results = await Promise.all(
        turn.toolCalls.map((call) => this.execute(call, step, opts.signal)),
      );
      toolCalls += results.length;
      messages.push({ role: "tool", results });
    }
    return finish("max_steps", this.maxSteps);
  }

  private async execute(call: ToolCall, step: number, runSignal?: AbortSignal): Promise<ToolResult> {
    this.onEvent?.({ type: "tool_start", step, call });
    const started = performance.now();
    const result = await this.invoke(call, runSignal);
    this.onEvent?.({ type: "tool_end", step, result, ms: performance.now() - started });
    return result;
  }

  private async invoke(call: ToolCall, runSignal?: AbortSignal): Promise<ToolResult> {
    const fail = (output: string): ToolResult => ({
      callId: call.id,
      name: call.name,
      output,
      isError: true,
    });

    const tool = this.tools.get(call.name);
    if (!tool) {
      return fail(`Unknown tool "${call.name}". Available tools: ${[...this.tools.keys()].join(", ")}.`);
    }

    // Model output is untrusted input: validate before running anything.
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) return fail(`Invalid input:\n${z.prettifyError(parsed.error)}`);

    const timeoutMs = tool.timeoutMs ?? this.toolTimeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(runSignal?.reason);
    runSignal?.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Tool timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });
      const value = await Promise.race([
        Promise.resolve(tool.run(parsed.data, { signal: controller.signal })),
        timeout,
      ]);
      return {
        callId: call.id,
        name: call.name,
        output: this.truncate(typeof value === "string" ? value : JSON.stringify(value)),
        isError: false,
      };
    } catch (err) {
      return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      runSignal?.removeEventListener("abort", onAbort);
    }
  }

  private truncate(text: string | undefined): string {
    const s = text ?? "";
    if (s.length <= this.maxToolOutputChars) return s;
    const dropped = s.length - this.maxToolOutputChars;
    return `${s.slice(0, this.maxToolOutputChars)}\n…[truncated ${dropped} characters]`;
  }
}
