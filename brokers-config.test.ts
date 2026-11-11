/**
 * brokers-config tests.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildBrokersConfig, loadBrokersConfig, loadSelfSecret, type HostRow } from "./brokers-config.ts";

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

describe("buildBrokersConfig (the host registry, ADR-0064)", () => {
  // A fixture in the shape of shared `data/hosts.json`: two servers that run a broker,
  // the KR box that runs none, and the Mac.
  const REGISTRY: HostRow[] = [
    { id: "oregon", kind: "server", ssh: "oregon", tailnet: "100.77.193.57", homeRoot: "/home/heesoo" },
    { id: "helsinki", kind: "server", ssh: "helsinki", tailnet: "100.69.105.7", homeRoot: "/home/heesoo" },
    { id: "kr", kind: "server", ssh: "ubuntu@100.104.175.102", tailnet: "100.104.175.102", homeRoot: "/home/ubuntu" },
    { id: "mac", kind: "laptop", ssh: "mac", tailnet: "100.97.171.83", homeRoot: "/Users/heesoojung" },
  ];

  test("oregon lists helsinki as a remote peer, and the Mac as before", () => {
    expect(buildBrokersConfig(REGISTRY, "oregon")).toEqual({
      schema: 1,
      self_machine: "oregon",
      self_ts_addr: "100.77.193.57:7900",
      peers: [
        { machine: "helsinki", ts_addr: "100.69.105.7:7900", ssh_alias: "helsinki-broker-secret" },
        { machine: "mac", ts_addr: "100.97.171.83:7900", ssh_alias: "mac-broker-secret" },
      ],
    });
  });

  test("helsinki lists oregon and the Mac", () => {
    const cfg = buildBrokersConfig(REGISTRY, "helsinki");
    expect(cfg.self_machine).toBe("helsinki");
    expect(cfg.peers.map((p) => [p.machine, p.ts_addr])).toEqual([
      ["oregon", "100.77.193.57:7900"],
      ["mac", "100.97.171.83:7900"],
    ]);
  });

  test("the built config is one loadBrokersConfig accepts", () => {
    setup();
    const path = join(TMP, "brokers.json");
    const built = buildBrokersConfig(REGISTRY, "oregon", { port: 7911 });
    writeFileSync(path, JSON.stringify(built));
    expect(loadBrokersConfig(path)).toEqual(built);
    expect(built.self_ts_addr).toBe("100.77.193.57:7911");
  });

  test("a broker host the registry has no row for is left out, not invented", () => {
    const cfg = buildBrokersConfig(REGISTRY.filter((h) => h.id !== "helsinki"), "oregon");
    expect(cfg.peers.map((p) => p.machine)).toEqual(["mac"]);
  });

  test("a self the registry cannot place, or one with no broker, is refused", () => {
    expect(() => buildBrokersConfig(REGISTRY, "nowhere")).toThrow(/nowhere/);
    expect(() => buildBrokersConfig(REGISTRY, "kr")).toThrow(/kr/);
  });

  test("a broker host with no tailnet address is refused", () => {
    const broken = REGISTRY.map((h) => (h.id === "helsinki" ? { ...h, tailnet: "" } : h));
    expect(() => buildBrokersConfig(broken, "oregon")).toThrow(/helsinki/);
  });
});
