/**
 * Fanout targets = peer_brokers rows ∩ machines in brokers.json.
 *
 * The live bug: peer_brokers kept rows for `mac` and `milo-mac` after
 * brokers.json went to `peers: []`, so every heartbeat fanned out to them,
 * failed `unknown-machine`, and wrote two ERR lines per peer forever.
 */

import { describe, expect, test } from "bun:test";
import { createTargetFilter } from "./fanout-targets.ts";

const rows = [
  { machine: "vps", status: "live" },
  { machine: "mac", status: "stale" },
  { machine: "milo-mac", status: "stale" },
  { machine: "work-mac", status: "live" },
];

describe("createTargetFilter", () => {
  test("skips self and machines missing from brokers.json, reporting each stale machine once", () => {
    const reported: string[] = [];
    const filter = createTargetFilter((m) => reported.push(m));
    const configured = new Set(["work-mac"]);

    for (let heartbeat = 0; heartbeat < 50; heartbeat++) {
      const targets = filter(rows, configured, "vps");
      expect(targets.map((t) => t.machine)).toEqual(["work-mac"]);
    }
    expect(reported).toEqual(["mac", "milo-mac"]);
  });

  test("an empty brokers.json peer list yields no targets", () => {
    const filter = createTargetFilter(() => {});
    expect(filter(rows, new Set(), "vps")).toEqual([]);
  });
});
