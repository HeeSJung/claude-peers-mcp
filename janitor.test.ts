/**
 * Janitor stale→down transition test.
 *
 * Reproduces the bug Silas caught 2026-04-30: `last_health_at` updates on
 * every probe attempt (success OR failure), so as long as the 30s probe
 * loop is running, the janitor's old `now - last_health_at > 5min` check
 * never fires. Result: peer_brokers stuck at `stale` forever.
 *
 * Fix: capture `stale_since` only on the live→stale transition; janitor
 * compares against that, decoupled from probe activity.
 *
 * This test exercises the SQL state-transition logic directly without
 * spinning a real broker.
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

let db: Database;

function setupDb() {
  db = new Database(":memory:");
  db.run(`
    CREATE TABLE peer_brokers (
      machine        TEXT PRIMARY KEY,
      ts_addr        TEXT NOT NULL,
      ssh_alias      TEXT NOT NULL,
      last_event_at  TEXT,
      last_health_at TEXT,
      consecutive_health_failures INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'unknown',
      stale_since    TEXT
    )
  `);
  db.run(`
    INSERT INTO peer_brokers (machine, ts_addr, ssh_alias)
    VALUES ('milo-mac', '100.99.99.99:7900', 'milo-broker-secret')
  `);
}

const STALE_AFTER_FAILS = 3;
const DOWN_AFTER_MS = 5 * 60 * 1000;

// Mirror of probeOnePeer's state-transition logic in broker.ts.
function applyProbe(machine: string, ok: boolean, nowIso: string) {
  const row = db
    .query(
      "SELECT consecutive_health_failures, status, stale_since FROM peer_brokers WHERE machine = ?",
    )
    .get(machine) as
    | { consecutive_health_failures: number; status: string; stale_since: string | null }
    | undefined;
  if (!row) throw new Error("missing row");

  if (ok) {
    db.run(
      `UPDATE peer_brokers SET status = 'live', last_health_at = ?, consecutive_health_failures = 0, stale_since = NULL WHERE machine = ?`,
      [nowIso, machine],
    );
    return;
  }

  const newFails = row.consecutive_health_failures + 1;
  const prevStatus = row.status;
  const newStatus = newFails >= STALE_AFTER_FAILS ? "stale" : prevStatus;
  let newStaleSince: string | null = row.stale_since;
  if (newStatus === "stale" && (prevStatus !== "stale" || newStaleSince === null)) {
    newStaleSince = nowIso;
  }
  db.run(
    `UPDATE peer_brokers SET status = ?, last_health_at = ?, consecutive_health_failures = ?, stale_since = ? WHERE machine = ?`,
    [newStatus, nowIso, newFails, newStaleSince, machine],
  );
}

function applyJanitor(nowMs: number) {
  const brokers = db.query(`SELECT * FROM peer_brokers`).all() as Array<{
    machine: string;
    status: string;
    stale_since: string | null;
  }>;
  for (const b of brokers) {
    if (b.status === "stale" && b.stale_since) {
      const staleMs = Date.parse(b.stale_since);
      if (Number.isFinite(staleMs) && nowMs - staleMs > DOWN_AFTER_MS) {
        db.run(`UPDATE peer_brokers SET status = 'down' WHERE machine = ?`, [b.machine]);
      }
    }
  }
}

function getRow() {
  return db.query("SELECT * FROM peer_brokers WHERE machine = 'milo-mac'").get() as {
    machine: string;
    last_health_at: string | null;
    consecutive_health_failures: number;
    status: string;
    stale_since: string | null;
  };
}

beforeEach(() => {
  setupDb();
});

afterAll(() => {
  db.close();
});

describe("probe state transitions", () => {
  test("first failure: status remains unknown, fails=1", () => {
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    const r = getRow();
    expect(r.status).toBe("unknown");
    expect(r.consecutive_health_failures).toBe(1);
    expect(r.stale_since).toBeNull();
  });

  test("3rd failure flips to stale and captures stale_since", () => {
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    const r = getRow();
    expect(r.status).toBe("stale");
    expect(r.consecutive_health_failures).toBe(3);
    expect(r.stale_since).toBe("2026-04-30T10:01:00.000Z");
  });

  test("subsequent failures preserve stale_since (bug fix)", () => {
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    // …and many more failures over 10 minutes…
    applyProbe("milo-mac", false, "2026-04-30T10:05:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:10:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:15:00.000Z");
    const r = getRow();
    // last_health_at advances with each probe…
    expect(r.last_health_at).toBe("2026-04-30T10:15:00.000Z");
    // …but stale_since stays at the live→stale transition timestamp.
    expect(r.stale_since).toBe("2026-04-30T10:01:00.000Z");
  });

  test("recovery clears stale_since", () => {
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    expect(getRow().stale_since).toBe("2026-04-30T10:01:00.000Z");
    applyProbe("milo-mac", true, "2026-04-30T10:02:00.000Z");
    const r = getRow();
    expect(r.status).toBe("live");
    expect(r.stale_since).toBeNull();
    expect(r.consecutive_health_failures).toBe(0);
  });

  test("stale→live→stale captures a NEW stale_since on the second flip", () => {
    // First outage: 10:00 → stale at 10:01.
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    // Recovery.
    applyProbe("milo-mac", true, "2026-04-30T10:02:00.000Z");
    // Second outage: starting 10:30, stale at 10:31.
    applyProbe("milo-mac", false, "2026-04-30T10:30:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:30:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:31:00.000Z");
    const r = getRow();
    expect(r.status).toBe("stale");
    expect(r.stale_since).toBe("2026-04-30T10:31:00.000Z");
  });
});

describe("janitor stale→down transition", () => {
  test("BUG REPRO: with the OLD logic (last_health_at-driven), janitor never fires", () => {
    // Replicate the OLD (buggy) janitor with last_health_at-only check.
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    expect(getRow().status).toBe("stale");
    // Probe fails every 30s for 10 minutes — last_health_at keeps advancing.
    for (let t = 1; t <= 20; t++) {
      const ts = `2026-04-30T10:${String(t).padStart(2, "0")}:30.000Z`;
      applyProbe("milo-mac", false, ts);
    }
    const r = getRow();
    expect(r.status).toBe("stale"); // still stale, never down
    // last_health_at is "fresh" relative to a now=10:21 even though peer has been stale 20 min
    const nowMs = Date.parse("2026-04-30T10:21:00.000Z");
    const lastMs = Date.parse(r.last_health_at!);
    expect(nowMs - lastMs).toBeLessThanOrEqual(60_000);
    // Old janitor would NOT flip to down because (now - last_health_at) is < 5min.
    // This is the bug.
  });

  test("FIX: janitor with stale_since correctly flips to down after 5min", () => {
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    // Probe fails every 30s for 10 minutes.
    for (let t = 1; t <= 20; t++) {
      const ts = `2026-04-30T10:${String(t).padStart(2, "0")}:30.000Z`;
      applyProbe("milo-mac", false, ts);
    }
    // Run janitor at t=10:21 — stale_since=10:01, so elapsed=20min > 5min → down.
    const nowMs = Date.parse("2026-04-30T10:21:00.000Z");
    applyJanitor(nowMs);
    expect(getRow().status).toBe("down");
  });

  test("janitor leaves stale alone if elapsed < 5min", () => {
    applyProbe("milo-mac", false, "2026-04-30T10:00:00.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:00:30.000Z");
    applyProbe("milo-mac", false, "2026-04-30T10:01:00.000Z");
    // Run janitor at t=10:03 (only 2 min stale).
    applyJanitor(Date.parse("2026-04-30T10:03:00.000Z"));
    expect(getRow().status).toBe("stale");
  });

  test("janitor does not touch live or unknown rows", () => {
    db.run(
      `INSERT INTO peer_brokers (machine, ts_addr, ssh_alias, status) VALUES ('alive-vps', 'x', 'y', 'live')`,
    );
    db.run(
      `INSERT INTO peer_brokers (machine, ts_addr, ssh_alias, status) VALUES ('quiet-vps', 'x', 'y', 'unknown')`,
    );
    applyJanitor(Date.parse("2026-04-30T11:00:00.000Z"));
    const live = db
      .query(`SELECT status FROM peer_brokers WHERE machine = 'alive-vps'`)
      .get() as { status: string };
    const unknown = db
      .query(`SELECT status FROM peer_brokers WHERE machine = 'quiet-vps'`)
      .get() as { status: string };
    expect(live.status).toBe("live");
    expect(unknown.status).toBe("unknown");
  });
});
