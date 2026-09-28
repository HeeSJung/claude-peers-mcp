import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTicketAddress, deliverTicketMessage, loadDaemonSecret } from "./ticket-address.ts";

describe("parseTicketAddress", () => {
  test.each(["ticket:sooth#1138", "ticket:claude-peers-mcp#7", "ticket:my.repo_x#42"])(
    "accepts %p verbatim",
    (addr) => {
      expect(parseTicketAddress(addr)).toBe(addr);
    },
  );

  test.each([
    "ticket:",
    "ticket:sooth",
    "ticket:sooth#",
    "ticket:sooth#0",
    "ticket:sooth#01",
    "ticket:sooth#12x",
    "ticket:#12",
    "ticket:so oth#12",
    "ticket:sooth#12@mac", // the @machine form stays the remote-forward branch's
    "gh:sooth#12",
    "abc12345", // a live-shaped peer id
    "k3pogncc@mac",
    "vscode@mac:q1758600000-12345-678",
    "TICKET:sooth#12",
  ])("returns null for %p", (addr) => {
    expect(parseTicketAddress(addr)).toBeNull();
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

  test("env wins", () => {
    process.env.SOOTH_KEEP_MCP_SECRET = "from-env";
    expect(loadDaemonSecret()).toBe("from-env");
  });
  test("falls back to <XDG_DATA_HOME>/solios-mcp/secret, trimmed", () => {
    mkdirSync(join(dir, "solios-mcp"), { recursive: true });
    writeFileSync(join(dir, "solios-mcp", "secret"), "abc123\n");
    expect(loadDaemonSecret()).toBe("abc123");
  });
  test("no env, no file → undefined", () => {
    process.env.XDG_DATA_HOME = join(dir, "nowhere");
    expect(loadDaemonSecret()).toBeUndefined();
  });
});

describe("deliverTicketMessage — daemon faked at the HTTP seam", () => {
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
    const r = await deliverTicketMessage("ticket:sooth#1138", "abc12345", "hello\nworld", {
      baseUrl: url,
      secret: "s3cret",
    });
    expect(r).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path.startsWith("/inbox/")).toBe(true);
    expect(seen[0]!.secret).toBe("s3cret");
    expect(seen[0]!.body).toEqual({
      source: "peer",
      thread_id: "ticket:sooth#1138",
      sender: "abc12345",
      content: "hello\nworld",
    });
  });

  test("no secret → no header (daemon dev mode decides)", async () => {
    reply = () => Response.json({ queued: true });
    const r = await deliverTicketMessage("ticket:sooth#1", "abc12345", "x", { baseUrl: url, secret: undefined });
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
    const r = await deliverTicketMessage("ticket:sooth#1138", "abc12345", "hi", { baseUrl: url, secret: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(reason);
    expect(r.error).toContain(String(status));
  });

  test("refusal with an empty body still names the status", async () => {
    reply = () => new Response("", { status: 401 });
    const r = await deliverTicketMessage("ticket:sooth#1138", "abc12345", "hi", { baseUrl: url, secret: "bad" });
    expect(r).toEqual({ ok: false, error: "ticket inbox refused ticket:sooth#1138 (401)" });
  });

  test("daemon unreachable → failed send naming the inbox", async () => {
    const r = await deliverTicketMessage("ticket:sooth#1138", "abc12345", "hi", {
      baseUrl: "http://127.0.0.1:1",
      secret: "s",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ticket inbox unreachable");
  });
});

describe("broker /send-message — ticket branch ahead of the peer lookup", () => {
  // A real single-broker (no brokers.json) pointed at a fake daemon.
  const ROOT = `/tmp/ticket-address-test-${process.pid}`;
  const PORT = 36899;
  let broker: Subprocess | null = null;
  let daemon: ReturnType<typeof Bun.serve>;
  let hits: { secret: string | null; body: { source: string; thread_id: string; sender: string; content: string } }[] = [];
  let verdict: () => Response = () => Response.json({ queued: true });
  let sleeper: Subprocess;
  let peerId = "";

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
    sleeper = spawn({ cmd: ["sleep", "60"] });
    peerId = (
      await post<{ id: string }>("/register", { pid: sleeper.pid, cwd: ROOT, git_root: null, tty: null, summary: "" })
    ).id;
  }, 20_000);

  afterAll(async () => {
    sleeper?.kill();
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
});
