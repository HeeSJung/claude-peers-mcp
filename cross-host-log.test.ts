/**
 * cross-host.log size rotation: rename to `<log>.<UTC date>[-N]`, gzip,
 * keep the newest 5 archives, and never lose the line being written.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingLog } from "./cross-host-log.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createRotatingLog", () => {
  test("rotates past the cap: renames with date suffix, gzips, prunes to 5, keeps every line", async () => {
    dir = mkdtempSync(join(tmpdir(), "cross-host-log-"));
    const path = join(dir, "cross-host.log");
    const date = "2026-09-30";
    // Seven pre-existing archives, oldest first: the hand-made one, and a raw
    // one a failed gzip would leave behind (must be pruned in turn).
    const old = [
      "cross-host.log.2026-08-01.gz",
      "cross-host.log.2026-08-15",
      "cross-host.log.2026-09-01.gz",
      "cross-host.log.2026-09-02.gz",
      "cross-host.log.2026-09-03.gz",
      "cross-host.log.2026-09-30.gz",
      "cross-host.log.2026-09-30-1.gz",
    ];
    for (const f of old) writeFileSync(join(dir, f), "x");
    writeFileSync(join(dir, "unrelated.gz"), "keep me");

    const log = createRotatingLog({
      path,
      maxBytes: 200,
      keep: 5,
      now: () => new Date(`${date}T12:00:00Z`),
    });

    // Fire concurrently, like the broker's `void logCrossHost(...)` calls.
    const lines = Array.from({ length: 12 }, (_, i) => `EVENT-OUT mac heartbeat p${String(i).padStart(2, "0")} OK`);
    await Promise.all(lines.map((l) => log(l)));

    const files = readdirSync(dir).sort();
    const archives = files.filter((f) => f.startsWith("cross-host.log.") && f.endsWith(".gz"));
    expect(archives).toHaveLength(5);
    // Oldest by date then suffix are gone; the newest rotations are present.
    expect(archives).not.toContain("cross-host.log.2026-08-01.gz");
    expect(files).not.toContain("cross-host.log.2026-08-15");
    expect(archives).toContain(`cross-host.log.${date}-2.gz`);
    expect(files).toContain("unrelated.gz");
    // No un-gzipped archive left behind.
    expect(files.filter((f) => /^cross-host\.log\.\d{4}-\d{2}-\d{2}(-\d+)?$/.test(f))).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBeLessThanOrEqual(200);

    // Every line lands exactly once across the live file + new archives.
    const created = archives.filter((f) => !old.includes(f));
    const text =
      created.map((f) => gunzipSync(readFileSync(join(dir, f))).toString()).join("") +
      readFileSync(path, "utf8");
    for (const l of lines) expect(text.split(l).length - 1).toBe(1);
  });

  test("no rotation under the cap", async () => {
    dir = mkdtempSync(join(tmpdir(), "cross-host-log-"));
    const path = join(dir, "cross-host.log");
    const log = createRotatingLog({ path, maxBytes: 10_000, keep: 5 });
    await log("HEALTH-OUT mac OK");
    await log("HEALTH-OUT mac OK");
    expect(readdirSync(dir)).toEqual(["cross-host.log"]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
