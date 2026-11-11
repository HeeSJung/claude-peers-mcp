import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parseSoliosAddress, deliverSoliosReply } from "./solios-reply.ts";
import { parseSessionAddress } from "./session-address.ts";
import type { BrokerRequest } from "./shared/types.ts";

/** A fake Solios daemon: records every reply and answers with `verdict`. */
function fakeDaemon() {
  const state = {
    hits: [] as { path: string; secret: string | null; body: unknown }[],
    verdict: (() => Response.json({ ok: true, ts: 1 })) as () => Response,
    server: null as ReturnType<typeof Bun.serve> | null,
  };
  state.server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      state.hits.push({
        path: new URL(req.url).pathname,
        secret: req.headers.get("x-solios-secret"),
        body: await req.json(),
      });
      return state.verdict();
    },
  });
  return state;
}

async function waitHealthy(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
}

async function post<T>(port: number, path: string, body: BrokerRequest): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

describe("parseSoliosAddress", () => {
  test.each([
    ["solios:2026-11-11-a1b2c3", "2026-11-11-a1b2c3"],
    ["solios:gh:sooth#12", "gh:sooth#12"],
  ])("%p → thread %p", (addr, thread) => {
    expect(parseSoliosAddress(addr)).toBe(thread);
  });

  test.each(["solios:", "solios:a b", "solios:x\n", "solios:x@oregon", "SOLIOS:x", "side:x", "abc12345"])(
    "returns null for %p",
    (addr) => {
      expect(parseSoliosAddress(addr)).toBeNull();
    },
  );

  test("is not a session address: the daemon inbox never sees it", () => {
    expect(parseSessionAddress("solios:2026-11-11-a1b2c3")).toBeNull();
  });
});

describe("deliverSoliosReply: daemon faked at the HTTP seam", () => {
  let d: ReturnType<typeof fakeDaemon>;
  let url: string;
  beforeAll(() => {
    d = fakeDaemon();
    url = `http://127.0.0.1:${d.server!.port}`;
  });
  afterAll(() => d.server!.stop(true));
  beforeEach(() => {
    d.hits = [];
    d.verdict = () => Response.json({ ok: true, ts: 1 });
  });

  test("POSTs {thread_id, content} to /api/v1/reply with the secret; 200 → ok", async () => {
    const r = await deliverSoliosReply("2026-11-11-a1b2c3", "준비됐어요\n\"quoted\"", { baseUrl: url, secret: "s3cret" });
    expect(r).toEqual({ ok: true });
    expect(d.hits).toEqual([
      {
        path: "/api/v1/reply",
        secret: "s3cret",
        body: { thread_id: "2026-11-11-a1b2c3", content: "준비됐어요\n\"quoted\"" },
      },
    ]);
  });

  test("the daemon's JSON refusal comes back as the error, with the status", async () => {
    d.verdict = () => Response.json({ ok: false, error: "reply: unknown thread" }, { status: 400 });
    const r = await deliverSoliosReply("nope", "x", { baseUrl: url, secret: "s" });
    expect(r).toEqual({ ok: false, error: "Solios daemon refused thread nope (400): reply: unknown thread" });
  });

  test("a plain-text refusal is relayed verbatim", async () => {
    d.verdict = () => new Response("unauthorized", { status: 401 });
    const r = await deliverSoliosReply("t1", "x", { baseUrl: url, secret: "bad" });
    expect(r).toEqual({ ok: false, error: "Solios daemon refused thread t1 (401): unauthorized" });
  });

  test("daemon unreachable → failed send naming the daemon", async () => {
    const r = await deliverSoliosReply("t1", "x", { baseUrl: "http://127.0.0.1:1", secret: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Solios daemon unreachable");
  });
});

describe("broker /send-message: solios:<thread_id> on the daemon's server", () => {
  const ROOT = `/tmp/solios-reply-test-${process.pid}`;
  const PORT = 36969;
  let broker: Subprocess | null = null;
  let d: ReturnType<typeof fakeDaemon>;
  const sleepers: Subprocess[] = [];
  let seat = "";

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    d = fakeDaemon();
    broker = spawn({
      cmd: ["bun", new URL("./broker.ts", import.meta.url).pathname],
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG_DIR: ROOT,
        CLAUDE_PEERS_DB: join(ROOT, "db.sqlite"),
        CLAUDE_PEERS_PORT: String(PORT),
        CLAUDE_PEERS_PEER_PORT: String(PORT + 1),
        CLAUDE_PEERS_TICKET_INBOX_URL: `http://127.0.0.1:${d.server!.port}`,
        SOOTH_KEEP_MCP_SECRET: "daemon-secret",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitHealthy(PORT);
    const sleeper = spawn({ cmd: ["sleep", "60"] });
    sleepers.push(sleeper);
    seat = (await post<{ id: string }>(PORT, "/register", { pid: sleeper.pid, cwd: ROOT, git_root: null, tty: null, summary: "" })).id;
  }, 20_000);

  afterAll(async () => {
    for (const s of sleepers) s.kill();
    broker?.kill("SIGTERM");
    await broker?.exited;
    d.server!.stop(true);
    rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    d.hits = [];
    d.verdict = () => Response.json({ ok: true, ts: 1 });
  });

  test("the content lands on the daemon's reply endpoint with that thread id", async () => {
    const r = await post(PORT, "/send-message", { from_id: seat, to_id: "solios:2026-11-11-a1b2c3", text: "수업 자료 준비됐어요" });
    expect(r).toEqual({ ok: true });
    expect(d.hits).toEqual([
      {
        path: "/api/v1/reply",
        secret: "daemon-secret",
        body: { thread_id: "2026-11-11-a1b2c3", content: "수업 자료 준비됐어요" },
      },
    ]);
  });

  test("the daemon's refusal comes back to the sender as {ok:false, error}", async () => {
    d.verdict = () => Response.json({ ok: false, error: "reply: thread_id is required" }, { status: 400 });
    const r = await post<{ ok: boolean; error?: string }>(PORT, "/send-message", {
      from_id: seat,
      to_id: "solios:2026-11-11-a1b2c3",
      text: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reply: thread_id is required");
  });
});

describe("two brokers: an office seat on another server answers a Solios thread", () => {
  const ROOT = `/tmp/solios-reply-two-brokers-${process.pid}`;
  const THREAD = "2026-11-11-a1b2c3";
  const B = {
    oregon: { dir: join(ROOT, "oregon"), port: 36979, proc: null as Subprocess | null },
    helsinki: { dir: join(ROOT, "helsinki"), port: 36989, proc: null as Subprocess | null },
  };
  let d: ReturnType<typeof fakeDaemon>;
  const sleepers: Subprocess[] = [];
  let seat = "";

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    d = fakeDaemon();
    const names = ["oregon", "helsinki"] as const;
    for (const [i, self] of names.entries()) {
      const other = names[1 - i]!;
      mkdirSync(B[self].dir, { recursive: true });
      writeFileSync(join(B[self].dir, "secret-current"), String(i + 1).repeat(64));
      chmodSync(join(B[self].dir, "secret-current"), 0o600);
      writeFileSync(
        join(B[self].dir, "brokers.json"),
        JSON.stringify({
          schema: 1,
          self_machine: self,
          self_ts_addr: `127.0.0.1:${B[self].port + 1}`,
          peers: [
            {
              machine: other,
              ts_addr: `127.0.0.1:${B[other].port + 1}`,
              ssh_alias: `__test_secret__:${B[other].dir}/secret-current`,
            },
          ],
        }),
      );
    }
    for (const self of names) {
      B[self].proc = spawn({
        cmd: ["bun", new URL("./broker.ts", import.meta.url).pathname],
        env: {
          ...process.env,
          CLAUDE_PEERS_CONFIG_DIR: B[self].dir,
          CLAUDE_PEERS_DB: join(B[self].dir, "db.sqlite"),
          CLAUDE_PEERS_PORT: String(B[self].port),
          CLAUDE_PEERS_PEER_PORT: String(B[self].port + 1),
          CLAUDE_PEERS_BIND_TS_IP: "127.0.0.1",
          CLAUDE_PEERS_SECRET_FETCH_TEST_MODE: "1",
          // Only Oregon runs the daemon; Helsinki's loopback has none.
          CLAUDE_PEERS_TICKET_INBOX_URL: self === "oregon" ? `http://127.0.0.1:${d.server!.port}` : "http://127.0.0.1:1",
          SOOTH_KEEP_MCP_SECRET: "daemon-secret",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    for (const self of names) await waitHealthy(B[self].port);
    const sleeper = spawn({ cmd: ["sleep", "60"] });
    sleepers.push(sleeper);
    seat = (
      await post<{ id: string }>(B.helsinki.port, "/register", {
        pid: sleeper.pid,
        cwd: join(ROOT, "homes", "may"),
        git_root: null,
        tty: null,
        summary: "",
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    for (const s of sleepers) s.kill();
    for (const b of Object.values(B)) {
      b.proc?.kill("SIGTERM");
      await b.proc?.exited;
    }
    d.server!.stop(true);
    rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    d.hits = [];
    d.verdict = () => Response.json({ ok: true, ts: 1 });
  });

  test("the prompt reaches the live seat from solios:<thread_id>@oregon", async () => {
    const sent = await post(B.oregon.port, "/send-message", {
      from_id: `solios:${THREAD}`,
      to_id: `${seat}@helsinki`,
      text: "오늘 수업 준비 됐어?",
    });
    expect(sent).toEqual({ ok: true });
    const inbox = await post<{ messages: { from_id: string; text: string }[] }>(B.helsinki.port, "/poll-messages", {
      id: seat,
    });
    expect(inbox.messages).toEqual([
      expect.objectContaining({ from_id: `solios:${THREAD}@oregon`, text: "오늘 수업 준비 됐어?" }),
    ]);
  });

  test("the seat's reply to that sender lands in the thread on Oregon's daemon", async () => {
    const r = await post(B.helsinki.port, "/send-message", {
      from_id: seat,
      to_id: `solios:${THREAD}@oregon`,
      text: "네, 준비됐어요",
    });
    expect(r).toEqual({ ok: true });
    expect(d.hits).toEqual([
      { path: "/api/v1/reply", secret: "daemon-secret", body: { thread_id: THREAD, content: "네, 준비됐어요" } },
    ]);
  });

  test("Oregon's daemon refusal comes back to the seat on Helsinki with the reason", async () => {
    d.verdict = () => Response.json({ ok: false, error: "reply: content is required" }, { status: 400 });
    const r = await post<{ ok: boolean; error?: string }>(B.helsinki.port, "/send-message", {
      from_id: seat,
      to_id: `solios:${THREAD}@oregon`,
      text: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reply: content is required");
  });
});
