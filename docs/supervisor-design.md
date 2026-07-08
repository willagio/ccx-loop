# ccx Supervisor Design

Status: shipped

## Goal

`/ccx:supervisor` lets one human dispatch multiple `/ccx:loop --duet` workers from a shared task queue. The supervisor owns scheduling, worker briefs, merge gates, retry/escalation, and inspection surfaces. Product repositories should not receive ccx-owned files in their working tree.

## State

All supervisor state lives outside the repo:

- `STATE_DIR/BOARD.md` — task queue and project direction.
- `STATE_DIR/tasks/T-<id>.md` — per-task worker briefs.
- `STATE_DIR/workers/T-<id>.log` — worker logs.
- `STATE_DIR/supervisor-audit/<RUN_ID>.jsonl` — autonomous answer and retry audit.
- `STATE_DIR/worktrees/T-<id>/` — worker git worktrees.
- `STATE_DIR/model-ladder.json` — optional user override for the visible Claude/Codex model ladder.

`STATE_DIR` resolution:

1. `$CCX_DATA_HOME`, when set, is used as the exact state directory.
2. Otherwise `$XDG_DATA_HOME/ccx/<repo-key>/`, when `$XDG_DATA_HOME` is set.
3. Otherwise Linux uses `~/.local/share/ccx/<repo-key>/`; macOS uses `~/Library/Application Support/ccx/<repo-key>/`.

`<repo-key>` is `<basename>-<sha256-7>` of the origin URL. If no origin exists, it is `<basename>-local-<sha256-7>` of the real repo path.

Inspection commands:

- `/ccx:where` prints the resolved `STATE_DIR`.
- `/ccx:board` opens `STATE_DIR/BOARD.md`.
- `/ccx:tasks` lists rows from `STATE_DIR/BOARD.md` and brief presence under `STATE_DIR/tasks/`.

## BOARD Schema

`/ccx:plan` writes `STATE_DIR/BOARD.md`. Rows start as `status: draft`; the human edits them and flips selected rows to `pending`.

```yaml
- id: T-1
  title: "Short task title"
  scope:
    include:
      - src/**/*.ts
    exclude: []
  status: draft
  priority: normal
  model_start: default
  depends_on: []
  brief: tasks/T-1.md
  attempts: 0
  worktree: null
  branch: null
  worker_pid: null
  started_at: null
  finished_at: null
  exit_status: null
  notes: |
    Human-readable context.
```

Statuses:

- `draft` — planned but not dispatchable.
- `pending` — ready for dispatch.
- `assigned` / `review` — supervisor-owned in-flight states.
- `merged` — landed on the integration branch.
- `blocked` — requires human action.

`model_start` is a task-readable alias into the active model ladder. Built-in aliases are `economy`, `default`, `strong`, and `max`; `/ccx:plan` chooses one per task and the human can edit it before dispatch. Missing or `auto` resolves to the active ladder's `default_start`.

## Briefs

The supervisor writes briefs to `STATE_DIR/tasks/T-<id>.md` at dispatch time. The worker receives the absolute brief path in the dispatch prompt and must only read it when it matches the trusted `CCX_TASK_BRIEF_PATH` and `CCX_TASK_ID` environment variables set by the supervisor. Brief frontmatter is BOARD-derived; worker flags are not task data.

## Dispatch

For each ready task, the supervisor:

1. Verifies no stale `duet/<task_id>` branch or `STATE_DIR/worktrees/<task_id>/` exists.
2. Writes the brief under `STATE_DIR/tasks/`.
3. Creates a worker worktree at `STATE_DIR/worktrees/<task_id>/`.
4. Loads the active ladder from `STATE_DIR/model-ladder.json` or the built-in default, prints it, and resolves this task's start alias.
5. Writes `STATE_DIR/model-ladder.effective.json`, then spawns `claude -p` with `/ccx:loop --duet --loops <N> --commit --chat`, passing the effective ladder path and task start tier through environment variables.
6. Tracks the worker by branch, worktree path, log path, attempt count, and start tier.

The scope-overlap gate prevents dispatching two tasks whose `scope.include` globs touch the same tracked file.

## Completion

Worker exit detection primarily uses `claude agents --json`, matched by `cwd == meta.worktree_path`. The worker's `chat_close` status is used to distinguish `approved`, `stuck`, `budget-exhausted`, `aborted`, and `error` paths.

Codex model selection can strengthen inside one worker session by duet cycle:

```text
economy -> default -> strong -> max
```

The built-in ladder maps those aliases to Claude/Codex settings:

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

Each rung's `codex` object carries an optional `effort` field (`none | minimal | low | medium | high | xhigh`, the reasoning-effort set the installed codex companion accepts). It is passed as `--effort <value>` to Codex **task** (implement) turns only — the companion does not accept `--effort` on `review` / `adversarial-review`, so Codex review turns always run with `--model` alone regardless of what the rung specifies. Omitting `codex.effort` on a rung passes no effort flag for that rung's implement turns, preserving the pre-T-8 behavior. `gpt-5.5` remains the default Codex model in the built-in ladder — unchanged by this field.

Claude is fixed by the worker's initial `claude -p --model/--effort` spawn. The supervisor does not claim to change Claude's in-session model by cycle.

### Worker-spawn robustness flags

Two supervisor flags shape the `claude -p` spawn template independently of the model ladder:

- `--fallback-model` is auto-derived per task, not user-supplied. Immediately after resolving the task's start tier, the supervisor walks the active ladder downward from the start tier looking for the nearest cheaper rung whose `claude.model` differs from the start tier's — e.g. `strong` (`opus`) falls back to `default` (`sonnet`), while `max` (`opus`) skips past `strong` (also `opus`) to `default` (`sonnet`). When found, it is passed to the worker's `claude -p` spawn as `--fallback-model <model>`, letting that single process survive a primary-model overload (e.g. Opus capacity errors during a large `--parallel` burst) by transparently falling back at the CLI level. When no cheaper rung has a different Claude model, `--fallback-model` is omitted entirely. This is independent of the worker's own in-session ladder advancement (duet/conductor per-cycle Codex tier escalation) — it only engages when the `claude` CLI itself decides the primary model is unavailable.
- `--max-worker-budget-usd AMOUNT` is an optional run-level supervisor flag (unset by default). When supplied, it is forwarded verbatim into every dispatched worker's `claude -p` spawn as `--max-budget-usd AMOUNT`, turning `budget-exhausted` from a purely heuristic exit (the worker ran out of `--loops` cycles) into a CLI-enforced hard dollar cap that can abort the process mid-run. The supervisor's completion classifier recognizes this CLI-enforced abort (via the worker log's `error_max_budget_usd` / `Exceeded USD budget` markers) and reports it as `budget-exhausted` with remediation guidance to raise or omit the cap, rather than as a generic crash. **Known limitation:** under `--worker-mode conductor`, the cap only bounds the conductor's own lightweight orchestration spend — it does not propagate to the per-turn `claude -p` sub-processes the conductor delegates to, since those spawns are owned by `/ccx:loop`'s Phase 2-Conductor rather than the supervisor's spawn template.

## Merge

Approved workers always land through the squash-only merge contract:

1. Assert the integration checkout is clean.
2. Run `git merge --squash --no-edit duet/<task_id>`.
3. If unmerged paths exist, roll back with `git restore --staged --worktree .` and block as `merge-conflict`.
4. If the squash refuses without unmerged paths, retry once. If it refuses again, block as `merge-aborted`.
5. If the squash is clean, commit with `git commit -F <message-file>`, where the file contains the worker's final commit message.
6. If commit fails, roll back, block as `merge-commit-failed`, write a recovery sidecar, stop new dispatches, and drain already-running workers.

There is no merge-strategy config, rebase path, or merge-commit-producing path.

## Cleanup

After a merged exit, the supervisor removes the worktree first and then deletes `duet/<task_id>`. Blocked exits remove the worktree but preserve the branch for inspection.

## Conductor Mode (M10)

Status: shipped. Opt-in via `--conductor` / `--worker-mode conductor`; duet remains the supervisor default during M10 incubation.

### Motivation

The shipped duet contract (M8b) runs both alternating implementers inside a single `claude -p` worker session. Claude implement turns execute in-session; Codex implement turns shell out to `codex-companion.mjs task`. Two consequences:

1. **Context accumulation.** Over many cycles the worker's Claude session collects every Read/Edit/Bash result, every Codex JSON envelope, and every worktree snapshot. Claude review uses a sub-Agent (whose context is isolated), but every other path lands in the main session. Long runs trip Claude Code's lossy auto-compaction; Codex output payloads are the largest per-turn additions.
2. **Claude tier locked at spawn.** Codex can advance through the ladder per cycle via `--model`; Claude cannot, because changing Claude's model mid-run requires a sub-Claude subprocess per turn, which M8b explicitly defers.

### Architecture

In conductor mode the worker `claude -p` becomes a **conductor** rather than an implementer. The conductor:

- Holds the run-wide context: brief excerpt, latest review verdict, short cycle log, ladder, and its own audit decisions.
- Spawns either `claude -p` or `codex` as the per-turn implementer or reviewer; collects each sub-process's artifact (worktree diff + bounded self-report) and the verdict.
- Makes the per-turn decisions that M8b hardcoded: which side implements next, which side reviews next, which tier each side runs at.

The conductor itself never edits source files. Edits are observed by the same temp-index snapshot algorithm M8b's duet driver already uses for empty-diff detection.

### Per-turn I/O contract

To each sub-implementer:

- The verbatim style-ping-pong-mitigation clause from M8b.
- Brief excerpt.
- When the previous outcome was reject: the previous review's verdict + findings, free-form. When it was approve: the "previous review approved; return without edits unless substantive" instruction.
- Working directory = worktree path.

From each sub-process (the only structured part of the contract):

- Final line MUST be `VERDICT: approve` or `VERDICT: reject` for review turns. This single-line protocol is the only convergence signal the conductor parses.
- Bounded self-report (≤ 200 words) summarizing the turn. Free-form; the conductor reads it as context, does not parse.
- Worktree diff is observed by the conductor independently via snapshot before/after — the sub-process does not need to describe it.

Codex's existing `codex-companion.mjs review --json` envelope is consumed as-is (its `verdict` field maps to the same approve/reject signal). The conductor accepts either the JSON envelope or the single-line protocol from any sub-side.

### Adaptive tier policy

Tier selection is LLM judgment, not a cycle counter. Default policy, guided by prompt and overridable via `STATE_DIR/tier-policy.md` when present:

- Start at BOARD `model_start` (or `--start-tier`).
- Reject judged substantive/architectural → tier index +1.
- Reject judged trivial/nit → tier index unchanged or -1.
- Two consecutive same-shape rejects → tier index +1.
- Stuck judgment fires → tier index +1 capped at max; conductor may also flip the implementer side.
- Trivial passing diff (e.g. ≤ 5-line approve) → next implement turn may use tier index -1 for token economy.

Tier escalation is no longer monotonic; the conductor may move both directions within the active ladder. Claude and Codex tiers move independently.

### Convergence and stuck detection

The M8b convergence contract is preserved: a run converges only when two consecutive approval-like outcomes come from **different reviewers**. The conductor enforces this by tracking which side produced each approval and rejecting a same-side double-approve.

Stuck detection moves from `(file, title, body)` tuple equality to a conductor-side LLM judgment over the last N review verdicts. The shared `findingStreak` map is no longer load-bearing. Default N = 3, matching M8b's threshold. The conductor must be conservative — false positives end runs prematurely.

The `M8B_STUCK_SIDE` worker-log token continues to be emitted before `chat_close({status: "stuck"})` so the supervisor's existing log-tail classifier keeps working unchanged.

### Companion script

`plugins/ccx/scripts/claude-companion.mjs` mirrors `codex-companion.mjs`. Responsibilities:

- Resolve the `claude` CLI path; fail with the same install-hint shape Codex uses if missing.
- Spawn `claude -p` with the conductor-chosen `--model` and (when set on the resolved tier) `--effort`, an explicit `--allowedTools` set (Read, Write, Edit, Bash, Glob, Grep), and `--permission-mode acceptEdits`. Worktree-isolation constrains blast radius to the task's worktree.
- Capture stdout/stderr until exit; extract the trailing `VERDICT:` line; return `{verdict, body, exit_code}` to the conductor.

The companion does NOT parse the free-form body. The conductor reads it as context.

### Backward compatibility

A new flag `/ccx:loop --conductor` enables conductor mode. `/ccx:loop --duet` keeps its M8b semantics during incubation; the two flags are mutually exclusive. Argument-parse rejects `--conductor --duet` with `--conductor and --duet are mutually exclusive`.

`/ccx:supervisor` gains `--worker-mode duet|conductor` (default: `duet` during M10 incubation; flips to `conductor` once stable). Optional per-task override via a new BOARD `worker_mode` field.

The M8b in-session driver remains as a fallback path for users who prefer fewer subprocesses or whose `claude -p` invocation is constrained.

### Conductor audit trail

Each conductor decision (tier choice, side choice, stuck judgment, exit) is appended as JSONL to `STATE_DIR/workers/<task_id>.conductor.jsonl` so the human can audit after-the-fact. Schema mirrors `STATE_DIR/supervisor-audit/<RUN_ID>.jsonl`. One file per worker, written by the conductor itself.

### Open questions

1. **Cost crossover.** Many short subprocess invocations vs one long in-session — measure the cycle count beyond which conductor mode wins on tokens. Expected to land between cycle 10 and 20. *Status 2026-07: still open.* The shipped cost-aware tier guidance in `loop.md` Phase 2-Conductor addresses a *related* per-side concern (stop escalating a side whose per-turn implement cost climbs without convergence progress) but does not answer this question — the conductor-vs-duet token-economics measurement remains to be done.
2. **Stuck judgment false positives.** LLM "is this the same complaint as last cycle" may end runs early. Default conservatively (require high confidence; fall back to tuple-equality when uncertain).
3. **Per-cycle Codex effort.** ~~`codex-companion.mjs` currently accepts `--model` only. Investigate whether newer Codex CLIs expose an effort flag the companion can forward.~~ *Resolved 2026-07:* companion v1.0.3 documents `--effort <none|minimal|low|medium|high|xhigh>` on `task` (implement turns only; `review` still takes `--model` alone). Ladder rungs carry an optional `codex.effort` that the duet and conductor drivers forward accordingly — see "Worker-spawn robustness flags" and the built-in ladder above.
4. **Conductor self-eviction.** If the conductor's own context grows large despite delegation, define a fallback: hand off audit log + state to a successor `claude -p` and exit. Probably out of scope for M10; flagged for M11.

### Non-goals for M10

- Replacing the supervisor with the conductor model (the supervisor's parallel-worker role is unchanged).
- Concurrent sub-implementer execution within one worker (turns remain serial within one task).
- Cross-worker tier policy sharing (each conductor decides independently).
- Migration of in-flight M8b runs to conductor mode (the modes coexist; new runs choose at start).

## Post-M10 hardening (2026-07)

Shipped after M10 as a freshness/robustness wave. Each item is additive to the contracts above; the authoritative spec text lives in `plugins/ccx/commands/supervisor.md` and `loop.md`.

- **Cost-aware conductor tier policy** (`loop.md` §Phase 2-Conductor). The Claude companion envelope passes through per-turn accounting (`cost_usd`, `num_turns`, `result_subtype`, `stop_reason`); the conductor records it in `implement_cost_by_side` / `cycle_log` and a `turn-cost` audit family, and the adaptive tier policy consults it as advisory guidance (per-side cost-crossover guard, affordable escalation, confirmed economy). Envelopes carrying `error_max_budget_usd` / `error_max_turns` terminate the run as a runtime-enforced `budget-exhausted` — the CLI ceiling, not the cycle-count heuristic. Codex-side accounting is `null` on companion v1.0.3; the policy only weighs sides with non-null observations.
- **Branch-guard hook** (`plugins/ccx/scripts/branch-guard-hook.mjs`). A `PreToolUse` hook injected into worker spawns via `--settings`, blocking any `git commit` when the current branch differs from `$CCX_EXPECTED_BRANCH` (`duet/<task_id>`). Deterministic enforcement of the commit-on-worker-branch rule that prompt-level instructions alone failed to guarantee (a worker once committed directly to main). No-ops when the env var is unset (manual runs).
- **Compaction anchors** (`supervisor.md` §P2 Step A step 4). Worker spawns carry `--append-system-prompt` with a <~800-char anchor (task id, brief path, convergence rule, EDITED_PATHS duty, worker-branch rule). System-prompt content is re-sent on every request, so the anchor survives Claude Code's lossy auto-compaction — the M10 motivation, now mitigated for duet mode too. The §P2.5 resume path reuses every spawn-template flag verbatim (template is SSOT), so anchors survive resume.
- **Resume-redispatch** (`supervisor.md` §P2.5 step 0). Workers spawn with plain `--output-format json`; the supervisor captures `session_id` from the final envelope and, when a worker exits on the cycle cap, resumes the same session once via `claude --resume` with a fresh cycle budget instead of rebuilding context from scratch. Bounded to one attempt; skipped when `--max-worker-budget-usd` is set (a second process would double the per-worker ceiling); persisted sessions are purged at every terminal cleanup site.
- **Agent SDK companion backend — evaluated, no-go for now** (`docs/sdk-companion-poc-notes.md`). Rewriting `claude-companion.mjs` on `@anthropic-ai/claude-agent-sdk` was prototyped and rejected for now; the CLI shell-out stays. The PoC notes list the concrete triggers that would reopen the decision — treat that doc as the seed for a future supervisor-as-code milestone.

## Non-Goals

- Distributed execution across machines.
- Long-lived background supervision without a human session open.
- Backward-compatible repo-local `.ccx/` state.
- Configurable merge strategies.
- Automatic migration from pre-release state layouts.
