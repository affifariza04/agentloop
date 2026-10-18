import { z } from "zod";
import { defineTool } from "../tool.js";

export const clock = defineTool({
  name: "current_time",
  description: "Get the current date and time in an IANA time zone.",
  schema: z.object({ timeZone: z.string().default("UTC").describe("e.g. Asia/Jakarta") }),
  run: ({ timeZone }) => {
    const now = new Date();
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
    return { timeZone, local, iso: now.toISOString() };
  },
});
