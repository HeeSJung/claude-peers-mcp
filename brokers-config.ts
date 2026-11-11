/**
 * Loader for `~/.crew-peers/brokers.json` and `~/.crew-peers/secret-current`.
 *
 * Schema (brokers.json):
 *   {
 *     "schema": 1,
 *     "self_machine": "oregon",
 *     "self_ts_addr": "100.64.0.5:7900",
 *     "peers": [
 *       {
 *         "machine":   "mac",
 *         "ts_addr":   "100.64.0.7:7900",
 *         "ssh_alias": "mac-broker-secret"
 *       }
 *     ]
 *   }
 *
 * `self_ts_addr` is informational; the broker actually binds based on
 * `tailscale ip --1` and `CLAUDE_PEERS_PEER_PORT` (default 7900) at runtime.
 *
 * `secret-current`: 64 hex chars (32 bytes) on a single line. Mode 600.
 *
 * brokers.json is built, not hand-written: `buildBrokersConfig` derives it from the
 * host registry (shared `data/hosts.json`, ADR-0064), so no address is typed here.
 * `bun cli.ts brokers-config <self>` prints it.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "/tmp";
export const CONFIG_DIR = process.env.CLAUDE_PEERS_CONFIG_DIR ?? join(HOME, ".crew-peers");
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

/** One row of the host registry (shared `data/hosts.json`), the fields read here. */
export interface HostRow {
  id: string;
  kind?: string;
  ssh?: string;
  tailnet?: string;
  homeRoot?: string;
  hostname?: string;
}

/**
 * The hosts that run a crew-peers broker, by place name. The KR box is in the
 * registry but runs none. A host listed here with no registry row is skipped.
 */
export const BROKER_HOSTS = ["oregon", "helsinki", "mac"] as const;

export const DEFAULT_REGISTRY = "/home/heesoo/sooth/shared/data/hosts.json";

/**
 * brokers.json for the broker on `self`: every other broker host is a peer,
 * reached at its tailnet address on the peer port, its secret fetched through
 * the `<host>-broker-secret` ssh alias. Throws on a self that is not a broker
 * host in the registry, or a broker host with no tailnet address.
 */
export function buildBrokersConfig(
  registry: HostRow[],
  self: string,
  opts: { port?: number; brokerHosts?: readonly string[] } = {},
): BrokersConfig {
  const port = opts.port ?? 7900;
  const brokerHosts = opts.brokerHosts ?? BROKER_HOSTS;
  const rows = brokerHosts.flatMap((id) => registry.filter((h) => h.id === id).slice(0, 1));
  const addrOf = (h: HostRow): string => {
    if (!h.tailnet) throw new Error(`host registry: ${h.id} has no tailnet address`);
    return `${h.tailnet}:${port}`;
  };
  const me = rows.find((h) => h.id === self);
  if (!me) throw new Error(`host registry: ${self} is not a broker host in the registry`);
  return {
    schema: 1,
    self_machine: self,
    self_ts_addr: addrOf(me),
    peers: rows
      .filter((h) => h.id !== self)
      .map((h) => ({ machine: h.id, ts_addr: addrOf(h), ssh_alias: `${h.id}-broker-secret` })),
  };
}

export function loadHostRegistry(path: string = process.env.HOST_REGISTRY ?? DEFAULT_REGISTRY): HostRow[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as HostRow[];
  if (!Array.isArray(parsed)) throw new Error(`host registry ${path}: not an array`);
  return parsed;
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
