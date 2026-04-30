#!/usr/bin/env bun
/**
 * Loopback smoke test for v2 cross-broker behavior.
 *
 * Spins up TWO brokers on the same Tailscale interface, on different ports,
 * with different "machine" identities, and verifies:
 *   - Each broker binds local + peer listener
 *   - Brokers can mutually reach each other's /health (HMAC OK)
 *   - peer-events from "silas-vps" propagate into "milo-mac"'s remote_peers
 *   - /forward delivers a message from silas → milo (recipient receives via long-poll)
 *
 * Both brokers share the *same* secret-current file for this test (since they
 * are the same machine for SSH purposes — the SSH lookup resolves to the same
 * file via a fake `ssh_alias` mapping in our test harness).
 *
 * Run: bun scripts/loopback-smoke.ts
 */

import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const TS_IP = "127.0.0.1"; // bind to loopback for the test (real broker uses real ts-ip)

const SECRET_HEX_A = "a".repeat(64);
const SECRET_HEX_B = "b".repeat(64);

interface FakeBroker {
  machine: string;
  configDir: string;
  dbPath: string;
  localPort: number;
  peerPort: number;
  proc: Subprocess<"ignore", "pipe", "pipe"> | null;
}

const A: FakeBroker = {
  machine: "silas-vps",
  configDir: "/tmp/loopback-A/.config",
  dbPath: "/tmp/loopback-A/db.sqlite",
  localPort: 27899,
  peerPort: 27900,
  proc: null,
};
const B: FakeBroker = {
  machine: "milo-mac",
  configDir: "/tmp/loopback-B/.config",
  dbPath: "/tmp/loopback-B/db.sqlite",
  localPort: 28899,
  peerPort: 28900,
  proc: null,
};

function setupBrokerConfig(b: FakeBroker, peer: FakeBroker, secretHex: string) {
  rmSync(b.configDir, { recursive: true, force: true });
  rmSync(b.dbPath, { force: true });
  rmSync(`${b.dbPath}-shm`, { force: true });
  rmSync(`${b.dbPath}-wal`, { force: true });
  mkdirSync(b.configDir, { recursive: true });
  writeFileSync(
    join(b.configDir, "brokers.json"),
    JSON.stringify({
      schema: 1,
      self_machine: b.machine,
      self_ts_addr: `${TS_IP}:${b.peerPort}`,
      peers: [
        {
          machine: peer.machine,
          ts_addr: `${TS_IP}:${peer.peerPort}`,
          ssh_alias: `__test_secret__:${peer.configDir}/secret-current`,
        },
      ],
    }),
  );
  writeFileSync(join(b.configDir, "secret-current"), secretHex);
  chmodSync(join(b.configDir, "secret-current"), 0o600);
}

async function startBroker(b: FakeBroker): Promise<void> {
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  b.proc = spawn({
    cmd: [
      "bun",
      brokerPath,
    ],
    env: {
      ...process.env,
      CLAUDE_PEERS_CONFIG_DIR: b.configDir,
      CLAUDE_PEERS_DB: b.dbPath,
      CLAUDE_PEERS_PORT: String(b.localPort),
      CLAUDE_PEERS_PEER_PORT: String(b.peerPort),
      // Override the bind interface — broker.ts uses `tailscale ip --1`,
      // but for the loopback smoke test we patch via a known-loopback IP
      // by setting CLAUDE_PEERS_BIND_TS_IP, then the broker prefers that
      // over `tailscale ip` if the env var is set. (See broker.ts main()).
      CLAUDE_PEERS_BIND_TS_IP: TS_IP,
      // Likewise patch the SSH fetcher: if the alias starts with "__test_secret__:",
      // the test fetcher reads from the path after the colon directly.
      CLAUDE_PEERS_SECRET_FETCH_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitFor(url: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function localPost<T>(b: FakeBroker, path: string, body: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${b.localPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function killBroker(b: FakeBroker): Promise<void> {
  if (b.proc) {
    b.proc.kill("SIGTERM");
    await b.proc.exited;
    b.proc = null;
  }
}

async function dumpStderr(b: FakeBroker): Promise<string> {
  if (!b.proc) return "";
  const reader = b.proc.stderr.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((res) =>
        setTimeout(() => res({ done: true, value: undefined }), 100),
      ),
    ]);
    if (r.done) break;
    if (r.value) chunks.push(r.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

function pass(label: string) {
  console.log(`✓ ${label}`);
}
function fail(label: string, info?: unknown): never {
  console.log(`✗ ${label}`);
  if (info !== undefined) console.log("  ", info);
  process.exit(1);
}

async function main() {
  console.log("Loopback smoke test — v2 broker-to-broker");

  // Setup: two configs, each pointing at the OTHER as a peer.
  // Each broker has its own secret. The "ssh_alias" is a magic string that
  // the test-mode fetcher reads from a literal file path.
  setupBrokerConfig(A, B, SECRET_HEX_A);
  setupBrokerConfig(B, A, SECRET_HEX_B);

  // Start both brokers.
  await startBroker(A);
  await startBroker(B);

  const upA = await waitFor(`http://127.0.0.1:${A.localPort}/health`);
  const upB = await waitFor(`http://127.0.0.1:${B.localPort}/health`);
  if (!upA) fail("A broker failed to start", await dumpStderr(A));
  if (!upB) fail("B broker failed to start", await dumpStderr(B));
  pass("both brokers up (local /health responding)");

  // Wait briefly for cross-broker /health probes to settle.
  await new Promise((r) => setTimeout(r, 1500));

  // §1: Register a peer on A. Verify it appears in B's remote_peers via peer-events.
  const reg = await localPost<{ id: string }>(A, "/register", {
    pid: process.pid + 99999, // fake pid; cleanStalePeers will eventually wipe
    cwd: "/test/cwd-a",
    git_root: "/test/cwd-a",
    tty: null,
    summary: "test-A-summary",
  });
  pass(`peer registered on A: ${reg.id}`);

  // Force a fanout to settle (HTTP RTT is fast on loopback).
  await new Promise((r) => setTimeout(r, 800));

  // Probe B's local /list-peers with scope=machine+remote — should include A's peer with @silas-vps suffix.
  const peers = await localPost<Array<{ id: string; summary: string }>>(B, "/list-peers", {
    scope: "machine+remote",
    cwd: "/anywhere",
    git_root: null,
  });
  const remoteRow = peers.find((p) => p.id === `${reg.id}@${A.machine}`);
  if (!remoteRow) {
    fail("B does not see A's peer via /list-peers machine+remote", peers);
  }
  pass("A's peer propagated to B's remote_peers (machine+remote scope sees it)");

  // §2: From A, send a message to A's local peer (should INSERT locally).
  // First, register a peer on B so we can target it.
  const regB = await localPost<{ id: string }>(B, "/register", {
    pid: process.pid + 99998,
    cwd: "/test/cwd-b",
    git_root: "/test/cwd-b",
    tty: null,
    summary: "test-B-summary",
  });
  pass(`peer registered on B: ${regB.id}`);

  // Wait for the new peer to propagate to A's remote_peers
  await new Promise((r) => setTimeout(r, 800));

  // Send a message from A to "regB@milo-mac" — should /forward to B and land in B's messages.
  const sendResp = await localPost<{ ok: boolean; error?: string }>(A, "/send-message", {
    from_id: reg.id,
    to_id: `${regB.id}@${B.machine}`,
    text: "hello-from-A",
  });
  if (!sendResp.ok) fail("send-message cross-host returned !ok", sendResp);
  pass("send-message cross-host accepted at A");

  // Poll messages on B for regB.
  await new Promise((r) => setTimeout(r, 300));
  const polled = await localPost<{ messages: Array<{ from_id: string; text: string }> }>(
    B,
    "/poll-messages",
    { id: regB.id },
  );
  const got = polled.messages.find((m) => m.text === "hello-from-A");
  if (!got) fail("B did not receive forwarded message", polled);
  if (got.from_id !== `${reg.id}@${A.machine}`) {
    fail(`forwarded message has wrong from_id: ${got.from_id}`);
  }
  pass(`B received forwarded message; from_id=${got.from_id}`);

  // §3: Test /forward to non-existent peer (should return ok=false).
  const stale = await localPost<{ ok: boolean; error?: string }>(A, "/send-message", {
    from_id: reg.id,
    to_id: `nonexistent@${B.machine}`,
    text: "should-fail",
  });
  if (stale.ok) fail("forward to non-existent peer should fail");
  pass(`forward to non-existent peer correctly returned !ok (${stale.error})`);

  // §4: Cleanup — unregister and verify exit propagates.
  await localPost(A, "/unregister", { id: reg.id });
  await new Promise((r) => setTimeout(r, 800));
  const peersAfterExit = await localPost<Array<{ id: string }>>(B, "/list-peers", {
    scope: "machine+remote",
    cwd: "/anywhere",
    git_root: null,
  });
  if (peersAfterExit.find((p) => p.id === `${reg.id}@${A.machine}`)) {
    fail("A's exit did not propagate to B (peer still in remote_peers)");
  }
  pass("A's exit event removed peer from B's remote_peers");

  // Cleanup
  await killBroker(A);
  await killBroker(B);
  rmSync("/tmp/loopback-A", { recursive: true, force: true });
  rmSync("/tmp/loopback-B", { recursive: true, force: true });

  console.log("\n✅ All loopback smoke tests passed");
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  console.error("--- A stderr ---", await dumpStderr(A));
  console.error("--- B stderr ---", await dumpStderr(B));
  await killBroker(A);
  await killBroker(B);
  process.exit(1);
});
