# agentloop

**A small, provider-agnostic AI agent runtime in TypeScript: typed tools, a hardened tool-calling loop, and adapters for Claude and Gemini.**

![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![tests](https://img.shields.io/badge/tests-38%20passing-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

Agent frameworks hide the loop, but the loop is where production agents fail: hallucinated tool names, malformed arguments, tools that hang, models that call tools forever, and half-written tool calls from truncated responses. agentloop is about 400 lines that handle each of those explicitly, with a test for every one.

```ts
import { z } from "zod";
import { Agent, AnthropicProvider, defineTool, calculator } from "agentloop";

const checkStock = defineTool({
  name: "check_stock",
  description: "Look up stock level and unit price for a SKU.",
  schema: z.object({ sku: z.string() }),
  run: async ({ sku }) => db.products.find(sku),   // `sku` is typed from the schema
});

const agent = new Agent({ provider: new AnthropicProvider(), tools: [checkStock, calculator] });
const { output, steps, usage } = await agent.run("What do 3 arabika and 2 robusta cost?");
```

## How the loop works

```
 user ─▶ ┌────────────┐   tool calls   ┌──────────────────────────────────────┐
         │   model    │ ─────────────▶ │ for each call, in parallel:          │
         │ (provider) │                │  1. known tool?   no → error result  │
         │            │ ◀───────────── │  2. Zod-validate  bad → error result │
         └─────┬──────┘  all results   │  3. run with timeout + abort signal  │
               │         in ONE msg    │  4. serialise + truncate output      │
               │                       └──────────────────────────────────────┘
               ▼
     stop when: no tool calls · maxSteps · max_tokens · refusal · aborted
```

Errors are **returned to the model as tool results**, not thrown. Models are good at fixing a call when you tell them what was wrong (`Invalid input: ✖ expected string → at expression`), and the run survives.

## Features

| | |
|---|---|
| **Typed tools** | One Zod schema gives the TypeScript type of `run(input)`, the runtime validation of model output, and the JSON Schema sent to the model. They can't drift apart. |
| **Provider-agnostic** | The loop speaks a neutral message format. `AnthropicProvider` (official SDK, `claude-opus-5-5`, server-side refusal fallback) and `GeminiProvider` (REST, `gemini-2.5-flash`) translate it. Adding a provider means implementing one `complete()` method. |
| **State-preserving replay** | Each provider's raw content blocks are replayed verbatim on the next turn. Claude thinking blocks and Gemini thought signatures stay valid across tool calls. |
| **Parallel tool calls** | Independent calls run concurrently and their results go back in a single message (tested: three 150 ms tools finish in under 400 ms). |
| **Guard rails** | Per-tool timeouts, `maxSteps`, output truncation, `AbortSignal` cancellation, and no execution of tool calls from a `max_tokens`-truncated turn. |
| **Observability** | `onEvent` streams `model` / `tool_start` / `tool_end` events with timings. Results include token usage and step counts. |
| **Secure built-in tools** | `calculator` uses a recursive-descent parser instead of `eval`. `read_file`/`list_files` are sandboxed to a root, including symlink escapes. `http_get` blocks private IPs, cloud metadata endpoints, and redirects (SSRF). |

## Quick start

```bash
git clone https://github.com/affifariza04/agentloop && cd agentloop
npm install
npm test                     # 38 tests, no API key needed

export ANTHROPIC_API_KEY=... # or GEMINI_API_KEY=... (free tier available)
npm run agent -- "What time is it in Jakarta, and how many days until 1 January 2027?"
```

Illustrative trace (timings and token counts vary):

```
[step 1] model 2140 ms → current_time
  ↳ current_time({"timeZone":"Asia/Jakarta"})
    1 ms: {"timeZone":"Asia/Jakarta","local":"Sunday 18 October 2026 at 23:20:11 GMT+7",...}
[step 2] model 1630 ms → calculator
  ↳ calculator({"expression":"13 + 30 + 31"})
...
done · 3 steps · 2 tool calls · 2911 in / 214 out tokens
```

There is a custom-tool example in [`examples/custom-tool.ts`](examples/custom-tool.ts).

## Testing without a model

`ScriptedProvider` replays a fixed script and records every request, so agent behaviour is unit-testable and deterministic:

```ts
const provider = new ScriptedProvider([
  { toolCalls: [{ id: "1", name: "calculator", input: { expr: "1+1" } }] },        // wrong arg name
  { toolCalls: [{ id: "2", name: "calculator", input: { expression: "1+1" } }] },  // model self-corrects
  { text: "2" },
]);
const r = await new Agent({ provider, tools: [calculator] }).run("1+1");
expect(r.status).toBe("done");
expect(provider.requests[1].messages.at(-1)).toMatchObject({ role: "tool", results: [{ isError: true }] });
```

The provider adapters are tested against mocked SDK and `fetch` responses, including wire-format mapping, refusals, and thought-part filtering.

## Project layout

```
src/
├── agent.ts              the loop: validation, timeouts, parallelism, stop conditions
├── tool.ts               defineTool + Zod → JSON Schema
├── types.ts              provider-neutral messages
├── providers/
│   ├── anthropic.ts      Claude via @anthropic-ai/sdk
│   ├── gemini.ts         Gemini via REST
│   └── scripted.ts       deterministic test double
├── tools/                calculator · current_time · http_get · read_file/list_files
└── cli.ts                `npm run agent -- "task"` with a live trace
```

## Design decisions

- **Why not LangChain or the vendor tool runners?** They're good for shipping. This project is about owning the control flow: one place to add approval gates, budgets, or tracing, and no dependence on one vendor's message shape.
- **Why return errors instead of throwing?** One bad argument shouldn't kill a 10-step run. The model sees the error and retries, and `maxSteps` bounds the worst case.
- **Why ignore tool calls on `max_tokens`?** The JSON arguments may be cut off mid-object. Running them would act on input the model never finished writing.

## Roadmap

- Streaming responses with incremental tool-input parsing
- Human-in-the-loop approval hook (`beforeTool`)
- Token-budget stop condition and conversation compaction
- An OpenAI-compatible provider for local models (Ollama, vLLM)

MIT licensed.
