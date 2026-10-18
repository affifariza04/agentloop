/**
 * Defining a custom tool and running the agent with a real model.
 *   ANTHROPIC_API_KEY=... npx tsx examples/custom-tool.ts
 */
import { z } from "zod";
import { Agent, AnthropicProvider, calculator, defineTool, GeminiProvider } from "../src/index.js";

const inventory: Record<string, { stock: number; price: number }> = {
  "kopi-arabika-250g": { stock: 14, price: 85_000 },
  "kopi-robusta-250g": { stock: 0, price: 60_000 },
  "teh-melati-100g": { stock: 31, price: 25_000 },
};

const checkStock = defineTool({
  name: "check_stock",
  description: "Look up stock level and unit price (IDR) for a product SKU.",
  schema: z.object({ sku: z.enum(Object.keys(inventory) as [string, ...string[]]) }),
  run: ({ sku }) => inventory[sku],
});

const agent = new Agent({
  provider: process.env.ANTHROPIC_API_KEY ? new AnthropicProvider() : new GeminiProvider(),
  tools: [checkStock, calculator],
  system: "You are a shop assistant. Always check stock before quoting a price.",
  onEvent: (e) => e.type === "tool_start" && console.log(`→ ${e.call.name}`, e.call.input),
});

const result = await agent.run(
  "A customer wants 3 arabika and 2 robusta. What can we sell them, and what's the total?",
);
console.log(`\n${result.output}\n(${result.steps} steps, ${result.toolCalls} tool calls)`);
