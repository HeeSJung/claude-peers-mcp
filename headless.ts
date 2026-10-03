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

/**
 * The turn's durable address: a session address (`ticket:<repo>#<n>`, `side:<side id>`) or a
 * remote crewmate's stand-in peer id. server.ts sends it on /register; the
 * broker stamps it as `from_id` on the peer's outbound messages, honoured only
 * for a headless peer (broker.ts `senderIdFor`).
 */
export const ADDRESS_ENV = "CLAUDE_PEERS_ADDRESS";

/** A registered address, trimmed; anything blank or non-string is no address. */
export function normalizeAddress(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw.trim() || undefined : undefined;
}

export function readAddressEnv(env: Record<string, string | undefined>): string | undefined {
  return normalizeAddress(env[ADDRESS_ENV]);
}
