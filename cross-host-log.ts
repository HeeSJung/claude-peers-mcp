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
 *
 * Size rotation: before a write that would push the file past the cap
 * (default 20MB, env CLAUDE_PEERS_CROSS_HOST_LOG_MAX_BYTES), the file is
 * renamed to `cross-host.log.<UTC YYYY-MM-DD>` (`-1`, `-2`… if taken), the
 * line goes to a fresh file, the archive is gzipped, and archives beyond the
 * newest 5 are deleted. Writes are serialized, so rotation loses no line.
 */

import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR } from "./brokers-config.ts";

export const CROSS_HOST_LOG = process.env.CLAUDE_PEERS_CROSS_HOST_LOG ?? join(CONFIG_DIR, "cross-host.log");
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const envMax = Number(process.env.CLAUDE_PEERS_CROSS_HOST_LOG_MAX_BYTES);
export const CROSS_HOST_LOG_MAX_BYTES = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_BYTES;
export const CROSS_HOST_LOG_KEEP = 5;

export interface RotatingLogOptions {
  path: string;
  maxBytes: number;
  keep: number;
  now?: () => Date;
}

/**
 * `<name>.<YYYY-MM-DD>[-N]` with or without `.gz` → sort key; null otherwise.
 * Raw (un-gzipped) archives count too, so one left by a failed gzip is still
 * pruned in turn.
 */
function archiveKey(logName: string, file: string): [string, number] | null {
  if (!file.startsWith(`${logName}.`)) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?(?:\.gz)?$/.exec(file.slice(logName.length + 1));
  return m ? [m[1]!, m[2] ? Number(m[2]) : 0] : null;
}

function archiveName(path: string, date: string): string {
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? `${path}.${date}` : `${path}.${date}-${n}`;
    if (!existsSync(candidate) && !existsSync(`${candidate}.gz`)) return candidate;
  }
}

/** Gzip `src` to `src.gz`. On failure drop the partial .gz and keep `src`. */
async function gzipAndRemove(src: string): Promise<void> {
  try {
    await pipeline(createReadStream(src), createGzip(), createWriteStream(`${src}.gz`));
  } catch (e) {
    console.error("[cross-host-log] gzip failed, keeping raw archive:", e instanceof Error ? e.message : e);
    await unlink(`${src}.gz`).catch(() => {});
    return;
  }
  await unlink(src);
}

async function pruneArchives(path: string, keep: number): Promise<void> {
  const dir = dirname(path);
  const name = basename(path);
  const archives = (await readdir(dir))
    .map((f) => ({ f, key: archiveKey(name, f) }))
    .filter((a): a is { f: string; key: [string, number] } => a.key !== null)
    .sort((a, b) => (a.key[0] === b.key[0] ? a.key[1] - b.key[1] : a.key[0] < b.key[0] ? -1 : 1));
  for (const a of archives.slice(0, Math.max(0, archives.length - keep))) {
    await unlink(join(dir, a.f));
  }
}

export function createRotatingLog(opts: RotatingLogOptions): (line: string) => Promise<void> {
  const now = opts.now ?? (() => new Date());
  let dirReady: Promise<unknown> | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function write(text: string): Promise<void> {
    dirReady ??= mkdir(dirname(opts.path), { recursive: true });
    await dirReady;
    const size = await stat(opts.path).then((s) => s.size, () => 0);
    if (size > 0 && size + Buffer.byteLength(text) > opts.maxBytes) {
      const archive = archiveName(opts.path, now().toISOString().slice(0, 10));
      await rename(opts.path, archive);
      await appendFile(opts.path, text, "utf8");
      const warn = (what: string) => (e: unknown) =>
        console.error(`[cross-host-log] ${what} failed:`, e instanceof Error ? e.message : e);
      await gzipAndRemove(archive).catch(warn("archive cleanup"));
      await pruneArchives(opts.path, opts.keep).catch(warn("prune"));
      return;
    }
    await appendFile(opts.path, text, "utf8");
  }

  return (line: string) => {
    const text = `${now().toISOString()} ${line}\n`;
    queue = queue.then(() => write(text)).catch((e) => {
      // Logging is best-effort — never crash the broker on log failures.
      console.error("[cross-host-log] write failed:", e instanceof Error ? e.message : e);
    });
    return queue;
  };
}

export const logCrossHost = createRotatingLog({
  path: CROSS_HOST_LOG,
  maxBytes: CROSS_HOST_LOG_MAX_BYTES,
  keep: CROSS_HOST_LOG_KEEP,
});

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
