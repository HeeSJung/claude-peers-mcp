/**
 * Headless marker on peer registration (sooth-os/sooth#1141).
 *
 * Spins two real brokers on loopback (same harness shape as
 * scripts/loopback-smoke.ts): A registers a flagged peer, an unflagged peer,
 * and an old-client peer whose /register body has no `headless` key at all.
 * A's own /list-peers and B's machine+remote view (fed by peer-events fanout)
 * must both report the flag. Cross-host, a headless peer's session address
 * stays home (the wire carries its peer id) while a stand-in address is sent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDRESS_ENV, HEADLESS_ENV, readAddressEnv, readHeadlessEnv } from "./headless.ts";

describe("readHeadlessEnv", () => {
  test("unset env is not headless", () => {
    expect(readHeadlessEnv({})).toBe(false);
  });
  test.each(["1", "true", "TRUE", "yes"])("%p is headless", (v) => {
    expect(readHeadlessEnv({ [HEADLESS_ENV]: v })).toBe(true);
  });
  test.each(["", "0", "false", "no"])("%p is not headless", (v) => {
    expect(readHeadlessEnv({ [HEADLESS_ENV]: v })).toBe(false);
  });
});

describe("readAddressEnv", () => {
  test("unset env has no address", () => {
    expect(readAddressEnv({})).toBeUndefined();
  });
  test.each(["", "   "])("blank %p has no address", (v) => {
    expect(readAddressEnv({ [ADDRESS_ENV]: v })).toBeUndefined();
  });
  test("the address is returned trimmed", () => {
    expect(readAddressEnv({ [ADDRESS_ENV]: " side:sori-side1\n" })).toBe("side:sori-side1");
  });
});

interface FakeBroker {
  machine: string;
  dir: string;
  localPort: number;
  peerPort: number;
  proc: Subprocess<"ignore", "pipe", "pipe"> | null;
}

const ROOT = `/tmp/headless-test-${process.pid}`;
const A: FakeBroker = { machine: "hl-a", dir: join(ROOT, "A"), localPort: 37899, peerPort: 37900, proc: null };
const B: FakeBroker = { machine: "hl-b", dir: join(ROOT, "B"), localPort: 38899, peerPort: 38900, proc: null };

function configure(b: FakeBroker, peer: FakeBroker, secretHex: string) {
  mkdirSync(b.dir, { recursive: true });
  writeFileSync(
    join(b.dir, "brokers.json"),
    JSON.stringify({
      schema: 1,
      self_machine: b.machine,
      self_ts_addr: `127.0.0.1:${b.peerPort}`,
      peers: [
        {
          machine: peer.machine,
          ts_addr: `127.0.0.1:${peer.peerPort}`,
          ssh_alias: `__test_secret__:${peer.dir}/secret-current`,
        },
      ],
    }),
  );
  writeFileSync(join(b.dir, "secret-current"), secretHex);
  chmodSync(join(b.dir, "secret-current"), 0o600);
}

function start(b: FakeBroker) {
  b.proc = spawn({
    cmd: ["bun", new URL("./broker.ts", import.meta.url).pathname],
    env: {
      ...process.env,
      CLAUDE_PEERS_CONFIG_DIR: b.dir,
      CLAUDE_PEERS_DB: join(b.dir, "db.sqlite"),
      CLAUDE_PEERS_PORT: String(b.localPort),
      CLAUDE_PEERS_PEER_PORT: String(b.peerPort),
      CLAUDE_PEERS_BIND_TS_IP: "127.0.0.1",
      CLAUDE_PEERS_SECRET_FETCH_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitUp(b: FakeBroker) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${b.localPort}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`broker ${b.machine} did not come up`);
}

async function post<T>(b: FakeBroker, path: string, body: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${b.localPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

type Row = { id: string; headless: boolean };

// /list-peers drops local rows whose pid is dead, so each peer needs a live pid.
const sleepers: Subprocess[] = [];
const ids = {
  flagged: "",
  unflagged: "",
  oldClient: "",
  addressed: "",
  standIn: "",
  standInTurn: "",
  onB: "",
};

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  configure(A, B, "c".repeat(64));
  configure(B, A, "d".repeat(64));
  start(A);
  start(B);
  await waitUp(A);
  await waitUp(B);
  await Bun.sleep(500);

  for (let i = 0; i < 7; i++) sleepers.push(spawn({ cmd: ["sleep", "60"] }));
  const base = { git_root: null, tty: null, summary: "" };
  ids.flagged = (
    await post<{ id: string }>(A, "/register", { ...base, pid: sleepers[0]!.pid, cwd: "/home/x", headless: true })
  ).id;
  ids.unflagged = (
    await post<{ id: string }>(A, "/register", { ...base, pid: sleepers[1]!.pid, cwd: "/home/x", headless: false })
  ).id;
  // Old client: no `headless` key in the body at all.
  ids.oldClient = (
    await post<{ id: string }>(A, "/register", { ...base, pid: sleepers[2]!.pid, cwd: "/home/x" })
  ).id;
  ids.addressed = (
    await post<{ id: string }>(A, "/register", {
      ...base,
      pid: sleepers[3]!.pid,
      cwd: "/home/x",
      headless: true,
      address: "side:sori-side1",
    })
  ).id;
  ids.standIn = (await post<{ id: string }>(A, "/register", { ...base, pid: sleepers[5]!.pid, cwd: "/home/x" })).id;
  ids.standInTurn = (
    await post<{ id: string }>(A, "/register", {
      ...base,
      pid: sleepers[6]!.pid,
      cwd: "/home/x",
      headless: true,
      address: ids.standIn,
    })
  ).id;
  ids.onB = (await post<{ id: string }>(B, "/register", { ...base, pid: sleepers[4]!.pid, cwd: "/home/y" })).id;
  await Bun.sleep(800); // let the register fanout reach the other broker
}, 20_000);

afterAll(async () => {
  for (const s of sleepers) s.kill();
  for (const b of [A, B]) {
    b.proc?.kill("SIGTERM");
    await b.proc?.exited;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

function flagOf(rows: Row[], id: string): boolean | undefined {
  return rows.find((r) => r.id === id)?.headless;
}

describe("headless marker through the broker", () => {
  test("local /list-peers returns the stored flag", async () => {
    const rows = await post<Row[]>(A, "/list-peers", { scope: "directory", cwd: "/home/x", git_root: null });
    expect(flagOf(rows, ids.flagged)).toBe(true);
    expect(flagOf(rows, ids.unflagged)).toBe(false);
  });

  test("a register body without the key defaults to false", async () => {
    const rows = await post<Row[]>(A, "/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(flagOf(rows, ids.oldClient)).toBe(false);
  });

  test("peer-events fanout carries the flag to the remote broker", async () => {
    const rows = await post<Row[]>(B, "/list-peers", { scope: "machine+remote", cwd: "/", git_root: null });
    expect(flagOf(rows, `${ids.flagged}@${A.machine}`)).toBe(true);
    expect(flagOf(rows, `${ids.unflagged}@${A.machine}`)).toBe(false);
    expect(flagOf(rows, `${ids.oldClient}@${A.machine}`)).toBe(false);
  });

  test("a heartbeat fanout keeps the remote flag", async () => {
    await post(A, "/set-summary", { id: ids.flagged, summary: "turn" });
    await Bun.sleep(500);
    const rows = await post<Row[]>(B, "/list-peers", { scope: "machine+remote", cwd: "/", git_root: null });
    expect(flagOf(rows, `${ids.flagged}@${A.machine}`)).toBe(true);
  });
});

describe("registered address across hosts", () => {
  // Explicit `<id>@<machine>` and a bare id A knows only from remote_peers
  // take the two forward branches; both must stamp alike.
  const targets = () => [`${ids.onB}@${B.machine}`, ids.onB];

  async function fromIdsOnB(): Promise<string[]> {
    const polled = await post<{ messages: { from_id: string }[] }>(B, "/poll-messages", { id: ids.onB });
    return polled.messages.map((m) => m.from_id);
  }

  test("a session address never crosses hosts: the wire carries the peer id", async () => {
    for (const to_id of targets()) {
      expect(await post<{ ok: boolean }>(A, "/send-message", { from_id: ids.addressed, to_id, text: "ask" })).toEqual({ ok: true });
    }
    expect(await fromIdsOnB()).toEqual([`${ids.addressed}@${A.machine}`, `${ids.addressed}@${A.machine}`]);
  });

  test("a stand-in address is stamped on both forward branches", async () => {
    for (const to_id of targets()) {
      expect(await post<{ ok: boolean }>(A, "/send-message", { from_id: ids.standInTurn, to_id, text: "ask" })).toEqual({ ok: true });
    }
    expect(await fromIdsOnB()).toEqual([`${ids.standIn}@${A.machine}`, `${ids.standIn}@${A.machine}`]);
  });

  test("the remote view stays a headless row under the peer id", async () => {
    const rows = await post<Row[]>(B, "/list-peers", { scope: "machine+remote", cwd: "/", git_root: null });
    expect(flagOf(rows, `${ids.addressed}@${A.machine}`)).toBe(true);
  });
});
