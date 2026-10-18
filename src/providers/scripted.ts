import type { CompletionRequest, ModelProvider, ModelTurn } from "../types.js";

type Step = Partial<ModelTurn> | ((req: CompletionRequest) => Partial<ModelTurn>);

/**
 * Deterministic provider that replays a fixed script. Used in tests and for
 * demos without an API key; it also records every request it receives so
 * tests can assert on exactly what the model would have seen.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  private index = 0;

  constructor(private readonly script: Step[]) {}

  async complete(req: CompletionRequest): Promise<ModelTurn> {
    // Snapshot: the agent keeps appending to the same array.
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const step = this.script[this.index++];
    if (!step) throw new Error("ScriptedProvider ran out of steps");
    const turn = typeof step === "function" ? step(req) : step;
    const toolCalls = turn.toolCalls ?? [];
    return {
      text: turn.text ?? "",
      toolCalls,
      stop: turn.stop ?? (toolCalls.length ? "tool_use" : "end"),
      usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
    };
  }
}
