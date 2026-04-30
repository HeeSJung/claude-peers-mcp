#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * Local listener:  127.0.0.1:7899   — same as v1, no auth, MCP clients only.
 * Peer listener:   <ts-ip>:7900     — v2, HMAC-required, cross-broker only.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
  PeerEventRequest,
  ForwardRequest,
  ForwardResponse,
  PeerBrokerHealthResponse,
} from "./shared/types.ts";
import { detectTailscaleIp } from "./tailscale.ts";
import {
  loadBrokersConfig,
  loadSelfSecret,
  type BrokersConfig,
  type BrokerPeerEntry,
} from "./brokers-config.ts";
import {
  HEADERS,
  buildSignedHeaders,
  verifyHmac,
  type VerifyError,
} from "./hmac.ts";
import { SshSecretFetcher } from "./secret-fetcher.ts";
import { logCrossHost, checkRate } from "./cross-host-log.ts";

const PORT_LOCAL = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const PORT_PEER = parseInt(process.env.CLAUDE_PEERS_PEER_PORT ?? "7900", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const HEALTH_INTERVAL_MS = 30_000;
const STALE_AFTER_FAILS = 3; // mark stale after 3 consecutive /health failures
const DOWN_AFTER_MS = 5 * 60 * 1000; // prune remote_peers after 5min stale
const HEARTBEAT_FANOUT_MIN_INTERVAL_MS = 10_000; // throttle heartbeat fanout

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS peer_brokers (
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

// Migration for DBs created before stale_since was added (pre-2026-04-30 fix).
// last_health_at updates on every probe attempt — including failures — so the
// janitor used to never see >5min staleness. stale_since captures the live→stale
// transition timestamp instead, decoupled from probe activity.
try {
  db.run("ALTER TABLE peer_brokers ADD COLUMN stale_since TEXT");
} catch {
  // Column already exists — no-op.
}

db.run(`
  CREATE TABLE IF NOT EXISTS remote_peers (
    machine        TEXT NOT NULL,
    id             TEXT NOT NULL,
    cwd            TEXT NOT NULL,
    git_root       TEXT,
    summary        TEXT NOT NULL DEFAULT '',
    registered_at  TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    PRIMARY KEY (machine, id)
  )
`);

// --- Stale-peer cleanup (existing behavior) ---

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      // Best-effort fanout — fire-and-forget
      void fanoutPeerEvent({
        event_type: "exit",
        machine: SELF_MACHINE,
        peer: snapshotPeerStub(peer.id),
      });
    }
  }
}

function snapshotPeerStub(id: string): PeerEventRequest["peer"] {
  return {
    id,
    cwd: "",
    git_root: null,
    summary: "",
    registered_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
}

setInterval(cleanStalePeers, 30_000);
cleanStalePeers();

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
const updateSummary = db.prepare(`UPDATE peers SET summary = ? WHERE id = ?`);
const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
const selectAllPeers = db.prepare(`SELECT * FROM peers`);
const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
const selectPeersByGitRoot = db.prepare(`SELECT * FROM peers WHERE git_root = ?`);
const selectPeerById = db.prepare(`SELECT * FROM peers WHERE id = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

const upsertPeerBroker = db.prepare(`
  INSERT INTO peer_brokers (machine, ts_addr, ssh_alias, status)
  VALUES (?, ?, ?, 'unknown')
  ON CONFLICT(machine) DO UPDATE SET ts_addr = excluded.ts_addr, ssh_alias = excluded.ssh_alias
`);
const selectAllPeerBrokers = db.prepare(`SELECT * FROM peer_brokers`);
const setBrokerStatus = db.prepare(`
  UPDATE peer_brokers SET status = ?, last_health_at = ?, consecutive_health_failures = ?, stale_since = ?
  WHERE machine = ?
`);
const setBrokerDown = db.prepare(`
  UPDATE peer_brokers SET status = 'down' WHERE machine = ?
`);
const setBrokerEventTs = db.prepare(`
  UPDATE peer_brokers SET last_event_at = ? WHERE machine = ?
`);

const upsertRemotePeer = db.prepare(`
  INSERT INTO remote_peers (machine, id, cwd, git_root, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(machine, id) DO UPDATE SET
    cwd = excluded.cwd,
    git_root = excluded.git_root,
    summary = excluded.summary,
    last_seen = excluded.last_seen
`);
const deleteRemotePeer = db.prepare(`DELETE FROM remote_peers WHERE machine = ? AND id = ?`);
const deleteRemotePeersByMachine = db.prepare(`DELETE FROM remote_peers WHERE machine = ?`);
const selectAllRemotePeers = db.prepare(`SELECT * FROM remote_peers`);
const selectRemotePeerById = db.prepare(`
  SELECT * FROM remote_peers WHERE id = ? LIMIT 1
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Cross-broker config + secrets ---

let brokersConfig: BrokersConfig | null = null;
let SELF_MACHINE = process.env.CLAUDE_PEERS_SELF_MACHINE ?? "unknown";
let SELF_SECRET: Buffer | null = null;
const sshFetcher = new SshSecretFetcher();
const peerEntries = new Map<string, BrokerPeerEntry>();
// Last heartbeat fanout per peer-id (throttling)
const lastHeartbeatFanout = new Map<string, number>();

async function loadCrossBrokerState(): Promise<void> {
  brokersConfig = loadBrokersConfig();
  if (!brokersConfig) return;
  SELF_MACHINE = brokersConfig.self_machine;
  SELF_SECRET = loadSelfSecret();
  for (const peer of brokersConfig.peers) {
    upsertPeerBroker.run(peer.machine, peer.ts_addr, peer.ssh_alias);
    peerEntries.set(peer.machine, peer);
  }
  console.error(
    `[claude-peers broker] loaded brokers config: self=${SELF_MACHINE}, peers=${brokersConfig.peers.length}`,
  );
}

/**
 * Each broker publishes its OWN secret via secret-current. Outbound requests
 * are signed with SELF_SECRET ("I am me"). Inbound requests are verified
 * against the SENDER's secret (fetched via SSH). The X-Peer-Broker-Machine
 * header tells us which sender we're talking to.
 */
function resolvePeerSecretSync(machine: string): Buffer | Uint8Array | null {
  // Sync getter into the SshSecretFetcher cache. Used by verifyHmac.
  return (sshFetcher as unknown as { cache: Map<string, Buffer> }).cache.get(machine) ?? null;
}

async function ensurePeerSecret(machine: string): Promise<Buffer | null> {
  const entry = peerEntries.get(machine);
  if (!entry) return null;
  try {
    const buf = await sshFetcher.fetch(machine, entry.ssh_alias);
    void logCrossHost(`SECRET-FETCH ${machine} OK`);
    return buf;
  } catch (e) {
    void logCrossHost(`SECRET-FETCH ${machine} ERR ${(e as Error).message}`);
    return null;
  }
}

// --- Local request handlers ---

function snapshotLocalPeer(id: string): PeerEventRequest["peer"] | null {
  const row = selectPeerById.get(id) as
    | (Peer & { registered_at: string; last_seen: string })
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    cwd: row.cwd,
    git_root: row.git_root,
    summary: row.summary,
    registered_at: row.registered_at,
    last_seen: row.last_seen,
  };
}

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as
    | { id: string }
    | null;
  if (existing) {
    deletePeer.run(existing.id);
    void fanoutPeerEvent({
      event_type: "exit",
      machine: SELF_MACHINE,
      peer: snapshotPeerStub(existing.id),
    });
  }
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  const snap = snapshotLocalPeer(id);
  if (snap) {
    void fanoutPeerEvent({ event_type: "register", machine: SELF_MACHINE, peer: snap });
  }
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
  // Throttle heartbeat fanout — every HEARTBEAT_FANOUT_MIN_INTERVAL_MS at most.
  const now = Date.now();
  const last = lastHeartbeatFanout.get(body.id) ?? 0;
  if (now - last >= HEARTBEAT_FANOUT_MIN_INTERVAL_MS) {
    lastHeartbeatFanout.set(body.id, now);
    const snap = snapshotLocalPeer(body.id);
    if (snap) {
      void fanoutPeerEvent({ event_type: "heartbeat", machine: SELF_MACHINE, peer: snap });
    }
  }
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
  const snap = snapshotLocalPeer(body.id);
  if (snap) {
    void fanoutPeerEvent({ event_type: "summary-change", machine: SELF_MACHINE, peer: snap });
  }
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];
  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      else peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "machine+remote": {
      const local = selectAllPeers.all() as Peer[];
      const remote = selectAllRemotePeers.all() as Array<{
        machine: string;
        id: string;
        cwd: string;
        git_root: string | null;
        summary: string;
        registered_at: string;
        last_seen: string;
      }>;
      const remoteAsPeer: Peer[] = remote.map((r) => ({
        id: `${r.id}@${r.machine}`,
        pid: 0,
        cwd: r.cwd,
        git_root: r.git_root,
        tty: null,
        summary: r.summary,
        registered_at: r.registered_at,
        last_seen: r.last_seen,
      }));
      peers = [...local, ...remoteAsPeer];
      break;
    }
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify local peers' processes are still alive. Skip pid check for remote peers (pid=0).
  return peers.filter((p) => {
    if (p.pid === 0) return true;
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      deletePeer.run(p.id);
      return false;
    }
  });
}

async function handleSendMessage(
  body: SendMessageRequest,
): Promise<{ ok: boolean; error?: string }> {
  // Detect @machine suffix → forward.
  const at = body.to_id.lastIndexOf("@");
  if (at > 0) {
    const targetId = body.to_id.slice(0, at);
    const targetMachine = body.to_id.slice(at + 1);
    return forwardToRemoteBroker(targetMachine, {
      from_id: body.from_id,
      from_machine: SELF_MACHINE,
      to_id: targetId,
      text: body.text,
      sent_at: new Date().toISOString(),
    });
  }

  // Cross-check remote_peers — if the bare id is unique to a single remote peer,
  // forward there too. Required because today's MCP clients don't yet emit the
  // @machine suffix.
  const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as
    | { id: string }
    | null;
  if (localTarget) {
    insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
    return { ok: true };
  }
  const remoteRow = selectRemotePeerById.get(body.to_id) as
    | { machine: string; id: string }
    | undefined;
  if (remoteRow) {
    return forwardToRemoteBroker(remoteRow.machine, {
      from_id: body.from_id,
      from_machine: SELF_MACHINE,
      to_id: remoteRow.id,
      text: body.text,
      sent_at: new Date().toISOString(),
    });
  }
  return { ok: false, error: `Peer ${body.to_id} not found` };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) markDelivered.run(msg.id);
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  // Snapshot before delete so fanout has the cwd/summary.
  const snap = snapshotLocalPeer(body.id);
  deletePeer.run(body.id);
  if (snap) {
    void fanoutPeerEvent({ event_type: "exit", machine: SELF_MACHINE, peer: snap });
  }
}

// --- Cross-broker outbound ---

interface FanoutAttempt {
  attempt: number;
  ok: boolean;
  err?: string;
}

async function fanoutPeerEvent(event: PeerEventRequest): Promise<void> {
  if (!brokersConfig) return; // single-broker mode — nothing to fan out to
  const brokers = selectAllPeerBrokers.all() as Array<{
    machine: string;
    ts_addr: string;
    ssh_alias: string;
    status: string;
  }>;
  const targets = brokers.filter((b) => b.machine !== SELF_MACHINE);
  await Promise.all(
    targets.map(async (b) => {
      const result = await peerPostJson<{ ok: boolean }>(b.machine, "POST", "/peer-events", event);
      const eventLabel = `${event.event_type} ${event.peer.id}`;
      if (result.ok) {
        void logCrossHost(`EVENT-OUT ${b.machine} ${eventLabel} OK`);
      } else {
        void logCrossHost(`EVENT-OUT ${b.machine} ${eventLabel} ERR ${result.error ?? "?"}`);
      }
    }),
  );
}

async function forwardToRemoteBroker(
  machine: string,
  body: ForwardRequest,
): Promise<ForwardResponse> {
  const result = await peerPostJson<ForwardResponse>(machine, "POST", "/forward", body);
  const label = `${body.from_id}→${body.to_id}`;
  if (result.ok && result.data?.ok) {
    void logCrossHost(`FORWARD-OUT ${machine} ${label} OK`);
    return { ok: true };
  }
  const reason = result.error ?? result.data?.error ?? "unknown";
  void logCrossHost(`FORWARD-OUT ${machine} ${label} ERR ${reason}`);
  if (result.data?.ok === false && result.data.error === "peer-not-found") {
    // Stale remote_peers entry — clean it up.
    deleteRemotePeer.run(machine, body.to_id);
  }
  return { ok: false, error: reason };
}

interface PostResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function peerPostJson<T>(
  machine: string,
  method: "POST" | "GET",
  path: string,
  body: unknown,
): Promise<PostResult<T>> {
  const entry = peerEntries.get(machine);
  if (!entry) return { ok: false, error: `unknown-machine ${machine}` };
  if (!SELF_SECRET) return { ok: false, error: "no-self-secret" };
  const bodyStr = method === "GET" ? "" : JSON.stringify(body ?? {});
  const headers = buildSignedHeaders({
    selfMachine: SELF_MACHINE,
    secret: SELF_SECRET,
    method,
    path,
    body: bodyStr,
  });
  const url = `http://${entry.ts_addr}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : bodyStr,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status}` };
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// --- Cross-broker inbound (HMAC-protected) ---

function authFail(res: { error: VerifyError }, path: string, machineHdr: string | null): Response {
  void logCrossHost(`AUTH-FAIL ${machineHdr ?? "?"} ${path} ${res.error}`);
  return Response.json({ error: res.error }, { status: 401 });
}

async function handlePeerRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const bodyStr = method === "GET" ? "" : await req.text();
  const machineHdr = req.headers.get(HEADERS.Machine);

  if (!machineHdr) {
    return authFail({ error: "missing-header" }, path, null);
  }
  if (!peerEntries.has(machineHdr)) {
    return authFail({ error: "unknown-machine" }, path, machineHdr);
  }

  // Ensure the sender's secret is cached. Lazy-fetch via SSH on first contact.
  if (!resolvePeerSecretSync(machineHdr)) {
    const fetched = await ensurePeerSecret(machineHdr);
    if (!fetched) {
      return authFail({ error: "unknown-machine" }, path, machineHdr);
    }
  }

  // First verify attempt — using cached secret.
  let verify = verifyHmac({
    headers: req.headers,
    method,
    path,
    body: bodyStr,
    resolveSecret: (m) => (m === machineHdr ? resolvePeerSecretSync(m) : null),
  });

  // Bad-sig may mean the peer rotated their secret. Refetch + retry ONCE.
  if (!verify.ok && verify.error === "bad-sig") {
    sshFetcher.invalidate(machineHdr);
    const refreshed = await ensurePeerSecret(machineHdr);
    if (refreshed) {
      verify = verifyHmac({
        headers: req.headers,
        method,
        path,
        body: bodyStr,
        resolveSecret: (m) => (m === machineHdr ? resolvePeerSecretSync(m) : null),
      });
    }
  }

  if (!verify.ok) {
    return authFail(verify, path, machineHdr);
  }
  const machine = verify.machine;

  // Rate limit per peer-machine.
  if (!checkRate(machine)) {
    void logCrossHost(`RATE-LIMIT ${machine} ${path}`);
    return Response.json({ error: "rate-limit" }, { status: 429 });
  }

  try {
    const json = bodyStr ? JSON.parse(bodyStr) : {};
    switch (`${method} ${path}`) {
      case "POST /peer-events": {
        const ev = json as PeerEventRequest;
        if (ev.machine !== machine) {
          return authFail({ error: "bad-sig" }, path, machine);
        }
        applyPeerEvent(ev);
        setBrokerEventTs.run(new Date().toISOString(), machine);
        void logCrossHost(`EVENT-IN ${machine} ${ev.event_type} ${ev.peer.id} OK`);
        return Response.json({ ok: true });
      }
      case "POST /forward": {
        const fw = json as ForwardRequest;
        if (fw.from_machine !== machine) {
          return authFail({ error: "bad-sig" }, path, machine);
        }
        const target = selectPeerById.get(fw.to_id) as Peer | undefined;
        if (!target) {
          void logCrossHost(`FORWARD-IN ${machine} ${fw.from_id}→${fw.to_id} ERR peer-not-found`);
          return Response.json({ ok: false, error: "peer-not-found" }, { status: 404 });
        }
        const mangledFrom = `${fw.from_id}@${fw.from_machine}`;
        insertMessage.run(mangledFrom, fw.to_id, fw.text, fw.sent_at);
        void logCrossHost(`FORWARD-IN ${machine} ${fw.from_id}→${fw.to_id} OK`);
        return Response.json({ ok: true });
      }
      case "GET /health": {
        const peerCount = (selectAllPeers.all() as Peer[]).length;
        const remoteCount = (selectAllRemotePeers.all() as unknown[]).length;
        const resp: PeerBrokerHealthResponse = {
          status: "ok",
          machine: SELF_MACHINE,
          peer_count: peerCount,
          remote_peer_count: remoteCount,
        };
        void logCrossHost(`HEALTH-IN ${machine} OK`);
        return Response.json(resp);
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

function applyPeerEvent(ev: PeerEventRequest): void {
  if (ev.event_type === "exit") {
    deleteRemotePeer.run(ev.machine, ev.peer.id);
    return;
  }
  // register, heartbeat, summary-change all upsert.
  upsertRemotePeer.run(
    ev.machine,
    ev.peer.id,
    ev.peer.cwd,
    ev.peer.git_root,
    ev.peer.summary,
    ev.peer.registered_at,
    ev.peer.last_seen,
  );
}

// --- Health probe (outbound) + janitor ---

async function probeOnePeer(machine: string): Promise<void> {
  const result = await peerPostJson<PeerBrokerHealthResponse>(machine, "GET", "/health", null);
  const now = new Date().toISOString();
  const row = db.query(
    "SELECT consecutive_health_failures, status, stale_since FROM peer_brokers WHERE machine = ?",
  ).get(machine) as
    | { consecutive_health_failures: number; status: string; stale_since: string | null }
    | undefined;
  const fails = row?.consecutive_health_failures ?? 0;
  const prevStatus = row?.status ?? "unknown";

  if (result.ok) {
    // live: clear stale_since so the janitor doesn't keep counting from an
    // earlier outage if the peer flapped.
    setBrokerStatus.run("live", now, 0, null, machine);
    void logCrossHost(`HEALTH-OUT ${machine} OK`);
    return;
  }

  const newFails = fails + 1;
  const newStatus = newFails >= STALE_AFTER_FAILS ? "stale" : prevStatus;
  // Capture stale_since on the live→stale transition only. Preserve the
  // existing stamp on stale→stale so the janitor measures elapsed-stale,
  // not elapsed-since-last-probe (the bug Silas caught 2026-04-30).
  let newStaleSince = row?.stale_since ?? null;
  if (newStatus === "stale" && (prevStatus !== "stale" || newStaleSince === null)) {
    newStaleSince = now;
  }
  setBrokerStatus.run(newStatus, now, newFails, newStaleSince, machine);
  void logCrossHost(
    `HEALTH-OUT ${machine} ERR ${result.error ?? "?"} (${newFails}/${STALE_AFTER_FAILS})`,
  );
}

async function healthLoop(): Promise<void> {
  if (!brokersConfig) return;
  const brokers = selectAllPeerBrokers.all() as Array<{ machine: string }>;
  await Promise.all(brokers.filter((b) => b.machine !== SELF_MACHINE).map((b) => probeOnePeer(b.machine)));
}

function janitor(): void {
  const now = Date.now();
  const brokers = selectAllPeerBrokers.all() as Array<{
    machine: string;
    status: string;
    stale_since: string | null;
  }>;
  for (const b of brokers) {
    if (b.machine === SELF_MACHINE) continue;
    if (b.status === "stale" && b.stale_since) {
      const staleMs = Date.parse(b.stale_since);
      if (Number.isFinite(staleMs) && now - staleMs > DOWN_AFTER_MS) {
        setBrokerDown.run(b.machine);
        deleteRemotePeersByMachine.run(b.machine);
        void logCrossHost(`PRUNE ${b.machine} remote_peers (stale >5min)`);
      }
    }
  }
}

// --- Local HTTP listener (127.0.0.1:7899) ---

async function handleLocalRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method !== "POST") {
    if (path === "/health") {
      return Response.json({
        status: "ok",
        peers: (selectAllPeers.all() as Peer[]).length,
        machine: SELF_MACHINE,
      });
    }
    return new Response("claude-peers broker", { status: 200 });
  }

  try {
    const body = await req.json();
    switch (path) {
      case "/register":
        return Response.json(handleRegister(body as RegisterRequest));
      case "/heartbeat":
        handleHeartbeat(body as HeartbeatRequest);
        return Response.json({ ok: true });
      case "/set-summary":
        handleSetSummary(body as SetSummaryRequest);
        return Response.json({ ok: true });
      case "/list-peers":
        return Response.json(handleListPeers(body as ListPeersRequest));
      case "/send-message": {
        const result = await handleSendMessage(body as SendMessageRequest);
        return Response.json(result);
      }
      case "/poll-messages":
        return Response.json(handlePollMessages(body as PollMessagesRequest));
      case "/unregister":
        handleUnregister(body as { id: string });
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// --- Startup ---

async function main(): Promise<void> {
  await loadCrossBrokerState();

  Bun.serve({
    port: PORT_LOCAL,
    hostname: "127.0.0.1",
    fetch: handleLocalRequest,
  });
  console.error(`[claude-peers broker] local listener: 127.0.0.1:${PORT_LOCAL} (db: ${DB_PATH})`);

  // Tailscale listener — only if brokers.json exists. Without it, single-broker mode.
  if (brokersConfig) {
    if (!SELF_SECRET) {
      console.error(
        `[claude-peers broker] WARNING: brokers.json present but secret-current missing — peer listener will NOT start. Generate a secret first.`,
      );
    } else {
      // CLAUDE_PEERS_BIND_TS_IP overrides Tailscale detection (used by loopback smoke tests).
      const tsIp = process.env.CLAUDE_PEERS_BIND_TS_IP ?? (await detectTailscaleIp());
      if (!tsIp) {
        console.error(
          `[claude-peers broker] WARNING: brokers.json present but Tailscale not detected — peer listener will NOT start.`,
        );
      } else {
        Bun.serve({
          port: PORT_PEER,
          hostname: tsIp, // explicit interface bind, NEVER 0.0.0.0
          fetch: handlePeerRequest,
        });
        console.error(`[claude-peers broker] peer listener:  ${tsIp}:${PORT_PEER}`);
        console.error(
          `[claude-peers broker] peers: ${brokersConfig.peers.map((p) => p.machine).join(", ") || "(none)"}`,
        );
        // Periodic health probe + janitor
        setInterval(() => void healthLoop(), HEALTH_INTERVAL_MS);
        setInterval(janitor, HEALTH_INTERVAL_MS);
      }
    }
  } else {
    console.error(`[claude-peers broker] no brokers.json — single-broker mode (v1 compat)`);
  }
}

void main().catch((e) => {
  console.error(`[claude-peers broker] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
