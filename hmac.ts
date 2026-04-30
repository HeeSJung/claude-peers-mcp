/**
 * HMAC-SHA256 signer / verifier for cross-broker requests.
 *
 * Header convention (string-cased exactly like this on the wire):
 *   X-Peer-Broker-Machine: <our-machine-name>
 *   X-Peer-Broker-Ts:      <unix millis as decimal string>
 *   X-Peer-Broker-Nonce:   <16-byte hex>
 *   X-Peer-Broker-Sig:     <hex(HMAC-SHA256(secret, msg))>
 *
 * Where msg = method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body)
 *
 * Verification fails if:
 *   - ts deviates from receiver's clock by more than CLOCK_SKEW_SECONDS
 *   - nonce was seen in the last NONCE_TTL_SECONDS (replay protection)
 *   - signature mismatch (constant-time compare)
 *   - any header missing
 */

import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";

export const CLOCK_SKEW_SECONDS = 30;
export const NONCE_TTL_SECONDS = 300; // 5 minutes — generous, kept in memory
const NONCE_LRU_CAP = 10_000;

export const HEADERS = {
  Machine: "X-Peer-Broker-Machine",
  Ts: "X-Peer-Broker-Ts",
  Nonce: "X-Peer-Broker-Nonce",
  Sig: "X-Peer-Broker-Sig",
} as const;

function sha256hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function buildSigningString(
  method: string,
  path: string,
  tsMillis: number,
  nonce: string,
  body: string,
): string {
  return [method.toUpperCase(), path, String(tsMillis), nonce, sha256hex(body)].join("\n");
}

export function hmacSign(
  secret: Buffer | Uint8Array,
  method: string,
  path: string,
  tsMillis: number,
  nonce: string,
  body: string,
): string {
  const msg = buildSigningString(method, path, tsMillis, nonce, body);
  return createHmac("sha256", secret).update(msg, "utf8").digest("hex");
}

export type SignedHeaders = Record<string, string>;

export function buildSignedHeaders(args: {
  selfMachine: string;
  secret: Buffer | Uint8Array;
  method: string;
  path: string;
  body: string;
  tsMillis?: number;
  nonce?: string;
}): SignedHeaders {
  const ts = args.tsMillis ?? Date.now();
  const nonce = args.nonce ?? randomBytes(16).toString("hex");
  const sig = hmacSign(args.secret, args.method, args.path, ts, nonce, args.body);
  return {
    [HEADERS.Machine]: args.selfMachine,
    [HEADERS.Ts]: String(ts),
    [HEADERS.Nonce]: nonce,
    [HEADERS.Sig]: sig,
  };
}

// --- Nonce LRU --------------------------------------------------------------

interface NonceEntry {
  expiresAt: number; // ms epoch
}

const nonceStore = new Map<string, NonceEntry>();

export function rememberNonce(nonce: string, nowMillis = Date.now()): void {
  // Cheap eviction: clear expired on every insert; bounded by NONCE_LRU_CAP.
  if (nonceStore.size > NONCE_LRU_CAP) {
    const cutoff = nowMillis;
    for (const [k, v] of nonceStore) {
      if (v.expiresAt < cutoff) nonceStore.delete(k);
    }
    if (nonceStore.size > NONCE_LRU_CAP) {
      // Hard truncation if still oversized — drop oldest insertion-order.
      const overflow = nonceStore.size - NONCE_LRU_CAP;
      const it = nonceStore.keys();
      for (let i = 0; i < overflow; i++) {
        const next = it.next();
        if (next.done) break;
        nonceStore.delete(next.value);
      }
    }
  }
  nonceStore.set(nonce, { expiresAt: nowMillis + NONCE_TTL_SECONDS * 1000 });
}

export function hasSeenNonce(nonce: string, nowMillis = Date.now()): boolean {
  const entry = nonceStore.get(nonce);
  if (!entry) return false;
  if (entry.expiresAt < nowMillis) {
    nonceStore.delete(nonce);
    return false;
  }
  return true;
}

export function _resetNonceStoreForTest(): void {
  nonceStore.clear();
}

// --- Verifier ---------------------------------------------------------------

export type VerifyResult =
  | { ok: true; machine: string; ts: number; nonce: string }
  | { ok: false; error: VerifyError };

export type VerifyError =
  | "missing-header"
  | "bad-ts"
  | "clock-skew"
  | "nonce-replay"
  | "bad-sig"
  | "unknown-machine";

export function verifyHmac(args: {
  headers: Headers | Record<string, string | undefined>;
  method: string;
  path: string;
  body: string;
  // Lookup the secret for the calling machine. Return null if unknown.
  resolveSecret: (machine: string) => Buffer | Uint8Array | null;
  nowMillis?: number;
  clockSkewSeconds?: number;
}): VerifyResult {
  const now = args.nowMillis ?? Date.now();
  const skewMs = (args.clockSkewSeconds ?? CLOCK_SKEW_SECONDS) * 1000;

  const get = (k: string): string | undefined =>
    args.headers instanceof Headers
      ? (args.headers.get(k) ?? undefined)
      : args.headers[k] ?? args.headers[k.toLowerCase()];

  const machine = get(HEADERS.Machine);
  const tsRaw = get(HEADERS.Ts);
  const nonce = get(HEADERS.Nonce);
  const sig = get(HEADERS.Sig);

  if (!machine || !tsRaw || !nonce || !sig) {
    return { ok: false, error: "missing-header" };
  }

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, error: "bad-ts" };
  }
  if (Math.abs(now - ts) > skewMs) {
    return { ok: false, error: "clock-skew" };
  }

  const secret = args.resolveSecret(machine);
  if (!secret) {
    return { ok: false, error: "unknown-machine" };
  }

  const expectedHex = hmacSign(secret, args.method, args.path, ts, nonce, args.body);
  const expected = Buffer.from(expectedHex, "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "hex");
  } catch {
    return { ok: false, error: "bad-sig" };
  }
  if (actual.length !== expected.length) {
    return { ok: false, error: "bad-sig" };
  }
  if (!timingSafeEqual(actual, expected)) {
    return { ok: false, error: "bad-sig" };
  }

  // Replay check after sig — sig must be valid first to even matter.
  if (hasSeenNonce(nonce, now)) {
    return { ok: false, error: "nonce-replay" };
  }
  rememberNonce(nonce, now);

  return { ok: true, machine, ts, nonce };
}
