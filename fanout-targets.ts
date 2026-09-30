/**
 * Which peer_brokers rows the broker may talk to.
 *
 * peer_brokers (SQLite) outlives brokers.json: a machine removed from the
 * config keeps its row. Talking to it fails `unknown-machine` in
 * peerPostJson, so fanout, health probes and the janitor use only rows whose
 * machine is still in the loaded brokers.json. A skipped machine is reported
 * once per process lifetime, never per heartbeat.
 */

export type SkipReporter = (machine: string) => void;

export function createTargetFilter(report: SkipReporter) {
  const reported = new Set<string>();
  return function configuredTargets<T extends { machine: string }>(
    rows: T[],
    configured: ReadonlySet<string>,
    selfMachine: string,
  ): T[] {
    const targets: T[] = [];
    for (const row of rows) {
      if (row.machine === selfMachine) continue;
      if (configured.has(row.machine)) {
        targets.push(row);
        continue;
      }
      if (!reported.has(row.machine)) {
        reported.add(row.machine);
        report(row.machine);
      }
    }
    return targets;
  };
}
