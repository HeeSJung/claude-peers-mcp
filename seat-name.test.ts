import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
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
