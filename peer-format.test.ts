/**
 * list_peers row formatting (sooth-os/sooth#1542): a headless row carries one
 * extra Headless line; every other row prints exactly as before.
 */

import { describe, expect, test } from "bun:test";
import { formatPeer } from "./peer-format.ts";
import type { Peer } from "./shared/types.ts";

const seat: Peer = {
  id: "abc12345",
  pid: 4242,
  cwd: "/home/heesoo/sooth/sori",
  git_root: "/home/heesoo/sooth/sori",
  tty: "pts/3",
  summary: "Working the board",
  registered_at: "2026-10-29T00:00:00Z",
  last_seen: "2026-10-29T00:01:00Z",
  headless: false,
};

describe("formatPeer", () => {
  test("a seat row prints the fields it always printed, and no Headless line", () => {
    expect(formatPeer(seat)).toBe(
      [
        "ID: abc12345",
        "PID: 4242",
        "CWD: /home/heesoo/sooth/sori",
        "Repo: /home/heesoo/sooth/sori",
        "TTY: pts/3",
        "Summary: Working the board",
        "Last seen: 2026-10-29T00:01:00Z",
      ].join("\n  "),
    );
  });

  test("a headless row appends the Headless line after Last seen", () => {
    expect(formatPeer({ ...seat, headless: true })).toBe(
      `${formatPeer(seat)}\n  Headless: true (one-turn session, not the seat; reply to its from_id)`,
    );
  });

  test("optional fields stay omitted when empty", () => {
    const remote: Peer = { ...seat, id: "x@mac", pid: 0, git_root: null, tty: null, summary: "" };
    expect(formatPeer(remote)).toBe(
      ["ID: x@mac", "PID: 0", "CWD: /home/heesoo/sooth/sori", "Last seen: 2026-10-29T00:01:00Z"].join("\n  "),
    );
  });
});
