# ccx-loop

Claude Code plugin for automated dev loops with Codex review gates.

Implement a task, get it reviewed by Codex, fix findings, repeat — then commit. All in one command.

The plugin ships four commands:

| Command | Behavior |
|---------|----------|
| `/ccx:loop`       | Run a fixed number of review-fix cycles (default 2). |
| `/ccx:forever`    | Repeat review-fix cycles until Codex approves (safety cap default 100). |
| `/ccx:plan`       | Seed (or extend with `--append`) `BOARD.md` task rows from a prompt or document — onboarding path for `/ccx:supervisor`. |
| `/ccx:supervisor` | Dispatch N parallel `/ccx:loop` workers from a shared `BOARD.md` (dispatch + autonomous chat_ask + scope-overlap gate + pre-merge squash + automatic tier escalation across a 5-rung model ladder). |

## Install

```bash
# 1. Add the marketplace
claude plugin marketplace add willysk73/ccx-loop

# 2. Install the plugin
claude plugin install ccx@ccx-loop
```

Or from inside Claude Code:

```
/plugin marketplace add willysk73/ccx-loop
/plugin install ccx@ccx-loop
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Codex](https://github.com/openai/codex) plugin (for review gates)
- Node.js ≥ 18.17 (only required if you enable the optional Discord chat bridge)

### Optional: Discord chat bridge

`/ccx:loop --chat` and `/ccx:forever --chat` mirror the run into a Discord channel — cycle summaries, stuck-finding reports, and the commit prompt are sent to chat, and your reply unblocks the loop. Multiple concurrent sessions are supported; each has a short `#id` and the bot can `!ccx sessions` / `!ccx focus <id>` / `!ccx cancel <id>` at any time.

One-time setup:

```
/ccx:chat-setup
```

This installs `discord.js` + MCP SDK into the plugin, creates `~/.claude/ccx-chat/config.json`, and smoke-tests the broker. You need a Discord bot token and the channel ID to use.

## Usage

### `/ccx:loop` — fixed N cycles

```
/ccx:loop [--loops N] [--min-severity LEVEL] [--min-confidence N] [--commit] [--duet] [--codex-first] <task>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--loops N` | Number of review-fix cycles (1–20) | 2 |
| `--min-severity LEVEL` | Ignore findings below `critical\|high\|medium\|low` | `low` (fix all) |
| `--min-confidence N` | Ignore findings with confidence < N (0.0–1.0) | `0.0` |
| `--commit` | Auto-commit on clean exit (gated) | off |
| `--duet` | Duet mode: Claude and Codex alternate as implementer, each reviewing the other's last turn. Requires `--loops >= 2`. | off |
| `--codex-first` | Flip the duet lead so Codex implements first. Only meaningful with `--duet`. | off |

**Duet mode** (`--duet`). Replaces the default single-implementer Phase 2 with a four-turn alternation: `Claude implement → Codex review → Codex implement → Claude review → ...`. Convergence fires only when two consecutive review turns from **different** reviewers approve with no rejecting or non-empty-diff turn between them, so duet runs need at least 2 cycles (parse-time error otherwise). The Claude review side spawns a sub-Claude `Agent` that runs the user-installed `code-review` skill against the worker's current diff. See `docs/supervisor-design.md` §17 for the full state machine.

### `/ccx:forever` — loop until approval

```
/ccx:forever [--max-cycles N] [--min-severity LEVEL] [--min-confidence N] [--commit] <task>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--max-cycles N` | Safety cap; loop exits on first approval anyway (1–100) | 100 |
| `--min-severity LEVEL` | Ignore findings below `critical\|high\|medium\|low` | `low` (fix all) |
| `--min-confidence N` | Ignore findings with confidence < N (0.0–1.0) | `0.0` |
| `--commit` | Auto-commit on clean approval (gated) | off |

### `/ccx:plan` — seed BOARD.md

```
/ccx:plan <prompt> | --from <path> [--append]
```

Takes a free-form prompt or a reference to a document the user already wrote (PRD, design note, ticket export), grounds `scope.include` globs on actual repo files, and writes task rows to `BOARD.md` as `status: draft`. The human reviews the draft, flips `draft → pending`, commits, and then runs `/ccx:supervisor`. This is the onboarding path for the supervisor — no need to learn the BOARD YAML schema by hand.

| Flag | Description | Default |
|------|-------------|---------|
| `--from <path>` | Read a file as the planning context (PRD/design note/etc). Relative paths resolve against the repo root. | (use positional prompt) |
| `--append` | Extend an existing `BOARD.md` — new rows appended at the end of the `## Tasks` block; existing rows preserved byte-for-byte. | off (fresh seed) |

### `/ccx:supervisor` — parallel orchestrator

```
/ccx:supervisor [--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--max-attempts N] [--start-tier <alias>] [--chat] [--dry-run]
```

Drives N parallel `/ccx:loop` workers from a shared `BOARD.md` at the repo root. Each task gets its own worktree, brief file (`.ccx/tasks/T-<id>.md`), and a squash merge commit on approval. Worker `chat_ask` calls are intercepted by the broker and answered autonomously from the brief / BOARD direction / merge history when possible; ambiguous asks escalate to Discord. When a worker exits without approval, the supervisor re-dispatches the task automatically along a fixed 5-rung model ladder — `haiku(medium) → sonnet(medium) → opus(high) → opus(xhigh) → opus(max)` — bumping one rung on `stuck` exits and retrying the same rung on `cycle-cap`, until the task merges or the `--max-attempts` budget runs out. A `stuck` exit at the top rung (`opus/max`) is the only remaining human gate.

| Flag | Description | Default |
|------|-------------|---------|
| `--parallel N` | Max concurrent workers (1–10) | 3 |
| `--integration BRANCH` | Branch merges land on | current branch |
| `--max-tasks M` | Stop after M merges | unlimited |
| `--worker-loops N` | `--loops N` passed to each worker (1–20) | 3 |
| `--max-attempts N` | Max automatic worker dispatches per task (tier bumps + same-tier retries). Exempt branch: `opus/max` stuck → human prompt. | 4 |
| `--start-tier <alias>` | First-attempt rung on the 5-rung ladder: `haiku \| sonnet \| opus \| opus-xhigh \| opus-max` | `sonnet` |
| `--chat` | Register a supervisor session with the ccx-chat broker and post lifecycle events (dispatch, merge, block, stuck prompt, run end) to Discord | off |
| `--dry-run` | Print dispatch plan, don't commit or spawn | off |

**Tier escalation.** Every worker spawn is parameterized by a rung on this fixed ladder (no config file, no per-task override):

| Rung | `--model` | `--effort` | Typical use                                            |
|------|-----------|------------|--------------------------------------------------------|
| 0    | `haiku`   | `medium`   | Docs tweaks, one-liner fixes, small mechanical changes |
| 1    | `sonnet`  | `medium`   | Default start-tier; most implementation tasks          |
| 2    | `opus`    | `high`     | First escalation for non-trivial logic work            |
| 3    | `opus`    | `xhigh`    | Second escalation when opus/high could not finish      |
| 4    | `opus`    | `max`      | Terminal rung — nothing higher to escalate to          |

Motion on the ladder is driven by the worker's exit:

- `stuck` (same Codex finding across 3 consecutive cycles) → **one rung up**, `attempts++`, re-dispatch. At rung 4 (`opus/max`), `stuck` falls through to an `AskUserQuestion` human prompt — the only remaining manual gate, exempt from `--max-attempts`.
- `cycle-cap` (`--worker-loops` exhausted without stuck firing) → **same rung**, `attempts++`, re-dispatch until `attempts >= --max-attempts`, then block as `attempts-exhausted`.
- `approved` → merge, no re-dispatch.

`--start-tier` chooses the first rung; lower rungs are unreachable for that run. The default `--max-attempts 4` exactly covers a pure stuck climb from `sonnet` → `opus/high` → `opus/xhigh` → `opus/max`, so the top-rung human prompt is reachable without raising the budget. `--start-tier haiku` needs at least `--max-attempts 5` to walk all five rungs on stuck exits.

**Duet mode for supervisor tasks.** There is no `--duet` supervisor flag — the choice is per-task, declared in the brief frontmatter at `.ccx/tasks/T-<id>.md`. Add `loop_flags: ["--duet"]` (and optionally `"--codex-first"`) to the brief YAML; the supervisor preserves the field across regenerations and re-dispatches and forwards the listed flags verbatim to each `/ccx:loop` spawn. Only `--duet` and `--codex-first` are on the allowlist; anything else blocks the task as `loop-flags-rejected`. Requires `--worker-loops >= 2` (the duet convergence rule needs at least two review turns).

**M8a infra notes.** Worker exit detection now reads `claude agents --json` (matched by `cwd == meta.worktree_path`) instead of `BashOutput`-on-`shell_id` polling, and Phase P0 best-effort fast-forwards your local integration branch to `origin/<INTEGRATION>` so each worker worktree forks from a fresh upstream base. Both have documented fallbacks (legacy `BashOutput`, local HEAD) so older Claude Code versions and purely-local repos degrade cleanly.

Milestones shipped: M1 dispatch + naive merge, M2 broker supervisor adapter, M3 autonomous chat_ask answering, M4 scope-overlap gate + pre-merge dry-run, M5 stuck-exit auto-revise + re-dispatch, M6 `/ccx:plan` onboarding (separate command above), M7 automatic model tier escalation, M8a `claude agents --json` exit detection + fresh-upstream worker base, M8b per-brief duet passthrough. See `docs/supervisor-design.md` for the full design.

### Examples

```bash
# Basic: implement + 2 review cycles + ask to commit
/ccx:loop Add user login with JWT authentication

# 3 review cycles
/ccx:loop --loops 3 Fix pagination bug in /api/users endpoint

# Loop until Codex approves
/ccx:forever Refactor database queries to use connection pooling

# Loop until approved, only fix medium+ findings, auto-commit on success
/ccx:forever --min-severity medium --commit Tighten input validation

# 1 cycle + auto-commit
/ccx:loop --loops 1 --commit Update error messages in validation middleware

# Duet mode: Claude and Codex alternate as implementer (needs --loops >= 2)
/ccx:loop --duet Refactor the rate limiter to use a sliding window
```

## How it works

```
Phase 0: Pre-check (dirty working tree? parse PRE_LOOP_PATHS)
    ↓
Phase 1: Implement the task (+ test gate)
    ↓
Phase 2: Review loop
    ┌─→ Codex review (JSON verdict)
    │       ↓
    │   Stuck-finding check (same finding × 3 cycles → stop)
    │       ↓
    │   Fix in-scope findings (with fix verification)
    │       ↓
    └── Exit or next cycle
    ↓
Phase 3: Update .handoff.md (if exists)
    ↓
Phase 4: Commit (gated — unresolved / test failure / cap-hit / stuck-exit block auto-commit)
```

### Key behaviors

- **One-approval exit.** `/ccx:loop` exits as soon as Codex approves (no pointless re-review of unchanged code). `/ccx:forever` exits on first approval too.
- **Severity & confidence filtering.** Skip low-value findings to reduce cycles. Skipped findings are logged.
- **Stuck-finding detection.** If the same finding (keyed by `(file, title, body)`, line-agnostic) reappears three cycles in a row, the loop stops — further cycles are unlikely to converge.
- **Fix verification.** Edit/Write failures are surfaced as `unresolved`, never silently absorbed.
- **Auto-commit gate.** `--commit` only fires when the loop exited cleanly (approved/filtered-clean), tests pass, and no findings are unresolved. Otherwise it downgrades to an interactive prompt.
- **Explicit staging.** Only files the loop intentionally edits (Edit/Write + intentional Bash ops like `mv`, `rm`, formatters) are staged. Generated artifacts like coverage output never slip in.
- **Dirty-tree handling.** Pre-existing uncommitted changes are parsed via `git status -z` and handled explicitly. A hunk-granularity caveat is documented: if Claude edits a file that was already dirty, the user's prior hunks will be committed too (stash to avoid).
- **Duet mode** (`--duet`). Two different reviewers (Codex and Claude) must approve consecutively to terminate. Any reject by either reviewer, or any non-empty implementer diff between the two approvals, resets the convergence counter. The Claude side of the ladder uses the M7 tier escalation when run under `/ccx:supervisor`; Codex stays at its default model.

If Codex is not installed, implementation is preserved on disk and you're prompted to install it — no unreviewed commit.

## Customer mode

ccx is invisible by default in any repo you point it at — the tool's state, briefs, worker logs, and audit history live OUTSIDE the user's working tree, and ccx-flavored commit subjects / merge commits / branch refs are blocked by a verifier before they can land on mainline. The contract is six invariants enforced mechanically:

1. The user's working tree contains no `.ccx/` directory or other ccx-owned files.
2. The user's `.gitignore` (committed) contains no ccx-related entries.
3. No commit subject or body on worker branches or new integration commits contains ccx tooling markers (`T-N:` prefix, `[T-N]`, standalone `T-N`, `supervisor:` subjects, `ccx/` branch markers). Single exception: opt-in Git trailer `Ccx-Task: T-N` when `git config --local ccx.commit.trailer true`.
4. Mainline commits contain no merge commit subject `Merge branch 'ccx/...'`. Default merge strategy is squash; `merge` is gated behind `ccx.dogfood = true`.
5. After a worker finishes, no `ccx/T-X` branch ref remains.
6. The user's `.claude/`, `CLAUDE.md`, `.claude/settings.json`, `AGENTS.md` files are untouched unless explicitly opted in.

`/ccx:verify` runs the six checks against your repo on demand; the `/ccx:supervisor` invokes the same script automatically as a pre-merge gate so a worker that regresses past T-3's commit-hygiene retry budget is caught before its commit lands on integration.

### Where ccx state lives

Resolved by [`plugins/ccx/commands/supervisor.md`](plugins/ccx/commands/supervisor.md)'s "State path resolver" (full algorithm in [`docs/supervisor-design.md`](docs/supervisor-design.md) §18.2). First match wins:

1. `$CCX_DATA_HOME` env var if set → that path verbatim (no `<repo-key>` suffix). Operator escape hatch for tests and shared state roots.
2. `git config --local ccx.dogfood true` → `<REPO_ROOT>/.ccx/` (dogfood mode — used by this repo only; the ccx narrative IS the product).
3. `$XDG_DATA_HOME/ccx/<repo-key>/` if `$XDG_DATA_HOME` is set.
4. Platform default: `~/.local/share/ccx/<repo-key>/` (Linux) or `~/Library/Application Support/ccx/<repo-key>/` (macOS).

`<repo-key>` is `<basename>-<sha256-7>` of `git remote get-url origin` (or the first remote, or a hash of `realpath(REPO_ROOT)` with a `-local-` infix for never-pushed repos). `/ccx:link --name <readable>` overrides the auto-derived key per-repo.

### Inspecting state

Five slash commands surface the otherwise-invisible state directory and the readable alias:

- `/ccx:where` — prints the resolved `STATE_DIR` for the current repo.
- `/ccx:board` — opens `STATE_DIR/BOARD.md` in `$EDITOR` (falls back to `cat`).
- `/ccx:tasks` — lists task briefs under `STATE_DIR/tasks/`.
- `/ccx:link --name <readable>` / `/ccx:unlink` — manage a per-repo readable override that replaces `<basename>-<sha256-7>`.
- `/ccx:verify` — runs the six M9 invariant checks against the current repo. Exit 0 = clean; non-zero = leak (codes 10..15 map 1:1 to invariants 1..6).

### Override env vars

| Variable | Effect |
|---|---|
| `CCX_DATA_HOME` | Force `STATE_DIR` verbatim (no `<repo-key>` suffix). Use for test isolation. |
| `XDG_DATA_HOME` | Standard XDG redirection — picks the base directory for the customer-mode `<repo-key>` subtree. |
| `CCX_PROTECTED_OPTIN` | When `=1`, lets `ccx verify` accept a diff that touches `.claude/`, `CLAUDE.md`, or `AGENTS.md`. Per-invocation only — there is no persistent `git config` knob, so the opt-in cannot silently disable invariant 6 across an operator's machine. |

### The `ccx.dogfood` flag

Set with `git config --local ccx.dogfood true` per-repo. Effect:

- `STATE_DIR` short-circuits to `<REPO_ROOT>/.ccx/` (state lives in the working tree).
- T-3's commit-hygiene pipeline is bypassed; `supervisor:` / `T-N:` commit subjects are retained.
- `ccx.merge.strategy = merge` becomes legal (otherwise STOPped at config-load time).
- `ccx verify` accepts `.ccx/` + `.ccx-config` as legitimate (invariants 1, 2, 3, 4 degrade to no-ops; invariant 5 stale-branch hygiene still fires). Invariant 6 is **independent** of dogfood — even dogfood runs need `CCX_PROTECTED_OPTIN=1` to edit `.claude/`, `CLAUDE.md`, or `AGENTS.md`. The per-invocation env-var gate is deliberate (no persistent `git config` knob to misconfigure into accidentally allowing all protected-path edits).

Customer repos should never set this. The flag is read `--local` only — no global or system inheritance — so a `ccx.dogfood = true` on one repo cannot leak into another on the same machine.

### `ccx migrate` — for repos with a committed `.ccx/`

If you adopted ccx before M9 shipped and have a `.ccx/` directory in your worktree (with `BOARD.md`, briefs, worker logs, audit JSONL), the customer-mode promise is restored in a few steps.

**Resolve the destination first.** Future `/ccx:supervisor` runs resolve `STATE_DIR` via the algorithm in the "Where ccx state lives" section above. The customer-mode shape is `<base>/<repo-key>` where `<repo-key> = <basename>-<sha256-7>(remote-url)`. Do NOT eyeball with `$(basename "$(pwd)")` — the hash suffix matters; without it your migrated state lands at a path the next resolver call cannot find.

Two ways to learn the destination:

1. **Inside Claude Code**, run the slash command `/ccx:where`. It prints one line — the absolute `STATE_DIR/` for the current repo. Copy that line.
2. **From your terminal**, run the shell-level resolver below. (It mirrors `/ccx:where`'s logic verbatim.)

```bash
# Shell-level STATE_DIR resolver — mirrors /ccx:where. Run from inside your
# repo; emits the absolute STATE_DIR with a trailing /.
ccx_where() {
  set -eu
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  DOGFOOD="$(git config --local --get --type=bool ccx.dogfood 2>/dev/null || echo false)"
  LINK="$(git config --local --get ccx.link 2>/dev/null || true)"
  sha7() {
    if command -v sha256sum >/dev/null 2>&1; then
      printf '%s' "$1" | sha256sum | cut -c1-7
    else
      printf '%s' "$1" | shasum -a 256 | cut -c1-7
    fi
  }
  if [ -n "${CCX_DATA_HOME:-}" ]; then
    printf '%s/\n' "${CCX_DATA_HOME%/}"; return
  fi
  if [ "$DOGFOOD" = "true" ]; then
    printf '%s/\n' "${REPO_ROOT%/}/.ccx"; return
  fi
  if [ -n "$LINK" ]; then
    KEY="$LINK"
  else
    BN="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
    URL="$(git remote get-url origin 2>/dev/null || true)"
    if [ -z "$URL" ]; then
      FIRST_REMOTE="$(git remote 2>/dev/null | head -n1)"
      [ -n "$FIRST_REMOTE" ] && URL="$(git remote get-url "$FIRST_REMOTE" 2>/dev/null || true)"
    fi
    if [ -n "$URL" ]; then
      KEY="${BN}-$(sha7 "$URL")"
    else
      KEY="${BN}-local-$(sha7 "$(cd "$REPO_ROOT" && pwd -P)")"
    fi
  fi
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    BASE="${XDG_DATA_HOME%/}/ccx"
  else
    case "$(uname -s)" in
      Darwin) BASE="$HOME/Library/Application Support/ccx" ;;
      *)      BASE="$HOME/.local/share/ccx" ;;
    esac
  fi
  printf '%s/%s/\n' "$BASE" "$KEY"
}
DEST="$(ccx_where)"  # e.g. /home/you/.local/share/ccx/myproject-a3f9b2c/
echo "STATE_DIR resolves to: $DEST"
```

If you want a more readable directory name (e.g. `myproject` instead of `myproject-a3f9b2c`), run `/ccx:link --name myproject` first; then re-run `ccx_where` (or `/ccx:where`) to pick up the alias.

**Case A: `.ccx/` is committed to your repo's history.**

```bash
# Use the $DEST resolved above (either by running /ccx:where in Claude and
# pasting its output, or by sourcing the ccx_where shell function).
mkdir -p "$DEST"

# 1. Move every state file to the canonical destination.
mv .ccx/* "$DEST/"
rmdir .ccx  # should now be empty

# 2. Stop tracking .ccx/. The original copies are already gone (step 1);
#    this only drops the entries from Git's index.
git rm -r --cached .ccx/

# 3. Do NOT add `.ccx/` to `.gitignore`. The line is itself a ccx footprint
#    and invariant 2 forbids it in customer mode. The directory should
#    simply not exist locally anymore.

# 4. Commit the cleanup with a natural commit message — NO `ccx:` prefix
#    per the M9 commit-hygiene policy.
git commit -m "chore: remove vestigial state directory"
```

After step 4, `/ccx:verify` should exit 0 and `/ccx:supervisor` will read its state from `$DEST` on the next run.

**Case B: `.ccx/` exists only locally (never committed).**

```bash
mkdir -p "$DEST"
mv .ccx/* "$DEST/"
rmdir .ccx
```

No commit needed — `.ccx/` was never tracked. `/ccx:verify` should exit 0 once the directory is gone. If your `.gitignore` mentions `.ccx`, drop that line too (invariant 2).

## License

MIT
