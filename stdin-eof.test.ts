/**
 * stdin EOF is the shutdown signal (sooth-os/sooth#1505).
 *
 * When the parent claude is SIGKILLed, the MCP child gets no signal; only its
 * stdin closes. server.ts must treat that EOF like SIGTERM: unregister from
 * the broker and exit, and still exit when the broker hangs on /unregister.
 * The broker is faked at the HTTP seam so the test never touches :7899.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";

const SERVER = new URL("./server.ts", import.meta.url).pathname;
const PEER_ID = "eoftest1";

function fakeBroker(opts: { hangUnregister?: boolean } = {}) {
  const calls: string[] = [];
  const peers = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(path);
      if (path === "/health") return Response.json({ status: "ok" });
      if (path === "/register") {
        peers.add(PEER_ID);
        return Response.json({ id: PEER_ID });
      }
      if (path === "/unregister") {
        if (opts.hangUnregister) await new Promise(() => {});
        peers.delete(PEER_ID);
        return Response.json({ ok: true });
      }
      if (path === "/poll-messages") return Response.json({ messages: [] });
      if (path === "/list-peers") return Response.json([...peers].map((id) => ({ id })));
      return Response.json({ ok: true });
    },
  });
  return { server, calls, peers };
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

let cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanupFns) f();
  cleanupFns = [];
});

function startServer(port: number) {
  const proc = spawn({
    cmd: ["bun", SERVER],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), OPENAI_API_KEY: "" },
  });
  cleanupFns.push(() => proc.kill(9));
  return proc;
}

async function exitWithin(proc: ReturnType<typeof startServer>, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

describe("server.ts on stdin EOF", () => {
  test("unregisters and exits within 2 s", async () => {
    const b = fakeBroker();
    cleanupFns.push(() => b.server.stop(true));
    const proc = startServer(b.server.port);

    expect(await waitFor(() => b.peers.has(PEER_ID), 10_000)).toBe(true);
    await Bun.sleep(300); // let the MCP transport attach
    proc.stdin.end();

    expect(await exitWithin(proc, 2000)).toBe(true);
    expect(b.calls).toContain("/unregister");
    expect(b.peers.has(PEER_ID)).toBe(false);
  }, 20_000);

  test("still exits within 2 s when the broker hangs on /unregister", async () => {
    const b = fakeBroker({ hangUnregister: true });
    cleanupFns.push(() => b.server.stop(true));
    const proc = startServer(b.server.port);

    expect(await waitFor(() => b.peers.has(PEER_ID), 10_000)).toBe(true);
    await Bun.sleep(300);
    proc.stdin.end();

    expect(await exitWithin(proc, 2000)).toBe(true);
    expect(b.calls).toContain("/unregister");
  }, 20_000);
});
