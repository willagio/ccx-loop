---
description: "Orchestrate N parallel /ccx:loop --duet workers from BOARD.md — dispatch + autonomous chat_ask + scope-overlap gate + squash merge + visible Claude/Codex model ladder + optional Discord presence"
argument-hint: "[--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--worker-mode duet|conductor] [--start-tier auto|economy|default|strong|max] [--chat] [--dry-run]"
allowed-tools: Bash, BashOutput, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, mcp__ccx-chat__chat_register, mcp__ccx-chat__chat_send, mcp__ccx-chat__chat_set_phase, mcp__ccx-chat__chat_close, mcp__ccx-chat__chat_supervisor_poll, mcp__ccx-chat__chat_supervisor_reply, mcp__ccx-chat__chat_supervisor_escalate, mcp__ccx-chat__chat_supervisor_close, mcp__ccx-chat__chat_supervisor_recent_closures
---

# /ccx:supervisor — Parallel Worker Orchestrator

One human drives N parallel `/ccx:loop --duet` workers from `STATE_DIR/BOARD.md`. Each task runs in its own external git worktree, gets its own external brief file, and merges back into the integration branch on approval. Worker `chat_ask` calls are intercepted by the broker; the supervisor session answers from the brief / BOARD / merge history when possible, escalating to Discord only when no deterministic answer fits. Tasks whose scope globs touch overlapping files are serialized at dispatch time so concurrent worktrees do not produce conflicting merges. Approved workers always land through `git merge --squash` followed by `git commit -F` with the worker's final commit message. Post-merge cleanup removes the worker's worktree and deletes the `duet/<task_id>` branch on the merged exit; blocked exits preserve the branch for human triage. The supervisor loads and prints a visible Claude/Codex model ladder before dispatch, resolves each task's `model_start` alias, and passes the active ladder to the duet worker. Claude runs at the resolved start tier for the worker lifetime; Codex can advance through the ladder by duet cycle via `--model`.

Raw arguments: `$ARGUMENTS`

**Milestones shipped** (see `docs/supervisor-design.md`):

- **M1 — dispatch.** `BOARD.md` → briefs → `claude -p` workers → naive merge (originally `--no-ff`; switched to `--squash` in pre-M6 — see Step B step 3) → batch BOARD update.
- **M2 — broker supervisor adapter.** `backend: "supervisor"` in `~/.claude/ccx-chat/config.json` queues worker asks in the broker and exposes `chat_supervisor_{poll,reply,escalate,close}` MCP tools, with a per-ask auto-escalate timer as the no-supervisor-session fallback.
- **M3 — autonomous answering.** `/ccx:supervisor` polls the broker's supervisor queue every scheduling iteration. For each pending ask it consults the task brief's `## Decisions` table, BOARD `## Direction`, and the integration branch's merge-commit history. A confident deterministic match → `chat_supervisor_reply`; otherwise → `chat_supervisor_escalate` (human answers on Discord). Every supervisor decision is appended as JSONL to `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can audit after the fact.
- **M4 — scope-overlap gate + pre-merge dry-run.** Step A defers any pending task whose `scope.include` matches a tracked file already claimed by a `RUNNING` task — overlap is computed by intersecting the two `git ls-files -- <pathspecs>` results plus a literal-glob equality fallback for globs that match no current files. Deferred tasks stay in `PENDING_POOL` and are retried next iteration when slots free; nothing is marked `blocked`. Step B's merge stages the integration branch via `git merge --squash --no-edit` (pre-M6 — originally `git merge --no-commit --no-ff --no-edit`), inspects unmerged paths via `git ls-files -u`, and either finalizes with a supervisor-authored `T-<id>: <title>` commit (clean) or rolls back via `git restore --staged --worktree .` (conflict) — separating conflict detection from commit creation.
- **Worker no-commit recovery.** The broker records every worker `chat_close` status in an in-memory ring buffer (`chat_supervisor_recent_closures` MCP tool); Step B queries it after a `no-commit` classification to distinguish `stuck` from `budget-exhausted` and block with a precise reason. Codex model strengthening is handled inside `/ccx:loop --duet` by the active ladder, not by supervisor re-dispatch.
- **Model ladder — visible and customizable.** The built-in ladder is `economy → default → strong → max`, mapping each alias to Claude and Codex model settings. The default Codex model is `gpt-5.5`. Users may override the mapping with `STATE_DIR/model-ladder.json`; task rows choose aliases via `model_start`, not raw model ids.
- **M8a — supervisor infra refresh.** Worker exit detection reads `claude agents --json` (matched by `cwd == meta.worktree_path`), and Phase P0 step 3a best-effort fast-forwards local integration to its `origin/<INTEGRATION>` tip so every worker worktree forks from a fresh upstream base. If there is no remote, the supervisor uses local HEAD.
- **M8b — supervisor duet workers.** Supervisor-launched workers default to `/ccx:loop --duet`; duet is the M8b product contract and remains the default for supervised work. M10 (next bullet) introduces a parallel `--conductor` path selectable via the run-level `--worker-mode` flag or a per-task BOARD `worker_mode` override — both shape the same dispatch surface; nothing about M8b is removed by that addition. BOARD schema and `/ccx:plan` are otherwise unchanged. See `docs/supervisor-design.md`.
- **M9 T-4 — squash merge + branch cleanup.** Step B step 3 always uses squash merge with the worker's final commit message as the squash subject. Step B step 5 adds an unconditional `git branch -D duet/<task_id>` after the worktree-remove on the merged exit only, with stderr-captured verification surfacing failures via a dedicated `STATE_DIR/supervisor-branch-residue-<RUN_ID>.txt` sidecar.
- **M9 T-5 — inspection surface.** Three new top-level slash commands surface the otherwise-invisible `STATE_DIR` to humans: `/ccx:where` prints the resolved path; `/ccx:board` opens `STATE_DIR/BOARD.md` in `$EDITOR` (falls back to `cat`); `/ccx:tasks` lists `STATE_DIR/tasks/T-*.md` with `--status` filter. See `docs/supervisor-design.md`
- **M10 — Conductor Mode (in-flight).** The duet worker can be swapped for a thin `claude -p` conductor that delegates each implement and review turn to a fresh sub-process, bounding per-worker context growth and letting Claude's tier move adaptively per cycle. Selected per run via `--worker-mode {duet,conductor}` (default `duet` during incubation) and overridable per task via the BOARD row's optional `worker_mode` field. Duet remains the default and the two modes coexist behind mutually-exclusive flags. SSOT: `docs/supervisor-design.md` §"Conductor Mode (M10 — proposed)".

Still deferred:

- Supervisor-session resume after close (stretch).

SSOT for all design decisions: `docs/supervisor-design.md`. Read it before editing this command.

---

## Argument Parsing

- `--parallel N` — max concurrent workers. Default: `3`. Clamp `1..10`.
- `--integration BRANCH` — branch merges land on. Default: the supervisor's current branch. Must exist locally.
- `--max-tasks M` — stop accepting new dispatches after M successful merges. Currently-running workers still complete. Default: unlimited.
- `--worker-loops N` — value forwarded to each worker as `/ccx:loop --<worker-mode> --loops N` (the per-worker cycle cap, where `<worker-mode>` is the resolved per-task mode substituted as the bare literal `duet` or `conductor` — the surrounding `--<worker-mode>` template renders as `--duet` or `--conductor`, never `----duet`). Default: `3`. Must be a positive integer in `2..100`; values outside that range are rejected at argument-parse time (see "Validation and defaults" below — do NOT silently clamp). `/ccx:loop` is used instead of `/ccx:forever` so every worker has a natural token cap. The model ladder advances inside this cycle budget.
- `--worker-mode <duet|conductor>` — run-level worker mode forwarded to each dispatched worker as the corresponding `/ccx:loop` flag (`--duet` or `--conductor`). Default: `duet` during M10 incubation. The two flags are mutually exclusive at the worker side; supervisor picks exactly one per dispatched task per the resolution order described below. Individual tasks may override this via their BOARD row's optional `worker_mode` field (see Phase P1 step 2). Conductor mode is the M10 in-flight design from `docs/supervisor-design.md` §"Conductor Mode (M10 — proposed)".
- `--start-tier <auto|economy|default|strong|max>` — run-level start-tier override. Default: `auto`. With `auto`, each task uses its `model_start` BOARD field; missing or `auto` falls back to the active ladder's `default_start`. With any explicit alias, every dispatched task starts from that alias for this run. The alias must exist in the active ladder loaded from `STATE_DIR/model-ladder.json` or the built-in ladder.
- `--chat` — pre-M6. Register the supervisor session with the `ccx-chat` broker and post lifecycle messages (run start, dispatch, merge, block, stuck prompt, run end) to Discord as fire-and-forget `chat_send` calls. The supervisor never calls `chat_ask` under `--chat` — nothing should queue from the supervisor side; every `AskUserQuestion` stays local. Requires one-time `/ccx:chat-setup`; degrades gracefully if the broker is unreachable (log once, continue without chat). See Phase P0.5.
- `--max-worker-budget-usd AMOUNT` — optional run-level per-worker spend cap in US dollars. When set, forwarded verbatim into every dispatched worker's `claude -p` spawn as `--max-budget-usd AMOUNT` (see §P2 Step A step 4's spawn template). Default: unset — no cap, current behavior. See "Design note — --max-worker-budget-usd placement" below for why this landed as a supervisor flag rather than a ladder field or a `STATE_DIR` config knob. **Known limitation — conductor mode:** the cap is enforced by the CLI on the exact process it is passed to. Under `--worker-mode duet` that outer `claude -p` process runs the whole worker, so the cap bounds the worker's total spend. Under `--worker-mode conductor`, that outer process is a thin conductor that delegates each implement/review turn to a fresh child `claude -p` sub-process (`docs/supervisor-design.md` §"Conductor Mode"); this flag does NOT propagate to those children (their spawn is owned by `/ccx:loop`'s Phase 2-Conductor in `loop.md`, out of scope for this change), so today it only caps the conductor's own light-weight orchestration spend, not the delegated turns that do the expensive work. Forwarding the cap into conductor sub-process spawns is follow-up work for whichever task next touches `loop.md`'s conductor contract.
- `--dry-run` — parse `BOARD.md`, print the dispatch plan, then exit without writing briefs, committing, or spawning workers.

**Validation and defaults** — at argument-parse time, reject the run with a non-zero exit and a precise error message when:

- `--worker-loops` is not a positive integer in `2..100`: `--worker-loops must be a positive integer between 2 and 100 (got: "<value>")`. The lower bound comes from duet convergence; the 100-cap mirrors `/ccx:loop`'s own `--loops` clamp.
- `--start-tier` is not `auto` and is not an alias in the active ladder: `--start-tier must be auto or one of <aliases> (got: "<value>")`. Do not attempt fuzzy matching; a typo in a ladder alias would silently pick the wrong tier and nothing later would catch it.
- `--worker-mode` is not exactly `duet` or `conductor` (case-sensitive): `--worker-mode must be one of: duet | conductor (got: "<value>")`. Error shape mirrors `--start-tier` so the operator sees one consistent invalid-flag pattern across the command. Do not coerce or fuzzy-match aliases like `Duet`, `CONDUCTOR`, or `conduct`; a silent coercion would let a misspelling fall through to the wrong worker mode and the operator would not know which one actually ran.
- `--max-worker-budget-usd` is present and is not a positive decimal number: `--max-worker-budget-usd must be a positive number (got: "<value>")`. Accepts plain integers and decimals (`5`, `2.50`); rejects zero, negative, and non-numeric values. Failing fast here surfaces a typo before any worker spawns, rather than after the first `claude -p` process rejects its own `--max-budget-usd` argument.

Defaults (`--worker-loops 3`, `--worker-mode duet`, `--start-tier auto`, `--max-worker-budget-usd` unset) are chosen so that running `/ccx:supervisor` with no flags keeps the M8b duet contract while M10 conductor mode incubates.

No free-form task description — the supervisor drives entirely from `BOARD.md`. If positional text is supplied, log a warning and ignore it.

### Design note — `--max-worker-budget-usd` placement (T-9)

Three homes were considered for the per-worker spend cap:

1. **A ladder field** (e.g. `tiers[].claude.maxBudgetUsd`) — rejected. Spend tolerance is orthogonal to model strength: a `strong`-tier task on a tight budget and an `economy`-tier task with room to spend are both plausible, so coupling the cap to the ladder would force spurious per-tier duplication of the same number.
2. **A `STATE_DIR` config knob** (e.g. a new `STATE_DIR/budget.json`) — rejected. That would add a second piece of durable state the operator has to remember exists and keep in sync, for a value that is really a per-invocation operational decision, not a durable cross-run setting.
3. **A supervisor CLI flag**, mirroring `--worker-loops` — **chosen**. The cap shares `--worker-loops`'s lifecycle (a per-run decision, applies uniformly to every dispatched worker in the run, needs no persistence beyond the run) and needs no new file or schema.

This is provisional pending human review. If per-task budget overrides turn out to be necessary, a future BOARD `max_budget_usd` row field (mirroring `model_start`) is the natural next step — not in scope here.

Also provisional: full conductor-mode coverage (propagating the cap into `loop.md`'s Phase 2-Conductor child sub-process spawns) is out of scope for this change — see the "Known limitation — conductor mode" note on the flag above.

---

## Guardrails

- The supervisor MUST NOT push, force-push, amend published commits, or `git reset --hard` anything. `git branch -D` is permitted ONLY for supervisor-owned worker branches matching the pattern `duet/<task_id>` in Step A spawn-error cleanup and Step B merged-exit cleanup. Any other branch deletion is forbidden.
- Every `claude -p` worker spawn MUST use `Bash(run_in_background=true)` so the supervisor keeps control. Synchronous spawns would block the whole scheduling loop.
- Worker log files land at `STATE_DIR/workers/<TASK_ID>.log`; the directory MUST exist before any spawn.
- The supervisor MUST NOT mark a task `merged` in `BOARD.md` without first verifying the merge actually moved `HEAD` on the integration branch (`git rev-parse HEAD` changed).
- `BOARD.md` writes are **read → modify → write** — never append-only, never via `sed`, never `git add -A`.
- Briefs are supervisor-owned. Workers MUST NOT edit `STATE_DIR/tasks/*.md` or `BOARD.md`; the dispatch prompt states this and the supervisor does not re-read briefs from worktrees after dispatch.
- Every M3 supervisor decision (autonomous reply or escalation — close is not used by M3; see Step B2 step c) MUST be appended to `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` immediately after the broker tool call returns — logging AFTER the call captures the real broker outcome (`ok: true` vs `ok: false` when the ask was already resolved by the auto-escalate timer or session cancel). An in-memory decision the human cannot audit defeats the point of M3.
- The supervisor MUST NOT `chat_supervisor_reply` with information it could not itself cite back to a brief decision / BOARD direction / merge commit. "Best guess from general reasoning" is NEVER a confident match — escalate instead. Autonomous answering is an optimization, not a replacement for the human judgement call.

---

## State path resolver (`STATE_DIR`)

All supervisor state — `BOARD.md`, per-task briefs, worker logs, M3 audit JSONL, M4 recovery sidecars — lives under a single `STATE_DIR` resolved once at the top of Phase P0 and used unchanged for the rest of the run. **The resolver is the SOLE source of state paths in this command file.** SSOT for the design: `docs/supervisor-design.md`.

**Resolution algorithm** (first match wins; evaluate top-to-bottom):

1. **`$CCX_DATA_HOME` override.** If the env var is set and non-empty, use it with NO `<repo-key>` suffix. **Normalize to an absolute path first** with a POSIX-portable shell prefix (no GNU-only tools like `realpath -m` or `readlink -f` — those break on stock macOS BSD utilities and on Alpine/busybox):
   ```sh
   case "$CCX_DATA_HOME" in
     /*) STATE_DIR="$CCX_DATA_HOME" ;;          # already absolute
     *)  STATE_DIR="$PWD/$CCX_DATA_HOME" ;;     # prepend cwd to relative override
   esac
   STATE_DIR="${STATE_DIR%/}"                    # strip ONE trailing slash if present
   ```
   The shell-only logic works whether or not the directory exists yet (no stat involved), so a fresh `CCX_DATA_HOME=/tmp/ccx-test-<run-id>` works on first use. Operator-level escape hatch — useful for tests and for users who want a single shared state root; the normalization is invisible when the operator already supplied an absolute path.
2. **`$XDG_DATA_HOME`.** If set and non-empty → `STATE_DIR = $XDG_DATA_HOME/ccx/<repo-key>/`.
3. **Platform default.** Linux → `STATE_DIR = ~/.local/share/ccx/<repo-key>/`. macOS (`uname -s` returns `Darwin`) → `STATE_DIR = ~/Library/Application Support/ccx/<repo-key>/`. Windows is out of scope for M9.

**`<repo-key>` derivation** (deterministic; same value across fresh clones of the same remote URL so a contributor on machine A and a contributor on machine B operating on the same upstream resolve to the same `STATE_DIR` modulo `$HOME`):

1. If `git remote get-url origin` exits 0 and returns a non-empty URL → `<repo-key> = <basename>-<sha256-7>` where the SHA-256 hash is computed over the URL string (raw bytes, no trailing newline, no normalization) and truncated to its first 7 hex chars. `<basename>` is the `basename` of `REPO_ROOT` lowercased. Example: `my-project-a3f9b2c`.
2. Else if `git remote` lists at least one remote → use the URL of the first remote in `git remote`'s output order, same `<basename>-<sha256-7>` shape. Documented in `docs/supervisor-design.md` so a fork with `upstream` set but `origin` missing still produces a stable key.
3. Else (no remotes — purely-local repo) → `<repo-key> = <basename>-local-<sha256-7>` where the hash is over `realpath(REPO_ROOT)`. The `-local-` infix is load-bearing: it distinguishes local-only entries from remote-keyed ones when a human lists `$XDG_DATA_HOME/ccx/`, and it makes it obvious that two local clones at different paths produce two distinct state directories (correct behaviour — they're different worktrees).

The 7-char truncation matches Git's short-SHA convention and keeps the directory name readable. Collision risk on truncation is acceptable: a collision between two unrelated repos sharing a `<basename>` only occurs when the SHA-256 also collides on the first 7 hex chars (~1 in 268M); the failure mode is two repos' state co-located in one directory, which surfaces immediately as confused board state and is recoverable by setting `$CCX_DATA_HOME` per-repo.

**First-access side effects.** On first resolution per run, `mkdir -p` the following four paths and emit ONE line to stderr — `ccx state: <STATE_DIR>` — so the operator sees where state landed without an interactive prompt (survives non-TTY contexts where workers spawn the supervisor under `claude -p`):

- `STATE_DIR/` itself
- `STATE_DIR/tasks/` (per-task briefs)
- `STATE_DIR/workers/` (worker log files)
- `STATE_DIR/supervisor-audit/` (M3 audit JSONL, per-run)

`STATE_DIR/BOARD.md` and `STATE_DIR/supervisor-recovery-*.txt` are NOT pre-created — their absence is a meaningful signal (no BOARD seeded → `/ccx:plan` not run; no recovery sidecar → no failed batch commit) and the later phases that write them call `Write` directly.

The stderr line is fire-and-forget: it must not crash the run on a closed-fd stderr. Log it exactly once per supervisor run, even when later phases re-reference `STATE_DIR` — the resolver is not re-invoked, and a second log line would be noise.

**Authority for state path construction.** Every `Read`, `Write`, `Edit`, `Glob`, and `Bash` invocation in this file MUST construct state paths by joining `STATE_DIR` with a subdirectory + filename. Path examples that follow this contract:

- BOARD: `STATE_DIR/BOARD.md`
- Brief: `STATE_DIR/tasks/<task_id>.md`
- Worker log: `STATE_DIR/workers/<task_id>.log`
- Audit JSONL: `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`
- Recovery sidecar: `STATE_DIR/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt`

The absolute path of, e.g., a worker log is `~/.local/share/ccx/<repo-key>/workers/T-<id>.log` — outside the working tree, so `git status` stays clean.

**The dispatch prompt path passed to workers.** §P2.1's brief is written to `STATE_DIR/tasks/<TASK.id>.md`, and §P2.2's `<task_brief path="...">` attribute carries the **same absolute path the supervisor used**. Workers never see a ccx-owned directory in their worktree; passing a worktree-relative path would fail the worker's `Read` call.

**No supervisor-authored commits on the integration branch.** The supervisor never `git add`s or `git commit`s STATE_DIR files: they live outside the working tree, so `git add` would reject the path. Step A's brief write, Step A's `assigned` BOARD update, and Step D's batch BOARD update are all in-place writes to `STATE_DIR` only — no staging, no commit. The integration branch carries product commits (worker merges) only.

---

## Worktree path resolver (`<worktree_path>`, `<task_key>`)

The supervisor creates every worker checkout at `<STATE_DIR>/worktrees/<task_id>/` so a user listing their parent directory sees no `*-T-<id>` siblings. SSOT for the design: `docs/supervisor-design.md`.

**The resolver is the SOLE source of worker worktree paths in this command file.** Every later step that references the worker's checkout substitutes `<worktree_path>` (the absolute filesystem path) and `<task_key>` (the basename, which Git also uses for the `.git/worktrees/<task_key>/` metadata directory).

**Resolution** (per task): `<task_key> = <task_id>`, `<worktree_path> = <STATE_DIR>/worktrees/<task_id>`. Readable name keeps `$STATE_DIR` introspection (`ls $STATE_DIR/worktrees/`) immediately legible.

**Per-task caching.** The resolver MUST be called exactly once per task dispatch. The cached pair is stashed on `TASK._resolved_worktree` and consumed by Step A step 3a / step 7 without re-invocation. Step A step 7 propagates the cached pair into `RUNNING[<task_id>].worktree_path` and `RUNNING[<task_id>].task_key` so every subsequent reference (spawn `cd`, cleanup, audit, P3 report) reads the persisted value.

**First-access side effect — `<STATE_DIR>/worktrees/` parent directory.** On the FIRST resolution per run, `mkdir -p <STATE_DIR>/worktrees/`. The directory is NOT pre-created by the STATE_DIR resolver's four-path `mkdir -p` — creating it on first worktree resolution rather than at P0 keeps a supervisor run that never dispatches a worker (e.g. an empty BOARD, or a `--dry-run`) from materializing an empty `worktrees/` directory under `$STATE_DIR`.

**`.git/worktrees/<task_key>/` metadata directory.** `git worktree add <path>` derives the metadata directory name in `.git/worktrees/` from `basename(<path>)`. Because the resolver produces a `<worktree_path>` whose basename is exactly `<task_key>`, the metadata directory inherits the same name.

**Authority for worktree path construction.** Every `git worktree add`, `git worktree remove`, `cd "..."`, stale-existence check, spawn-error cleanup, worker-close cleanup, audit-notes string, and P3 cleanup-command print in this file MUST substitute the resolved `<worktree_path>` / `<task_key>`.

---

## Merge contract

M9 T-4 — squash-only merge. Approved workers always land as one integration-branch commit:

1. `git merge --squash duet/<task_id>`
2. `git commit -F <message-file>`, where `<message-file>` contains the worker's final commit message.

There is no merge-strategy config, no rebase path, and no merge-commit-producing path. This keeps the first shipped product predictable: one task becomes one mainline commit, with no ccx-owned marker in the commit subject.

**Post-merge cleanup contract:** after a successful merge, the supervisor removes the worker's worktree first and then deletes the worker branch. The order is load-bearing because `git branch -D` refuses to delete a branch checked out in any worktree. Blocked exits preserve the branch for human triage.

---

## Phase P0: Pre-check

1. Resolve repo root: `REPO_ROOT="$(git rev-parse --show-toplevel)"`. All subsequent supervisor paths derive from `REPO_ROOT` (working-tree concerns: branch, scope globs, commits) or from `STATE_DIR` (ccx-owned state: BOARD, briefs, logs, audit). The two are disjoint — never interchange them.

1a. **Resolve `STATE_DIR`** per the "State path resolver" section above. Run the resolver exactly once at this step and cache `STATE_DIR` — the absolute path returned by the resolver. Every later reference reads from this variable. Merge handling is squash-only; do not read any merge-strategy config.

   The resolver also creates the four pre-required subdirectories (`tasks/`, `workers/`, `supervisor-audit/`, and `STATE_DIR` itself) and emits the one-line `ccx state: <STATE_DIR>` stderr announcement. P0 step 5 below is the only other directory-creation point and is superseded by this step's `mkdir -p` — keep step 5's location in the phase so the original numbering reads continuously, but the bodies have moved up. The `<STATE_DIR>/worktrees/` directory is NOT created here — the worktree-path resolver creates it lazily on first resolution (see the "First-access side effect" clause of the worktree-path resolver section), so a supervisor run that never dispatches a worker leaves no empty `worktrees/` behind.
1b. **Load the active model ladder.** If `STATE_DIR/model-ladder.json` exists, parse it as JSON; otherwise use the built-in ladder below. Validate before reading BOARD so task `model_start` errors can cite the active alias set.

   ```json
   {
     "default_start": "default",
     "tiers": [
       { "alias": "economy", "claude": { "model": "sonnet", "effort": "medium" }, "codex": { "model": "gpt-5.5", "effort": "medium" } },
       { "alias": "default", "claude": { "model": "sonnet", "effort": "xhigh" }, "codex": { "model": "gpt-5.5", "effort": "high" } },
       { "alias": "strong", "claude": { "model": "opus", "effort": "xhigh" }, "codex": { "model": "gpt-5.5", "effort": "high" } },
       { "alias": "max", "claude": { "model": "opus", "effort": "max" }, "codex": { "model": "gpt-5.5", "effort": "xhigh" } }
     ]
   }
   ```

   Validation rules:
   - `tiers` must be a non-empty array.
   - Each tier must have a unique non-empty `alias`.
   - Each tier must have `claude.model` and `codex.model`.
   - `claude.effort` is optional but, when present, is passed to Claude as `--effort <value>`.
   - `codex.effort` is optional. When present it must be one of `none | minimal | low | medium | high | xhigh` (the reasoning-effort set the installed codex companion v1.0.3 accepts); reject any other value at ladder-load time. It is passed to Codex **task** (implement) primitives only, as `--effort <value>`. Codex **review** primitives (`review` / `adversarial-review`) receive `--model <codex.model>` alone — the companion accepts `--effort` on `task` only. When a rung omits `codex.effort`, no effort flag is passed for that rung (current behavior).
   - `default_start`, when present, must match a tier alias. If absent, use `default` when present, otherwise the first tier.

   Print the active ladder before the dispatch plan:

   ```text
   Active model ladder: <source path or built-in>
   alias      claude              codex
   economy    sonnet/medium       gpt-5.5/medium
   default    sonnet/xhigh        gpt-5.5/high
   strong     opus/xhigh          gpt-5.5/high
   max        opus/max            gpt-5.5/xhigh
   default_start: default
   ```

   When a tier omits `claude.effort` or `codex.effort`, print that column as the bare model id with no `/<effort>` suffix (e.g. `gpt-5.5`), matching the optional-effort schema above.

   This printout is required even when `--dry-run` is not set. Users should not need to read command source to know which models will run.

   After validation, write the resolved effective ladder JSON to `STATE_DIR/model-ladder.effective.json`. This file is always supervisor-owned and overwritten on every run, even when the active source was the built-in ladder. Workers receive this effective path via `CCX_MODEL_LADDER_PATH`; they never need to reconstruct built-in defaults.
2. Resolve integration branch:
   - If `--integration` is set, use that. Verify with `git rev-parse --verify "refs/heads/<branch>"`. Stop if missing.
   - Otherwise `INTEGRATION="$(git rev-parse --abbrev-ref HEAD)"`. If the result is `HEAD` (detached), STOP — tell the user to check out a branch first.
2a. **Integration branch must be the current checkout.** Compute `CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"`. If `CURRENT_BRANCH != INTEGRATION`, STOP with: `supervisor must be run while checked out on the integration branch — run 'git checkout <INTEGRATION>' first`. Rationale: every subsequent `git add`/`git commit`/`git merge` operates on the current `HEAD`, and worker worktrees fork from that `HEAD` too. If supervisor ran from a different branch, briefs and merges would land on the wrong branch and workers would fork from stale commits. Auto-checkout is avoided in M1 because it would require crash-safe restore on failure; forcing an explicit checkout gates the risk clearly.
3. Verify the working tree is clean on the current checkout: `git status --porcelain=v1 -z` must be empty. If dirty, STOP. Unlike `/ccx:loop`, supervisor commits land directly on the integration branch; pre-existing uncommitted changes would contaminate the dispatch/batch commits. Tell the user to stash or commit first and re-run.
3a. **M8a — fresh-base refresh (`worktree.baseRef: "fresh"`).** Best-effort fast-forward of local `INTEGRATION` to its `origin/<INTEGRATION>` tip so that every worker worktree created later in Step A step 3a forks from an up-to-date base rather than a stale local HEAD. Runs ONCE per supervisor run, at P0 only:
   - `git fetch --quiet origin "<INTEGRATION>:refs/remotes/origin/<INTEGRATION>" 2>/dev/null || true`. The explicit `<branch>:refs/remotes/origin/<branch>` refspec is load-bearing — without it `git fetch origin <branch>` lands only in `FETCH_HEAD` and leaves `refs/remotes/origin/<INTEGRATION>` stale, so the subsequent `git merge --ff-only refs/remotes/origin/<INTEGRATION>` would replay the OLD remote tip. The trailing `|| true` covers no-origin-remote and offline cases — `else local HEAD` is the brief's documented fallback and not a hard error.
   - If `git rev-parse --verify "refs/remotes/origin/<INTEGRATION>" >/dev/null 2>&1` resolves, attempt `git merge --ff-only "refs/remotes/origin/<INTEGRATION>"`. On success, local `INTEGRATION` silently advances to the upstream tip. On failure (local is ahead of origin from a prior run, or has diverged) log one line — `M8a: integration branch is ahead of origin/<INTEGRATION> or diverged — continuing with local HEAD as worker base ref` — and continue. Do NOT attempt non-FF merge, rebase, or hard reset; rewriting local history under a supervisor that is about to commit briefs to the current HEAD would corrupt every subsequent dispatch.
   - If `refs/remotes/origin/<INTEGRATION>` does not resolve (purely-local repo, never pushed, upstream renamed): skip silently. The documented `else local HEAD` fallback applies.

   The refresh is once-per-run, not per-dispatch. Per-dispatch worktree creation (Step A step 3a) always forks from the supervisor's current `HEAD` — which equals whatever this P0 step landed on plus any brief commits already made this run. That preserves the Step B step 2 / step 3 invariant that worker branches diff cleanly against the merge target. Per-dispatch upstream refresh is deferred to a later milestone if measurement shows origin advancement during a run is a real pain point.
4. Verify `STATE_DIR/BOARD.md` exists.
   - If present, proceed.
   - If absent, STOP with: `BOARD.md not found at <STATE_DIR>/BOARD.md. Run /ccx:plan "<prompt>" or /ccx:plan --from <path> to seed tasks.` — `/ccx:plan` is the M6 onboarding path (see `docs/supervisor-design.md`); supervisor does NOT auto-invoke it, because auto-invocation would conflate LLM creativity (decomposition) with deterministic scheduling and hide the human review gate (`status: draft` in planned rows).

   `BOARD.md` lives outside the working tree (`$XDG_DATA_HOME/ccx/<repo-key>/BOARD.md`) and is resolved through `STATE_DIR/BOARD.md`.
5. Already handled in step 1a (the resolver's `mkdir -p` covers `STATE_DIR/tasks/`, `STATE_DIR/workers/`, `STATE_DIR/supervisor-audit/`). The numbered step is retained as a placeholder so the phase numbering reads continuously across older revisions; do NOT re-create the directories here.
5a. **Compute a per-run supervisor ID** `SUPERVISOR_RUN_ID = <UTC-compact-ts>-<rand8>` (e.g. `20260417T153012Z-a3f9c011`). Per-run isolation is required because two concurrent `/ccx:supervisor` runs on the same host each own their own DISPATCHED set but share `STATE_DIR` — writing both runs' decisions into a single `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` would let either run's Step D commit pick up the other's audit entries. Use `SUPERVISOR_RUN_ID` as the audit filename (Step B2 writes `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`; Step D only stages that exact file; P3 reads that exact file). Do not reuse a prior run's ID.
6. Verify `claude` CLI is on `$PATH`: `command -v claude`. If missing, STOP — the supervisor cannot spawn workers.
7. Check `~/.claude/ccx-chat/config.json`. If missing, WARN (workers with `--chat` will disable chat per `/ccx:loop` Phase 0.7 contract — the supervisor still works, but worker `chat_ask` calls will fall back to `AskUserQuestion` which in `-p` mode aborts the worker cleanly). Do not stop.

If anything fails, print the exact error and stop. No partial setup.

---

## Phase P0.5: Chat bridge setup (only if `--chat` is set)

Pre-M6. Registers the supervisor's own ccx-chat session so Discord watchers can see lifecycle events that are otherwise invisible (workers post their own chatter, but from Discord you cannot tell a supervisor run started in repo X, which worker got T-N, or when the run ended).

1. **Tool availability check.** Before calling any `mcp__ccx-chat__*` tool, verify it appears in this session's tool surface (same check §P2 Step B2 performs for `chat_supervisor_poll` and /ccx:loop Phase 0.7 performs for its own chat bridge). If the `ccx-chat` MCP server is not registered — the user has not run `/ccx:chat-setup`, or it failed — `chat_register` is simply absent. Log once to stderr: `--chat requested but ccx-chat MCP server is not available. Run /ccx:chat-setup first. Continuing without chat.` Then unset `--chat` for the rest of the run and proceed. Do NOT abort the supervisor — the user opted into chat, not into blocking on it.

2. **Register the supervisor session.** Call `mcp__ccx-chat__chat_register` with:
   - `label` — `[supervisor] <repo_basename> — <UTC-YYYY-MM-DD HH:MM>Z`. Truncated to ~80 chars by the broker. The `[supervisor]` prefix disambiguates from worker sessions in `/sessions`-style listings; the repo basename mirrors pre-M6 broker message prefix (both short, never the absolute path); the UTC timestamp lets the human scroll back through Discord and correlate a session banner to a specific run.
   - `cwd` — `REPO_ROOT` (absolute path; the broker uses `basename(cwd)` to render the repo prefix on every message).
   - `branch` — `INTEGRATION` (the supervisor operates on the integration branch by contract — P0 step 2a enforces this).
3. **Store the returned `sessionId` as `CHAT_SESSION_ID`.** On any error from `chat_register` (broker down, Discord 5xx, misconfig), log the error once, leave `CHAT_SESSION_ID` unset, and continue. Every later `chat_send` call gates on `CHAT_SESSION_ID` being truthy, so a register-time failure cleanly degrades to the no-chat path.
4. **Set the initial phase** via `chat_set_phase({sessionId: CHAT_SESSION_ID, phase: "dispatching"})` immediately after register. Later phase transitions: `draining` when `STOP_DISPATCHING` is set or `READY` exhausts while `RUNNING` is non-empty; `closing` at the top of P3. Phase-set failures are logged and ignored — phase is a nice-to-have, not load-bearing.
5. **Degraded-mode handling.** If any later `chat_*` call fails with a non-cancellation error, log the error once, set a run-level `CHAT_DEGRADED = true` flag, and stop attempting further chat calls for the rest of the run to avoid spamming errors. The final P3 report must mention that chat was lost mid-run. Do NOT retry; a broker that dropped one call is unlikely to recover within the same scheduling loop, and retries would just clutter the log.
6. **Cancellation semantics.** Unlike `/ccx:loop`'s `--chat`, the supervisor never calls `chat_ask`, so the `source: "cancel"` path has no trigger. If any `chat_send` call returns an error whose message contains the substring `cancelled` (e.g. `session ab12 was cancelled (user)`), the user issued `!ccx cancel #<id>` from Discord. STOP the supervisor loop immediately without dispatching new workers (set `STOP_DISPATCHING = true` so Step B continues to drain `RUNNING`), skip to P3, and exit via `chat_close({status: "aborted"})`. Do not interpret generic transient errors (network, timeout) as cancellations — only the literal substring `cancelled`.

**Lifecycle messages** — fire-and-forget via `mcp__ccx-chat__chat_send({sessionId: CHAT_SESSION_ID, text: ...})`. All gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`. The broker automatically prepends the color tag, repo prefix , and session-id to every body, so the text below should NOT redundantly include the repo name. Each bullet is a separate `chat_send` call — never pack multiple facts onto one line; one fact per bullet renders better in Discord:

| Event | Where fired | `text` body (multi-line; use `\n` between bullets) |
|---|---|---|
| Run start | After P0.5 registration succeeds AND P1's `Proceed` answer returns | `supervisor run started\n• parallel=<N>\n• worker-loops=<N>\n• worker-mode-default=<run-level mode>\n• worker-mode-overrides=<count of READY tasks whose BOARD worker_mode is non-null>\n• start-tier=<alias>\n• integration=<branch>\n• pending=<count>\n• ready=<count>\n• deferred-by-deps=<count>` |
| Dispatch | Step A step 8 (right after the one-line stderr dispatch notice) | `dispatched T-<id> — <title>\n• worker session=<sessionId from chat_register inside the worker, if knowable; else "launching">\n• worktree=<RUNNING[T-id].worktree_path>\n• branch=duet/<id>\n• model_start=<alias>\n• worker_mode=<RUNNING[T-id].worker_mode_resolved>\n• attempt=<attempts>` |
| Merge | Step B step 3's clean-squash-and-commit outcome | `merged T-<id> — <title>\n• commit=<short SHA>\n• squashed via T-<id>: <title>\n• model_start=<alias>` |
| Block | Step B step 3/4's any blocked outcome | `blocked T-<id> — <exit_status>\n• attempts=<N>\n• model_start=<alias>\n• notes=<first 120 chars of notes>\n• log=STATE_DIR/workers/T-<id>.log` |
| Run end | Top of P3, before printing the textual report | `supervisor run complete\n• merged=<N>\n• blocked=<N>\n• stranded=<N>\n• duration=<human-readable>\n• audit=STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl (if written)` |

**Never `chat_ask`.** The supervisor's only human gate is `AskUserQuestion` locally for the P1 Proceed prompt. `chat_ask` from supervisor would queue in the broker and require the supervisor to poll its own queue, which is not the supervisor's role. Stick to fire-and-forget `chat_send`.

7. **Close the session at P3.** Call `chat_close({sessionId: CHAT_SESSION_ID, status: ...})` exactly once, in a `finally`-style block that runs even when earlier phases threw. Derive `status` in priority order (first match wins):

   1. `aborted` — the human issued `!ccx cancel` (P0.5 step 6 set `STOP_DISPATCHING` via the cancel path).
   2. `error` — an uncaught supervisor error reached the `finally` block.
   3. `stuck` — ANY task ended in a stuck-flavored outcome. A task is stuck-flavored when either of these holds:
      - Its `exit_status` is `stuck`.
   4. `approved` — every dispatched task ended `merged`, and nothing is in flight or blocked.
   5. `completed` — the default for any other mixed merged/blocked outcome, including `budget-exhausted`, `merge-*`, `spawn-error`, `no-commit`, etc.

   Because `RUNNING` is drained into `BLOCKED_IDS` or `MERGED_IDS` by the time P3 runs, stuck classification must be stored on the BOARD-row `exit_status` before Step B step 5 removes the task from `RUNNING`.

If `--chat` was unset by step 1's tool-availability check, all seven items above are no-ops.

---

## Phase P1: Parse BOARD.md and plan

1. Read `STATE_DIR/BOARD.md` (resolved in P0 step 1a). Extract:
   - The `## Direction` section (everything from the line after `## Direction` up to the next `## ` heading or EOF). Store as `DIRECTION_TEXT`. May be empty.
   - The single YAML fenced code block under `## Tasks`. Parse it as a YAML array. If parsing fails or multiple fenced blocks appear under `## Tasks`, STOP with the parse error.
2. Validate each task entry. **Required** fields: `id` (string matching `^T-[0-9]+$`), `title` (non-empty string), `status` (one of `draft | pending | assigned | review | merged | blocked` — `draft` was added in M6 for `/ccx:plan` output and is accepted as a valid status value but is excluded from dispatch in step 3 below), `scope.include` (non-empty array of strings). **Optional** with defaults: `scope.exclude` (`[]`), `priority` (`normal`, one of `high | normal | low`), `model_start` (`auto`, one of `auto | <active ladder aliases>`), `worker_mode` (`null`, one of `null | duet | conductor` — when `null` or absent, the task inherits the run-level `--worker-mode` value), `depends_on` (`[]`, array of task ids), `brief` (`STATE_DIR/tasks/<id>.md`), `notes` (`""`), `attempts` (`0`, non-negative integer — supervisor-managed counter; humans never need to set this, but a missing or null field must be accepted and normalized to `0`).

   `worker_mode` is the per-task override for the run-level `--worker-mode` flag. Per-task override exists because some tasks (e.g. heavy spec-writing, long convergence runs that risk Claude Code auto-compaction) benefit from conductor's bounded per-cycle context, while simpler tasks stay cheaper under duet. Resolution at dispatch time is: explicit non-null BOARD `worker_mode` wins; otherwise the run-level `--worker-mode` value (default `duet`) is used. Reject invalid values with: `T-<id> worker_mode must be null or one of duet | conductor (got: "<value>")`. Both the literal YAML `null` (or its tilde shorthand `~`) and the field being absent from the row normalize to `null` (inherit run-level); the empty string `""`, the empty sequence `[]`, and any other value that is neither `duet` nor `conductor` are rejected with the error above.

   `model_start` and `worker_mode` are the only BOARD fields that describe worker behavior. Everything else about the worker invocation (the `--loops`, `--commit`, `--chat` flags, the brief path, the dispatch prompt body, the env vars) is supervisor-controlled and never appears in BOARD.

   `model_start` is a BOARD field because it describes task complexity, not worker flags. It must be an alias, never a raw model id. Missing or `auto` resolves to the active ladder's `default_start`; any other value must exist in the active ladder loaded in P0 step 1b. Reject invalid aliases with: `T-<id> model_start must be auto or one of <aliases> (got: "<value>")`.

   **Glob-string contract** (used by M4's overlap gate, §P2.4): every entry in `scope.include` and `scope.exclude` MUST be a non-empty string that contains no NUL byte and no newline character — those are the two characters that would break `git ls-files -z` output parsing. All other characters (including single-quote `'`, double-quote `"`, spaces, `$`, backtick) are permitted because §P2.4 mandates exec/argv invocation; single-quote in particular is a legal character in committed Git paths (e.g. `docs/engineer's-guide.md`) and rejecting it would be a regression in accepted task scopes.

   **Pathspec sanity probe** (M4 — runs at validation time, before the dispatch loop starts): for every task whose `status == "pending"`, run `git ls-files -z --` with each glob in `scope.include` AND `scope.exclude` as its own argv element (per §P2.4 step 1's contract — direct exec, no shell). The probe uses Git's pathspec parser without doing anything with the output; its sole purpose is to catch malformed pathspecs deterministically at startup. Any non-zero exit, or stderr matching `bad pathspec` / `unknown pathspec` / `pathspec '...' .* invalid`, fails this task's validation. Without this probe, malformed `:(...)` magic or a stray `\` in a pathspec would only surface inside §P2.4's overlap gate, which defers-and-retries on `git ls-files` failure — turning a bad BOARD row into an infinite supervisor loop because no exit condition fires while `READY` keeps re-including a task that can never dispatch. STOP and print every offending task id with the verbatim git stderr; the human fixes the BOARD row and re-runs.

   If any task fails validation (shape, required-field, glob-string contract, or pathspec sanity probe), STOP and print the offending row(s) verbatim.
3. Compute the two dispatch pools. Both are re-evaluated across the whole run (see P2 Step A1), so treat them as live views rather than frozen snapshots:
   - `PENDING_POOL` — every task with `status == "pending"`. Stays in this pool until the supervisor picks it up.
   - `NOT_READY_REASONS` — for each pending task whose `depends_on` contains any non-`merged` entry, record the unmet deps (for reporting). This is derivation, not filtering.
   Tasks with `status in {draft, assigned, review, blocked, merged}` are excluded from dispatch entirely. `draft` is the `/ccx:plan` output status (M6) — it is the human-review gate: the plan LLM writes drafts, the human reviews and edits, then flips `draft → pending` explicitly before the next supervisor run. Supervisor must NEVER auto-flip `draft → pending`, not even when the row is otherwise complete, because that would bypass the review gate the design doc is built around.
4. Compute the **initial ready set** `READY` — every task in `PENDING_POOL` whose `depends_on` all resolve to `status == "merged"`. Sort by `priority` descending (`high > normal > low`), breaking ties by `id` ascending treated as a numeric suffix (`T-9` < `T-10`). This ordering is re-applied every time the ready set is recomputed.
5. Print the dispatch plan:
   - `READY` — dispatchable now.
   - `NOT_READY` — waiting on listed deps; will be re-evaluated after each merge.
   - `BLOCKED` / `ASSIGNED` / `REVIEW` — present for visibility; supervisor does not touch these (they need human action or are owned by a prior/concurrent run).
   - For each `READY` row, include `model_start=<resolved alias>` and `worker_mode=<resolved mode>` so the user sees both the chosen starting rung and the resolved per-task worker mode (`duet` or `conductor`) before approving dispatch. The worker-mode resolution applies the same rule Step A uses at spawn time: explicit non-null BOARD `worker_mode` wins; otherwise the run-level `--worker-mode` value; otherwise the default `duet`. Surface the resolved value as a trailing parenthetical or column on the existing per-task plan line so the operator can spot a row that will run under conductor before answering Proceed/Abort.
6. If `--dry-run`, stop here.
7. Otherwise call `AskUserQuestion`: "Proceed with dispatch plan?" with options **Proceed** / **Abort**. On Abort, stop with no side effects.
8. On **Proceed**, capture `RUN_STARTED_AT = <UTC ISO 8601>` for P3's run-end duration calculation. Then fire the pre-M6 run-start lifecycle message per the table in P0.5 (gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`).

---

## Phase P2: Scheduling loop

State:

- `SLOTS = --parallel N`
- `WORKER_LOOPS = --worker-loops N` — forwarded verbatim into the worker spawn as `/ccx:loop --<TASK_WORKER_MODE> --loops <WORKER_LOOPS>`, where `<TASK_WORKER_MODE>` is the same per-task variable §P2.2 substitutes (literal `duet` or `conductor`) per the resolution rule on `WORKER_MODE` below.
- `WORKER_MODE = --worker-mode {duet,conductor}` — run-level default worker mode. Resolved per task inside Step A: `TASK_WORKER_MODE = TASK.worker_mode` when non-null, otherwise `WORKER_MODE`. The resolved value drives the leading `--duet` / `--conductor` flag inside `$DISPATCH_PROMPT` (see §P2.2). Default is `duet` during M10 incubation; conductor mode is the in-flight design from `docs/supervisor-design.md` §"Conductor Mode (M10 — proposed)".
- `MODEL_LADDER` — active ladder loaded in P0 step 1b. Built-in aliases are `economy`, `default`, `strong`, and `max`; custom `STATE_DIR/model-ladder.json` may replace the alias set. Each rung is `{alias, claude: {model, effort?}, codex: {model, effort?}}`.
- `DEFAULT_START_ALIAS` — active ladder default from `default_start` validation.
- `START_TIER_OVERRIDE` — `auto` or an explicit active ladder alias from `--start-tier`. `auto` means "use each task's `model_start`, falling back to `DEFAULT_START_ALIAS`."
- `MAX_WORKER_BUDGET_USD` — run-level `--max-worker-budget-usd` value, or `null` when the flag was not supplied. Resolved once at argument-parse time; forwarded verbatim into every dispatched worker's spawn as `--max-budget-usd <value>` when non-null (see §P2 Step A step 4).
- `RUNNING = {}` — map `task_id -> { shell_id, worktree_path, task_key, branch, log_path, started_at, scope_include, attempts, start_tier_alias, worker_mode_resolved, session_id, resume_attempts }`. `worktree_path` is the absolute path the M9 T-2 worktree-path resolver returned at dispatch time (`<STATE_DIR>/worktrees/<task_key>/`); it is the join key for Step B step 1's `claude agents --json` cwd lookup and the cleanup-target for Step B step 5 and recovery paths. `task_key` (M9 T-2) is the basename of `worktree_path` — equal to `task_id`; the basename is also the name of the `.git/worktrees/<task_key>/` metadata directory. Both fields are written by Step A step 7 from the cached resolver pair. `scope_include` is the BOARD row's `scope.include` glob list (a list of strings, copied verbatim at dispatch time), used by Step A's scope-overlap gate. `attempts` starts at `1` on first dispatch. `start_tier_alias` is the resolved model start alias passed to the worker; ladder movement after that happens inside the worker by cycle. `worker_mode_resolved` (M10) is the literal string `duet` or `conductor` substituted into `$DISPATCH_PROMPT`'s leading `/ccx:loop --<TASK_WORKER_MODE>` token at dispatch time per §P2.2; Step A step 7 writes it, the Step A step 8 dispatch notice and the P0.5 dispatch lifecycle chat row read it, and it is the auditable source for the resolved-for-this-task mode (especially when the BOARD row's `worker_mode` was null and the value was inherited from the run-level flag). `session_id` (starts `null`) is the worker's `claude -p` session id, captured off the worker log's final `--output-format json` envelope by Step B step 2 when the worker exits; it is the resume handle §P2.5 uses to redispatch a cycle-cap worker via `claude --resume`. When the capture fails (no parseable envelope, no `session_id` field), it stays `null` and §P2.5 falls back to the fresh-dispatch/block path. `resume_attempts` (starts `0`) counts how many times §P2.5 has resumed this worker's session; it is the bound (max `1`) that keeps a repeatedly-cycle-capping worker from resuming forever.
- `DISPATCHED = set()` — every `<TASK_ID>` this supervisor has launched in this run (populated in Step A step 7, never removed). Used by Step B2's ownership filter so asks from workers that exit between ask-time and the next poll are still recognized as ours.
- `MERGED_COUNT = 0`
- `MERGED_IDS = []`, `BLOCKED_IDS = []`
- `PENDING_POOL` and `READY` from P1 — treated as live views; recomputed after every completion (see A1 below).
- `DEFERRED_THIS_PASS = set()` — Step A scratch state, cleared at the top of every Step A pass. Tracks which `READY` task ids have already been popped and deferred this pass due to scope-overlap so the inner loop does not re-pop and re-defer the same task indefinitely (popping is destructive — without this set the head of `READY` would be reconsidered until slots fill, masking lower-priority dispatchable tasks behind it).
- `EVER_DEFERRED_BY_SCOPE = set()` — run-level accumulator, NEVER cleared. A1's clear of `DEFERRED_THIS_PASS` is correct for slot-fill scheduling but discards the history P3 needs to classify leftover `PENDING_POOL` entries. Every time A2 step 1a defers a task by scope-overlap, also add its id to `EVER_DEFERRED_BY_SCOPE`. P3 reads this set to attach the `scope-deferred` reason to any task that ends the run still in `PENDING_POOL`. A task that was deferred earlier but eventually dispatched (and then merged or blocked) stays in this set, but P3 ignores it because it is no longer in `PENDING_POOL` at exit — the set is purely a tag, not a status.
- `STOP_DISPATCHING = false` — set to `true` by Step B's merge-commit-failed branch (M4) when the integration-branch commit pipeline rejects a merge commit. While `true`, Step A's slot-fill is skipped entirely so no new workers start, but Step B continues to drain `RUNNING` so already-in-flight peers are not stranded as `assigned`. Loop exit gains a new condition 3 (see below) that fires once `RUNNING` drains, because `READY` may legitimately still hold pending tasks at that point — those tasks are intentionally being left for a future supervisor run after the human resolves the broken commit pipeline.
- `LAST_OUTPUT_SEEN = {}` — map `shell_id -> byte length of BashOutput buffer at last Step C probe`. Pre-M6 — Step C's adaptive polling primitive uses this to detect "a worker produced new output since the last probe" and break out of the 30s wait early. New entries are added by Step A step 7 (initialize to the then-current `BashOutput` length on the first Step C pass after dispatch); entries are removed from `LAST_OUTPUT_SEEN` in Step B step 5 when the task is removed from `RUNNING` so the map cannot grow unbounded across a long run.
- `CHAT_SESSION_ID` and `CHAT_DEGRADED` — pre-M6 — set (or not) by P0.5. `CHAT_SESSION_ID` is truthy only when `--chat` was requested, the MCP tool surface was available, AND `chat_register` succeeded. `CHAT_DEGRADED = true` after the first `chat_*` error; once set, all subsequent `chat_send` calls are skipped. Together they gate every lifecycle message below as `if (CHAT_SESSION_ID && !CHAT_DEGRADED) chat_send(...)`.
- `RUN_STARTED_AT` — UTC ISO 8601 captured at the top of P1 after the dispatch plan prints. Used by P3's run-end chat message to compute `duration`. Not load-bearing for any non-chat behavior.

**Exit conditions** (evaluated at the top of every iteration, after A1 recomputes `READY`):

1. `RUNNING == {}` AND `READY == []` → exit. Nothing is running and nothing can be dispatched right now. Any task still in `PENDING_POOL` must have unmet deps that point at `blocked` (or non-existent) tasks, so no future completion will unblock them in this run. Report those as stranded in P3.
2. `--max-tasks M` is set AND `MERGED_COUNT >= M` AND `RUNNING == {}` → exit. Cap reached and no workers left to drain.
3. `STOP_DISPATCHING == true` AND `RUNNING == {}` → exit. The integration-branch commit pipeline rejected a merge commit and the supervisor is in drain-then-stop mode (Step B's merge-commit-failed branch). Once the last in-flight worker has been classified by Step B, there is nothing left for the loop to do — A2 is gated off by `STOP_DISPATCHING`, so any tasks still in `PENDING_POOL` (READY or not) MUST stay there until a future supervisor run picks them up after the human fixes the broken commit pipeline. Without this condition the loop would spin forever in this scenario, because A1 keeps `READY` populated from `PENDING_POOL` even when A2 cannot act on it. Report any leftover `PENDING_POOL` entries as `deferred-by-stop-dispatching` in P3.

Without all three conditions the loop can hang — condition 1 covers dependency-blocked stranding, condition 2 covers cap-reached-but-pending-tasks-left, condition 3 covers commit-pipeline-broken-but-pending-tasks-left. `PENDING_POOL` becoming empty is also an implicit exit because it forces `READY == []` in A1, which triggers condition 1 once `RUNNING` drains.

**Pool-removal rule.** Every time a task is classified `blocked` — whether pre-dispatch (stale-artifact / spawn-error) or post-completion (no-commit / error / merge-conflict) — it MUST be removed from `PENDING_POOL` in the same step. Otherwise A1 would re-select it on the next pass and the same failure handler would fire indefinitely. The rule is: "blocked → out of the pool, into `BLOCKED_IDS` for the P2 Step D batch commit".

### Step A — Fill slots

A1. **Recompute `READY` first.** Iterate `PENDING_POOL`; re-include any task whose `depends_on` set is now entirely `merged` in the current in-memory BOARD state (picks up newly-unblocked tasks after each merge). Re-apply the priority + id sort. This recomputation is cheap and MUST run at the top of every Step A pass — computing `READY` only once in P1 would strand tasks whose deps merge mid-run. Then **clear `DEFERRED_THIS_PASS`** so the new pass starts with a fresh deferral list (deferrals from a previous pass were instructive only for that pass — by the time A1 runs again, the `RUNNING` set has already changed via Step B drains and the overlap picture may differ). A1 always runs, even when `STOP_DISPATCHING == true`, so P3 reporting and the loop's exit condition still observe the correct `READY` state.

A2. **Skip A2 entirely when `STOP_DISPATCHING == true`** — no slot-fill, no overlap checks, no spawns. The loop relies on Step B to drain `RUNNING` until **exit condition 3** fires naturally (condition 1 cannot fire while `STOP_DISPATCHING` is set because A1 keeps `READY` populated from any leftover `PENDING_POOL` entries; condition 3 was added precisely so this path has a terminating exit). Otherwise, while `len(RUNNING) < SLOTS` AND `READY` contains at least one task NOT in `DEFERRED_THIS_PASS` AND (`--max-tasks` unset OR `MERGED_COUNT < M`):

1. Pop the highest-priority ready task that is not in `DEFERRED_THIS_PASS`. Call it `TASK`. Remove it from `PENDING_POOL` only after step 7 confirms a live worker — until then, the task is still "pending" from the persisted-BOARD perspective.
1a. **Scope-overlap gate.** Before any side effect, check whether `TASK.scope.include` overlaps with any `RUNNING_TASK.scope_include` for `RUNNING_TASK` currently in `RUNNING`. Use the algorithm in §P2.4. If any pairwise overlap is detected:
   - Add `TASK.id` to `DEFERRED_THIS_PASS` (per-pass, scoped to the inner slot-fill loop).
   - Add `TASK.id` to `EVER_DEFERRED_BY_SCOPE` (run-level, used by P3 to label leftover `PENDING_POOL` rows). Adding repeatedly is a no-op — set semantics.
   - Do NOT mark `blocked`. Do NOT remove from `PENDING_POOL`. Do NOT touch BOARD or write a brief.
   - Print one line: `deferred <TASK.id> — scope overlaps running <OVERLAP_TASK.id> on <SHARED_FILES (max 3, …)>`. Overlap is a transient parallelism gate, not a failure mode; the task is re-evaluated next iteration.
   - Continue the inner slot-fill loop (try the next non-deferred ready task). Do not advance to step 1b.
1b. **Stale-branch / stale-worktree gate.** Before writing anything, **resolve the target worktree path via the worktree-path resolver** (`<worktree_path>` and `<task_key>` are the resolver outputs for this `TASK.id`). **Cache the pair on the in-memory task record immediately** — e.g. assign `TASK._resolved_worktree = {worktree_path, task_key}` (or any per-pass scratchpad) so Step A step 3a below reads this cached pair instead of re-invoking the resolver. Step A step 3a explicitly defers to this cached pair (see its "M9 T-2 — read the cached pair" note). Then verify that neither the target branch nor the target worktree path exists yet:
   ```bash
   git rev-parse --verify "refs/heads/duet/<TASK.id>" 2>/dev/null   # expect non-zero
   test -e "<worktree_path>"                                       # expect non-zero
   ```
   If either check passes (the ref or path exists), this is a stale artifact from a prior failed run. M8a moved worktree creation into the supervisor (step 1c below) so the worker no longer auto-suffixes branch names; supervisor must NOT let `git worktree add` proceed against an existing branch or path because step 1c would then fail with `fatal: 'duet/<id>' is already checked out` and abort mid-dispatch. Instead:
   - Record an in-memory BOARD update: `status: "blocked"`, `exit_status: "stale-artifact"`, `notes: "existing branch duet/<TASK.id> or worktree <worktree_path> from prior run — delete with 'git branch -d duet/<TASK.id>' and 'git worktree remove <worktree_path>' then re-run supervisor"`.
   - Append `<TASK.id>` to `BLOCKED_IDS` (step D persists it).
   - **Remove `<TASK.id>` from `PENDING_POOL`** per the pool-removal rule — without this, the next A1 recompute would re-include this task (because the in-memory BOARD status hasn't been persisted yet) and the same stale-artifact handler would fire on every pass indefinitely.
   - Continue the outer slot-fill loop (this slot becomes free for the next ready task).
2. **Write the brief** at `STATE_DIR/tasks/<TASK.id>.md` using the template in §P2.1. Frontmatter fields come from the BOARD row; body placeholders reference `DIRECTION_TEXT` and any `TASK.notes`. Do not parse or preserve stale worker flag fields from an existing brief: the brief is regenerated from BOARD state, and the resolved worker mode (`duet` or `conductor`) is applied via the dispatch prompt's leading `/ccx:loop --<TASK_WORKER_MODE>` token (§P2.2) — never via brief frontmatter.

3. **Persist the brief.** Write the regenerated brief to `STATE_DIR/tasks/<TASK.id>.md` (overwrites the on-disk file). The brief lives outside the working tree, so no `git add` / `git commit` runs here — the integration branch only carries product commits (worker merges). Proceed to step 3a sourcing `BASE_REV = $(git rev-parse HEAD)` from the unchanged tip. The worker is dispatched with the dispatch prompt's `<task_brief path="…">` attribute carrying the absolute `STATE_DIR/tasks/<TASK.id>.md` path (resolver-section "dispatch prompt path passed to workers" rule); the 4KB-escape-hatch dispatch variant relies on the worker `Read`ing that absolute path directly.
3a. **M8a — pre-create the worker worktree (supervisor owns this now, not `/ccx:loop --worktree`).** Forks from the supervisor's current `HEAD` — which equals `INTEGRATION`, AND is the same ref Step B's squash merge will eventually target. Forking from the merge target is mandatory: if the worktree forked from `origin/<INTEGRATION>` instead and local `INTEGRATION` had diverged (prior task merges this run, local-only commits), the `git log "<INTEGRATION>..duet/<TASK.id>"` diff in Step B step 2 would include any upstream-only commits as if they were worker work, and the squash in step 3 would replay them — silently inflating audit history and risking false conflicts. The P0 fetch + ff-only handles the "stale local" failure mode at run start (see P0 step 3a); per-dispatch the supervisor always forks from its own HEAD. See `docs/supervisor-design.md`:
   - **M9 T-2 — read the cached `<worktree_path>` and `<task_key>` pair** set by Step A step 1b's resolver invocation (`TASK._resolved_worktree.{worktree_path, task_key}`); do NOT re-invoke the worktree-path resolver here. The resolver call at step 1b is the SOLE per-dispatch invocation point; this step and step 7 below both consume the cached pair. The cached path lands the worktree at `<STATE_DIR>/worktrees/<task_key>/`, isolating it from the user's repo parent directory. (The resolver also `mkdir -p`s `<STATE_DIR>/worktrees/` on first invocation per run — that side effect already happened at step 1b.)
   - `BASE_REV = $(git rev-parse HEAD)` — captures the current HEAD; this becomes the worker branch's fork point AND the merge base Step B uses.
   - `WORKTREE_ERR="$(git worktree add -b "duet/<TASK.id>" "<worktree_path>" "<BASE_REV>" 2>&1 1>/dev/null)"; WORKTREE_RC=$?`. The `2>&1 1>/dev/null` form captures stderr into the shell variable while discarding stdout — NEVER redirect to a file inside `REPO_ROOT` (e.g. `2>worktree.err`), because the redirection creates the file before `git worktree add` runs, leaving an untracked path in the integration checkout that Step B step 3's `git status --porcelain` cleanliness assert would then classify as a dirty tree and abort every approved-worker merge in the run. The `<worktree_path>` substitution comes from the resolver call above. The `.git/worktrees/<task_key>/` metadata directory is derived from `basename(<worktree_path>)` automatically — no `--name` flag exists on `git worktree add` and none is needed. On `WORKTREE_RC != 0` (disk full, permission denied, race), treat as a non-fatal per-task error: record `exit_status: "stale-artifact"` with `notes: "git worktree add failed: <first 200 chars of WORKTREE_ERR>"`, append to `BLOCKED_IDS`, remove from `PENDING_POOL`, and continue the outer slot-fill loop. Do NOT STOP the whole run.
   - Spawning workers from inside this worktree (step 4) is what makes Step B step 1's `claude agents --json` cwd lookup correct — the OS process cwd reported in the registry equals `meta.worktree_path`, the join key.
4. **Capture `STARTED_AT` BEFORE spawning.** Record `STARTED_AT = <UTC now ISO 8601>` immediately, before the Bash spawn call below. Steps 6 and 7 MUST both use this same `STARTED_AT` value — not a re-sampled "now" timestamp. Rationale: §P2.5's stuck classifier requires `closure.at >= meta.started_at` to distinguish a fresh stuck exit from a stale closure in the broker's ring buffer. If the worker exits stuck very quickly (within the 3s liveness check, or during the `assigned` BOARD commit, or if a local config file makes `claude -p` crash fast), its `chat_close` `at` timestamp will be older than a "now" sampled at step 6 — and the classifier would filter out exactly the fast-fail stuck events M5 is meant to recover. Sampling `STARTED_AT` pre-spawn closes that window.

   Then spawn the worker with `Bash(run_in_background=true)`. M8a — the spawn `cd`s into the **worktree path**, not `REPO_ROOT`, so the OS process cwd visible in `claude agents --json` matches `meta.worktree_path` for Step B's M8a liveness lookup. The `<worktree_path>` substitution is the resolver output from step 3a (cached on the in-memory task record), not a literal sibling interpolation. Resolve all per-task variables BEFORE the spawn block below: (a) `TASK_START_ALIAS` — explicit `--start-tier` alias if not `auto`; otherwise `TASK.model_start` when set and not `auto`; otherwise `DEFAULT_START_ALIAS`. Define `TASK_START_TIER = MODEL_LADDER[TASK_START_ALIAS]`. The initial `claude -p` spawn uses `TASK_START_TIER.claude`; the worker receives the same ladder path + start alias so Codex can advance by cycle. (b) `TASK_WORKER_MODE` — explicit `TASK.worker_mode` when non-null; otherwise the run-level `WORKER_MODE` (default `duet`). The resolved literal (`duet` or `conductor`) is substituted into `$DISPATCH_PROMPT`'s leading `/ccx:loop --<TASK_WORKER_MODE>` token per §P2.2 and persisted on `RUNNING[T-id].worker_mode_resolved` per step 7. (c) `TASK_FALLBACK_MODEL` — resolved from the active ladder immediately after `TASK_START_TIER` above. Let `START_INDEX` be `TASK_START_ALIAS`'s position in `MODEL_LADDER.tiers` (the array is ordered cheapest/weakest-first per the built-in ladder shape in P0 step 1b: `economy < default < strong < max`). Walk `i` downward from `START_INDEX - 1` to `0`: the first tier whose `claude.model` differs from `TASK_START_TIER.claude.model` sets `TASK_FALLBACK_MODEL = MODEL_LADDER.tiers[i].claude.model` — the nearest cheaper rung with an actually-different Claude model (e.g. `strong`'s `opus` falls back to `default`'s `sonnet`). Walking down rather than always taking a flat `START_INDEX - 1` matters because the built-in ladder's `strong` and `max` tiers both use `opus`: a flat one-rung-down from `max` would resolve to `opus` again, emitting `--model opus --fallback-model opus` — not a real fallback, and a value the CLI could reasonably reject as its own primary model repeated. When the walk finds no cheaper tier with a different model (`START_INDEX == 0`, or every cheaper tier shares the same `claude.model`), there is no meaningful fallback; omit `--fallback-model` from this dispatch's spawn entirely. All three resolves run before `DISPATCH_PROMPT` is built so the prompt's first line and the spawn's `--model` / `--effort` / `--fallback-model` flags all see the bound values.

   ```bash
   # M9 — export the brief-path contract so the worker's M9 brief-read exception
   # can pin its absolute-path validation to the exact path the supervisor handed
   # off. Without these env vars the worker would have to trust the
   # <task_brief path="..."> attribute alone, which prompt injection can spoof.
   cd "<worktree_path>" && \
     CCX_STATE_DIR="<STATE_DIR>" \
     CCX_TASK_BRIEF_PATH="<STATE_DIR>/tasks/<TASK.id>.md" \
     CCX_TASK_ID="<TASK.id>" \
     CCX_MODEL_LADDER_PATH="<STATE_DIR>/model-ladder.effective.json" \
     CCX_MODEL_START_TIER="<TASK_START_ALIAS>" \
     CCX_EXPECTED_BRANCH="duet/<TASK.id>" \
     claude -p \
     --permission-mode bypassPermissions \
     <BRANCH_GUARD_SETTINGS_ARG> \
     --output-format json \
     --model <TASK_START_TIER.claude.model> \
     <TASK_FALLBACK_MODEL_ARG> \
     <CLAUDE_EFFORT_ARG> \
     --append-system-prompt "<APPEND_SYSTEM_PROMPT_TEXT>" \
     <MAX_WORKER_BUDGET_USD_ARG> \
     "$DISPATCH_PROMPT" \
     > "<STATE_DIR>/workers/<TASK.id>.log" 2>&1
   ```

   **`--output-format json`, resumable sessions, and their lifecycle (resume-redispatch contract).** The spawn uses plain `--output-format json` — the single-result envelope form, which (unlike `stream-json`) needs no `--verbose` and so does not trip the CLI's `stream-json requires --verbose` startup rejection (the failure this run's stream-json spawn hit). Its trailing envelope is a single `JSON.parse`-able object that carries a top-level `session_id`; Step B captures that id off the worker log at exit and stores it on `RUNNING[<task_id>].session_id` so §P2.5 can `claude --resume <session_id> -p` a cycle-cap worker instead of rebuilding its context from scratch.

   **Log-content tradeoff.** Under plain `json` the worker log holds the final result envelope, not a turn-by-turn stream: its `result` field is the worker's own end-of-run report — the `/ccx:loop` cycle summaries and exit reason, including the stuck-finding / unresolved detail — which is the operative signal every blocked-row remediation path points the operator at. Finer per-turn detail lives in the worker's `--chat` Discord thread and, under conductor mode, the `STATE_DIR/workers/<task_id>.conductor.jsonl` audit trail — not in this log. An operator who needs a full transcript for one task can re-run it manually with a streaming format; the supervisor keeps plain `json` so session_id capture stays on the proven companion-baseline format (`claude-companion.mjs` uses the same `--output-format json`).

   **Session persistence and cleanup.** `--no-session-persistence` is deliberately NOT passed: that flag makes the session unsavable and therefore unresumable (verified on `claude` 2.1.202: "sessions will not be saved to disk and cannot be resumed"), which would silently defeat the resume path. Persisted sessions do NOT live inside the worktree — they land in Claude's per-project state store keyed by the worker's cwd, so `git worktree remove` alone does NOT delete them. To keep no resume artifact outliving its task, every terminal worker-cleanup site — Step B step 5 (normal terminal outcomes), §P2.5 step 2 (the stuck/budget-exhausted block path), and Step A step 5's liveness-window teardown (spawn-error and budget-capped-within-window exits that never enter `RUNNING`) — best-effort purges that state with `claude project purge "<worktree_path>" -y 2>/dev/null || true` — the supported CLI surface that deletes a project's transcripts/state — alongside the worktree removal, so the supervisor never reaches into Claude's internal storage layout. §P2.5 step 0's resume runs BEFORE any purge, so the session it resumes is still on disk. Do not re-add `--no-session-persistence` here — it would leave the §P2.5 resume branch permanently falling back to a fresh dispatch.

   `<STATE_DIR>` in the env-var assignments is the supervisor's resolved absolute path, substituted at template-render time (NOT the literal token `STATE_DIR`). The task vars define the M9 worker-side contract that `/ccx:loop` Phase 0.5's brief-read exception enforces: `CCX_TASK_BRIEF_PATH` is the exact absolute path the worker is permitted to `Read` for its brief, `CCX_TASK_ID` is the task id the worker must see in the dispatch prompt's `<task_brief id="…">` attribute, and `CCX_STATE_DIR` is reserved for future M9 workers that need to write secondary state. The model vars define the duet ladder contract; the effective ladder file is supervisor-written even when the user did not provide a custom `model-ladder.json`, so workers always read one concrete JSON shape.

   `CCX_EXPECTED_BRANCH="duet/<TASK.id>"` and `<BRANCH_GUARD_SETTINGS_ARG>` together install the **branch-guard** — a deterministic backstop against the worker committing to the integration branch (e.g. `main`) instead of its own `duet/<TASK.id>` branch, which would bypass the squash-merge gate. `CCX_EXPECTED_BRANCH` is the worker's own branch (the same `duet/<TASK.id>` that Step A step 3a's worktree resolver checked out and that cleanup deletes on the merged exit). The settings file registers a `PreToolUse(Bash)` hook running `plugins/ccx/scripts/branch-guard-hook.mjs`; the hook reads `CCX_EXPECTED_BRANCH` from the inherited spawn env, and on any `git commit` (or other commit-creating git subcommand) whose resolved branch differs from that value it returns `permissionDecision: "deny"` so the commit never runs. Because the hook keys off the env var, manual `/ccx:loop` runs (which never set `CCX_EXPECTED_BRANCH`) are unaffected — the hook no-ops and allows every command. Hooks run outside the model context, so the guard costs zero tokens.

   **Node preflight.** The hook command is `node "<HOOK_SCRIPT>"`, so it needs a `node` on PATH. Resolve `BRANCH_GUARD_SETTINGS_ARG` ONCE at the top of the dispatch run (cache it; it is the same for every worker): if `command -v node` succeeds, `BRANCH_GUARD_SETTINGS_ARG="--settings \"<STATE_DIR>/workers/<TASK.id>.settings.json\""` (per-task path substituted at render time) and the settings file is generated per below; if `node` is absent, set `BRANCH_GUARD_SETTINGS_ARG=""` (empty — the spawn omits `--settings`), skip settings-file generation, and log ONE stderr warning: `ccx: node not found — branch-guard hook disabled for this run (workers commit unguarded)`. This degrades gracefully rather than installing a hook that would fail on every worker Bash call. In practice `node` is present whenever the `claude` CLI is (the CLI is itself a Node program the supervisor already depends on), so the warning path is a belt-and-suspenders fallback, not the common case. `CCX_EXPECTED_BRANCH` is still forwarded regardless; without the hook it is simply an unread env var.

   **Generate the settings file BEFORE the spawn** (it must exist when `--settings` resolves it) when the node preflight passed. Resolve the hook script's absolute path from the plugin root — `HOOK_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/branch-guard-hook.mjs"` — and bake that resolved absolute path into the file rather than emitting a `${CLAUDE_PLUGIN_ROOT}` placeholder: `CLAUDE_PLUGIN_ROOT` is set in the supervisor's plugin-command context but is NOT guaranteed in the worker's hook-execution env, so a placeholder would fail to expand at hook time. Write `<STATE_DIR>/workers/<TASK.id>.settings.json` (the `workers/` directory already exists from P0) with exactly this shape, substituting the resolved absolute `HOOK_SCRIPT`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             { "type": "command", "command": "node \"<HOOK_SCRIPT>\"" }
           ]
         }
       ]
     }
   }
   ```

   `--settings` merges over the worker's normal settings hierarchy (it overrides only the keys it names and leaves the rest file-based), so injecting `hooks.PreToolUse` here does not disturb the worker's other configuration. **Design choice — generated file over inline JSON:** a per-task file under `STATE_DIR/workers/` keeps the JSON out of the already-dense env-prefixed spawn line (no fragile shell-escaping of a brace-and-quote blob), gives the operator an auditable artifact of exactly which hook each worker received alongside its `<TASK.id>.log`, and is referenced by a single stable path. This mirrors the log-path rationale below.

   The log path stays under `STATE_DIR/workers/` (the supervisor's log directory created in P0), NOT under the worktree — worker logs survive worktree teardown and the supervisor's P3 report references this absolute path.

   `<TASK_START_TIER.claude.model>` comes from the active ladder. `CLAUDE_EFFORT_ARG` is either `--effort <TASK_START_TIER.claude.effort>` or an empty string when `claude.effort` is absent. The `--loops <WORKER_LOOPS>` token inside `$DISPATCH_PROMPT` (see §P2.2) is an independent axis — it controls the worker's internal review-fix cycle cap and therefore how far Codex can advance through the ladder. The same `CCX_MODEL_LADDER_PATH` and `CCX_MODEL_START_TIER` env vars in the spawn template above are forwarded in BOTH worker modes — conductor mode's adaptive per-cycle tier policy also reads the active ladder, so the duet branch and the conductor branch share an identical spawn env. Only the leading `--duet` / `--conductor` flag inside `$DISPATCH_PROMPT` differs.

   `<TASK_FALLBACK_MODEL_ARG>` is either `--fallback-model <TASK_FALLBACK_MODEL>` or an empty string when the walk-down in resolution rule (c) above finds no cheaper tier with a different Claude model. `--fallback-model` lets a single dispatched `claude -p` process survive a primary-model overload (e.g. Opus capacity errors during a large `--parallel` burst) by transparently falling back to the next-cheaper ladder rung's Claude model instead of the worker failing outright. This is independent of the worker's own in-session ladder-advancement logic (duet/conductor per-cycle tier escalation, which stays pinned to `TASK_START_TIER` for Claude per the existing contract) — `--fallback-model` only engages when the `claude` CLI's own retry/overload handling decides the primary model is unavailable, not on every request, and it never changes which model the worker driver believes it is running.

   `<MAX_WORKER_BUDGET_USD_ARG>` is `--max-budget-usd <MAX_WORKER_BUDGET_USD>` when `--max-worker-budget-usd` was supplied at supervisor invocation, else an empty string. Unlike `<TASK_FALLBACK_MODEL_ARG>`, this is a single run-level value resolved once at argument-parse time (§P2 state map) rather than per-task, and the same resolved string is reused verbatim across every dispatch in the run. When set, it turns a worker's `budget-exhausted` exit from a heuristic decision (the driver ran out of `--loops N` cycles) into a real CLI-enforced hard ceiling: `claude -p` itself aborts the process once the dollar cap is hit, independent of which cycle the worker driver is on. See "Design note — `--max-worker-budget-usd` placement" above for why this is a supervisor flag rather than a ladder field or `STATE_DIR` config knob.

   `--append-system-prompt "<APPEND_SYSTEM_PROMPT_TEXT>"` is a compaction-resilience anchor: unlike the `$DISPATCH_PROMPT` user turn, system-prompt content is re-sent on every request and survives Claude Code's lossy auto-compaction, so this is where the facts a compacted worker must never lose belong. `<APPEND_SYSTEM_PROMPT_TEXT>` is a fixed, per-task-substituted template (kept under ~800 chars — it is paid on every request) carrying: the task id, the brief path (read-only per the M9 brief-read exception), the duet/conductor convergence rule (stop only after two consecutive approvals from two different reviewers), the automatic edited-path capture that Phase 4 uses for staging, and the commit-on-worker-branch rule:

   ```
   ccx duet/conductor worker anchors (survive compaction): task=<TASK.id> brief=<STATE_DIR>/tasks/<TASK.id>.md (read-only, M9 brief-read exception). Convergence = two consecutive approvals from two DIFFERENT reviewers (Claude and Codex); other exits (stuck, cycle cap, abort) still apply. Track every file you create/edit/delete in EDITED_PATHS (snapshot-diff accounting) — Phase 4 stages those paths (plus any Phase-0-accepted pre-existing paths) with git add -- <path>. Commit only on branch duet/<TASK.id>.
   ```

   This flag is unconditional (no `_ARG` empty-string branch) and applies identically to both `--duet` and `--conductor` dispatches, since both worker modes share this single spawn template per the shared-spawn-env note above — only the leading `--duet` / `--conductor` token inside `$DISPATCH_PROMPT` differs between modes.

   Build `DISPATCH_PROMPT` per §P2.2. Use a shell heredoc into a variable so embedded newlines and `<` characters survive unquoted:

   ```bash
   DISPATCH_PROMPT="$(cat <<'CCXPROMPT'
   ...content...
   CCXPROMPT
   )"
   ```

   Record the returned shell id as `SHELL_ID`.

5. **Verify the spawn is live** before persisting any `assigned` state — committing `status: "assigned"` to BOARD when the worker never actually started would strand the task, because future supervisor runs exclude `assigned` rows from dispatch. Two-step check:
   - Sleep 3 seconds (`sleep 3`) to let `claude -p` get past initial argv parsing and config load.
   - Use `BashOutput` on `SHELL_ID`. If the shell has already terminated AND its exit status is non-zero (or log is empty + exited), treat as **spawn failure**, EXCEPT when `MAX_WORKER_BUDGET_USD` is non-null AND the log matches the same budget-cap marker regex Step B step 2's budget-capped branch checks for — a `--max-worker-budget-usd` cap set low enough to bite on the very first API call can trip within this 3-second window, and the generic spawn-error path below would misreport a real, well-understood signal as an opaque crash:
     - **Budget-capped within the liveness window:** run the same `grep -qE '"subtype"[[:space:]]*:[[:space:]]*"error_max_budget_usd"|^Error: Exceeded USD budget' "<STATE_DIR>/workers/<TASK.id>.log"` check. On a match:
       - Do NOT commit an `assigned` BOARD update (the worker never ran long enough to do anything worth resuming).
       - Tear down `<worktree_path>` and `duet/<TASK.id>` AND purge the persisted Claude session with the same three commands as the spawn-failure branch below (`git worktree remove` + `git branch -D` + `claude project purge "<worktree_path>" -y`) — the task never entered `RUNNING`, so §P2.5 (which expects a live `RUNNING` entry) cannot run its own worktree/session cleanup for this case, making this the only cleanup path for the liveness-window budget-cap exit.
       - Record an in-memory BOARD update: `status: "blocked"`, `exit_status: "budget-exhausted"`, `notes: "worker hit the --max-worker-budget-usd cap (claude -p aborted the run) during the spawn liveness window, before any commit; see STATE_DIR/workers/<TASK.id>.log. Raise --max-worker-budget-usd (or omit it) and re-run, then flip status to pending."` — the same remediation text §P2.5 step 4 uses for the in-flight `budget-capped` signal, so the operator sees one consistent message regardless of which check caught it.
       - Append `<TASK.id>` to `BLOCKED_IDS` (step D persists it).
       - Continue the outer slot-fill loop; do not spawn a replacement in the same pass.
       - **Remove `<TASK.id>` from `PENDING_POOL`** per the pool-removal rule.
     - **Otherwise (generic spawn failure):**
       - Do NOT commit an `assigned` BOARD update.
       - **M8a — tear down the pre-created worktree and branch.** Step 3a created `<worktree_path>` and `duet/<TASK.id>` before this liveness check ran; on spawn failure those artifacts MUST be removed so a future supervisor run (after the human fixes the underlying config/binary issue and flips the row back to `pending`) does not trip Step A step 1b's stale-artifact gate and re-block the task on phantom state from a dead spawn:
         ```bash
         git worktree remove --force "<worktree_path>" 2>/dev/null
         git branch -D "duet/<TASK.id>" 2>/dev/null
         claude project purge "<worktree_path>" -y 2>/dev/null || true
         ```
        Best-effort `2>/dev/null` matches the worker-finish cleanup contract; if either git operation fails (worktree busy, branch protection) the next supervisor run still hits stale-artifact, but the notes string below tells the human exactly which manual commands to run. The `claude project purge` line is required here for the same reason Step B step 5 and §P2.5 step 2 carry it: with `--no-session-persistence` removed (Step A step 4's resume-redispatch contract), a `claude -p` that made even one API call inside the 3s liveness window persists project/session state that lives OUTSIDE the worktree — and because this task never enters `RUNNING`, neither Step B step 5 nor §P2.5 will ever purge it. Purging here is the only cleanup path for a liveness-window terminal exit, so the persisted session never outlives the blocked task.
       - Record an in-memory BOARD update: `status: "blocked"`, `exit_status: "spawn-error"`, `notes: "claude -p exited immediately — see STATE_DIR/workers/<TASK.id>.log. Worktree/branch cleanup attempted; if 'git worktree list' or 'git branch --list duet/<TASK.id>' still show artifacts, remove manually before re-running."`.
       - Append `<TASK.id>` to `BLOCKED_IDS` (step D persists it).
       - Continue the outer slot-fill loop; do not spawn a replacement in the same pass.
       - **Remove `<TASK.id>` from `PENDING_POOL`** per the pool-removal rule — the in-memory BOARD is now `blocked` but not yet persisted, so A1 would otherwise re-select this task and re-attempt the spawn.
   - Otherwise the shell is running (or completed with exit 0 — exceedingly unlikely for a Codex-gated worker in 3 seconds, but also not a failure). Proceed.
6. **Persist the `assigned` state**:
   - In-memory edit: set the BOARD row's `status: "assigned"`, `worktree: "<worktree_path>"`, `branch: "duet/<TASK.id>"`, `started_at: "<STARTED_AT from step 4>"`, `attempts: 1`. The `worktree` field carries the resolver's output verbatim — the absolute path under `<STATE_DIR>/worktrees/`. Do NOT re-sample "now" here; reuse the `STARTED_AT` captured pre-spawn so the worker-close classifier window covers the entire lifetime of the worker including the 3s liveness check.
   - Write the modified BOARD content to `STATE_DIR/BOARD.md` (read-YAML-block → modify in memory → re-emit → replace the exact YAML block). Preserve sibling rows byte-for-byte. The BOARD lives outside the working tree, so no per-dispatch commit is produced (no `supervisor:` subjects on the integration branch). The next-pass scheduler still sees the row as `assigned` because the supervisor reads its own BOARD from `STATE_DIR/BOARD.md`, not from `git show HEAD -- BOARD.md`.
7. Write `RUNNING[TASK.id] = { shell_id: SHELL_ID, worktree_path: "<worktree_path>", task_key: "<task_key>", branch: "duet/<TASK.id>", log_path: "STATE_DIR/workers/<TASK.id>.log", started_at: STARTED_AT, scope_include: TASK.scope.include, attempts: 1, start_tier_alias: TASK_START_ALIAS, worker_mode_resolved: TASK_WORKER_MODE, session_id: null, resume_attempts: 0 }` (reuse the SAME `STARTED_AT` captured in step 4; `<worktree_path>` and `<task_key>` come from the worktree-path resolver call in step 3a; `TASK_WORKER_MODE` was resolved in step 4 per the rule in the §P2 state map) AND add `TASK.id` to the `DISPATCHED` set. **M9 T-2 — `task_key` is the basename of `<worktree_path>`** (equal to `TASK.id`) and is used by recovery paths and the Step B step 5 worker-finish cleanup. The `worktree_path` field is the absolute path the resolver returned and is the join key for Step B step 1's `claude agents --json` cwd lookup. The `scope_include` field is a verbatim copy of the BOARD row's glob list captured at dispatch time. The `attempts` field mirrors the BOARD row's `attempts: 1` just written in step 6. `start_tier_alias` records the alias handed to the worker; it is also printed in P3 summaries. `worker_mode_resolved` is the literal string `duet` or `conductor` actually substituted into `$DISPATCH_PROMPT` — it makes the resolved mode auditable in-memory for tasks whose BOARD `worker_mode` was null (inherited from the run-level flag) and is the value the dispatch notice in step 8 and the P0.5 dispatch chat message both read. `DISPATCHED` is never removed from — it's the ownership source of truth for Step B2's filter across the whole run. `session_id` starts `null` (the worker has not emitted its final `--output-format json` envelope yet — Step B step 2 fills it in at exit) and `resume_attempts` starts `0` (no §P2.5 resume has fired yet). Remove `<TASK.id>` from `PENDING_POOL`.
8. Print a one-line dispatch notice: `dispatched <TASK.id> (<TASK.title>) → shell <SHELL_ID>, worker_mode=<RUNNING[TASK.id].worker_mode_resolved>, log <log_path>`. Pre-M6 — also fire the dispatch lifecycle `chat_send` per the table in P0.5 (gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`). The worker's own chat session id is not yet known at this point — its `/ccx:loop --chat` register call fires later inside the spawned process — so the message uses `launching` as a placeholder. A Discord watcher correlates the worker to this supervisor dispatch by matching `T-<id>` across both messages.

### Step B — Drain completions

**M8a — refresh the agent registry once per Step B pass.** Before iterating `RUNNING`, run `claude agents --json` exactly once and parse the result. The JSON shape is an array of `{pid, cwd, kind, startedAt, sessionId, status, name?}` — store it as `AGENTS_BY_CWD: { <absolute-cwd> -> <entry> }` keyed by the `cwd` field. `cwd` is the only field the supervisor controls deterministically at spawn time (PID and `sessionId` are assigned by `claude -p` at spawn time and are not knowable before the worker reports them via `chat_register`), so it is the join key — matching by `branch` is not possible because the JSON does not expose branch. See `docs/supervisor-design.md` for the rationale.

If the `claude agents --json` invocation itself fails — non-zero exit, empty stdout, or the parser rejects the output as non-JSON — STOP with a clear error. Current Claude Code agent registry support is required; do not fall back to shell-id polling.

For each `(task_id, meta)` in `RUNNING`:

1. **Worker liveness check (M8a).** If `M8A_AGENTS_FALLBACK == false`, look up `AGENTS_BY_CWD[meta.worktree_path]`:
   - **Entry present** → the worker is still alive (kind/status/pid are all informational only — presence alone establishes liveness). **Skip this task** for the rest of Step B; the next pass will check again.
   - **Entry absent** → the worker MAY have exited. Before falling through to step 2 below, call `BashOutput` on `meta.shell_id` ONCE as a cross-check and to capture the worker's exit status — record it as `EXIT_CODE`. Two cases:
     - **Bash also reports the shell as exited** → the worker is genuinely done. Fall through to step 2 with `EXIT_CODE`; the classifier splits `approved` (`EXIT_CODE == 0` + new commits) from `error` (`EXIT_CODE != 0`).
     - **Bash reports the shell as still running** → the registry snapshot raced with the worker's startup (e.g. `claude -p` hasn't registered itself yet, cwd normalization difference, or a transient registry omission). The worker is alive and may still be actively writing to the worktree. **Skip this task** for the rest of Step B and re-check on the next pass — classifying as exited and entering the recovery/block paths would tear down the worktree underneath a live `claude -p`, potentially spawning a duplicate attempt on top of in-flight worker edits. The next pass's claude agents --json refresh will most likely show the entry; if it persistently does not, the eventual Bash exit will resolve the race cleanly.

   The registry only reports liveness (presence/absence), not exit code, which is why the BashOutput exit-status read is mandatory even on the registry-says-absent path. Without it, a worker that crashed AFTER making a commit would be merged as approved work.

   If the registry check cannot run, abort the supervisor before classifying any worker. Shell-id polling is intentionally not supported in the first shipped product.

   The {running / approved / stuck / cycle-cap / budget-capped / crashed / unknown} taxonomy maps onto the existing exit_status vocabulary via step 2's branches plus §P2.5's stuck/cycle-cap/budget-capped sub-classifier — no new BOARD `exit_status` value is introduced (budget-capped still reports as `budget-exhausted`, see step 2's **budget-capped** branch below).

   The `shell_id` field stays in `RUNNING` records regardless of which branch fires: Step C's adaptive-polling primitive (pre-M6) still reads `BashOutput` on `shell_id` to detect new worker output, the absent-entry exit-code read above also relies on it, and `STATE_DIR/workers/<task_id>.log` is the user-facing artifact for post-mortem. Only the exit-**detection** branch moves off PID-style polling; the log-correlation handle persists.
2. If exited, first **capture the worker's `session_id`** (best-effort — needed by §P2.5's resume-redispatch path), then classify the outcome.

   **Capture `session_id`.** The worker was spawned with `--output-format json` (Step A step 4), so its log ends with a single `--output-format json` result envelope carrying a top-level `session_id`. Because the spawn redirects `2>&1` into the log, stray stderr may surround the envelope, so extract the field directly rather than JSON-parsing the whole file:
   ```bash
   grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' "<STATE_DIR>/workers/<task_id>.log" \
     | tail -1 | sed -E 's/.*"([^"]+)"$/\1/'
   ```
   Store the last match on `RUNNING[<task_id>].session_id`. This best-effort capture never fails the classification: on no match (worker crashed before emitting the envelope, log truncated, `--output-format` overridden) leave `session_id` at `null` — §P2.5 then falls back to the fresh-dispatch/block path per the brief's "never block a task on the optimization" decision. Capture happens here (once, at exit) rather than during the run because `session_id` is only present in the final envelope.

   Then classify the outcome using two repo-state signals (the M1 completion-detection subset — broker `chat_close` state is currently ignored because the integration-branch commit is the authoritative "approved" signal; adding `chat_close` as a cross-check is a later milestone):

   ```bash
   git rev-parse --verify "refs/heads/duet/<task_id>" 2>/dev/null
   git log "<INTEGRATION>..refs/heads/duet/<task_id>" --format=%H | head -1
   ```

   - **approved** — exit code 0 AND at least one new commit on `duet/<task_id>` relative to `INTEGRATION`.
   - **budget-capped** — only checked when `MAX_WORKER_BUDGET_USD` is non-null for this run (skip this check entirely otherwise — no wasted log read on a flag that was never passed). Exit code non-zero AND the worker log matches the budget-cap marker regex:
     ```bash
     grep -qE '"subtype"[[:space:]]*:[[:space:]]*"error_max_budget_usd"|^Error: Exceeded USD budget' "<STATE_DIR>/workers/<task_id>.log"
     ```
     `claude` CLI output for a `--max-budget-usd` abort has been observed in two shapes across versions: `claude` 2.1.202 (verified directly) exits 1 with a result envelope carrying `{"type":"result","subtype":"error_max_budget_usd", "is_error":true, ..., "errors":["Reached maximum budget ($<n>)"]}` — the `error_max_budget_usd` subtype marker is present whether the run emitted `--output-format stream-json` (as older spawns did) or the plain `--output-format json` the current spawn template uses, but the two formats space the JSON differently (compact `"subtype":"..."` versus pretty-printed `"subtype": "..."`), so the regex allows optional whitespace around the colon (`"subtype"[[:space:]]*:[[:space:]]*"error_max_budget_usd"`) to match both; `docs/m10-poc-notes.md` §"Quirks" item 4 (recorded against `claude` 2.1.152, six weeks earlier) documents exit 1 with plain-text `Error: Exceeded USD budget (N)` instead. Match both so this check keeps working across the CLI versions operators may have installed rather than silently depending on exactly the version this task happened to verify against. This check MUST run BEFORE the generic **error** branch below — a `--max-budget-usd` abort is a non-zero exit like any other crash, but it is a real signal, not a crash, and the operator's remediation (raise the cap) is completely different from "go read the crash log." Hand off directly to §P2.5 with `signal="budget-capped"` — do NOT fall through to **error** or **no-commit** — because `claude -p` exits non-zero the moment the CLI itself enforces the cap, so the worker never reaches its own `chat_close` call and the existing worker-close sub-classifier (step 4 below, which only fires on exit code 0) never gets a chance to run.
   - **no-commit** — exit code 0 but no new commits. Worker exited via filtered-unapproved, stuck, cycle-cap (`/ccx:loop`'s `budget-exhausted` status), or user cancellation — `/ccx:loop`'s Phase 4 auto-commit gate correctly blocked the commit. Step 4 below splits this bucket further; the rest mark `blocked`.
   - **error** — non-zero exit code (crash, invalid args, missing `claude -p`) that did NOT match **budget-capped** above. Mark `blocked`.

3. For **approved**, attempt a squash merge onto the integration branch.

   ```bash
   PRE_MERGE_DIRTY="$(git status --porcelain)"
   if [ -n "$PRE_MERGE_DIRTY" ]; then
     # Caller: block as merge-aborted. Do not attempt a merge or rollback
     # when the integration checkout is dirty.
     :
   elif git merge --squash --no-edit "duet/<task_id>"; then
     UNMERGED="$(git ls-files -u)"
     if [ -z "$UNMERGED" ]; then
       WORKER_FINAL_MSG="$(git log -1 --format=%B "duet/<task_id>")"
       MERGE_MSG_FILE="$(mktemp)"
       printf '%s' "$WORKER_FINAL_MSG" > "$MERGE_MSG_FILE"
       COMMIT_STDERR="$(git commit -F "$MERGE_MSG_FILE" 2>&1 1>/dev/null)"
       COMMIT_RC=$?
       rm -f "$MERGE_MSG_FILE"
       if [ "$COMMIT_RC" -ne 0 ]; then
         git restore --staged --worktree .
         # Caller: block as merge-commit-failed and write the recovery sidecar.
         :
       fi
       # Otherwise: merged.
     else
       CONFLICT_FILES="$(git ls-files -u | awk '{print $4}' | sort -u | tr '\n' ',' | sed 's/,$//')"
       git restore --staged --worktree .
       # Caller: block as merge-conflict.
     fi
   else
     MERGE_STDERR_1="<verbatim stderr of the failed --squash call>"
     UNMERGED="$(git ls-files -u)"
     if [ -n "$UNMERGED" ]; then
       CONFLICT_FILES="$(echo "$UNMERGED" | awk '{print $4}' | sort -u | tr '\n' ',' | sed 's/,$//')"
     else
       CONFLICT_FILES=""
     fi
     git restore --staged --worktree .
     # Caller: CONFLICT_FILES non-empty => merge-conflict; empty => retry once,
     # then merge-aborted if the retry also refuses without conflicts.
   fi
   ```

   Outcomes:
   - **Clean squash + commit succeeds**: mark the task `merged` with `exit_status: "approved"`.
   - **Conflict**: capture `CONFLICT_FILES` before rollback, mark `blocked` with `exit_status: "merge-conflict"`, remove the worktree, and preserve the worker branch for human triage.
   - **Non-conflict merge refusal**: retry `git merge --squash` once in the same Step B iteration. If the retry refuses again without unmerged paths, mark `blocked` with `exit_status: "merge-aborted"`.
   - **Clean squash but commit fails**: roll back with `git restore --staged --worktree .`, mark `blocked` with `exit_status: "merge-commit-failed"`, write `STATE_DIR/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt`, set `STOP_DISPATCHING = true`, and drain already-running workers before exiting.

   The rollback path is always `git restore --staged --worktree .`; never use `git reset --hard` here.

4. For **no-commit**: check whether this was a stuck-finding exit or a cycle-cap exit before marking blocked.

   **Worker close sub-classification.** `/ccx:loop` calls `chat_close({status: "stuck"})` when stuck-finding detection fires, `chat_close({status: "budget-exhausted"})` when it runs out of review-fix cycles without approval, and `chat_close({status: ...})` with other verbs (`filtered-clean`, `aborted`) for the remaining `no-commit` reasons. The supervisor queries the broker's recent-closures ring buffer to distinguish these. If the latest closure record for `branch == "duet/<task_id>"` shows `status == "stuck"` OR `status == "budget-exhausted"`, hand the task to §P2.5 so it blocks with a precise reason. Any other status — or any failure to query the buffer — falls through to the generic no-commit handling below.

   ```
   closures = try mcp__ccx-chat__chat_supervisor_recent_closures({
                cwd: meta.worktree_path,
                branch: "duet/<task_id>",
                since: meta.started_at,
                limit: 16,
              })
              catch → skip to generic no-commit handling
   scopedClosures = closures.closures sorted by `at` ascending
   latest = last entry of scopedClosures, or null if none
   if latest != null AND latest.status == "stuck":
       hand off to §P2.5 with signal="stuck" — do NOT fall through
   elif latest != null AND latest.status == "budget-exhausted":
       hand off to §P2.5 with signal="cycle-cap" — do NOT fall through
   else:
       fall through to generic no-commit handling below
   ```

   **Stuck-vs-cap precedence.** When a worker's final three review-fix cycles all shared a single stuck finding AND `--worker-loops` was exhausted, `/ccx:loop` reports the exit as `stuck` (its stuck detector fires first and overrides the budget-exhausted label). The supervisor inherits that decision — the closure record will show `status: "stuck"`, so §P2.5 blocks the task with `exit_status: "stuck"` rather than `"budget-exhausted"`. This is the expected resolution of the ambiguity (see `docs/supervisor-design.md`) and matches the design doc's "stuck takes precedence" rule. Model strengthening happens inside `/ccx:loop --duet` by cycle for Codex; §P2.5 itself never re-dispatches or bumps a tier.

   **Server-side filter parameters are mandatory for M5 scale.** Pass `cwd`, `branch`, and `since` as shown — do NOT call the tool with an empty params object and filter client-side. The broker's ring buffer can hold up to 8192 entries (24h of closures across every concurrent session on the host); shipping the whole buffer through MCP on every Step B `no-commit` exit would routinely exceed tool/model output budgets, at which point the supervisor's Step B query falls back to the generic no-commit path and M5 silently stops working on realistic workloads. The broker applies these filters identically to the client-side rules described in "Three-dimension scoping" below, so the returned `closures` list is already scoped to this worker's attempt — the supervisor only needs to sort by `at` and pick the tail entry. `limit: 16` is generous for the single-worker single-attempt case (one expected entry) while still tolerating any transient over-reporting.

   **Three-dimension scoping (all required).** The closure ring buffer is broker-wide — shared across every `/ccx:supervisor` and `/ccx:loop` session on the host, and retained in memory across supervisor runs. A loose match would pick up stale entries that have nothing to do with this worker's actual exit. The three filters below are independent and all must apply:

   1. **`cwd == meta.worktree_path`** — the broker is host-global, so two checkouts of different repos (or the same repo under two checkout paths) can each launch a worker whose branch is `duet/T-1`. Without this filter, a stuck exit in repo A could misclassify a worker in repo B. `meta.worktree_path` was captured at dispatch time (Step A step 7) as the absolute path returned by the worktree-path resolver (`<STATE_DIR>/worktrees/<task_key>/`). That path is exactly the `cwd` the supervisor passed to `cd "<worktree_path>" && claude -p ...` in Step A step 4, which is also the `cwd` the worker process inherits and reports via `claude agents --json`. Exact-equality on cwd scopes the match to this supervisor's repo unambiguously.

   2. **`branch == "duet/<task_id>"`** — obvious task-level scoping.

   3. **`at >= meta.started_at`** — closures survive broker restarts within the in-memory ring (they do not survive a broker process restart, but they survive across `/ccx:supervisor` invocations as long as the broker stays alive). A rerun of the same task id after a prior run could otherwise hit an old `stuck` closure from the prior run if the current worker exits `no-commit` without ever calling `chat_close` (broker unreachable, worker crash-before-close, etc.) — the ring buffer would still hold the prior run's `stuck` entry and the classifier would pipe the current fresh `no-commit` into §P2.5 even though THIS attempt never reported stuck. `meta.started_at` was captured at dispatch time and is guaranteed to be later than every closure from a prior run on the same branch. `at` and `started_at` are both UTC ISO 8601 strings — lexicographic comparison is safe because UTC ISO 8601 is monotonic.

   **Latest-match rule (on the scoped set).** After all three filters, the lookup MUST pick the most recent remaining closure and then check `status in {"stuck", "budget-exhausted"}` on THAT single record — NOT scan for any stuck or budget-exhausted entry in the scoped set. A loose "find any stuck/cap in the scoped set" match could route an unrelated earlier close into §P2.5 even though the live exit was not stuck or cycle-cap. Sorting the scoped set by `at` ascending and taking the tail entry is the contract; equivalently, `max(scopedClosures, key = at)`.

   Rationale for the fallthrough on query failure: sub-classification is best-effort. If the broker is in Discord-only mode, the `chat_supervisor_recent_closures` tool is unavailable and the supervisor degrades to the generic `no-commit` block. No data is lost.

   **Tool-availability gate.** Before the first query, verify `mcp__ccx-chat__chat_supervisor_recent_closures` is in the session's available tool surface (same check Step B2 performs for `chat_supervisor_poll`). If absent, set a run-level flag `RECENT_CLOSURES_DISABLED = true`, log once `worker close sub-classifier disabled: chat_supervisor_recent_closures tool unavailable`, and skip every subsequent per-task recovery query for the remainder of the run. This mirrors Step B2's `SKIP_B2` pattern.

   **Stale-broker degradation (call-time safety net).** Even when the tool IS advertised, a stale detached broker from an older install may be holding the socket. When the supervisor's query errors with a message matching `requires a newer ccx-chat broker` or `unknown op: supervisorRecentClosures` (substring, case-insensitive), treat that as equivalent to the tool being unavailable: set `RECENT_CLOSURES_DISABLED = true`, log once `worker close sub-classifier disabled: ccx-chat broker is out of date — restart it with 'pkill -f ccx-chat/broker.mjs' and re-run the supervisor`, and fall through to the generic no-commit handling for this task and every subsequent no-commit task this run.

   **Generic no-commit handling** (reached when the worker-close sub-classifier does not trigger): append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "no-commit"`, `notes: "see STATE_DIR/workers/<task_id>.log"`. (`PENDING_POOL` already has this task removed from Step A step 7; the pool-removal rule requires nothing further here.)

   **For error:** append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "error"`, `notes: "see STATE_DIR/workers/<task_id>.log"`. The worker-close sub-classifier is NOT consulted for `error` outcomes — a non-zero shell exit means the worker crashed before it could call `chat_close`, so the closure ring buffer has no entry to examine.

5. **M9 T-2 + T-4 — worker-finish worktree cleanup, branch deletion gated on the merged exit** (BEFORE removing from `RUNNING`, so `meta.worktree_path` is still readable). The supervisor removes the external worker worktree (T-2) and deletes the `duet/T-X` branch ref after a worker FINISHES SUCCESSFULLY (T-4 — branch deletion on the merged exit only). **Scope of this step — normal Step B terminal outcomes ONLY.** Reaches here when Step B step 2/3/4 classified the task as: `merged`, `merge-conflict`, `merge-aborted`, `merge-commit-failed`, generic `no-commit` (step 4 with NO §P2.5 sub-classifier handoff), or `error` (step 4 non-zero shell exit).

   **Always:** remove the worker's worktree, then purge the worker's persisted Claude session state.
   ```bash
   git worktree remove --force "<meta.worktree_path>" 2>/dev/null
   claude project purge "<meta.worktree_path>" -y 2>/dev/null || true
   ```
   Idempotent by construction: `--force ... 2>/dev/null` silently no-ops on a missing path, so transient FS oddities (a worktree directory already gone for unrelated reasons, a removal racing another process) never crash this step. NEVER reconstruct the path from a literal — the resolved path lives in `meta.worktree_path`. The `claude project purge` line deletes the resumable session the removed `--no-session-persistence` flag now leaves on disk (see Step A step 4's resume-redispatch contract — sessions live outside the worktree, so worktree removal alone would leak them); it is best-effort (`|| true`) so a missing project entry never fails cleanup.

   **T-4 branch deletion — ONLY on the `merged` exit, with verification.** A successful merge unconditionally deletes `duet/<task_id>` AFTER the worktree-remove. The deletion's stderr is captured (NOT discarded with `2>/dev/null`) so the supervisor can detect failures — branch protection enforcing delete restrictions, a hook rejecting the delete, a race with a peer process — and surface them rather than silently leaving `duet/<task_id>` in place.
   ```bash
   BRANCH_DELETE_ERR="$(git branch -D "duet/<task_id>" 2>&1 1>/dev/null)"
   BRANCH_DELETE_RC=$?
   if [ "$BRANCH_DELETE_RC" -ne 0 ] || git rev-parse --verify --quiet "refs/heads/duet/<task_id>" >/dev/null; then
     # Delete failed OR succeeded according to its exit code but the
     # ref still resolves (e.g. a hook denied the change after `git
     # branch -D` reported success — rare but observed under reflog
     # protections). Both shapes are invariant 5 violations.
     #
     # The merge commit is already on the integration branch — this
     # is the post-merge step, not the pre-merge gate — so the task's
     # exit_status stays `approved` and MERGED_IDS already includes
     # <task_id>. What we need to do is (a) record the cleanup
     # failure on the merged row's `notes` field so the P3 report
     # surfaces it inline with the merge result, and (b) keep a
     # synchronous recovery breadcrumb the operator can act on.
     #
     # Append to (or create) STATE_DIR/supervisor-branch-residue-<SUPERVISOR_RUN_ID>.txt
     # — a DEDICATED sidecar distinct from the merge-commit-failed
     # recovery file. Step D's merge-commit-failed cleanup deletes
     # `supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` on a Step D
     # success ("the sidecar is obsolete (the Step D commit subject
     # already records every blocked id...)"), which would delete a
     # branch-delete breadcrumb sharing that filename even though the
     # branch is still leaking. Using a separate per-run filename
     # keeps the two recovery surfaces independent: Step D never
     # touches `supervisor-branch-residue-*.txt`, so the breadcrumb
     # survives every Step D outcome until the operator manually
     # cleans it up after running `git branch -D` themselves. Format:
     #
     #   Run: <SUPERVISOR_RUN_ID>
     #   Cause: branch-delete-after-merge-failed for <task_id> on integration branch <INTEGRATION>
     #   Merged commit: <git rev-parse HEAD short SHA — the squash/ff/no-ff commit just created>
     #   Last git stderr: <verbatim BRANCH_DELETE_ERR, single-line>
     #
     #   Required manual recovery:
     #   1. Inspect the branch protection or hook that rejected `git branch -D duet/<task_id>`.
     #   2. Once resolved, run: git branch -D duet/<task_id>
     #   3. Delete this file once every listed branch is gone: rm STATE_DIR/supervisor-branch-residue-<SUPERVISOR_RUN_ID>.txt
     #
     # Mutate the merged row's stashed notes (in-memory before Step D
     # persists) to include: `branch-delete-after-merge failed: <first
     # 200 chars of BRANCH_DELETE_ERR, single-line> — see
     # STATE_DIR/supervisor-branch-residue-<SUPERVISOR_RUN_ID>.txt`.
     # The row's status / exit_status do NOT change (the merge
     # succeeded); only `notes` records the cleanup residue. The
     # sidecar path here is DISTINCT from the merge-commit-failed
     # sidecar (`supervisor-recovery-*.txt`) precisely so a Step D
     # success that cleans up the latter does not collaterally delete
     # the former.
     #
     # P3's Merged section detects rows whose notes carry the
     # `branch-delete-after-merge failed:` prefix and prints the
     # sidecar path + the manual recovery command for each. Do NOT
     # set STOP_DISPATCHING — a single failed branch delete is not
     # a per-supervisor failure; the merge itself succeeded.
     :
   fi
   ```
   **Every other reachable exit_status preserves the branch** — `merge-conflict` and `merge-aborted` need the branch for human conflict resolution; `merge-commit-failed` is paired with the recovery sidecar that explicitly states "Worker branch `duet/<task_id>` is INTACT and contains the approved diff"; generic `no-commit` and `error` leave the branch for log/commit triage. T-4 only adds deletion on the merged exit, never removes the preservation on blocked exits.

   §P2.5 may classify `stuck` / `budget-exhausted` before this cleanup step, but terminal cleanup remains owned here so branch preservation rules stay uniform.

6. Remove `task_id` from `RUNNING`. Also `delete LAST_OUTPUT_SEEN[meta.shell_id]` so the Step C probe map cannot grow unbounded across a long-running supervisor session (pre-M6).
7. Print a one-line completion notice summarizing outcome + duration + log path. Pre-M6 — if the task just transitioned to `merged` fire the merge lifecycle `chat_send`; if it transitioned to `blocked` (any `exit_status` including `stuck`, `budget-exhausted`, `merge-conflict`, `merge-aborted`, `merge-commit-failed`, `no-commit`, `error`, `stale-artifact`, `spawn-error`) fire the block lifecycle `chat_send`. Both gated on `CHAT_SESSION_ID && !CHAT_DEGRADED` per the table in P0.5. Never emit both for the same task-completion event.

### Step B2 — Answer supervisor asks

Before the first iteration of the scheduling loop runs Step B2, initialize two in-run flags — `SKIP_B2 = false` and `B2_TRANSIENT_STREAK = 0` — and load `AUTO_ESCALATE_AFTER_SEC` from `config.json` (see "Pre-loop initialization" below). Once `SKIP_B2` is set to `true` (either definitively via a "not in supervisor mode" response, or after sustained transient failures — see step 1), every subsequent iteration's Step B2 is a no-op until the run ends.

**Pre-loop initialization (done once per supervisor run, before the scheduling loop starts):**

- Resolve the broker home the same way the broker does: `CCX_CHAT_HOME` env var if set, else `~/.claude/ccx-chat` (see `plugins/ccx/mcp/ccx-chat/paths.mjs`). Shell: `CCX_CHAT_HOME="${CCX_CHAT_HOME:-$HOME/.claude/ccx-chat}"`.
- Read `"$CCX_CHAT_HOME/config.json"` if present and set `AUTO_ESCALATE_AFTER_SEC = config.supervisor.autoEscalateAfterSec`; fall back to `60` when the field or file is absent (matches `DEFAULT_AUTO_ESCALATE_SEC` in `plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs`). The broker's own startup validation clamps to `[5, 3600]`, so M3 does not re-clamp.
- **Drift warning.** The broker reads `config.json` only at startup. `config.json` is therefore an operator-facing hint, not a safety invariant. §P2.3's race cutoff leaves a 3-second buffer and the broker's own auto-escalate timer is the ultimate backstop. Instruct operators to restart the broker after editing `autoEscalateAfterSec` so the two stay in sync — M3 does NOT reload config mid-scheduling-loop, matching the broker's own single-read semantics.

**Per-iteration Step B2:**

1. If `SKIP_B2 == true`, skip Step B2 entirely and go to Step C. Otherwise, first verify that the `mcp__ccx-chat__chat_supervisor_poll` tool is available in this session's tool surface (check the available-tools list — if `/ccx:chat-setup` has not registered the `ccx-chat` MCP server, the supervisor tools are absent entirely). If the tool is NOT available, log once to stderr `M3 Step B2 disabled: ccx-chat MCP not registered (run /ccx:chat-setup). Worker asks will reach humans via the broker's auto-escalate path, if any.`, set `SKIP_B2 = true`, and skip to Step C. Matches the tool-availability check `/ccx:loop` Phase 0.7 performs for its own chat bridge.

2. Call `mcp__ccx-chat__chat_supervisor_poll` with `{}`. This ONE poll call serves two purposes: it probes whether the broker is in supervisor mode, and it returns the list of queued asks. Do NOT read `config.json` to gate this — the running broker's state, not the file, is the source of truth.
   - **Success** (a result object, possibly with empty `asks`) → the broker is in supervisor mode. Reset `B2_TRANSIENT_STREAK = 0` (see below). Continue to step 3 with `asks`.
   - **Error message contains `not in supervisor mode`** → the broker is definitively Discord-only (this is not a transient condition — the broker decides its backend at startup and never flips). Set `SKIP_B2 = true`, log once to stderr, and skip to Step C. Worker `chat_ask` calls continue reaching humans via the broker's Discord path.
   - **Any other error** (IPC down, transient reconnect, broker restart window) → treat as transient by default, NOT terminal. Increment a per-run counter `B2_TRANSIENT_STREAK` (starts at 0; resets on any successful poll). Log the error with `B2_TRANSIENT_STREAK` to stderr, then skip to Step C this iteration — the next iteration probes again so a brief broker restart or MCP reconnect does not disable M3 for the whole run. If `B2_TRANSIENT_STREAK >= 20` (about 60s of consecutive failures at the 3s Step C cadence), the broker is likely wedged rather than restarting — set `SKIP_B2 = true`, log the terminal transition once, and stop probing. The broker's own auto-escalate-after-`AUTO_ESCALATE_AFTER_SEC`-seconds timer remains the safety net during the transient window.

3. If `asks` is empty, skip to Step C.

4. **Filter to this supervisor's asks.** Since `chat_supervisor_poll` returns asks for the whole broker queue (every concurrent ccx session on this host, not just this supervisor's workers), this run MUST only act on asks it owns. Ownership is keyed off the **`DISPATCHED` set** — every `<TASK_ID>` this supervisor has ever launched in this run, never removed even after the worker exits or the task gets `merged` / `blocked`. Maintain `DISPATCHED` by adding `<TASK_ID>` in Step A at step 7 (right where `RUNNING[<TASK_ID>]` is populated) and NEVER deleting from it. Reason: a worker can emit `chat_ask` and exit before the next Step B2 poll; its entry will already be out of `RUNNING` by the time we filter, but it is still legitimately our ask to answer. For each returned ask:
   - Read `"$CCX_CHAT_HOME/sessions.json"` (the broker persists its registry there — see `plugins/ccx/mcp/ccx-chat/paths.mjs`; the file has shape `{ sessions: [{ id, label, cwd, branch, ... }], ... }`). Find the entry whose `id == sessionId`.
   - If the entry exists AND its `branch` is `"duet/<TASK_ID>"` for some `<TASK_ID>` in `DISPATCHED`, tag the ask as owned and attribute it to `<TASK_ID>`.
   - Otherwise, the ask is either (a) foreign — owned by a concurrent `/ccx:supervisor` run — or (b) not yet attributable (sessions.json stale or missing, worker just registered and hasn't persisted). **Leave it pending**: do NOT call `chat_supervisor_reply`, do NOT call `chat_supervisor_escalate`, and do NOT write an audit entry for it. The owning supervisor (if any) will handle it on its own poll; if nothing handles it, the broker's auto-escalate-after-`AUTO_ESCALATE_AFTER_SEC`-seconds timer pushes it to Discord. Stealing the ask with our own escalate call would force the foreign supervisor's question to Discord before its real owner could answer it deterministically — silent interference between supervisors. Maintain an in-memory count `foreignAsksSkipped` per run for P3 reporting; do not log per-occurrence to avoid flooding stderr when both supervisors poll on a 3s cadence.

5. If no asks remain after filtering in step 4, skip to Step C.

6. **Do not spend the entire iteration on one ask.** Sort the owned asks by `ageSec` descending (oldest first) and handle at most `len(RUNNING) + 1` per Step B2 pass — the remainder wait one Step C cycle (3s) before the next poll. Rationale: a single slow autonomous-answer decision must not starve completion draining or newly-freed slot-filling for the rest of the run.

7. For each owned ask selected above (the `<TASK_ID>` was attributed in step 4):

   a. **Consult three sources, in order.** Stop at the first source that meets §P2.3's confidence rubric.

      1. **Brief `## Decisions` table** — `Read` `STATE_DIR/tasks/<TASK_ID>.md` (the committed supervisor-owned copy at `REPO_ROOT`, NOT the worktree copy — the worktree copy could have been edited by the worker even though the dispatch prompt forbids it; reading the integration-branch copy keeps supervisor decisions traceable to dispatch-time content). Parse the `## Decisions` section as a YAML-ish list of `- q: "…"` / `  a: "…"` pairs. Match the ask's `prompt` against each `q` semantically — paraphrase is fine, topic drift is not.
      2. **BOARD `## Direction`** — `DIRECTION_TEXT` captured in P1. Match for project-wide policy statements that directly answer the ask (e.g. "prefer stdlib over third-party deps" answers "can I add lodash?").
      3. **Integration-branch worker-commit history** — `git log "<INTEGRATION>" -n 40 --format='%H%x09%s%x09%b'`. Scan each commit's subject + body for lexical hits on the ask's prompt. The squash commit (M9 T-4) uses the worker's final commit message (subject + body, captured via `git log -1 --format=%B "duet/<task_id>"`), so the integration history exposes one commit per task with the worker's tip-commit text. When Tier 3 cannot match the ask, escalate per §P2.3's conservative bias. `--no-merges` is no longer needed (squash produces no merge commits at all). Cite the squash commit SHA (first 8 chars) in the reply; the body line that hit can be quoted verbatim.

   b. **Decide.**
      - **Confident match** (see §P2.3) → call `mcp__ccx-chat__chat_supervisor_reply` with `{askId, reply}`. The reply MUST begin with a one-line source citation — `"From brief Decisions: "`, `"From BOARD direction: "`, or `"From worker-commit <first 8 chars of SHA>: "` — so the worker can push back if the match was wrong.
      - **No confident match** → call `mcp__ccx-chat__chat_supervisor_escalate` with `{askId}`. A human answers on Discord; the reply flows back through the broker automatically.
      - **Explicit refusal** (the ask describes something the brief explicitly forbids, e.g. editing a path outside `scope.include`) → call `mcp__ccx-chat__chat_supervisor_reply` with `{askId, reply: "Refused: <one-sentence reason citing the brief>. Do not proceed — abort via chat_close({status: \"aborted\"}) and surface the blocker in the worker log."}`. Do NOT use `chat_supervisor_close`: that returns `source: "closed"` to the worker, which `/ccx:loop`'s `chat_ask` failure path handles by calling `AskUserQuestion`. Workers dispatched by the supervisor run under `claude -p` where `AskUserQuestion` cannot resolve, so a closed reply would hang the worker or derail it into an aborted cycle. A deterministic refusal reply gives the worker a usable answer it can cite in its own cycle summary.

   c. **Audit.** After the broker tool returns, append ONE JSONL line to `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`. Field schema (all string fields MUST be valid JSON — pass them through a JSON-string encoder before interpolation so embedded quotes, backslashes, and newlines are escaped; raw heredoc interpolation is FORBIDDEN because worker prompts and supervisor replies routinely contain `"` / `\` / newlines):

      ```json
      {"ts":"<UTC ISO 8601>","askId":"<askId>","taskId":"T-<id>","sessionId":"<sessionId>","ageSec":<ageSec at poll>,"prompt":<JSON.stringify(first 200 chars of prompt)>,"decision":"reply|escalate","source":"brief|direction|worker-history|none","citation":<JSON.stringify(source span / commit SHA / q-text) or null>,"reply":<JSON.stringify(first 200 chars of reply) or null>,"brokerOk":<true|false>}
      ```

      Concrete implementation sketch: build the line with `node -e 'process.stdout.write(JSON.stringify({ts:…, prompt:…, …})+"\n")' >> STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` or write a small inline `jq -n` expression — either produces valid JSON regardless of input. If the broker call returned `{ok: false}` (ask already resolved by auto-escalate timer or session cancel), still write the audit line with `brokerOk: false` so the trail is complete. Create the log file the first time it is needed; `STATE_DIR/supervisor-audit/` was created in P0 step 1a by the resolver. Never truncate the file; never use `echo "…"` heredoc interpolation for JSON payloads — it cannot safely encode untrusted strings.

### Step C — Adaptive wait

Wait until either (a) at least one worker in `RUNNING` produces new `BashOutput` lines, or (b) 30 seconds have elapsed since entering Step C, whichever happens first. Then go back to the top of the iteration — **re-evaluate all three exit conditions first** (after A1 recomputes `READY`), then run Steps A → B → B2 in order if none of the three conditions fires. A1 is where newly-unblocked dependents get picked up by a fresh merge; B2 is where supervisor-mode runs drain worker `chat_ask` queues (Discord-only runs skip B2). This iteration shape guarantees the loop cannot spin in any of the documented failure modes:
- (a) all remaining pending tasks depend on `blocked` predecessors → condition 1 fires once `RUNNING` drains.
- (b) `--max-tasks` has been reached with tasks still pending → condition 2 fires once `RUNNING` drains.
- (c) `STOP_DISPATCHING` was set by Step B's merge-commit-failed branch (M4) and `PENDING_POOL` still holds untouched tasks → condition 3 fires once `RUNNING` drains. Without checking condition 3 here, A1 keeps `READY` populated from `PENDING_POOL` and the loop would spin forever in this exact failure mode the M4 path is meant to handle.

**Why adaptive polling, not a fixed sleep.** Pre-M6 replaced an earlier fixed `sleep 3` with this primitive because (a) Claude Code 2.1.x blocks long standalone leading sleeps, and during e2e the supervisor-LLM sometimes deviated from `sleep 3` and emitted `sleep 30` / `sleep 60` instead, hanging the whole scheduling loop; (b) a fixed 3s cadence wakes the loop 20× per minute even when no worker has produced output, which is wasted LLM budget in the long runtime. The adaptive primitive below is robust to both: any overshoot is naturally capped at 30s, and quiet iterations still cost essentially zero because the supervisor is blocked on `BashOutput` probes rather than re-running Steps A/B/B2.

**Algorithm.** Maintain a per-`shell_id` counter `LAST_OUTPUT_SEEN[shell_id]` across iterations; it is the byte length (or line count — whichever `BashOutput` exposes, use byte length by default) of the worker log the last time Step C inspected it. Initialize new entries to the current `BashOutput` length on the first Step C pass after a dispatch in Step A. On every Step C entry:

1. Record `STEP_C_ENTERED_AT = $(date +%s)` (UTC monotonic wall clock via `date` is adequate — precision within ±1s is fine; the 30s cap is a budget, not a deadline).
2. Inner loop (repeat until a break condition fires):
   a. For each `(task_id, meta)` in `RUNNING`, call `BashOutput` on `meta.shell_id`. If its current output length exceeds `LAST_OUTPUT_SEEN[meta.shell_id]`, update `LAST_OUTPUT_SEEN` to the new length and **break out of Step C immediately** — a worker just produced output and Step B is more likely to find a classifiable completion on the next pass than it was 3 seconds ago.
   b. If `($(date +%s) - STEP_C_ENTERED_AT) >= 30`, break out of Step C — the 30s cap prevents Step C from blocking indefinitely in the (unlikely but possible) case that every `RUNNING` worker is silent for the whole window but also has not exited. Even without new output, Step B might still classify a completion (e.g. a worker exits silently), so revisiting the top of the iteration is the right move.
   c. **Sleep exactly 2 seconds** (`sleep 2`, not 3, not 5, not 30 — the short sleep is mandatory because Claude Code 2.1.x blocks long standalone leading sleeps and because 2s is small enough that the 30s cap is reached in a predictable 15 iterations). Then loop back to step 2a.
3. When `RUNNING == {}`, skip the inner loop entirely — there is no worker to watch. In that case Step C reduces to a single `sleep 2` so the loop still yields cooperatively to the OS scheduler, after which the top-of-iteration exit conditions fire (condition 1 or 3, depending on state).
4. When `SKIP_B2 == false` AND the broker is reachable AND `asks` were pending on the most recent Step B2 poll, prefer a shorter inner-loop cap — break the inner loop after 10 seconds instead of 30. Rationale: a pending ask is work the supervisor owes the worker; the 2s `sleep 2` step gives the broker a chance to return additional asks between polls, but sitting on a 30s cap while workers are waiting on the supervisor for a reply stalls every dispatched worker. This is the only branch that deviates from the 30s ceiling.

**Implementation.** Because Step C runs inside the LLM-driven scheduling loop, each iteration of 2a uses `BashOutput` tool calls (one per `RUNNING` entry), and step 2c uses a `Bash` call with literally `sleep 2` — never a joined sleep like `sleep 30 && ...`. Never issue `sleep` with any value other than `2`. Never issue `sleep` from a wrapper that resolves its own duration from a variable (e.g. `sleep $POLL_INTERVAL`); the harness-level sleep-guard inspects the literal argument, and a variable-resolved duration that happens to be large would still block. Do NOT attempt to replace the inner loop with a single blocking `until` one-liner in shell: that would (a) produce a long-running Bash call the LLM cannot inspect for worker output between probes, and (b) lose the per-iteration `BashOutput` checkpointing that `LAST_OUTPUT_SEEN` needs to avoid over-counting stale output across iterations.

### Step D — Batch BOARD.md write

After the loop exits, apply all stashed BOARD-row updates to `STATE_DIR/BOARD.md` in one Write pass. The BOARD and the audit JSONL live outside the working tree, so there is no `git add` and no `git commit` — supervisor state never lands on the integration branch. The single batch Write replaces per-task BOARD updates to keep state changes coherent (see `docs/supervisor-design.md`).

If `MERGED_IDS` and `BLOCKED_IDS` are both empty AND the audit log was not written this run, the Write is a no-op (no-op run).

### P2.1 — Brief template

Write exactly this content to `STATE_DIR/tasks/<TASK.id>.md`. The 6 H2 sections MUST appear in this order — parsing downstream is schema-driven . Substitute placeholders in `{{…}}`.

```markdown
---
id: {{TASK.id}}
title: {{TASK.title | yaml-quote}}
scope:
  include:
{{- each TASK.scope.include as glob}}
    - {{glob}}
{{- end}}
  exclude:
{{- if TASK.scope.exclude is empty}}
    []
{{- else}}
{{- each TASK.scope.exclude as glob}}
    - {{glob}}
{{- end}}
{{- end}}
depends_on: {{TASK.depends_on as YAML inline array}}
---

# {{TASK.title}}

## Goal

{{if TASK.notes is non-empty}}
{{TASK.notes}}
{{else}}
_Goal unspecified in BOARD.md. Worker should chat_ask if the intent is
not derivable from scope and project direction._
{{end}}

## Acceptance

- [ ] Code compiles and any existing tests pass.
- [ ] Changes are limited to paths matching `scope.include` and NOT matching `scope.exclude`.
- [ ] Codex review returns `verdict: "approve"` with zero in-scope findings at the worker's `--min-severity`.

## Context

Source: `BOARD.md`. Project direction at dispatch time:

> {{DIRECTION_TEXT, each line prefixed with `> `, or `_No direction set._` if empty}}

Scope globs (hard constraint — do NOT edit outside):
- include: {{TASK.scope.include}}
- exclude: {{TASK.scope.exclude}}

## Out of scope

- Any file outside the scope globs above.
- Pushing to remote, opening PRs, or creating tags.
- Modifying `BOARD.md` or any `STATE_DIR/tasks/*.md` — those are supervisor-owned.

## Test plan

If the repo has a test runner, run it and verify no regressions. `/ccx:loop` Phase 1 enforces this automatically via its test gate.

## Decisions

<!-- No seeded decisions. Supervisor's M3 autonomous-answer loop (§P2.3) treats
this section as the highest-confidence source and parses it for `- q:` / `  a:`
YAML-ish pairs; leaving it empty (no such pairs) means unknown questions
escalate to Discord as before. HTML comments are invisible to the Tier-1
parser, so this default yields an empty decision list. To seed deterministic
answers, replace this comment block with real `- q:` / `  a:` entries. -->
```

### P2.2 — Dispatch prompt shape

`DISPATCH_PROMPT` is a single string containing:

```
/ccx:loop --<TASK_WORKER_MODE> --loops <WORKER_LOOPS> --commit --chat

<task_brief path="<DISPATCH_BRIEF_PATH>" id="<TASK.id>">
{{full contents of the brief file just written in P2.A step 2}}
</task_brief>

<project_direction source="BOARD.md">
{{DIRECTION_TEXT verbatim, or `_No direction set._` if empty}}
</project_direction>

<instructions>
Read <task_brief> as your complete spec. Implement exactly what its
Acceptance section requires, respect Out of scope, and verify with
the Test plan before handing off to Codex review.

Do not edit files outside <task_brief>.scope.include. If you need to,
STOP via chat_close({status: "aborted"}) and explain why in the
worker log — the supervisor will surface the log path on exit.

When something is ambiguous and not covered by the Decisions section
of the brief, call chat_ask with the specific question. The
supervisor's broker adapter (M2) queues the ask; the supervisor
session (M3) may reply autonomously from the brief Decisions /
BOARD direction / merge history, otherwise it escalates to a human
on Discord. Either way, your chat_ask returns the reply verbatim.
</instructions>
```

**`<DISPATCH_BRIEF_PATH>` (M9).** The literal token `STATE_DIR` never appears in the rendered prompt — the supervisor substitutes the resolver-returned absolute path at template-render time. `DISPATCH_BRIEF_PATH = "<absolute STATE_DIR/tasks/<TASK.id>.md path>"`. The brief is NOT committed to the worker branch; the worker `Read`s it via the absolute path, permitted by `/ccx:loop` Phase 0.5's "M9 exception" rule.

**`<TASK_WORKER_MODE>` (M10).** The literal token `<TASK_WORKER_MODE>` never appears in the rendered prompt — the supervisor substitutes the resolved per-task mode at template-render time. The substituted value is the bare literal string `duet` or `conductor` — never `--duet` / `--conductor` — so the surrounding `--<TASK_WORKER_MODE>` template renders as `--duet` or `--conductor` (NOT `----duet`). This is the same `TASK_WORKER_MODE` variable resolved in Step A step 4 and persisted on `RUNNING[T-id].worker_mode_resolved` per Step A step 7; the names match by design so there is one variable for one concept across §P2, §P2.2, and Step A. Resolution order (first non-null source wins):

1. The task's BOARD `worker_mode` field, when non-null (`duet` or `conductor`).
2. The run-level `--worker-mode` flag value (default `duet`).

The rendered first line reads either `/ccx:loop --duet --loops <WORKER_LOOPS> --commit --chat` (current M8b behavior) or `/ccx:loop --conductor --loops <WORKER_LOOPS> --commit --chat` (the M10 conductor mode that `/ccx:loop` exposes). The two flags are mutually exclusive at the worker side — supervisor MUST emit exactly one of them per dispatched task, never both, never neither. SSOT for the conductor branch's worker-side semantics: `docs/supervisor-design.md` §"Conductor Mode (M10 — proposed)".

Supervisor dispatch always includes either `--duet` or `--conductor`. The resolved value is recorded on `RUNNING[T-id].worker_mode_resolved` at dispatch time (Step A step 7), surfaced on the one-line dispatch notice (Step A step 8), and surfaced in the P0.5 dispatch lifecycle chat message — so an operator inspecting a task that inherited its mode from the run-level `--worker-mode` flag (BOARD `worker_mode` absent or `null`) can still tell which flag actually went out without re-deriving from the supervisor invocation. The `assigned` BOARD row does NOT gain a new persistent field for this; BOARD `worker_mode` keeps its "per-task override" semantic, and the in-memory + log + chat surfaces are the source of truth for the resolved-for-this-run value. Conductor mode's per-cycle tier movement is observed inside the worker via the same `CCX_MODEL_LADDER_PATH` env var both modes already share.

**Brief-size escape hatch.** If `wc -c < STATE_DIR/tasks/<TASK.id>.md` > 4096, replace the inline `<task_brief>` body with:

```
<task_brief path="<absolute STATE_DIR/tasks/<TASK.id>.md path>" id="<TASK.id>">
Brief exceeds 4KB — read the file from the absolute path in the path
attribute above. It is NOT committed to your worker branch (M9 keeps
ccx state out of the working tree); use the Read tool with that
absolute path directly.
</task_brief>
```

The supervisor substitutes the resolved absolute path at template-render time. The literal token `STATE_DIR` is never sent to the worker — only the resolved absolute path. The `/ccx:loop` Phase 0.5 "M9 exception" rule permits reading exactly that supervisor-provided absolute brief path even though it lies outside the worktree.

The worker reads the brief via `Read` in its Phase 1. **The brief lives at the absolute `STATE_DIR/tasks/<TASK.id>.md` path outside the working tree** — the supervisor substitutes the resolved absolute path into the dispatch prompt at template-render time.

### P2.3 — Match-confidence rubric

A "confident match" is one where the supervisor is willing to answer a worker's `chat_ask` WITHOUT human review. The rubric is conservative — when in doubt, ESCALATE. A wrong autonomous answer costs more than a late one because it propagates into the worker's Phase 1 implementation and gets baked into a commit before Codex review can catch it.

- **Tier 1 — Brief `## Decisions` entry (CONFIDENT).** Reply if the ask asks substantively the same question as a `- q:` entry in the brief's Decisions section. Paraphrase is fine ("which of X vs Y?" matches `q: "X vs Y?"`). Do NOT stretch across topics: an ask about library X does not match a decision about library Z just because both are "library choice" questions.
- **Tier 2 — BOARD `## Direction` direct policy hit (CONFIDENT).** Reply if `DIRECTION_TEXT` contains a policy statement that concretely answers the ask. "Prefer stdlib over third-party deps" answers "can I add `lodash`?" with "no, use stdlib". Do NOT fabricate policy from vague direction — "focus on reliability" is not a concrete answer.
- **Tier 3 — Prior task commits on the integration branch (LESS CONFIDENT).** Reply only if a recent commit's subject + body contains a decision that clearly governs the ask. Under M9 T-4 the squash commit is the worker's final commit message verbatim (subject + body + trailers, captured via `git log -1 --format=%B "duet/<task_id>"`). Cite the commit SHA (first 8 chars) and quote the body line that hit. When Tier 3 cannot match, escalate per the conservative bias. SKIP this tier entirely when the ask is safety-sensitive (touching auth, data migrations, destructive operations, secret handling, network/filesystem permissions) — those always escalate.
- **Everything else → ESCALATE.** Ambiguous match, multiple conflicting sources, safety-sensitive, no source hit at all. Escalation is the default; autonomous answering is an optimization over always-escalating, not a replacement for human judgement.

**Auto-escalate race.** The broker's auto-escalate timer is the hard deadline, but the broker applies a **per-ask clamp**: `SupervisorAdapter.enqueue()` in `plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs` sets the real delay to `min(AUTO_ESCALATE_AFTER_SEC, max(1, floor(timeoutSec) - 2))` when the worker supplied a finite positive `timeoutSec`, and `AUTO_ESCALATE_AFTER_SEC` otherwise. For each polled ask, compute the per-ask deadline the same way using the `timeoutSec` field returned by `chat_supervisor_poll`:

```
perAskDeadlineSec =
  (timeoutSec is a finite positive number)
    ? min(AUTO_ESCALATE_AFTER_SEC, max(1, floor(timeoutSec) - 2))
    : AUTO_ESCALATE_AFTER_SEC
```

If `ageSec >= perAskDeadlineSec - 3`, skip the decision work and call `chat_supervisor_escalate` immediately — the broker's timer is about to fire (or has already fired). Using the global value alone would miss short-timeout asks: a worker calling `chat_ask({timeoutSec: 30})` with `AUTO_ESCALATE_AFTER_SEC = 60` has a real deadline of 28s, not 57s; treating 40s as "still safe" races an ask the broker already escalated. The cutoff MUST derive from the per-ask deadline, not the raw config value.

Explicit escalation (via `chat_supervisor_escalate`) rather than lost `chat_supervisor_reply` calls keeps the audit log clean: a racing reply would land as `brokerOk: false` (the adapter already resolved the ask), which clutters the JSONL trail without changing the outcome.

### P2.4 — Scope-overlap detection

Step A's overlap gate (A2 step 1a) decides whether `TASK.scope.include` overlaps with any `RUNNING_TASK.scope_include`. Two tasks "overlap" when there is at least one tracked file that both task scopes would include — at that point a parallel dispatch risks producing two worktrees that edit the same file and a merge conflict downstream. The algorithm below errs on the side of serializing: a false-positive overlap defers a task by one Step C cycle (3s); a false-negative lets two workers race the same file.

**Algorithm** — applied to every `RUNNING_TASK` for the popped `TASK`. Stops at the first overlap detected (one match is enough to defer).

1. **Build the candidate file set per task.** For each glob list, invoke `git ls-files` via **direct exec with each glob as its own argv element** — never via a shell-snippet that joins globs into a single string. The shell would expand `*`/`?`/`[…]` against the supervisor's `cwd` (with semantics that differ from Git's: `nullglob` drops unmatched literals, default bash keeps them as literal strings, `failglob` errors out — none of those is what the supervisor wants), so passing glob strings through a shell would silently corrupt overlap detection for any task whose `scope.include` uses real wildcards. Direct exec sidesteps the shell entirely and lets Git perform pathspec resolution itself, against the integration tree, with its own `**` / `*` / class-bracket semantics. This also makes the BOARD glob-string contract narrower: only NUL and newline are forbidden (§P1 step 2), which lines up with the legal Git path character set.

   Build the argv array programmatically (each glob becomes one element); never join globs into a single space-separated string, and never route this call through `sh -c`:

   ```
   argv = ["git", "-C", REPO_ROOT, "ls-files", "-z", "--"]
   for glob in TASK.scope.include:
       argv.append(glob)            # one argv element per glob, NEVER passed through a shell
   spawn(argv)                      # exec(argv), not exec("sh", "-c", joined_string)
   ```

   This contract holds regardless of how the tool runtime spells the call — `Bash` tool calls that need overlap detection must build a single-string command that the shell will not re-glob (use a `bash -c` wrapper that quotes via `printf %q` per element if absolutely necessary, but prefer a Node/Python helper that calls `child_process.spawn` / `subprocess.run` with the argv array directly). Documentation snippets that show a copy-pasted `git -C "$REPO_ROOT" ls-files -z -- ...` form are NOT part of the contract and MUST NOT be used at runtime — they exist only to make the intent legible to a human reading the prompt.

   `-z` is required — file paths can contain spaces, tabs, or shell-special characters; newlines must not be relied on as a separator. Parse the NUL-separated output into a set of repo-relative paths. Use `git ls-files` (not `find` or `git ls-tree`) so untracked-but-tracked-after-add files behave consistently with the rest of the supervisor's path logic, and so the `.gitignore` semantics match the integration branch's view.
   - Run from `REPO_ROOT` via `-C`, not from the worker worktrees — `RUNNING_TASK.scope_include` was captured at dispatch time on the integration branch and reflects the integration tree's contents. Worktree contents have diverged.
   - Cache per-task results within a single Step A pass (the gate may compare the same `RUNNING_TASK` against several popped candidates). Do NOT cache across passes — the integration tree mutates as merges land in Step B.

2. **Intersect.** If `set(TASK_FILES) ∩ set(RUNNING_TASK_FILES)` is non-empty, the two tasks overlap. Record up to 3 sample paths from the intersection for the deferral notice (sorted ascending so the diagnostic is stable across runs).

3. **Empty-match fallback (two tiers).** Globs may match zero current files (e.g. a brand-new directory the task will create). `git ls-files` returns the empty set for those globs, so the intersection from step 2 is trivially empty and would silently say "no overlap" even when two tasks plan to write into the same future directory. The fallback runs in two tiers; either tier triggering an overlap is sufficient.

   **Normalization (applies to both tiers).** Collapse repeated `/` runs (`a//b` → `a/b`). Do NOT trim leading or trailing whitespace — P1 step 2 explicitly permits whitespace in glob strings (Git allows spaces in committed paths, e.g. `"assets/logo .svg"`), and trimming would silently change which file path the glob refers to and let the gate compare a different path than the BOARD declared. Do NOT case-fold; on case-insensitive filesystems two literally-different globs may still collide, but that is a filesystem-policy edge case the supervisor does not try to resolve.

   **Tier 3a — literal-string equality.** If any normalized glob string from `TASK.scope.include` matches any normalized glob string from `RUNNING_TASK.scope_include` byte-for-byte, the two tasks overlap on that glob string. Record the matching glob string (not a file path) for the deferral notice.

   **Tier 3b — glob-prefix coverage.** Pure literal-string equality misses the common case of broad-vs-narrow patterns over a directory that does not exist yet — `src/**/*.ts` vs `src/foo/*.ts` would both be byte-different and both produce empty `git ls-files` output, yet they obviously overlap once `src/foo/` is created by either worker. To catch this:

   - Compute each normalized glob's **literal prefix**: the longest leading substring containing no Git pathspec metacharacter (`*`, `?`, `[`, `]`). Curly braces (`{`, `}`) are NOT Git pathspec metacharacters — Git pathspecs do not implement brace expansion (that is a shell feature). A BOARD glob like `src/{a,b}/*.ts` matches a file literally named `{a,b}` under `src/`, not files under `src/a/` or `src/b/`. The supervisor does NOT special-case braces and treats them as literal characters; if an operator wrote a brace pattern intending shell-style alternation, that is a BOARD authoring bug they will see at dispatch time when `git ls-files` returns an unexpected (likely empty) set. Examples: `src/**/*.ts` → `src/`; `src/foo/*.ts` → `src/foo/`; `src/foo.ts` → `src/foo.ts` (no metacharacter, the whole string is its prefix); `**/foo.ts` → `` (empty prefix); `[abc]/lib.ts` → `` (leading metacharacter); `src/{a,b}/*.ts` → `src/{a,b}/` (braces are literal — only the trailing `*` is a metacharacter).
   - Two normalized globs are flagged as overlapping under Tier 3b when ALL of the following hold:
     1. Glob A and glob B are NOT byte-identical (Tier 3a already covers that case).
     2. Either glob A or glob B contains a glob metacharacter (two purely-literal paths can only overlap by being identical, which Tier 3a handled — and `git ls-files` would have caught any extant file).
     3. **At least one of the two prefixes is non-empty.** When both prefixes are empty (both globs lead with `**` or a character class), the prefix algorithm has no usable signal — `**/foo.ts` and `**/*.md` are unrelated future-file patterns, but a naive empty-prefix-equals-empty-prefix match would over-defer them and turn the gate into a near-global mutex for any repo that uses leading-`**` patterns. The principled handling is to skip Tier 3b in that case and let the "still undecidable cases" note (below) cover them; tasks whose scopes both lead with `**` should declare `depends_on` explicitly when they actually conflict.
     4. One of the prefixes is a path-prefix of the other (treat the prefixes as `/`-separated path segments, so `src/foo/` is a prefix of `src/foo/bar/` but `src/foo` — without trailing slash — is NOT a prefix of `src/foobar/`; normalize each prefix to end with `/` unless it is empty for this comparison). With clause 3 enforcing that at least one prefix is non-empty, this comparison is well-defined.
     5. The "wider" glob (the one whose prefix is shorter, or the one with metacharacters when the prefixes are equal) actually has a chance of matching paths under the narrower's prefix — proxy: the wider glob contains `**`, OR the segment immediately following the shared prefix in the wider glob is a single `*`, OR the wider glob's prefix equals the narrower's prefix exactly (in which case both globs match files in the same directory).
   - Record the deferral notice as `glob-prefix overlap: <wider> covers <narrower>` so the human sees which two patterns the gate considered conflicting.

   **Conservative bias.** Both tiers err toward false positives (defer when in doubt) over false negatives (let two workers race the same file). A false positive costs one Step C cycle (3s) of waiting for the running task to drain; a false negative costs a merge-conflict and a `blocked` task. When the prefixes are entirely disjoint (`src/lib/` vs `tests/api/`), no tier fires and the tasks run in parallel as intended. The empty-prefix carve-out in clause 3 above is a deliberate exception to the conservative bias: defer-on-any-leading-`**` would punish broad-pattern repos for no real benefit, so we accept the rare false negative there in exchange for retaining parallelism in the common case.

   **Still undecidable cases.** Pure character-class overlap (`src/[ab]*` vs `src/[bc]*`) is not detected — class-vs-class coverage analysis is undecidable in general. Two-leading-`**` pattern pairs (per clause 3 above) are also not detected by Tier 3b. Tasks that intend to overlap on these patterns should declare `depends_on` explicitly. Document this as a known M4 gap; M5 may revisit if the case turns up in practice. Brace alternation patterns (`src/{a,b}/*.ts`) are not in this list because Git pathspecs do not interpret braces — those globs match literal `{a,b}` paths and so are not a coverage-analysis problem at all (they will simply match the wrong files at dispatch time, which is a BOARD authoring mistake the operator should see and fix).

4. **`scope.exclude` is ignored by the overlap gate.** A file matched by an `include` glob and also by an `exclude` glob is per-task out-of-scope, but the gate's job is parallelism safety — encoding exclude rules into overlap detection would let two tasks claim the same `include` set with mutually exclusive `exclude` filters, then race when one of them edits a file the other thought was off-limits. The conservative policy is: `scope.include` is the contract for which files a task **may** touch; that's what overlap is computed against. If two tasks need disjoint slices of the same directory, model it via separate `include` globs, not via overlapping include + differing exclude.

5. **Failure modes.** `git ls-files` should never fail on a clean integration branch — P1 step 2's pathspec sanity probe has already validated every task's `scope.include` and `scope.exclude` against this exact tree, so any runtime failure here is **not** a pathspec issue. The remaining causes are repo-level: a locked or corrupt `.git/index`, a missing or unreadable object, a filesystem permission revocation between startup and now, or another process holding a write lock. None of these are wait-and-retry transient — they all require human intervention to clear, and silently deferring would either spin forever (because A1 clears `DEFERRED_THIS_PASS` every pass and `READY` keeps re-including the task once `RUNNING` drains, so no exit condition fires) or, worse, produce a false-negative overlap result if the supervisor decided to skip the gate after some retry count.

   The correct response is to **STOP the whole supervisor run immediately** on the first runtime `git ls-files` failure inside the overlap gate, but the STOP MUST be accompanied by a **comprehensive recovery sidecar** so already-`assigned` workers do not get orphaned. P1 step 3 excludes `assigned` rows from `PENDING_POOL` on every future run, and the in-memory `status: "assigned"` BOARD update committed in Step A step 6 is already on the integration branch — without explicit recovery instructions, every in-flight worker becomes invisible to future supervisor runs even after the human resolves the repo issue.

   Concrete sequence on first runtime `ls-files` failure in the gate:

   1. Capture the verbatim stderr from the failed call (`LS_FILES_STDERR`).
   2. Do **not** attempt Step D. The integration index may be locked or corrupt, so any `git add` / `git commit` would either fail or produce a damaged commit; defer all BOARD/audit persistence to human triage.
   3. Do **not** attempt to kill the in-flight `claude -p` workers. They are running in their own worktrees on their own branches; the integration-side repo issue does not affect their progress, and killing them would lose their work. Let them continue; the human will classify their final state manually after the repo is fixed.
   4. Write `STATE_DIR/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` (append if the merge-commit-failed branch already wrote one — both records are needed) with these sections, in this order:
      - **Cause**: `git ls-files refused inside the M4 overlap gate at <UTC ISO 8601>`. Include `LS_FILES_STDERR` verbatim.
      - **Already-merged tasks** (`MERGED_IDS`): the integration branch already holds these merges; the BOARD-row updates were stashed in memory but not yet persisted by Step D. List each as `T-<id> — needs BOARD row update to status=merged, exit_status=approved`.
      - **Already-blocked tasks** (`BLOCKED_IDS` + their stashed BOARD-row updates): same situation; list each with the verbatim `exit_status` and `notes` text the supervisor would have written via Step D.
      - **In-flight workers** (`RUNNING`): list each as `T-<id> — branch duet/<id> — worktree <RUNNING[T-id].worktree_path> — log <log_path> — shell <shell_id>`. The `worktree` value is the resolved absolute path the M9 T-2 worktree-path resolver returned at dispatch time (cached on `RUNNING[T-id].worktree_path` per Step A step 7) — `<STATE_DIR>/worktrees/<task_key>/`. Tell the operator: "These workers are still alive at STOP time. After fixing the repo issue, inspect each log to determine its final outcome and either run `/ccx:supervisor` again (which will detect the worktree+branch and surface the resulting commit on the next dispatch — assuming the BOARD row is back to `pending`) or manually merge `duet/<id>` and update the BOARD row from `assigned` → `merged`/`blocked`."
      - **Untouched pending tasks** (`PENDING_POOL` minus the IDs already in MERGED/BLOCKED/RUNNING): list each as `T-<id> — pending, untouched by this run`. These need no manual action; a future supervisor run will pick them up automatically once the repo is healthy.
      - **Manual remediation steps**: a numbered checklist starting with "Resolve the underlying repo issue (locked index, permissions, corruption — see stderr above)", then "Manually apply the BOARD-row updates from the merged/blocked sections above", then "For each in-flight worker, decide based on its log".
   5. Print the absolute sidecar path, the verbatim `LS_FILES_STDERR`, and a one-line summary `M4 overlap gate aborted: <count> merged, <count> blocked, <count> in-flight workers; see <sidecar path>` to the user. STOP with a non-zero exit.

The gate intentionally does NOT enumerate the cross product of every `READY` task pair — only the popped candidate against currently `RUNNING` tasks. Two `READY` tasks that overlap with each other but neither with `RUNNING` will both be popped sequentially: the first one transitions into `RUNNING`, then the second is checked against it on the inner-loop's next iteration. This is correct because dispatch is sequential within one Step A pass — there is no point at which two `READY` tasks become `RUNNING` simultaneously.

### P2.5 — Worker no-commit recovery

Step B step 4 routes here only when a worker exits without a commit after reporting `stuck` or `budget-exhausted`; Step B step 2's **budget-capped** branch also routes here directly (on a non-zero exit, bypassing step 4 entirely — see that branch for why). Model escalation is NOT handled here anymore. The active model ladder is passed into `/ccx:loop --duet`, and the worker advances through that ladder by duet cycle inside one session. Re-spawning a healthy task just to change models is intentionally not part of the shipped contract.

**Resume-redispatch (step 0 below) is a distinct optimization, not model re-spawn.** For the `cycle-cap` signal only, this section first attempts to `claude --resume <session_id> -p` the SAME session with a fresh cycle budget so the accumulated context is not rebuilt from scratch — the cost the brief calls out (a prior run re-ran `--loops 5` after `--loops 3` exhausted, paying a full context rebuild). It never changes the model, never forks the session, and is bounded to one attempt. When resume is not applicable — a non-`cycle-cap` signal, a missing `session_id`, the one-attempt bound already spent, or a run-level `--max-worker-budget-usd` cap in effect (resuming would double the per-worker ceiling) — this section falls through to the terminal block path (steps 1–6), which is exactly today's behavior. Per the brief's decision, resume is layered on top of that path and never replaces it: a task is never blocked *on* the optimization, only ever *by* the fallback.

Inputs: `meta = RUNNING[<task_id>]` and `signal ∈ {"stuck", "cycle-cap", "budget-capped"}`. `cycle-cap` is the supervisor label for the worker's own heuristic `budget-exhausted` close status (ran out of `--worker-loops` cycles without converging); `budget-capped` is the label for the `claude -p --max-budget-usd` CLI-enforced hard stop (Step B step 2). Both report the same BOARD `exit_status` — from the operator's perspective both mean "this task needs more budget, not a bug fix" — but their `notes` remediation text differs because the two are raised, and fixed, by different flags.

Algorithm:

0. **Resume-redispatch (bounded, best-effort; the layered optimization).** Runs BEFORE the block path below. Attempt a resume only when ALL four hold; if any fails, skip straight to step 1:
   - `signal == "cycle-cap"`. `stuck` is excluded because resuming the same session re-enters the same context and re-hits the recurring finding; `budget-capped` is excluded because the `--max-worker-budget-usd` ceiling would re-bite immediately unless the operator raises it. Only a genuine run-out-of-`--worker-loops`-cycles exit benefits from a fresh cycle budget over the same context.
   - `meta.session_id` is non-null (Step B step 2 captured a resume handle). On `null`, the capture failed and there is nothing to resume — fall through to step 1, the fresh-dispatch/block fallback.
   - `meta.resume_attempts < 1` — the bound. A worker that cycle-caps *again* after a resume arrives here with `resume_attempts == 1` and falls through to step 1, so the block path is always the terminal state and resume can never loop.
   - `MAX_WORKER_BUDGET_USD` is `null` — no run-level per-worker dollar cap is in effect. `--max-worker-budget-usd` is a CLI-enforced ceiling on a *single* `claude -p` process; a resume spawns a *second* process that would receive the full `<MAX_WORKER_BUDGET_USD_ARG>` again, letting one worker spend up to ~2× the advertised per-worker limit across the two processes. When a cap is set the operator has prioritized cost control, so resume is skipped and the cycle-cap worker falls through to the block path — the per-worker ceiling is never doubled. (The `budget-capped` signal already cannot resume; this closes the same doubling via the `cycle-cap` path.)

   When all four hold, redispatch the SAME session into the SAME worktree and branch instead of blocking. Do NOT remove the worktree, do NOT delete `duet/<task_id>`, do NOT append to `BLOCKED_IDS`, and do NOT touch the BOARD row — it stays `assigned` and the task stays a live `RUNNING` entry:

   a. **Build `RESUME_PROMPT`.** Prefix a one-paragraph preamble to the SAME `$DISPATCH_PROMPT` §P2.2 builds for this task (leading `/ccx:loop --<worker_mode_resolved> --loops <WORKER_LOOPS> --commit` plus `--chat` when the run has it, followed by the `<task_brief>` block). The preamble states: the prior turn exhausted its `--loops` cycle budget without reaching convergence; the full conversation context and the worktree contents are preserved; treat the current worktree state as the in-progress implementation and continue the loop rather than rebuilding from scratch. The `--loops <WORKER_LOOPS>` counter resets for this fresh `-p` invocation, so the resumed worker gets a full cycle budget again while keeping the accumulated context — which is the entire point (it avoids the full-context rebuild the brief calls out).

   b. **Spawn with the Step A step 4 template, plus `--resume`, minus worktree creation.** First capture `RESUME_STARTED_AT = <now>` **immediately before** the spawn (the same pre-spawn timestamp discipline Step A step 4 uses for `STARTED_AT`) — step d reuses it so the worker-close classifier window covers the resumed worker's entire lifetime including the 3s liveness check. A resumed worker can cycle-cap or go stuck within that window and `chat_close` before the liveness check returns; a post-spawn timestamp would sit *after* that close, so Step B step 4's `at >= meta.started_at` recent-closures filter would drop the resumed attempt's closure and misroute it to generic `no-commit` instead of cycle-cap/stuck. Then reuse `cd "<meta.worktree_path>"`, the same `CCX_*` env vars, and **every flag from the Step A step 4 spawn template verbatim** — the template is the SSOT for the flag set; do NOT rebuild the list by hand (a hand-maintained copy here drifted once already, silently dropping the compaction anchor from resumed workers). For the avoidance of doubt that includes `--permission-mode bypassPermissions`, `<BRANCH_GUARD_SETTINGS_ARG>`, `--output-format json`, `--model` / `<CLAUDE_EFFORT_ARG>` / `<TASK_FALLBACK_MODEL_ARG>`, `--append-system-prompt "<APPEND_SYSTEM_PROMPT_TEXT>"`, and `<MAX_WORKER_BUDGET_USD_ARG>`, with three differences: add `--resume "<meta.session_id>"`, pass `RESUME_PROMPT` (not the bare `$DISPATCH_PROMPT`) as the positional prompt argument, and skip Step A step 3a's `git worktree add` (the worktree already exists). Redirect with `>>` (append) rather than `>` so attempt 1's envelope stays in `STATE_DIR/workers/<task_id>.log` for the operator; the session_id re-capture in Step B step 2 uses `tail -1`, so the appended second envelope's id (identical, since the session is not forked) is what it reads. Because the spawn template no longer passes `--no-session-persistence`, the resumed session is itself persisted — but the `resume_attempts < 1` bound, not persistence, is what stops a second resume.

   c. **Liveness-check the resume** exactly as Step A step 5 does (`sleep 3` + `BashOutput`). If the resumed spawn fails the liveness check, fall through to step 1's block path — the resume did not take, and it is not retried.

   d. **On a live resume:** set `meta.shell_id = <new SHELL_ID>`, `meta.started_at = RESUME_STARTED_AT` (the pre-spawn timestamp captured in step b — NOT a fresh `<now>` sampled here; see step b for why a post-spawn sample would drop a fast-closing resumed worker's closure. This window covers the resumed attempt's close and excludes the pre-resume cycle-cap closure already in the ring), and `meta.resume_attempts += 1`. Audit: `decision: "worker-resumed"`, `source: "worker-close"`, `citation: "signal=cycle-cap,session_id=<meta.session_id>,resume_attempts=<meta.resume_attempts>"`, `reply: null`, `brokerOk: null`. Emit a one-line notice `resumed <task_id> via claude --resume (attempt <resume_attempts>) → shell <SHELL_ID>`. Then **return to the outer Step B drain loop without running steps 1–6** — the resumed worker is now a normal live `RUNNING` entry that the next Step B pass re-checks. If it converges, Step B step 3 merges it; if it cycle-caps again, P2.5 re-enters with `resume_attempts == 1` and blocks via steps 1–6.

1. Use `signal` to choose the final BOARD `exit_status`: `"stuck"` when `signal == "stuck"`, otherwise `"budget-exhausted"` (covers both `cycle-cap` and `budget-capped`).
2. Best-effort remove the worker worktree with `git worktree remove --force "<meta.worktree_path>" 2>/dev/null`, then purge its persisted Claude session with `claude project purge "<meta.worktree_path>" -y 2>/dev/null || true` (the session persists outside the worktree per Step A step 4's resume-redispatch contract; this line reaches here only after step 0 declined to resume, so no live resume handle is discarded). Preserve `duet/<task_id>` on blocked exits so the operator can inspect whatever the worker left behind.
3. Append `<task_id>` to `BLOCKED_IDS`.
4. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status` from step 1, and `notes` chosen by `signal`:
   - `"stuck"` → `"worker exited stuck; see STATE_DIR/workers/<task_id>.log. Raise --worker-loops, edit model_start, or customize STATE_DIR/model-ladder.json, then flip status to pending and re-run supervisor."`
   - `"cycle-cap"` → `"worker exited cycle-cap; see STATE_DIR/workers/<task_id>.log. Raise --worker-loops, edit model_start, or customize STATE_DIR/model-ladder.json, then flip status to pending and re-run supervisor."`
   - `"budget-capped"` → `"worker hit the --max-worker-budget-usd cap (claude -p aborted the run) before converging; see STATE_DIR/workers/<task_id>.log. Raise --max-worker-budget-usd (or omit it) and re-run, then flip status to pending."`
5. Audit: `decision: "worker-blocked"`, `source: "worker-close"`, `citation: "signal=<signal>,start_tier=<meta.start_tier_alias>"`, `reply: null`, `brokerOk: null`.
6. Remove `<task_id>` from `RUNNING` and continue the outer Step B drain loop.

This section deliberately has no end-of-ladder human prompt. If the worker reaches the top tier and still cannot converge, the correct first-release behavior is to block with a clear log path and let the human edit the task, `model_start`, or ladder config explicitly.

---

## Phase P3: Report

Pre-M6 — before printing the textual summary, fire the run-end lifecycle `chat_send` per the P0.5 table (gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`): merged count, blocked count, stranded count (tasks still in `PENDING_POOL`), duration (`UTC now - RUN_STARTED_AT`, rendered human-readable like `12m34s`), and the audit log path if `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` was written.

Then — also before the textual report — call `mcp__ccx-chat__chat_close({sessionId: CHAT_SESSION_ID, status: <final>})` exactly once. Pick `status` from `approved | completed | stuck | aborted | error` per the rules in P0.5 step 7. This call MUST run in a `finally`-style block so it still fires if an earlier phase threw; if `CHAT_SESSION_ID` was never set (no `--chat`, or registration failed, or the MCP tool was unavailable), skip the close entirely.

Then print a structured textual summary:

- **Merged** (`<count>`): list `T-<id>` — `<title>` — `<duration>` — `model_start=<alias>`. **T-4 cleanup-residue suffix:** when the row's `notes` carries the literal prefix `branch-delete-after-merge failed:` (Step B step 5 detected that the post-merge `git branch -D duet/<task_id>` either errored or left the ref resolvable), append a separate line per merged-with-residue task: `    ! duet/T-<id> still present — run 'git branch -D duet/T-<id>' to clean up; see STATE_DIR/supervisor-branch-residue-<SUPERVISOR_RUN_ID>.txt for cause`.
- **Blocked** (`<count>`): list `T-<id>` — `<exit_status>` — log path (`STATE_DIR/workers/T-<id>.log`) — `model_start=<alias>`. Blocked reasons: `stale-artifact | spawn-error | merge-conflict | merge-aborted | merge-commit-failed | no-commit | stuck | budget-exhausted | error`.
  - `merge-aborted` (M4): `git merge --squash` refused without unmerged paths (pre-merge-commit hook rejection, branch protection, unreachable object) AND the in-iteration retry refused again. The supervisor does NOT set `STOP_DISPATCHING` here — failures of this shape are usually per-merge, so the loop keeps draining and other peers can still merge.
  - `merge-commit-failed` (M4): the pre-merge dry-run reported clean but `git commit -F <message-file>` rejected the merge (typically a pre-commit hook on the integration branch); the supervisor sets `STOP_DISPATCHING` so no new workers spawn, drains existing `RUNNING` peers via Step B, then exits via condition 3. A recovery sidecar at `STATE_DIR/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` is written.
  - `stuck`: the worker saw the same finding recur across three review turns and blocked without committing. Inspect the log, edit the task or ladder if needed, then flip status back to `pending`.
  - `budget-exhausted`: either the worker used its `--worker-loops` budget without convergence, or (when `--max-worker-budget-usd` was set for this run) `claude -p` itself aborted the worker on hitting the dollar cap. Consult the row's `notes` to tell the two causes apart: the worker's own heuristic cycle-cap ("Raise --worker-loops...") versus the CLI-enforced hard stop ("Raise --max-worker-budget-usd...") — see §P2.5 step 4. Remediate accordingly (raise `--worker-loops`, edit `model_start`, customize `STATE_DIR/model-ladder.json`, or raise `--max-worker-budget-usd`), then flip status back to `pending`.
- **Stranded in `PENDING_POOL`** (informational): tasks whose deps were met but were never dispatched before the loop exited. Report each row with the reason it stayed pending so the human knows what follow-up is needed. Source these reasons from the run-level state (`EVER_DEFERRED_BY_SCOPE`, `STOP_DISPATCHING`, in-memory BOARD `depends_on` resolution) — `DEFERRED_THIS_PASS` is intentionally cleared every A1 pass and is NOT a valid source for P3.
  - `T-<id> — scope-deferred`: `<id>` is in `EVER_DEFERRED_BY_SCOPE`. The M4 scope-overlap gate deferred this task on at least one Step A pass because a `RUNNING` task held an overlapping file set, and no slot ever cleared into a non-overlapping window before the loop exited (typically because `--max-tasks` was reached, `STOP_DISPATCHING` was set, or all conflicting peers merged after this pass's A1 had already moved on). Re-run the supervisor once the conflicting ids merge.
  - `T-<id> — deferred-by-stop-dispatching`: exit condition 3 (M4 — see Step B's merge-commit-failed branch) fired and the loop drained `RUNNING` without dispatching this task. The integration-branch commit pipeline rejected at least one merge commit during the run; resolve the underlying hook/signing/protection issue (see the recovery sidecar referenced below if the run produced one) and re-run the supervisor to pick this task back up.
  - `T-<id> — deps-blocked`: the task's `depends_on` set still points at non-`merged` ids in the in-memory BOARD state at exit. Surface the unmet dep ids; this is the same data the "Not ready (deps unmet)" bullet reports above and is included here for completeness when the same task is also `scope-deferred` or `deferred-by-stop-dispatching`.
- **Not ready (deps unmet)**: list `T-<id>` with its pending deps.
- **Still assigned/running** — only non-empty if the loop exited via `--max-tasks` while workers were still running. Step C waits on RUNNING, so this should stay empty; guard against it in the report anyway.
- **Supervisor audit** (M3 decisions and worker-close classifications, when `STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` exists): parse every JSONL line in that file and summarize counts per `decision` and per `source`. Include the absolute path to the JSONL file.

**M9 T-2 + T-4 — worktree AND branch cleanup are now automatic for the merged exit.** Pre-T-4 the supervisor printed `git branch -d "duet/T-<id>"` for each merged task and left the deletion to the operator; T-4 folds that step into Step B step 5's worker-finish cleanup (gated on the `merged` exit, after the worktree-remove that T-2 already automated). So this report no longer prints a per-merged-task branch-delete command — the merged task's branch is already gone by the time P3 runs.

For BLOCKED tasks the branch is preserved for operator triage and the worktree is removed when possible. The human-facing manual cleanup command is included in that row's `notes` string; print the BOARD `notes` verbatim rather than synthesizing a new command line.

Step B step 5 performs normal terminal cleanup. Merged exits remove the worktree and delete `duet/<task_id>`; blocked exits remove the worktree and preserve the branch for inspection.

Supervisor automatically cleans up worker branches on the merged exit only (T-4); blocked workers' branches are preserved for human triage. This brings worktree removal (T-2) and branch removal (T-4) into a single per-task cleanup contract.

Print a final BOARD.md snapshot (the `## Tasks` YAML block) so the user can see the end state at a glance.

---

## What's deferred to later milestones

| Feature | Milestone |
|---------|-----------|
| Broker supervisor adapter (worker `chat_ask` interception) | M2 — shipped |
| Autonomous answering from brief `## Decisions` / BOARD direction / merge history | M3 — shipped |
| Scope-glob overlap parallelism gate | M4 — shipped |
| Pre-merge conflict dry-run before committing the merge | M4 — shipped |
| Visible/customizable Claude/Codex model ladder | shipped |
| Supervisor duet workers | M8b — shipped |
| Squash merge + post-merge branch deletion | M9 T-4 — shipped |
| Conductor mode (`--worker-mode {duet,conductor}` + BOARD `worker_mode` override) | M10 — in-flight |
| Supervisor resume after session close | open |

The current contract is: `BOARD.md` → load and print active ladder → briefs → dispatch (with scope-overlap gate, per-task `model_start`, and per-task `worker_mode` resolved against the run-level `--worker-mode` flag) → poll completions → drain supervisor asks (autonomous reply or escalate) → pre-merge dry-run → block no-commit workers with precise `stuck` / `budget-exhausted` reasons → BOARD update → audit report.

### Runtime integration

- M2 ships the broker plumbing (`plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs`, `backend: "supervisor"` config option, and the `chat_supervisor_{poll,reply,escalate,close}` MCP tools). With `backend: "supervisor"` in `~/.claude/ccx-chat/config.json`, worker `chat_ask` calls queue in the broker and auto-escalate to Discord after `supervisor.autoEscalateAfterSec` seconds (default 60).
- M3 ships the supervisor-side polling (`Step B2`) and the match-confidence rubric (`§P2.3`). When the broker is in Discord-only mode OR the broker tool is unavailable, Step B2 is a no-op and worker asks reach humans via the broker's own auto-escalate timer.
- M4 adds two independent gates: the scope-overlap gate defers candidate dispatches whose `scope.include` shares any tracked file with a `RUNNING` task, and the pre-merge dry-run wraps every approved-worker merge in `git merge --squash` + `git commit -F <message-file>`.
- The model ladder is loaded and printed once per supervisor run. `/ccx:plan` writes `model_start` aliases. The worker (`/ccx:loop --duet` or `/ccx:loop --conductor`, selected by M10's per-task resolution) uses the selected start tier for Claude and advances Codex through the ladder by cycle inside one worker session.
- M8b makes duet the supervisor default: every supervised worker is spawned with `/ccx:loop --duet` unless M10's `--worker-mode` flag or a BOARD `worker_mode` override selects `--conductor`. Under the duet default, Claude and Codex alternate implement/review turns; under the conductor override, the worker delegates each turn to a fresh sub-process per `docs/supervisor-design.md` §"Conductor Mode (M10 — proposed)". Either way, the mode is applied via the dispatch prompt — no brief frontmatter flag.
- M9 T-4 makes the merge path squash-only and folds branch deletion into Step B step 5 on the merged exit only (`git branch -D duet/<task_id>` after the existing T-2 worktree-remove).
- M10 adds the `--worker-mode {duet,conductor}` run-level flag and an optional BOARD `worker_mode` per-task override. The resolved per-task value drives the leading `/ccx:loop --duet` vs `/ccx:loop --conductor` flag in `$DISPATCH_PROMPT` (§P2.2); everything else about the dispatch surface (env vars, brief path, `--loops`, `--commit`, `--chat`) is identical across the two modes. Duet stays the default during incubation.
- The audit log (`STATE_DIR/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`) is append-only JSONL, owned by the supervisor session, and written outside the product repo. M3 decisions (`decision: "reply" | "escalate"`) and worker-close decisions (`decision: "worker-blocked"`) share the file and are distinguishable by decision family. Never truncate the file; never edit past lines.
