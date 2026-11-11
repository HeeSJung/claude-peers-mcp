/**
 * Route a `send_message` to a SOLIOS THREAD ADDRESS, `solios:<thread_id>`, into
 * that thread on the Solios panel (ADR-0064, sooth-os/sooth#2046).
 *
 * The Solios daemon hands a panel prompt for a crewmate whose home lives on
 * another server to crew-peers FROM `solios:<thread_id>`; the receiving broker
 * stamps it `solios:<thread_id>@<server>` (the `/forward` sender rule). An
 * office seat answers with a plain `send_message` back to that sender: the `@`
 * branch carries it to the daemon's server, whose broker posts the content
 * here. A bare `solios:<thread_id>` sent on the daemon's own server lands the
 * same way.
 *
 * The broker POSTs `{thread_id, content}` to the daemon's `/api/v1/reply`, the
 * same two keys an office crewmate's Solios `reply` tool and
 * `crew-reply-solios.sh` send, so the answer is indistinguishable from theirs.
 * The daemon's answer is the delivery verdict:
 *   200 `{ok:true}` → on the thread
 *   400/401/502 `{ok:false, error}` → failed send carrying the daemon's reason.
 */

import { loadDaemonSecret } from "./session-address.ts";

export const SOLIOS_ADDRESS_PREFIX = "solios:";

/** The daemon's loopback listener; `CLAUDE_PEERS_TICKET_INBOX_URL` overrides it, as for session addresses. */
const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:8770";

/** A gh: thread posts an issue comment through the daemon, so allow it the same budget as the reply script. */
const REPLY_TIMEOUT_MS = 20_000;

/**
 * The thread id when `toId` is `solios:` plus a non-empty key with no
 * whitespace and no `@`, else null. The `@<machine>` form stays the
 * remote-forward branch's; the thread grammar is the daemon's to refuse.
 */
export function parseSoliosAddress(toId: string): string | null {
  if (!toId.startsWith(SOLIOS_ADDRESS_PREFIX)) return null;
  const threadId = toId.slice(SOLIOS_ADDRESS_PREFIX.length);
  if (threadId === "" || /\s/.test(threadId) || threadId.includes("@")) return null;
  return threadId;
}

export async function deliverSoliosReply(
  threadId: string,
  text: string,
  // `secret: undefined` given explicitly = send no header; omitted = look it up.
  opts?: { baseUrl?: string; secret?: string | undefined },
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = opts?.baseUrl ?? process.env.CLAUDE_PEERS_TICKET_INBOX_URL ?? DEFAULT_DAEMON_BASE_URL;
  const secret = opts && "secret" in opts ? opts.secret : await loadDaemonSecret();
  const headers = new Headers({ "content-type": "application/json" });
  if (secret) headers.set("x-solios-secret", secret);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ thread_id: threadId, content: text }),
      signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Solios daemon unreachable at ${baseUrl}: ${msg}` };
  }
  if (res.ok) return { ok: true };
  const raw = (await res.text().catch(() => "")).trim();
  let reason = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") reason = parsed.error;
  } catch {
    // a plain-text refusal is its own reason
  }
  return {
    ok: false,
    error: reason
      ? `Solios daemon refused thread ${threadId} (${res.status}): ${reason}`
      : `Solios daemon refused thread ${threadId} (${res.status})`,
  };
}
