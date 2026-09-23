/**
 * Route a crewmate's send_message to `vscode@mac:<qid>` into the VS Code mailbox
 * instead of the broker (sooth-os/sooth#1086). The mailbox writer
 * crew-reply-vscode.sh owns delivery and its exit codes are the contract:
 *   0 → delivered (stdout line says where), 1/2/3 → error (stderr says why;
 *   3 = nothing reached Heesoo, the caller still holds the answer).
 */

// Absolute and VPS-only on purpose: the qid is minted on the VPS and only VPS
// sessions receive VS Code questions, so this route never runs on the Mac.
const CREW_REPLY_VSCODE_SCRIPT = "/home/heesoo/sooth/shared/scripts/crew-reply-vscode.sh";

// crew-ask-peers.sh mints qids as `q<epoch>-<pid>-<random>`, digits only.
const VSCODE_REPLY_ADDRESS = /^vscode@mac:(q[0-9]+-[0-9]+-[0-9]+)$/;

/** The qid of a `vscode@mac:<qid>` address, or null for anything else. */
export function parseVscodeReplyAddress(toId: string): string | null {
  const m = VSCODE_REPLY_ADDRESS.exec(toId);
  return m ? m[1]! : null;
}

export async function deliverVscodeReply(
  qid: string,
  message: string,
  opts?: { script?: string },
): Promise<{ ok: boolean; text: string; code: number }> {
  const script = opts?.script ?? CREW_REPLY_VSCODE_SCRIPT;
  const proc = Bun.spawn(["bash", script, qid, "-"], {
    stdin: new TextEncoder().encode(message),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return { ok: true, text: stdout.trim(), code };
  return { ok: false, text: stderr.trim() || `crew-reply-vscode.sh exited ${code}`, code };
}
