# ccx-loop

Claude Code plugin for automated dev loops with Codex review gates.

Implement a task, get it reviewed by Codex, fix findings, repeat — then commit. All in one command.

The plugin ships four commands:

| Command | Behavior |
|---------|----------|
| `/ccx:loop`       | Run a fixed number of review-fix cycles (default 2). |
| `/ccx:forever`    | Repeat review-fix cycles until Codex approves (safety cap default 100). |
| `/ccx:plan`       | Seed (or extend with `--append`) the external `BOARD.md` task queue from a prompt or document — onboarding path for `/ccx:supervisor`. |
| `/ccx:supervisor` | Dispatch N parallel Claude↔Codex duet workers from the external `BOARD.md` (autonomous chat_ask + scope-overlap gate + squash merge + visible model ladder). |

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

**Duet mode** (`--duet`). Replaces the default single-implementer Phase 2 with a four-turn alternation: `Claude implement → Codex review → Codex implement → Claude review → ...`. Convergence fires only when two consecutive review turns from **different** reviewers approve with no rejecting or non-empty-diff turn between them, so duet runs need at least 2 cycles (parse-time error otherwise). The Claude review side spawns a sub-Claude `Agent` that runs the user-installed `code-review` skill against the worker's current diff. See `docs/supervisor-design.md` for the full state machine.

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

Takes a free-form prompt or a reference to a document the user already wrote (PRD, design note, ticket export), grounds `scope.include` globs on actual repo files, and writes task rows to `STATE_DIR/BOARD.md` as `status: draft`. The human reviews the draft, flips `draft → pending`, and then runs `/ccx:supervisor`. This is the onboarding path for the supervisor — no need to learn the BOARD YAML schema by hand.

| Flag | Description | Default |
|------|-------------|---------|
| `--from <path>` | Read a file as the planning context (PRD/design note/etc). Relative paths resolve against the repo root. | (use positional prompt) |
| `--append` | Extend an existing `BOARD.md` — new rows appended at the end of the `## Tasks` block; existing rows preserved byte-for-byte. | off (fresh seed) |

### `/ccx:supervisor` — parallel orchestrator

```
/ccx:supervisor [--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--start-tier auto|economy|default|strong|max] [--chat] [--dry-run]
```

Drives N parallel `/ccx:loop --duet` workers from `STATE_DIR/BOARD.md`, outside the repo working tree. Each task gets an external worktree under `STATE_DIR/worktrees/`, a brief file under `STATE_DIR/tasks/`, and one squash merge commit on approval. Worker `chat_ask` calls are intercepted by the broker and answered autonomously from the brief / BOARD direction / merge history when possible; ambiguous asks escalate to Discord. The supervisor prints the active model ladder before dispatch and passes the selected start tier to each duet worker. Claude runs at that start tier for the worker's lifetime; Codex can advance through the ladder by duet cycle via `--model`.

| Flag | Description | Default |
|------|-------------|---------|
| `--parallel N` | Max concurrent workers (1–10) | 3 |
| `--integration BRANCH` | Branch merges land on | current branch |
| `--max-tasks M` | Stop after M merges | unlimited |
| `--worker-loops N` | `--loops N` passed to each duet worker (2–20) | 3 |
| `--start-tier <alias>` | Override every task's starting rung: `auto \| economy \| default \| strong \| max`. `auto` uses each row's `model_start`. | `auto` |
| `--chat` | Register a supervisor session with the ccx-chat broker and post lifecycle events (dispatch, merge, block, stuck prompt, run end) to Discord | off |
| `--dry-run` | Print dispatch plan, don't commit or spawn | off |

**Model ladder.** The built-in ladder is fixed and visible, but users can replace it by writing `STATE_DIR/model-ladder.json`. The default Codex model is `gpt-5.5`; no `mini` model is used by default. Claude's selected tier is fixed at worker spawn; Codex uses the ladder per cycle.

| Alias | Claude `--model` | Claude `--effort` | Codex `--model` | Typical use |
|-------|------------------|-------------------|-----------------|-------------|
| `economy` | `sonnet` | `medium` | `gpt-5.5` | Small docs, obvious one-file fixes |
| `default` | `sonnet` | `high` | `gpt-5.5` | Normal implementation tasks |
| `strong` | `opus` | `high` | `gpt-5.5` | Cross-file logic or ambiguous design |
| `max` | `opus` | `max` | `gpt-5.5` | Hard failures, architecture, high-risk changes |

`/ccx:plan` writes `model_start: economy|default|strong|max` on each task row. The planner chooses the cheapest rung it expects can finish the task; the human can edit it before flipping `draft → pending`. `--start-tier auto` respects the row. Passing `--start-tier strong`, for example, overrides every task for that supervisor run.

Custom ladder file:

```json
{
  "default_start": "default",
  "tiers": [
    {
      "alias": "default",
      "claude": { "model": "sonnet", "effort": "high" },
      "codex": { "model": "gpt-5.5" }
    }
  ]
}
```

The supervisor rejects duplicate aliases, missing `claude.model`, missing `codex.model`, or a `default_start` that is not present in `tiers`. `model_start` values in BOARD must reference an active alias; this keeps task rows readable while letting the operator remap aliases to newer model IDs later without editing every task.

**Supervisor duet.** There is no `--duet` supervisor flag because supervisor workers always run in duet mode. The worker spawn is `/ccx:loop --duet --loops <N> --commit --chat`; `--worker-loops` therefore starts at 2 because duet convergence needs two reviewer turns.

**M8a infra notes.** Worker exit detection reads `claude agents --json` (matched by `cwd == meta.worktree_path`), and Phase P0 best-effort fast-forwards your local integration branch to `origin/<INTEGRATION>` so each worker worktree forks from a fresh upstream base. If there is no remote, the supervisor uses local HEAD.

Milestones shipped: M1 dispatch + naive merge, M2 broker supervisor adapter, M3 autonomous chat_ask answering, M4 scope-overlap gate + pre-merge dry-run, M6 `/ccx:plan` onboarding (separate command above), M8a `claude agents --json` exit detection + fresh-upstream worker base, M8b supervisor duet workers, visible/customizable duet model ladder. See `docs/supervisor-design.md` for the full design.

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
- **Duet mode** (`--duet`). Two different reviewers (Codex and Claude) must approve consecutively to terminate. Any reject by either reviewer, or any non-empty implementer diff between the two approvals, resets the convergence counter. Under `/ccx:supervisor`, Claude uses the resolved start tier for the whole worker and Codex uses the active ladder per cycle.

If Codex is not installed, implementation is preserved on disk and you're prompted to install it — no unreviewed commit.

## Where ccx state lives

The supervisor's state (BOARD, briefs, worker logs, audit JSONL) lives outside your working tree at `~/.local/share/ccx/<repo-key>/` (Linux) or `~/Library/Application Support/ccx/<repo-key>/` (macOS), with `$XDG_DATA_HOME` honoured and `$CCX_DATA_HOME` as an explicit override. `<repo-key>` is `<basename>-<sha256-7>` of `git remote get-url origin` (falls back to a hash of `realpath(REPO_ROOT)` for never-pushed repos), so two clones of the same repo share state and two unrelated repos don't collide.

Three inspection commands surface the path and contents:

- `/ccx:where` — prints the resolved `STATE_DIR` (one line, no side effects).
- `/ccx:board` — opens `STATE_DIR/BOARD.md` in `$EDITOR` (falls back to `cat`).
- `/ccx:tasks` — lists task briefs under `STATE_DIR/tasks/`, with `--status` filter.

Worker worktrees go under `STATE_DIR/worktrees/T-X/` (also outside your tree). Approved worker branches merge via `git merge --squash` into a single mainline commit; the worker's commit message is rewritten to match your repo's recent-history style before the squash lands. Worker branches and worktrees are cleaned up after merge — no `duet/T-X` ref survives.

## License

MIT
