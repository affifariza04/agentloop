import type {
  CompletionRequest,
  Message,
  ModelProvider,
  ModelTurn,
  StopReason,
  ToolCall,
} from "../types.js";

/** Minimal slice of the Gemini REST schema that this provider uses. */
interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  [key: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiProviderOptions {
  model?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export function toGeminiContents(messages: Message[], providerName: string): GeminiContent[] {
  return messages.map((m): GeminiContent => {
    switch (m.role) {
      case "user":
        return { role: "user", parts: [{ text: m.content }] };
      case "assistant":
        // Raw parts carry thought signatures that Gemini requires on replay.
        if (m.provider === providerName && Array.isArray(m.raw)) {
          return { role: "model", parts: m.raw as GeminiPart[] };
        }
        return {
          role: "model",
          parts: [
            ...(m.text ? [{ text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.input } })),
          ],
        };
      case "tool":
        return {
          role: "user",
          parts: m.results.map((r) => ({
            functionResponse: {
              id: r.callId,
              name: r.name,
              response: r.isError ? { error: r.output } : { result: r.output },
            },
          })),
        };
    }
  });
}

const REFUSALS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

export class GeminiProvider implements ModelProvider {
  readonly name: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiProviderOptions = {}) {
    this.model = opts.model ?? "gemini-2.5-flash";
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.fetchImpl = opts.fetch ?? fetch;
    this.name = `gemini:${this.model}`;
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not set");
  }

  async complete(req: CompletionRequest): Promise<ModelTurn> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      signal: req.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: toGeminiContents(req.messages, this.name),
        tools: req.tools.length
          ? [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.inputSchema,
                })),
              },
            ]
          : undefined,
      }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const toolCalls: ToolCall[] = parts.flatMap((p, i) =>
      p.functionCall
        ? [{ id: p.functionCall.id ?? `call_${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }]
        : [],
    );
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();

    let stop: StopReason = toolCalls.length ? "tool_use" : "end";
    if (candidate?.finishReason === "MAX_TOKENS") stop = "max_tokens";
    if (!candidate || REFUSALS.has(candidate.finishReason ?? "")) stop = "refusal";

    return {
      text,
      toolCalls,
      stop,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      raw: parts,
    };
  }
}
