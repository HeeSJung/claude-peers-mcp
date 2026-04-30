/**
 * brokers-config tests.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { loadBrokersConfig, loadSelfSecret } from "./brokers-config.ts";

const TMP = "/tmp/claude-peers-test-brokers-config";

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function setup() {
  mkdirSync(TMP, { recursive: true });
}

describe("loadBrokersConfig", () => {
  test("returns null if file absent", () => {
    setup();
    expect(loadBrokersConfig(join(TMP, "missing.json"))).toBeNull();
  });

  test("parses a valid config", () => {
    setup();
    const path = join(TMP, "brokers.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        self_machine: "silas-vps",
        self_ts_addr: "100.64.0.5:7900",
        peers: [
          { machine: "milo-mac", ts_addr: "100.64.0.7:7900", ssh_alias: "milo-broker-secret" },
        ],
      }),
    );
    const cfg = loadBrokersConfig(path);
    expect(cfg).not.toBeNull();
    expect(cfg!.self_machine).toBe("silas-vps");
    expect(cfg!.peers).toHaveLength(1);
    expect(cfg!.peers[0]!.machine).toBe("milo-mac");
  });

  test("throws on schema mismatch", () => {
    setup();
    const path = join(TMP, "brokers.json");
    writeFileSync(
      path,
      JSON.stringify({ schema: 2, self_machine: "x", self_ts_addr: "y", peers: [] }),
    );
    expect(() => loadBrokersConfig(path)).toThrow(/schema mismatch/);
  });

  test("throws on missing required peer fields", () => {
    setup();
    const path = join(TMP, "brokers.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        self_machine: "x",
        self_ts_addr: "y",
        peers: [{ machine: "mm" }],
      }),
    );
    expect(() => loadBrokersConfig(path)).toThrow(/missing required field/);
  });
});

describe("loadSelfSecret", () => {
  test("returns null if absent", () => {
    setup();
    expect(loadSelfSecret(join(TMP, "missing"))).toBeNull();
  });

  test("returns a 32-byte Buffer for valid 600-mode hex file", () => {
    setup();
    const path = join(TMP, "secret-current");
    writeFileSync(path, "a".repeat(64));
    chmodSync(path, 0o600);
    const buf = loadSelfSecret(path);
    expect(buf).not.toBeNull();
    expect(buf!.length).toBe(32);
  });

  test("rejects insecure permissions (644)", () => {
    setup();
    const path = join(TMP, "secret-current");
    writeFileSync(path, "a".repeat(64));
    chmodSync(path, 0o644);
    expect(() => loadSelfSecret(path)).toThrow(/insecure permissions/);
  });

  test("rejects malformed contents", () => {
    setup();
    const path = join(TMP, "secret-current");
    writeFileSync(path, "not-hex-zzz");
    chmodSync(path, 0o600);
    expect(() => loadSelfSecret(path)).toThrow(/exactly 64 hex chars/);
  });
});
