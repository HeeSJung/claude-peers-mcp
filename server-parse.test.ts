import { test, expect } from "bun:test";

/**
 * `server.ts` is the per-session MCP process; no other test imports it, so a syntax error in it
 * (fc0ee45 left unescaped quotes inside a tool description, 2026-11-08) reaches every session as
 * CONNECTION_CLOSED while `bun test` stays green. This is the parse gate: transpile, never run.
 */
test("server.ts parses", async () => {
  const src = await Bun.file(new URL("./server.ts", import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  expect(() => transpiler.transformSync(src)).not.toThrow();
});
