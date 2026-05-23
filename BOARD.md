## Direction

Active milestone: **M8 — duet loop (Claude↔Codex alternating implementer) + supervisor infra refresh**. Motivation: the installed Codex CLI is underused — only the review gate calls it. M8 introduces a `/ccx:loop --duet` mode where Claude and Codex alternate as implementer, each reviewing the other's turn. M7 left supervisor's worker exit detection on PID polling, which is broken for Phase 2 respawn and gets worse under duet's higher worker count — M8a swaps it for `claude agents --json` and lands `worktree.baseRef: "fresh"` so the duet work in M8b is built on solid infra.

Design decisions locked in this milestone (referenced by T-2 notes and woven into `docs/supervisor-design.md` §16/§17 by T-1 and T-2):

**M8a — supervisor infra refresh**
- Replace `kill -0 PID` worker exit detection in `plugins/ccx/commands/supervisor.md` with `claude agents --json` polling (parse JSON, key off agent status).
- Add `worktree.baseRef: "fresh"` to worker worktree spawn so each task forks from the remote default, not local HEAD.
- Out of scope (backlog): hook `$CLAUDE_EFFORT`, `--bg --name`, `/code-review --comment`, `parentSettingsBehavior`.

**M8b — duet mode**
- Per-turn sequence: `Claude implement → Codex review → Codex implement → Claude review → ...`
- Default lead: Claude. `--codex-first` flag flips lead to Codex.
- Convergence: terminate when **both reviewers approve consecutively** (one Codex review approve + one Claude review approve, with no implement turn between them rejecting). Any reject by either reviewer or any non-empty implement diff resets the counter.
- M7 ladder scope: applies to **Claude side only**. Codex stays at its default model (`gpt-5.5`) for M8. `--codex-model` / `--codex-effort` runtime knobs are out of scope, deferred to M9.
- Style ping-pong mitigation: **prompt-only** — each implementer's prompt receives "preserve previous turn's structure, minimize unrelated edits". No format pass. Revisit if observed in practice.
- New `/ccx:loop` flags: `--duet`, `--codex-first`. Supervisor learns to forward these to workers; no new supervisor flags.
- Codex implement primitive: same path `/codex:rescue` uses today — `codex-companion.mjs task --write --json`.
- Claude review primitive: **decision deferred to T-2 design task** — either a sub-Claude spawn with built-in `/code-review` skill, or an inline reviewer prompt run as a separate `claude -p` call. Design task picks one with stated rationale.
- BOARD schema unchanged. `/ccx:plan` unchanged.

## Tasks

```yaml
- id: T-1
  title: "M8a: supervisor infra refresh — claude agents --json + worktree.baseRef:fresh"
  scope:
    include:
      - plugins/ccx/commands/supervisor.md
      - docs/supervisor-design.md
    exclude: []
  status: assigned
  priority: normal
  depends_on: []
  brief: .ccx/tasks/T-1.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-1"
  branch: "ccx/T-1"
  started_at: "2026-05-23T04:17:23Z"
  notes: |
    Two narrow changes to supervisor.md plus a §16 stub in
    docs/supervisor-design.md documenting them.

    1. Worker exit detection. Find the existing `kill -0 PID` polling
       (Phase B step 1 region) and replace with `claude agents --json`
       parsing. The new logic should:
       - Run `claude agents --json` each scheduling iteration.
       - Match worker by `branch` or `cwd` (whichever the JSON shape
         exposes — verify by running `claude agents --json` in this
         repo first).
       - Classify worker as: running / approved / stuck / cycle-cap /
         crashed / unknown. Map to existing exit_status taxonomy.
       - Delete the kill -0 path and any PID-tracking fields that
         only that path used; preserve worker_pid in RUNNING records
         for log correlation only.

    2. worktree.baseRef:fresh. In the `git worktree add` invocation
       inside Phase A step 7 (or wherever supervisor spawns the
       worker worktree), force baseRef to the integration branch's
       remote tip when one exists, else local HEAD. Add a small
       comment explaining the M8a switch and link to the design
       doc section.

    3. docs/supervisor-design.md gets a new "## 16. M8a — infra
       refresh" section (short — ~half the length of §15/M7)
       describing the two changes and the underlying Claude Code
       feature versions they depend on.

    Verification:
    - Re-read supervisor.md after edit; confirm no remaining
      `kill -0` references in worker management code paths.
    - Spawn one worker via `/ccx:supervisor --dry-run --parallel 1`
      using a tiny seed BOARD; confirm `claude agents --json` returns
      the expected shape and the new detection branches on it.

- id: T-2
  title: "M8b design: document duet loop in supervisor-design.md §17"
  scope:
    include:
      - docs/supervisor-design.md
    exclude: []
  status: pending
  priority: normal
  depends_on:
    - T-1
  notes: |
    SSOT for M8b. Add "## 17. M8b — Duet loop" matching §15 (M7)
    depth. Must cover:

    1. Motivation — Codex CLI underused; review-only usage misses
       the implementer capability that's already installed. Diverse-
       model alternation hypothesised to catch blind spots.

    2. Sequence diagram: Claude implement → Codex review → Codex
       implement → Claude review → ... Show one full cycle and a
       second-cycle continuation.

    3. Flags: --duet (enable), --codex-first (lead flip). Default
       lead = Claude. Locked in BOARD direction.

    4. Convergence rule: both reviewers approve consecutively. Define
       exactly when the counter resets (any reject by either reviewer
       resets; any implement turn that produced a non-empty diff
       resets).

    5. M7 ladder scope: Claude-only for M8. Codex stays at default
       model. Explicit out-of-scope list for --codex-model /
       --codex-effort / per-task model_profile (deferred to M9).

    6. Style ping-pong mitigation: prompt-only. Show the exact
       prompt clause to be injected into each implementer turn.

    7. Claude review primitive — PICK ONE and justify:
       (a) sub-Claude spawn with /code-review skill, OR
       (b) inline reviewer prompt run as separate `claude -p` call.
       Consider: invocation cost, structured-output cleanliness,
       ability to signal approve/reject back to the loop, fit with
       existing chat_close status taxonomy.

    8. Codex implement primitive: codex-companion.mjs task --write
       --json. Already exists for /codex:rescue.

    9. Worker exit signal taxonomy under duet: a duet cycle counts
       as one "cycle" for /ccx:loop's --loops cap; cycle-cap and
       stuck semantics carry over unchanged from M7.

    10. Worked examples — (a) clean 2-cycle approval, (b) one Codex
        review rejects + Claude fixes + Codex re-reviews approves +
        Claude reviews approves (terminates), (c) M7-ladder
        escalation on Claude implementer turn stuck.

    No implementation code — this is SSOT for T-3.

- id: T-3
  title: "M8b implementation: --duet flag in /ccx:loop + supervisor passthrough"
  scope:
    include:
      - plugins/ccx/commands/loop.md
      - plugins/ccx/commands/supervisor.md
    exclude: []
  status: pending
  priority: normal
  depends_on:
    - T-2
  notes: |
    Implement M8b per docs/supervisor-design.md §17. Touch points:

    plugins/ccx/commands/loop.md:
    - Frontmatter `argument-hint`: add [--duet] [--codex-first].
    - Argument parsing: parse the two new flags. --codex-first
      requires --duet (otherwise reject with precise error).
    - Phase additions: define the duet inner loop (alternation,
      convergence counter, M7 ladder integration on Claude side
      only) per §17. The existing single-implementer phases stay
      the default code path; --duet routes to the duet branch.
    - Implementer prompt injection: prepend the ping-pong-prevention
      clause from §17.6 to each implementer turn.
    - Claude review primitive: implement the choice from §17.7.

    plugins/ccx/commands/supervisor.md:
    - Frontmatter: --duet / --codex-first added.
    - Forward both flags verbatim to the /ccx:loop worker spawn.
    - No new supervisor-level logic; supervisor is a passthrough
      for M8.

    Out of scope:
    - --codex-model / --codex-effort (M9).
    - per-task BOARD model_profile (M9).
    - Style format pass (revisit if ping-pong observed).

- id: T-4
  title: "Bump ccx to v0.4.0 — M8 infra refresh + duet loop shipped"
  scope:
    include:
      - plugins/ccx/.claude-plugin/plugin.json
    exclude: []
  status: pending
  priority: normal
  depends_on:
    - T-3
  notes: |
    Bump plugins/ccx/.claude-plugin/plugin.json version from 0.3.4
    to 0.4.0 (minor bump — M8 is a behavior addition, not a bugfix)
    and extend the `description` field with a brief mention of duet
    mode + claude agents --json switch. Trivial one-file edit kept
    separate from T-3 so the M8 impl commit stays focused.

    Out of scope: package.json (repo-level, separate versioning).
    No CHANGELOG since this repo doesn't maintain one.
```
