import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CompletionRequest, Message, ModelProvider, ModelTurn, StopReason } from "../types.js";

export interface AnthropicProviderOptions {
  model?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

export function toAnthropicMessages(messages: Message[], providerName: string): BetaMessageParam[] {
  return messages.map((m): BetaMessageParam => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content };
      case "assistant": {
        // Replay our own blocks verbatim (keeps thinking blocks valid);
        // rebuild from the neutral form when the turn came from another provider.
        if (m.provider === providerName && Array.isArray(m.raw)) {
          return { role: "assistant", content: m.raw as BetaContentBlockParam[] };
        }
        const content: BetaContentBlockParam[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
        }
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.callId,
            content: r.output,
            is_error: r.isError,
          })),
        };
    }
  });
}

const STOP: Record<string, StopReason> = {
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

export function fromAnthropicContent(content: BetaContentBlock[], stopReason: string | null) {
  const text = content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  const toolCalls = content.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
  );
  return { text, toolCalls, stop: STOP[stopReason ?? ""] ?? "end" };
}

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: NonNullable<AnthropicProviderOptions["effort"]>;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.effort = opts.effort ?? "high";
    this.client = opts.client ?? new Anthropic();
    this.name = `anthropic:${this.model}`;
  }

  async complete(req: CompletionRequest): Promise<ModelTurn> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages, this.name),
        tools: req.tools.map(
          (t): BetaTool => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as BetaTool.InputSchema,
          }),
        ),
        output_config: { effort: this.effort },
        // On a policy decline the API retries on its default fallback model
        // within the same call instead of ending the run.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal: req.signal },
    );

    return {
      ...fromAnthropicContent(response.content, response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      raw: response.content,
    };
  }
}
