# ccx Supervisor — Design

Status: draft (2026-04-17)
Scope: add a `/ccx:supervisor` slash command to the existing `ccx` plugin so one human can drive N parallel `/ccx:loop` workers from a single repository.

---

## 1. Goal

A single repository maintains a `BOARD.md` file at its root that captures pending tasks and project direction. A **supervisor session** reads that file, writes a per-task brief under `.ccx/tasks/T-<id>.md` for each task it dispatches, launches up to N independent **worker sessions** (each running `/ccx:loop --worktree --commit --chat` inside its own git worktree), waits for completion, merges approved branches into the integration branch, and updates `BOARD.md`. When workers need a judgement call mid-run they first ask the supervisor through the `ccx-chat` broker; the supervisor answers autonomously if the answer is already in the brief / BOARD / repo, and only escalates to a human via Discord when it is not.

Non-goals: distributed execution across machines, long-lived background supervision without a human session open, replacing `/ccx:loop` itself.

---

## 2. Three documents at a glance

Three distinct files play distinct roles. Keeping their purposes separate avoids the conceptual drift that happens when one word (e.g. "handoff") ends up meaning two different things.

| File | Purpose | Who writes | Who reads |
|---|---|---|---|
| `BOARD.md` (repo root) | Task queue + project direction. One row per task with `status`, `scope`, `depends_on`. Intentionally terse — queue entry, not spec. | supervisor (mostly); humans edit direction & add tasks | supervisor + humans |
| `.ccx/tasks/T-<id>.md` | Per-task brief — full spec for a single task. Fixed H2 schema (see §6). | supervisor | worker (treats as complete spec) |
| `.handoff.md` (existing — do not repurpose) | Session-to-session state: what the last `/ccx:loop` run did, unresolved findings, current state. Auto-maintained by `/ccx:loop` Phase 3. | `/ccx:loop` | next session (human or ccx) |

**Storage** is markdown + YAML frontmatter: humans edit comfortably, Git diffs render cleanly, GitHub renders. **Transfer** (supervisor → worker at dispatch time) wraps the brief in XML tags (see §7) — following Anthropic's prompt-construction guidance that XML is for unambiguous delimiters inside prompts, not for on-disk file formats.

---

## 3. Architecture

```
                    ┌─────────────────────────────────┐
                    │   supervisor session            │
                    │   (/ccx:supervisor)             │
                    │   - reads BOARD.md              │
                    │   - writes .ccx/tasks/T-*.md    │
                    │   - dispatches workers          │
                    │   - merges approved work        │
                    └──────────┬──────────────────────┘
                               │ Bash(run_in_background)
                               │ claude -p "/ccx:loop ...
                               │   <task_brief>...</task_brief>"
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
    ┌───────────┐       ┌───────────┐       ┌───────────┐
    │ worker T-1│       │ worker T-2│       │ worker T-3│
    │ worktree  │       │ worktree  │       │ worktree  │
    │ ccx/T-1   │       │ ccx/T-2   │       │ ccx/T-3   │
    └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
          │                   │                   │
          └─── chat_ask ──────┴─── chat_send ─────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  ccx-chat       │
                     │  broker         │
                     │  (Unix socket)  │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ supervisor      │
                     │ adapter (new)   │
                     └────────┬────────┘
                              │ autonomous? answer directly
                              │ escalate? forward to...
                              ▼
                     ┌─────────────────┐
                     │ discord adapter │
                     │ (existing)      │
                     └─────────────────┘
```

---

## 4. Spawn mechanism — `claude -p` as background subprocess

The supervisor launches each worker via `Bash(run_in_background=true)`:

```bash
claude -p \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --output-format stream-json \
  "$DISPATCH_PROMPT" \
  > .ccx/workers/<TASK_ID>.log 2>&1
```

`$DISPATCH_PROMPT` is assembled per §7.

Rationale:

- **True process isolation.** Each worker is its own Claude Code session with its own skills, hooks, permission state. A worker that hangs or crashes does not affect the supervisor.
- **Native skill invocation.** Workers execute `/ccx:loop` exactly as a human would run it — no need to inline the body into an Agent prompt.
- **Existing tooling reused.** `/ccx:loop --worktree --commit --chat` already handles isolation, auto-commit gating, and Discord bridging. The supervisor adds orchestration, nothing else.

### 4.1 Flags — why each one

- `--permission-mode bypassPermissions` — `/ccx:loop` issues many `Bash(git …)` / `Bash(codex …)` calls. In `-p` mode a TTY-based prompt cannot resolve, so a stricter mode would block the worker. Blast radius is bounded by `--worktree` (sibling directory on an isolated branch); the worker cannot touch main.
- `--no-session-persistence` — avoids polluting `/resume` history with ephemeral worker runs.
- `--output-format stream-json` — lets the supervisor optionally parse worker events in real time (tool calls, phase transitions) instead of only reading end-of-run logs.

### 4.2 Worker-to-supervisor flags — `/ccx:loop`

Workers are always dispatched with:

- `--worktree=<TASK_ID>` — guarantees per-task working-tree isolation so Codex review diffs do not cross-contaminate.
- `--commit` — auto-commit when the Phase 4 gate passes (approve + zero unresolved + tests pass/na + no stuck). Without this, the commit prompt would fall back to `AskUserQuestion` in `-p` mode and hang.
- `--chat` — routes all `chat_*` calls through the broker so the supervisor can intercept.

### 4.3 Completion detection

Three independent signals. The supervisor treats a worker as terminated when any one fires, then cross-checks the other two for the actual status:

1. **Background shell exit.** `Bash(run_in_background=true)` returns a shell id; the supervisor polls its status. Non-zero exit = worker crashed, missing git state.
2. **`chat_close` status.** `/ccx:loop` calls `chat_close({status: ...})` in a finally block with one of `approved | filtered-clean | stuck | budget-exhausted | aborted | error`. The broker records this per session. Supervisor queries `mcp__ccx-chat__*` (or reads broker state) for the final status.
3. **Branch HEAD presence.** The worktree branch `ccx/<TASK_ID>` exists with a new commit authored by Claude. If `chat_close` says `approved` but no commit exists, the worker lied or crashed after approval; supervisor treats this as error.

---

## 5. `BOARD.md` schema

`BOARD.md` lives at the repo root. It is both human-editable and supervisor-parseable. Each task is a YAML block inside a fenced code block under a `## Tasks` section so the surrounding markdown (rationale, direction, notes) stays free-form.

```markdown
## Direction

Free-form prose describing current project priorities, constraints,
upcoming milestones. The supervisor reads this when deciding task
order and when answering worker questions autonomously.

## Tasks

```yaml
- id: T-12
  title: "Add supervisor adapter to ccx-chat broker"
  scope:
    include:
      - plugins/ccx/mcp/ccx-chat/adapters/*.mjs
      - plugins/ccx/mcp/ccx-chat/broker.mjs
    exclude: []
  status: pending            # draft | pending | assigned | review | merged | blocked
  priority: normal           # low | normal | high
  depends_on: []             # other task ids that must be merged first
  brief: .ccx/tasks/T-12.md  # path to the per-task brief (§6)
  attempts: 0                # supervisor-managed (M5, widened by M7); starts at 1 on first dispatch; increments on every re-dispatch (stuck or cycle-cap) under M7 — see §15.3/§15.4
  worktree: null             # filled in when dispatched
  branch: null
  worker_pid: null
  started_at: null
  finished_at: null
  exit_status: null          # chat_close status
  notes: |
    Optional free-form notes the supervisor can append after merge.
```
```

Schema rules:

- `id` is the **stable key**; supervisor never renames. Used as `--worktree=<id>` name, branch suffix, brief-file name, and log-file name.
- `scope.include` is a list of globs. **Two tasks whose scope globs do not overlap can run in parallel**; overlapping scopes are serialized. This is how the supervisor prevents concurrent worktrees from producing conflicting merges.
- `status` transitions: `(draft →) pending → assigned → (review) → merged`. `draft` is the `/ccx:plan` output (M6) — a non-dispatchable status that exists to gate the human review step; the human flips `draft → pending` explicitly after reviewing the planned rows. `blocked` is terminal and needs human action.
- `exit_status` mirrors `chat_close`'s status verb so merging logic can key off a single field.
- BOARD is the **queue card**; fine-grained decisions and autonomous-answer lookup tables live in the brief (§6), not here.

Supervisor writes updates to `BOARD.md` itself — edits are atomic (read → modify → write) and committed on the integration branch after each batch of merges.

---

## 6. Task brief files (`.ccx/tasks/T-<id>.md`)

The brief file is the complete spec for a single task. It is the worker's read-once source of truth during Phase 1 of `/ccx:loop`. BOARD rows are queue entries; the brief carries the depth.

### 6.1 Location and lifecycle

- Path: `.ccx/tasks/T-<id>.md` — same `T-<id>` that appears in BOARD.
- Created by the supervisor **before** dispatch. The create-brief + dispatch pair is atomic: if brief creation fails, dispatch does not happen.
- Committed as part of the supervisor's dispatch commit on the integration branch, so the brief is version-controlled and auditable.
- Revised in place on re-dispatch after `stuck` or `blocked` exit; git history preserves the revision.

### 6.2 Fixed schema — 6 H2 sections, in this order

The schema is a **contract**. Supervisors emit exactly these six sections in this order. Workers expect this order. Empty sections are allowed (e.g. `## Out of scope\n\n_None._`) but the heading must be present — that keeps parsing schema-driven instead of heuristic.

Frontmatter fields: `id`, `title`, `scope.include`, `scope.exclude`, `depends_on` are required (BOARD-sourced). Optional additive fields land here as milestones add them; M8b added `loop_flags: [...]` (string array, defaults to `[]`, see §17.3 for the worker-side semantics and the supervisor's preserve-on-overwrite contract). Future fields follow the same rule: additive, optional, defaulted, parsers MUST tolerate unknown frontmatter keys rather than rejecting the brief.

```markdown
---
id: T-12
title: "Add supervisor adapter to ccx-chat broker"
scope:
  include:
    - plugins/ccx/mcp/ccx-chat/adapters/*.mjs
    - plugins/ccx/mcp/ccx-chat/broker.mjs
  exclude: []
depends_on: []
# loop_flags: ["--duet"]   # optional M8b additive field, see §17.3 — omit when not needed
---

# Add supervisor adapter to ccx-chat broker

## Goal
One short paragraph: what outcome this task achieves and why it matters.

## Acceptance
Checkbox list of concrete, testable completion conditions.
- [ ] ...
- [ ] ...

## Context
Pointers the worker needs: related files, prior decisions, similar
implementations to mirror, constraints the BOARD direction doesn't
already cover.

## Out of scope
Explicit list of things NOT to change. Keeps diffs focused and
prevents scope creep when the task description is read loosely.

## Test plan
How the worker verifies its own work before Codex review. If a test
file already exists, point at it; otherwise specify what to add.

## Decisions
Key–answer table the supervisor pre-populates with foreseeable
ambiguities. When a worker's chat_ask semantically matches one of
these, the supervisor's supervisor-adapter answers autonomously
without escalating to the human.
- q: "X vs Y library choice?"
  a: "Use Y. Reason: ..."
```

### 6.3 Why a separate file, not inline in BOARD

- BOARD needs to stay scannable — one screen shows the whole queue.
- Briefs are long-tail: some tasks need 1 line of spec, some need 200. Embedding them in BOARD would destroy its scan-ability.
- Briefs are per-task; BOARD is per-project. Different edit frequencies, different audit surfaces.
- Brief files are discoverable by path (`.ccx/tasks/T-12.md`) without having to grep through BOARD.

---

## 7. Dispatch prompt shape

The dispatch prompt is the single CLI argument the supervisor passes to `claude -p`. Because a bare one-liner cannot carry enough context, the supervisor embeds the brief and project direction into the prompt using XML tags. This follows Anthropic's prompt-construction guidance: XML tags give Claude unambiguous delimiters inside prompts. The tags are a **prompt concern**, not an on-disk format.

### 7.1 Prompt template

```
/ccx:loop --worktree=T-12 --commit --chat

<task_brief path=".ccx/tasks/T-12.md" id="T-12">
{{entire contents of .ccx/tasks/T-12.md}}
</task_brief>

<project_direction source="BOARD.md">
{{Direction section from BOARD.md, verbatim}}
</project_direction>

<instructions>
Read <task_brief> as your complete spec. Implement exactly what its
Acceptance section requires, respect Out of scope, and verify with
Test plan before handing off to Codex review.

When something is ambiguous and not covered by the Decisions section
of the brief, call chat_ask with the specific question. The
supervisor will answer from the brief / BOARD / repo if possible,
or escalate to the human via Discord.

Do not edit files outside <task_brief>.scope.include.
</instructions>
```

### 7.2 Why embed the full brief instead of "read the file"

Alternative: `claude -p "/ccx:loop ... Read .ccx/tasks/T-12.md and execute it."` That works, but embedding the brief directly has two advantages:

1. **Deterministic context.** The worker sees the brief as part of its first user message, guaranteed, before any tool use. Reading the file is an extra tool call the worker could forget, delay, or misinterpret the path of.
2. **Audit surface.** The dispatch log (`.ccx/workers/T-12.log`) captures the exact brief-as-dispatched. If the brief is later revised, the log still shows what the worker was told at dispatch time.

Tradeoff: prompt size grows with brief size. For briefs over ~4KB, switch to the "read the file" variant — the brief is still committed, so audit is preserved via git. The supervisor can measure brief length and choose automatically.

### 7.3 Why XML tags, not more markdown

Markdown inside a prompt has ambiguous delimiters — an `##` inside the brief body looks the same as an `##` inside the supervisor's instructions. XML tags (`<task_brief>`, `<project_direction>`, `<instructions>`) give Claude unambiguous section boundaries and carry attribute metadata (`path`, `id`, `source`) without mixing into the content.

---

## 8. Escalation flow — worker → supervisor → human

### 8.1 Broker supervisor adapter (path A, chosen)

Add `plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs` alongside the existing `discord.mjs`. Broker config grows a new backend:

```jsonc
// ~/.ccx-chat/config.json
{
  "backend": "supervisor",
  "supervisor": {
    "socket": "/tmp/ccx-supervisor.sock",
    "fallback": "discord"
  },
  "discord": { /* unchanged */ }
}
```

When `backend: "supervisor"`:

1. Worker calls `chat_ask` via MCP → broker → **supervisor adapter**.
2. Adapter writes the question to `/tmp/ccx-supervisor.sock`. Supervisor session listens.
3. Supervisor receives the event, consults the task brief's `## Decisions` section + BOARD direction + repo state, decides:
   - **autonomous answer available** → adapter returns `{ reply, source: "supervisor-auto" }`.
   - **escalate** → supervisor calls `chat_ask` on the **Discord adapter** with the question rewrapped (task id, worker branch, original question, brief excerpt). Human replies. Supervisor relays the reply back through the socket to the original worker's pending `chat_ask`.
   - **defer/refuse** → adapter returns `{ reply: null, source: "closed" }` and the worker follows its existing `chat_ask` failure path (falls back to `AskUserQuestion`, which fails in `-p`, and the loop aborts cleanly).
4. `chat_send` (one-way status messages from workers) gets two behaviors by flag:
   - Per-worker chatter: forwarded to a **single supervisor-scoped thread** in Discord (one thread per task id), not to the top-level channel.
   - Decisions / escalations: go to the main channel the human watches.

### 8.2 Why keep the broker

The existing broker already handles Unix-socket IPC, session registry, ask/reply correlation, and timeouts. The supervisor adapter is a ~200-line file that forwards events; broker core is untouched. Workers remain unchanged — they keep calling `chat_ask` / `chat_send` regardless of backend.

### 8.3 What the supervisor session runs

The supervisor slash command (`/ccx:supervisor`) itself must:

- Start a local listener on `/tmp/ccx-supervisor.sock` (see below for two options).
- Spawn N worker background processes.
- Poll for completion signals (shell exit, chat_close, branch HEAD).
- Handle incoming `chat_ask` forwards: read question, consult the brief + BOARD, reply or escalate.
- Drive the integration branch: on approved worker completion → `git merge --no-ff ccx/<id>` into the integration branch → update `BOARD.md` → commit.

Socket listener implementation — two viable options:

- **(a) Inline Node from Bash.** Spawn a Node child via `node -e '…'` once at command start; it reads socket lines and appends them to a file the supervisor tail-reads. Simple, no long-lived state, dies with the supervisor session.
- **(b) Broker-bundled.** Add a `supervisor-pending.log` mode to the existing broker that appends forwarded questions. Supervisor just reads that file. No new process at all.

(b) is preferred; it reuses the broker's lifecycle management.

---

## 9. Parallel slot management

Supervisor loop (pseudocode):

```
slots = N              # --parallel N, default 3
running = {}           # task_id -> { shell_id, worktree, started_at }

while pending_tasks_exist() or running:
    # 1. Fill slots.
    while len(running) < slots and (task := pick_next_ready_task()):
        write_brief(task)                 # .ccx/tasks/T-<id>.md
        dispatch(task)                    # writes .log, updates BOARD.md
        running[task.id] = …

    # 2. Drain completions.
    for task_id, meta in list(running.items()):
        if shell_exited(meta.shell_id):
            status = read_chat_close_status(task_id)
            handle_completion(task_id, status)
            del running[task_id]

    # 3. Answer forwarded questions.
    for q in drain_supervisor_socket():
        reply = answer_autonomously(q) or escalate_to_human(q)
        send_reply(q.id, reply)

    sleep_a_bit()                         # 2–5s backoff
```

`pick_next_ready_task()` skips tasks whose scope globs overlap with any currently running task's scope, and whose `depends_on` set is not yet fully `merged`.

`handle_completion(task_id, status)`:

- `approved` / `filtered-clean` → attempt `git merge --no-ff ccx/<id>` into integration branch. On clean merge, mark `status: merged` and update direction notes. On conflict, mark `status: blocked` with conflict details and escalate.
- `stuck` / `budget-exhausted` → mark `status: blocked`, post the worker's last cycle summary to Discord, include the Codex findings that tripped stuck detection, human decides (possibly revise the brief's Decisions section and re-dispatch).
- `aborted` / `error` → mark `status: blocked` with the log path.

> **M7 note (§15 — proposed):** under M7's tier-escalation logic, `stuck` and `cycle-cap` (the M7 label for `budget-exhausted`) are no longer immediate-block outcomes. Instead the supervisor increments `attempts`, picks the next tier (bump on `stuck`, same tier on `cycle-cap`), and re-dispatches until `attempts >= --max-attempts`. Only then — or on an end-of-ladder `stuck` at `opus-max` — does the block + human-escalation path above fire. The merge / aborted / error rows are unchanged by M7.

---

## 10. Merge policy

- **Integration branch** defaults to `main` but `--integration=<branch>` can redirect. Supervisor never force-pushes.
- **Merge mechanism**: `git merge --squash` (pre-M6 §19.1; replaces an earlier `--no-ff` design). Each task lands as exactly one supervisor-authored commit on the integration branch with subject `T-<id>: <title>`. Rationale: `/ccx:loop` Phase 4 already squashes its review-fix cycles into a single commit, so a `--no-ff` merge would only add a tree-empty graph node — pure noise. Squash gives the same audit surface (one commit per task, identifiable by its `T-<id>:` subject) without the extra commit. Conflict detection still happens before commit creation: the supervisor stages the squash, inspects `git ls-files -u`, and either commits (clean) or rolls back via `git restore --staged --worktree .` (conflict). The rollback is guarded by a pre-merge `git status --porcelain` cleanliness assert so the wholesale restore can never destroy unrelated uncommitted changes.
- **Worktree cleanup** is automatic under M9 T-2 (§18.2.3). On every worker terminal exit — merged, blocked of any flavour, or §P2.5 stuck-aborted — Step B step 5 (or the inline cleanup in the §P2.5 abort branches and retry-spawn-failure override) runs `git worktree remove --force` on the resolved `meta.worktree_path`. Worker-finish cleanup also prunes the paranoid-mode `<STATE_DIR>/worktrees/_index.json` entry. **Branch cleanup remains manual** until T-4 lands: the P3 report still prints `git branch -d ccx/T-<id>` for each merged task so the operator can issue branch deletes when ready. Pre-T-2 dogfood operators who relied on the old "supervisor reports cleanup commands and the human runs them" workflow still see the branch-delete print; the worktree-remove print disappeared (Step B step 5 already ran the command).
- **Post-merge `BOARD.md` update** is a single commit per batch of merges, not per individual merge, to avoid N+1 commits cluttering history. Commit subject: `supervisor: update board — merged T-12, T-15, T-19, blocked T-9`.

---

## 11. Permission handling

Supervisor runs in interactive mode (the human is present). Workers run in `-p` with `--permission-mode bypassPermissions`. This is acceptable because:

- Workers only operate inside their worktree (Codex review, Edit/Write, build, test, commit).
- The sibling worktree path is outside the main repo's working tree — a rogue worker cannot touch uncommitted work in the main checkout.
- Workers never call `git push` unless the task description explicitly requests it; `/ccx:loop` Phase 4 does not push by default.
- Network / system-level operations are still constrained by the user's shell environment.

A stricter alternative — `--permission-mode acceptEdits` plus per-repo `.claude/settings.json` allowlist of `Bash(git *) Bash(node *) Bash(npm *) ...` — can replace `bypassPermissions` once the allowlist is tuned. Starting bypass makes the MVP shippable; tightening is a follow-up.

---

## 12. `/ccx:supervisor` command shape

```
/ccx:supervisor [--parallel N] [--integration BRANCH] [--max-tasks M] [--dry-run]
                [--chat]
                [--max-attempts N] [--worker-loops N] [--start-tier TIER]   # M7, §15

--parallel N        max concurrent workers (default 3, clamp 1..10)
--integration B     branch to merge into (default main)
--max-tasks M       stop after M merges even if tasks remain (default unlimited)
--dry-run           parse BOARD.md, print dispatch plan, do nothing
--chat              supervisor lifecycle messages to Discord (§19.3)
--max-attempts N    per-task dispatch budget (default 4; §15.3)
--worker-loops N    per-worker cycle cap, forwarded as /ccx:loop --loops N (default 3; §15.3)
--start-tier TIER   first-attempt rung: haiku|sonnet|opus|opus-xhigh|opus-max (default sonnet; §15.3)
```

Phases inside `/ccx:supervisor`:

- **P0 pre-check**: clean tree on integration branch, `BOARD.md` parses, broker `backend: supervisor`, `.ccx/tasks/` writable.
- **P1 plan**: list ready tasks, print the dispatch order (which tasks parallel vs serialized due to scope overlap or deps), ask confirm (unless `--dry-run`).
- **P2 run**: the scheduling loop, until done or `--max-tasks` reached.
- **P3 report**: final summary (merged / blocked / skipped), pointer to `.ccx/workers/*.log` and `.ccx/tasks/*.md` for each worker.

---

## 13. MVP milestones

1. **M1 — dispatch only** (shipped 2026-04-17, commit `873dc5c`). `/ccx:supervisor` reads `BOARD.md`, generates `.ccx/tasks/T-<id>.md` from a template, spawns workers with `claude -p … /ccx:loop --worktree --commit --chat` using the XML-wrapped dispatch prompt from §7, polls shell exit, marks status `merged` on `approved` exit (naive merge, no conflict handling). No escalation, no socket, no autonomous answering. Human handles any `chat_ask` directly via the existing Discord path.
2. **M2 — supervisor adapter + escalation** (shipped 2026-04-17, commit `a6ea2fe`). `adapters/supervisor.mjs`, broker config `backend: "supervisor"`, and `chat_supervisor_{poll,reply,escalate,close}` MCP tools land. Workers' `chat_ask` calls queue in the broker and auto-escalate to Discord after `supervisor.autoEscalateAfterSec` seconds (default 60); the supervisor-side polling stub is present but everything escalates.
3. **M3 — autonomous answering** (shipped 2026-04-17, commit `7e4b8bc`). Supervisor consults the brief's `## Decisions`, BOARD direction, and prior worker commits on the integration branch to answer without escalating. Every decision lands in `.ccx/supervisor-audit/<RUN_ID>.jsonl` for audit.
4. **M4 — scope conflict detection** (shipped 2026-04-17, commit `573e39c`). Scope glob overlap check gates parallelism via `git ls-files -- <pathspecs>` intersection with literal and prefix fallbacks. Pre-merge conflict dry-run (`git merge --no-commit --no-ff <branch>` then `git commit --no-edit` or `git merge --abort`) separates conflict detection from commit creation. New blocked reasons: `merge-aborted`, `merge-commit-failed` (the latter sets `STOP_DISPATCHING` and drains existing peers via new exit condition 3).
5. **M5 — stuck recovery** (shipped 2026-04-17). Broker records every `chat_close` status in an in-memory ring buffer (`chat_supervisor_recent_closures` MCP tool, capped at 256 entries). Supervisor Step B peels stuck exits out of the generic `no-commit` bucket by querying the buffer. First stuck per task triggers a single `AskUserQuestion` (three-way: re-dispatch with guidance via "Other", re-dispatch unchanged, abort); on guidance the supervisor appends a `## Decisions` entry, commits the revised brief, cleans the prior worktree+branch, and re-spawns. `STUCK_REDISPATCH_CAP = 2` hard-caps at one re-dispatch; a second stuck blocks as `stuck-exhausted`. New blocked reasons: `stuck-exhausted`, `stuck-aborted`, `stuck-recovery-failed`, `stuck-cleanup-failed`. BOARD rows gain an `attempts` field (optional, normalized to 0).
6. **Pre-M6 hotfixes** (shipped 2026-04-18; design in §19). Four runtime hotfixes surfaced by the first e2e run land before M6: §19.1 `--squash` merge policy (replaces `--no-ff`, one supervisor-authored commit per task with `T-<id>: <title>` subject); §19.2 Step C adaptive `BashOutput`-watch + 2s-sleep + 30s-cap polling primitive (replaces fixed `sleep 3`, robust to LLM deviation and harness sleep guards); §19.3 supervisor Discord presence via new `--chat` flag (lifecycle `chat_send` for run start / dispatch / merge / block / stuck / end); §19.4 repo basename prefix on every ccx-chat message body (disambiguates concurrent ccx sessions across repos).
7. **M6 — planning phase** (proposed 2026-04-18, design in §14). Free-form-input → `BOARD.md` draft, mandatory review gate before dispatch. Closes the last onboarding cliff: M1–M5 assume `BOARD.md` already exists, but today the schema is plugin-internal knowledge and the plugin ships no scaffolding. M6 makes planning the entry path so humans never hand-author YAML.
8. **M7 — model tier escalation** (proposed 2026-04-22, design in §15). Supervisor escalates the worker model + effort tier on each `stuck` re-dispatch (same tier on `cycle-cap`), following a fixed 5-rung ladder `haiku(medium) → sonnet(medium) → opus(high) → opus(xhigh) → opus(max)`. Adds three flags — `--max-attempts`, `--worker-loops`, `--start-tier` — and makes the "if the loop drags on, escalate to a better model" behaviour automatic. No BOARD schema change; supervisor + docs only.

M1 and M2 are enough to be useful. M3–M5 are runtime quality-of-life. The pre-M6 hotfixes (§19) tighten merge history, fix a Step C deadlock failure mode, and give the supervisor its own Discord voice. M6 is the entry-path fix and is the last blocker for non-author adoption. M7 automates stuck-escalation along a fixed model+effort ladder so the human is only asked when the ladder is exhausted. M8a (§16) swaps worker exit detection over to `claude agents --json` and fast-forwards local integration to `origin/<INTEGRATION>` so every worker worktree forks from a fresh upstream base; M8b (§17, proposed 2026-05-23) introduces `/ccx:loop --duet` so Claude and Codex alternate as implementer with each reviewing the other's turn, built on top of M8a's infra. M9 (§18, proposed 2026-05-24) plugs every leak vector ccx leaves in a user repo by relocating tool state outside the working tree, tightening commit hygiene, and adding a `ccx verify` gate that blocks merges on any detected leak.

---

## 14. M6 — Planning phase (BOARD.md scaffolding from free-form input)

Status: shipped (2026-04-18) as `plugins/ccx/commands/plan.md` + supervisor.md P1 updates. Driven by the observation that after M1–M5 ship, the **only remaining human-authored artifact** is `BOARD.md`, and its schema (YAML-in-fenced-block, scope globs, depends_on, attempts) is plugin-internal knowledge. Forcing users to learn the schema before they can use the supervisor is the last onboarding cliff.

**Shipped shape:** `/ccx:plan <prompt>` or `/ccx:plan --from <path>` seeds a fresh `BOARD.md`; `/ccx:plan --append` extends an existing one. All new rows land as `status: draft`. Supervisor's P1 validator accepts `draft` as a valid status value but excludes it from dispatch (same bucket as `assigned | review | merged | blocked`). Missing-BOARD error at supervisor startup now points back at `/ccx:plan` instead of the design doc. No brief files are written by plan — that remains the supervisor's job at dispatch time. Direction-only edits stay manual per §14.3.6.

### 14.1 Problem

- `BOARD.md` schema lives in §5 of this design doc and inside `plugins/ccx/commands/supervisor.md` §P1. The plugin ships no `BOARD.md.example`, no error-message pointer — a first-time user hits `/ccx:supervisor`, sees a parse failure, and has no idea where to look.
- Even with a template, the human shouldn't *have to* think in YAML rows (`scope.include`, `depends_on`, `attempts`, `worker_pid`). They should be able to describe intent in the format they already prefer — a prompt, a PRD, a ticket export, a CLAUDE.md-style note — and get a reviewable draft back.
- Most of those fields (`attempts`, `worker_pid`, `started_at`, `exit_status`, `worktree`, `branch`) are supervisor-managed anyway. Humans should touch `title`, `scope.include`, `depends_on`, `notes` at most.

### 14.2 Direction (chosen 2026-04-18)

**Shape A — separate `/ccx:plan` command.** `/ccx:plan <prompt|--from path>` takes free-form input (a prompt string or a reference to a document the user wrote in their own preferred format), explores the repo to ground `scope.include` on actual files, writes a `BOARD.md` draft with all rows as `status: draft`, commits it as `supervisor: plan draft`, prints the diff, stops. Human reviews, edits if needed, flips `draft → pending`, then runs `/ccx:supervisor` as today.

**Rejected: Shape B (integrated `/ccx:supervisor --plan`).** Conflates LLM creativity (planning) with deterministic scheduling (supervision). The supervisor's deterministic-parser property has been load-bearing for M4/M5's robustness; mixing in a second failure mode class (hallucinated scope, over-decomposition, under-decomposition) would degrade it. Shape A also makes re-plan ergonomic (`/ccx:plan --append`) and keeps `supervisor.md` at its current size instead of doubling it.

**Rejected: `--init` skeleton scaffold.** An earlier draft proposed `/ccx:supervisor --init` for users who want a blank YAML template to hand-edit. Dropped because `/ccx:plan` covers the same need (run it with a one-line prompt, get a BOARD.md draft, edit from there) without creating a separate hand-authoring path — which was exactly the onboarding cliff M6 is meant to close. "Hand-authored BOARD.md" is still physically possible (the user can edit the file), but it is not an advertised workflow.

**Missing-BOARD error:** when supervisor is invoked and no `BOARD.md` exists, STOP with: `BOARD.md not found. Run /ccx:plan "<prompt>" or /ccx:plan --from <path> to seed tasks.` No auto-invocation — keeps the two commands' contracts clean and forces a human review step.

### 14.3 Sub-decisions for M6

1. **Input forms accepted.** Both of:
   - Prompt string: `/ccx:plan "add OAuth2 login flow"` — free-form, LLM does decomposition.
   - Document reference: `/ccx:plan --from docs/prd-oauth.md` — LLM reads the file the user already wrote in the user's preferred format (PRD, design note, Linear export, whatever).
   Document reference is the more important one because it respects the user's existing workflow — many teams already write specs, and the plugin shouldn't force a new format.

2. **Scope grounding.** LLM must derive `scope.include` from *actual repo files*, not guesses. Plan command needs `Glob`, `Grep`, `Read` in its `allowed-tools`. Ungrounded scopes produce M4 gate misfires at dispatch time — worse than no plan.

3. **Review gate via `status: draft`.** Plan writes rows as `status: draft`. Supervisor's P1 validator treats `draft` as non-dispatchable (same exclusion as `assigned | review | merged | blocked`). Human flips `draft → pending` explicitly before running supervisor — this is the review act. Keeps BOARD as the single source of truth, no out-of-band state, and works in both interactive and `-p` modes (no `AskUserQuestion` dependency on a review prompt that couldn't resolve in `-p`).

4. **Task-ID allocation.** `T-<n>` numeric suffix. Plan appends starting from `max(existing) + 1`. Never reuses IDs even if prior tasks were `blocked` and removed, because brief filenames and branch names are keyed off ID.

5. **Re-planning an existing BOARD.md.** When the human wants to add tasks to a BOARD that already has some — `/ccx:plan --append <prompt>` vs `/ccx:plan --from new-prd.md`. Plan should never silently modify existing `pending | assigned | review | merged | blocked` rows, only append new `draft` rows at the end of the Tasks block.

6. **Direction-only updates.** If the user wants to update the `## Direction` prose without adding tasks, they edit `BOARD.md` by hand. Plan does not offer a direction-only mode — it's not worth a dedicated flag.

### 14.4 Why this belongs as M6, not a nice-to-have

Every prior milestone (M1–M5) assumed BOARD.md already exists. At this point the supervisor is feature-complete for its intended runtime behaviour — but the *entry path* is still a cliff: read a 700-line design doc, hand-write YAML, then invoke. That's the gap M6 closes. It's the difference between a working prototype (today) and something the author of this repo's next colleague can pick up on their own.

---

## 15. M7 — Model tier escalation

Status: proposed 2026-04-22. Source of truth for T-2 to implement against. Complements M5's stuck recovery: instead of asking the human for guidance on every stuck exit, the supervisor first tries the cheaper "re-run the task at a higher model tier" strategy, and only escalates to the human when the ladder is exhausted or the attempts budget runs out.

### 15.1 Motivation

Before M7, every worker ran at whatever model tier the supervisor session happened to be using — the same fixed tier for the docs tweak and the gnarly refactor, the same tier for the first attempt and the re-dispatch after a stuck exit. Two concrete pain points:

- **No per-task control.** Default runs were burning Opus on tasks that haiku or sonnet could have completed, and there was no way to dial effort down without hand-editing every dispatch one-liner. Conversely, when a cheap tier could not finish the work, nothing escalated automatically — the human had to notice the stuck state and re-dispatch with a stronger model.
- **Effort was an implicit axis.** `claude -p`'s `--effort` knob existed but had never been a supervisor concern. The result was a single operating point per run: one model, one effort, for every task and every retry.

M7 makes both axes — model alias and effort level — explicit supervisor knobs. First-attempt cost can drop (start at `sonnet` or `haiku`), and subsequent attempts automatically escalate when the worker's exit signal says the prior tier could not finish. The resulting behaviour — "if the loop drags on, escalate to a better model" — is what a human watching a stuck worker would have done manually.

### 15.2 The 5-rung ladder

The tier ladder is **fixed** — five rungs in this exact order, no config file, no per-task override (see §15.6 for what M7 explicitly defers). Each rung is a `(model_alias, effort)` pair:

| Rung | Model alias | Effort | Typical use                                                |
|------|-------------|--------|------------------------------------------------------------|
| 0    | `haiku`     | medium | Docs tweaks, one-liner fixes, small mechanical changes.    |
| 1    | `sonnet`    | medium | Default starting tier; most implementation tasks.          |
| 2    | `opus`      | high   | First escalation for non-trivial logic work.               |
| 3    | `opus`      | xhigh  | Second escalation when opus/high could not finish.         |
| 4    | `opus`      | max    | Terminal rung; nothing higher to escalate to.              |

Implementation shape (for T-2 — no code in this SSOT): every `claude -p` worker spawn is built with `--model <alias>` and `--effort <level>` derived from the rung the supervisor currently has this task on. Using the alias rather than a pinned model ID means a future "sonnet-5" or "opus-5" bump in `claude -p` does not require editing this design doc — the alias resolves inside `claude -p` at runtime.

ASCII view of the ladder and its escalation edges (read left-to-right; `stuck` bumps one rung, `cycle-cap` is a self-loop on each rung):

```
              stuck             stuck              stuck              stuck
  sonnet/medium ────> opus/high ──────> opus/xhigh ──────> opus/max
       ▲                  ▲                  ▲                  ▲
       │ cycle-cap        │ cycle-cap        │ cycle-cap        │ cycle-cap
       └────── self ──────┘     (each dashed loop is a separate self-edge)

  haiku/medium   — reachable only when --start-tier haiku.
                  stuck edge: haiku/medium -> sonnet/medium.
                  cycle-cap edge: haiku/medium -> haiku/medium.
```

Each `cycle-cap` arc is a self-loop on its own rung — the `└── self ──┘` bus is a drawing convenience, not a shared transition between rungs. Rung 0 (`haiku/medium`) is never reached by escalation; it is a start-tier choice only. Escalation never descends.

### 15.3 New supervisor flags

Three flags land on `/ccx:supervisor`. Defaults are chosen so that running `/ccx:supervisor` with no flags preserves the pre-M7 cost envelope (first attempt at `sonnet`) while unlocking automatic escalation on stuck exits.

- **`--max-attempts N`** (default `4`). Maximum number of worker dispatches per task before the supervisor stops re-dispatching and escalates to the human. Default `4` exactly covers a full ladder climb from the default start tier: `sonnet → opus/high → opus/xhigh → opus/max` (four attempts inclusive). The running count is persisted as BOARD's existing `attempts` field (see §5); **no new BOARD field** — M7 is a supervisor + docs change, not a schema change. M7 **widens** the M5 semantics of `attempts`: under M5 the counter only incremented on `stuck` re-dispatch, but under M7 it increments on **every** re-dispatch — both `stuck` (which also bumps the tier) and `cycle-cap` (which retries the same tier). The §5 BOARD comment is updated to reflect this; implementations must increment on both outcomes or `--max-attempts` cannot bound the same-tier drain case (example (b) in §15.5).

- **`--worker-loops N`** (default `3`). Forwarded verbatim to each worker as `/ccx:loop --loops <N>` — the per-worker review-fix cycle cap. This is an **independent axis** from `--max-attempts`: `--worker-loops` controls how many review-fix cycles a single worker session runs with Codex before giving up inside its own loop; `--max-attempts` controls how many worker sessions the supervisor spawns for a task across tiers. A low `--worker-loops` with a high `--max-attempts` gives you "many short attempts across the ladder"; the opposite gives you "few but thorough attempts per tier".

- **`--start-tier <haiku|sonnet|opus|opus-xhigh|opus-max>`** (default `sonnet`). The rung the first attempt runs at. Subsequent escalations climb from this rung. Tiers below `--start-tier` are unreachable for that task — if the human sets `--start-tier opus`, rungs 0 (`haiku`) and 1 (`sonnet`) are off the ladder for that run and the effective ladder length shrinks to 3 (`opus/high → opus/xhigh → opus/max`). `--start-tier haiku` exercises the full 5-rung ladder; `--start-tier opus-max` is a 1-rung "no escalation available" run where only `cycle-cap` same-tier retries are possible.

### 15.4 Escalation rules — keyed on worker exit signal

The supervisor chooses the next action by reading the worker's `chat_close` exit status (the existing M5 channel) and the task's current tier + `attempts`:

| Worker exit         | `attempts` | Next tier       | Then                                           |
|---------------------|------------|-----------------|------------------------------------------------|
| `approved`          | —          | —               | Merge (existing M1 path). Task done.           |
| `filtered-clean`    | —          | —               | Merge (same path as `approved`).               |
| `stuck`             | `++`       | current + 1     | Re-dispatch at the next rung.                  |
| `cycle-cap`         | `++`       | same rung       | Re-dispatch at the same rung.                  |
| `aborted` / `error` | —          | —               | Block (existing M1 / M5 behaviour).            |

Edges the table elides:

- **`cycle-cap` is the M7 label for `/ccx:loop`'s `budget-exhausted` exit.** `/ccx:loop` Phase 4 closes with `budget-exhausted` when it runs out of cycles without approval and without detecting stuck. M7's escalation logic treats that status as `cycle-cap`; the wire format is unchanged. This relabelling is documentation-internal — the broker's recent-closures ring buffer still records whatever `/ccx:loop` emits.

- **Stuck-vs-cap ambiguity.** With `--worker-loops 3`, a worker can finish all three cycles hitting the same finding — that is simultaneously "stuck" (same finding in 3 consecutive cycles, `/ccx:loop`'s existing detector fires) and "cycle-cap" (loops exhausted). `/ccx:loop` reports the exit as `stuck` in this case. **Stuck takes precedence** so the tier bumps; M7 inherits that choice rather than re-litigating it.

- **End-of-ladder handling (at `opus-max`).** Nothing higher to escalate to:
  - `stuck` → human escalation via the existing M5 `AskUserQuestion` path (`opus-max` stuck is the literal "ladder exhausted" signal; further automation here would be speculative).
  - `cycle-cap` → same-rung retry (`opus-max`) until `attempts >= --max-attempts`, at which point block with reason `attempts-exhausted` and escalate.

- **`attempts >= --max-attempts` with no approval.** Regardless of the last exit type, the supervisor stops re-dispatching and escalates to the human. Per-task escalation is bounded by `--max-attempts`, not by ladder length; a small `--max-attempts` against a full ladder means the supervisor never reaches `opus-max`.

- **M5 interaction.** M5's `STUCK_REDISPATCH_CAP` and first-stuck `AskUserQuestion` prompt predate M7 and addressed the same failure mode by asking the human. M7 subsumes the automatic half (re-dispatch at a higher tier, no human prompt) while reusing M5's `AskUserQuestion` fallback at end-of-ladder. `STUCK_REDISPATCH_CAP` is superseded by `--max-attempts`.

### 15.5 Worked examples

All three examples assume `--start-tier sonnet` (default) and `--max-attempts 4` (default) unless noted. Each row is one attempt.

**(a) All-stuck ladder climb — the happy escalation path.**

| Attempt | Tier            | Worker exit | `attempts` | Next action                      |
|---------|-----------------|-------------|-----------|-----------------------------------|
| 1       | sonnet/medium   | stuck       | 1         | bump → opus/high                  |
| 2       | opus/high       | stuck       | 2         | bump → opus/xhigh                 |
| 3       | opus/xhigh      | stuck       | 3         | bump → opus/max                   |
| 4       | opus/max        | approved    | —         | **merge**                         |

Four attempts, full ladder climb, ends with merge. Uses the `--max-attempts 4` budget exactly.

**(b) All-cycle-cap same-tier drain — when loops-per-attempt was the bottleneck.**

Same defaults. Worker keeps running out of `--worker-loops` without triggering stuck (different findings each cycle):

| Attempt | Tier            | Worker exit | `attempts` | Next action                           |
|---------|-----------------|-------------|-----------|----------------------------------------|
| 1       | sonnet/medium   | cycle-cap   | 1         | same tier → sonnet/medium              |
| 2       | sonnet/medium   | cycle-cap   | 2         | same tier → sonnet/medium              |
| 3       | sonnet/medium   | cycle-cap   | 3         | same tier → sonnet/medium              |
| 4       | sonnet/medium   | cycle-cap   | 4         | **block** — `attempts-exhausted`       |

Four attempts, never leaves `sonnet/medium`. Blocks with `attempts-exhausted`. The human then decides whether to raise `--max-attempts`, raise `--worker-loops`, or move `--start-tier` up.

**(c) Mixed stuck + cap, opus-max cycle-cap drains budget.**

With `--max-attempts 5` so the example can finish its story:

| Attempt | Tier            | Worker exit | `attempts` | Next action                                         |
|---------|-----------------|-------------|-----------|------------------------------------------------------|
| 1       | sonnet/medium   | stuck       | 1         | bump → opus/high                                     |
| 2       | opus/high       | cycle-cap   | 2         | same tier → opus/high                                |
| 3       | opus/high       | stuck       | 3         | bump → opus/xhigh                                    |
| 4       | opus/xhigh      | stuck       | 4         | bump → opus/max                                      |
| 5       | opus/max        | cycle-cap   | 5         | **block** — `attempts-exhausted` at end-of-ladder    |

Illustrates both the stuck-bumps-tier and cap-stays-same-tier paths interacting, and the end-of-ladder cycle-cap behaviour: at `opus-max`, `cycle-cap` does not escalate to the human on its own — it keeps same-tier re-dispatching at `opus-max` until `--max-attempts` runs out, then blocks with `attempts-exhausted`.

### 15.6 Out of scope for M7

Deliberately deferred. Listed here so the reason is captured and not re-debated when a future M8 design picks up the thread:

- **Per-task `model_profile` field in BOARD.** A BOARD row that pre-declares its starting tier or attempts budget. Useful, but it mixes planning concerns into the queue schema and would require a corresponding `/ccx:plan` change; M7 deliberately keeps BOARD untouched (see §5). Candidate for M8 alongside planner updates.
- **`/ccx:plan` model inference.** Planner-side heuristic that guesses a cheap tier for docs tasks and a richer tier for code tasks. Out of scope because M7's default `sonnet` start already gives cheap tiers a first try before escalating; heuristic inference is a polish pass, not a correctness fix.
- **`--start-effort` override.** Mirror of `--start-tier` for the effort axis alone. Dropped to keep M7's user-facing surface at three flags; effort is coupled to model in the fixed ladder, so overriding effort independently would make the rung model harder to reason about. Revives as a targeted flag if a concrete pain case shows up.
- **Dynamic ladder config / re-ordering.** The five rungs are hardcoded in order. No YAML file chooses rungs or swaps their order. Motivated by the same "deterministic supervisor" property M4 and M5 rely on — a config-driven ladder multiplies failure modes (parse error, missing aliases, circular escalation edges) without a clear benefit at this stage.

These are explicit out-of-scopes so a future M8 design has a starting point for the supervisor's knob surface.

---

## 16. M8a — Supervisor infra refresh

Status: shipped 2026-05-23. Two narrow follow-ups to M7 that unblock M8b's duet loop (§17 — owned by T-2): replace the brittle worker-exit detector with a registry-backed lookup, and force every worker worktree to fork from the remote integration tip rather than the supervisor's potentially-stale local HEAD.

### 16.1 Worker exit detection via `claude agents --json`

**Why:** Through M7 the supervisor watched workers exit by polling the spawning Bash shell (`BashOutput` on the recorded `shell_id`). Two failure modes:

- A worker that re-spawns inside its own session (M8b's "Phase 2 respawn") releases its original shell handle; the supervisor would then observe the shell as terminated and misclassify a still-live worker as exited.
- Under M8b's higher worker count, every Step B pass ran a `BashOutput` probe per `RUNNING` entry — quadratic in worker count, with each probe also pulling the worker's growing log into the supervisor context just to read its exit status.

**What changed:** Step B now refreshes the agent registry **once per pass** with `claude agents --json` and joins each `RUNNING` entry against the result by `cwd == meta.worktree_path`. The JSON shape is an array of `{pid, cwd, kind, startedAt, sessionId, status, name?}`; `cwd` is the only field the supervisor controls deterministically at spawn time (PID and `sessionId` are assigned by `claude -p` and not known a priori), so it is the join key. Presence ⇒ still running (skip this task); absence ⇒ exited, and Step B step 2 takes over with the existing repo-state classifier (approved / no-commit / error) — those branches then feed §P2.5's recovery sub-classifier as before, so the {running / approved / stuck / cycle-cap / crashed / unknown} taxonomy maps cleanly onto the pre-existing exit_status vocabulary without new state.

The `shell_id` field stays in `RUNNING` records because Step C's adaptive polling primitive (§19.2) still reads `BashOutput` on `shell_id` to detect new output, and the log path is the user-facing artifact for post-mortem. Only the **exit-detection** branch moves off PID-style polling; the log-correlation handle persists for triage.

**Fallback.** When `claude agents --json` itself fails (binary missing, non-zero exit, malformed JSON) the supervisor reverts to the legacy `BashOutput`-on-`shell_id` exit check for the rest of the run, logging a single line — `M8a: claude agents --json unavailable — falling back to BashOutput polling for the rest of the run` — so a broken install degrades cleanly rather than misclassifying every worker as exited.

**Required Claude Code feature version:** `claude agents --json` lands in Claude Code 2.2.0. Earlier versions emit a non-zero exit and trip the fallback above automatically.

### 16.2 `worktree.baseRef: "fresh"` for worker worktree spawn

**Why:** Through M7 every worker worktree forked from the supervisor's local `HEAD` (`git worktree add` inside `/ccx:loop --worktree` resolved its base ref to whatever the parent checkout currently pointed at). But the supervisor's local checkout often lagged `origin/<INTEGRATION>` by minutes or hours — the human is reading email while waiting — and worker review-fix cycles then re-discovered issues that were already merged upstream, wasting Codex review tokens and producing merge-aborted exits when the squash dry-run finally collided with the diverged tree.

**What changed (two parts):**

1. **Phase P0 step 3a — fetch + fast-forward local integration once per run.** Supervisor runs `git fetch --quiet origin "<INTEGRATION>:refs/remotes/origin/<INTEGRATION>"` (explicit refspec; bare `git fetch origin <branch>` lands only in `FETCH_HEAD` and would leave `refs/remotes/origin/<INTEGRATION>` stale), then `git merge --ff-only refs/remotes/origin/<INTEGRATION>`. On FF success, local `INTEGRATION` advances to the upstream tip; every dispatch in this run forks from that fresh base. On FF failure (local ahead of origin from unpushed merges, or diverged) the supervisor logs one line and continues with local `HEAD` — the brief's documented `else local HEAD` fallback. NEVER attempt a non-FF merge, rebase, or hard reset mid-run; rewriting the supervisor's history while it is committing briefs and BOARD updates to the prior `HEAD` would corrupt in-flight state.

2. **Step A step 3a — supervisor pre-creates the worker worktree from the post-brief-commit HEAD.** Worktree creation moved out of `/ccx:loop --worktree` (worker-side) into the supervisor itself. The supervisor commits the brief on `INTEGRATION` (Step A step 3) and then forks the worker worktree from `git rev-parse HEAD` — which is the same commit Step B will eventually squash-merge INTO. Forking from `origin/<INTEGRATION>` directly would be a mistake: when local `INTEGRATION` has diverged from origin (the second/third/etc. dispatch of a run includes prior task merges on local), the `git log "<INTEGRATION>..ccx/<TASK.id>"` diff in Step B step 2 would include upstream-only commits as if they were worker work, and Step B step 3's squash would replay them into the `T-<id>: <title>` commit — silently inflating audit history and risking false conflicts. Forking from local `HEAD` (post-brief) keeps Step B's diff window exactly what it has always been: "what changed on the worker branch after fork."

The supervisor's `cd "<worktree_path>" && claude -p ...` spawn ensures the OS process cwd matches `meta.worktree_path` — that is the join key §16.1's M8a liveness check reads, and it only works because the supervisor owns the worktree path. The `<worktree_path>` substitution is whatever the M9 T-2 worktree-path resolver returned for this task (§18.2.1: `<STATE_DIR>/worktrees/<task_key>/` in customer mode, legacy `<REPO_ROOT>-<TASK.id>` sibling in dogfood mode); the M8a contract holds regardless of which branch fired because the cwd is whatever the supervisor `cd`'d into immediately before the `claude -p` exec. Stripping `--worktree=<TASK.id>` from `DISPATCH_PROMPT` is the matching worker-side change: `/ccx:loop` without `--worktree` runs in cwd, which IS the worktree.

Failure cases each have a documented fallback (none are fatal):

- No `origin` remote configured, or network down: P0 step 3a's `git fetch` errors are swallowed by `|| true`. Local `INTEGRATION` does not advance; dispatches fork from whatever local `HEAD` was at supervisor start. No warning — purely-local repos are a legitimate case.
- Local integration diverged from origin: FF declines, supervisor logs one line and continues with local `HEAD`. Subsequent dispatches still benefit from the per-dispatch invariant (fork from merge target).
- `git worktree add` itself fails (disk full, permission denied, race with another supervisor instance): per-task block with `exit_status: "stale-artifact"` and a notes string carrying the verbatim git stderr; the loop continues with other tasks.

**Required Claude Code feature version:** none — implemented entirely with plain `git fetch` / `git merge --ff-only` / `git worktree add -b`, which work back to Git 2.5 (`worktree add -b` was added in 2.5.0). The change is supervisor-internal and does not touch `/ccx:loop`'s public flags.

### 16.3 Explicit out-of-scope (M8b backlog)

Listed here so the M8b implementer (T-2) does not re-debate them:

- **`$CLAUDE_EFFORT` hook integration.** Echo the active effort level in worker logs for triage. Tracked but defer to M8b post-ship.
- **`--bg --name` named background sessions.** Would let `claude agents --json` surface the supervisor-assigned task id rather than only the `cwd` — useful for log-tail tooling, but the `cwd` join key already works.
- **`/code-review --comment` PR integration.** Posting Codex findings as inline PR comments. Separate axis; not blocked by M8a's infra.
- **`parentSettingsBehavior` for worker spawn.** Inheriting supervisor settings into the worker's spawn-time configuration. Touches Claude Code subagent surface; not part of M8a's `claude -p`-driven dispatch flow.

---

## 17. M8b — Duet loop

Status: proposed 2026-05-23. SSOT for T-3 to implement against. Built on the M8a infra refresh (§16): every duet worker is liveness-checked through `claude agents --json` (§16.1) and forks its worktree from the supervisor's post-brief-commit local `HEAD` per §16.2 — which itself fast-forwards local `INTEGRATION` to `origin/<INTEGRATION>` once per run before the first dispatch, so workers benefit from a fresh upstream base without bypassing local task merges queued earlier in the same run. The per-task worker can then grow from "one Claude session" to "one Claude session whose internal driver alternates with a Codex subprocess" without re-introducing the PID-polling failure mode §16.1 fixed.

### 17.1 Motivation

The Codex CLI was installed for the review gate at the bottom of `/ccx:loop` (§4.2's `--chat` path eventually triggers a `/codex:review` call inside the worker) and for the `/codex:rescue` escape hatch. Two implementer capabilities sit idle:

- **Implementer Codex is never invoked unless rescued.** `/codex:rescue` (`codex-companion.mjs task --write --json`) is the user-facing escape hatch when Claude is stuck. It is reactive — the human has to notice and trigger it — and it discards the loop state. The same primitive could be the duet's Codex implement turn, used proactively every cycle.
- **Reviewer Claude is never invoked at all.** Codex reviews Claude's work each cycle; nothing reviews Codex's. When the worker is doing pure-Claude implementation, the reviewer is a fundamentally different model (good); when the worker is doing pure-Codex implementation under `/codex:rescue`, the reviewer (also Codex) shares the implementer's blind spots.

M8b makes both directions the default operating mode of `/ccx:loop --duet`: Claude and Codex alternate as implementer, and each side reviews the other side's last implement turn. The hypothesis is that diverse-model alternation catches blind spots a single-model loop misses — the same intuition that motivates §15's M7 ladder (escalating to a stronger model when the current one is stuck) generalized to "escalate across model families on every turn." If the hypothesis is wrong in practice, the cost is twice the per-cycle wall-clock and roughly doubled token spend with no quality lift; `--duet` is opt-in (§17.3) so the cost is bounded to the runs that ask for it.

### 17.2 Per-turn sequence and the alternation rule

The happy-path sequence with Claude-lead (default) is a fixed **4-turn alternation** that repeats. "Alternation" is the unit used here for the round-trip Claude→Codex→Claude pattern; **"cycle" — used later in §17.9 — is reserved for the loop-budget unit (one implement + one review = two turns)**, the same unit non-duet `/ccx:loop` already uses. One alternation therefore equals two cycles. Keeping the two words distinct prevents `--loops 3` from being implemented as three 4-turn alternations (six implement + six review = twelve turns, double the intended budget):

```
       alternation k                            alternation k+1
┌──────────────────────────────────────┐   ┌──────────────────────────
│ T(4k+1)  Claude implement   ───┐    │   │ T(4k+5)  Claude implement
│ T(4k+2)  Codex review     ◀───┘    │   │ T(4k+6)  Codex review
│ T(4k+3)  Codex implement  ───┐    │   │ ...
│ T(4k+4)  Claude review    ◀───┘    │
└──────────────────────────────────────┘
```

Two rules govern advancement between turns:

1. **On reviewer approve, the implementer role flips.** The other side runs next. After a Claude review approves Codex's implement, Claude implements next (cycle boundary); after a Codex review approves Claude's implement, Codex implements next (mid-cycle boundary). The empty implement turn that follows an approval is expected — see §17.4.
2. **On reviewer reject, the same implementer re-runs.** The side that just heard the criticism keeps the implement turn to address it; the reviewer then re-reviews. This is the deliberate departure from strict alternation — having the rejecter implement their own fix would be diverse-model bug-fixing in theory but in practice asks Codex to re-engineer a passage it just criticised in Claude's voice, or vice versa, which compounds the style ping-pong that §17.6 already has to mitigate.

The implementer who runs after a rejection is therefore deterministic from the last review outcome alone; the driver does not need an "interrupted alternation" state machine — it tracks `last_implementer` and `last_review_outcome` only.

**Lead.** Default lead is Claude (the first implement turn is `Claude implement`). The `--codex-first` flag (§17.3) flips the lead so Codex's `codex-companion.mjs task` runs first and Claude's first turn is `Claude review`. Lead choice does not affect the convergence rule (§17.4) — both consecutive approvals still need to come from different reviewers.

### 17.3 New `/ccx:loop` flags

Two flags land on `/ccx:loop`; the supervisor (§4.2) learns to forward them to workers via a new brief frontmatter field. No new supervisor-level flags — `--duet` is a per-task decision (the same docs-only task should not flip between duet and non-duet across re-dispatches), so it lives at the brief level, not in `/ccx:supervisor`'s configuration surface.

- **`--duet`** — enable duet mode. Without this flag `/ccx:loop` is unchanged (single-model Claude implementer, Codex reviewer). With it, the driver enters the alternating sequence described in §17.2.
- **`--codex-first`** — flip lead to Codex. Only meaningful with `--duet`; the driver MUST reject the invocation with a precise error (`--codex-first requires --duet`) if it is passed without `--duet`. This matches T-3's queued argument-parsing contract; a silent no-op would let a user think duet was enabled when it was not, and a stray flag in a `/ccx:loop` invocation is a typo worth surfacing immediately.

**Brief-driven supervisor forwarding.** The supervisor's dispatch prompt template (§7.1, mirrored in `plugins/ccx/commands/supervisor.md` §P2.2) currently hard-codes the first line as `/ccx:loop --loops <WORKER_LOOPS> --commit --chat`. M8b extends the brief frontmatter (§6.2) with an optional `loop_flags: [...]` list — strings appended verbatim to that first line at dispatch time. A duet task brief declares:

```yaml
---
id: T-42
title: "..."
scope: { ... }
depends_on: []
loop_flags: ["--duet"]        # or ["--duet", "--codex-first"]
---
```

Supervisor's P2.2 string-builder appends each entry to the first line: `/ccx:loop --loops 3 --commit --chat --duet`. Validation runs against the **whole token** (not just the flag name): each entry must match `^--[a-z][a-z0-9-]+$` exactly — no `=`, no whitespace, no value suffix. Both M8b allowlisted flags are boolean toggles, so the `=` form has no legitimate use; an entry like `--duet=foo bar` would parse as a single token whose name fragment is `--duet` but whose appended payload could inject arbitrary additional CLI tokens into the worker command line. Rejecting the whole-token shape closes that injection vector at parse time. Future allowlist additions that legitimately take values (e.g. a hypothetical `--codex-effort=<level>`) MUST be allowlisted with an explicit per-flag regex (e.g. `^--codex-effort=(none|minimal|low|medium|high|xhigh)$`) rather than relaxing this regex; the per-flag regex constrains both the name AND the value's grammar in one pattern.

**Forwardable-flag allowlist** (the supervisor MUST reject `loop_flags` entries outside this set rather than forward them blindly — an over-permissive contract would let a brief override the supervisor-owned `--worktree`, `--loops`, `--commit`, or `--chat` flags from §4.2 and break M8a's cwd-based liveness lookup (§16.1) or duplicate the loop budget):

| Flag             | Allowed token form (exact match) | Reason it is on the allowlist                                                                 |
|------------------|----------------------------------|------------------------------------------------------------------------------------------------|
| `--duet`         | `--duet` (boolean)               | M8b-owned implementer-loop mode toggle (§17.3).                                                |
| `--codex-first`  | `--codex-first` (boolean)        | M8b-owned lead flip (§17.3); requires `--duet` per §17.3's argument-parse contract.            |

Everything else — including `--worktree`, `--loops`, `--commit`, `--chat`, any value-form variant of an allowlisted boolean (e.g. `--duet=true`), and any non-duet `/ccx:loop` flag — is denied with a precise error at the supervisor's Step A step 2 brief-validation pass: `loop_flags[<n>] '<token>' is not on the supervisor's forwardable allowlist (M8b allows: --duet, --codex-first as boolean tokens). Edit .ccx/tasks/<id>.md to remove or correct it.` Tasks fail dispatch with `exit_status: "loop-flags-rejected"` and a notes string carrying the rejected entry; the run continues with other tasks. Adding a future flag to the allowlist is a deliberate per-milestone act, not a default-open behaviour — every new entry requires a design-doc amendment here and a corresponding supervisor.md / loop.md change so the flag's interaction with the supervisor's worktree / liveness / merge invariants is reasoned about explicitly.

**BOARD schema and `/ccx:plan` stay unchanged per BOARD direction.** `loop_flags` lives only in brief frontmatter — never in `BOARD.md` rows, never in `/ccx:plan` output. The opt-in lifecycle:

1. **First-dispatch opt-in: human pre-creates AND commits the brief.** For a task that wants duet on its first dispatch, the human authors `.ccx/tasks/T-<id>.md` on the integration branch by hand — copying the §6.2 6-H2-section template, frontmatter included, and setting `loop_flags: ["--duet"]` in the frontmatter — then commits the new brief file (`git add .ccx/tasks/T-<id>.md && git commit -m "supervisor: pre-seed T-<id> duet brief"`) before running `/ccx:supervisor`. The commit step is required because supervisor's P0 clean-tree pre-check (§P0 step 2) refuses to run with `git status --porcelain` non-empty; an uncommitted pre-seed brief would abort the run before Step A could observe it. Supervisor's Step A step 2 (brief write) gains a "**preserve-on-overwrite**" rule (T-3 amends `plugins/ccx/commands/supervisor.md` §P2.1 / §P2.A step 2 accordingly): if `.ccx/tasks/<id>.md` already exists with parseable frontmatter, the supervisor reads `loop_flags` from it, applies all other BOARD-derived fields normally, and emits the regenerated brief with `loop_flags` copied through. This is the only frontmatter field the rewrite preserves; all others (id, title, scope, depends_on, body H2 sections) are still BOARD-sourced as before, so a stale brief cannot mask a BOARD edit. **No-op commit handling:** when the regenerated brief byte-matches the pre-seeded committed file (no fields changed because all BOARD-sourced data already matched the pre-seed exactly), Step A's brief-only `git commit` would fail under the existing "no-op commit treated as failure" rule and abort the dispatch despite the duet opt-in being valid. T-3's supervisor.md amendment MUST therefore use this exact ordering — write, stage, then probe — so the cached-diff check actually observes the regenerated content:

1. Write the regenerated brief to `.ccx/tasks/<id>.md` (overwrites the on-disk file).
2. `git add -- .ccx/tasks/<id>.md` (stage the regenerated content; without this step the cached diff would be empty regardless of whether the file changed, because `git diff --cached` only sees the index).
3. Run `git diff --cached --quiet -- .ccx/tasks/<id>.md`.
4. Branch on exit code:
   - **Zero exit (no staged diff, regeneration matched the committed pre-seed byte-for-byte)**: SKIP `git commit` and proceed to Step A step 3a, sourcing `BASE_REV = $(git rev-parse HEAD)` from the unchanged tip. The pre-seed commit already contains the brief content the worker needs.
   - **Non-zero exit (changes staged)**: `git commit -m "supervisor: prepare <TASK.id> <TASK.title> — brief"` as before, then continue to Step A step 3a with the post-commit HEAD.

The "write → stage → probe" order is load-bearing: a reading that probes before staging would always see an empty cached diff for the regenerated content and skip the commit even when BOARD-derived fields legitimately changed, leaving the worker forked from an old `HEAD` whose brief did not reflect the regeneration. The amendment keeps "every brief change lands as one commit" while not forcing an empty commit when nothing changed.
2. **Re-dispatch preservation.** After §15's stuck or cycle-cap re-dispatch the supervisor rewrites the brief again; the same preserve-on-overwrite rule keeps `loop_flags` stable across attempts so a multi-attempt duet task stays duet through the whole ladder.
3. **Post-first-dispatch opt-in (not recommended).** A task that started non-duet can be flipped mid-run by editing the on-disk brief between attempts: append `loop_flags: ["--duet"]` to the frontmatter, then let the next re-dispatch pick it up. Discouraged because it muddies the per-attempt audit trail (the same task brief shipped two different worker command lines across attempts); the cleaner path is to wait for the run to drain, then mark the task `pending` again with a hand-authored duet brief.
4. **`/ccx:plan` (§14) stays unchanged.** It writes BOARD rows only, never briefs. A future `/ccx:plan --duet` that pre-stages a duet brief alongside its BOARD row is M9 polish (§17.11), not M8b scope.

T-3 implements the preserve-on-overwrite rule in `plugins/ccx/commands/supervisor.md` and the brief-frontmatter line in this doc's §6.2; SSOT for both is this subsection.

No `--codex-model` / `--codex-effort` knobs ship in M8b — see §17.5 for why Codex stays at its companion-default model and §17.11 for the M9 deferral.

### 17.4 Convergence rule — counter increments and resets

The driver maintains an integer `approval_counter`, initialized to 0 at the start of the run and updated on every review and implement turn:

| Turn outcome                                | `approval_counter` action      |
|---------------------------------------------|--------------------------------|
| Review approves                              | `+= 1`; if `== 2`, terminate.  |
| Review rejects                               | reset to 0.                    |
| Implement with non-empty diff                | reset to 0.                    |
| Implement with empty diff                    | preserved.                     |

Termination requires **two consecutive approvals from different reviewers**, with no intervening reject and no intervening implement turn that introduced new code. Strict alternation (§17.2 rule 1) guarantees the two approvals come from different reviewers — after Codex review approves, the next review is Claude's, and vice versa.

**Why the empty-implement turn is preserved.** When Codex review approves at turn T, the driver runs Codex implement at T+1 anyway (rather than skipping straight to Claude review at T+2) so Codex sees the approved state and explicitly produces no changes — its empty diff is the audit trail that Codex agrees with its own approval. Skipping the turn would save one model call but lose the symmetry that makes the convergence rule diagram-able; the saving is not worth the asymmetry. Implementer prompts (§17.6) are explicit about this: "if the previous review approved, return without edits."

**Empty-diff detection.** The driver compares **pre-turn vs post-turn worktree state**, not worktree vs HEAD. After the first non-empty implement turn, any cycle-level `git diff --quiet` against `HEAD` would still see the accumulated task diff regardless of whether the current turn added anything — and would reset `approval_counter` on every post-approval empty turn, making the §17.10(a) happy path impossible to reach. The contract is therefore: just before spawning the implement turn, the driver snapshots the worktree+index state (concrete options: `git write-tree` after `git add --intent-to-add` of untracked paths, or a stable hash of `git status --porcelain` ∪ `git diff` ∪ `git diff --cached` outputs; T-3 picks the cheapest one the worker's environment supports). It snapshots again after the turn completes. Equal snapshots → empty diff for this turn; the implementer added nothing on top of the prior state and the counter is preserved. Unequal snapshots → non-empty diff and the counter resets per §17.4. Whitespace-only and comment-only edits between snapshots count as non-empty by design — a "clean up while I'm here" reformat that resets the counter is precisely what §17.6's style ping-pong mitigation aims to prevent at the prompt level; the snapshot equality check is the runtime backstop.

### 17.5 M7 ladder scope — Claude-only for M8b

M8b applies §15's 5-rung model+effort ladder to the **Claude side only**. Codex stays at the companion's runtime default model and default effort for every turn it runs in M8b — neither is named in this doc on purpose (see below). Concretely:

- Each Claude implement and Claude review turn is spawned at the rung the supervisor has the task on (via `--model <alias> --effort <level>`), inheriting M7's automatic-escalation behaviour: a `stuck` exit on the Claude side bumps the ladder, a `cycle-cap` exit retries the same rung. The Codex turns that interleave between Claude turns do not influence the rung — the supervisor's escalation logic reads only the `chat_close` status the **worker** emits at end-of-run (§17.9), and the worker emits one status for the whole duet, not per-side.
- The `codex-companion.mjs task` invocation passes no `--model` / `--effort`, matching how `/codex:rescue` invokes it today (rescue.md leaves both unset unless the user opts in explicitly). The default model and effort resolve inside the companion at runtime against the local Codex install; if a future Codex CLI bump renames its default, no design-doc change is needed.

The decision to hold Codex at its default is two-fold: (a) M7's tier ladder is calibrated against Claude's `--effort` levels which do not map cleanly onto Codex's `none|minimal|low|medium|high|xhigh` scale; (b) the supervisor's per-task budget (`--max-attempts`) is sized for one ladder, and pinning both sides to their own ladders multiplies the search space without a clear escalation signal to drive it. M9 may revisit (§17.11).

### 17.6 Style ping-pong mitigation — prompt-only

When two different models alternate as implementer on the same file, the natural failure mode is a style war: Claude renames a variable, Codex renames it back, Claude reformats a block, Codex re-reformats it differently. Each side's edits look like noise to the other's reviewer and reset the convergence counter (§17.4) every cycle.

M8b mitigates this purely at the prompt level. Each implementer turn's system / user prompt is extended with a fixed clause appended verbatim:

> When a previous implementer turn already touched this task, preserve that turn's file structure, naming, and code style. Limit your edits to the specific issue the latest review surfaced (or the missing piece this turn is responsible for). Do not reformat, refactor, or rename unrelated code. If the previous review approved and you have nothing substantive to add, return without edits — an empty diff is the correct response, not a flaw.

This clause attaches to both Claude and Codex implement prompts at every turn including the first. The first-turn redundancy ("when a previous implementer turn …" → there is none) is deliberate: producing the prompt by string concatenation rather than branching keeps the implementer-spawn primitive identical across turns, which matters because the same primitive runs inside both the `Agent`-spawned Claude implementer (§17.7) and the `codex-companion.mjs task --write --json` Codex implementer (§17.8).

No format pass. An earlier draft considered a "normalize with prettier / ruff before each review turn" step to eliminate format diffs entirely; rejected because (a) the project may not have a formatter configured, (b) running a formatter the worker did not author injects diffs the next implementer's reviewer would flag as unattributed, and (c) the prompt-only mitigation is reversible at zero cost if it does not hold up. Revisit if ping-pong is observed in practice.

### 17.7 Claude review primitive — sub-Claude `Agent` spawn with the `code-review` skill

**Decision: option (a) — sub-Claude `Agent` spawn invoking the existing `code-review` skill, with a fixed structured-output appendix.** The driver spawns an Agent (claude-type subagent) on each Claude-review turn, instructing it to run the user-installed `code-review` skill against the current worktree diff and emit a JSON envelope as the final line of its response.

The two candidates from the brief:

| Axis                              | (a) `Agent` + `code-review` skill                                | (b) `claude -p` subprocess with inline reviewer prompt          |
|-----------------------------------|------------------------------------------------------------------|------------------------------------------------------------------|
| Invocation cost                   | Shares the worker's plugin/skill cache, MCP connections, permission state; one `Agent` tool call. | Cold-start Claude process per turn; new MCP handshake, new permission negotiation, new log file. |
| Structured-output cleanliness     | Skill output is prose; structured envelope must be appended via prompt convention ("end with `<verdict>...</verdict>` block"). | Total control over output schema; can mirror Codex review's JSON shape exactly. |
| Approve/reject signal back to the driver | Driver parses Agent's reply text for the envelope; mismatched envelope = treat as reject and reset counter. | Same parse step, just on subprocess stdout instead of Agent reply. |
| Fit with chat_close status taxonomy | None — the duet driver emits the existing `approved` / `filtered-clean` / `stuck` / `budget-exhausted` / `aborted` / `error` exits regardless of which review primitive ran. | Same. Both primitives are internal to the duet driver; neither extends the worker-facing status enum. |
| Re-implementation surface         | Reuses an installed skill that is already the canonical "Claude reviews current diff" path. | Re-implements review prompt inline inside `/ccx:loop`'s duet driver, diverging from any future evolution of the `code-review` skill. |

Option (a) wins on invocation cost (no subprocess cold-start per turn — the duet runs ≥4 review turns per cycle and that overhead adds up over a `--loops 3` run), and on re-implementation surface (the `code-review` skill is the SSOT for "Claude reviews the current diff"; forking an inline copy is exactly the kind of drift that bit the supervisor when `/code-review --comment` got listed as a separate M8a backlog item in §16.3). Option (b)'s sole edge — structured-output cleanliness — is closeable by prompt convention: the driver's Agent prompt appends `Your final response MUST end with a fenced JSON block: \`\`\`json\n{"verdict": "approve"|"needs-attention", "findings": [...]}\n\`\`\``, and the driver parses that final block. Malformed or missing envelope is treated as `needs-attention` with one synthetic finding `("review-output-malformed", "<first 200 chars of reply>")` so the counter resets and the next implement turn surfaces the issue.

The driver passes the skill the same arguments `--min-severity` / `--min-confidence` that `/ccx:loop` already accepts (forwarded as Agent prompt instructions, not as skill flags — the `code-review` skill's flag surface is the skill's contract, not the duet driver's). Findings flow through `/ccx:loop`'s existing stuck-finding detector (§17.9) by `(file, title, body)` key.

### 17.8 Codex implement primitive — `codex-companion.mjs task --write --json`

Reuse `/codex:rescue`'s implementation path verbatim: each Codex implement turn invokes

```
node "${CODEX_ROOT}/scripts/codex-companion.mjs" task --write --json [prompt]
```

— the same one-line invocation the `codex:codex-rescue` subagent uses (see `rescue.md` operating rules). `--write` lets Codex edit files in place; `--json` returns a parseable result envelope; no `--model` / `--effort` per §17.5. The prompt the driver builds for each Codex implement turn is the task brief excerpt plus the latest review's findings plus the §17.6 style clause — exactly the same prompt shape as the Claude implementer would get, just routed to the Codex CLI.

`CODEX_ROOT` resolves with the same `find ~/.claude/plugins/marketplaces/openai-codex/plugins/codex ~/.claude/plugins/cache/openai-codex/codex -maxdepth 0 -type d 2>/dev/null | head -1` snippet `/ccx:loop` Phase 2 already uses for `/codex:review`. The first Codex turn that fails (binary missing, non-zero exit, malformed JSON, or `CODEX_ROOT` empty) STOPS the worker with `chat_close({status: "error"})` — the duet cannot proceed half-way, and falling back to single-model Claude mid-run would silently violate the user's `--duet` opt-in. The worker log captures the verbatim companion stderr so the supervisor's block-handler (§9) can surface it.

### 17.9 Worker exit signal taxonomy under duet

The duet runs inside one `/ccx:loop` worker session and emits one `chat_close` status at end-of-run; the existing taxonomy (`approved | filtered-clean | stuck | budget-exhausted | aborted | error`) carries over unchanged with the following per-status semantics adjusted for duet:

- **`approved`** — convergence rule (§17.4) fired: two consecutive review approvals from different reviewers. This is the dominant happy-path exit under `--duet`.
- **`filtered-clean`** — the convergence rule did not strictly fire but both reviewers' remaining findings all fell below `--min-severity` / `--min-confidence`. Mirrors `/ccx:loop`'s existing semantics (loop.md Step D rule 2).
- **`stuck`** — a single `(file, title, body)` finding key appeared in **three consecutive review turns** (from either reviewer, counted across both sides — the streak is a property of the finding, not of the reviewer who raised it). Duet does not double the stuck threshold because the failure mode is the same: the implementer cannot satisfy the criticism after two prior fix attempts; the third repeat justifies escalation. **Recovery asymmetry under M8b's Claude-only M7 ladder (§17.5):** the driver records which side's most-recent non-empty implement turn preceded the stuck streak — Claude-side or Codex-side — and surfaces that hint by writing one line to the worker's log file (`.ccx/workers/T-<id>.log`) **immediately before** calling `chat_close`, formatted exactly as `M8B_STUCK_SIDE: claude` or `M8B_STUCK_SIDE: codex` (one literal line, no trailing punctuation). The supervisor's §P2.5 stuck classifier — which already opens `meta.log_path` for triage — tails the last ~20 log lines on every `stuck` closure and scans for that token; presence → record `stuck_side` in `LAST_SIGNAL_ON_BLOCK`'s metadata alongside the existing signal value, absence → treat as `stuck_side=unknown` (a non-duet worker, or an old log). The chat broker's `chat_close` tool surface and recent-closures ring (`{sessionId,cwd,branch,label,status,at}`) stay unchanged — log-tail is the existing channel for worker-internal state the supervisor needs at block time, used by every block-handler since M5's `stuck-recovery-failed` notes path. Supervisor's §15 ladder bump still fires on every `stuck` exit, but only meaningfully escalates Claude-side stuck (a stronger Claude rung produces different code on Claude's implement turns). A **Codex-side stuck** would re-run with the same Codex default and most likely repeat the same `stuck` exit until `--max-attempts` is exhausted — explicitly an M8b limitation, tracked in §17.11 for M9 follow-up where the Codex side gets a ladder of its own or a separate `stuck-codex` block path. Until then, the human who sees a `stuck_side=codex` annotation in supervisor's Discord lifecycle event (§19.3) should disable duet for that task and re-dispatch single-implementer rather than re-trying duet.
- **`budget-exhausted`** — one **duet cycle** equals one implement+review turn-pair (two turns total); `--loops N` caps the worker at N such cycles. This matches the non-duet semantics where "one cycle = one impl + one review" — duet does not redefine the unit, it just alternates which side runs which turn. `--loops 3` therefore allows 3 impl + 3 review turns total (mixed Claude / Codex), not 3 full 4-turn alternations. Supervisor's §15 ladder treats this exit as `cycle-cap` (same-tier retry). **Minimum `--loops` under `--duet`:** because §17.4's convergence rule requires two consecutive approvals from different reviewers (≥3 review turns in the worst case where the first review approves and one empty implement turn intervenes), `--duet --loops 1` cannot possibly converge to `approved`. The duet driver MUST therefore reject `--duet` with `--loops < 2` at argument-parse time with `--duet requires --loops >= 2 (convergence needs two reviewer approvals from different reviewers)`. T-3's arg-parse contract picks this up alongside the `--codex-first` validation in §17.3.
- **`aborted`** / **`error`** — unchanged. `aborted` covers cancellation (loop.md cancellation semantics); `error` covers Codex companion crash (§17.8), Agent spawn failure (§17.7), or any uncaught exception in the duet driver.

No new worker-emitted `chat_close` status values — the implement/review primitive sequence is worker-internal and the supervisor sees the same six statuses it has handled since M5. **One supervisor-side block reason is added by M8b:** `loop-flags-rejected` (§17.3 brief-validation pass — task never gets dispatched because the brief carried an invalid `loop_flags` entry). T-3 amends supervisor.md §P3's blocked-reasons enumeration and §P0.5 step 7 rule 5's classifier mapping (`loop-flags-rejected` is a `completed`-classified session exit since the rejection is deterministic and bounded, not a stuck-flavored loop) so the new reason flows through the existing report / lifecycle / Discord paths without ad-hoc handling at each site.

### 17.10 Worked examples

All examples assume Claude-lead (default), `--loops 3`, `--min-severity low`, and start the run with `approval_counter = 0`. Each row is one turn. "Diff" describes the implement turn's outcome; "Counter" is the post-turn `approval_counter` value.

**(a) Clean 2-cycle approval — the happy path.**

| Turn | Side | Phase     | Outcome                                      | Diff       | Counter | Action                              |
|------|------|-----------|----------------------------------------------|------------|--------:|--------------------------------------|
| T1   | C    | implement | initial implementation                       | non-empty  |       0 | proceed                              |
| T2   | X    | review    | approve                                      | —          |       1 | proceed (flip → Codex implements)    |
| T3   | X    | implement | nothing to add post-approval                 | empty      |       1 | proceed (empty diff preserves counter) |
| T4   | C    | review    | approve                                      | —          |       2 | **terminate — `chat_close: "approved"`** |

Four turns total. Both reviewers approved consecutively; the empty Codex implement turn between them did not reset the counter.

**(b) Codex rejects, fix turn, then both reviewers approve.**

| Turn | Side | Phase     | Outcome                                                                  | Diff      | Counter | Action                                                   |
|------|------|-----------|--------------------------------------------------------------------------|-----------|--------:|----------------------------------------------------------|
| T1   | C    | implement | initial implementation                                                   | non-empty |       0 | proceed                                                  |
| T2   | X    | review    | reject — flags a missing edge case                                       | —         |       0 | proceed (reject keeps Claude as implementer per §17.2)   |
| T3   | C    | implement | Claude addresses Codex's feedback                                        | non-empty |       0 | proceed                                                  |
| T4   | X    | review    | re-review, approve                                                       | —         |       1 | proceed (flip → Codex implements)                        |
| T5   | X    | implement | nothing to add post-approval                                             | empty     |       1 | proceed (empty preserves counter)                        |
| T6   | C    | review    | approve                                                                  | —         |       2 | **terminate — `chat_close: "approved"`**                  |

Six turns. The reject at T2 kept Claude on the implementer turn at T3 (§17.2 rule 2); the subsequent two consecutive approvals (T4 = Codex, T6 = Claude with empty Codex implement between) satisfied convergence. This is the trace the brief example (b) describes.

**(c) M7 ladder escalation on a stuck Claude implementer turn.**

Start tier `sonnet`, `--max-attempts 4`. A docs-misalignment finding survives two fix attempts on Claude's side; Codex's reviewer keeps flagging it:

| Attempt | Tier             | Turn trace (abridged)                                                      | Stuck-finding streak | Worker exit  | Supervisor next action               |
|---------|------------------|----------------------------------------------------------------------------|----------------------|--------------|---------------------------------------|
| 1       | sonnet/medium    | C-impl₁ → X-rev reject (finding F₁) → C-impl₂ → X-rev reject (F₁) → C-impl₃ → X-rev reject (F₁) | 3                    | `stuck`      | bump → opus/high; re-dispatch         |
| 2       | opus/high        | C-impl₁ → X-rev approve → X-impl (empty) → C-rev approve                   | —                    | `approved`   | merge                                  |

The Claude side benefits from the tier bump; Codex stays at its default model across both attempts per §17.5. The supervisor's escalation decision reads only the worker's `chat_close` status — it does not see which side raised the stuck finding, and it does not need to: M7's premise is that a stronger model on the failing side resolves the deadlock, and only Claude has a ladder to climb.

### 17.11 Out of scope for M8b

Deliberately deferred to M9 so the M8b scope stays implementer-loop-only:

- **`--codex-model` / `--codex-effort` runtime knobs.** Same shape as M7's `--start-tier`, but for the Codex side. Out of scope per §17.5; revisit once duet has shipped and there is evidence the default Codex model is the failing axis on some class of task.
- **Per-task `model_profile` in BOARD.** A BOARD row that pre-declares duet on / off, lead side, and per-side tier hints. Couples to `/ccx:plan` and the BOARD schema; deferred jointly with M7's identical out-of-scope item (§15.6).
- **Format pass.** A prettier / ruff normalization step interleaved between turns. Rejected for M8b per §17.6; revives only if prompt-only ping-pong mitigation visibly fails.
- **Multi-implementer concurrency within a single cycle.** Running Claude implement and Codex implement in parallel and merging diffs. Touches scope-overlap detection (§9) and the worker's working-tree model in a way that has no design precedent; deferred indefinitely.
- **Codex-side stuck recovery via M7-style ladder.** Codex stays at default; no Codex-side rung to bump. §17.9's `stuck-side=codex` block reason is the human-visible signal that the current `stuck` exit will not benefit from automatic re-dispatch — M9 picks up either a Codex-side tier ladder (paired with the deferred `--codex-model` / `--codex-effort` knobs) or a distinct `stuck-codex` supervisor block path that skips the M7 retry entirely and escalates to the human on first occurrence.

---

## 18. M9 — Customer-mode invisibility

Status: proposed (2026-05-24). Touches: every command file under `plugins/ccx/commands/`, plus the verifier shipped in T-6 and the inspection helpers shipped in T-5. SSOT for the algorithm; M7 (§15) / M8a (§16) / M8b (§17) are the depth template.

### 18.1 Motivation

ccx today leaves heavy traces in any repo it touches:

- a `.ccx/` directory in the worktree (briefs, worker logs, audit JSONL, recovery sidecars),
- `BOARD.md` at the repo root,
- `ccx/T-X` worker branches that survive into merge commits as `Merge branch 'ccx/...'`,
- `T-X:` / `supervisor: dispatch` / `supervisor: update board` commit subjects mixed into product history,
- and brief / BOARD edits sweeping into the same commits as product changes.

This pattern is fine in this repo (it is dogfood — the ccx narrative *is* the product) but it is unacceptable in a customer's repo, where the user expects their git log to be indistinguishable from one written by hand. M9 plugs every leak vector by relocating tool state outside the working tree (T-1, T-2), forcing commit / merge hygiene (T-3, T-4), shipping inspection helpers + a dogfood opt-in flag (T-5), and adding a verifier that gates merges if any leak is detected (T-6).

M9 is treated as a **contract**, not a feature set. The six invariants below are checked automatically by `ccx verify` (T-6); a violation blocks the supervisor's pre-merge dry-run and the worker retries with a corrected message.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | The user's working tree contains no `.ccx/` directory or other ccx-owned files. | T-1 (state relocation); T-2 (worktree relocation); T-6 verifier |
| 2 | The user's `.gitignore` (committed) contains no ccx-related entries. | T-2; T-6 verifier |
| 3 | No commit subject or body on worker branches or new integration commits contains ccx tooling markers (`T-N:` prefix, `supervisor:` subjects, `ccx/` branch markers). Single exception: opt-in Git trailer `Ccx-Task: T-X` when `ccx.commit.trailer = true`, default false. | T-3; T-6 verifier |
| 4 | Mainline commits contain no merge commit whose first parent matches `Merge branch 'ccx/...'`. Default merge strategy is squash; merge-commit strategies gated behind `ccx.dogfood = true`. | T-4; T-6 verifier |
| 5 | After a worker finishes, no `ccx/T-X` branch ref remains. | T-2 (cleanup); T-4 (squash semantics); T-6 verifier |
| 6 | The user's `.claude/`, `CLAUDE.md`, `.claude/settings.json`, `AGENTS.md` files are untouched by ccx unless explicitly opted in. | T-3; T-6 verifier |

T-1 enables invariant 1 (no `.ccx/` in the working tree) by relocating every ccx state file out of `REPO_ROOT` in customer mode. This subsection (§18.2–§18.7) is the SSOT for that relocation; the other M9 tasks add subsections (§18.8 reserves the slots).

### 18.2 State path resolver — algorithm

All ccx state — `BOARD.md`, per-task briefs, worker logs, M3 audit JSONL, M4 recovery sidecars — lives under a single `STATE_DIR` resolved once at the top of `/ccx:supervisor` Phase P0 (and at the top of `/ccx:plan` Phase 0). `plugins/ccx/commands/supervisor.md`'s "State path resolver" section is the operational mirror of this subsection and MUST stay in lockstep with it.

Resolution algorithm (first match wins; evaluate top-to-bottom):

1. **`$CCX_DATA_HOME` env var.** If set and non-empty, `STATE_DIR = $CCX_DATA_HOME` verbatim — no `<repo-key>` suffix is appended. Operator-level escape hatch for tests (`CCX_DATA_HOME=/tmp/ccx-test-<run-id>`) and for users who want a single shared state root across multiple repos.
2. **Dogfood short-circuit.** `git config --local --get --type=bool ccx.dogfood` returning `true` → `STATE_DIR = REPO_ROOT/.ccx/`. The `--local` scope is load-bearing — §18.4 establishes that no global or system defaults are honoured for any ccx.* key, and a bare `git config --get` would silently inherit a global `ccx.dogfood = true` and activate dogfood mode in every repo on the machine. The flag must be set explicitly per-repo via `git config --local ccx.dogfood true` (the `--local` is also the default scope for `git config` when run inside a repo, so the plain form `git config ccx.dogfood true` writes to local config; the `--local` qualifier is spelled out for symmetry with the read sites and for resistance to a future Git default change); there is no global override and no auto-detection from repo name. This is the only mode in which a `.ccx/` directory legitimately appears in the working tree, and `ccx verify` (T-6) refuses to bless any other repo that carries one.
3. **`$XDG_DATA_HOME`.** If set and non-empty → `STATE_DIR = $XDG_DATA_HOME/ccx/<repo-key>/`.
4. **Platform default.** Linux (`uname -s` returns `Linux`) → `STATE_DIR = ~/.local/share/ccx/<repo-key>/`. macOS (`uname -s` returns `Darwin`) → `STATE_DIR = ~/Library/Application Support/ccx/<repo-key>/`. Windows is out of scope for M9 (deferred jointly with the broader Claude Code Windows story).

The XDG branch and the dogfood branch are mutually exclusive: a `true` dogfood flag short-circuits *before* any XDG lookup, so a customer who happens to set `ccx.dogfood = true` while `$XDG_DATA_HOME` is also set still gets `REPO_ROOT/.ccx/`. `$CCX_DATA_HOME` overrides both — operators running test harnesses against this repo can isolate state without touching the dogfood config. The override precedence is deliberate: developer-friendly knobs (`$CCX_DATA_HOME`) above per-repo knobs (`ccx.dogfood`) above environment defaults (`$XDG_DATA_HOME`) above platform defaults.

**Why `$XDG_DATA_HOME` and not `$XDG_CACHE_HOME`.** Board state is data, not cache. A cache directory is one a tool can safely delete to free space; `BOARD.md`, briefs, worker logs, and audit JSONL collectively constitute the operator's working memory across supervisor runs. Recovery from accidental eviction is technically possible (re-running `/ccx:plan` regenerates the BOARD; the workers' branches still exist) but lossy (the audit history disappears and any in-flight `stuck-recovery-failed` sidecars vanish). Treat ccx state as `$XDG_DATA_HOME` material throughout.

**Why a `<repo-key>` suffix.** A single user has many repos and a host-global broker (the ccx-chat singleton, §15.4); collapsing all of them into a single `~/.local/share/ccx/` directory would let a stuck task in repo A overwrite a worker log in repo B via filename collision (`T-1.log` from both runs would clash). Keying every state subdirectory by repo identity removes the collision class entirely, at the cost of a one-time directory creation per repo. The 7-char SHA-256 truncation matches Git's short-SHA convention and keeps the path readable in shell prompts.

### 18.3 `<repo-key>` derivation

Deterministic — fresh clones of the same upstream resolve to the same `<repo-key>` modulo `$HOME`, so a contributor on machine A and a contributor on machine B operating on the same upstream see the same logical state location (modulo whose disk it's on). M9 T-5 inserts a per-repo override at step 0 (the `ccx.link` key in `git config`); steps 1–3 are the unmodified auto-derivation fallback. Algorithm:

0. **T-5 — readable override.** If `git config --local --get ccx.link` returns a non-empty value → `<repo-key> = <ccx.link>` verbatim; the `<basename>-<sha>` shape is NOT applied. The `--local` scope is load-bearing — §18.4 establishes that no global or system defaults are honoured for any ccx.* key, and a bare `git config --get` would silently inherit a global `ccx.link` and route every repo on the machine through the same alias (which is exactly the failure mode a per-repo override is designed to avoid). Operator-chosen names are validated at WRITE time by `/ccx:link --name <readable>` against `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$` so the resolver can trust the value without re-validation. The override is per-repo (lives in `.git/config`, NOT in a repo-root file — invariant 1) and is removed by `/ccx:unlink`. Useful for: forks that want a distinct state path under a memorable name, repos that moved (renamed `REPO_ROOT` basename) and want the previous state directory's history without manually `mv`-ing it, and disambiguating two repos that legitimately share a remote URL + basename (rare but real for monorepos sharing a single canonical `origin`).
1. If `git remote get-url origin` exits 0 and returns a non-empty URL → `<repo-key> = <basename>-<sha256-7>` where the SHA-256 is computed over the URL string (raw bytes, NO trailing newline, NO normalization — case, scheme, and `.git` suffix are part of the input verbatim so two URLs that resolve to the same upstream via redirects still get different keys) and truncated to its first 7 lowercase hex chars. `<basename>` is the `basename` of `REPO_ROOT` lowercased. Example: a repo at `~/Code/MyProject` with `origin = git@github.com:will/myproject.git` resolves to `<repo-key> = myproject-a3f9b2c`.
2. Else if `git remote` lists at least one remote → use the URL of the **first remote in `git remote`'s output order** (which is alphabetical for git ≥ 2.20), same `<basename>-<sha256-7>` shape. Documented here so a fork with `upstream` set but `origin` missing — a legitimate pattern on private GitHub forks — still produces a stable key.
3. Else (no remotes — purely-local repo, never pushed) → `<repo-key> = <basename>-local-<sha256-7>` where the hash is over `realpath(REPO_ROOT)`. The `-local-` infix is load-bearing: it makes the local-only nature obvious to a human listing `$XDG_DATA_HOME/ccx/`, and it ensures two clones at different absolute paths produce two distinct state directories (correct behaviour — they're independent worktrees).

The 7-char truncation has a collision risk of approximately 1 in 268M between two unrelated repos that also share a `<basename>`. The failure mode is two repos' state co-located in one directory, which surfaces immediately as confused board state (two BOARDs trying to be the same file) and is recoverable by setting `$CCX_DATA_HOME` per-repo. We accept the risk on the same grounds Git accepts short-SHA collisions: rare enough to ignore in practice, recoverable when hit.

**Why not just hash the absolute path** in every case (skipping the remote URL)? Two reasons. First, the same upstream cloned twice on the same machine — a common workflow when a developer keeps a "stable" clone and a "wip" clone — would produce two distinct state directories, splitting the operator's working memory in half. Second, two contributors on the same upstream would never share a logical reference frame ("the T-12 log is at `<repo-key>/workers/T-12.log`") because their absolute paths differ. Hashing the remote URL keeps the logical reference shared while preserving correctness for the local-only fallback.

**Why not hash the project's working-tree contents** (a Merkle-style key)? Tempting but wrong: any commit advances the hash, so every push would invalidate the state directory. Remote URL is the right level: it changes only on `git remote set-url`, which is rare and operator-intentional, and it captures the identity of the project rather than its current state.

### 18.4 Configuration surface — `git config` keys

M9 introduces four configuration keys, all read via `git config --get`. They are per-repo (no global defaults are honoured) so different repos on the same machine can opt in to different modes:

| Key | Type | Default | Effect |
|---|---|---|---|
| `ccx.dogfood` | bool | `false` | When `true`, `STATE_DIR = REPO_ROOT/.ccx/` (state lives in the working tree), the supervisor's `supervisor:` commit subjects are retained, and `ccx verify` accepts `.ccx/` + `.ccx-config` as legitimate. Used by this repo only. **Read with `git config --local --get`** at every resolver site (supervisor, plan, the five T-5 helpers, and loop's commit-hygiene pipeline) so a global or system `ccx.dogfood = true` cannot activate dogfood mode in customer repos. Write with `git config --local ccx.dogfood true` (local is also `git config`'s default scope when run inside a repo, so the qualifier is documentary). |
| `ccx.commit.trailer` | bool | `false` | When `true`, T-3 (commit hygiene) appends an opt-in `Ccx-Task: T-X` Git trailer to worker-authored squash commits so an operator can grep for ccx provenance after the fact. Default off — invariant 3 forbids ccx markers unless explicitly opted in. **Read with `git config --local --get`** in `loop.md`'s commit-hygiene pipeline; a bare `--get` would inherit a global `ccx.commit.trailer = true` and append trailers to customer commits whose operators never opted in. `forever.md` mirrors loop.md verbatim and currently still uses bare `--get`; closing that drift is the same follow-up as the dogfood read drift (see §18.2.8 "Out of scope for T-5"). |
| `ccx.merge.strategy` | enum | `squash` | T-4 (merge strategy) honours one of `squash | rebase | merge`. `squash` (default) produces a single supervisor-authored squash commit per task with the worker's final commit message as the subject (no `T-<id>:` prefix in customer mode; preserved in dogfood mode). `rebase` (customer + dogfood opt-in) preserves individual worker commits via `git rebase <INTEGRATION>` + `git merge --ff-only`. `merge` is dogfood-only and STOPs the supervisor at config-load time (P0 step 1a) unless `ccx.dogfood = true` — it preserves the legacy `git merge --no-ff` shape with Git's default `Merge branch 'ccx/<task_id>'` subject. Customer mode is squash-or-rebase (the `merge` value is gated by the dogfood requirement). Any other value (including legacy `no-ff` / `ff` from pre-T-4 drafts) → P0 STOP with the enum-validation error. See §18.2.7. **Read with `git config --local --get`** (single site in `supervisor.md`'s Merge strategy resolver); a global default would force every customer repo into a strategy the operator never chose. |
| `ccx.paranoid` | bool | `false` | When `true`, T-6 (`ccx verify`) elevates every warning to a hard error. Default off — non-paranoid mode reserves the hard-error budget for invariants 1–6 and treats incidental drift (stale `Ccx-Task:` trailers on rebased commits, etc.) as warnings. **Read with `git config --local --get`** (single site in `supervisor.md`'s P0 step 1a alongside `IS_DOGFOOD`); a global default would activate paranoid worktree-key hashing in repos that never opted in. |
| `ccx.link` | string | `(unset)` | T-5. A readable per-repo override for `<repo-key>`. When set to `<readable>`, the resolver's `<repo-key>` derivation step 0 short-circuits to `<readable>` verbatim (no `<basename>-<sha>` shape), so customer-mode `STATE_DIR` becomes `<base>/<readable>/`. Written by `/ccx:link --name <readable>` with `git config --local` (which validates the value against `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`); removed by `/ccx:unlink` with `git config --local --unset`. **Both writers and readers use `--local` scope** — every resolver site (supervisor, plan, and the five T-5 helpers) calls `git config --local --get ccx.link` so a global or system `ccx.link` cannot leak across repos. Per-clone — stored in `.git/config`, NOT in a repo-root file (a repo-root config file would itself violate invariant 1). Shadowed by `ccx.dogfood = true` and by `$CCX_DATA_HOME` because both bypass `<repo-key>` derivation entirely; setting `ccx.link` in either configuration writes the config but has no observable effect on `STATE_DIR` until the shadowing branch goes away (`/ccx:link`'s confirmation message surfaces this). |

A repo may additionally commit a `.ccx-config` file as **dogfood-only metadata** documenting the operator's defaults (similar to `.editorconfig`). `ccx verify` treats `.ccx-config` as the single permitted dogfood-only filesystem exception and refuses it in non-dogfood checkouts. A customer's repo MUST NEVER receive a ccx-owned config file; T-3 / T-6 enforce this on the writer and reader side respectively.

### 18.5 First-run UX

On first resolution per run, the resolver:

1. `mkdir -p`s `STATE_DIR`, `STATE_DIR/tasks/`, `STATE_DIR/workers/`, `STATE_DIR/supervisor-audit/`. `STATE_DIR/BOARD.md` and `STATE_DIR/supervisor-recovery-*.txt` are NOT pre-created — their absence is a meaningful signal (no BOARD seeded → `/ccx:plan` not run; no recovery sidecar → no failed batch commit) and the writers (`/ccx:plan` Phase 2 for BOARD; supervisor §P2.4 for recovery) call `Write` directly when they fire.
2. Emits ONE line to stderr: `ccx state: <STATE_DIR>`. Fire-and-forget — must not crash on a closed-fd stderr (workers spawn the supervisor under `claude -p` and the stderr pipe is owned by the parent). Logged exactly once per run, regardless of how many later phases reference `STATE_DIR`.
3. Returns `STATE_DIR` to the caller. The caller caches it in a run-scope variable and re-reads that variable; the resolver is not re-invoked.

No interactive prompt. No tty check. The single stderr line is enough audit signal — a `claude -p` runner can pipe stderr to its supervisor log if it cares — and avoids the "first-run wizard" failure mode where a non-TTY context (CI, `claude -p` invocation, headless server) hangs forever on a prompt that nobody answers.

### 18.6 Where state files live, and what gets `git`-tracked

In customer mode (`STATE_DIR` outside `REPO_ROOT`):

| File | Absolute path | Git-tracked? |
|---|---|---|
| BOARD | `<STATE_DIR>/BOARD.md` | No — outside the worktree. |
| Per-task brief | `<STATE_DIR>/tasks/T-<id>.md` | No — outside the worktree. |
| Worker log | `<STATE_DIR>/workers/T-<id>.log` | No — outside the worktree. |
| Audit JSONL | `<STATE_DIR>/supervisor-audit/<RUN_ID>.jsonl` | No — outside the worktree. |
| Recovery sidecar | `<STATE_DIR>/supervisor-recovery-<RUN_ID>.txt` | No — outside the worktree. |

In dogfood mode (`STATE_DIR == REPO_ROOT/.ccx/`):

| File | Absolute path | Git-tracked? |
|---|---|---|
| BOARD | `<REPO_ROOT>/.ccx/BOARD.md` | Yes — committed by `/ccx:plan` Phase 3 and `/ccx:supervisor` Step D. |
| Per-task brief | `<REPO_ROOT>/.ccx/tasks/T-<id>.md` | Yes — committed by supervisor Step A step 3. |
| Worker log | `<REPO_ROOT>/.ccx/workers/T-<id>.log` | Optionally — typically `.gitignore`d in the dogfood repo to avoid log churn; the audit JSONL is the authoritative trail. |
| Audit JSONL | `<REPO_ROOT>/.ccx/supervisor-audit/<RUN_ID>.jsonl` | Yes — staged alongside BOARD in Step D's batch commit. |
| Recovery sidecar | `<REPO_ROOT>/.ccx/supervisor-recovery-<RUN_ID>.txt` | Yes when the merge-commit-failed branch fires; cleaned up on Step D success. |

The two columns differ only in the second one — customer mode is "write the file, never git it"; dogfood mode is "write the file and git it". The supervisor's git operations on `STATE_DIR` paths (Step A step 3 brief commit, Step A step 8 dispatch commit, Step D batch commit, §P2.5 step 4 brief revision commit) are gated on a conjunction predicate: `IS_DOGFOOD = (STATE_DIR == REPO_ROOT/.ccx/) AND (git config --get --type=bool ccx.dogfood == true)`. A generic `is_subpath(STATE_DIR, REPO_ROOT)` is NOT used — that loose form would mark an environment override like `CCX_DATA_HOME=$REPO_ROOT/.ccx` as dogfood even without the explicit `git config ccx.dogfood true` opt-in, silently writing state into a customer's working tree. The commands additionally STOP at resolver time when `STATE_DIR` lies inside `REPO_ROOT` without the dogfood flag set (the "In-repo `STATE_DIR` requires explicit dogfood opt-in" rejection in supervisor.md's resolver section). T-3 (commit hygiene) hardens this gate, defines the customer-mode write-only protocol, and removes the legacy `supervisor:` commit subjects entirely. T-1 (this milestone-section) establishes the gate's existence so an early customer-mode run cannot accidentally create the commits T-3 is meant to forbid.

### 18.7 Migration from pre-M9 state

Dogfood repos (this one) — no migration needed; `git config ccx.dogfood true` short-circuits to `REPO_ROOT/.ccx/`, which is exactly where state lived pre-M9. The one nuance: `BOARD.md` historically lived at `REPO_ROOT/BOARD.md`, not `REPO_ROOT/.ccx/BOARD.md`. The dogfood resolver returns `STATE_DIR/BOARD.md = REPO_ROOT/.ccx/BOARD.md`, so the existing root-level BOARD must be moved to `.ccx/BOARD.md` once. T-1 does NOT perform this move (out of scope per the brief — only `plugins/ccx/commands/*.md` and `docs/supervisor-design.md` are touched); the operator runs `git mv BOARD.md .ccx/BOARD.md` and commits, OR keeps the root BOARD and accepts that the next supervisor run will fail P0 step 4's existence check until they do. Manual one-time migration; flagging it here so the dogfood operator knows what to do on first M9 run.

Customer repos with no prior ccx history — no migration needed; the resolver creates the state directory on first access. Customer repos with a stray `.ccx/` directory from pre-M9 experimentation should `git rm -r .ccx/` and commit before running M9 commands; otherwise T-6's verifier blocks the next merge.

### 18.2.1 T-2 — Worktree relocation

Status: proposed (2026-05-24). Touches: `plugins/ccx/commands/supervisor.md` (the "Worktree path resolver" section, P0 step 1a's `IS_PARANOID` resolution, Step A steps 1b/3a/4/5/6/7, Step B step 5's worker-finish cleanup, §P2.5 steps 2/3(e)/4/5/6/7, and the P3 cleanup-print).

T-1 stopped a customer-mode `.ccx/` directory from appearing inside the user's worktree by relocating every state file to `<STATE_DIR>`. T-2 closes the corresponding leak ONE directory level up: pre-T-2 every worker checkout lived at `<REPO_ROOT>-<task_id>` as a sibling of the user's repo, visible in any parent-directory listing and named with the ccx-internal task id (`my-project-T-1/`, `my-project-T-2/`, …). T-2 moves that worktree into `<STATE_DIR>/worktrees/<task_key>/` in customer mode so the user's repo parent stays free of `*-T-<id>` siblings. Dogfood mode is unchanged (the legacy sibling path is the documented dogfood workflow).

**Worktree path resolver — algorithm** (mirrors §18.2's STATE_DIR resolver; per-task; first match wins; evaluate top-to-bottom):

| Mode | `<task_key>` | `<worktree_path>` |
|---|---|---|
| Dogfood (`IS_DOGFOOD == true`) | `<task_id>` | `<REPO_ROOT>-<task_id>` (legacy sibling) |
| Customer non-paranoid (`IS_DOGFOOD == false` AND `IS_PARANOID == false`) | `<task_id>` | `<STATE_DIR>/worktrees/<task_id>` |
| Customer paranoid (`IS_DOGFOOD == false` AND `IS_PARANOID == true`) | `sha256(<task_id> + ":" + <ISO-8601 UTC ts of this resolution>)[:8]` (lowercase hex) | `<STATE_DIR>/worktrees/<task_key>` |

`IS_PARANOID` is the cached result of `git config --get --type=bool ccx.paranoid`, resolved once at P0 step 1a alongside `IS_DOGFOOD`. Dogfood + paranoid is treated as dogfood: the resolver short-circuits to the legacy sibling path before consulting `IS_PARANOID`, because forcing an opaque hash onto a sibling-of-repo directory would defeat the legibility goal that motivates dogfood mode.

**`.git/worktrees/<task_key>/` metadata directory.** `git worktree add <path>` derives the metadata directory name in `.git/worktrees/` from `basename(<path>)`. Every resolver branch produces a `<worktree_path>` whose basename is exactly `<task_key>`, so the metadata directory automatically inherits the opacity (paranoid mode) or readability (default mode) of the chosen key. No `--name` flag exists on `git worktree add` and none is needed.

**Per-task caching.** The resolver is invoked exactly once per task per dispatch lifecycle: at **Step A step 1b for the first dispatch** (the pair is stashed on a per-pass scratchpad `TASK._resolved_worktree`, consumed by Step A step 3a and step 7 without re-invocation), and at **§P2.5 step 6 for every re-dispatch** (after the prior worktree was torn down in §P2.5 step 5; the pair is stashed on `REDISPATCH_RESOLVED` and consumed by the re-invoked Step A step 3a / step 7). Step A step 7 propagates the cached pair into `RUNNING[<task_id>].worktree_path` and `RUNNING[<task_id>].task_key` so every subsequent reference (spawn `cd`, Step B step 1 cwd lookup, Step B step 5 cleanup, §P2.5 cleanups, P3 reporting) reads the persisted value. The 1b-not-3a ownership rule for first dispatch is load-bearing: in paranoid mode each resolver call mints a timestamp-seeded hash, so resolving at step 3a would have step 1b's stale-artifact gate test one path while `git worktree add` creates a different one.

### 18.2.2 T-2 — Paranoid `_index.json` mapping

When `IS_PARANOID == true`, the supervisor maintains `<STATE_DIR>/worktrees/_index.json` as the authoritative `<task_id> ↔ <task_key>` mapping for live workers. Schema:

```json
{
  "version": 1,
  "entries": [
    {"task_id": "T-1", "task_key": "a3f9b2c0", "worktree_path": "<absolute>", "branch": "ccx/T-1", "created_at": "<ISO-8601 UTC>"},
    {"task_id": "T-3", "task_key": "7d4e1f92", "worktree_path": "<absolute>", "branch": "ccx/T-3", "created_at": "<ISO-8601 UTC>"}
  ]
}
```

**Full rewrite, never append-only** (per the brief's Decisions section). The file holds one entry per live worker, worker count is bounded by `--parallel` (default 3, max 10), and a full rewrite of a small JSON file is atomic via the standard write-temp-and-rename idiom (`mv` is atomic within a single filesystem on POSIX, and `<STATE_DIR>/worktrees/` is always on the same filesystem as the temp file by construction). Append-only would require a reader to scan the whole file and resolve duplicates, defeating the simplicity goal.

Write points (every write follows the temp-and-rename idiom):

- **After successful `git worktree add`** in Step A step 3a (first dispatch) AND §P2.5 step 6 (re-dispatch): upsert the entry for `task_id`.
- **After successful (or best-effort) worktree teardown** in:
  - Step B step 5 (terminal-exit worker-finish cleanup: merged, no-commit blocked, error blocked, merge-conflict / merge-aborted / merge-commit-failed);
  - Step A step 5 (first-dispatch spawn-failure cleanup);
  - §P2.5 step 2 (attempts-exhausted budget block);
  - §P2.5 step 3(e) — both stuck-aborted branches: the deliberate "Abort (mark blocked)" choice AND the empty-other-text reinterpretation (these return directly to the Step B drain loop and do NOT fall through to Step B step 5, so their `_index.json` prune is inline);
  - §P2.5 step 4 (stuck-recovery-failed commit-failure-recovery cleanup);
  - §P2.5 step 5 (pre-redispatch cleanup, plus the `stuck-cleanup-failed` failure branch when residue persists);
  - §P2.5 step 6 (retry-spawn-failure override — the freshly-created retry worktree has its new `_index.json` entry pruned alongside the worktree + branch teardown, since the failed retry never reaches Step B step 5).

  Each site removes the entry for `task_id` via the temp-and-rename idiom. Idempotent: if the entry is already gone or the file is missing, the rewrite of `{"version":1,"entries":[<...without this task>]}` is a no-op write.

Read points: no live read paths in the supervisor itself. The file exists for operator introspection — `jq '.entries[] | select(.task_id == "T-3")' <STATE_DIR>/worktrees/_index.json` answers "where is T-3's worktree on disk?" without the operator needing to know the hash. The supervisor always uses `RUNNING[<task_id>].worktree_path` directly and never trusts the file's contents back into its own logic — even after a crash that leaves a stale entry, the next run rebuilds `RUNNING` from BOARD and reconciles via the stale-artifact gate.

In customer non-paranoid mode `_index.json` is NOT written — the task-key equals the task id and the mapping is trivial. In dogfood mode the file is NOT written either — the sibling path is observable via `git worktree list`.

### 18.2.3 T-2 — Worker-finish cleanup contract

Pre-T-2 the supervisor printed `git worktree remove <REPO_ROOT>-T-<id>` in the P3 report and left it to the operator to run the command. That left a customer's repo parent directory cluttered with `*-T-<id>` siblings for as long as the operator failed to read and act on the report — visible to any other process listing the parent, and trivially backed-up by any tool that walks the parent (Time Machine, rsync to a backup mount). T-2 makes worktree removal **automatic on every worker terminal exit** so the leak window is bounded to the duration of one dispatch:

Two cleanup sites enforce the contract, partitioned by the control-flow path the task takes through Step B. Together they cover every terminal exit_status:

- **Step B step 5 (normal Step B terminal outcomes).** Step B's classifier in step 2/3/4 routes to: `merged` (clean squash + commit), `merge-conflict` / `merge-aborted` / `merge-commit-failed` (step 3 outcomes), generic `no-commit` (step 4 with no §P2.5 recovery), and `error` (non-zero shell exit). For each of these the task falls through to step 5 BEFORE being removed from `RUNNING`, where `git worktree remove --force "<meta.worktree_path>" 2>/dev/null` runs (paranoid mode also prunes the `_index.json` entry). The `--force ... 2>/dev/null` shape is idempotent — silently no-ops on a missing path, so the `stuck-cleanup-failed` retry case (where §P2.5 step 5's earlier attempt also touched this path) is safe.
- **§P2.5 inline cleanup (recovery-path terminal outcomes and re-dispatch teardown).** When Step B step 4's sub-classifier routes a `no-commit` exit to §P2.5, the recovery algorithm performs its OWN cleanup at every site that removes the task from `RUNNING` without falling through to Step B step 5. Those sites are: §P2.5 step 2 (`attempts-exhausted`), step 3(e) (both stuck-aborted branches — deliberate "Abort" and empty-other-text reinterpretation), step 4 (`stuck-recovery-failed`), step 5 (pre-redispatch teardown, plus its `stuck-cleanup-failed` failure branch), and step 6's retry-spawn-failure override. Each site runs the same `git worktree remove --force` + paranoid `_index.json` prune pattern inline before clearing `RUNNING`. Successful re-dispatches (§P2.5 step 9) leave the task in `RUNNING` with a fresh worktree and do NOT reach either cleanup site — Step B's next iteration will eventually classify the retry and route through whichever cleanup path applies then.

Step B step 5 specifically does NOT fire on the §P2.5 inline-cleanup branches because they return control directly to the outer Step B drain loop after their own cleanup, bypassing step 5. The two sites are mutually exclusive per task per exit, not overlapping — a given terminal exit lands at exactly one of them based on which classifier branch routed it.

- **Branch deletion is left to T-4** (later milestone). T-2 only removes the worktree; the branch ref `ccx/<task_id>` is left intact so the operator can `git checkout ccx/<task_id>` post-merge to inspect the squashed history or recover a blocked attempt's diff. The P3 report continues to print the manual `git branch -d ccx/T-<id>` command for now (the manual `git worktree remove` line is removed).

The cleanup contract is "any exit_status" per the brief — including `merge-commit-failed` and `stuck-cleanup-failed`. For `merge-commit-failed`, the recovery sidecar already records "Worker branch `ccx/<task_id>` is INTACT and contains the approved diff"; removing the worktree does NOT affect that statement (the branch ref lives independently). For `stuck-cleanup-failed`, an earlier §P2.5 step 5 attempt provably failed, and the human-facing notes string carries the manual-cleanup command; the Step B step 5 path is unreachable in this case (the task was already removed from `RUNNING` by §P2.5 step 5's failure branch).

### 18.2.4 T-2 — Cross-filesystem note

`git worktree add <path>` accepts paths on a different filesystem than the repo's `.git/` directory. Per the brief's Decisions section, no special handling is required: git's worktree machinery supports cross-FS locations natively. The `_index.json` write-temp-and-rename idiom relies on `mv` being atomic on a single filesystem; the temp file always lives alongside the destination (`<STATE_DIR>/worktrees/_index.json.tmp` → `<STATE_DIR>/worktrees/_index.json`), so the cross-FS question reduces to "what filesystem holds `<STATE_DIR>`" — a single user choice via `$CCX_DATA_HOME` or the XDG default, never split across multiple FS within one run.

### 18.2.5 T-2 — Out of scope

- **Forced relocation of in-flight workers' existing worktrees.** T-2 applies to NEW spawns only. A worker that was already running at the legacy sibling path when the supervisor binary is upgraded to T-2 finishes at that path; the per-task `RUNNING` entry caches the worktree path from dispatch time, so mid-run relocation is impossible by construction.
- **Branch deletion on worker finish.** T-4 owns `git branch -d ccx/<task_id>` after worktree removal. T-2 leaves the branch ref intact.
- **Migration of legacy sibling worktrees** from pre-T-2 customer-mode runs. The next supervisor run's Step A step 1b stale-artifact gate refuses to overwrite the legacy path; the operator runs `git worktree remove <REPO_ROOT>-<task_id>` once and the next dispatch lands at the new T-2 location. Auto-migration is rejected for the same reason T-1's BOARD migration is rejected — moving paths inside P0 would mutate operator state before the supervisor has even checked broker availability.
- **Validation that `<STATE_DIR>/worktrees/` is writable, or that `<STATE_DIR>` and `REPO_ROOT` are on the same filesystem.** Both are user-environment concerns; an unwritable `<STATE_DIR>` surfaces as the existing Step A step 3a `git worktree add` failure (classified as `stale-artifact` with the git stderr in notes), which already covers the diagnostic path. Cross-FS is documented in §18.2.4 above; no pre-flight check is added.

### 18.2.6 T-3 — Commit message hygiene

Status: proposed (2026-05-24). Touches: `plugins/ccx/commands/loop.md` Phase 4 (the worker's commit step), `plugins/ccx/commands/forever.md` Phase 4 (same pipeline mirrored), and this design subsection. T-3 ships the writer-side enforcement of invariant 3 (no `T-N:` / `supervisor:` / `ccx/` markers in customer-mode commits); T-6's `ccx verify` re-applies the same regex at merge time as the corresponding reader-side gate. Two layers because the worker's LLM rewrite may regress and a one-layer regex check is fragile.

The operational SSOT for the pipeline is the **Commit message hygiene** subsection in both command files (loop.md and forever.md carry the same three-step procedure verbatim — keep them in lockstep when one changes). This subsection is the **algorithmic SSOT** — the rewrite prompt template, the regex, the dogfood bypass, the trailer mechanics, and the new `commit-marker-leak` exit status are anchored here.

**Pipeline shape** (runs once per worker, between draft-message assembly and `git commit` in Phase 4):

1. Worker assembles the draft message exactly as today (subject + body + `Co-Authored-By` trailer per §15's worker contract).
2. **Style-mirror pass** — `git log --pretty='%s%n%b%n--' -30 <integration-branch>` + draft → in-session LLM rewrite.
3. **Marker-strip regex gate** — applied to the rewritten subject + body; on hit, go back to step 2; three consecutive hits abort the worker with `exit_status: commit-marker-leak`.
4. **Optional `Ccx-Task: T-X` trailer** — appended when `ccx.commit.trailer = true` AND `$CCX_TASK_ID` (or the dispatch prompt's `<task_brief id>`) is resolvable.

Dogfood mode (`ccx.dogfood = true`) **skips steps 2 and 3 entirely** — the draft message lands as-is, preserving the legible `T-X:` / `supervisor: dispatch` prefixes that make the dogfood narrative auditable. Step 4 is independent of dogfood mode; it still respects `ccx.commit.trailer = true` so a dogfood operator can still emit machine-parseable provenance if desired.

**Integration-branch resolution** (used by step 2's `git log`). Each candidate MUST pass `git rev-parse --verify --quiet <ref>` before selection. First passing candidate wins:

1. The output of `git symbolic-ref --short refs/remotes/origin/HEAD` used **verbatim** (typically `origin/main`). Do NOT strip the `origin/` prefix: stripping yields a bare `main` that may not exist as a local ref on fresh upstream checkouts where `git pull` has not yet populated a local tracking branch, and `git log -30 main` would fail. The remote-tracking ref resolves whenever the upstream publishes its `HEAD`, which is the common case.
2. Else try local `main`, then local `master`. Each candidate is verified individually so a missing local branch falls through cleanly.
3. Else `HEAD` — always resolves in any repo with at least one commit. Do NOT use a `HEAD~30..HEAD` range here: in repos with fewer than 31 commits the range is an invalid revision and `git log -30 HEAD~30..HEAD` fails. The `-30` cap on `git log` itself truncates to the last 30 commits regardless of history depth, so plain `HEAD` is the safe upper bound.

If none verify (brand-new repo with no commits, or a worker branch on a repo whose only ref is the worker's own branch), the worker still runs step 2 with an empty style sample — the LLM has no convention to mirror but the prompt's explicit "strip task IDs / tooling markers" instructions are still active, so the rewrite still produces a marker-stripped draft. **Step 2 is never skipped on no-style-sample:** skipping it would let the draft's tooling markers fall through to step 3 unchanged, and the regex gate would deterministically hit three times in a row on every regen attempt (the empty-prompt retries can't strip the markers either), producing a guaranteed `commit-marker-leak` exit for any valid draft on a fresh repo.

**Rewrite prompt template** (verbatim — the worker MUST NOT paraphrase this; M5's stuck-exit auto-revise depends on stable rewrites across retries to detect "the worker can't satisfy the regex" vs "the worker phrased the prompt differently and got lucky"):

> Rewrite the proposed commit message to match this repo's existing convention (prefix style, subject case, imperative vs past tense, trailing period, body presence). Strip any task IDs (T-NN) or tooling markers (`supervisor:` subjects, `ccx/...` paths or branch names). Preserve unrelated Git trailers (`Co-Authored-By`, `Signed-off-by`, etc.) verbatim. Output the rewritten message only — no preamble, no quotes, no fenced block.

On a retry after a regex hit, the worker appends one extra line to this prompt naming the markers that survived the previous rewrite:

> The previous rewrite still contained these tooling markers: `<comma-separated match list>`. Strip them.

Naive in-line stripping (e.g. regex-replace `T-N:` → ``) is forbidden by the brief's Decisions: it leaves dangling syntax (`": fix bug"` after stripping `T-3:`) and produces unnatural results. The whole point of step 2 is naturalness; only an LLM rewrite delivers that.

**Marker-strip regex** (anchor copy — both command files quote this exact string; never paraphrase or "improve" it without amending this subsection in the same commit). Pattern body in PCRE-style syntax with a negative lookbehind (`(?<!...)`); case-insensitive matching is applied via the engine's native flag (e.g. `grep -i -P`, `re.compile(..., re.IGNORECASE)`, `new RegExp(..., 'i')`) and is NOT encoded as an inline `(?i)` modifier — ECMAScript `RegExp` rejects inline mode flags with a `SyntaxError` at construction time:

```
(?<![A-Za-z0-9])(T-[0-9]+:|\[T-[0-9]+\]|\bT-[0-9]+\b|supervisor:\s*(dispatch|update board)?|ccx/)
```

Branch-by-branch rationale:

- `T-[0-9]+:` — the colon-suffix form workers used pre-M9 (`T-3: add CSV export`).
- `\[T-[0-9]+\]` — the bracketed form occasionally seen in PR titles or square-bracketed prefixes.
- `\bT-[0-9]+\b` — bare task ids anywhere in subject or body (`Implements T-12`); the word boundaries prevent matching `T-shirt` or `T-pose`.
- `supervisor:\s*(dispatch|update board)?` — the supervisor's own commit subjects (matches `supervisor:`, `supervisor: dispatch`, `supervisor: update board`); the optional capture group means a bare `supervisor:` also matches.
- `ccx/` — the worker-branch and worktree-path prefix. Requires a forward slash, so `Co-Authored-By: Claude` (which contains the substring `ccx` only as part of `Claude` — no slash) passes cleanly.

The leading `(?<![A-Za-z0-9])` is a **negative lookbehind for any alphanumeric character** (matches start-of-string AND any non-alphanumeric prefix — whitespace, punctuation, brackets, backticks). It prevents matches inside identifiers like `MyT-3Class` (the preceding `y` is alphanumeric, so the lookbehind blocks) while catching the punctuation-wrapped marker shapes the brief's "narrow to tooling-marker shapes" intent describes — `Merge branch \`ccx/T-3\``, `fix (T-3)`, `revert ccx/T-3-foo`. Per the brief's Decisions, the regex is **not configurable per repo** — a customer wanting custom regex is a rabbit hole; M9 ships one fixed regex and defers configurability.

**Deliberate deviation from the brief's literal regex.** The brief specifies `(?i)(^|\s)(...)` as the regex body. T-3's implementation broadens the prefix from `(^|\s)` to the negative lookbehind `(?<![A-Za-z0-9])` to fix a correctness gap discovered during T-3 review: the original `(^|\s)` only anchored at start-of-string or literal whitespace and silently passed every realistic punctuation-wrapped marker form (backtick-quoted in `Merge branch` messages, parenthesised in conversational subjects, slash-prefixed in path-style references). The broadened prefix preserves the brief's stated intent ("Match tooling-marker shapes, not ordinary product words") and is the only T-3 deviation from the brief's literal regex; every other alternation branch and the case-insensitive flag policy are kept verbatim. The `(?i)` inline mode flag is also dropped from the pattern body in favour of the engine-native flag (see the regex preamble above) — that change is a portability fix, not a semantic deviation.

**The `commit-marker-leak` exit status.** New worker exit status introduced by T-3; reserved value in the `chat_close({status})` taxonomy of `/ccx:loop` and `/ccx:forever`. Fires when `commit_marker_attempts` reaches 3 in step 3 (two regex hits followed by a third that exhausts the budget). The worker:

1. Sets `commit_marker_leak = true`, skips `git commit` entirely.
2. **Rolls back Phase 3's `.handoff.md` update** (the hygiene pipeline runs inside Phase 4, AFTER Phase 3 has already touched the worktree). `git checkout HEAD -- <handoff_path>` if it was tracked, `rm <handoff_path>` if Phase 3 created it new, no-op if Phase 3 was skipped (no `.handoff.md` present). This restores atomicity — a failed loop run leaves no observable trace in the worktree beyond the substantive `EDITED_PATHS` from Phases 1–2, which are preserved so the operator can salvage them. Without this rollback, the commit-marker-leak exit would leave a stale handoff edit on disk while the commit it described never landed.
3. Writes the final regenerated message and the matched markers to the worker log so the operator can see what failed.
4. Phase 4's `finally`-block invokes `chat_close({sessionId, status: "commit-marker-leak"})` exactly once.

**Supervisor-side handling — current behaviour and follow-up.** The worker's `chat_close({status: "commit-marker-leak"})` envelope is visible in the broker's closure ring buffer and in the worker log, so an operator who knows to look can identify the leak. However, the supervisor's existing generic no-commit handler (`supervisor.md` Step B step 4) hardcodes `exit_status: "no-commit"` for any closure that is not `stuck` / `budget-exhausted`, so `commit-marker-leak` reaches the BOARD row as the generic `no-commit` label — the leak distinction is lost on BOARD until a follow-up supervisor.md edit surfaces it. And because §P2.5's stuck-flavored signal mapping today branches only on `stuck` and `budget-exhausted`, the task does not automatically auto-revise and re-dispatch on a leak exit either — it simply blocks with the generic `no-commit` BOARD label until the operator intervenes.

Two follow-up supervisor.md edits are therefore needed to deliver the full M9 contract for this exit:
1. **Surface the actual close status on the BOARD row** — extend the generic no-commit handler to map known `chat_close` statuses (starting with `commit-marker-leak`) onto the stashed `exit_status` field, replacing the catch-all `"no-commit"` label.
2. **Route `commit-marker-leak` into §P2.5's stuck-flavored signal set** — alongside `stuck` / `budget-exhausted` — so the supervisor automatically revises the brief and re-dispatches per the M5 mechanism.

Both touch `plugins/ccx/commands/supervisor.md`, which is OUT of T-3's `scope.include` and therefore deliberately untouched in this milestone. They can ship independently of the worker contract documented here. Until they land, the documented unblock path is: operator reads the worker log to confirm a leak (the BOARD row shows `no-commit`), optionally revises the brief, and flips the BOARD row from `blocked` back to `pending` for re-dispatch.

**Trailer mechanics** (step 4). When the gate passes:

- Read `$CCX_TASK_ID` from the env (set by `/ccx:supervisor` Step A step 4 alongside `$CCX_TASK_BRIEF_PATH`); fall back to the dispatch prompt's `<task_brief id="...">` attribute when the env var is unset; fall back to `null` for direct (non-supervisor) `/ccx:loop` invocations.
- Read `ccx.commit.trailer` via `git config --get --type=bool` (treat absent or error as `false`).
- When both are non-null/true, run `git interpret-trailers --in-place --trailer "Ccx-Task: <TASK_ID>"` against the commit-message file. `git interpret-trailers` is the right tool because it canonicalises the trailer block separator (blank line before trailers), inserts the new line alongside any existing `Co-Authored-By` / `Signed-off-by` lines without duplicating, and produces output that `git interpret-trailers --parse` can extract — satisfying the brief's Acceptance criterion.

**Ordering relative to step 3** (load-bearing for T-6's reader-side regex). The trailer is appended in step 4 AFTER step 3's regex gate has already accepted the rewritten subject + body. The writer-side regex therefore never inspects the trailer line — without this ordering, the gate would match the `T-X` substring in `Ccx-Task: T-X` via the `\bT-[0-9]+\b` alternation branch and produce a false positive, making the opt-in trailer feature impossible to use. T-6's reader-side `ccx verify` MUST mirror this ordering: parse trailers via `git interpret-trailers --parse` and apply the regex only to the non-trailer portion of the subject + body. The brief's invariant 3 names the opt-in `Ccx-Task: T-X` trailer as the single permitted exception precisely to anchor this symmetric writer/reader contract; T-3 documents it here so T-6's implementation can rely on it without re-deriving the exception.

The trailer is opt-in for customer mode (default off — invariant 3 forbids ccx markers unless explicitly opted in) but the same flag works in dogfood mode for operators who want machine-parseable provenance on top of the human-legible `T-X:` prefix.

**Why two layers** (LLM rewrite + regex gate). A regex-only enforcement would mangle natural-language commits ("supervisor: dispatch events" rewritten as ": dispatch events" reads poorly), so the LLM produces a clean rewrite the regex audits. An LLM-only enforcement is non-deterministic — the model might regress on a low-effort tier or under a confusing prompt and emit `T-3:` again. The two-layer design gives the LLM three attempts to satisfy the regex; T-6's `ccx verify` re-applies the same regex at merge time so even a rare model regression that slips through the worker is caught before mainline lands.

**Out of scope for T-3** (per the brief and the M9 scope split):

- The merge-time enforcement of the same regex (T-6 `ccx verify`).
- The squashed-commit message rewrite at merge boundary (T-4 — applies the same pipeline one more time after the squash).
- Any per-repo configurable regex (deferred indefinitely per the brief's Decisions).
- Modifications to `supervisor.md` or any other command file beyond `loop.md` / `forever.md`. Two specific supervisor.md edits are needed to deliver the full M9 contract for the new `commit-marker-leak` exit — surfacing it on the BOARD row's `exit_status` field (today's generic no-commit handler collapses it to `"no-commit"`) and routing it into §P2.5's stuck-flavored signal set for auto-revise — and both are explicitly deferred follow-ups per the "Supervisor-side handling — current behaviour and follow-up" note above. T-3 stays within its `scope.include` constraint; the supervisor wiring can ship as a separate scoped task without changing the worker contract this subsection anchors.

### 18.2.7 T-4 — Merge strategy + branch cleanup

Status: proposed (2026-05-24). Touches: `plugins/ccx/commands/supervisor.md`'s "Merge strategy resolver" section (new), P0 step 1a (resolver invocation alongside `IS_DOGFOOD` / `IS_PARANOID`), Step B step 3 (strategy dispatcher replacing the pre-T-4 hardcoded squash), Step B step 5 (merged-exit branch deletion added to the existing T-2 worktree-remove), the P3 cleanup-print (removes the manual `git branch -d` per-merged-task command), and this design subsection.

T-2 closed the worker-worktree leak by relocating customer-mode worktrees out of the user's repo parent directory. T-4 closes the next two: the supervisor-authored `T-<id>: <title>` squash commit subject (invariant 3 — no tooling markers on the user's branch) AND the surviving `ccx/T-X` branch ref after a successful merge (invariant 5 — no `ccx/T-X` branch ref remains after a worker finishes). Both leaks were dogfood-narrative artifacts retained because pre-T-4 supervisor.md hardcoded a single merge primitive with no escape hatch for the legacy `Merge branch 'ccx/...'` shape the dogfood narrative depends on. T-4 generalises the merge step into a `ccx.merge.strategy` dispatcher, gates the legacy `merge` strategy behind `ccx.dogfood = true`, and folds branch deletion into the existing per-task cleanup contract.

**Strategy matrix** — same table as the supervisor.md "Merge strategy resolver" section, anchored here as the design SSOT:

| Strategy | Required mode | Git operations | Commit subject |
|---|---|---|---|
| `squash` (default) | customer + dogfood | `git merge --squash ccx/<task_id>` then `git commit -F <message-file>` where the message is the worker's final commit. Customer mode: T-3-processed at worker time AND re-checked at merge boundary (the regex anchor in §18.2.6). Dogfood mode: regex check SKIPPED — the worker bypassed T-3 entirely per §18.2.6 ("Dogfood mode skips steps 2 and 3") so its message intentionally carries `T-N:` / `supervisor:` subjects that ARE the dogfood narrative. | Customer mode: worker's final subject verbatim (no `T-<id>:` prefix — invariant 3). Dogfood mode: worker's final subject verbatim with its existing `T-X: <title>` prefix preserved. |
| `rebase` | customer + dogfood | `git rebase <INTEGRATION>` inside the worker's worktree, then `git merge --ff-only ccx/<task_id>` from the integration checkout. | Worker commits preserved verbatim (each subject already T-3-processed). |
| `merge` | dogfood only | `git merge --no-ff ccx/<task_id>` (legacy path). | `Merge branch 'ccx/<task_id>'` (Git default — the dogfood-narrative shape). |

The `ccx.merge.strategy` enum is one of `squash | rebase | merge`. Default `squash` matches the brief's "Default: squash" decision and preserves invariants 3 and 4 without explicit operator action. The `merge` strategy is gated behind `ccx.dogfood = true` AT CONFIG-LOAD TIME (P0 step 1a) — not at merge-attempt time — so a misconfigured customer-mode repo fails before any worker dispatches. Dogfood + `merge` is the SOLE configuration in which a `Merge branch 'ccx/...'` first-parent commit may appear on mainline; T-6's verifier enforces the inverse on every customer-mode checkout.

**Why squash as default for customer mode.** Squash produces ONE supervisor-authored commit per task on integration, with the worker's final (T-3-processed) commit message as its subject. No `T-<id>:` prefix, no `Merge branch 'ccx/...'` first parent, no `Co-Authored-By: Claude Opus` trailer mismatch (the worker's existing trailer flows through unchanged). The customer's git log reads exactly as if the work were authored by hand on the integration branch. Squash is also the cheapest to undo — one commit on mainline either survives or gets reverted as one unit, no merge-commit recovery dance. The trade-off (worker's per-cycle commit history is lost) is acceptable because `/ccx:loop` Phase 4 already collapses review-fix cycles into a single worker commit; squashing a one-commit branch produces a tree-equivalent result with a different commit identity (supervisor authorship + merge-time timestamp).

**Why rebase as the customer-mode opt-in.** Some operators value per-attempt commit history for blame / git-bisect / progress-tracking on long tasks. The rebase strategy preserves every individual worker commit on the integration branch via `git rebase <INTEGRATION>` on the worker branch followed by `git merge --ff-only` from integration. Each commit's subject + body are already T-3-processed at worker time (the regex gate fires inside `/ccx:loop` Phase 4 before any worker commit lands), so no extra rewrite happens at merge time. The result is a linear graph with no merge commits — invariant 4 holds without any subject-mutation; invariant 5 still requires the post-merge branch-delete because the branch ref otherwise survives. Rebase conflicts abort cleanly (`git rebase --abort` restores the pre-rebase state) and are classified as a new blocked `exit_status: "rebase-conflict"` — see "New exit_statuses" below.

**Post-merge cleanup contract** (T-4, all strategies, runs UNCONDITIONALLY after a successful merge): the supervisor removes the worker's worktree FIRST, then deletes the worker's branch. The order is load-bearing — `git branch -D` refuses to delete a branch checked out in any worktree, including the supervisor's just-completed merge worktree (squash, dogfood-merge) AND the worker's own worktree (rebase, where `git -C "<meta.worktree_path>" rebase` left the worker branch checked out at the new tip). Both operations are folded into `supervisor.md`'s Step B step 5 — the same site T-2 centralised for every terminal exit. T-4 only ADDS the branch-delete on the merged exit; blocked exits keep the existing T-2 behaviour (worktree removed for most blocked exits, branch preserved for human triage). The `rebase-conflict` blocked exit is the SOLE additional preservation rule introduced by T-4: both branch AND worktree stay intact so the operator can `cd "<meta.worktree_path>"` and resolve the conflict in place against the pre-rebase tip.

**The merge-boundary regex re-check** (squash strategy only). The brief specifies that the squashed commit's message is "the worker's final commit message, run through T-3's pipeline a final time at merge time (last regex check before mainline lands)." The merge-time check is REGEX-ONLY — the full T-3 pipeline (style-mirror LLM rewrite + regex + Ccx-Task trailer) ran at worker time with three retries; re-invoking the LLM rewrite at merge time would burn another round of generation budget on a message the worker already converged on, AND the brief's Decisions section explicitly rejects re-invocation ("Abort with `exit_status: leak-detected-at-merge` and let the supervisor's M5 stuck-exit auto-revise pick it up. We already retried 3× at worker time"). The supervisor:

1. Reads the worker's final commit message via `git log -1 --format=%B "ccx/<task_id>"` (subject + body + trailers in one git invocation, preserves blank lines).
2. Splits trailers from the subject+body via `git interpret-trailers --parse` and applies the regex ONLY to the non-trailer portion — same writer/reader symmetry T-3 established for the opt-in `Ccx-Task: T-X` trailer (the trailer line contains `T-<id>` and would otherwise trigger the `\bT-[0-9]+\b` branch). T-6's `ccx verify` will mirror this split when it lands.
3. Applies the T-3 marker-strip regex (anchored in §18.2.6) with case-insensitive matching via the engine's native flag (`grep -i -P`, NOT the inline `(?i)` modifier).
4. On hit, rolls back the staged squash via `git restore --staged --worktree .` and classifies the task as the new `leak-detected-at-merge` exit status — see below.

The rebase and dogfood-`merge` strategies do NOT run the merge-boundary regex: rebase preserves worker commits verbatim (their messages were already gated at worker time in customer mode, or are intentionally untouched dogfood-marker subjects in dogfood mode), and the dogfood-`merge` strategy's commit subject is Git's default `Merge branch 'ccx/<task_id>'` — a tooling marker by design, intentionally retained in dogfood mode. The squash strategy's regex check is ALSO skipped in dogfood mode for the same reason: dogfood worker commits bypass T-3's hygiene pipeline at commit time (§18.2.6 — "Dogfood mode skips steps 2 and 3"), so applying the marker-strip regex at merge boundary would deterministically reject every dogfood squash. Customer mode is the SOLE configuration in which the merge-boundary regex fires.

**New exit_statuses introduced by T-4:**

- **`leak-detected-at-merge`** — squash strategy only. The worker's final commit message passed T-3's marker-strip regex at worker time but regressed by the time the supervisor re-ran the same regex at the merge boundary. The rollback fired inside the strategy dispatcher; no commit landed on integration. The worker branch is preserved (Step B step 5 skips T-4's merged-only branch delete on blocked exits) so the operator can `git checkout ccx/<task_id>` and inspect the regressed message. **Recovery is operator-driven** — Step A's stale-artifact gate refuses to re-dispatch onto an existing `ccx/<task_id>` ref, so a naive "flip to pending and re-run" deterministically blocks as `stale-artifact`. Two recovery options: (a) **salvage** — `git commit --amend` on `ccx/<task_id>` to fix the subject, merge into `<INTEGRATION>` by hand (squash or rebase-then-ff), and mark the BOARD row `merged` manually; (b) **discard** — `git worktree remove <meta.worktree_path>; git branch -D ccx/<task_id>`, revise `STATE_DIR/tasks/T-<id>.md`'s `## Decisions` section to seed marker-strip guidance, then flip BOARD status to `pending` and re-run (the supervisor dispatches a fresh worker that re-implements from scratch).
- **`rebase-conflict`** — rebase strategy only. `git rebase <INTEGRATION>` (run inside the worker's worktree via `git -C "<meta.worktree_path>"`) could not replay one or more worker commits without conflicts. `git rebase --abort` restored the worker branch AND the worktree's index to the pre-rebase tip; both branch AND worktree are preserved (the SOLE additional preservation T-4 introduces beyond the T-2 contract — every other blocked exit keeps only the branch). **Recovery is operator-driven** for the same reason as `leak-detected-at-merge` above — Step A's stale-artifact gate refuses to re-dispatch onto the preserved branch/worktree. Two recovery options: (a) **resolve in place** — `cd <meta.worktree_path>; git rebase <INTEGRATION>` and resolve conflicts as Git surfaces them (the abort wiped the original conflict markers; this is a fresh rebase, not a resume), then merge into `<INTEGRATION>` by hand and mark the BOARD row `merged` manually; (b) **discard** — `git worktree remove --force <meta.worktree_path>; git branch -D ccx/<task_id>`, then flip BOARD status to `pending` and re-run. Note that an automatic adopt-the-preserved-branch path in Step A would be a useful future improvement (the supervisor could detect a `pending` task whose branch already exists at a strictly-ahead-of-integration tip and merge it instead of dispatching) but is OUT of T-4's scope.

Both exit_statuses are deliberately surfaced as separate from the existing `merge-conflict` / `merge-aborted` / `merge-commit-failed` set even though they share the "merge could not finalise" semantics: the remediation paths are strategy-specific (a `rebase-conflict` is fixed on the worker branch; a `leak-detected-at-merge` is fixed in the brief's Decisions section), and surfacing them as distinct labels avoids forcing the operator to read `notes` to understand what failed.

**Supervisor-side auto-routing of the new exit_statuses is OUT of T-4's scope.** Neither `leak-detected-at-merge` nor `rebase-conflict` auto-routes into §P2.5's stuck-flavored signal set — T-4 surfaces both as new BOARD `exit_status` values that block the task with the worker branch intact; routing them through the supervisor's stuck-recovery auto-revise mechanism would require extending Step B step 4's sub-classifier AND §P2.5's signal enum, which is out of T-4's per-task scope. Same deferral pattern T-3's "Supervisor-side handling — current behaviour and follow-up" applied to `commit-marker-leak`. Manual remediation is the documented path for now; a follow-up scoped to supervisor.md can wire the auto-routing later without changing the T-4 contract.

**Out of scope for T-4** (per the brief and the M9 scope split):

- **Per-task `merge_strategy` override** (a BOARD-row or brief-frontmatter field). M9 keeps BOARD schema unchanged; per-repo `ccx.merge.strategy` is the only knob in this milestone. A future M10+ may introduce per-task overrides if the use case appears.
- **Mid-run strategy switching.** `MERGE_STRATEGY` is resolved once at P0 step 1a and cached; a mid-run `git config` edit cannot half-apply. Every merge in a single supervisor run uses the same strategy.
- **Auto-routing `leak-detected-at-merge` / `rebase-conflict` into §P2.5.** Deferred per the "Supervisor-side auto-routing" paragraph above.
- **Auto-resolving rebase conflicts.** Explicitly rejected by the brief's Decisions ("Don't auto-resolve. Conflict resolution belongs to a separate task / human review.").
- **Squash-commit author/date manipulation.** Per the brief's Decisions, the squash commit uses Git's default for `git commit` after `--squash` — author = supervisor's identity, date = merge time. Operators wanting per-task author preservation use the `rebase` strategy.
- **Per-repo configurable regex** at the merge boundary. The regex is the T-3 anchor regex re-used verbatim; configurability was rejected indefinitely by T-3's brief.

### 18.2.8 T-5 — Inspection surface and dogfood escape hatch

Status: proposed (2026-05-24). Touches: five new command files under `plugins/ccx/commands/` (`where.md`, `board.md`, `tasks.md`, `link.md`, `unlink.md`), the `<repo-key>` derivation in `supervisor.md` (new step 0), the `ccx.link` row in §18.4 above, a committed `.ccx-config` at the repo root (this dogfood repo only), and this subsection.

T-1 through T-4 closed the four leak paths the M9 invariants name explicitly. T-5 closes the user-experience gap those changes opened: customer-mode `STATE_DIR` lives outside the working tree, so the operator can no longer `vim BOARD.md` or `ls .ccx/tasks/`. Five inspection helpers re-surface the same information through the slash-command interface, plus two helpers manage a per-repo readable override (`ccx.link`) for operators who do not want the auto-derived `<basename>-<sha>` cluttering their filesystem. The same section also documents the `ccx.dogfood` flag as the single escape hatch all T-1..T-4 behaviours consult — collected here as SSOT rather than re-explained in each task's subsection.

**Helper inventory** (each is a new top-level slash command — discoverable in Claude Code's `/`-completion alongside `/ccx:loop` and `/ccx:supervisor`):

| Command | Purpose | Side effects | Output |
|---|---|---|---|
| `/ccx:where` | Print the resolved `STATE_DIR` for the current repo. | None — read-only. Explicitly does NOT trigger the resolver's first-access `mkdir -p` side effect (the supervisor owns that contract; `/ccx:where` is pure inspection). | One line on stdout: `<STATE_DIR>/` (trailing slash). |
| `/ccx:board` | Open `STATE_DIR/BOARD.md` in `$EDITOR` (`exec $EDITOR "$BOARD_PATH"`) or fall back to `cat` if `$EDITOR` is unset. | None other than `$EDITOR`'s mutations (the operator's responsibility). | The editor's output stream, or the file's contents prefixed by `# BOARD: <path>` line in the `cat` fallback. |
| `/ccx:tasks [--status <value>]` | List `STATE_DIR/tasks/T-*.md` joined with BOARD `status:` + `title:` for each id. | None — read-only. | One line per task: `T-<id>  <status>  <title>`, followed by a `<N> task(s) listed` summary. |
| `/ccx:link --name <readable>` | Write `<readable>` to `git config --local ccx.link` so the resolver yields `<base>/<readable>/`. | One line written to `.git/config` (NOT to the working tree). | Confirmation: `linked: <new-STATE_DIR>/` (or a `no effect — <reason> shadows ccx.link` variant when dogfood or `$CCX_DATA_HOME` is active). |
| `/ccx:unlink` | Run `git config --local --unset ccx.link`; resolver reverts to auto-derivation. | One line removed from `.git/config`. | Confirmation: `unlinked (was: <prior>). state now resolves to: <new-STATE_DIR>/`. |

Each helper inlines the resolver algorithm verbatim (not via a shared shell library, which would require a `plugins/ccx/scripts/` dir scope T-5 does not include). The SSOT is `plugins/ccx/commands/supervisor.md` → "State path resolver"; if the algorithm changes there, mirror the change into all five helpers in the same commit so they don't drift.

**`/ccx:tasks` BOARD parsing.** The helper joins `T-<id>.md` filenames under `STATE_DIR/tasks/` with rows in `STATE_DIR/BOARD.md`. BOARD parsing is awk-based — the `## Tasks` YAML block has a stable shape (`- id: T-N` at column 0, two-space-indented key/value pairs) that awk handles without a python dependency. Briefs without a matching BOARD row surface as `status: ORPHAN`; rows whose `status:` or `title:` line is missing surface as `status: ?` (the helper is an inspection tool, not a validator). Numeric sort on task ids restores `T-2 … T-10` ordering, which lexicographic sort would scramble.

**The `ccx.dogfood` flag — full behavior matrix.** T-1 introduced the flag; T-2/T-3/T-4 added their own short-circuits keyed on it; T-5 collects the matrix in one place so an operator can read what "dogfood mode" actually changes without grepping four subsections:

| T-task | Customer mode (default, `ccx.dogfood = false`) | Dogfood mode (`ccx.dogfood = true`) |
|---|---|---|
| T-1 (state path) | `STATE_DIR = $XDG_DATA_HOME/ccx/<repo-key>/` (or platform default; or `$CCX_DATA_HOME`). BOARD, briefs, audit, recovery sidecars all outside the working tree; no commits. | `STATE_DIR = REPO_ROOT/.ccx/`. BOARD, briefs, audit committed alongside product code; legacy `supervisor:` commit subjects retained. |
| T-2 (worktree path) | `<worktree_path> = $STATE_DIR/worktrees/<task_key>/` (readable basename = `<task_id>` by default; opaque `sha256[:8]` in paranoid mode). | `<worktree_path> = <REPO_ROOT>-<task_id>` (legacy sibling-of-repo). |
| T-3 (commit hygiene) | Style-mirror LLM rewrite + marker-strip regex gate fire on every worker commit; three consecutive regex hits abort with `commit-marker-leak`. Opt-in `Ccx-Task: T-X` trailer when `ccx.commit.trailer = true`. | Style-mirror + regex SKIPPED. Worker commits land verbatim with their `T-<id>:` / `supervisor:` subjects intact. Trailer flag still honoured. |
| T-4 (merge strategy) | `ccx.merge.strategy = squash | rebase` valid; default `squash`. `merge` rejected at P0 with the dogfood-gate error. Squash subject = worker's T-3-processed final message (no `T-<id>:` prefix). | All three strategies valid (including legacy `merge` / `--no-ff` with `Merge branch 'ccx/<id>'` subject). Squash subject preserves worker's `T-<id>:` prefix. |
| T-5 (inspection) | All five helpers work normally. `/ccx:link` writes config; the override is honoured. `/ccx:where` prints the external path. | All five helpers still work. `/ccx:link` writes config but the resolver shadows it (dogfood short-circuit fires first). `/ccx:where` always prints `REPO_ROOT/.ccx/`. |
| T-6 (verifier) | `ccx verify` enforces invariants 1–6 strictly. A `.ccx/` directory or `.ccx-config` in the working tree is a verifier failure. | `ccx verify` runs with relaxed checks: `.ccx/` and `.ccx-config` are accepted; `T-N:` / `supervisor:` subjects are accepted; `Merge branch 'ccx/<id>'` first parents are accepted. |

**The dogfood opt-in is `git config --local ccx.dogfood true`** — no `.ccx-config` parsing, no auto-detection from repo name, no global default. The flag is per-clone (a freshly-cloned ccx-loop checkout is NOT in dogfood mode until the operator runs the git-config command), which keeps the gate auditable: `git config --local --get ccx.dogfood` answers "is this checkout in dogfood mode?" definitively. Every reader site uses `--local`; a global `ccx.dogfood = true` is intentionally ignored so the gate cannot be activated from outside the repo. A globally-defaulted or path-derived flag would mean "this checkout is in dogfood mode because…" with a fragile because-clause, which is exactly what the verifier needs to be able to refute deterministically.

**`.ccx-config` is dogfood-only metadata** — a committed TOML file (similar to `.editorconfig` in shape) that documents "this repo is the ccx tooling's own dogfood; fresh clones should set `ccx.dogfood = true`". The file is NOT consumed by any ccx command: the supervisor, plan, loop, forever, and inspection helpers all read their gates from `git config ccx.*`, never from `.ccx-config`. The file exists for human readers (cloning the repo, wondering why `.ccx/` is committed) and for `ccx verify`, which treats it as the single permitted dogfood-only filesystem exception (see §18.4 and T-6's verifier contract). A customer repo that accidentally commits a `.ccx-config` is a `ccx verify` failure regardless of value — the file's *presence* is the marker, not its contents.

**Why these helpers are slash commands, not shell utilities.** The brief's Decisions section ("Slash commands. Keep the surface uniform [everything M9 introduces is a slash command]. A shell script would force users to know where the plugin lives.") makes this explicit. Adding a `plugins/ccx/scripts/` dir for shell utilities was rejected for two reasons: (a) it doesn't compose with the existing `claude` slash-command UX, so users would need to learn two invocation patterns; (b) plugins on the marketplace have varying install paths (`~/.claude/plugins/marketplaces/<repo>/<plugin>/` vs `~/.claude/plugins/cache/<repo>/<plugin>/`), so a shell utility can't be `PATH`-discovered without per-plugin installer scripts the marketplace doesn't currently provide. Slash commands are discoverable in the existing completion UI and run inside the Claude Code session that already has the relevant Bash tool permissions.

**`/ccx:link` and the no-repo-root-file constraint.** The brief specifies "writes `<readable>` to a per-repo override file so future invocations resolve state at `$XDG_DATA_HOME/ccx/<readable>/`". A naive reading puts the file at `<repo-root>/.ccx-link` — but that file would land in the working tree, show up in `git status --porcelain`, and fail invariant 1 in `ccx verify`. T-5's resolution: write to `git config --local`, which targets `.git/config` (under the repo's git directory, but NOT in the working tree — `git ls-files` does not enumerate it; `git status --porcelain` does not surface it). Same scope ("per-repo, not global, not committed"), zero footprint on the user's diff. The brief's "override file" language is honoured by the spirit (a per-repo configuration store) without violating invariant 1 by the letter.

**Why `/ccx:link` does NOT migrate existing state.** A previously-linked or previously-auto-derived state directory persists at its old path after `/ccx:link --name X` is run — the helper only flips the resolver's future output. Auto-migrating state would have to either (a) `mv` the old directory atomically, which can fail across filesystems and would surprise the operator if multiple repos share the same `STATE_DIR` parent, or (b) walk the old directory and copy file-by-file, which is the kind of error-prone operation slash commands should not silently perform. The operator who wants history preserved runs `mv "$OLD_STATE_DIR" "$NEW_STATE_DIR"` themselves; the helper's confirmation message names the new path so they can compose the `mv` without re-running `/ccx:where` twice. Same rationale applies to `/ccx:unlink`.

**Shadowing precedence — explicit list.** The link override (`ccx.link`) operates inside the `<repo-key>` derivation, which only runs when the outer four-step resolution algorithm reaches the `<base>/<repo-key>` branches. Two earlier branches **shadow** the link:

1. `$CCX_DATA_HOME` set and non-empty → `STATE_DIR = $CCX_DATA_HOME` (no `<repo-key>`). The link is dormant.
2. `ccx.dogfood = true` → `STATE_DIR = REPO_ROOT/.ccx/` (no `<repo-key>`). The link is dormant.

`/ccx:link` writes the config either way (the operator may be preparing the repo for a future state — unsetting `$CCX_DATA_HOME` or `ccx.dogfood` — and the persisted value should already be in place when that happens), but the confirmation line surfaces the no-op explicitly so the operator is not surprised: `linked (no effect — $CCX_DATA_HOME shadows ccx.link): …` or `linked (no effect — ccx.dogfood=true shadows ccx.link): …`. The shadowing is documented in `supervisor.md`'s "Where the link override is consulted in the resolver pipeline" paragraph and is the same predicate `/ccx:where` evaluates so the messaging stays consistent.

**Out of scope for T-5** (deferred to later milestones, called out so a reviewer of T-5's diff sees the boundary):

- **`forever.md`'s commit-hygiene config reads.** T-5 moved every ccx.* read in scope (supervisor.md, plan.md, loop.md, the five new helpers) to `git config --local --get` so a global default cannot leak into customer repos. `plugins/ccx/commands/forever.md` carries a verbatim mirror of loop.md's commit-hygiene subsection per §18.2.6's lockstep contract, but is NOT in T-5's `scope.include`. Two reads in forever.md are still bare `--get` as a result: `IS_DOGFOOD = git config --get --type=bool ccx.dogfood` (lets a global dogfood flag skip T-3 hygiene in `/ccx:forever` runs on customer repos) and `WANT_TRAILER = git config --get --type=bool ccx.commit.trailer` (lets a global trailer flag append `Ccx-Task:` lines to customer commits whose operators never opted in). The lockstep mirror is slightly broken in the meantime — a follow-up task scoped to `{loop.md, forever.md}` should flip both forever.md reads to `--local` and re-state §18.2.6's "lockstep contract" line so loop.md and forever.md have identical commit-hygiene preambles. Filed here so a reviewer of T-5's diff sees the residual leak as a known boundary, not an oversight.
- **A shell utility that wraps `git config ccx.dogfood true`.** The flag is a single git-config command; introducing a slash-command wrapper would add surface area without removing typing. Operators set the flag directly.
- **Migration helpers that move state between linked and unlinked paths.** Operator-driven `mv` is the documented path; auto-migration is rejected per the "Why `/ccx:link` does NOT migrate existing state" paragraph above.
- **`/ccx:tasks --format json` or other output formats.** The helper emits human-readable text. A JSON / TSV output mode would be useful for scripting but is deferred — operators wanting machine-readable data can `awk` over the existing format or parse BOARD.md directly.
- **`/ccx:audit` or similar inspection helpers for the M3 audit JSONL.** Deferred — the JSONL is operator-readable as-is via `jq`, and no specific request has surfaced for a slash-command wrapper.
- **A `--global` mode for `/ccx:link`.** The override is per-repo by design (linking is an alias scheme for THIS repo's state path); a global link would either collide across repos or be meaningless. Operators with system-wide state-routing needs use `$CCX_DATA_HOME`.

### 18.8 Scope split across M9 tasks

T-1 (this subsection's depth) establishes the resolver, the configuration surface, and the customer-mode write contract. T-2 (§18.2.1–§18.2.5 above) builds on it to relocate worker worktrees. The remaining M9 tasks each get a sibling subsection under §18 once they land:

- **§18.2.1–§18.2.5 (T-2 — worktree relocation):** shipped — see the dedicated subsections above. Customer-mode worker worktrees live at `<STATE_DIR>/worktrees/<task_key>/` (readable basename = `<task_id>` by default, opaque sha256 prefix in paranoid mode), with a `_index.json` mapping in paranoid mode and automatic worktree teardown on every worker terminal exit.
- **§18.2.6 (T-3 — commit hygiene):** shipped — see the dedicated subsection above. Customer-mode worker commits pass through a style-mirror LLM rewrite + marker-strip regex gate before `git commit` fires; three consecutive regex hits abort the worker with the new `commit-marker-leak` exit status. Opt-in `Ccx-Task: T-X` trailer when `ccx.commit.trailer = true`; dogfood mode (`ccx.dogfood = true`) bypasses both passes.
- **§18.2.7 (T-4 — merge strategy + branch cleanup):** shipped — see the dedicated subsection above. Customer-mode merges default to `squash` with the worker's T-3-processed final commit message as the squashed subject (no `T-<id>:` prefix); `rebase` is the customer-mode opt-in for multi-commit history; the legacy `merge` (no-ff) strategy is gated behind `ccx.dogfood = true` and STOPs the run at config-load time otherwise. Post-merge cleanup unconditionally removes the worker's worktree (T-2) AND deletes its branch (T-4) on the merged exit; blocked exits preserve the branch per the T-2 triage contract. Two new blocked `exit_status` values surface T-4-specific failure modes: `leak-detected-at-merge` (squash strategy regex regression) and `rebase-conflict` (rebase strategy conflict).
- **§18.2.8 (T-5 — inspection helpers + dogfood opt-in flag):** shipped — see the dedicated subsection above. Five new slash commands (`/ccx:where`, `/ccx:board`, `/ccx:tasks`, `/ccx:link`, `/ccx:unlink`) surface the otherwise-invisible `STATE_DIR` and manage the per-repo readable override (`ccx.link`). The `ccx.dogfood` flag's full behavior matrix across T-1..T-6 is collected in that subsection as SSOT. Customer mode reads gates from `git config ccx.*` only; the committed `.ccx-config` is dogfood-only documentation.
- **§18.2.9 (T-6 — `ccx verify` + customer-mode README section):** shipped — see the dedicated subsection below. `plugins/ccx/scripts/verify.sh` operationalizes the six-invariant table above as a Bash script with distinct exit codes 10..15 (lowest matching code on multi-violation; full violation list on stderr). The supervisor invokes the same script as a pre-merge gate in Step B step 3; a non-zero exit routes the task into §P2.5 with `signal = "leak"` for same-tier brief-revise + re-dispatch. `/ccx:verify` is the user-facing manual wrapper. `README.md` "Customer mode" section anchors the contract for human readers.

Each subsequent M9 task amends THIS section (§18) rather than starting a new top-level section; the design doc keeps M9 as a single block so a reader can grasp the whole contract in one scroll.

### 18.2.9 T-6 — `ccx verify` pre-merge gate + customer-mode README

T-6 closes the M9 contract by mechanizing the six-invariant table from §18.1 as a Bash script (`plugins/ccx/scripts/verify.sh`) that the supervisor invokes as a pre-merge gate. The verifier exits 0 on a clean candidate and otherwise prints every violation to stderr while exiting with the LOWEST matching invariant code, so a single run surfaces the full leak picture rather than a one-at-a-time whack-a-mole.

**Why a two-layer enforcement (T-3 write-time + T-6 merge-time).** LLM rewrites can regress. T-3's commit-hygiene retry budget is bounded at three attempts at worker time; once it burns and the worker commits, the supervisor's pre-merge gate is the last line of defense before the message lands on mainline. Without T-6, a worker that produces a marker-laden subject after exhausting T-3's budget would silently propagate the leak to integration. The two layers are not redundant — they enforce the same contract at different times: T-3 catches the common case cheaply (worker fixes its own output before commit); T-6 catches the rare regression and surfaces structured detail back to the worker's next attempt via M5 auto-revise.

**Why a shell script (not Python / not a Node helper).** Six invariants × the entire set of supported customer repos × every supervisor run = a tight cold-start budget. Bash + `git` + `grep` + path existence is the natural shape for invariants 1, 2, 4, 5, 6. Invariant 3 — the commit-marker scan — additionally needs Python because the punctuation-bounded marker regex (`(?<![A-Za-z0-9])(T-[0-9]+:|…)`) and the trailer-block validation that gates the Ccx-Task carve-out both exceed what POSIX ERE + portable `grep` can do safely. The verifier fails closed (exit 2) if `python3` is absent rather than silently degrading invariant 3 — a degraded gate that misses punctuation-bounded markers (`fix (T-6)`, `update 'ccx/foo'`) defeats the whole pre-merge contract. The supervisor's P0 prereq check is the right place to surface this BEFORE dispatching workers; manual `/ccx:verify` callers see the same exit-2 message and can install python3.

**Exit code surface (1:1 with the §18.1 invariant numbering):**

| Code | Invariant | Detector |
|---|---|---|
| 0  | — (clean)         | every check below passed |
| 10 | 1 (.ccx/ in tree) | `[ -d "$REPO/.ccx" ]` AND `ccx.dogfood != true` |
| 11 | 2 (.gitignore)    | `grep -E '^\.ccx/?$\|^\.ccx/\*' "$REPO/.gitignore"` matches AND `ccx.dogfood != true` |
| 12 | 3 (commit markers)| `git log --pretty='%s%n%b' "$BASE..$TARGET_REF" \| grep -v '^Ccx-Task:' \| grep -iE '(^\|[[:space:]])(T-[0-9]+:\|\[T-[0-9]+\]\|T-[0-9]+\|supervisor:[[:space:]]*(dispatch\|update board)?\|ccx/)'` matches AND `ccx.dogfood != true`. For squash strategy the supervisor also feeds the proposed final commit message via `CCX_PROPOSED_MSG` so a regressing subject is caught BEFORE the squash commit is created (belt-and-braces complement to T-4's existing merge-boundary regex). |
| 13 | 4 (mainline merge)| `git log --merges --pretty='%s' "$BASE..$TARGET_REF" \| grep -E "Merge branch 'ccx/"` matches AND `ccx.dogfood != true`. Default squash strategy never produces merge commits, so this fires only under `ccx.merge.strategy = merge` — which the supervisor's config-load gate already STOPs in customer mode. The verifier is the second backstop. |
| 14 | 5 (stale branches)| `git for-each-ref 'refs/heads/ccx/T-*'` returns non-empty after exempting `$TARGET_REF` (the worker branch the supervisor is about to merge is obviously still present at pre-merge time). Runs ALWAYS, even in dogfood — stale `ccx/T-*` branches are bad hygiene regardless of mode. |
| 15 | 6 (protected paths)| `CCX_DIFF_PATHS` (newline-separated) matches `^(\.claude/\|CLAUDE\.md$\|AGENTS\.md$)` AND `CCX_PROTECTED_OPTIN != 1`. Independent of dogfood — even dogfood runs require explicit opt-in to edit `.claude/` / `CLAUDE.md` / `AGENTS.md`. |
| 2  | verifier itself failed | not a git repo, `REPO` unset and cwd is non-git, etc. Operator-action exit; never returned from the supervisor's path because Step B step 3 has already established `REPO == $(pwd)` by then. |

**Multi-violation contract.** When more than one invariant fires, the script exits with the LOWEST matching code AND prints every violation to stderr (one `ccx verify: …` line each). The lowest-code rule keeps telemetry stable (one primary classifier per run); the full-list stderr feeds M5's auto-revise step 4a so the worker sees every leak in its next attempt's Decisions section, not just the first one. A `leak-12 + leak-13 + leak-15` combination becomes `leak-12` in the BOARD `exit_status` field and a three-line block in the synthesized revise prompt.

**Inputs (env vars, NOT argv).** Argv is reserved (the script takes no positional arguments); inputs are env vars so multi-line strings (`CCX_PROPOSED_MSG`, `CCX_DIFF_PATHS`) land without shell-quoting hazards:

| Variable | Purpose |
|---|---|
| `REPO` | Repository root. Default: `git rev-parse --show-toplevel`. |
| `BASE` | Integration baseline ref. Default: `HEAD`. The supervisor passes `<INTEGRATION>` here. |
| `TARGET_REF` | Candidate worker ref. Default: `HEAD`. The supervisor passes `ccx/<task_id>`. Pass empty for "no worker in flight" (invariants 3/4/6 degrade to no-ops; invariant 5 flags every `ccx/T-*` ref). |
| `CCX_DIFF_PATHS` | Newline-separated diff path list for invariant 6. Supervisor passes `git diff --name-only "$BASE...ccx/<task_id>"`; manual `/ccx:verify` falls back to the same computation. |
| `CCX_PROPOSED_MSG` | Squash-strategy ONLY — the worker's final commit message that the squash will land verbatim. Scanned by invariant 3. Left empty for rebase / dogfood-merge (the per-commit subjects in the range are scanned directly). |
| `CCX_PROTECTED_OPTIN` | When `=1`, invariant 6 is bypassed. Env-var-only (no `git config` knob) so a careless flip cannot silently disable invariant 6 across a machine. |

**Supervisor wire-up (Step B step 3 of `plugins/ccx/commands/supervisor.md`).** The gate runs AFTER the pre-merge cleanliness assert (so a dirty integration tree blocks the verify call from running on stale state) and BEFORE the `case "$MERGE_STRATEGY"` dispatch (so a leak block fires identically across squash / rebase / dogfood-merge — T-4's own merge-boundary regex is squash-only; T-6 unifies). On non-zero exit:

1. The strategy dispatch + commit/rollback block is skipped entirely. No `git merge` / `git rebase` / `git restore` has run yet — the integration tree is still in its pre-merge clean state, so there is NOTHING to roll back.
2. The task routes into §P2.5 with `signal = "leak"`, `leak_detail = VERIFY_STDERR`, and `leak_code = VERIFY_RC` (10..15). §P2.5 step 1's new branch fires, step 4a synthesizes a Decisions entry from the leak detail, step 5 tears down the prior worktree+branch, and step 6 re-dispatches at the same tier.
3. The leak path is budget-gated like cycle-cap and below-opus/max stuck (§P2.5 step 2): exhausted budget blocks with `exit_status: "attempts-exhausted"` and `LAST_SIGNAL_ON_BLOCK = "leak"`, which P0.5 step 7 rule 3 maps onto the stuck-flavored session close.
4. Per-task only; do NOT set `STOP_DISPATCHING` — a leak regression on one worker does not invalidate others' merges.

**Invariant → exit code → detector → revise hint template** (the §P2.5 step 4a Decisions entry is seeded from the verifier's stderr verbatim; the table here is the human-readable index of what each entry will look like):

| # | Code | Detector | Revise hint shape (what step 4a tells the next attempt) |
|---|---|---|---|
| 1 | 10 | `[ -d "$REPO/.ccx" ]` | "Do NOT create a `.ccx/` directory in the working tree. Use `STATE_DIR` (resolved via `$CCX_DATA_HOME` / `$XDG_DATA_HOME` / platform default) for all task state." |
| 2 | 11 | `.gitignore` matches `^\.ccx/?$\|^\.ccx/\*` | "Do NOT add a `.ccx` entry to `.gitignore`. The line is itself a ccx footprint; remove it per the README ccx-migrate section." |
| 3 | 12 | commit message regex hit | "Rewrite the worker's commit subject/body to drop `T-N:`, `[T-N]`, standalone `T-N`, `supervisor:dispatch`, `supervisor:update board`, and `ccx/` markers. Use a natural commit message (e.g. `fix: …`, `add: …`). The opt-in `Ccx-Task: T-N` trailer is allowed only when `git config --local ccx.commit.trailer true`." |
| 4 | 13 | `Merge branch 'ccx/...'` mainline | "Squash strategy never produces this. If your worker sees this code, `ccx.merge.strategy` was misconfigured — the supervisor's config-load gate should have STOPped earlier." |
| 5 | 14 | stale `ccx/T-*` branch | "Branch ref hygiene is the supervisor's job, not the worker's. If a re-dispatch trips this, the supervisor will surface a manual cleanup hint." |
| 6 | 15 | diff touches protected path | "Do NOT edit `.claude/`, `CLAUDE.md`, `.claude/settings.json`, or `AGENTS.md`. If your task legitimately requires it, the brief's `scope.include` should list those paths explicitly AND the pre-merge gate should be invoked with `CCX_PROTECTED_OPTIN=1`." |

**Manual entry point (`/ccx:verify`).** Thin slash-command wrapper around the same script (`plugins/ccx/commands/verify.md`). Use cases:

- Post-run audits — "did the supervisor leave any leaks behind?"
- Brief-rewrite sanity checks — "would my proposed message pass the gate?" (pass `CCX_PROPOSED_MSG`).
- Diagnosing a `leak-<code>` exit_status the supervisor surfaced — run with the same `BASE`/`TARGET_REF` and inspect the full violation list locally.

The wrapper accepts `--base REF`, `--target REF`, `--with-diff PATH`, and forwards everything as env vars. `CCX_PROTECTED_OPTIN=1` and `CCX_DATA_HOME=…` etc. pass through from the operator's shell. There is no separate "manual verify mode" — the supervisor and the slash command call the same script with the same contract.

**Out of scope for T-6.** Deferred to a later milestone:

- **Auto-running `ccx verify` as a Git pre-merge / pre-commit hook in user repos.** Would write to `.git/hooks/`, which invariant 6 would flag if the hook script itself contained `ccx/` paths. Supervisor invocation only; manual `/ccx:verify` for ad-hoc audits.
- **Recovering automatically from invariant 14 (stale branch).** The verifier flags stale `ccx/T-*` refs but does NOT delete them — destructive ref operations on a customer's repo without explicit consent are out of policy. The revise hint surfaces the manual `git branch -D` command instead.
- **A `--paranoid` verifier mode that elevates warnings to errors.** `git config ccx.paranoid` already governs that for the T-5 inspection helpers and the T-2 worktree key shape; the verifier itself has no "warning" tier (every fired invariant is a hard error already), so the knob has no effect here.
- **JSON output mode.** A `--format json` flag would make the verifier scriptable for higher-level dashboards. Deferred until a concrete consumer surfaces — `/ccx:supervisor` itself just needs the exit code + stderr, both of which are stable contracts.

### 18.9 Out of scope for M9

Deliberately deferred to a later milestone:

- **Sharing `STATE_DIR` across hosts** (e.g. a team-wide ccx state directory on a network mount). Out of scope because it conflicts with the design's per-operator working-memory model and would need a locking primitive the broker does not yet have.
- **Windows support.** The resolver's platform default branch covers Linux and macOS; Windows is deferred jointly with the broader Claude Code Windows path-handling work.
- **A migration helper that moves a pre-M9 `.ccx/` directory into `STATE_DIR` automatically.** The customer-mode case is "delete pre-existing experimentation"; the dogfood case is a one-time `git mv`. Neither needs scripting; an inspection helper that prints the diagnosis is in T-5's scope and suffices.
- **Encrypted state at rest.** Worker logs and briefs can carry sensitive prompt text. M9 takes the position that `$XDG_DATA_HOME` is the right protection boundary (filesystem permissions inherited from the user's home directory) and defers any tool-level encryption to a future security-hardening milestone.
- **Multi-user `$STATE_DIR`.** If two users on the same host want to drive the same ccx repo, they each get their own `$STATE_DIR` under their own `$HOME`. The broker is host-global (one per host); coordinating two operators' state directories with one broker is left open for the supervisor session-resume work that is already deferred (§20).

---

## 19. Pre-M6 hotfixes and follow-ups (from e2e 2026-04-18)

Items surfaced during the first end-to-end run against `/tmp/ccx-e2e`. Each scoped tightly so they ship independently or batched with M6. Do NOT pick these up until the e2e sandbox is cleaned or rebuilt — the current `/tmp/ccx-e2e/` has a half-merged dispatch that should be wiped before re-testing.

### 19.1 `--squash` merge policy (replaces `--no-ff`) — shipped 2026-04-18

**Why:** §10 picked `--no-ff` on the assumption workers land multi-commit branches worth preserving as a group. In practice `/ccx:loop`'s Phase 4 squashes cycles into one final commit, so a task branch has exactly one commit — and `--no-ff` adds a parent-only merge commit that carries **zero new tree changes**, just a graph node. With `--squash`, one task = one supervisor-authored commit on integration: cleaner history with the same audit surface.

**Touch points:**
- `supervisor.md` Step B3 (pre-merge dry-run) — replace `git merge --no-commit --no-ff` algorithm with `git merge --squash` + conflict probe via `git ls-files -u`. Rollback is NOT `git merge --abort` (doesn't apply to squash) — use `git restore --staged --worktree .`, guarded by a pre-merge `git status --porcelain` cleanliness assert so the rollback never blows away unexpected uncommitted state.
- `supervisor.md` Step B real merge commit — subject = `T-<id>: <title>`, author = supervisor. Keeps task identity in the first line of the commit, which is what `--no-ff`'s implicit merge commit was really for.
- `supervisor.md` §P2.4 — `merge-aborted` / `merge-commit-failed` state names can stay; semantics still apply with the new algorithm.
- design doc §10 — update policy + rationale.
- memory M4 note — `--no-ff --no-commit` → `--squash`.

### 19.2 Step C sleep robustness — shipped 2026-04-18 (option B)

**Why:** Spec says `sleep 3`. First e2e run had supervisor-Claude run `sleep 60` instead (LLM deviated from the literal instruction — model inferred "60s is more reasonable when waiting on LLM workers"). Claude Code 2.1.x blocks long standalone leading sleeps, so the scheduling loop hung at Step C and workers' completions were never drained.

**Options:**
- **A (minimal):** strengthen wording. "MUST be exactly `sleep 3`. Never `sleep 30`, never `sleep 60`. The harness blocks long leading sleeps; anything over a few seconds stalls the loop." Fragile — relies on future supervisor-Claude reading and obeying literally.
- **B (robust):** replace sleep with a polling primitive that works regardless of exact duration — `until any_worker_has_new_output_or_timeout; do sleep 2; done`, capped at 30s. `any_worker_has_new_output` = iterate `RUNNING` and call `BashOutput` on each `shell_id`; break if any returns new lines since the last check. This also fixes the orthogonal problem where supervisor polls on a fixed cadence even when nothing has happened.

Recommend B — it's the same amount of prose to document, more robust to LLM deviation, and measurably reduces wake-ups on quiet iterations.

### 19.3 Supervisor Discord presence — shipped 2026-04-18 (`--chat` flag)

**Why:** Workers post to Discord via their `chat_send` calls, so the user sees worker chatter. Supervisor itself has no Discord route, so from Discord you cannot tell "a supervisor run started in repo X", "it dispatched T-1 and T-2", "T-1 merged / T-2 blocked", or "the run ended with 3 merged". That's the orchestration timeline the user actually wants to watch, and it's entirely missing.

**Proposed lifecycle messages** (fire-and-forget `chat_send`, not `chat_ask`):
- **Start:** `[<repo>] supervisor run <RUN_ID> — N pending, parallel=2, worker-loops=3, integration=main`
- **Dispatch:** `[<repo>] supervisor → T-<id> "<title>" dispatched to worker <sessionId>` — making the worker↔supervisor linkage explicit so later `T-<id>` chat messages from that worker are recognisable as the supervisor's delegate.
- **Merge:** `[<repo>] supervisor ← T-<id> merged (<short_sha>)`
- **Block:** `[<repo>] supervisor ← T-<id> blocked: <exit_status>`
- **Stuck-recovery prompt:** `[<repo>] supervisor ← T-<id> stuck — human guidance requested` (AskUserQuestion already routes to Discord via supervisor-mode fallback; the lead-in message makes the trigger source obvious).
- **End:** `[<repo>] supervisor run <RUN_ID> complete — merged=N, blocked=M, stranded=K, duration=t`

**Mechanism:** Supervisor registers its own ccx-chat session at P0 with a label like `[supervisor] <repo_basename>`. Uses `chat_send` only (no asks, nothing queues). Gated behind a `--chat` flag on `/ccx:supervisor` to mirror worker semantics. When `backend: "supervisor"`, the supervisor's own sends fall through to the Discord fallback — already plumbed in `adapters/supervisor.mjs`.

### 19.4 Repo-name prefix on all ccx-chat messages — shipped 2026-04-18

**Why:** User runs many concurrent ccx sessions across different repos (`ccx-loop`, `gold-digger-*`, etc.). Current Discord messages carry session label + branch but not the repo. Prefix disambiguates.

**Privacy concern raised 2026-04-18:** "괜찮을까" — broadcasting repo names to a channel that might be shared. Recommend **repo basename** (e.g. `ccx-loop`, not `/home/will/Repositories/ccx-loop`) so the prefix stays short and never leaks absolute paths. If basename alone isn't enough (two repos with the same name), fall back to `<parent>/<basename>`. Never log the absolute path.

**Touch points:**
- `plugins/ccx/mcp/ccx-chat/adapters/discord.mjs` — compute `repoBasename = basename(session.cwd)` at session-registration time, prepend to every message body in the format helpers.
- Per-session color tag stays; repo prefix is on the body, color is on the author.

Non-goal: re-rendering the branch as a prefix (already in session label, would double-render).

---

## 20. Open questions

- **Broker singleton vs supervisor scope.** The broker is global (one per host). Can two simultaneous supervisor sessions coexist? Probably not on MVP — require one supervisor at a time, enforce with a lock file.
- **What if the human closes the supervisor session mid-run?** Workers keep running (they're independent processes). On resume (`/ccx:supervisor --resume`), re-read `BOARD.md` and reconcile by checking branch HEADs, `.ccx/workers/*.log` tails, and `chat_close` records. Stretch goal.
- **Long-running workers vs budget.** A single worker running `/ccx:forever` inside `-p` has no natural budget cap and can burn tokens indefinitely. Recommendation: supervisor always launches `/ccx:loop --loops N` (not `forever`), with an explicit N, so each worker is bounded.
- **Brief size cap.** §7.2 suggests switching from inline embed to "read the file" for briefs over ~4KB. The threshold is a guess; measure in practice.
