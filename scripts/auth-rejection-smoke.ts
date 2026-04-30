#!/usr/bin/env bun
/**
 * HTTP-level smoke test: replay attack + clock-skew rejection at the live
 * peer listener. Spins one broker, fires manually-signed requests at it.
 *
 * Run: bun scripts/auth-rejection-smoke.ts
 */

import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildSignedHeaders, HEADERS } from "../hmac.ts";

const TS_IP = "127.0.0.1";
const SECRET_HEX_A = "a".repeat(64);
const SECRET_HEX_B = "b".repeat(64);

const A_DIR = "/tmp/auth-smoke-A/.config";
const B_DIR = "/tmp/auth-smoke-B/.config";
const A_DB = "/tmp/auth-smoke-A/db.sqlite";
const A_LOCAL = 37899;
const A_PEER = 37900;
const B_PEER = 37910; // B doesn't actually run; we just claim to be it.

function setupA() {
  rmSync("/tmp/auth-smoke-A", { recursive: true, force: true });
  rmSync("/tmp/auth-smoke-B", { recursive: true, force: true });
  mkdirSync(A_DIR, { recursive: true });
  mkdirSync(B_DIR, { recursive: true });
  writeFileSync(
    join(A_DIR, "brokers.json"),
    JSON.stringify({
      schema: 1,
      self_machine: "silas-vps",
      self_ts_addr: `${TS_IP}:${A_PEER}`,
      peers: [
        {
          machine: "milo-mac",
          ts_addr: `${TS_IP}:${B_PEER}`,
          ssh_alias: `__test_secret__:${B_DIR}/secret-current`,
        },
      ],
    }),
  );
  writeFileSync(join(A_DIR, "secret-current"), SECRET_HEX_A);
  chmodSync(join(A_DIR, "secret-current"), 0o600);
  // B's secret file (B never starts; we just need its secret on disk for A to fetch)
  writeFileSync(join(B_DIR, "secret-current"), SECRET_HEX_B);
  chmodSync(join(B_DIR, "secret-current"), 0o600);
}

function pass(label: string) {
  console.log(`✓ ${label}`);
}
function fail(label: string, info?: unknown): never {
  console.log(`✗ ${label}`);
  if (info !== undefined) console.log("  ", info);
  process.exit(1);
}

let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;

async function startA() {
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  proc = spawn({
    cmd: ["bun", brokerPath],
    env: {
      ...process.env,
      CLAUDE_PEERS_CONFIG_DIR: A_DIR,
      CLAUDE_PEERS_DB: A_DB,
      CLAUDE_PEERS_PORT: String(A_LOCAL),
      CLAUDE_PEERS_PEER_PORT: String(A_PEER),
      CLAUDE_PEERS_BIND_TS_IP: TS_IP,
      CLAUDE_PEERS_SECRET_FETCH_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for local /health
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const r = await fetch(`http://127.0.0.1:${A_LOCAL}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) return;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("A failed to start");
}

async function killA() {
  if (proc) {
    proc.kill("SIGTERM");
    await proc.exited;
    proc = null;
  }
}

async function main() {
  console.log("Auth rejection smoke test");
  setupA();
  await startA();
  pass("A broker up");

  const url = `http://${TS_IP}:${A_PEER}/peer-events`;
  const body = JSON.stringify({
    event_type: "heartbeat",
    machine: "milo-mac",
    peer: {
      id: "spoofy",
      cwd: "/tmp",
      git_root: null,
      summary: "spoof",
      registered_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    },
  });

  // Test 1: valid signed request — should be 200.
  // (Note: A will fetch B's secret via the test-mode SSH-alias; B never runs.)
  {
    const headers = buildSignedHeaders({
      selfMachine: "milo-mac",
      secret: Buffer.from(SECRET_HEX_B, "hex"),
      method: "POST",
      path: "/peer-events",
      body,
    });
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    if (!r.ok) {
      const t = await r.text();
      fail(`valid signed request rejected (${r.status}: ${t})`);
    }
    pass("valid signed request accepted (HMAC verifies, secret fetched via SSH alias)");
  }

  // Test 2: replay — same nonce twice.
  {
    const ts = Date.now();
    const nonce = "deadbeef".repeat(4);
    const headers = buildSignedHeaders({
      selfMachine: "milo-mac",
      secret: Buffer.from(SECRET_HEX_B, "hex"),
      method: "POST",
      path: "/peer-events",
      body,
      tsMillis: ts,
      nonce,
    });
    const r1 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    if (!r1.ok) fail(`first replay req rejected: ${r1.status}`);
    const r2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    if (r2.status !== 401) fail(`replay should be 401, got ${r2.status}`);
    const j = (await r2.json()) as { error: string };
    if (j.error !== "nonce-replay") fail(`expected nonce-replay, got ${j.error}`);
    pass("replay (same nonce twice) → 401 nonce-replay");
  }

  // Test 3: clock skew — ts 60s in the past.
  {
    const headers = buildSignedHeaders({
      selfMachine: "milo-mac",
      secret: Buffer.from(SECRET_HEX_B, "hex"),
      method: "POST",
      path: "/peer-events",
      body,
      tsMillis: Date.now() - 60_000,
    });
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    if (r.status !== 401) fail(`clock-skew should be 401, got ${r.status}`);
    const j = (await r.json()) as { error: string };
    if (j.error !== "clock-skew") fail(`expected clock-skew, got ${j.error}`);
    pass("ts 60s in past → 401 clock-skew");
  }

  // Test 4: tampered body — sign one body, send another.
  {
    const headers = buildSignedHeaders({
      selfMachine: "milo-mac",
      secret: Buffer.from(SECRET_HEX_B, "hex"),
      method: "POST",
      path: "/peer-events",
      body: '{"original":true}',
    });
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: '{"tampered":true}',
    });
    if (r.status !== 401) fail(`tampered body should be 401, got ${r.status}`);
    const j = (await r.json()) as { error: string };
    // Could be bad-sig (because re-sign with different body produces different sig)
    if (j.error !== "bad-sig") fail(`expected bad-sig, got ${j.error}`);
    pass("tampered body → 401 bad-sig");
  }

  // Test 5: missing X-Peer-Broker-Sig header.
  {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [HEADERS.Machine]: "milo-mac",
        [HEADERS.Ts]: String(Date.now()),
        [HEADERS.Nonce]: "abc",
      },
      body,
    });
    if (r.status !== 401) fail(`missing-header should be 401, got ${r.status}`);
    const j = (await r.json()) as { error: string };
    if (j.error !== "missing-header") fail(`expected missing-header, got ${j.error}`);
    pass("missing X-Peer-Broker-Sig → 401 missing-header");
  }

  await killA();
  rmSync("/tmp/auth-smoke-A", { recursive: true, force: true });
  rmSync("/tmp/auth-smoke-B", { recursive: true, force: true });
  console.log("\n✅ All auth-rejection tests passed");
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  await killA();
  process.exit(1);
});
