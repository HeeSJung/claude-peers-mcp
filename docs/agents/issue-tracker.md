---
description: Where crew-peers's issues live (`sooth-os/crew-peers`), the `gh` recipe for every named tracker operation, and which shared-tracker rules still apply here.
---

# Issue tracker: GitHub, `sooth-os/crew-peers`

Every skill that says _"the issue tracker should have been provided to you"_ reads
**this file**. Edit it directly; a re-run of `/onboard` is a health check, not the way to
change an answer.

Issues, maps, and specs for this repo live as **GitHub issues in `sooth-os/crew-peers`**,
carded on the **Sooth OS** board (project **3**, owner `sooth-os`). Use the `gh` CLI for
every operation. Work on a **shared** skill or **shared** doc (anything under
`~/sooth/shared` or `~/.claude/skills/`, the `scripts/crew-peers/` wrappers included) is
filed in `sooth-os/sooth` instead, through `~/sooth/shared/docs/agents/issue-tracker.md`.

This file adapts the company recipes in `~/sooth/shared/docs/agents/issue-tracker.md` to
this repo. Company-wide machinery (the Tracker Registry, Capture Routing, the Queue and
Stage fields, `new-project`, and editing a single-select field's options) is
single-sourced there; read that file for any of it.

**Triage labels** are the company-wide set in `~/sooth/shared/docs/agents/triage-labels.md`; this repo keeps no local copy.

---

## Conventions

**Everything an agent WRITES to an issue goes out as SGA** (`sooth-github-actions[bot]`)
through `~/sooth/shared/scripts/tracker/gh-as-bot.sh`. A harness guard denies agent Bash calls to
`gh issue create`, `gh issue/pr comment`, `gh issue close --comment`, and their `gh api`
shapes, each with a pointer back to the gh-as-bot.sh subcommand.

- **Create**: `~/sooth/shared/scripts/tracker/gh-as-bot.sh create -R sooth-os/crew-peers --title "…" (--body "…" | --body-file PATH|-) [--label NAME]`. It prints the new issue's URL on one line, so `URL=$(…)` works. Use `--body-file` for multi-line bodies.
- **Title**: a short Korean noun phrase that passes the title-alone test (40 characters or fewer, at most one code identifier). The full rule is the company file's §Conventions.
- **Comment**: `~/sooth/shared/scripts/tracker/gh-as-bot.sh comment <n> -R sooth-os/crew-peers --body "…"`.
- **Edit**: `gh issue edit <n> -R sooth-os/crew-peers …` stays on the PAT; an edit has no author to get wrong.
- **Read**: `gh issue view <n> -R sooth-os/crew-peers --comments`.
- **List**: `gh issue list -R sooth-os/crew-peers --state open --json number,title,body,labels,comments`.
- **Close**: post the landing comment via gh-as-bot.sh first, then move the card's Status to Done, which closes the issue at once. A bot comment starting with `LANDED:` is closed by the webhook. Off the board: comment via gh-as-bot.sh, then `gh issue close <n> -R sooth-os/crew-peers` (no `--comment`, which would post as HeeSJung). Not planned adds `--reason "not planned"`.
- **Sub-issues / dependencies**: `gh api` with `-H "X-GitHub-Api-Version: 2026-03-10"` (below).

**`-R sooth-os/crew-peers` is explicit on every call**, never inferred from `git remote`:
a worktree's remote can be another repo, and a bare `gh issue close <n>` would act on
issue `<n>` there.

**A bot-created issue sits on no board.** gh-as-bot.sh mints the issue and nothing else, so
board registration (publish step 4) is always yours. Before an `implement-loop` run, card
the map **and every child**:

```bash
gh project item-add 3 --owner sooth-os --url <issue url> --format json --jq .id
```

**A transferred issue never takes sub-issues.** An issue transferred into
`sooth-os/crew-peers` from another repo answers `422` on `POST …/sub_issues` permanently.
Mint a fresh map with gh-as-bot.sh and hang the children under it.

---

## When a skill says "publish to the issue tracker"

"Publish" is this **named tracker operation**: all four steps, in order. A ticket that
skipped any step is not published.

| # | Operation | What it is |
|---|---|---|
| 1 | **Create** | `gh-as-bot.sh create -R sooth-os/crew-peers`: title + body (Parent line, Context, `- [ ]` acceptance). **No labels.** |
| 2 | **Sub-issue parenting** | hang the child under its map with the native sub-issues endpoint |
| 3 | **`blocked_by` wiring (2-pass, integer db id)** | native issue dependencies, the DAG's only representation |
| 4 | **Board registration** | `gh project item-add 3 --owner sooth-os`, then promote Status → Not Started |

The `Parent:` line in the body is load-bearing: the webhook gives `needs-triage` to an
issue born with no State label, and that line is how it knows a child ticket at birth.

### The load-bearing gotcha: integer database id, not `#number`, not node id

Both wiring endpoints (2 and 3) key on the issue's **REST integer database id**
(`gh api /repos/sooth-os/crew-peers/issues/<n> -q .id`) and need
`-H "X-GitHub-Api-Version: 2026-03-10"`. The GraphQL node id (`I_kwDO…`, from
`gh issue view --json id`) and a string `-f` both answer `422 "is not of type integer"`;
send the integer with **`-F`**.

- **Dependencies**: `POST /repos/sooth-os/crew-peers/issues/{n}/dependencies/blocked_by`, `issue_id` = the **blocking** issue's id.
- **Sub-issues**: `POST /repos/sooth-os/crew-peers/issues/{map}/sub_issues`, `sub_issue_id` = the **child's** id.

The id exists only after creation, so publishing a set is **2-pass**: Pass 1 creates every
ticket and captures each `#number` **and** integer id; Pass 2 wires edges and parenting
from those. Wire nothing before Pass 1 has finished.

### Pass 1: create, register, capture

```bash
R=sooth-os/crew-peers
MAP_N=<map issue number>
PID=PVT_kwDOEilLWs4Bd4bW       # Sooth OS project id (board 3, owner sooth-os)

BODY=$(cat <<'EOF'
# <Task Title>

Parent: #<map issue number>

## Context

<what/why + folded-in survey brief facts>

## Acceptance

- [ ] <criterion 1>
- [ ] <criterion 2>
EOF
)

# create with NO labels: untriaged is a Status test, not a label
URL=$(~/sooth/shared/scripts/tracker/gh-as-bot.sh create -R "$R" --title "<Ticket title>" --body "$BODY")
N=$(echo "$URL" | grep -oE '[0-9]+$')

# the INTEGER internal id (NOT `gh issue view --json id`)
ID=$(gh api /repos/$R/issues/$N -q .id)

# register on board 3; a fresh card lands with EMPTY Status
ITEM_ID=$(gh project item-add 3 --owner sooth-os --url "$URL" --format json --jq '.id')

# promote Status → Not Started (registered = triaged)
gh project item-edit --id "$ITEM_ID" --project-id $PID --field-id PVTSSF_lADOEilLWs4Bd4bWzhYWsDk --single-select-option-id 99ebbe42

# OPTIONAL, MAP issue only: auto-done run, implement-loop's gate agent closes the map
# after the final review gate. No label = the Human gate (the default).
gh issue edit "$N" -R "$R" --add-label gate:auto
```

Keep `ticket → {number, integer id}` for every ticket; Pass 2 needs both.

### Pass 2: wire `blocked_by` + parenting

```bash
# "B is blocked by A" → target B's NUMBER, send A's INTEGER id
gh api --method POST -H "X-GitHub-Api-Version: 2026-03-10" \
  /repos/$R/issues/$B_N/dependencies/blocked_by -F issue_id="$A_ID"

# hang each child under the map (sub_issue_id = the CHILD's integer id)
gh api --method POST -H "X-GitHub-Api-Version: 2026-03-10" \
  /repos/$R/issues/$MAP_N/sub_issues -F sub_issue_id="$CHILD_ID"

# verify an edge landed
gh api -H "X-GitHub-Api-Version: 2026-03-10" \
  /repos/$R/issues/$B_N/dependencies/blocked_by -q '.[] | "#\(.number) \(.title) [id=\(.id)]"'
```

A **cross-repo** edge (a `sooth-os/sooth` blocker on a crew-peers ticket) has no native
form: put `Blocked by: sooth-os/sooth#n` at the top of the child body and say so in your
report.

**Code repo line**: an issue filed here whose code lands in another repo carries a
`**Code repo:** <owner/name>` body line (`sooth-os/sooth` → `~/sooth/shared`).

### Map and parent issues: `crystallize`'s two paths

- **Immediate run** (default): create the map, or adopt the existing issue, card it on
  board 3 and promote Status → Not Started; it enters the pipeline now.
- **Parked** (Heesoo says "나중에", "일단 이슈만 만들어둬"): leave Status empty and add the
  `needs-triage` label (`gh issue edit <n> -R sooth-os/crew-peers --add-label needs-triage`),
  so it sits in his `01 Queue` view. He re-runs `/crystallize` on it to start it.
  Ambiguous → ask once ("바로 태울까, 파킹할까?").
- **Adopting an existing issue = transform, never duplicate.** Write the spec into that
  issue and ensure its board card (`item-add` is idempotent). The adopt path performs no
  label operation; `ready-for-agent` is Heesoo's own gesture.
- **Registration promotes empty Status to Not Started** (`99ebbe42`), maps and tickets
  alike. A card already past Not Started keeps its Status; a parked map keeps its empty
  Status and `needs-triage`.

### Taxonomy fields (board 3, `sooth-os`)

Project id `PVT_kwDOEilLWs4Bd4bW`; writing a field needs the `project` token scope.
**Status is the only taxonomy field.**

| Field | field-id | option → id |
|---|---|---|
| **Status** | `PVTSSF_lADOEilLWs4Bd4bWzhYWsDk` | Not Started `99ebbe42` · In Progress `33b8ad22` · Done `4be540f2` *(a new card lands with **empty** Status)* |

Queue and Stage (Heesoo's working set, driven by the webhook) are company machinery:
their ids and the **pin-every-`id`** rule for editing any single-select field's options
live in `~/sooth/shared/docs/agents/issue-tracker.md` §Taxonomy fields. Read it before
touching either.

### Status is the state, and it is the run gate

Status on the board card is the single source of truth (no `in-review` or `run:*`
label). Read it via GraphQL; `gh issue view` does not carry it:

```bash
R=sooth-os/crew-peers; O=${R%%/*}; NM=${R##*/}
ISSUE_N=<issue number to read>
read -r ITEM_ID STATUS <<<"$(gh api graphql -f query='
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){ issue(number:$num){
      projectItems(first:20){ nodes{ id project{ number }
        fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } }
  }' -F owner=$O -F repo=$NM -F num=$ISSUE_N \
  --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number==3) | "\(.id) \(.fieldValueByName.name)"')"
```

Move it with `gh project item-edit --id "$ITEM_ID" --project-id PVT_kwDOEilLWs4Bd4bW
--field-id PVTSSF_lADOEilLWs4Bd4bWzhYWsDk --single-select-option-id <optId>`.

A **map** is a top-level issue: parent-less **and** passed explicitly as the run target.
A non-empty native parent means it is a sub-issue and never a run root:

```bash
R=sooth-os/crew-peers; O=${R%%/*}; NM=${R##*/}
ISSUE_N=<candidate map issue number>
[ -n "$ISSUE_N" ] || { echo "HALT: ISSUE_N unset, gate must not run open"; exit 1; }
PARENT="$(gh api graphql -f query='
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){ issue(number:$num){ parent{ number } } }
  }' -F owner=$O -F repo=$NM -F num=$ISSUE_N \
  --jq '.data.repository.issue.parent.number // empty')"
[ -n "$PARENT" ] && { echo "HALT: #$ISSUE_N is a sub-issue of #$PARENT, not a map"; exit 1; }
```

A merged PR that references its child (`#n` in its title or body, or a `drv-<n>` branch)
moves the card to Done; close a child only through that or a `LANDED:` comment. A map is
closed **by a human only**, except a map wearing `gate:auto`, which the executor closes
after the review gate passes.

---

## When a skill says "fetch the relevant ticket"

`gh issue view <n> -R sooth-os/crew-peers --comments`. Upstream workers' learnings live in
the **comments**; always fetch them.

---

## Taxonomy neutralisation rules

These override any label instruction inside a vendored skill:

- **Engineering tickets carry no readiness label.** A ticket `to-tickets` or `wayfinder`
  creates gets neither `ready-for-agent` nor `needs-triage`; this file is the "unless
  instructed otherwise". Readiness is **derived**: Status untriaged **and** every
  `blocked_by` closed. Untriaged means `Status ∉ {In Progress, Done}`, Not Started **and**
  empty; a literal `== "Not Started"` drops every freshly published ticket.
- **`wayfinder:*` labels are allowed**: `wayfinder:map` and `wayfinder:<type>`
  (`research` / `prototype` / `grilling` / `task`) name a decision's kind, not readiness.
- **Escalation labels are allowed**: `needs-info`, `ready-for-human`, on any issue.

## GTD capture layer (labels)

Heesoo's captures run the label pipeline (`needs-triage`, `unread`, `icebox`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`) on board 3, disjoint from the engineering
pipeline above. The full mapping, views, and daily flow live in
`~/sooth/shared/docs/agents/triage-labels.md`; drive it through `/triage`.

## Acceptance criteria quality bar

Every ticket's `## Acceptance` must be both:

- **Checkable**: each criterion is settled by **one command or script**'s output.
  "`bun test seat-name.test.ts` exits 0" is checkable; "works correctly" is not.
- **Exhaustive**: together the criteria are the complete definition of done.

Tick a box only once verified, via a read-modify-write on the issue body (re-read
immediately before writing) so concurrent edits survive.

## Before planning, check the latest docs

Before a skill commits to a plan, a DAG, or an API call shape, fetch the current docs for
every library / SDK / CLI it touches (Bun, the MCP SDK) through the **context7 MCP**
(`resolve-library-id` → `query-docs`).

---

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.
**`-R sooth-os/crew-peers` is mandatory on every call in this section.**

- **Map**: one issue labelled `wayfinder:map`, holding the Destination / Notes /
  Decisions-so-far / Not-yet-specified body:
  `~/sooth/shared/scripts/tracker/gh-as-bot.sh create -R sooth-os/crew-peers --label wayfinder:map --title "…" --body "…"`.
  Card it on board 3 like any issue; a map is **parent-less**.
- **Child ticket**: hung under the map via the native sub-issues endpoint
  (`POST /repos/sooth-os/crew-peers/issues/<map>/sub_issues`, `-F sub_issue_id=<child
  integer id>`, `-H "X-GitHub-Api-Version: 2026-03-10"`), labelled `wayfinder:<type>`, no
  readiness label.
- **Blocking**: native issue dependencies, by integer id:
  `gh api --method POST -H "X-GitHub-Api-Version: 2026-03-10"
  /repos/sooth-os/crew-peers/issues/<child>/dependencies/blocked_by -F issue_id=<blocker integer id>`.
  A ticket is unblocked when every blocker is **closed**
  (`issue_dependencies_summary.blocked_by` counts open blockers).
- **Frontier query**: the map's open children, minus any with an open blocker, any whose
  Status is past untriaged (`Status ∉ {In Progress, Done}` keeps it), and any with an
  assignee. First in map order wins. Enumerate children with the native endpoint below.
- **Claim**: `gh issue edit <n> -R sooth-os/crew-peers --add-assignee @me`, then move the
  card to **In Progress**. An advisory marker, not a lock: exclusivity comes from the engine.
- **Resolve**: `~/sooth/shared/scripts/tracker/gh-as-bot.sh comment <n> -R sooth-os/crew-peers --body "<answer>"`,
  then move the card to Done (or `gh issue close <n> -R sooth-os/crew-peers` off the
  board), then append a one-line gist + link to the map's *Decisions so far*. The decision
  lives in its ticket; the map only points.

### Enumerating a map's children: the fail-open trap

`--search "parent-issue:<n>"` with a bare number matches nothing and returns `[]` with
exit 0, which reads as "this map has no work". Key on the native relation:

```bash
R=sooth-os/crew-peers; MAP=<map issue number>
gh api -H "X-GitHub-Api-Version: 2026-03-10" /repos/$R/issues/$MAP/sub_issues \
  --jq '.[] | select(.state=="open") | .number'
```

If you must search, qualify it fully and make empty loud:

```bash
KIDS=$(gh issue list -R $R --state open --search "parent-issue:$R#$MAP" --jq '[.[].number]' --json number)
[ "$KIDS" = "[]" ] && { echo "HALT: map #$MAP enumerated 0 children, refusing to treat as an empty run" >&2; exit 1; }
```

---

## Deleting an issue: the `deleteIssue` named operation

**Delete is not close.** A closed issue still lists, still counts as a sub-issue, and
still satisfies a `blocked_by` edge as Done. Anything **ephemeral** (a smoke fixture, a
mis-filed duplicate, a test map) is deleted, and only issues this run created.

`deleteIssue` keys on the **GraphQL node id** (`I_kwDO…`), the mirror image of the wiring
endpoints:

| Operation | id flavour | how to capture |
|---|---|---|
| `dependencies/blocked_by`, `sub_issues` | REST integer db id | `gh api /repos/$R/issues/$N -q .id` |
| **`deleteIssue`** | **GraphQL node id** | **`gh issue view $N -R $R --json id -q .id`** |

```bash
R=sooth-os/crew-peers
N=<issue number to delete>
NODE=$(gh issue view "$N" -R "$R" --json id -q .id)
gh api graphql -f query='
  mutation($id:ID!){ deleteIssue(input:{issueId:$id}){ repository{ nameWithOwner } } }
' -F id="$NODE"
```

Delete children before the parent. Then prove residual = 0:

```bash
gh issue view "$N" -R "$R" --json number 2>&1 | grep -q 'Could not resolve' && echo "#$N deleted"
gh issue list -R "$R" --state all --search '<fixture marker, e.g. [SMOKE] in:title>' --json number,title
```

---

## Pull requests as a triage surface

**PRs as a request surface: no.** PRs here are the landing mechanism for agent work. A
worker's PR references its issue without `Closes` when a merge agent owns closing; `Closes
#n` only where the merge itself is the Done signal. Issues and PRs share one number space:
resolve a bare `#42` with `gh pr view 42`, then `gh issue view 42`.
