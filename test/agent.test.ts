import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.js";
import { ScriptedProvider } from "../src/providers/scripted.js";
import { defineTool, toSpec } from "../src/tool.js";
import { calculator } from "../src/tools/calculator.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const slow = defineTool({
  name: "slow",
  description: "waits",
  schema: z.object({ ms: z.number() }),
  run: async ({ ms }) => {
    await sleep(ms);
    return `slept ${ms}`;
  },
});

describe("Agent loop", () => {
  it("returns the model's answer when no tools are called", async () => {
    const agent = new Agent({ provider: new ScriptedProvider([{ text: "Hello!" }]) });
    const r = await agent.run("hi");
    expect(r).toMatchObject({ output: "Hello!", status: "done", steps: 1, toolCalls: 0 });
  });

  it("runs a tool and feeds the result back to the model", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "calculator", input: { expression: "2^10 + 1" } }] },
      (req) => {
        const last = req.messages.at(-1);
        expect(last?.role).toBe("tool");
        return { text: "The answer is 1025." };
      },
    ]);
    const r = await new Agent({ provider, tools: [calculator] }).run("2^10+1?");
    expect(r.status).toBe("done");
    expect(r.output).toBe("The answer is 1025.");
    const toolMsg = provider.requests[1]!.messages.at(-1);
    expect(toolMsg).toMatchObject({
      role: "tool",
      results: [{ callId: "1", isError: false, output: '{"expression":"2^10 + 1","result":1025}' }],
    });
  });

  it("executes parallel tool calls concurrently and returns them in one message", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "a", name: "slow", input: { ms: 150 } },
          { id: "b", name: "slow", input: { ms: 150 } },
          { id: "c", name: "slow", input: { ms: 150 } },
        ],
      },
      { text: "done" },
    ]);
    const t0 = performance.now();
    const r = await new Agent({ provider, tools: [slow] }).run("go");
    expect(performance.now() - t0).toBeLessThan(400);
    expect(r.toolCalls).toBe(3);
    const msg = provider.requests[1]!.messages.at(-1);
    expect(msg?.role === "tool" && msg.results.map((x) => x.callId)).toEqual(["a", "b", "c"]);
  });

  it("returns validation errors to the model so it can self-correct", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "calculator", input: { expr: "1+1" } }] },
      { toolCalls: [{ id: "2", name: "calculator", input: { expression: "1+1" } }] },
      { text: "2" },
    ]);
    const r = await new Agent({ provider, tools: [calculator] }).run("1+1");
    const first = provider.requests[1]!.messages.at(-1);
    expect(first?.role === "tool" && first.results[0]).toMatchObject({ isError: true });
    expect(first?.role === "tool" && first.results[0]!.output).toContain("expression");
    expect(r).toMatchObject({ status: "done", output: "2", steps: 3 });
  });

  it("reports unknown tools and thrown errors as tool errors, not crashes", async () => {
    const boom = defineTool({
      name: "boom",
      description: "throws",
      schema: z.object({}),
      run: () => {
        throw new Error("kaboom");
      },
    });
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "1", name: "nope", input: {} },
          { id: "2", name: "boom", input: {} },
        ],
      },
      { text: "ok" },
    ]);
    await new Agent({ provider, tools: [boom] }).run("x");
    const msg = provider.requests[1]!.messages.at(-1);
    if (msg?.role !== "tool") throw new Error("expected tool message");
    expect(msg.results[0]!.output).toMatch(/Unknown tool "nope". Available tools: boom/);
    expect(msg.results[1]).toMatchObject({ isError: true, output: "Error: kaboom" });
  });

  it("times out slow tools", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "slow", input: { ms: 1_000 } }] },
      { text: "gave up" },
    ]);
    await new Agent({ provider, tools: [slow], toolTimeoutMs: 50 }).run("x");
    const msg = provider.requests[1]!.messages.at(-1);
    expect(msg?.role === "tool" && msg.results[0]!.output).toBe("Error: Tool timed out after 50 ms");
  });

  it("stops at maxSteps when the model keeps calling tools", async () => {
    const loop = { toolCalls: [{ id: "1", name: "calculator", input: { expression: "1" } }] };
    const provider = new ScriptedProvider(Array(10).fill(loop));
    const r = await new Agent({ provider, tools: [calculator], maxSteps: 3 }).run("x");
    expect(r).toMatchObject({ status: "max_steps", steps: 3, toolCalls: 3 });
  });

  it("does not execute tool calls from a truncated (max_tokens) turn", async () => {
    let ran = false;
    const spy = defineTool({
      name: "spy",
      description: "",
      schema: z.object({}),
      run: () => {
        ran = true;
      },
    });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "spy", input: {} }], stop: "max_tokens" },
    ]);
    const r = await new Agent({ provider, tools: [spy] }).run("x");
    expect(r.status).toBe("max_tokens");
    expect(ran).toBe(false);
  });

  it("truncates oversized tool output", async () => {
    const big = defineTool({ name: "big", description: "", schema: z.object({}), run: () => "x".repeat(500) });
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "1", name: "big", input: {} }] }, { text: "" }]);
    await new Agent({ provider, tools: [big], maxToolOutputChars: 100 }).run("x");
    const msg = provider.requests[1]!.messages.at(-1);
    expect(msg?.role === "tool" && msg.results[0]!.output).toMatch(/^x{100}\n…\[truncated 400 characters\]$/);
  });

  it("emits trace events and accumulates usage", async () => {
    const events: AgentEvent["type"][] = [];
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "calculator", input: { expression: "1" } }] },
      { text: "1" },
    ]);
    const r = await new Agent({ provider, tools: [calculator], onEvent: (e) => events.push(e.type) }).run("x");
    expect(events).toEqual(["model", "tool_start", "tool_end", "model"]);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("honours an abort signal between steps", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      () => {
        controller.abort();
        return { toolCalls: [{ id: "1", name: "calculator", input: { expression: "1" } }] };
      },
      { text: "never" },
    ]);
    const r = await new Agent({ provider, tools: [calculator] }).run("x", { signal: controller.signal });
    expect(r.status).toBe("aborted");
    expect(provider.requests).toHaveLength(1);
  });

  it("rejects duplicate tool names", () => {
    expect(() => new Agent({ provider: new ScriptedProvider([]), tools: [calculator, calculator] })).toThrow(
      /Duplicate/,
    );
  });
});

describe("toSpec", () => {
  it("derives JSON Schema from the Zod schema", () => {
    const spec = toSpec(calculator);
    expect(spec.name).toBe("calculator");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    });
    expect(spec.inputSchema).not.toHaveProperty("$schema");
  });
});
