# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)               |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable                    | Default                  | Description                                                          |
| --------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`                     | `7899`                   | Broker local-listener port (loopback, unauth)                        |
| `CLAUDE_PEERS_PEER_PORT`                | `7900`                   | Broker cross-host listener port (Tailscale-bound, HMAC-required)      |
| `CLAUDE_PEERS_DB`                       | `~/.claude-peers.db`     | SQLite database path                                                  |
| `CLAUDE_PEERS_CONFIG_DIR`               | `~/.claude-peers/`       | Where `brokers.json` and `secret-current` live                        |
| `CLAUDE_PEERS_CROSS_HOST_LOG`           | `<config-dir>/cross-host.log` | Audit log for cross-broker requests                              |
| `OPENAI_API_KEY`                        | —                        | Enables auto-summary via gpt-5.4-nano                                 |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
- (cross-host only) [Tailscale](https://tailscale.com) on both machines

## Cross-host messaging (v2)

Two machines on the same Tailnet can join their broker meshes — Claude sessions
on machine A can `send_message` to peers on machine B. The cross-host listener
is HMAC-signed (SHA-256, 30s clock window, nonce LRU replay protection) and
binds to the Tailscale IP only — never to `0.0.0.0` or any public NIC.

### One-time setup per machine

1. **Generate a broker secret:**

   ```bash
   mkdir -p ~/.claude-peers
   openssl rand -hex 32 > ~/.claude-peers/secret-current
   chmod 600 ~/.claude-peers/secret-current
   ```

2. **Add a forced-command SSH key path** to `~/.ssh/authorized_keys`:

   ```
   command="cat ~/.claude-peers/secret-current",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty <peer's pubkey>
   ```

3. **Add an SSH alias on the *other* machine** in `~/.ssh/config`:

   ```
   Host <this-machine>-broker-secret
       HostName <this-machine>.tailnet
       User <peer-user>
       IdentityFile ~/.ssh/broker-secret-fetcher
       IdentitiesOnly yes
   ```

4. **Edit `~/.claude-peers/brokers.json`:**

   ```json
   {
     "schema": 1,
     "self_machine": "silas-vps",
     "self_ts_addr": "100.64.0.5:7900",
     "peers": [
       {
         "machine":   "milo-mac",
         "ts_addr":   "100.64.0.7:7900",
         "ssh_alias": "milo-broker-secret"
       }
     ]
   }
   ```

5. **Restart the broker** — it now binds two listeners:

   ```
   [claude-peers broker] local listener: 127.0.0.1:7899
   [claude-peers broker] peer listener:  100.64.0.5:7900
   [claude-peers broker] peers: milo-mac
   ```

### Use it from Claude

```
list_peers with scope "machine+remote"
   → returns local + remote peers; remote IDs end in @<machine>

send_message to_id "<id>@milo-mac" message "..."
   → forwarded over Tailscale; recipient sees same channel push as local
```

If `brokers.json` is absent, the broker runs in single-broker mode (v1
behavior — local loopback only). Cross-host is opt-in.

For the full design + smoke-test plan, see
[`Claude-Claw/knowledge/multi-session-peer-bridge-v2-broker.md`](https://github.com/HeeSJung/Claude-Claw/blob/main/knowledge/multi-session-peer-bridge-v2-broker.md).
