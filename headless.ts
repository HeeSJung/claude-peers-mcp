/**
 * Headless marker — a peer registered from a one-shot headless turn (a
 * ticket-session turn, a remote resume turn) rather than a resident seat.
 * Exists so seat-address resolvers can skip headless rows; a headless peer can
 * still send.
 *
 * The process that launches such a turn sets this env var; server.ts reads it
 * once at startup and passes `headless` on /register.
 */
export const HEADLESS_ENV = "CLAUDE_PEERS_HEADLESS";

const TRUTHY = new Set(["1", "true", "yes"]);

export function readHeadlessEnv(env: Record<string, string | undefined>): boolean {
  return TRUTHY.has((env[HEADLESS_ENV] ?? "").trim().toLowerCase());
}
