/**
 * Route a `send_message` to a SESSION ADDRESS into the solios-mcp daemon's
 * inbox, where it becomes a new turn on that headless session. Kinds:
 * `ticket:<repoName>#<issue>` (an issue's ticket-session, sooth-os/sooth#1140,
 * spec #464) and `side:<side id>` (a Side Session).
 *
 * The daemon owns the address grammar (solios mcp-daemon) and the admission
 * verdict. The broker knows only the prefix list below; it holds no session
 * state: it POSTs `{source:'peer', thread_id, sender, content}` to the loopback
 * inbox and relays the answer:
 *   200 → delivered (queued as a turn)
 *   400 malformed / 404 no such session / 409 closed, opening or gone /
 *   429 loop brake / 503 state unknown / 401 bad secret → failed send, body =
 *   the reason.
 * A message never creates a session; that rule is the daemon's.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every daemon-owned address prefix. A new headless kind is one entry here;
 * the solios daemon's copy is pinned to this list by test.
 */
export const DAEMON_ADDRESS_PREFIXES = ["ticket:", "side:"] as const;

/** The solios-mcp daemon's loopback listener; `CLAUDE_PEERS_TICKET_INBOX_URL` overrides it (tests). */
const DEFAULT_INBOX_BASE_URL = "http://127.0.0.1:8770";

/** Admission runs a live issue-state probe, so allow it a few seconds. */
const INBOX_TIMEOUT_MS = 15_000;

/**
 * The address itself when `toId` is a daemon-owned prefix plus a non-empty key
 * with no whitespace and no `@`, else null. The `@<machine>` form stays the
 * remote-forward branch's; the key grammar is the daemon's to refuse.
 */
export function parseSessionAddress(toId: string): string | null {
  const prefix = DAEMON_ADDRESS_PREFIXES.find((p) => toId.startsWith(p));
  if (!prefix) return null;
  const key = toId.slice(prefix.length);
  if (key === "" || /\s/.test(key) || key.includes("@")) return null;
  return toId;
}

/**
 * The daemon's shared secret: `SOOTH_KEEP_MCP_SECRET`, else
 * `$XDG_DATA_HOME|~/.local/share` + `/solios-mcp/secret` — the daemon's own
 * lookup order. Undefined when neither exists (the daemon then runs open).
 * Read per send so a rotated secret needs no broker restart.
 */
export async function loadDaemonSecret(): Promise<string | undefined> {
  if (process.env.SOOTH_KEEP_MCP_SECRET) return process.env.SOOTH_KEEP_MCP_SECRET;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  try {
    return (await Bun.file(join(dataHome, "solios-mcp", "secret")).text()).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function deliverSessionMessage(
  address: string,
  senderId: string,
  text: string,
  // `secret: undefined` given explicitly = send no header; omitted = look it up.
  opts?: { baseUrl?: string; secret?: string | undefined },
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = opts?.baseUrl ?? process.env.CLAUDE_PEERS_TICKET_INBOX_URL ?? DEFAULT_INBOX_BASE_URL;
  const secret = opts && "secret" in opts ? opts.secret : await loadDaemonSecret();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-solios-secret"] = secret;

  let res: Response;
  try {
    // The path target is ignored for peer messages: the daemon dispatches on the
    // address kind.
    res = await fetch(`${baseUrl}/inbox/ticket`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "peer", thread_id: address, sender: senderId, content: text }),
      signal: AbortSignal.timeout(INBOX_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `session inbox unreachable at ${baseUrl}: ${msg}` };
  }
  if (res.ok) return { ok: true };
  const reason = (await res.text().catch(() => "")).trim();
  return {
    ok: false,
    error: reason
      ? `session inbox refused ${address} (${res.status}): ${reason}`
      : `session inbox refused ${address} (${res.status})`,
  };
}
