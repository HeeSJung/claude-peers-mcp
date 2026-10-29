/**
 * One `list_peers` row as text. A headless row (headless.ts) gets a trailing
 * Headless line so a reader never takes a one-turn session for the seat.
 */

import type { Peer } from "./shared/types.ts";

export const HEADLESS_LINE = "Headless: true (one-turn session, not the seat; reply to its from_id)";

export function formatPeer(p: Peer): string {
  const parts = [`ID: ${p.id}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  if (p.headless) parts.push(HEADLESS_LINE);
  return parts.join("\n  ");
}
