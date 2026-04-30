/**
 * Cross-broker secret fetcher.
 *
 * Each broker writes its own 32-byte secret to ~/.claude-peers/secret-current
 * (mode 600). Peer brokers fetch each other's secrets via a forced-command
 * SSH key path:
 *
 *   ssh <ssh_alias>           # → prints 64 hex chars to stdout, exits 0
 *
 * The SSH key on the receiving side has a forced-command:
 *   command="cat ~/.claude-peers/secret-current"
 *
 * Cached in memory; re-fetched on HMAC verify failure.
 */

import { spawn } from "node:child_process";

export interface SecretFetcher {
  fetch(machine: string, sshAlias: string): Promise<Buffer>;
}

export class SshSecretFetcher implements SecretFetcher {
  // machine → 32-byte secret
  private cache = new Map<string, Buffer>();

  async fetch(machine: string, sshAlias: string): Promise<Buffer> {
    const cached = this.cache.get(machine);
    if (cached) return cached;
    return this.refetch(machine, sshAlias);
  }

  async refetch(machine: string, sshAlias: string): Promise<Buffer> {
    let hex: string;
    if (sshAlias.startsWith("__test_secret__:") && process.env.CLAUDE_PEERS_SECRET_FETCH_TEST_MODE === "1") {
      // Test-only: read directly from the file path. Used by loopback-smoke.ts.
      const path = sshAlias.slice("__test_secret__:".length);
      const { readFileSync } = await import("node:fs");
      hex = readFileSync(path, "utf8").trim();
    } else {
      hex = await runSshSecretRead(sshAlias);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        `secret-fetcher: ${machine} returned non-hex (${hex.length} chars), expected 64`,
      );
    }
    const buf = Buffer.from(hex, "hex");
    this.cache.set(machine, buf);
    return buf;
  }

  invalidate(machine: string): void {
    this.cache.delete(machine);
  }

  has(machine: string): boolean {
    return this.cache.has(machine);
  }
}

function runSshSecretRead(sshAlias: string, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=3",
        sshAlias,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`ssh ${sshAlias}: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (stdout += d));
    child.stderr!.on("data", (d: string) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`ssh ${sshAlias}: exit ${code} — ${stderr.trim()}`));
      }
    });
  });
}
