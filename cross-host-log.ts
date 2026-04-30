/**
 * Cross-host audit log + simple per-peer rate limiter.
 *
 * Append-only at ~/.claude-peers/cross-host.log. Format:
 *   <iso-ts> <DIRECTION-EVENT> <peer-machine> <details...> <result>
 *
 * Examples:
 *   2026-04-30T17:30:00Z EVENT-OUT milo-mac register peer-7sk2ab12 OK
 *   2026-04-30T17:30:00Z EVENT-IN  milo-mac heartbeat peer-7sk2ab12 OK
 *   2026-04-30T17:30:00Z FORWARD-OUT milo-mac ec39idnw→7sk2ab12 OK
 *   2026-04-30T17:30:00Z AUTH-FAIL milo-mac /peer-events nonce-replay
 *   2026-04-30T17:30:00Z HEALTH-OUT milo-mac OK
 *   2026-04-30T17:30:00Z SECRET-FETCH milo-mac OK
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_DIR } from "./brokers-config.ts";
import { join } from "node:path";

export const CROSS_HOST_LOG = process.env.CLAUDE_PEERS_CROSS_HOST_LOG ?? join(CONFIG_DIR, "cross-host.log");

let ensureDirOnce: Promise<void> | null = null;
async function ensureDir(): Promise<void> {
  if (!ensureDirOnce) {
    ensureDirOnce = mkdir(dirname(CROSS_HOST_LOG), { recursive: true }).then(() => undefined);
  }
  return ensureDirOnce;
}

export async function logCrossHost(line: string): Promise<void> {
  try {
    await ensureDir();
    const ts = new Date().toISOString();
    await appendFile(CROSS_HOST_LOG, `${ts} ${line}\n`, "utf8");
  } catch (e) {
    // Logging is best-effort — never crash the broker on log failures.
    console.error("[cross-host-log] write failed:", e instanceof Error ? e.message : e);
  }
}

// --- Rate limiter -----------------------------------------------------------

interface Bucket {
  windowStart: number; // ms epoch of start of 60s window
  count: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

/**
 * Fixed-window rate limiter — 60 inbound events per minute per peer machine.
 * Returns true if the call is allowed; false if it should be rejected (429).
 */
export function checkRate(
  machine: string,
  limitPerMinute = 60,
  nowMillis = Date.now(),
): boolean {
  let b = buckets.get(machine);
  if (!b || nowMillis - b.windowStart >= WINDOW_MS) {
    b = { windowStart: nowMillis, count: 0 };
    buckets.set(machine, b);
  }
  b.count++;
  return b.count <= limitPerMinute;
}

export function _resetRateLimitForTest(): void {
  buckets.clear();
}
