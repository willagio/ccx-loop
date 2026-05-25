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

## Briefs

The supervisor writes briefs to `STATE_DIR/tasks/T-<id>.md` at dispatch time. The worker receives the absolute brief path in the dispatch prompt and must only read it when it matches the trusted `CCX_TASK_BRIEF_PATH` and `CCX_TASK_ID` environment variables set by the supervisor. Brief frontmatter is BOARD-derived; worker flags are not task data.

## Dispatch

For each ready task, the supervisor:

1. Verifies no stale `duet/<task_id>` branch or `STATE_DIR/worktrees/<task_id>/` exists.
2. Writes the brief under `STATE_DIR/tasks/`.
3. Creates a worker worktree at `STATE_DIR/worktrees/<task_id>/`.
4. Spawns `claude -p` with `/ccx:loop --duet --loops <N> --commit --chat` and model tier flags.
5. Tracks the worker by branch, worktree path, log path, attempt count, and tier.

The scope-overlap gate prevents dispatching two tasks whose `scope.include` globs touch the same tracked file.

## Completion

Worker exit detection primarily uses `claude agents --json`, matched by `cwd == meta.worktree_path`. The worker's `chat_close` status is used to distinguish `approved`, `stuck`, `budget-exhausted`, `aborted`, and `error` paths.

`stuck` and `budget-exhausted` are recoverable:

- `stuck` below the top tier bumps one rung up.
- `budget-exhausted` retries the same rung.
- `stuck` at `opus/max` asks the human for guidance.
- Automatic paths are bounded by `--max-attempts`.

The fixed tier ladder is:

```text
haiku/medium -> sonnet/medium -> opus/high -> opus/xhigh -> opus/max
```

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

After a merged exit, the supervisor removes the worktree first and then deletes `duet/<task_id>`. Blocked exits remove the worktree but preserve the branch for inspection, except recovery paths that intentionally delete and recreate the branch before re-dispatch.

## Non-Goals

- Distributed execution across machines.
- Long-lived background supervision without a human session open.
- Backward-compatible repo-local `.ccx/` state.
- Configurable merge strategies.
- Automatic migration from pre-release state layouts.
