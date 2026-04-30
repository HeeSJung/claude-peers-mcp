/**
 * Tailscale IP detection.
 *
 * `tailscale ip --1` returns the first (IPv4) Tailscale IP, or fails non-zero
 * if Tailscale isn't running. We use it as the bind address for the cross-broker
 * listener — never bind to 0.0.0.0 or any public NIC.
 */

import { spawn } from "node:child_process";

export async function detectTailscaleIp(timeoutMs = 4_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("tailscale", ["ip", "--1"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (out += d));
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const ip = out.trim().split("\n")[0]?.trim() ?? "";
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        resolve(ip);
      } else {
        resolve(null);
      }
    });
  });
}
