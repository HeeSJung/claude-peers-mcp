/**
 * HMAC-SHA256 signer / verifier tests.
 *
 * Run: bun test hmac.test.ts
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  HEADERS,
  buildSignedHeaders,
  buildSigningString,
  hmacSign,
  verifyHmac,
  hasSeenNonce,
  rememberNonce,
  _resetNonceStoreForTest,
  CLOCK_SKEW_SECONDS,
} from "./hmac.ts";

const SECRET = Buffer.from("0".repeat(64), "hex"); // 32 zero bytes
const SECRET_B = Buffer.from("1".repeat(64), "hex");
const ME = "silas-vps";
const PEER = "milo-mac";

const resolve = (m: string) => (m === PEER ? SECRET : null);

beforeEach(() => {
  _resetNonceStoreForTest();
});

describe("hmacSign", () => {
  test("known vector — fixed inputs produce stable hex output", () => {
    const sig = hmacSign(SECRET, "POST", "/peer-events", 1714500000000, "deadbeef", '{"x":1}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Stability check: same inputs must yield same output across runs.
    const sig2 = hmacSign(SECRET, "POST", "/peer-events", 1714500000000, "deadbeef", '{"x":1}');
    expect(sig).toBe(sig2);
  });

  test("buildSigningString format is method\\npath\\nts\\nnonce\\nsha256(body)", () => {
    const s = buildSigningString("post", "/foo", 123, "abc", "");
    const lines = s.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("POST"); // upcased
    expect(lines[1]).toBe("/foo");
    expect(lines[2]).toBe("123");
    expect(lines[3]).toBe("abc");
    expect(lines[4]).toMatch(/^[0-9a-f]{64}$/); // sha256 of empty
  });
});

describe("verifyHmac — happy path", () => {
  test("sign+verify roundtrip succeeds", () => {
    const body = JSON.stringify({ event_type: "heartbeat", machine: ME });
    const ts = Date.now();
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/peer-events",
      body,
      tsMillis: ts,
    });
    const result = verifyHmac({
      headers,
      method: "POST",
      path: "/peer-events",
      body,
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.machine).toBe(PEER);
      expect(result.ts).toBe(ts);
    }
  });
});

describe("verifyHmac — failure modes", () => {
  test("missing X-Peer-Broker-Sig fails missing-header", () => {
    const r = verifyHmac({
      headers: {
        [HEADERS.Machine]: PEER,
        [HEADERS.Ts]: String(Date.now()),
        [HEADERS.Nonce]: "abc",
      },
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing-header");
  });

  test("clock skew >30s in future fails clock-skew", () => {
    const now = Date.now();
    const future = now + (CLOCK_SKEW_SECONDS + 5) * 1000;
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "",
      tsMillis: future,
    });
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
      nowMillis: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("clock-skew");
  });

  test("clock skew >30s in past fails clock-skew", () => {
    const now = Date.now();
    const past = now - (CLOCK_SKEW_SECONDS + 5) * 1000;
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "",
      tsMillis: past,
    });
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
      nowMillis: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("clock-skew");
  });

  test("tampered body fails bad-sig", () => {
    const ts = Date.now();
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "original",
      tsMillis: ts,
    });
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "TAMPERED",
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-sig");
  });

  test("tampered nonce fails bad-sig (signature won't match)", () => {
    const ts = Date.now();
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "",
      tsMillis: ts,
      nonce: "originalnonce0123",
    });
    headers[HEADERS.Nonce] = "tamperednonce0001";
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-sig");
  });

  test("wrong secret fails bad-sig", () => {
    const ts = Date.now();
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET_B, // signs with different secret
      method: "POST",
      path: "/x",
      body: "",
      tsMillis: ts,
    });
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve, // resolves PEER → SECRET, not SECRET_B
      nowMillis: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-sig");
  });

  test("unknown machine fails unknown-machine", () => {
    const ts = Date.now();
    const headers = buildSignedHeaders({
      selfMachine: "stranger-vps",
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "",
      tsMillis: ts,
    });
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown-machine");
  });
});

describe("nonce LRU — replay protection", () => {
  test("replay with same nonce fails nonce-replay", () => {
    const ts = Date.now();
    const nonce = randomBytes(16).toString("hex");
    const headers = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "x",
      tsMillis: ts,
      nonce,
    });
    const r1 = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "x",
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(r1.ok).toBe(true);

    const r2 = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "x",
      resolveSecret: resolve,
      nowMillis: ts + 1000,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("nonce-replay");
  });

  test("hasSeenNonce returns false for fresh nonce", () => {
    expect(hasSeenNonce("never-seen-this")).toBe(false);
  });

  test("rememberNonce expires after TTL", () => {
    const ts = Date.now();
    rememberNonce("expiring-nonce", ts);
    expect(hasSeenNonce("expiring-nonce", ts + 1000)).toBe(true);
    // 6 minutes later, past 5-min TTL
    expect(hasSeenNonce("expiring-nonce", ts + 6 * 60 * 1000)).toBe(false);
  });
});

describe("verifyHmac — edge cases", () => {
  test("rejects malformed hex sig as bad-sig", () => {
    const ts = Date.now();
    const r = verifyHmac({
      headers: {
        [HEADERS.Machine]: PEER,
        [HEADERS.Ts]: String(ts),
        [HEADERS.Nonce]: "n",
        [HEADERS.Sig]: "not-hex-zzzz",
      },
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-sig");
  });

  test("rejects bad-ts when ts is non-numeric", () => {
    const r = verifyHmac({
      headers: {
        [HEADERS.Machine]: PEER,
        [HEADERS.Ts]: "not-a-number",
        [HEADERS.Nonce]: "n",
        [HEADERS.Sig]: "0".repeat(64),
      },
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-ts");
  });

  test("Headers object also works (Web Fetch API style)", () => {
    const ts = Date.now();
    const headers = new Headers();
    const signed = buildSignedHeaders({
      selfMachine: PEER,
      secret: SECRET,
      method: "POST",
      path: "/x",
      body: "",
      tsMillis: ts,
    });
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    const r = verifyHmac({
      headers,
      method: "POST",
      path: "/x",
      body: "",
      resolveSecret: resolve,
      nowMillis: ts,
    });
    expect(r.ok).toBe(true);
  });
});
