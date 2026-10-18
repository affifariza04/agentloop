import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/tools/calculator.js";
import { fileTools, resolveInside } from "../src/tools/files.js";
import { htmlToText, httpGet, isPrivateAddress } from "../src/tools/http.js";

const signal = new AbortController().signal;

describe("calculator", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", 4],
    ["10 % 4", 2],
    ["sqrt(16) + abs(-3)", 7],
    ["round(pi * 100) / 100", 3.14],
    ["1.5e3 / 3", 500],
  ])("%s = %d", (expr, expected) => {
    expect(evaluate(expr)).toBeCloseTo(expected);
  });

  it.each(["1 / 0", "2 +", "foo(1)", "1 2", "process.exit()", "(1"])("rejects %s", (expr) => {
    expect(() => evaluate(expr)).toThrow();
  });
});

describe("file tools", () => {
  it("reads inside the workspace and blocks path traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentloop-"));
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "a.txt"), "hello");
    await writeFile(path.join(root, "secret.txt"), "top secret");
    const [list, read] = fileTools(root);

    expect(await list!.run({ dir: "." }, { signal })).toEqual(["notes/", "secret.txt"]);
    expect(await read!.run({ path: "notes/a.txt" }, { signal })).toBe("hello");
    await expect(resolveInside(path.join(root, "notes"), "../secret.txt")).rejects.toThrow(/outside/);
    await expect(read!.run({ path: "../../etc/passwd" }, { signal })).rejects.toThrow();
  });
});

describe("http_get", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses to fetch loopback and metadata endpoints", async () => {
    await expect(httpGet.run({ url: "http://127.0.0.1:8080/" }, { signal })).rejects.toThrow(/private/);
    await expect(httpGet.run({ url: "http://169.254.169.254/latest" }, { signal })).rejects.toThrow(/private/);
    await expect(httpGet.run({ url: "http://localhost/" }, { signal })).rejects.toThrow(/private/);
  });

  it("only accepts http(s) URLs", () => {
    expect(httpGet.schema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(httpGet.schema.safeParse({ url: "https://example.com" }).success).toBe(true);
  });

  it("strips markup", () => {
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><script>x()</script>")).toBe("Hi there");
  });
});
