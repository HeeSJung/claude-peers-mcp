/**
 * codex-seat.ts — how a peer message reaches THIS process's seat when that seat
 * is running the codex TUI rather than Claude Code (sooth-os/sooth#911,
 * ADR-0035 D5).
 *
 * ⚠️ **This module has a TWIN**, and they are meant to stay recognisably alike:
 * `~/apps/solios/mcp-daemon/codex-delivery.ts` + `delivery-strategy.ts` in the
 * Solios repo do the same job for a Solios panel prompt. They are DUPLICATED
 * rather than shared because the two live in separate git repos with no
 * dependency between them, and a cross-repo import would tie the crew-peers
 * broker's startup to a checkout of the panel. The duplication is bounded to
 * the app-server handshake and the thread-selection rule; if you change either
 * of those here, change them there too — and if a third caller ever appears,
 * that is the moment the pair earns a home in the corpus instead.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * `server.ts` is spawned once per seat as a stdio MCP server, polls the broker,
 * and pushes each inbound message as a `notifications/claude/channel` — which is
 * Claude-Code-proprietary. A codex seat runs this same server (it is wired into
 * the crewmate's own CODEX_HOME, sooth-os/sooth#905) and can call its tools, but
 * it has no channel surface, so that push reaches nobody: the message is marked
 * delivered by the broker and is never seen. Silence, with nothing in any log.
 *
 * So for a codex seat the message goes the way `crew-codex-launch.sh` already
 * built the road for: a `turn/start` over the seat's own `codex app-server`
 * WebSocket, into the thread its TUI is attached to. When that socket is down,
 * a tmux paste into the seat's pane — the same fallback the Solios twin uses,
 * and the same verb `~/sooth/shared/scripts/inject-prompt.sh` has always used.
 *
 * ── Resolved PER POLL ───────────────────────────────────────────────────────
 *
 * The runtime is read on every message, never held: this process outlives a
 * `switch-ai` (the record flips, the TUI is replaced, the MCP server the
 * app-server spawned may not be), and a cached answer is a seat that goes deaf
 * with no error anywhere. Three shell-outs at ~15ms each, on a path that fires
 * when a human sent a message.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// ─── The corpus, and where this box keeps it ────────────────────────────────

const SHARED = process.env.SOOTH_SHARED_DIR ?? join(homedir(), "sooth", "shared");

function rosterPath(): string {
  return process.env.CREWMATE_REGISTRY?.trim() || join(SHARED, "data", "crew-roster.json");
}
function crewRuntimeScript(): string {
  return process.env.CREW_RUNTIME_SH?.trim() || join(SHARED, "scripts", "crew-runtime.sh");
}
function crewCodexLaunchScript(): string {
  return (
    process.env.CREW_CODEX_LAUNCH_SH?.trim() || join(SHARED, "scripts", "crew-codex-launch.sh")
  );
}

/**
 * Run a corpus script and return its trimmed stdout, or `undefined`.
 *
 * `env` is passed EXPLICITLY. Bun's `spawnSync` snapshots the environment at
 * startup, so a variable assigned to `process.env` after boot never reaches the
 * child — the override would look injected and silently would not be. (Same
 * finding, same fix, in the Solios twin.)
 */
function askScript(script: string, args: string[]): string | undefined {
  const run = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  if (run.error || run.status !== 0) {
    return undefined;
  }
  const out = (run.stdout ?? "").trim();
  return out ? out : undefined;
}

// ─── Which crewmate is this process sitting in? ─────────────────────────────

interface RosterSeat {
  id?: string;
  session?: string;
  home?: string;
  scope?: string;
  role?: string;
}

/** The crewmate home a roster row names, spelled for this box. The roster
 *  stores the portable `~/…` form because several languages read it. */
function homeOf(seat: RosterSeat): string | undefined {
  if (!seat.id) return undefined;
  const declared = seat.home?.trim();
  if (!declared) return join(homedir(), "sooth", seat.id);
  if (declared === "~") return homedir();
  if (declared.startsWith("~/")) return join(homedir(), declared.slice(2));
  return declared;
}

export interface Seat {
  id: string;
  /** tmux session name — the pane the fallback pastes into. */
  session: string;
  home: string;
}

/**
 * Which crewmate's seat is this process running inside, decided by its CWD.
 *
 * The MCP server is spawned by the thing that owns the seat — a Claude Code
 * session in the pane, or (on codex) the `codex app-server` the pane started —
 * so it inherits the seat's working directory. Verified live: the crew-peers
 * server under the atlas seat's app-server reports `/home/heesoo/apps/atlas`.
 *
 * Matched by PREFIX and longest-wins, not by equality: a session that was
 * started from a subdirectory of its home is still that seat, and a home that
 * is a prefix of another's must not win over the more specific one.
 */
export function seatForCwd(cwd: string, path: string = rosterPath()): Seat | undefined {
  let rows: RosterSeat[];
  try {
    // `readFileSync`, not `Bun.file().json()`, against this repo's house rule —
    // because this call site is SYNCHRONOUS by design and Bun.file is not. It
    // sits beside `seatRuntime`'s `spawnSync` in one decision that has to settle
    // before the next line chooses a delivery path, and the roster is a few KB
    // read once per polled message. Making it async would buy nothing and would
    // split one decision across two ticks.
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return undefined;
    rows = parsed as RosterSeat[];
  } catch {
    return undefined;
  }
  let best: Seat | undefined;
  for (const row of rows) {
    if (!row.id || !row.session) continue;
    const home = homeOf(row);
    if (!home) continue;
    if (cwd !== home && !cwd.startsWith(home.endsWith("/") ? home : home + "/")) continue;
    if (!best || home.length > best.home.length) best = { id: row.id, session: row.session, home };
  }
  return best;
}

/** What this seat is running right now — the corpus resolver, asked fresh.
 *  `undefined` when it could not be asked, which the caller reads as "not codex"
 *  and therefore as the unchanged Claude channel push. */
export function seatRuntime(id: string): string | undefined {
  return askScript(crewRuntimeScript(), ["get", id]);
}

/** The loopback port this seat's codex app-server listens on. Derived by the
 *  corpus script, never computed here — the launcher that BINDS it and this
 *  client have to agree, and one derivation is how they cannot drift. */
export function seatPort(id: string): number | undefined {
  const answer = askScript(crewCodexLaunchScript(), ["port", id]);
  if (!answer) return undefined;
  const port = Number(answer);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

// ─── The app-server WebSocket ───────────────────────────────────────────────

export interface CodexSocket {
  send(data: string): void;
  close(): void;
}

export interface CodexSocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onError: (err: unknown) => void;
  onClose: () => void;
}

export type CodexSocketFactory = (url: string, handlers: CodexSocketHandlers) => CodexSocket;

export const defaultCodexSocketFactory: CodexSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (ev: MessageEvent) => handlers.onMessage(String(ev.data));
  ws.onerror = (err: unknown) => handlers.onError(err);
  ws.onclose = () => handlers.onClose();
  return { send: (data) => ws.send(data), close: () => ws.close() };
};

export const CODEX_WS_TIMEOUT_MS = 5_000;

/** The `thread/read` metadata this module reads. Everything optional — it is
 *  another program's payload, and a build that stops sending a field must
 *  degrade rather than take the seat off the air. */
export interface CodexThreadMeta {
  id: string;
  cwd?: string;
  ephemeral?: boolean;
  threadSource?: string;
  canAcceptDirectInput?: boolean;
  recencyAt?: number;
  updatedAt?: number;
  createdAt?: number;
}

function recency(t: CodexThreadMeta): number {
  return t.recencyAt ?? t.updatedAt ?? t.createdAt ?? 0;
}

/**
 * Pick the thread that IS this seat's TUI.
 *
 * A live app-server holds more than the TUI's thread: the read-only probe of the
 * atlas seat found an `ephemeral` / `threadSource: "system"` helper alongside it,
 * NEWER than the real one. `turn/start` there succeeds and the answer goes to a
 * throwaway conversation nobody reads — so "the most recent loaded thread" is
 * the wrong rule, and so is "the only one". Filter, then take the most recent
 * survivor (threads stay loaded after their TUI dies).
 */
export function selectSeatThread(
  threads: ReadonlyArray<CodexThreadMeta>,
  home?: string,
): string | undefined {
  const usable = threads.filter((t) => {
    if (!t.id) return false;
    if (t.ephemeral === true) return false;
    if (t.threadSource !== undefined && t.threadSource !== "user") return false;
    if (t.canAcceptDirectInput === false) return false;
    if (home && t.cwd !== undefined && t.cwd !== home) return false;
    return true;
  });
  if (usable.length === 0) return undefined;
  return usable.reduce((best, t) => (recency(t) > recency(best) ? t : best)).id;
}

interface RpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Start a turn carrying `text` on the seat listening at `port`. Throws on any
 * failure — a refused socket, a timeout, an app-server holding no thread this
 * seat can use. The caller's answer to a throw is the tmux fallback.
 *
 * Opened and closed per message rather than held: a held socket is one more
 * thing to keep alive across a `switch-ai`, and loopback costs a millisecond.
 */
export async function startCodexTurn(
  port: number,
  text: string,
  options: { home?: string; factory?: CodexSocketFactory; timeoutMs?: number } = {},
): Promise<string> {
  const url = `ws://127.0.0.1:${port}`;
  const factory = options.factory ?? defaultCodexSocketFactory;
  const timeoutMs = options.timeoutMs ?? CODEX_WS_TIMEOUT_MS;

  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let socket: CodexSocket | undefined;
  let settled = false;

  return await new Promise<string>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Already gone; the outcome below is what matters.
      }
      fn();
    };
    const fail = (err: unknown) =>
      finish(() => {
        for (const [, waiter] of pending) waiter.reject(err);
        pending.clear();
        reject(err instanceof Error ? err : new Error(String(err)));
      });

    const timer = setTimeout(
      () => fail(new Error(`codex app-server at ${url} did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const call = (method: string, params: unknown) =>
      new Promise<unknown>((res, rej) => {
        const id = ++nextId;
        pending.set(id, { resolve: res, reject: rej });
        try {
          socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        } catch (err) {
          pending.delete(id);
          rej(err);
        }
      });

    const body = async (): Promise<string> => {
      await call("initialize", {
        clientInfo: { name: "crew-peers", title: "crew-peers", version: "1" },
        capabilities: null,
      });
      const loaded = (await call("thread/loaded/list", {})) as { data?: string[] } | undefined;
      const ids = loaded?.data ?? [];
      if (ids.length === 0) {
        throw new Error(`codex app-server at ${url} has no loaded thread (is the TUI up?)`);
      }
      const metas: CodexThreadMeta[] = [];
      for (const id of ids) {
        const read = (await call("thread/read", { threadId: id, includeTurns: false })) as
          | { thread?: Partial<CodexThreadMeta> }
          | Partial<CodexThreadMeta>
          | undefined;
        // BOTH shapes, identically to the twin: 0.153.4 answers
        // `{ thread: Thread }`, and a build that answers the row bare must not
        // read as "no metadata" — which would strip every discriminating field
        // and take the seat off the air rather than degrade.
        const meta = ((read as { thread?: Partial<CodexThreadMeta> })?.thread ??
          read ??
          {}) as Partial<CodexThreadMeta>;
        metas.push({ ...meta, id });
      }
      const chosen = selectSeatThread(metas, options.home);
      if (!chosen) {
        throw new Error(
          `codex app-server at ${url} holds ${ids.length} loaded thread(s), none of them this seat's TUI`,
        );
      }
      await call("turn/start", { threadId: chosen, input: [{ type: "text", text }] });
      return chosen;
    };

    socket = factory(url, {
      // A microtask hop, because a fake transport may call `onOpen`
      // synchronously from inside `factory`, before `socket` is assigned.
      onOpen: () => {
        void Promise.resolve()
          .then(body)
          .then(
            (value) => finish(() => resolve(value)),
            (err) => fail(err),
          );
      },
      onMessage: (data) => {
        let msg: RpcResponse;
        try {
          msg = JSON.parse(data) as RpcResponse;
        } catch {
          return;
        }
        if (msg.id === undefined) return;
        const waiter = pending.get(Number(msg.id));
        if (!waiter) return;
        pending.delete(Number(msg.id));
        if (msg.error) waiter.reject(new Error(msg.error.message ?? "codex app-server error"));
        else waiter.resolve(msg.result);
      },
      onError: (err) => fail(err),
      onClose: () => fail(new Error(`codex app-server at ${url} closed the connection`)),
    });
  });
}

// ─── The tmux fallback ──────────────────────────────────────────────────────

export interface TmuxIO {
  query: (argv: string[]) => Promise<string>;
  send: (argv: string[]) => Promise<void>;
}

const PANE_ID_RE = /^%\d+$/;

function tmuxBin(): string {
  return process.env.CREW_PEERS_TMUX_BIN ?? "tmux";
}

const defaultTmuxIO: TmuxIO = {
  query: (argv) =>
    new Promise((resolve, reject) => {
      const child = Bun.spawn([tmuxBin(), ...argv], { stdout: "pipe", stderr: "ignore" });
      void new Response(child.stdout).text().then(async (out) => {
        const code = await child.exited;
        code === 0 ? resolve(out) : reject(new Error(`tmux ${argv[0]} exited ${code}`));
      }, reject);
    }),
  send: (argv) =>
    new Promise((resolve, reject) => {
      const child = Bun.spawn([tmuxBin(), ...argv], { stdout: "ignore", stderr: "ignore" });
      void child.exited.then(
        (code) => (code === 0 ? resolve() : reject(new Error(`tmux ${argv[0]} exited ${code}`))),
        reject,
      );
    }),
};

/** How long to let the pane settle between the paste and the Enter. A TUI
 *  redraws on paste, and submitting into a half-processed input line drops the
 *  prompt; `inject-prompt.sh` sleeps the same 500ms at the same seam. */
export const PASTE_SETTLE_MS = 500;

let pasteSeq = 0;

/**
 * Paste one line into a seat's pane and submit it.
 *
 * NOT serialized per target, and that is the one deliberate divergence from the
 * twin. Solios's `pane-delivery.ts` chains deliveries per pane because its
 * caller is an HTTP handler: two panel POSTs can be in flight at once, and two
 * concurrent pastes corrupt each other deterministically — B's paste lands on
 * the line A is still composing, A's Enter submits both concatenated, B's Enter
 * submits an empty line. This caller cannot do that: `pollAndPushMessages` walks
 * one poll's messages in a `for` loop with an `await` per message, and the poll
 * itself is a single `setInterval` callback, so there is exactly one delivery in
 * flight per process and exactly one process per seat. A chain here would guard
 * a race that the loop already prevents. If this ever gains a second caller — a
 * push path, a second timer — it needs the twin's `serializePerTarget` first.
 *
 * Pane-anchored: the session's active pane is resolved to a concrete `%N` ONCE,
 * so the Enter can never submit a different pane's in-flight prompt. A pane the
 * user scrolled into copy-mode still takes the paste but EATS the Enter, so the
 * mode is cancelled first (`-X cancel` errors on a pane not in a mode, hence the
 * query). Args-array spawn, no shell — nothing in the text can become syntax.
 */
export async function pasteIntoPane(
  session: string,
  text: string,
  io: TmuxIO = defaultTmuxIO,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const pane = (
    await io.query(["display-message", "-p", "-t", session, "-F", "#{pane_id}"])
  ).trim();
  if (!PANE_ID_RE.test(pane)) {
    throw new Error(`could not resolve an active pane for session "${session}" (got "${pane}")`);
  }
  pasteSeq += 1;
  const buffer = `crew-peers-${process.pid}-${pasteSeq}`;
  await io.send(["set-buffer", "-b", buffer, text]);
  await io.send(["paste-buffer", "-b", buffer, "-d", "-t", pane]);
  await sleep(PASTE_SETTLE_MS);
  const inMode = (
    await io.query(["display-message", "-p", "-t", pane, "-F", "#{pane_in_mode}"])
  ).trim();
  if (inMode === "1") await io.send(["send-keys", "-t", pane, "-X", "cancel"]);
  await io.send(["send-keys", "-t", pane, "Enter"]);
}

// ─── What the seat reads ────────────────────────────────────────────────────

export interface PeerMessageView {
  from_id: string;
  from_summary?: string;
  from_cwd?: string;
  sent_at: string;
  text: string;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The `<channel source="crew-peers" …>` block a codex seat receives.
 *
 * Deliberately the SAME envelope Claude Code's harness renders around a
 * `notifications/claude/channel` push, so a crewmate's instructions about peer
 * messages read identically on either runtime — and so the sender's id is
 * inline, which is the only way a codex seat can find the address to reply to.
 */
export function renderPeerChannelBlock(msg: PeerMessageView): string {
  const parts = [
    `<channel source="crew-peers"`,
    `from_id="${attr(msg.from_id)}"`,
    `sent_at="${attr(msg.sent_at)}"`,
  ];
  if (msg.from_summary) parts.push(`from_summary="${attr(msg.from_summary)}"`);
  if (msg.from_cwd) parts.push(`from_cwd="${attr(msg.from_cwd)}"`);
  return `${parts.join(" ")}>\n${msg.text}\n</channel>`;
}

/**
 * The one-line form for the pane fallback. A pane submits on Enter, so the block
 * above would submit its first line and strand the rest. The leading frame is a
 * plain word, so a message that opens with `/` cannot be eaten by a TUI's
 * slash-command autocomplete.
 */
export const PANE_FRAME = "crew-peers message";

export function renderPeerPaneLine(msg: PeerMessageView): string {
  const body = msg.text.replace(/\s+/g, " ").trim();
  const head = `${PANE_FRAME} from ${msg.from_id} (${msg.sent_at}) —`;
  return body ? `${head} ${body}` : head;
}

// ─── The delivery ───────────────────────────────────────────────────────────

export type CodexDeliveryPath = "ws" | "fallback";

export interface CodexDeliveryOutcome {
  path: CodexDeliveryPath;
  threadId?: string;
  reason?: string;
}

export interface CodexDeliveryDeps {
  port?: (id: string) => number | undefined;
  turn?: typeof startCodexTurn;
  paste?: (session: string, text: string) => Promise<void>;
  factory?: CodexSocketFactory;
}

/**
 * Deliver one peer message to a codex seat: WS first, pane second.
 *
 * Throws only when BOTH paths failed — then nothing reached the seat, and the
 * caller's job is to say so in the log rather than to record a delivery.
 */
export async function deliverToCodexSeat(
  seat: Seat,
  msg: PeerMessageView,
  deps: CodexDeliveryDeps = {},
): Promise<CodexDeliveryOutcome> {
  const port = (deps.port ?? seatPort)(seat.id);
  let reason: string;
  if (port === undefined) {
    reason = `no app-server port could be derived for "${seat.id}"`;
  } else {
    try {
      const threadId = await (deps.turn ?? startCodexTurn)(port, renderPeerChannelBlock(msg), {
        home: seat.home,
        factory: deps.factory,
      });
      return { path: "ws", threadId };
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  await (deps.paste ?? pasteIntoPane)(seat.session, renderPeerPaneLine(msg));
  return { path: "fallback", reason };
}
