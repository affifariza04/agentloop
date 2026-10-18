import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { defineTool } from "../tool.js";

/** Loopback, private, link-local (cloud metadata) and unique-local ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export const httpGet = defineTool({
  name: "http_get",
  description: "Fetch a public web page or JSON endpoint and return its text content.",
  timeoutMs: 20_000,
  schema: z.object({ url: z.url({ protocol: /^https?$/ }) }),
  run: async ({ url }, { signal }) => {
    // SSRF guard: a model can be prompt-injected into probing internal services.
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, "");
    const { address } = isIP(host) ? { address: host } : await lookup(host);
    if (host === "localhost" || isPrivateAddress(address)) {
      throw new Error("Refusing to fetch a private or loopback address");
    }

    const res = await fetch(url, { signal, redirect: "error" });
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    return {
      status: res.status,
      contentType: type,
      text: (type.includes("html") ? htmlToText(body) : body).slice(0, 6_000),
    };
  },
});
