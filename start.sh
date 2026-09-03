#!/bin/bash
# Wrapper to launch the crew-peers MCP server with bun on PATH.
# Derives the server path from its own location, so moving this repo needs no
# edit here — only the registrations that name this wrapper.
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/home/heesoo/.bun/bin:$PATH"
exec /home/heesoo/.bun/bin/bun "$here/server.ts" "$@"
