/**
 * codex-seat tests — how a peer message reaches a seat that is running the codex
 * TUI instead of Claude Code (sooth-os/sooth#911).
 *
 * No codex and no tmux are touched: `startCodexTurn` takes its socket factory
 * and `deliverToCodexSeat` takes its paste, so every assertion is on the exact
 * JSON-RPC frames and the exact pane line the module WOULD produce. The fake
 * app-server answers the shapes the live 0.153.4 binary answers.
 *
 * The runtime resolver IS exercised for real, against `crew-runtime.sh` with
 * `CREW_RUNTIME_FILE` pointed at a fixture — the live record is never touched.
 * Faking it would prove only that this file's own mock works, and the failure it
 * guards (a cached runtime on a process that outlives a `switch-ai`) lives
 * precisely in that seam.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  PANE_FRAME,
  deliverToCodexSeat,
  renderPeerChannelBlock,
  renderPeerPaneLine,
  seatForCwd,
  seatRuntime,
  selectSeatThread,
  startCodexTurn,
  type CodexSocketFactory,
  type CodexThreadMeta,
  type PeerMessageView,
  type Seat,
} from "./codex-seat.ts";

const ATLAS: Seat = { id: "atlas", session: "atlas", home: "/home/heesoo/apps/atlas" };

function message(overrides: Partial<PeerMessageView> = {}): PeerMessageView {
  return {
    from_id: "k3pogncc@mac",
    from_summary: "Reviewing the runtime axis",
    from_cwd: "/Users/heesoojung/01 Projects/sooth-keep",
    sent_at: "2026-09-10T12:00:00.000Z",
    text: "atlas, status?",
    ...overrides,
  };
}

/** The two threads the live atlas seat actually had loaded, from the read-only
 *  probe: the TUI's own, and the app-server's ephemeral helper — which is the
 *  NEWER of the two. */
const LIVE_TUI: CodexThreadMeta = {
  id: "01a08b46-1ee1-7df0-8156-5984d0e22c46",
  cwd: "/home/heesoo/apps/atlas",
  ephemeral: false,
  threadSource: "user",
  canAcceptDirectInput: true,
  recencyAt: 1789043158,
};
const LIVE_HELPER: CodexThreadMeta = {
  id: "01a08b48-2e3e-7ff2-bfe7-4212a858e720",
  cwd: "/home/heesoo/apps/atlas",
  ephemeral: true,
  threadSource: "system",
  canAcceptDirectInput: true,
  recencyAt: 1789044036,
};

function fakeCodexServer(
  opts: { threads?: CodexThreadMeta[]; refuse?: boolean; mute?: boolean } = {},
) {
  const threads = opts.threads ?? [LIVE_TUI, LIVE_HELPER];
  const sent: Array<{ method: string; params: any }> = [];
  let closed = 0;
  const factory: CodexSocketFactory = (_url, handlers) => {
    const socket = {
      send(data: string) {
        const msg = JSON.parse(data) as { id: number; method: string; params: any };
        sent.push({ method: msg.method, params: msg.params });
        if (opts.mute) return;
        queueMicrotask(() => {
          const reply = (result: unknown) =>
            handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
          if (msg.method === "thread/loaded/list") return reply({ data: threads.map((t) => t.id) });
          if (msg.method === "thread/read")
            return reply({ thread: threads.find((t) => t.id === msg.params.threadId) });
          return reply({});
        });
      },
      close() {
        closed += 1;
      },
    };
    if (opts.refuse)
      queueMicrotask(() => handlers.onError(new Error("connect ECONNREFUSED 127.0.0.1:17895")));
    else queueMicrotask(() => handlers.onOpen());
    return socket;
  };
  return {
    factory,
    sent,
    get closed() {
      return closed;
    },
  };
}

// ─── seatForCwd ─────────────────────────────────────────────────────────────

describe("seatForCwd — which crewmate is this process sitting in", () => {
  let dir: string;
  let roster: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crew-peers-roster-"));
    roster = join(dir, "crew-roster.json");
    writeFileSync(
      roster,
      JSON.stringify([
        { id: "sori", session: "sori", scope: "sooth-core" },
        { id: "may", session: "may", scope: "may" },
        { id: "atlas", session: "atlas", scope: "sooth-core", role: "contractor", home: "~/apps/atlas" },
      ]),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a contractor home spelled with ~ resolves against this box's HOME", () => {
    expect(seatForCwd(join(homedir(), "apps", "atlas"), roster)).toEqual({
      id: "atlas",
      session: "atlas",
      home: join(homedir(), "apps", "atlas"),
    });
  });

  test("a crewmate with no home field defaults to ~/sooth/<id>", () => {
    expect(seatForCwd(join(homedir(), "sooth", "may"), roster)?.id).toBe("may");
  });

  // A session started from a subdirectory of its home is still that seat — and
  // the live sori session runs from `~/sooth/sori/memory`, so this is not
  // hypothetical.
  test("a SUBDIRECTORY of the home still resolves to that seat", () => {
    expect(seatForCwd(join(homedir(), "sooth", "sori", "memory"), roster)?.id).toBe("sori");
  });

  test("a cwd under no crewmate home is undefined — the channel push stays", () => {
    expect(seatForCwd("/tmp/nowhere", roster)).toBeUndefined();
  });

  // `~/sooth/sori` is a prefix of nothing here, but `~/sooth` would match every
  // crewmate if a row ever declared it: longest-wins is what keeps the answer
  // the most specific seat rather than the first row in the file.
  test("the LONGEST matching home wins, not the first row", () => {
    const nested = join(dir, "nested.json");
    writeFileSync(
      nested,
      JSON.stringify([
        { id: "outer", session: "outer", home: "~/apps" },
        { id: "atlas", session: "atlas", home: "~/apps/atlas" },
      ]),
    );
    expect(seatForCwd(join(homedir(), "apps", "atlas"), nested)?.id).toBe("atlas");
    expect(seatForCwd(join(homedir(), "apps", "other"), nested)?.id).toBe("outer");
  });

  test("a sibling directory that merely shares a prefix is NOT a match", () => {
    expect(seatForCwd(join(homedir(), "apps", "atlas-scratch"), roster)).toBeUndefined();
  });

  test("an unreadable roster is undefined, never a throw — the seat must not go deaf over it", () => {
    expect(seatForCwd(join(homedir(), "apps", "atlas"), join(dir, "absent.json"))).toBeUndefined();
  });
});

// ─── seatRuntime, against the real corpus resolver ──────────────────────────

describe("seatRuntime — read per poll, through crew-runtime.sh", () => {
  let dir: string;
  let record: string;
  const saved = process.env.CREW_RUNTIME_FILE;

  const write = (lines: Array<[string, string]>) =>
    writeFileSync(
      record,
      lines.map(([id, rt]) => `${id}\t${rt}\t${Math.floor(Date.now() / 1000)}`).join("\n") + "\n",
    );

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crew-peers-runtime-"));
    record = join(dir, "crew-runtime.tsv");
    process.env.CREW_RUNTIME_FILE = record;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.CREW_RUNTIME_FILE;
    else process.env.CREW_RUNTIME_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unrecorded seat answers claude — the pre-switch world", () => {
    write([]);
    expect(seatRuntime("atlas")).toBe("claude");
  });

  // THE property: this process outlives a switch-ai, so a held answer is a seat
  // that goes deaf. Same process, same module, only the record changed.
  test("flipping the record flips the answer, with no restart", () => {
    write([["atlas", "codex"]]);
    expect(seatRuntime("atlas")).toBe("codex");
    write([["atlas", "claude"]]);
    expect(seatRuntime("atlas")).toBe("claude");
    write([["atlas", "codex"]]);
    expect(seatRuntime("atlas")).toBe("codex");
  });

  test("haru's roster pin answers agy — and agy is not codex, so the push is unchanged", () => {
    write([]);
    expect(seatRuntime("haru")).toBe("agy");
  });

  test("an unreachable resolver answers undefined, which the caller reads as NOT codex", () => {
    const prev = process.env.CREW_RUNTIME_SH;
    process.env.CREW_RUNTIME_SH = join(dir, "does-not-exist.sh");
    try {
      expect(seatRuntime("atlas")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CREW_RUNTIME_SH;
      else process.env.CREW_RUNTIME_SH = prev;
    }
  });
});

// ─── selectSeatThread ───────────────────────────────────────────────────────

describe("selectSeatThread — the seat's TUI, not whatever else is loaded", () => {
  test("the LIVE case: the ephemeral helper is NEWER and must still lose", () => {
    expect(LIVE_HELPER.recencyAt!).toBeGreaterThan(LIVE_TUI.recencyAt!);
    expect(selectSeatThread([LIVE_TUI, LIVE_HELPER], ATLAS.home)).toBe(LIVE_TUI.id);
    expect(selectSeatThread([LIVE_HELPER, LIVE_TUI], ATLAS.home)).toBe(LIVE_TUI.id);
  });

  test("only an ephemeral/system thread loaded ⇒ nothing usable", () => {
    expect(selectSeatThread([LIVE_HELPER])).toBeUndefined();
    expect(selectSeatThread([{ ...LIVE_HELPER, ephemeral: false }])).toBeUndefined();
  });

  test("a thread that says it cannot take direct input is refused", () => {
    expect(selectSeatThread([{ ...LIVE_TUI, canAcceptDirectInput: false }])).toBeUndefined();
  });

  test("a thread from another cwd is refused when the home is known", () => {
    expect(selectSeatThread([LIVE_TUI], "/home/heesoo/sooth/may")).toBeUndefined();
    expect(selectSeatThread([LIVE_TUI])).toBe(LIVE_TUI.id);
  });

  test("a thread declaring none of the fields is still usable — a newer codex must not silence the seat", () => {
    expect(selectSeatThread([{ id: "bare" }])).toBe("bare");
  });

  test("the most recent real thread wins — a switched-away seat leaves its old one loaded", () => {
    const older = { ...LIVE_TUI, id: "older", recencyAt: 1 };
    const newer = { ...LIVE_TUI, id: "newer", recencyAt: 2 };
    expect(selectSeatThread([older, newer], ATLAS.home)).toBe("newer");
  });
});

// ─── The text ───────────────────────────────────────────────────────────────

describe("what the seat reads", () => {
  test("the block is the same envelope Claude Code renders — the sender id is INLINE", () => {
    const block = renderPeerChannelBlock(message());
    expect(block).toStartWith('<channel source="crew-peers"');
    expect(block).toContain('from_id="k3pogncc@mac"');
    expect(block).toContain('sent_at="2026-09-10T12:00:00.000Z"');
    expect(block).toContain("atlas, status?");
    expect(block).toEndWith("</channel>");
  });

  test("a quote in a sender field cannot break out of the attribute", () => {
    const block = renderPeerChannelBlock(message({ from_summary: 'says "hi"' }));
    expect(block).toContain("&quot;hi&quot;");
  });

  test("the pane line is ONE line, whatever the message was", () => {
    expect(renderPeerPaneLine(message({ text: "첫 줄\n\n둘째 줄" }))).not.toContain("\n");
  });

  test.each(["/model gpt", "[Cron] do a thing", "/handoff"])(
    "a message opening with %p rides behind the frame",
    (text) => {
      const line = renderPeerPaneLine(message({ text }));
      expect(line.startsWith("/")).toBe(false);
      expect(line.startsWith("[")).toBe(false);
      expect(line).toStartWith(PANE_FRAME);
      expect(line).toContain(text);
    },
  );
});

// ─── startCodexTurn ─────────────────────────────────────────────────────────

describe("startCodexTurn — the four frames, in order", () => {
  test("initialize → loaded/list → read each → turn/start on the TUI thread", async () => {
    const server = fakeCodexServer();
    const threadId = await startCodexTurn(17895, "hello", {
      home: ATLAS.home,
      factory: server.factory,
    });
    expect(server.sent.map((m) => m.method)).toEqual([
      "initialize",
      "thread/loaded/list",
      "thread/read",
      "thread/read",
      "turn/start",
    ]);
    const turn = server.sent.at(-1)!;
    expect(turn.params.threadId).toBe(LIVE_TUI.id);
    expect(turn.params.input).toEqual([{ type: "text", text: "hello" }]);
    expect(threadId).toBe(LIVE_TUI.id);
  });

  test("the read is metadata-only", async () => {
    const server = fakeCodexServer();
    await startCodexTurn(17895, "hello", { factory: server.factory });
    for (const read of server.sent.filter((m) => m.method === "thread/read")) {
      expect(read.params.includeTurns).toBe(false);
    }
  });

  test("the socket is closed when the exchange is done — nothing is held", async () => {
    const server = fakeCodexServer();
    await startCodexTurn(17895, "hello", { factory: server.factory });
    expect(server.closed).toBe(1);
  });

  test("a refused socket throws, and no turn was started", async () => {
    const server = fakeCodexServer({ refuse: true });
    await expect(startCodexTurn(17895, "hi", { factory: server.factory })).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(server.sent).toEqual([]);
  });

  test("a silent app-server times out instead of wedging the poll loop", async () => {
    const server = fakeCodexServer({ mute: true });
    await expect(
      startCodexTurn(17895, "hi", { factory: server.factory, timeoutMs: 25 }),
    ).rejects.toThrow("did not answer within 25ms");
  });

  test("no loaded thread throws rather than inventing one", async () => {
    const server = fakeCodexServer({ threads: [] });
    await expect(startCodexTurn(17895, "hi", { factory: server.factory })).rejects.toThrow(
      "no loaded thread",
    );
  });

  // The twin tolerates both payload shapes and so must this one: a build that
  // answers the row bare instead of `{ thread: … }` would otherwise strip every
  // discriminating field and take the seat off the air.
  test("a bare thread/read payload is read as well as the wrapped one", async () => {
    const sent: Array<{ method: string; params: any }> = [];
    const factory: CodexSocketFactory = (_url, handlers) => {
      const socket = {
        send(data: string) {
          const msg = JSON.parse(data) as { id: number; method: string; params: any };
          sent.push({ method: msg.method, params: msg.params });
          queueMicrotask(() => {
            const reply = (result: unknown) =>
              handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
            if (msg.method === "thread/loaded/list") return reply({ data: [LIVE_TUI.id] });
            // BARE — no `thread` wrapper.
            if (msg.method === "thread/read") return reply(LIVE_TUI);
            return reply({});
          });
        },
        close() {},
      };
      queueMicrotask(() => handlers.onOpen());
      return socket;
    };
    const threadId = await startCodexTurn(17895, "hi", { home: ATLAS.home, factory });
    expect(threadId).toBe(LIVE_TUI.id);
    expect(sent.some((m) => m.method === "turn/start")).toBe(true);
  });

  test("only the ephemeral helper loaded ⇒ throws, never answers there", async () => {
    const server = fakeCodexServer({ threads: [LIVE_HELPER] });
    await expect(
      startCodexTurn(17895, "hi", { home: ATLAS.home, factory: server.factory }),
    ).rejects.toThrow("none of them this seat's TUI");
    expect(server.sent.some((m) => m.method === "turn/start")).toBe(false);
  });
});

// ─── deliverToCodexSeat ─────────────────────────────────────────────────────

describe("deliverToCodexSeat — WS first, pane second, and the fallback SAYS so", () => {
  test("the happy path starts a turn and never touches the pane", async () => {
    const server = fakeCodexServer();
    const pasted: Array<[string, string]> = [];
    const outcome = await deliverToCodexSeat(ATLAS, message(), {
      port: () => 17895,
      factory: server.factory,
      paste: async (s, t) => {
        pasted.push([s, t]);
      },
    });
    expect(outcome.path).toBe("ws");
    expect(outcome.threadId).toBe(LIVE_TUI.id);
    const turn = server.sent.find((m) => m.method === "turn/start")!;
    expect(turn.params.input[0].text).toContain('from_id="k3pogncc@mac"');
    expect(pasted).toEqual([]);
  });

  test("a refused socket pastes one framed line into the seat's tmux session", async () => {
    const server = fakeCodexServer({ refuse: true });
    const pasted: Array<[string, string]> = [];
    const outcome = await deliverToCodexSeat(ATLAS, message(), {
      port: () => 17895,
      factory: server.factory,
      paste: async (s, t) => {
        pasted.push([s, t]);
      },
    });
    expect(outcome.path).toBe("fallback");
    expect(outcome.reason).toContain("ECONNREFUSED");
    expect(pasted).toHaveLength(1);
    const [session, line] = pasted[0]!;
    expect(session).toBe("atlas");
    expect(line).toStartWith(PANE_FRAME);
    expect(line).not.toContain("\n");
  });

  test("no derivable port falls straight to the pane, and names why", async () => {
    const pasted: string[] = [];
    const outcome = await deliverToCodexSeat(ATLAS, message(), {
      port: () => undefined,
      paste: async (_s, t) => {
        pasted.push(t);
      },
    });
    expect(outcome.path).toBe("fallback");
    expect(outcome.reason).toContain("no app-server port");
    expect(pasted).toHaveLength(1);
  });

  test("both paths down throws — the caller must log a loss, not a delivery", async () => {
    const server = fakeCodexServer({ refuse: true });
    await expect(
      deliverToCodexSeat(ATLAS, message(), {
        port: () => 17895,
        factory: server.factory,
        paste: async () => {
          throw new Error('tmux display-message exited 1 (session not running?)');
        },
      }),
    ).rejects.toThrow("session not running");
  });
});
