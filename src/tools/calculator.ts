import { z } from "zod";
import { defineTool } from "../tool.js";

/**
 * Recursive-descent arithmetic evaluator. Models are bad at exact arithmetic
 * and `eval` is a remote-code-execution hole, so the grammar is explicit:
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := power (("*" | "/" | "%") power)*
 *   power  := unary ("^" power)?          // right-associative
 *   unary  := "-" unary | call
 *   call   := ident "(" expr ")" | ident | number | "(" expr ")"
 */
const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluate(source: string): number {
  const tokens = source.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[a-z_]\w*|[-+*/%^()]|\S/gi) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t: string) => {
    if (next() !== t) throw new Error(`Expected "${t}"`);
  };

  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    for (let op = peek(); op === "*" || op === "/" || op === "%"; op = peek()) {
      next();
      const r = power();
      if (op !== "*" && r === 0) throw new Error("Division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const power = (): number => {
    const base = unary();
    if (peek() === "^") {
      next();
      return base ** power();
    }
    return base;
  };
  const unary = (): number => (peek() === "-" ? (next(), -unary()) : call());
  const call = (): number => {
    const t = next();
    if (t === undefined) throw new Error("Unexpected end of expression");
    if (t === "(") {
      const v = expr();
      expect(")");
      return v;
    }
    if (/^\d/.test(t)) return Number(t);
    const name = t.toLowerCase();
    if (name in FUNCTIONS) {
      expect("(");
      const v = expr();
      expect(")");
      return FUNCTIONS[name]!(v);
    }
    if (name in CONSTANTS) return CONSTANTS[name]!;
    throw new Error(`Unknown token "${t}"`);
  };

  const value = expr();
  if (pos < tokens.length) throw new Error(`Unexpected token "${peek()}"`);
  if (!Number.isFinite(value)) throw new Error("Result is not a finite number");
  return value;
}

export const calculator = defineTool({
  name: "calculator",
  description:
    "Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses, " +
    "sqrt, abs, round, floor, ceil, ln, log10, sin, cos, tan, pi and e.",
  schema: z.object({
    expression: z.string().min(1).max(500).describe("e.g. (1200 * 1.11) / 12"),
  }),
  run: ({ expression }) => ({ expression, result: evaluate(expression) }),
});
