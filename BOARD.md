## Direction

Active milestone: **M9 — Customer-mode invisibility (zero footprint in user repos)**. Motivation: ccx today leaves heavy traces in any repo it touches — `.ccx/` directory in the worktree, BOARD.md at repo root, `ccx/T-X` branches surviving into merge commits, `T-X:` / `supervisor: dispatch / supervisor: update board` commit subjects, and board/task file changes mixed into product history. That pattern is fine here (this repo is dogfood — the ccx narrative *is* the product) but it is unacceptable in a customer's repo, where the user expects their git log to be indistinguishable from one written by hand. M9 plugs every leak vector by relocating tool state outside the working tree and forcing commit/merge hygiene, with a verifier that gates merges if any leak is detected.

This milestone is treated as a *contract*, not a feature set. The six invariants below are checked automatically by `ccx verify` (T-6); violation blocks the merge and the worker retries with a corrected message.

**Invariants (enforced by T-6 verifier; violations = merge blocked):**

1. The user's working tree contains no `.ccx/` directory or other ccx-owned files.
2. The user's `.gitignore` (committed) contains no ccx-related entries.
3. No commit subject or body on worker branches or new integration commits contains ccx tooling markers: task IDs in marker form (`T-\d+`), `supervisor:` subjects, `supervisor: dispatch`, `supervisor: update board`, or `ccx/` branch/path markers. The single exception is an opt-in Git trailer (`Ccx-Task: T-X`) at the end of the body when `ccx.commit.trailer = true`, which defaults to **false**.
4. Mainline (integration-branch) commits contain no merge commit whose first parent message matches `Merge branch 'ccx/...'`. Default merge strategy is **squash**; merge-commit-producing strategies are gated behind `ccx.dogfood = true`.
5. After a worker finishes (approved or aborted), no `ccx/T-X` branch ref remains in the user's repo — branches are deleted post-merge or post-abort.
6. The user's `.claude/`, `CLAUDE.md`, `.claude/settings.json`, and `AGENTS.md` files are untouched by ccx unless the user explicitly opts in; worker/supervisor diffs that include those files are verifier failures.

**State relocation (T-1, T-2):**

- All tool state — BOARD.md, tasks/, audit/, workers/, worktrees/ — moves to `$XDG_DATA_HOME/ccx/<repo-key>/` (Linux/macOS fallback `~/.local/share/ccx/<key>/`), overridable via `$CCX_DATA_HOME`.
- `<repo-key>` is derived deterministically: primary = SHA-256 short hash of the first remote URL (`origin`), with a readable suffix from the repo's directory basename → e.g. `my-project-a3f9b2`. Fallback for repos without a remote = SHA-256 short hash of `realpath`. Explicit override via `ccx link --name <readable>` for repo moves / forks / disambiguation.
- Git worktrees move under `$STATE/worktrees/<task-key>/`. Default `<task-key>` = `T-X` (readable). `ccx.paranoid = true` opt-in renames worktree directories *and* the `.git/worktrees/<name>/` metadata to opaque hashes for users who want maximum invisibility (including in `.git/` internals).
- First run is silent — one stderr line announcing the state path. No interactive prompt.

**Commit hygiene (T-3):**

- Before any worker commit lands, two passes run:
  1. **Style mirror.** Workers read `git log --pretty='%s%n%b%n--' -30 <integration-branch>` and rewrite the proposed message to match the repo's convention (conventional-commit prefix style, subject case, imperative vs. past tense, trailing period, body presence). Implementation: a single LLM rewrite call with the recent history as context.
  2. **Marker strip.** A regex pass removes/rejects tooling-marker shapes such as `T-N:`, `[T-N]`, `supervisor: ...`, and `ccx/`; it must not reject ordinary product words like "dispatch". Hits cause the worker to regenerate the message; three consecutive hits abort the worker with a `commit-marker-leak` exit status.
- Opt-in trailer (`ccx.commit.trailer = true`, default `false`) appends `Ccx-Task: T-X` as a Git trailer (parseable by `git interpret-trailers`) for users who want forensic mapping in history. Default invisibility wins.
- The same regex runs again at supervisor pre-merge time as belt-and-suspenders.

**Merge strategy (T-4):**

- Default: **squash** into the integration branch with a single natural-prose commit message (T-3 hygiene applies to the squashed message).
- `ccx.merge.strategy = squash | rebase | merge` config — `merge` (which produces `Merge branch 'ccx/T-X'` commits) requires `ccx.dogfood = true` and is rejected otherwise.
- Post-merge/post-abort cleanup runs in this order: `git worktree remove --force <path>` first, then `git branch -D ccx/T-X`. Git refuses branch deletion while the branch is checked out in a worktree, so the order is load-bearing.

**Inspection helpers (T-5):**

- `/ccx:where` — echoes the resolved state directory path for the current repo.
- `/ccx:board` — opens `$STATE/BOARD.md` in `$EDITOR` (falls back to `cat`).
- `/ccx:tasks [--status]` — lists tasks from `$STATE/tasks/`.
- `ccx link --name <readable>` / `ccx unlink` — explicit repo→state mapping management for moves, forks, or aliasing.
- `ccx.dogfood = true` (read from `git config ccx.dogfood true`, with this repo optionally carrying a committed `.ccx-config` only because it is dogfood) re-enables the legacy behavior set (`.ccx/` inside repo + `merge` strategy + `T-X:` prefix allowed + state stored at `.ccx/`). Customer repos must not receive a ccx-owned config file.

**Verifier + docs (T-6):**

- `ccx verify` shell script implements the six invariants as exit-code checks. Supervisor invokes it as a pre-merge gate; failure blocks merge and surfaces a structured `leak` exit status to the supervisor's stuck-exit auto-revise loop (M5).
- `README.md` gains a "Customer mode" section documenting the invariants, the state directory location, and the `ccx migrate` path for any existing user with a committed `.ccx/` directory.

**Out of scope (M9):**

- Positive opt-in policy for modifying `.claude/`, `CLAUDE.md`, and `AGENTS.md` (separate hardening pass). M9's verifier only blocks ccx-authored changes to those files when they appear in a worker/supervisor diff without an explicit opt-in.
- Per-task model-profile in BOARD (deferred from M8 to a later milestone).
- `--codex-model` / `--codex-effort` runtime knobs (still deferred from M8).
- A "share board across team" mode using committed `.ccx/` — discussed but parked. Customers who want this can flip `ccx.dogfood = true` until a proper shared-mode design lands.
- Migration of supervisor-audit / worker scratch in *this* repo: dogfood mode preserves the existing layout, no movement.

## Tasks

```yaml
- id: T-1
  title: "M9: external state directory — relocate .ccx/ to $XDG_DATA_HOME/ccx/<key>/"
  scope:
    include:
      - plugins/ccx/commands/supervisor.md
      - plugins/ccx/commands/loop.md
      - plugins/ccx/commands/forever.md
      - plugins/ccx/commands/plan.md
      - docs/supervisor-design.md
    exclude: []
  status: merged
  priority: normal
  depends_on: []
  brief: .ccx/tasks/T-1.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-1"
  branch: "ccx/T-1"
  started_at: "2026-05-24T13:15:29Z"
  finished_at: "2026-05-24T14:25:00Z"
  exit_status: approved
  notes: |
    Foundation for M9. Every other M9 task assumes state lives at
    $XDG_DATA_HOME/ccx/<repo-key>/ (Linux/macOS) with $CCX_DATA_HOME
    override. <repo-key> = SHA-256 short hash of first remote URL +
    basename suffix (e.g. my-project-a3f9b2); fallback to realpath
    hash if no remote.

    Touch points across the four command files: every read/write to
    .ccx/BOARD.md, .ccx/tasks/, .ccx/audit/, .ccx/workers/ must
    resolve through a single helper that:
      1. Reads $CCX_DATA_HOME (override).
      2. Else $XDG_DATA_HOME/ccx/<key>/ (Linux).
      3. Else ~/.local/share/ccx/<key>/ (Linux fallback) or
         ~/Library/Application Support/ccx/<key>/ (macOS).
      4. Creates the dir on first access (silent + one stderr line:
         "ccx state: <path>").
      5. If ccx.dogfood = true in `git config`, short-circuit to
         repo-local .ccx/. This repo may also carry a committed
         .ccx-config as dogfood metadata; customer repos must not.

    docs/supervisor-design.md gains a new "## 18. M9 — Customer-mode
    invisibility" section (M7/M8 depth) documenting the state path
    resolver, the repo-key derivation, the dogfood flag, and the
    invariant set this enables.

    Plan-time decisions to seed in T-1.md Decisions block:
      - Use $XDG_DATA_HOME path scheme (vs. ~/.cache: data not
        cache).
      - Repo-key = remote-URL hash, NOT path hash. Stable across
        clones.
      - First-run UX = silent + 1-line stderr log. No prompt.
      - ccx link --name = override mechanism; spec'd in T-5.

    Verification:
      - Run /ccx:supervisor --dry-run --parallel 1 in a fresh clone
        of this repo with ccx.dogfood unset; confirm $STATE/<key>/
        is created and repo has zero new files.
      - With ccx.dogfood = true, confirm the existing .ccx/ path
        is still used unchanged.
      - Re-run with $CCX_DATA_HOME set to a tmpdir; confirm state
        lands there.

- id: T-2
  title: "M9: external worktrees — git worktree add under $STATE/worktrees/"
  scope:
    include:
      - plugins/ccx/commands/supervisor.md
      - docs/supervisor-design.md
    exclude: []
  status: merged
  priority: normal
  depends_on:
    - T-1
  brief: .ccx/tasks/T-2.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-2"
  branch: "ccx/T-2"
  started_at: "2026-05-24T14:27:26Z"
  finished_at: "2026-05-24T15:54:30Z"
  exit_status: approved
  notes: |
    Move worker worktree spawn from the supervisor's current location
    (sibling of the repo: ~/Repositories/ccx-loop-T-X) into
    $STATE/worktrees/<task-key>/.

    Defaults:
      - <task-key> = T-X (readable in $STATE introspection).
      - .git/worktrees/<task-key>/ metadata directory keeps the same
        readable name.

    Paranoid mode (ccx.paranoid = true):
      - <task-key> = first 8 chars of SHA-256(T-X || timestamp).
      - .git/worktrees/<hash>/ also opaque.
      - Mapping T-X ↔ hash recorded in $STATE/worktrees/_index.json.

    Wire-up:
      - The supervisor's worktree-add invocation (Phase A step that
        creates the worker worktree) computes the target path from
        T-1's helper + `worktrees/<task-key>` and passes it to
        `git worktree add`.
      - On worker finish (any exit_status), supervisor runs
        `git worktree remove --force $STATE/worktrees/<task-key>`
        before deleting the branch (T-4).

    Verification:
      - After `/ccx:supervisor --dry-run --parallel 1`, confirm the
        printed dispatch plan names the external $STATE worktree path
        but no worktree is created.
      - After a real mocked dispatch, confirm `ls $REPO` shows no
        .ccx/ inside the repo, `git worktree list` shows the external
        path, and cleanup leaves no stale entries.

    Out of scope: forced relocation of an in-flight worker's
    existing worktree (M9 applies to new spawns only; in-flight
    workers from before the upgrade continue at their current
    path until they finish).

- id: T-3
  title: "M9: commit message hygiene — style mirror + marker strip"
  scope:
    include:
      - plugins/ccx/commands/loop.md
      - plugins/ccx/commands/forever.md
      - docs/supervisor-design.md
    exclude: []
  status: merged
  priority: normal
  depends_on:
    - T-1
  brief: .ccx/tasks/T-3.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-3"
  branch: "ccx/T-3"
  started_at: "2026-05-24T15:55:29Z"
  finished_at: "2026-05-24T16:23:20Z"
  exit_status: approved
  notes: |
    Independent of T-2 — this touches only the loop's commit step,
    not state location. Depends on T-1 because it consumes the shared
    config resolver for ccx.dogfood and ccx.commit.trailer.

    Pipeline (in /ccx:loop and /ccx:forever before each commit):
      1. Worker produces draft commit message (as today).
      2. Style-mirror pass: feed
           git log --pretty='%s%n%b%n--' -30 <integration-branch>
         + draft message to a single LLM rewrite call. Prompt asks:
         "Rewrite the proposed commit message to match the repo's
         existing convention (prefix style, subject case, imperative
         vs. past tense, trailing period, body presence). Strip any
         task IDs (T-NN) or tooling markers. Output the rewritten
         message only."
      3. Marker-strip regex gate. Match tooling-marker shapes, not
         ordinary product words:
           (?i)(^|\s)(T-[0-9]+:|\[T-[0-9]+\]|\bT-[0-9]+\b|supervisor:\s*(dispatch|update board)?|ccx/)
         against subject + body. If hit, regenerate (go back to step
         2). Three consecutive hits → abort worker with exit_status:
         commit-marker-leak (new status). Supervisor picks this up via
         M5's stuck-exit auto-revise.
      4. Optional opt-in trailer: if ccx.commit.trailer = true, append
         `Ccx-Task: T-X` Git trailer to the body (parseable by
         `git interpret-trailers --parse`). Default false.

    Dogfood mode (ccx.dogfood = true):
      - Skip steps 2 + 3 entirely. Worker's draft message lands
        as-is (T-X: prefix, supervisor: prefix all allowed).
      - Trailer flag still respected.

    docs/supervisor-design.md §18 (created by T-1) gets a subsection
    documenting the rewrite prompt template and the regex.

    Verification:
      - Manual run: `/ccx:loop` with ccx.dogfood unset on a test task
        whose natural commit message would contain "T-5". Verify the
        landed commit subject contains no T-N pattern.
      - Run regex grep over last 10 commits of an integration test
        run: zero hits.
      - Dogfood: same task with ccx.dogfood = true. Verify legacy
        message lands unchanged.

- id: T-4
  title: "M9: merge strategy — squash default + branch cleanup"
  scope:
    include:
      - plugins/ccx/commands/supervisor.md
      - plugins/ccx/commands/loop.md
      - docs/supervisor-design.md
    exclude: []
  status: merged
  priority: normal
  depends_on:
    - T-3
  brief: .ccx/tasks/T-4.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-4"
  branch: "ccx/T-4"
  started_at: "2026-05-24T16:24:18Z"
  finished_at: "2026-05-24T18:19:41Z"
  exit_status: approved
  notes: |
    Replace the current supervisor merge logic (which produces
    `Merge branch 'ccx/T-X'` commits) with a configurable strategy
    defaulting to squash for customer mode.

    Config: ccx.merge.strategy ∈ { squash | rebase | merge }
      - Default: squash.
      - `merge` is rejected unless ccx.dogfood = true (raise a
        clear error from the supervisor at config-load time, not at
        merge-attempt time).

    Implementation per strategy:
      - squash: `git merge --squash ccx/T-X` from the integration
        branch, then `git commit -m "<T-3-processed message>"`.
        The squashed commit's message is the worker's final commit
        message, run through T-3's pipeline a final time at merge
        time (last regex check).
      - rebase: `git rebase <integration> ccx/T-X` followed by
        `git merge --ff-only ccx/T-X`. Each individual commit on
        the branch is T-3-processed at worker time, so no extra
        rewrite here.
      - merge (dogfood only): existing path — `git merge --no-ff
        ccx/T-X` with the current "Merge branch 'ccx/T-X'" subject.

    Post-merge cleanup (all strategies, runs unconditionally):
      - `git worktree remove --force $STATE/worktrees/<key>` first
        (T-2 responsibility but supervisor invokes it here).
      - `git branch -D ccx/T-X` after worktree removal.

    docs/supervisor-design.md §18 gets a subsection on the strategy
    matrix and the post-merge cleanup contract.

    Verification:
      - End-to-end on a test task with default config: final
        integration-branch log has one new commit, subject matches
        repo convention, no `Merge branch 'ccx/'` substring,
        ccx/T-X branch absent from `git branch -a`.
      - rebase variant: same expectations, multiple commits if
        worker made several.
      - dogfood + merge: existing behavior preserved.

- id: T-5
  title: "M9: inspection helpers + ccx.dogfood flag"
  scope:
    include:
      - plugins/ccx/commands/supervisor.md
      - plugins/ccx/commands/loop.md
      - plugins/ccx/commands/plan.md
      - plugins/ccx/commands/where.md
      - plugins/ccx/commands/board.md
      - plugins/ccx/commands/tasks.md
      - plugins/ccx/commands/link.md
      - plugins/ccx/commands/unlink.md
      - .ccx-config
      - docs/supervisor-design.md
    exclude: []
  status: merged
  priority: normal
  depends_on:
    - T-1
  brief: .ccx/tasks/T-5.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-5"
  branch: "ccx/T-5"
  started_at: "2026-05-24T18:20:35Z"
  finished_at: "2026-05-24T19:33:50Z"
  exit_status: approved
  notes: |
    Surface the external state directory to humans through three
    helpers, plus formalize the dogfood escape hatch.

    Helpers — added as new commands or sub-modes (decision in brief):
      - /ccx:where        → prints $STATE/<key>/ resolved path.
      - /ccx:board        → opens $STATE/<key>/BOARD.md via $EDITOR
                            (falls back to `cat` if $EDITOR unset).
      - /ccx:tasks        → lists tasks from $STATE/<key>/tasks/.
                            --status filters by status.
      - ccx link --name X → write X to a per-repo override file so
                            future invocations resolve to
                            $XDG_DATA_HOME/ccx/X/ instead of the
                            auto-derived key.
      - ccx unlink        → remove the override.

    The ccx.dogfood = true flag (introduced in T-1) is fully
    documented and consumed here:
      - Customer mode reads from `git config ccx.*`, not a repo-root
        ccx-owned file.
      - When true, all M9 behaviors (T-1 state relocation, T-2
        worktree relocation, T-3 commit hygiene, T-4 squash default)
        revert to pre-M9 behavior. This repo (ccx-loop) may commit
        `.ccx-config` with ccx.dogfood = true as dogfood metadata;
        that exception is forbidden for customer repos.
      - Auto-detection ("am I the ccx repo?") is explicitly
        rejected. Must be set explicitly.

    docs/supervisor-design.md §18 gets a subsection: "Inspection
    surface and dogfood escape hatch."

    Verification:
      - /ccx:where in this repo (dogfood = true) prints the repo's
        own .ccx/ path.
      - /ccx:where in a fresh test repo (dogfood unset) prints
        $XDG_DATA_HOME/ccx/<key>/.
      - ccx link --name foo, then /ccx:where, then ccx unlink:
        path changes to .../foo/, then back.

- id: T-6
  title: "M9: ccx verify (zero-footprint gate) + customer-mode README section"
  scope:
    include:
      - plugins/ccx/scripts/
      - plugins/ccx/commands/supervisor.md
      - plugins/ccx/commands/verify.md
      - README.md
      - docs/supervisor-design.md
    exclude: []
  status: merged
  priority: normal
  depends_on:
    - T-1
    - T-2
    - T-3
    - T-4
    - T-5
  brief: .ccx/tasks/T-6.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-6"
  branch: "ccx/T-6"
  started_at: "2026-05-24T19:34:33Z"
  finished_at: "2026-05-24T20:42:08Z"
  exit_status: approved
  notes: |
    The contract enforcer. Implements `ccx verify` as a shell script
    that checks all six M9 invariants and is invoked by the
    supervisor as a pre-merge gate.

    Script location: plugins/ccx/scripts/verify.sh (new dir if needed).
    Exit codes: 0 = clean, non-zero = leak detected (each invariant
    maps to a distinct code 10..15 for granular telemetry).

    Checks run with the repo root as $REPO, integration baseline as
    $BASE, and candidate worker ref as $TARGET_REF. For squash, the
    supervisor also passes the staged tree / proposed final commit
    message before creating the integration commit.
      1. `[ ! -d "$REPO/.ccx" ]` unless ccx.dogfood = true.
      2. `! grep -E '^\.ccx/?$|^\.ccx/\*' "$REPO/.gitignore" 2>/dev/null`
         unless dogfood.
      3. `! git -C "$REPO" log --pretty='%s%n%b' \
              "$BASE..$TARGET_REF" | \
           grep -v '^Ccx-Task:' | \
           grep -E '(^|[[:space:]])(T-[0-9]+:|\[T-[0-9]+\]|T-[0-9]+|supervisor:[[:space:]]*(dispatch|update board)?|ccx/)'`
         unless dogfood.
      4. `! git -C "$REPO" log --merges --pretty='%s' \
              "$BASE..$TARGET_REF" | \
           grep -E "Merge branch 'ccx/"` unless dogfood.
      5. `! git -C "$REPO" branch --list 'ccx/T-*' | grep -q .`
         (no surviving worker branches).
      6. The worker/supervisor diff path list contains no .claude/,
         CLAUDE.md, .claude/settings.json, or AGENTS.md paths unless
         an explicit opt-in flag is present. User-authored dirty
         files outside the worker diff are not blamed on ccx.

    Supervisor wire-up:
      - Pre-merge: call ccx verify. Non-zero → block merge, record
        exit_status: leak-<code>, surface to M5 stuck-exit auto-
        revise. Worker retries with the leak detail in its revise
        prompt (e.g. "your last commit subject contained T-3; the
        verifier refused to merge — rewrite without task IDs").

    README.md gains a new "Customer mode" section:
      - The six invariants (copy from BOARD.md direction).
      - Default state path ($XDG_DATA_HOME/ccx/<key>/) and override
        ($CCX_DATA_HOME).
      - How to inspect state (/ccx:where, /ccx:board, /ccx:tasks).
      - ccx.dogfood flag (when to set, what it disables).
      - ccx migrate sub-section for any existing user with a
        committed .ccx/: steps to (a) move state to external, (b)
        `git rm -r --cached .ccx/`, (c) do not add .ccx/ to
        .gitignore in customer mode, (d) commit the cleanup.

    docs/supervisor-design.md §18 closes with the verifier contract
    + invariant table.

    Verification:
      - Run ccx verify against this repo with ccx.dogfood = true:
        exit 0.
      - Run against a synthesized "bad" repo with .ccx/ present and
        a commit subject "T-3: foo": exit non-zero with code 10
        AND code 12 (multiple invariants flagged independently).
      - Run end-to-end /ccx:supervisor on a fresh repo: verify
        triggers, blocks if any worker leaks, surfaces leak details
        to revise loop, succeeds after worker fixes.
```
