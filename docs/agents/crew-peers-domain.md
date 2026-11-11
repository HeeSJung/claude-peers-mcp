---
description: The map of the crew-peers repo: which document to read when, where a new file goes here, and whose glossary owns a word. Read it before exploring `~/apps/crew-peers`.
---

# crew-peers Domain Map

This repo's map. `CLAUDE.md` carries what a session knows every turn here; this file is
what it reads *before exploring*, and it is the only place the catalogue of what
`~/apps/crew-peers` holds lives.

It inherits its section headings from `docs/agents/domain.md`, so this map and the
corpus's own (`~/sooth/shared/docs/agents/sooth-domain.md`) are read with the same eye.

crew-peers is the broker and MCP channel through which crew sessions find and message
each other, on one machine and across machines over Tailscale. Sori owns it. **It keeps
no glossary and no ADR series of its own**: its words live in the company glossary
`~/sooth/shared/GLOSSARY.md`, and the decisions about it in `~/sooth/shared/docs/adr/`.

## Before exploring, read these

Each row is a document and the shape of the task that should send you to it. If a
document does not exist, proceed silently.

| Document | Read it when |
|---|---|
| `~/apps/crew-peers/CLAUDE.md` | You need the module roles (`broker.ts`, `server.ts`, `seat-name.ts`, `session-address.ts`, `headless.ts` and the rest), the run commands, or the Bun rules. Always loaded, so read it for what it *points at* rather than to learn it. |
| `~/apps/crew-peers/README.md` | You need the MCP tools a session gets, the broker's environment variables and ports, or the cross-host setup (broker secret, `brokers.json`, HMAC signing). |
| `~/apps/crew-peers/docs/agents/domain.md` | You are about to explore, plan, or name something, and want the generic consumer rules for `GLOSSARY.md` and `docs/adr/` and the check-latest-docs rule. |
| `~/apps/crew-peers/docs/agents/issue-tracker.md` | A skill says "publish to the issue tracker" or "fetch the relevant ticket". It holds this repo's tracker (`sooth-os/crew-peers`), the `gh` recipes, and the board 3 ids. |
| `~/apps/crew-peers/docs/agents/crew-peers-domain.md` | This file. You are orienting in the repo, or deciding where a new file goes here. |
| `~/sooth/shared/GLOSSARY.md` | You met a word this repo uses (Session Address, Ticket Address, Ticket Session, Seat Session) you could not define, or are naming something in the broker or server. §Language is the glossary. |
| `~/sooth/shared/docs/adr/` | You are about to change a design here. ADR-0030 names the channel `crew-peers` and lists which internals keep the old `claude-peers` spelling; ADR-0052 moves the broker state to `~/.crew-peers/`; ADR-0044 stamps a headless turn's Session Address as the sender; ADR-0041 has crewmates message each other directly with no hub. |
| `~/sooth/shared/docs/agents/conventions.md` | You are changing how a crewmate reaches another (§Communication Protocol, the callers' side of this channel), or deciding where a new file goes (§Standard Folder Layout). |
| `~/sooth/shared/scripts/crew-peers/` | You are changing the seat resolver `seat-name.ts` runs (`crew-send-peers.sh --resolve`), the VS Code reply path `vscode-reply.ts` calls (`crew-reply-vscode.sh`), or the wrappers callers use. They are shared scripts, so a change there is filed in `sooth-os/sooth`. |
| `~/sooth/shared/docs/agents/sooth-domain.md` | Your question is about the corpus rather than this repo: which shared document answers what, and where a new file goes over there. |
| `~/sooth/shared/scripts/instincts/` | You are about to do something risky: restart the broker, a delete, an automated send, a schema or DB change. Query first: `python3 ~/sooth/shared/scripts/instincts/instincts-query.py match <keyword> --json`. |

## File structure

`~/apps/crew-peers` is **app-shaped** (signal: `package.json` carries a `test` script
run by `bun test`, and the TypeScript sources sit at the repo root, outside the standard
folders):

```
~/apps/crew-peers/
├── CLAUDE.md            ← this repo's instructions, loaded every turn
├── README.md            ← the MCP tools, environment variables, cross-host setup
├── *.ts                 ← the app at the root: broker.ts (the daemon), server.ts (the MCP stdio server), cli.ts, and the modules both import
├── *.test.ts            ← bun tests, colocated beside the module each one covers
├── shared/              ← types.ts (the broker API types) and summarize.ts (auto-summary)
├── scripts/             ← hand-run smoke tests against live brokers (loopback, auth rejection)
├── systemd/             ← crew-peers-broker.service, the user unit, installed by symlink
├── tools/oxlint/        ← the vendored anti-slop oxlint plugin `bun run lint` loads
└── docs/agents/         ← this map · domain.md · issue-tracker.md
```

**Tests** are colocated, not gathered: there is no `tests/` folder and no `src/` folder.
`bun test` runs every `*.test.ts` at the root.

**State** lives outside the checkout, in `~/.crew-peers/` (`broker.db`, `brokers.json`,
the secret files, `broker.log`, `cross-host.log`; ADR-0052). There is no `state/` or
`data/` folder here. Definitions of the standard folders are
`~/sooth/shared/docs/agents/conventions.md` §Standard Folder Layout, not this tree.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a ticket, a hypothesis, a test
name, a peer message, a route or tool name), use the term as
`~/sooth/shared/GLOSSARY.md` §Language defines it.

A synonym forks the vocabulary: the moment two words name one thing, every search,
router and glossary lookup has to know both, and one of them starts drifting.

If the concept is not in the glossary, that is the signal: either the language is being
invented (reconsider), or there is a real gap for `/domain-modeling` to close.
