import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVscodeReplyAddress, deliverVscodeReply } from "./vscode-reply.ts";

describe("parseVscodeReplyAddress", () => {
  test("accepts vscode@mac:<qid> and returns the qid", () => {
    expect(parseVscodeReplyAddress("vscode@mac:q1758600000-12345-678")).toBe("q1758600000-12345-678");
  });
  test("accepts a live-shaped qid from crew-ask-peers.sh", () => {
    expect(parseVscodeReplyAddress("vscode@mac:q1790407825-2025251-182616983")).toBe(
      "q1790407825-2025251-182616983",
    );
  });
  test.each([
    "vscode@mac",
    "vscode@mac:",
    "vscode@mac:notaqid",
    "vscode@mac:../x",
    "abc123",
    "abc123@mac",
    "k3pogncc@mac",
    "vscode@mac:q1-2-3/../etc",
  ])("returns null for %p", (addr) => {
    expect(parseVscodeReplyAddress(addr)).toBeNull();
  });
});

describe("deliverVscodeReply", () => {
  let dir: string;
  let script: string;
  const qid = "q1758600000-12345-678";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vscode-reply-test-"));
    script = join(dir, "fake-reply.sh");
    // Captures argv + stdin, then exits per the message's first line (exit0/exit2/exit3).
    writeFileSync(
      script,
      `#!/usr/bin/env bash
printf '%s\\n' "$1" > "${"$"}{0%/*}/argv1"
printf '%s\\n' "$2" > "${"$"}{0%/*}/argv2"
cat > "${"$"}{0%/*}/stdin"
code=$(head -n1 "${"$"}{0%/*}/stdin")
case "$code" in
  exit0) echo "delivered to waiter"; exit 0 ;;
  exit3) echo "no waiter and Solios fallback failed; you still hold the answer" >&2; exit 3 ;;
  exit2) exit 2 ;;
esac
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("passes qid, '-' and the message verbatim on stdin; exit 0 → ok + stdout line", async () => {
    const message = `exit0\nline two with "double" and 'single' quotes\n  $HOME \`tick\``;
    const r = await deliverVscodeReply(qid, message, { script });
    expect(r).toEqual({ ok: true, text: "delivered to waiter", code: 0 });
    expect(readFileSync(join(dir, "argv1"), "utf8")).toBe(`${qid}\n`);
    expect(readFileSync(join(dir, "argv2"), "utf8")).toBe("-\n");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(message);
  });

  test("exit 3 → not ok, text = stderr", async () => {
    const r = await deliverVscodeReply(qid, "exit3", { script });
    expect(r).toEqual({
      ok: false,
      text: "no waiter and Solios fallback failed; you still hold the answer",
      code: 3,
    });
  });

  test("exit 2 with empty stderr → not ok, text names the exit code", async () => {
    const r = await deliverVscodeReply(qid, "exit2", { script });
    expect(r).toEqual({ ok: false, text: "crew-reply-vscode.sh exited 2", code: 2 });
  });
});
