import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_ADDRESS_PREFIXES,
  parseSessionAddress,
  deliverSessionMessage,
  loadDaemonSecret,
} from "./session-address.ts";

/**
 * What the broker forwards to the daemon and what it leaves to the peer
 * lookup. The solios daemon's copy of the prefix list pins against this.
 * Forwarded is not admitted: `ticket:sooth#0`
 * reaches the daemon, whose grammar refuses it.
 */
import SESSION_ADDRESS_FIXTURES from "./session-address.fixtures.json";

describe("parseSessionAddress", () => {
  test("the prefix list is the fixture's", () => {
    expect<string[]>([...DAEMON_ADDRESS_PREFIXES]).toEqual(SESSION_ADDRESS_FIXTURES.prefixes);
  });

  test.each(SESSION_ADDRESS_FIXTURES.forwarded)("accepts %p verbatim", (addr) => {
    expect(parseSessionAddress(addr)).toBe(addr);
  });

  test.each(SESSION_ADDRESS_FIXTURES.notForwarded)("returns null for %p", (addr) => {
    expect(parseSessionAddress(addr)).toBeNull();
  });
});

describe("loadDaemonSecret", () => {
  let dir: string;
  const saved = { secret: process.env.SOOTH_KEEP_MCP_SECRET, xdg: process.env.XDG_DATA_HOME };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ticket-secret-test-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.secret === undefined) delete process.env.SOOTH_KEEP_MCP_SECRET;
    else process.env.SOOTH_KEEP_MCP_SECRET = saved.secret;
    if (saved.xdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved.xdg;
  });
  beforeEach(() => {
    delete process.env.SOOTH_KEEP_MCP_SECRET;
    process.env.XDG_DATA_HOME = dir;
  });

  test("env wins", async () => {
    process.env.SOOTH_KEEP_MCP_SECRET = "from-env";
    expect(await loadDaemonSecret()).toBe("from-env");
  });
  test("falls back to <XDG_DATA_HOME>/solios-mcp/secret, trimmed", async () => {
    mkdirSync(join(dir, "solios-mcp"), { recursive: true });
    writeFileSync(join(dir, "solios-mcp", "secret"), "abc123\n");
    expect(await loadDaemonSecret()).toBe("abc123");
  });
  test("no env, no file → undefined", async () => {
    process.env.XDG_DATA_HOME = join(dir, "nowhere");
    expect(await loadDaemonSecret()).toBeUndefined();
  });
});

describe("deliverSessionMessage: daemon faked at the HTTP seam", () => {
  type Seen = { path: string; secret: string | null; body: unknown };
  let seen: Seen[] = [];
  let reply: () => Response = () => new Response("{}", { status: 200 });
  let server: ReturnType<typeof Bun.serve>;
  let url: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          secret: req.headers.get("x-solios-secret"),
          body: await req.json(),
        });
        return reply();
      },
    });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    seen = [];
  });

  test("POSTs the peer payload with the secret header; 200 → ok", async () => {
    reply = () =>
      Response.json({ enqueued: false, queued: true, target: "sori", thread_id: "gh:sooth#1138", ts: 1 });
    const r = await deliverSessionMessage("ticket:sooth#1138", "abc12345", "hello\nworld", {
      baseUrl: url,
      secret: "s3cret",
    });
    expect(r).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/inbox/ticket");
    expect(seen[0]!.secret).toBe("s3cret");
    expect(seen[0]!.body).toEqual({
      source: "peer",
      thread_id: "ticket:sooth#1138",
      sender: "abc12345",
      content: "hello\nworld",
    });
  });

  test("a side address goes to the same route with the same payload shape", async () => {
    reply = () => Response.json({ queued: true });
    const r = await deliverSessionMessage("side:sori-side1", "ticket:sooth#1138", "found it", {
      baseUrl: url,
      secret: "s3cret",
    });
    expect(r).toEqual({ ok: true });
    expect(seen[0]!.path).toBe("/inbox/ticket");
    expect(seen[0]!.body).toEqual({
      source: "peer",
      thread_id: "side:sori-side1",
      sender: "ticket:sooth#1138",
      content: "found it",
    });
  });

  test("no secret → no header (daemon dev mode decides)", async () => {
    reply = () => Response.json({ queued: true });
    const r = await deliverSessionMessage("ticket:sooth#1", "abc12345", "x", { baseUrl: url, secret: undefined });
    expect(r.ok).toBe(true);
    expect(seen[0]!.secret).toBeNull();
  });

  test.each([
    [409, "sooth#1138 is closed — its ticket-session takes no messages"],
    [404, "no ticket-session for gh:sooth#9999 — a message never starts one"],
    [503, "could not confirm sooth#1138 is open; retry later"],
    [400, "not a ticket address"],
  ])("daemon refusal %p → failed send carrying the reason", async (status, reason) => {
    reply = () => new Response(reason, { status, headers: { "content-type": "text/plain" } });
    const r = await deliverSessionMessage("ticket:sooth#1138", "abc12345", "hi", { baseUrl: url, secret: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(reason);
    expect(r.error).toContain(String(status));
  });

  test("refusal with an empty body still names the status", async () => {
    reply = () => new Response("", { status: 401 });
    const r = await deliverSessionMessage("ticket:sooth#1138", "abc12345", "hi", { baseUrl: url, secret: "bad" });
    expect(r).toEqual({ ok: false, error: "session inbox refused ticket:sooth#1138 (401)" });
  });

  test("daemon unreachable → failed send naming the inbox", async () => {
    const r = await deliverSessionMessage("ticket:sooth#1138", "abc12345", "hi", {
      baseUrl: "http://127.0.0.1:1",
      secret: "s",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("session inbox unreachable");
  });
});

describe("broker /send-message: session branch ahead of the peer lookup", () => {
  // A real single-broker (no brokers.json) pointed at a fake daemon.
  const ROOT = `/tmp/session-address-test-${process.pid}`;
  const PORT = 36899;
  let broker: Subprocess | null = null;
  let daemon: ReturnType<typeof Bun.serve>;
  let hits: { secret: string | null; body: { source: string; thread_id: string; sender: string; content: string } }[] = [];
  let verdict: () => Response = () => Response.json({ queued: true });
  const sleepers: Subprocess[] = [];
  let peerId = "";

  async function register(extra: Record<string, unknown> = {}): Promise<string> {
    const sleeper = spawn({ cmd: ["sleep", "60"] });
    sleepers.push(sleeper);
    const body = { pid: sleeper.pid, cwd: ROOT, git_root: null, tty: null, summary: "", ...extra };
    return (await post<{ id: string }>("/register", body)).id;
  }
  const sendFrom = (from_id: string, to_id: string, text = "hi") =>
    post<{ ok: boolean; error?: string }>("/send-message", { from_id, to_id, text });
  async function fromIdsAt(id: string): Promise<string[]> {
    const polled = await post<{ messages: { from_id: string }[] }>("/poll-messages", { id });
    return polled.messages.map((m) => m.from_id);
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  }
  const send = (to_id: string, text = "hi") =>
    post<{ ok: boolean; error?: string }>("/send-message", { from_id: peerId, to_id, text });

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    // A peers table as the running broker made it, before the address column:
    // startup must migrate it in place.
    const old = new Database(join(ROOT, "db.sqlite"));
    old.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
      headless INTEGER NOT NULL DEFAULT 0
    )`);
    old.close();
    daemon = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        hits.push({ secret: req.headers.get("x-solios-secret"), body: (await req.json()) as (typeof hits)[number]["body"] });
        return verdict();
      },
    });
    broker = spawn({
      cmd: ["bun", new URL("./broker.ts", import.meta.url).pathname],
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG_DIR: ROOT,
        CLAUDE_PEERS_DB: join(ROOT, "db.sqlite"),
        CLAUDE_PEERS_PORT: String(PORT),
        CLAUDE_PEERS_PEER_PORT: String(PORT + 1),
        CLAUDE_PEERS_TICKET_INBOX_URL: `http://127.0.0.1:${daemon.port}`,
        SOOTH_KEEP_MCP_SECRET: "broker-test-secret",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    // Registration without the address field, as an old server.ts sends it.
    peerId = await register();
  }, 20_000);

  afterAll(async () => {
    for (const s of sleepers) s.kill();
    broker?.kill("SIGTERM");
    await broker?.exited;
    daemon?.stop(true);
    rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    hits = [];
    verdict = () => Response.json({ queued: true });
  });

  test("a ticket address is forwarded to the daemon inbox and acceptance returns ok", async () => {
    const r = await send("ticket:sooth#1138", "please re-check the diff");
    expect(r).toEqual({ ok: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.secret).toBe("broker-test-secret");
    expect(hits[0]!.body).toEqual({
      source: "peer",
      thread_id: "ticket:sooth#1138",
      sender: peerId,
      content: "please re-check the diff",
    });
  });

  test("a daemon refusal is relayed to the sender as a failed send with the reason", async () => {
    verdict = () => new Response("sooth#1138 is closed — its ticket-session takes no messages", { status: 409 });
    const r = await send("ticket:sooth#1138");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sooth#1138 is closed — its ticket-session takes no messages");
  });

  test("a live peer id still lands in the peer table, never the daemon", async () => {
    const r = await send(peerId, "peer mail");
    expect(r).toEqual({ ok: true });
    expect(hits).toHaveLength(0);
    const polled = await post<{ messages: { text: string }[] }>("/poll-messages", { id: peerId });
    expect(polled.messages.map((m) => m.text)).toContain("peer mail");
  });

  test("the @machine form stays the remote branch's, never the daemon's", async () => {
    const r = await send("ticket:sooth#1138@mac");
    expect(r.ok).toBe(false);
    expect(hits).toHaveLength(0);
  });

  test("an unknown non-ticket id is still 'not found'", async () => {
    const r = await send("zzzzzzzz");
    expect(r).toEqual({ ok: false, error: "Peer zzzzzzzz not found" });
    expect(hits).toHaveLength(0);
  });

  test("a side address is forwarded to the daemon inbox with the peer payload", async () => {
    const r = await send("side:sori-side1", "what did the diff show?");
    expect(r).toEqual({ ok: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toEqual({
      source: "peer",
      thread_id: "side:sori-side1",
      sender: peerId,
      content: "what did the diff show?",
    });
  });

  test("a side refusal is relayed to the sender with the reason", async () => {
    verdict = () => new Response("no open side sori-side9", { status: 404 });
    const r = await send("side:sori-side9");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no open side sori-side9");
    expect(r.error).toContain("404");
  });

  test("an unknown prefix falls through to the peer lookup", async () => {
    const r = await send("panel:sori-side1");
    expect(r).toEqual({ ok: false, error: "Peer panel:sori-side1 not found" });
    expect(hits).toHaveLength(0);
  });

  test("a peer registered without an address sends as its own id", async () => {
    expect(await send(peerId, "plain")).toEqual({ ok: true });
    expect(await fromIdsAt(peerId)).toEqual([peerId]);
  });

  test("a headless peer's session address is stamped on local delivery", async () => {
    const turn = await register({ headless: true, address: "side:sori-side1" });
    expect(await sendFrom(turn, peerId, "answer me here")).toEqual({ ok: true });
    expect(await fromIdsAt(peerId)).toEqual(["side:sori-side1"]);
  });

  test("a padded registered address is stored trimmed", async () => {
    const turn = await register({ headless: true, address: "  side:sori-side2\n" });
    expect(await sendFrom(turn, peerId)).toEqual({ ok: true });
    expect(await fromIdsAt(peerId)).toEqual(["side:sori-side2"]);
  });

  test("a headless peer's session address is the daemon-forward sender", async () => {
    const turn = await register({ headless: true, address: "ticket:sooth#1138" });
    expect(await sendFrom(turn, "side:sori-side1", "found it")).toEqual({ ok: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body.sender).toBe("ticket:sooth#1138");
  });

  test("a headless peer's stand-in address is stamped while the stand-in is registered", async () => {
    const standIn = await register();
    const turn = await register({ headless: true, address: standIn });
    expect(await sendFrom(turn, peerId)).toEqual({ ok: true });
    expect(await fromIdsAt(peerId)).toEqual([standIn]);

    await post("/unregister", { id: standIn });
    expect(await sendFrom(turn, peerId)).toEqual({ ok: true });
    expect(await fromIdsAt(peerId)).toEqual([turn]);
  });

  test("a resident (non-headless) peer's address is ignored", async () => {
    const seat = await register({ headless: false, address: "side:sori-side1" });
    expect(await sendFrom(seat, peerId)).toEqual({ ok: true });
    expect(await fromIdsAt(peerId)).toEqual([seat]);
  });

  test.each(["zzzzzzzz", "side:", "side:sori side1", "ticket:sooth#1@mac", "gh:sooth#1"])(
    "a headless peer's garbage address %p is ignored",
    async (address) => {
      const turn = await register({ headless: true, address });
      expect(await sendFrom(turn, peerId)).toEqual({ ok: true });
      expect(await fromIdsAt(peerId)).toEqual([turn]);
    },
  );

  test("/list-peers carries no address, so a stamped turn never looks like a seat", async () => {
    const turn = await register({ headless: true, address: "side:sori-side1" });
    const rows = await post<Record<string, unknown>[]>("/list-peers", { scope: "machine", cwd: ROOT, git_root: null });
    const row = rows.find((r) => r.id === turn);
    expect(row?.headless).toBe(true);
    expect(row && "address" in row).toBe(false);
  });
});
