import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { chmodSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isSeatNameShaped } from "./seat-name.ts";
import type { BrokerRequest, RegisterRequest } from "./shared/types.ts";

/**
 * `send_message(to_id="<seat name>")` against a real broker running the real
 * `crew-send-peers.sh --resolve` over a fixture roster (sooth-os/sooth#1814).
 * CLAUDE_PEERS_SEAT_RESOLVER points the broker at an unmerged copy of the script.
 */
const RESOLVER =
  process.env.CLAUDE_PEERS_SEAT_RESOLVER ?? "/home/heesoo/sooth/shared/scripts/crew-peers/crew-send-peers.sh";

describe("isSeatNameShaped", () => {
  test.each(["haru", "dad-invst", "spk-coach", "sori"])("accepts %p", (n) => {
    expect(isSeatNameShaped(n)).toBe(true);
  });
  test.each(["", "Haru", "haru@mac", "side:sori-side1", "-x", "../sori", "ha ru"])("rejects %p", (n) => {
    expect(isSeatNameShaped(n)).toBe(false);
  });
});

describe("broker /send-message: a bare seat name resolves to the seated session", () => {
  const ROOT = `/tmp/seat-name-test-${process.pid}`;
  const PORT = 36909;
  const home = (name: string) => join(ROOT, "homes", name);
  let broker: Subprocess | null = null;
  const sleepers: Subprocess[] = [];
  let sender = "";

  async function post<T>(path: string, body: BrokerRequest): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  }
  async function register(cwd: string, extra: Partial<RegisterRequest> = {}): Promise<string> {
    const sleeper = spawn({ cmd: ["sleep", "60"] });
    sleepers.push(sleeper);
    const body = { pid: sleeper.pid, cwd, git_root: null, tty: null, summary: "", ...extra };
    return (await post<{ id: string }>("/register", body)).id;
  }
  const send = (to_id: string, text = "hi") =>
    post<{ ok: boolean; error?: string }>("/send-message", { from_id: sender, to_id, text });
  async function inbox(id: string): Promise<{ from_id: string; text: string }[]> {
    return (await post<{ messages: { from_id: string; text: string }[] }>("/poll-messages", { id })).messages;
  }

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    for (const n of ["alpha", "beta", "gamma"]) mkdirSync(home(n), { recursive: true });
    writeFileSync(
      join(ROOT, "roster.json"),
      JSON.stringify(["alpha", "beta", "gamma"].map((id) => ({ id, session: id, scope: id, home: home(id) }))),
    );
    broker = spawn({
      cmd: ["bun", new URL("./broker.ts", import.meta.url).pathname],
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG_DIR: ROOT,
        CLAUDE_PEERS_DB: join(ROOT, "db.sqlite"),
        CLAUDE_PEERS_PORT: String(PORT),
        CLAUDE_PEERS_PEER_PORT: String(PORT + 1),
        CLAUDE_PEERS_SEAT_RESOLVER: RESOLVER,
        CREWMATE_REGISTRY: join(ROOT, "roster.json"),
        CREW_QUEUE_ROOT: join(ROOT, "queue"),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    sender = await register(join(ROOT, "elsewhere"));
  }, 20_000);

  afterAll(async () => {
    for (const s of sleepers) s.kill();
    broker?.kill("SIGTERM");
    await broker?.exited;
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("a peer seated at the crewmate home receives a send addressed by name, not a worktree under it", async () => {
    const seat = await register(home("alpha"));
    const worktree = await register(join(home("alpha"), ".claude/worktrees/drv-1"));
    expect(await send("alpha", "by name")).toEqual({ ok: true });
    expect(await inbox(seat)).toEqual([expect.objectContaining({ from_id: sender, text: "by name" })]);
    expect(await inbox(worktree)).toEqual([]);
  });

  test("a restarted seat is reached under its new id with no cache in the way", async () => {
    const first = await register(home("beta"));
    expect(await send("beta", "one")).toEqual({ ok: true });
    await post("/unregister", { id: first });
    const second = await register(home("beta"));
    expect(await send("beta", "two")).toEqual({ ok: true });
    expect((await inbox(second)).map((m) => m.text)).toEqual(["two"]);
  });

  test("with no seated peer the listener stand-in takes it, and without one the error names the home", async () => {
    const vacant = await send("gamma");
    expect(vacant.ok).toBe(false);
    expect(vacant.error).toContain("Peer gamma not found");
    expect(vacant.error).toContain(home("gamma"));

    const standIn = await register(join(ROOT, "listener"));
    mkdirSync(join(ROOT, "queue", "gamma"), { recursive: true });
    writeFileSync(join(ROOT, "queue", "gamma", "peers-identity"), `${standIn}\n`);
    expect(await send("gamma", "via stand-in")).toEqual({ ok: true });
    expect((await inbox(standIn)).map((m) => m.text)).toEqual(["via stand-in"]);
  });

  test("a name off the roster is still plain 'not found'", async () => {
    expect(await send("nobody")).toEqual({ ok: false, error: "Peer nobody not found" });
  });

  test("a random peer id still resolves exactly", async () => {
    const peer = await register(join(ROOT, "random"));
    expect(await send(peer, "exact")).toEqual({ ok: true });
    expect((await inbox(peer)).map((m) => m.text)).toEqual(["exact"]);
  });
});

/**
 * A bare name whose roster entry names another server goes to `<name>@<server>`
 * (ADR-0064, sooth-os/sooth#2037). The broker runs as "oregon" with one peer,
 * "helsinki", which is a fake remote broker: a loopback server that records each
 * signed /forward and answers like a real one.
 */
describe("broker /send-message: a bare name whose home lives on another server", () => {
  const ROOT = `/tmp/seat-name-remote-test-${process.pid}`;
  const PORT = 36929;
  const ROSTER_READER =
    process.env.CLAUDE_PEERS_ROSTER_READER ?? "/home/heesoo/sooth/shared/scripts/seat/crewmate-seat.sh";
  const home = (name: string) => join(ROOT, "homes", name);
  let broker: Subprocess | null = null;
  let remote: ReturnType<typeof Bun.serve> | null = null;
  const forwarded: { path: string; machine: string | null; body: Record<string, unknown> }[] = [];
  const sleepers: Subprocess[] = [];
  let sender = "";

  async function post<T>(path: string, body: BrokerRequest): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  }
  async function register(cwd: string): Promise<string> {
    const sleeper = spawn({ cmd: ["sleep", "60"] });
    sleepers.push(sleeper);
    const body = { pid: sleeper.pid, cwd, git_root: null, tty: null, summary: "" };
    return (await post<{ id: string }>("/register", body)).id;
  }
  const send = (to_id: string, text = "hi") =>
    post<{ ok: boolean; error?: string }>("/send-message", { from_id: sender, to_id, text });

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    for (const n of ["alpha", "may"]) mkdirSync(home(n), { recursive: true });
    writeFileSync(
      join(ROOT, "roster.json"),
      JSON.stringify([
        { id: "alpha", session: "alpha", scope: "alpha", home: home("alpha"), homeServer: "oregon" },
        { id: "may", session: "may", scope: "may", home: home("may"), homeServer: "helsinki" },
      ]),
    );
    remote = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const text = await req.text();
        if (path === "/forward") {
          forwarded.push({ path, machine: req.headers.get("x-peer-broker-machine"), body: JSON.parse(text) });
        }
        return Response.json(path === "/list-peers" ? [] : { ok: true });
      },
    });
    writeFileSync(
      join(ROOT, "brokers.json"),
      JSON.stringify({
        schema: 1,
        self_machine: "oregon",
        self_ts_addr: `127.0.0.1:${PORT + 1}`,
        peers: [{ machine: "helsinki", ts_addr: `127.0.0.1:${remote.port}`, ssh_alias: "helsinki-broker-secret" }],
      }),
    );
    writeFileSync(join(ROOT, "secret-current"), "b".repeat(64));
    chmodSync(join(ROOT, "secret-current"), 0o600);
    broker = spawn({
      cmd: ["bun", new URL("./broker.ts", import.meta.url).pathname],
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG_DIR: ROOT,
        CLAUDE_PEERS_DB: join(ROOT, "db.sqlite"),
        CLAUDE_PEERS_PORT: String(PORT),
        CLAUDE_PEERS_PEER_PORT: String(PORT + 1),
        CLAUDE_PEERS_BIND_TS_IP: "127.0.0.1",
        CLAUDE_PEERS_SEAT_RESOLVER: RESOLVER,
        CLAUDE_PEERS_ROSTER_READER: ROSTER_READER,
        CREWMATE_REGISTRY: join(ROOT, "roster.json"),
        CREW_QUEUE_ROOT: join(ROOT, "queue"),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    sender = await register(join(ROOT, "elsewhere"));
  }, 20_000);

  afterAll(async () => {
    for (const s of sleepers) s.kill();
    broker?.kill("SIGTERM");
    await broker?.exited;
    remote?.stop(true);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("a name whose roster entry names this server resolves locally, as today", async () => {
    const seat = await register(home("alpha"));
    expect(await send("alpha", "local")).toEqual({ ok: true });
    const inbox = await post<{ messages: { text: string }[] }>("/poll-messages", { id: seat });
    expect(inbox.messages.map((m) => m.text)).toEqual(["local"]);
    expect(forwarded.filter((f) => f.body.to_id === "alpha")).toEqual([]);
  });

  test("a name whose roster entry names another server is forwarded there as <name>@<server>", async () => {
    expect(await send("may", "across")).toEqual({ ok: true });
    expect(forwarded).toEqual([
      {
        path: "/forward",
        machine: "oregon",
        body: expect.objectContaining({ from_id: sender, from_machine: "oregon", to_id: "may", text: "across" }),
      },
    ]);
  });
});

/**
 * End to end over two real brokers on loopback: "oregon" sends to the bare name
 * "may", whose roster entry names "helsinki"; helsinki resolves the name to the
 * session seated in may's home there, and the sender reads as `<id>@oregon`.
 */
describe("two brokers: a bare name crosses to the server its home lives on", () => {
  const ROOT = `/tmp/seat-name-two-brokers-${process.pid}`;
  const ROSTER_READER =
    process.env.CLAUDE_PEERS_ROSTER_READER ?? "/home/heesoo/sooth/shared/scripts/seat/crewmate-seat.sh";
  const B = {
    oregon: { dir: join(ROOT, "oregon"), port: 36949, proc: null as Subprocess | null },
    helsinki: { dir: join(ROOT, "helsinki"), port: 36959, proc: null as Subprocess | null },
  };
  const mayHome = join(ROOT, "homes", "may");
  const sleepers: Subprocess[] = [];

  async function post<T>(port: number, path: string, body: BrokerRequest): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  }
  async function register(port: number, cwd: string): Promise<string> {
    const sleeper = spawn({ cmd: ["sleep", "60"] });
    sleepers.push(sleeper);
    return (await post<{ id: string }>(port, "/register", { pid: sleeper.pid, cwd, git_root: null, tty: null, summary: "" })).id;
  }

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(mayHome, { recursive: true });
    writeFileSync(
      join(ROOT, "roster.json"),
      JSON.stringify([{ id: "may", session: "may", scope: "may", home: mayHome, homeServer: "helsinki" }]),
    );
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
          CLAUDE_PEERS_SEAT_RESOLVER: RESOLVER,
          CLAUDE_PEERS_ROSTER_READER: ROSTER_READER,
          CREWMATE_REGISTRY: join(ROOT, "roster.json"),
          CREW_QUEUE_ROOT: join(ROOT, "queue"),
        },
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    for (const self of names) {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${B[self].port}/health`)).ok) break;
        } catch {
          // not up yet
        }
        await Bun.sleep(100);
      }
    }
  }, 30_000);

  afterAll(async () => {
    for (const s of sleepers) s.kill();
    for (const b of Object.values(B)) {
      b.proc?.kill("SIGTERM");
      await b.proc?.exited;
    }
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("the seat on helsinki receives it, from <sender>@oregon", async () => {
    const seat = await register(B.helsinki.port, mayHome);
    const sender = await register(B.oregon.port, join(ROOT, "elsewhere"));
    const sent = await post<{ ok: boolean }>(B.oregon.port, "/send-message", { from_id: sender, to_id: "may", text: "hello may" });
    expect(sent).toEqual({ ok: true });
    const inbox = await post<{ messages: { from_id: string; text: string }[] }>(B.helsinki.port, "/poll-messages", {
      id: seat,
    });
    expect(inbox.messages).toEqual([expect.objectContaining({ from_id: `${sender}@oregon`, text: "hello may" })]);
  });

  test("no seat there: the sender gets the failure, not a silent drop", async () => {
    const here = await post<{ id: string }[]>(B.helsinki.port, "/list-peers", { scope: "machine", cwd: "", git_root: null });
    for (const p of here) await post(B.helsinki.port, "/unregister", { id: p.id });
    const sender = await register(B.oregon.port, join(ROOT, "elsewhere2"));
    const r = await post<{ ok: boolean }>(B.oregon.port, "/send-message", { from_id: sender, to_id: "may", text: "x" });
    expect(r.ok).toBe(false);
  });
});
