/**
 * Loader for `~/.claude-peers/brokers.json` and `~/.claude-peers/secret-current`.
 *
 * Schema (brokers.json):
 *   {
 *     "schema": 1,
 *     "self_machine": "silas-vps",
 *     "self_ts_addr": "100.64.0.5:7900",
 *     "peers": [
 *       {
 *         "machine":   "milo-mac",
 *         "ts_addr":   "100.64.0.7:7900",
 *         "ssh_alias": "milo-broker-secret"
 *       }
 *     ]
 *   }
 *
 * `self_ts_addr` is informational; the broker actually binds based on
 * `tailscale ip --1` and `CLAUDE_PEERS_PEER_PORT` (default 7900) at runtime.
 *
 * `secret-current`: 64 hex chars (32 bytes) on a single line. Mode 600.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "/tmp";
export const CONFIG_DIR = process.env.CLAUDE_PEERS_CONFIG_DIR ?? join(HOME, ".claude-peers");
export const BROKERS_JSON = join(CONFIG_DIR, "brokers.json");
export const SECRET_CURRENT = join(CONFIG_DIR, "secret-current");

export interface BrokerPeerEntry {
  machine: string;
  ts_addr: string; // "100.64.0.7:7900"
  ssh_alias: string;
}

export interface BrokersConfig {
  schema: 1;
  self_machine: string;
  self_ts_addr: string;
  peers: BrokerPeerEntry[];
}

export function loadBrokersConfig(path: string = BROKERS_JSON): BrokersConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as BrokersConfig;
  if (parsed.schema !== 1) {
    throw new Error(`brokers.json schema mismatch: expected 1, got ${parsed.schema}`);
  }
  if (!parsed.self_machine || !parsed.self_ts_addr) {
    throw new Error("brokers.json missing self_machine or self_ts_addr");
  }
  if (!Array.isArray(parsed.peers)) {
    throw new Error("brokers.json missing peers array");
  }
  for (const p of parsed.peers) {
    if (!p.machine || !p.ts_addr || !p.ssh_alias) {
      throw new Error(`brokers.json peer missing required field: ${JSON.stringify(p)}`);
    }
  }
  return parsed;
}

/**
 * Read the current self-secret from secret-current.
 * Returns null if the file is absent.
 * Throws if file mode is too permissive (anything beyond 600).
 */
export function loadSelfSecret(path: string = SECRET_CURRENT): Buffer | null {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  // Mode mask: lower 9 bits. 0o600 = owner read/write only.
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `secret-current has insecure permissions ${mode.toString(8)} (must be 600 or stricter)`,
    );
  }
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("secret-current must be exactly 64 hex chars (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}
