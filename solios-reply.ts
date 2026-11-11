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

import { postToDaemon } from "./session-address.ts";

export const SOLIOS_ADDRESS_PREFIX = "solios:";

function msFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * How long the broker waits on the daemon's reply endpoint. A gh: thread posts
 * an issue comment through the daemon, so it gets the reply script's budget.
 * `CLAUDE_PEERS_SOLIOS_REPLY_TIMEOUT_MS` overrides it (tests).
 */
export const SOLIOS_REPLY_TIMEOUT_MS = msFromEnv("CLAUDE_PEERS_SOLIOS_REPLY_TIMEOUT_MS", 20_000);

/**
 * How long a sending broker waits on a peer broker's `/forward` to a
 * `solios:<thread_id>`: longer than that broker's wait on its daemon, so a
 * slow reply that lands is never reported to the sender as failed (a retry
 * would post it twice). `CLAUDE_PEERS_SOLIOS_FORWARD_TIMEOUT_MS` overrides it
 * (tests).
 */
export const SOLIOS_FORWARD_TIMEOUT_MS = msFromEnv("CLAUDE_PEERS_SOLIOS_FORWARD_TIMEOUT_MS", 30_000);

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
  opts?: { baseUrl?: string; secret?: string | undefined },
): Promise<{ ok: boolean; error?: string }> {
  const r = await postToDaemon(
    "/api/v1/reply",
    { thread_id: threadId, content: text },
    SOLIOS_REPLY_TIMEOUT_MS,
    opts,
  );
  if (r.ok) return { ok: true };
  if (r.unreachable) return { ok: false, error: `Solios daemon unreachable at ${r.baseUrl}: ${r.message}` };
  let reason = r.body;
  try {
    const parsed = JSON.parse(r.body) as { error?: unknown };
    if (typeof parsed.error === "string") reason = parsed.error;
  } catch {
    // a plain-text refusal is its own reason
  }
  return {
    ok: false,
    error: reason
      ? `Solios daemon refused thread ${threadId} (${r.status}): ${reason}`
      : `Solios daemon refused thread ${threadId} (${r.status})`,
  };
}
