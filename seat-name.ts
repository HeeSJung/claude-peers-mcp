/**
 * Resolve a bare seat name (`send_message(to_id="haru")`) to the live session
 * seated in that crewmate's home (sooth-os/sooth#1814). The doctrine says a
 * crewmate's kebab id is its crew-peers id; peer ids are random and change on
 * every restart, so the broker makes the name true on the wire.
 *
 * The rule is not copied here. `crew-send-peers.sh --resolve` owns it (roster
 * home, `crew_peers_seat_id`'s seat pick, the listener stand-in fallback), the
 * same rule senders outside a session already use. The broker hands it its own
 * local peer list on stdin, so the script never calls back into the broker.
 * Resolved on every send, never cached: a seat restart is invisible to senders.
 */
import type { Peer } from "./shared/types.ts";

// Absolute and VPS-only, like vscode-reply.ts: the roster and the crewmate
// homes live on this box. A broker without the script (the Mac) answers every
// name with the ordinary "not found".
const SEAT_RESOLVER_SCRIPT =
  process.env.CLAUDE_PEERS_SEAT_RESOLVER ?? "/home/heesoo/sooth/shared/scripts/crew-peers/crew-send-peers.sh";

// A roster id: lowercase kebab. Random peer ids also fit, but the exact-id
// lookup runs first, so a live peer id never reaches this resolver.
const SEAT_NAME = /^[a-z][a-z0-9-]*$/;

export type SeatResolution =
  | { kind: "unknown" }
  | { kind: "seat"; id: string; home: string }
  | { kind: "vacant"; home: string };

export function isSeatNameShaped(toId: string): boolean {
  return SEAT_NAME.test(toId);
}

export async function resolveSeatName(
  name: string,
  peers: Peer[],
  opts?: { script?: string },
): Promise<SeatResolution> {
  if (!isSeatNameShaped(name)) return { kind: "unknown" };
  const script = opts?.script ?? SEAT_RESOLVER_SCRIPT;
  if (!(await Bun.file(script).exists())) return { kind: "unknown" };
  const proc = Bun.spawn(["bash", script, "--resolve", name], {
    stdin: new TextEncoder().encode(JSON.stringify(peers)),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5_000,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return { kind: "unknown" };
  try {
    const r = JSON.parse(stdout) as { home?: unknown; id?: unknown };
    if (typeof r.home !== "string") return { kind: "unknown" };
    if (typeof r.id === "string" && r.id) return { kind: "seat", id: r.id, home: r.home };
    return { kind: "vacant", home: r.home };
  } catch {
    return { kind: "unknown" };
  }
}

// The roster's reader (sourced, never copied): `crewmate_is_id` and
// `crewmate_home_server` answer which server a crewmate's home lives on (ADR-0064).
const ROSTER_READER_SCRIPT =
  process.env.CLAUDE_PEERS_ROSTER_READER ?? "/home/heesoo/sooth/shared/scripts/seat/crewmate-seat.sh";

/**
 * The server a roster crewmate's home lives on (`homeServer`, default oregon),
 * or null for a name off the roster, an unreadable roster, or a broker without
 * the script. A bare name whose home server is another broker is sent there as
 * `<name>@<server>`, where that broker resolves the seat.
 */
export async function readHomeServer(name: string, opts?: { script?: string }): Promise<string | null> {
  if (!isSeatNameShaped(name)) return null;
  const script = opts?.script ?? ROSTER_READER_SCRIPT;
  if (!(await Bun.file(script).exists())) return null;
  const proc = Bun.spawn(
    ["bash", "-c", 'source "$1" && crewmate_is_id "$2" && crewmate_home_server "$2"', "_", script, name],
    { stdout: "pipe", stderr: "ignore", timeout: 5_000 },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const server = stdout.trim();
  return code === 0 && server ? server : null;
}
