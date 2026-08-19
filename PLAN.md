# dsh-beads — Plan

Status: approved design, implementing. Date: 2026-08-19.

A DeepSeek Harness (dsh) plugin wrapping the literal `bd` (beads) CLI — the durable
work ledger for agents. Thesis (from design discussion): **dsh = how agents execute,
beads = what work exists**; the repo itself stays the source of truth for code
structure. Design rule: *persist what is expensive to reconstruct; derive what is
cheap.* No knowledge-graph ontology — prose notes, typed deps, bounded packets.

Reference repos: dsh clone `/home/dev/dev/deepseek-harness` (0.1.0-rc.7, built),
beads clone `/home/dev/dev/beads` (post-1.2.2 main — AHEAD of installed binary),
sibling plugin `/home/dev/dsh-consult` (the proven wrapper playbook: subprocess
spawning, bounded outputs, exit-code→domain-outcome mapping, defineTool patterns,
real-Cordis-context tests).

## Decisions (settled)

1. **One package `@aubwang/dsh-beads`, NO capability seam.** Unlike consult there is
   no plausible second provider. One plugin module registering tools directly over an
   internal DI'd CLI layer. No `ctx.beads` service key in v1; extract later if a
   consumer appears (we know how — dsh-consult seam v2).
2. **Wrap the installed binary's verified surface only** (`bd` 1.2.2). The source
   tree is ahead (no `bd sync`/`unclaim`/`heartbeat`/`--if-assignee`/`--max-rows` in
   1.2.2). Feature-probe with `bd <cmd> --help` exit codes where uncertain; never
   assume source-tree features.
3. **Real `bd` in tests, not a fake.** It's a local, fast, auth-free binary: tests
   run against a real temp workspace (`git init` + `bd init --non-interactive
   --skip-agents --skip-hooks` + pinned env). A tiny fake only if an error shape
   can't be provoked for real.
4. **Verification semantics are the one design addition**: a bead's
   `metadata.verify` (JSON array of shell commands) is enforced by `bead_close` —
   commands run via `ctx.shell` (sandbox-integrated), all must pass or the close is
   refused as a domain outcome carrying bounded failing output, and a bounded
   failure note is appended to the bead (durable record). Mechanism not policy:
   requirements live on the bead.
5. **Context packet = the `bead_start` result itself** (synchronous — no inject
   needed, unlike the reviewer's async findings): claimed issue's
   title/description/acceptance/design/notes + dependencies with status + parent +
   labels + verify requirements, all bounded. Start simple; no graph-RAG.
6. **Delegation composition stays prose-loose**: beads may reference consult job ids
   in notes/refs; no schema coupling to dsh-consult. README gets a recipe, code gets
   nothing.

## Invocation contract (from exploration, verified on 1.2.2)

Every spawn (via `ctx.subprocess`, stdin `'ignore'`):

```
env BD_NON_INTERACTIVE=1 CI=1 NO_COLOR=1 BD_NO_PAGER=1
    BD_DISABLE_METRICS=1 BD_DISABLE_EVENT_FLUSH=1 BEADS_DOLT_AUTO_START=0
    BEADS_ACTOR=<actor>          # from config/agent session
  bd -C <workspaceRoot> <cmd> ... --json
```

- **JSON parsing**: try `BD_JSON_ENVELOPE=1` → `{schema_version, data, pagination?}`;
  MUST first verify the installed 1.2.2 actually honors it (docs may be ahead). If
  not honored, legacy mode: objects carry top-level `schema_version`, arrays are
  bare. Error paths are NOT reliably JSON (verified: workspace-missing errors print
  plain text to stderr) — parse stdout as JSON, fall back to bounded stderr text.
- **Exit codes**: 0 ok · 1 generic (parse stderr for domain cases: claim conflict
  "already claimed by <who>", not-claimable, close-gated, open-children) · 2 usage ·
  10/11/12 init-safety · 130 prompt-cancel (should never happen; treat as bug).
- **Never expose**: `bd edit`, `create-form` (interactive), `-w/--watch`, unbounded
  `bd export`, `bd sql`. Always pass explicit ids (last-touched fallback is
  disabled by BD_NON_INTERACTIVE but never rely on it). Always `--limit`.
- **Single-writer**: embedded Dolt is file-locked. The plugin serializes ALL bd
  invocations per workspace through one async queue; on a lock-contention error
  shape (investigate what it looks like — provoke with two concurrent processes),
  one bounded retry with backoff, then domain outcome "workspace busy (another bd
  process?)".
- **Worktrees share one workspace** (git common dir) — document: an inherit-mode
  delegate running `bd` writes the SAME ledger live (single-writer contention with
  the host possible); confined delegates cannot run bd at all.

## Tool surface (8, model-facing)

| Tool | Backing | Notes |
|---|---|---|
| `bead_create` | `bd create --json` | title, type?, priority?, description?, acceptance?, deps? (typed: `blocks`/`discovered-from`/`related`/`parent-child` — the 4 core types only in v1), parent?, labels?, verify? (→ `--metadata '{"verify":[...]}'`) |
| `bead_ready` | `bd ready --json -n <limit>` | limit (default from config), unassigned_only?, priority?, label? |
| `bead_list` | `bd list --json -n` / `bd search --json -n` | status?, type?, label?, text? (routes to search), limit |
| `bead_show` | `bd show --json` | ids[], include_comments? (default false) |
| `bead_update` | `bd update --json` / `bd dep` for nothing — no dep changes here | id, status?, priority?, description?, acceptance?, append_note?, add_labels?, remove_labels?, assignee?, verify? (replace metadata.verify) |
| `bead_start` | `bd update <id> --claim --json`, or `bd ready --claim --json` when id omitted | returns the CONTEXT PACKET (see decision 5). Claim conflict → domain outcome naming the holder. Nothing ready → domain outcome. |
| `bead_close` | verify via `ctx.shell` then `bd close <id> -r <reason> --json` | reason required (bd's own validation wants ≥20 chars — surface that in the description); verification per decision 4; open-children/gate refusals → domain outcomes (no `--force` in v1) |
| `bead_dep` | `bd dep add/remove --json` | from, to, type (4 core types), action add/remove |

Tool descriptions encode bd's own SKILL.md guidance: link discovered work with
`discovered-from`; don't close unless the work is actually complete; notes capture
*why/decisions/failed approaches*; check ready before asking what to work on.

## Module layout

```
src/bd-cli.ts    — DI invocation layer: env template, queue/serialization, JSON
                   parse (envelope or legacy), exit/stderr → typed outcomes, bounds
src/plugin.ts    — the plugin: Config (Schemastery), preflight, tool registration
src/packet.ts    — context-packet assembly + rendering (bounded)
src/render.ts    — render() helpers, data framing
tests/           — real-bd temp workspaces; golden-corpus decoder checks (vendor a
                   minimal subset from beads' cmd/bd/protocol/testdata IF the
                   corpus matches 1.2.2 output — verify, don't assume)
```

Config: `bdPath` ('bd'), `workspaceRoot?` (default: harness cwd at load), `actor?`
(default: 'dsh:' + agent session id at call time), `listLimit` (20),
`maxOutputBytes`, `maxPacketBytes` (16 KiB), `verifyTimeoutMs` (300_000),
`writeRetryMs`. Peer deps: pnpm `link:` into the harness clone, exact 0.1.0-rc.7,
same as dsh-consult (copy its package.json/tsconfig shape).

Preflight (lazy, memoized, negative-TTL — copy dsh-consult's shape): `bd version
--json` (accept `>=1.2 <2`, record version) + `bd context --json` from
workspaceRoot; uninitialized workspace → every tool returns a domain outcome with
the remediation (`bd init` — the plugin never auto-inits; mechanism not policy).

## Non-goals (v1)

Molecules/formulas/swarm, gates, memories (`bd remember` — dsh has its own memory),
kv, federation/dolt-remote sync operations, epic management, `bd batch`, custom
dep types, auto-init, any autonomous behavior (nothing runs without a tool call).

## Verification gates

- `pnpm test` all green (real-bd workspace tests: full workflow create → ready →
  start(claim+packet) → discovered-from create → close-with-verify-refusal →
  fix → close-success; claim-conflict; lock-contention; uninitialized-workspace;
  bounds; envelope-vs-legacy parse).
- `tsc --noEmit` clean; bundle loads in the real harness (list-tools smoke, same
  pattern as dsh-consult's drill).
- gpt-5.6-sol xhigh review via `consult review`, findings fixed.
