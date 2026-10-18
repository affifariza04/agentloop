import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { AnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.js";
import { GeminiProvider, toGeminiContents } from "../src/providers/gemini.js";
import { calculator } from "../src/tools/calculator.js";
import type { Message } from "../src/types.js";

const history: Message[] = [
  { role: "user", content: "what is 2+2" },
  { role: "assistant", text: "Let me check.", toolCalls: [{ id: "t1", name: "calculator", input: { expression: "2+2" } }] },
  { role: "tool", results: [{ callId: "t1", name: "calculator", output: "4", isError: false }] },
];

describe("Anthropic mapping", () => {
  it("converts neutral messages to Messages API params", () => {
    expect(toAnthropicMessages(history, "anthropic:x")).toEqual([
      { role: "user", content: "what is 2+2" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "t1", name: "calculator", input: { expression: "2+2" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "4", is_error: false }] },
    ]);
  });

  it("replays raw blocks (e.g. thinking) only for the same provider", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "hi" }];
    const msg: Message = { role: "assistant", text: "hi", toolCalls: [], raw, provider: "anthropic:x" };
    expect(toAnthropicMessages([msg], "anthropic:x")[0]!.content).toBe(raw);
    expect(toAnthropicMessages([msg], "anthropic:y")[0]!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("drives a full tool round trip through the SDK client", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "6*7" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "42" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 150, output_tokens: 5 },
      });
    const client = { beta: { messages: { create } } } as unknown as Anthropic;
    const agent = new Agent({ provider: new AnthropicProvider({ client }), tools: [calculator] });

    const r = await agent.run("6*7?");
    expect(r).toMatchObject({ output: "42", status: "done", usage: { inputTokens: 250, outputTokens: 25 } });

    const first = create.mock.calls[0]![0];
    expect(first).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    expect(first.tools[0]).toMatchObject({ name: "calculator", input_schema: { type: "object" } });

    const second = create.mock.calls[1]![0];
    expect(second.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"expression":"6*7","result":42}', is_error: false }],
    });
  });

  it("maps refusals to a refusal status", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [],
      stop_reason: "refusal",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const client = { beta: { messages: { create } } } as unknown as Anthropic;
    const r = await new Agent({ provider: new AnthropicProvider({ client }) }).run("x");
    expect(r.status).toBe("refusal");
  });
});

describe("Gemini mapping", () => {
  it("converts neutral messages to Gemini contents", () => {
    expect(toGeminiContents(history, "gemini:x")).toEqual([
      { role: "user", parts: [{ text: "what is 2+2" }] },
      {
        role: "model",
        parts: [{ text: "Let me check." }, { functionCall: { id: "t1", name: "calculator", args: { expression: "2+2" } } }],
      },
      { role: "user", parts: [{ functionResponse: { id: "t1", name: "calculator", response: { result: "4" } } }] },
    ]);
  });

  it("parses function calls and skips thought parts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  { text: "thinking...", thought: true },
                  { functionCall: { name: "calculator", args: { expression: "1+1" } }, thoughtSignature: "abc" },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
        }),
      ),
    );
    const provider = new GeminiProvider({ apiKey: "test", fetch: fetchMock as unknown as typeof fetch });
    const turn = await provider.complete({ system: "s", messages: [history[0]!], tools: [] });

    expect(turn).toMatchObject({
      text: "",
      stop: "tool_use",
      toolCalls: [{ id: "call_1", name: "calculator", input: { expression: "1+1" } }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("gemini-2.5-flash:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("test");
  });
});
