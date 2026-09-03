#!/bin/bash
# Wrapper to launch claude-peers MCP server with bun on PATH
export PATH="/home/heesoo/.bun/bin:$PATH"
exec /home/heesoo/.bun/bin/bun /home/heesoo/claude-peers-mcp/server.ts "$@"
