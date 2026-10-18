#!/usr/bin/env node
import { Agent, type AgentEvent } from "./agent.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { calculator } from "./tools/calculator.js";
import { clock } from "./tools/clock.js";
import { fileTools } from "./tools/files.js";
import { httpGet } from "./tools/http.js";
import type { ModelProvider } from "./types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function pickProvider(): ModelProvider {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (process.env.GEMINI_API_KEY) return new GeminiProvider();
  console.error("Set ANTHROPIC_API_KEY or GEMINI_API_KEY to run the agent.");
  process.exit(1);
}

function trace(e: AgentEvent): void {
  if (e.type === "model") {
    const calls = e.turn.toolCalls.map((c) => c.name).join(", ");
    console.error(dim(`[step ${e.step}] model ${e.ms.toFixed(0)} ms${calls ? ` → ${calls}` : ""}`));
  } else if (e.type === "tool_start") {
    console.error(cyan(`  ↳ ${e.call.name}(${JSON.stringify(e.call.input)})`));
  } else {
    const preview = e.result.output.replace(/\s+/g, " ").slice(0, 120);
    console.error((e.result.isError ? red : dim)(`    ${e.ms.toFixed(0)} ms: ${preview}`));
  }
}

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: agentloop "your task"');
  process.exit(1);
}

const agent = new Agent({
  provider: pickProvider(),
  tools: [calculator, clock, httpGet, ...fileTools(process.cwd())],
  onEvent: trace,
});

const result = await agent.run(prompt);
console.log(`\n${result.output}`);
console.error(
  dim(
    `\n${result.status} · ${result.steps} steps · ${result.toolCalls} tool calls · ` +
      `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`,
  ),
);
