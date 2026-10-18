import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../tool.js";

/**
 * Resolves a model-supplied path inside `root`. Symlinks are resolved first,
 * so a link pointing outside the sandbox is rejected too.
 */
export async function resolveInside(root: string, requested: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(path.resolve(realRoot, requested));
  const rel = path.relative(realRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Access denied: "${requested}" is outside the workspace`);
  }
  return target;
}

export function fileTools(root: string, { maxBytes = 64_000 } = {}) {
  const listFiles = defineTool({
    name: "list_files",
    description: "List files and folders in a workspace directory.",
    schema: z.object({ dir: z.string().default(".").describe("Path relative to the workspace") }),
    run: async ({ dir }) => {
      const target = await resolveInside(root, dir);
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    },
  });

  const readFileTool = defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    schema: z.object({ path: z.string().min(1).describe("Path relative to the workspace") }),
    run: async ({ path: p }) => {
      const target = await resolveInside(root, p);
      const info = await stat(target);
      if (info.size > maxBytes) throw new Error(`File is ${info.size} bytes; limit is ${maxBytes}`);
      return readFile(target, "utf8");
    },
  });

  return [listFiles, readFileTool] as const;
}
