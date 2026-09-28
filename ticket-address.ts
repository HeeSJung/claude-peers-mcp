/**
 * Route a `send_message` to a TICKET ADDRESS (`ticket:<repoName>#<issue>`) into
 * the solios-mcp daemon's inbox, where it becomes a new turn on that issue's
 * ticket-session (sooth-os/sooth#1140, spec #464).
 *
 * The daemon owns the address format (solios mcp-daemon/ticket-address.ts) and
 * the admission verdict (mcp-daemon/ticket-session-peer.ts). The broker holds
 * no ticket state: it POSTs `{source:'peer', thread_id, sender, content}` to
 * the loopback inbox and relays the answer —
 *   200 → delivered (queued as a turn)
 *   400 malformed / 404 no session for the issue / 409 closed or gone /
 *   503 open-state unknown / 401 bad secret → failed send, body = the reason.
 * A message never creates a session; that rule is the daemon's.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors the daemon's parser, minus its bare `gh:` form: the broker routes
// only the published address. No `@`, `:`-free repo name, positive issue number
// — so it can never be a peer id ([a-z0-9]{8}) or the `<id>@<machine>` form.
const TICKET_ADDRESS = /^ticket:[A-Za-z0-9._-]+#[1-9][0-9]*$/;

/** The solios-mcp daemon's loopback listener; `CLAUDE_PEERS_TICKET_INBOX_URL` overrides it (tests). */
const DEFAULT_INBOX_BASE_URL = "http://127.0.0.1:8770";

/** Admission runs a live issue-state probe, so allow it a few seconds. */
const INBOX_TIMEOUT_MS = 15_000;

/** The address itself when `toId` is a ticket address, else null. */
export function parseTicketAddress(toId: string): string | null {
  return TICKET_ADDRESS.test(toId) ? toId : null;
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

export async function deliverTicketMessage(
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
    // The path target is ignored for peer messages: the seat is the mapping's.
    res = await fetch(`${baseUrl}/inbox/ticket`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "peer", thread_id: address, sender: senderId, content: text }),
      signal: AbortSignal.timeout(INBOX_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `ticket inbox unreachable at ${baseUrl}: ${msg}` };
  }
  if (res.ok) return { ok: true };
  const reason = (await res.text().catch(() => "")).trim();
  return {
    ok: false,
    error: reason
      ? `ticket inbox refused ${address} (${res.status}): ${reason}`
      : `ticket inbox refused ${address} (${res.status})`,
  };
}
