---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Auto-summary generation via gpt-5.4-nano.
- `cli.ts` — CLI utility for inspecting broker state.
- `vscode-reply.ts` — Routes `send_message` to `vscode@mac:<qid>` into the VS Code mailbox via `crew-reply-vscode.sh`. Both the broker's `/send-message` (every HTTP client) and `server.ts` (a session before it registers) call it.
- `session-address.ts` — Routes `send_message` to a session address (`ticket:<repo-name>#<n>`, `side:<side id>`) into the solios-mcp daemon's inbox (`127.0.0.1:8770`, or `CLAUDE_PEERS_TICKET_INBOX_URL`; `x-solios-secret`), where it becomes a turn on that headless session. `DAEMON_ADDRESS_PREFIXES` is the broker's only knowledge of the address; the daemon validates the key. The broker's `/send-message` matches it ahead of the peer lookup; the daemon's HTTP answer is the delivery verdict, relayed to the sender as `{ok:false, error}` on refusal.
- `headless.ts` — The headless marker: `server.ts` reads `CLAUDE_PEERS_HEADLESS` at startup and sends `headless` on `/register`; the broker stores it, returns it on `/list-peers`, and carries it on `peer-events` fanout. `CLAUDE_PEERS_ADDRESS` is sent as `address` on `/register`; for a headless peer whose address is a session address or a live local peer id, the broker stamps it as `from_id` on local delivery and the daemon forward; cross-host forwards carry only a stand-in peer id, never a session address. `/list-peers` never shows it.
- `fanout-targets.ts` — Filters `peer_brokers` rows to machines still in `brokers.json`; fanout and `healthLoop` use it (the janitor does not, so stale rows still go down), and each skipped machine is reported once per process.

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-peers

# Or just add to .mcp.json and use as regular MCP (no channel push, but tools work):
# { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
