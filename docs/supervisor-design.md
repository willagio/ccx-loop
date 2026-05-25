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
- **Worktree cleanup** is automatic under M9 T-2 (§18.2). On every worker terminal exit — merged, blocked of any flavour, or §P2.5 stuck-aborted — Step B step 5 (or the inline cleanup in the §P2.5 abort branches and retry-spawn-failure override) runs `git worktree remove --force` on the resolved `meta.worktree_path`. **Branch cleanup remains manual** until T-4 lands: the P3 report still prints `git branch -d ccx/T-<id>` for each merged task so the operator can issue branch deletes when ready.
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

M1 and M2 are enough to be useful. M3–M5 are runtime quality-of-life. The pre-M6 hotfixes (§19) tighten merge history, fix a Step C deadlock failure mode, and give the supervisor its own Discord voice. M6 is the entry-path fix and is the last blocker for non-author adoption. M7 automates stuck-escalation along a fixed model+effort ladder so the human is only asked when the ladder is exhausted. M8a (§16) swaps worker exit detection over to `claude agents --json` and fast-forwards local integration to `origin/<INTEGRATION>` so every worker worktree forks from a fresh upstream base; M8b (§17, proposed 2026-05-23) introduces `/ccx:loop --duet` so Claude and Codex alternate as implementer with each reviewing the other's turn, built on top of M8a's infra. M9 (§18, proposed 2026-05-24) relocates all ccx state outside the user's working tree, tightens commit-message + merge hygiene, and adds inspection helpers so the operator can still find their board.

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

The supervisor's `cd "<worktree_path>" && claude -p ...` spawn ensures the OS process cwd matches `meta.worktree_path` — that is the join key §16.1's M8a liveness check reads, and it only works because the supervisor owns the worktree path. The `<worktree_path>` substitution is whatever the M9 T-2 worktree-path resolver returned for this task (§18.2: `<STATE_DIR>/worktrees/<task_id>/`); the M8a contract holds because the cwd is whatever the supervisor `cd`'d into immediately before the `claude -p` exec. Stripping `--worktree=<TASK.id>` from `DISPATCH_PROMPT` is the matching worker-side change: `/ccx:loop` without `--worktree` runs in cwd, which IS the worktree.

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

## 18. M9 — State relocation outside the user's repo

Status: proposed (2026-05-24). Touches: every command file under `plugins/ccx/commands/`. SSOT for the resolver algorithm; M7 (§15) / M8a (§16) / M8b (§17) are the depth template.

ccx previously kept its state — `BOARD.md` at the repo root, `.ccx/tasks/T-<id>.md` briefs, `.ccx/workers/T-<id>.log` worker logs, `.ccx/supervisor-audit/<RUN_ID>.jsonl`, `.ccx/supervisor-recovery-<RUN_ID>.txt` sidecars — inside the user's working tree, and ran worker worktrees as `<REPO_ROOT>-<task_id>` siblings of the user's repo. That left ccx-owned files in `git status`, ccx-owned commit subjects in the user's history, and `*-T-<id>/` clutter in the parent directory. M9 relocates every one of those state files to `$XDG_DATA_HOME/ccx/<repo-key>/` (override via `$CCX_DATA_HOME`), moves worker worktrees under `<STATE_DIR>/worktrees/<task_id>/`, and tightens commit-message / merge / cleanup hygiene so the user's repo is left exactly as ccx found it.

M9 ships as six tasks (T-1 state path, T-2 worktree path, T-3 commit hygiene, T-4 merge strategy, T-5 inspection helpers, T-6 deferred) that all touch §18 in this design doc and the corresponding command files under `plugins/ccx/commands/`. The subsections below are the algorithmic SSOT; the per-command operational mirror lives in `plugins/ccx/commands/supervisor.md` and MUST stay in lockstep.

### 18.1 State path resolver — algorithm

All ccx state — `BOARD.md`, per-task briefs, worker logs, M3 audit JSONL, M4 recovery sidecars — lives under a single `STATE_DIR` resolved once at the top of `/ccx:supervisor` Phase P0 (and at the top of `/ccx:plan` Phase 0). `plugins/ccx/commands/supervisor.md`'s "State path resolver" section is the operational mirror of this subsection and MUST stay in lockstep with it.

Resolution algorithm (first match wins; evaluate top-to-bottom):

1. **`$CCX_DATA_HOME` env var.** If set and non-empty, `STATE_DIR = $CCX_DATA_HOME` verbatim — no `<repo-key>` suffix is appended. Operator-level escape hatch for tests (`CCX_DATA_HOME=/tmp/ccx-test-<run-id>`) and for users who want a single shared state root across multiple repos.
2. **`$XDG_DATA_HOME`.** If set and non-empty → `STATE_DIR = $XDG_DATA_HOME/ccx/<repo-key>/`.
3. **Platform default.** Linux (`uname -s` returns `Linux`) → `STATE_DIR = ~/.local/share/ccx/<repo-key>/`. macOS (`uname -s` returns `Darwin`) → `STATE_DIR = ~/Library/Application Support/ccx/<repo-key>/`. Windows is out of scope for M9 (deferred jointly with the broader Claude Code Windows story).

`$CCX_DATA_HOME` overrides `$XDG_DATA_HOME` and the platform default — operators running test harnesses can isolate state without touching any other knob. The override precedence is deliberate: developer-friendly knobs (`$CCX_DATA_HOME`) above environment defaults (`$XDG_DATA_HOME`) above platform defaults.

**Why `$XDG_DATA_HOME` and not `$XDG_CACHE_HOME`.** Board state is data, not cache. A cache directory is one a tool can safely delete to free space; `BOARD.md`, briefs, worker logs, and audit JSONL collectively constitute the operator's working memory across supervisor runs. Recovery from accidental eviction is technically possible (re-running `/ccx:plan` regenerates the BOARD; the workers' branches still exist) but lossy (the audit history disappears and any in-flight `stuck-recovery-failed` sidecars vanish). Treat ccx state as `$XDG_DATA_HOME` material throughout.

**Why a `<repo-key>` suffix.** A single user has many repos and a host-global broker (the ccx-chat singleton, §15.4); collapsing all of them into a single `~/.local/share/ccx/` directory would let a stuck task in repo A overwrite a worker log in repo B via filename collision (`T-1.log` from both runs would clash). Keying every state subdirectory by repo identity removes the collision class entirely, at the cost of a one-time directory creation per repo. The 7-char SHA-256 truncation matches Git's short-SHA convention and keeps the path readable in shell prompts.

**`<repo-key>` derivation.** Deterministic — fresh clones of the same upstream resolve to the same `<repo-key>` modulo `$HOME`, so a contributor on machine A and a contributor on machine B operating on the same upstream see the same logical state location (modulo whose disk it's on):

1. If `git remote get-url origin` exits 0 and returns a non-empty URL → `<repo-key> = <basename>-<sha256-7>` where the SHA-256 is computed over the URL string (raw bytes, NO trailing newline, NO normalization — case, scheme, and `.git` suffix are part of the input verbatim so two URLs that resolve to the same upstream via redirects still get different keys) and truncated to its first 7 lowercase hex chars. `<basename>` is the `basename` of `REPO_ROOT` lowercased. Example: a repo at `~/Code/MyProject` with `origin = git@github.com:will/myproject.git` resolves to `<repo-key> = myproject-a3f9b2c`.
2. Else if `git remote` lists at least one remote → use the URL of the **first remote in `git remote`'s output order** (which is alphabetical for git ≥ 2.20), same `<basename>-<sha256-7>` shape. Documented here so a fork with `upstream` set but `origin` missing — a legitimate pattern on private GitHub forks — still produces a stable key.
3. Else (no remotes — purely-local repo, never pushed) → `<repo-key> = <basename>-local-<sha256-7>` where the hash is over `realpath(REPO_ROOT)`. The `-local-` infix is load-bearing: it makes the local-only nature obvious to a human listing `$XDG_DATA_HOME/ccx/`, and it ensures two clones at different absolute paths produce two distinct state directories (correct behaviour — they're independent worktrees).

The 7-char truncation has a collision risk of approximately 1 in 268M between two unrelated repos that also share a `<basename>`. The failure mode is two repos' state co-located in one directory, which surfaces immediately as confused board state (two BOARDs trying to be the same file) and is recoverable by setting `$CCX_DATA_HOME` per-repo. We accept the risk on the same grounds Git accepts short-SHA collisions: rare enough to ignore in practice, recoverable when hit.

**Why not just hash the absolute path** in every case (skipping the remote URL)? Two reasons. First, the same upstream cloned twice on the same machine — a common workflow when a developer keeps a "stable" clone and a "wip" clone — would produce two distinct state directories, splitting the operator's working memory in half. Second, two contributors on the same upstream would never share a logical reference frame ("the T-12 log is at `<repo-key>/workers/T-12.log`") because their absolute paths differ. Hashing the remote URL keeps the logical reference shared while preserving correctness for the local-only fallback.

**Why not hash the project's working-tree contents** (a Merkle-style key)? Tempting but wrong: any commit advances the hash, so every push would invalidate the state directory. Remote URL is the right level: it changes only on `git remote set-url`, which is rare and operator-intentional, and it captures the identity of the project rather than its current state.

**First-run UX.** On first resolution per run, the resolver:

1. `mkdir -p`s `STATE_DIR`, `STATE_DIR/tasks/`, `STATE_DIR/workers/`, `STATE_DIR/supervisor-audit/`. `STATE_DIR/BOARD.md` and `STATE_DIR/supervisor-recovery-*.txt` are NOT pre-created — their absence is a meaningful signal (no BOARD seeded → `/ccx:plan` not run; no recovery sidecar → no failed batch commit) and the writers (`/ccx:plan` Phase 2 for BOARD; supervisor §P2.4 for recovery) call `Write` directly when they fire.
2. Emits ONE line to stderr: `ccx state: <STATE_DIR>`. Fire-and-forget — must not crash on a closed-fd stderr (workers spawn the supervisor under `claude -p` and the stderr pipe is owned by the parent). Logged exactly once per run, regardless of how many later phases reference `STATE_DIR`.
3. Returns `STATE_DIR` to the caller. The caller caches it in a run-scope variable and re-reads that variable; the resolver is not re-invoked.

No interactive prompt. No tty check. The single stderr line is enough audit signal — a `claude -p` runner can pipe stderr to its supervisor log if it cares — and avoids the "first-run wizard" failure mode where a non-TTY context (CI, `claude -p` invocation, headless server) hangs forever on a prompt that nobody answers.

**Where state files live.** Every state file is outside the working tree:

| File | Absolute path |
|---|---|
| BOARD | `<STATE_DIR>/BOARD.md` |
| Per-task brief | `<STATE_DIR>/tasks/T-<id>.md` |
| Worker log | `<STATE_DIR>/workers/T-<id>.log` |
| Audit JSONL | `<STATE_DIR>/supervisor-audit/<RUN_ID>.jsonl` |
| Recovery sidecar | `<STATE_DIR>/supervisor-recovery-<RUN_ID>.txt` |

None of these are `git`-tracked — they live outside `REPO_ROOT`. The supervisor's git operations on `STATE_DIR` paths (the legacy Step A brief commits, Step D batch commits) are no-ops in M9: state writes go directly to disk via `Write`, never via `git add`.

**Migration from pre-M9 state.** Repos with no prior ccx history — no migration needed; the resolver creates the state directory on first access. Repos with a stray `.ccx/` directory from pre-M9 experimentation should `git rm -r .ccx/` (and remove a root-level `BOARD.md` if present) and commit before running M9 commands.

### 18.2 Worktree path resolver

T-1 (§18.1) stopped a `.ccx/` directory from appearing inside the user's worktree by relocating every state file to `<STATE_DIR>`. T-2 closes the corresponding leak ONE directory level up: pre-T-2 every worker checkout lived at `<REPO_ROOT>-<task_id>` as a sibling of the user's repo, visible in any parent-directory listing and named with the ccx-internal task id (`my-project-T-1/`, `my-project-T-2/`, …). T-2 moves that worktree into `<STATE_DIR>/worktrees/<task_id>/` so the user's repo parent stays free of `*-T-<id>` siblings. Touches: `plugins/ccx/commands/supervisor.md` (the "Worktree path resolver" section, Step A steps 1b/3a/4/5/6/7, Step B step 5's worker-finish cleanup, §P2.5 steps 2/3(e)/4/5/6/7, and the P3 cleanup-print).

**Worktree path resolver — algorithm** (mirrors §18.1's STATE_DIR resolver; per-task):

`<worktree_path> = <STATE_DIR>/worktrees/<task_id>`

`git worktree add <path>` derives the metadata directory name in `.git/worktrees/` from `basename(<path>)`, so the metadata directory lives at `.git/worktrees/<task_id>/`. No `--name` flag exists on `git worktree add` and none is needed.

**Per-task caching.** The resolver is invoked exactly once per task per dispatch lifecycle: at **Step A step 1b for the first dispatch** (the path is stashed on a per-pass scratchpad `TASK._resolved_worktree`, consumed by Step A step 3a and step 7 without re-invocation), and at **§P2.5 step 6 for every re-dispatch** (after the prior worktree was torn down in §P2.5 step 5; stashed on `REDISPATCH_RESOLVED` and consumed by the re-invoked Step A step 3a / step 7). Step A step 7 propagates the cached path into `RUNNING[<task_id>].worktree_path` so every subsequent reference (spawn `cd`, Step B step 1 cwd lookup, Step B step 5 cleanup, §P2.5 cleanups, P3 reporting) reads the persisted value.

**Worker-finish cleanup contract.** Pre-T-2 the supervisor printed `git worktree remove <REPO_ROOT>-T-<id>` in the P3 report and left it to the operator to run the command. That left the repo parent directory cluttered with `*-T-<id>` siblings for as long as the operator failed to read and act on the report. T-2 makes worktree removal **automatic on every worker terminal exit** so the leak window is bounded to the duration of one dispatch.

Two cleanup sites enforce the contract, partitioned by the control-flow path the task takes through Step B. Together they cover every terminal exit_status:

- **Step B step 5 (normal Step B terminal outcomes).** Step B's classifier in step 2/3/4 routes to: `merged` (clean squash + commit), `merge-conflict` / `merge-aborted` / `merge-commit-failed` (step 3 outcomes), generic `no-commit` (step 4 with no §P2.5 recovery), and `error` (non-zero shell exit). For each of these the task falls through to step 5 BEFORE being removed from `RUNNING`, where `git worktree remove --force "<meta.worktree_path>" 2>/dev/null` runs. The `--force ... 2>/dev/null` shape is idempotent — silently no-ops on a missing path.
- **§P2.5 inline cleanup (recovery-path terminal outcomes and re-dispatch teardown).** When Step B step 4's sub-classifier routes a `no-commit` exit to §P2.5, the recovery algorithm performs its OWN cleanup at every site that removes the task from `RUNNING` without falling through to Step B step 5. Those sites are: §P2.5 step 2 (`attempts-exhausted`), step 3(e) (both stuck-aborted branches — deliberate "Abort" and empty-other-text reinterpretation), step 4 (`stuck-recovery-failed`), step 5 (pre-redispatch teardown, plus its `stuck-cleanup-failed` failure branch), and step 6's retry-spawn-failure override. Each site runs the same `git worktree remove --force` pattern inline before clearing `RUNNING`. Successful re-dispatches (§P2.5 step 9) leave the task in `RUNNING` with a fresh worktree and do NOT reach either cleanup site — Step B's next iteration will eventually classify the retry and route through whichever cleanup path applies then.

Step B step 5 specifically does NOT fire on the §P2.5 inline-cleanup branches because they return control directly to the outer Step B drain loop after their own cleanup, bypassing step 5. The two sites are mutually exclusive per task per exit, not overlapping — a given terminal exit lands at exactly one of them based on which classifier branch routed it.

Branch deletion is folded into the merged-exit branch of Step B step 5 by T-4 (§18.4). T-2 leaves the branch ref intact on blocked exits so the operator can `git checkout ccx/<task_id>` post-merge to inspect the squashed history or recover a blocked attempt's diff.

**Cross-filesystem note.** `git worktree add <path>` accepts paths on a different filesystem than the repo's `.git/` directory. Git's worktree machinery supports cross-FS locations natively, so the `<STATE_DIR>/worktrees/` path needs no special handling even when the user's home directory is on a different mount than their checkout.

**Out of scope for T-2.**

- **Forced relocation of in-flight workers' existing worktrees.** T-2 applies to NEW spawns only. A worker that was already running at the legacy sibling path when the supervisor binary is upgraded to T-2 finishes at that path; the per-task `RUNNING` entry caches the worktree path from dispatch time, so mid-run relocation is impossible by construction.
- **Migration of legacy sibling worktrees** from pre-T-2 runs. The next supervisor run's Step A step 1b stale-artifact gate refuses to overwrite the legacy path; the operator runs `git worktree remove <REPO_ROOT>-<task_id>` once and the next dispatch lands at the new T-2 location.
- **Validation that `<STATE_DIR>/worktrees/` is writable.** An unwritable `<STATE_DIR>` surfaces as the existing Step A step 3a `git worktree add` failure (classified as `stale-artifact` with the git stderr in notes), which already covers the diagnostic path.

### 18.3 Commit message hygiene — style-mirror

Touches: `plugins/ccx/commands/loop.md` Phase 4 (the worker's commit step), `plugins/ccx/commands/forever.md` Phase 4 (same pipeline mirrored), and this subsection.

ccx workers historically produced commit messages that read like tool output (`T-3: add CSV export`, `supervisor: dispatch T-4`). M9 strips that tooling shape by re-running every worker's draft commit message through an in-session LLM rewrite that matches the repo's existing convention before `git commit` fires.

The operational SSOT for the pipeline is the **Commit message hygiene** subsection in both command files (loop.md and forever.md carry the same procedure verbatim — keep them in lockstep when one changes). This subsection is the **algorithmic SSOT** — the rewrite prompt template and the optional trailer mechanics are anchored here.

**Pipeline shape** (runs once per worker, between draft-message assembly and `git commit` in Phase 4):

1. Worker assembles the draft message exactly as today (subject + body + `Co-Authored-By` trailer per §15's worker contract).
2. **Style-mirror pass** — `git log --pretty='%s%n%b%n--' -30 <integration-branch>` + draft → in-session LLM rewrite. The LLM produces a rewritten message that matches the repo's existing prefix style, subject case, imperative vs past tense, trailing period, body presence.
3. **Optional `Ccx-Task: T-X` trailer** — appended when `ccx.commit.trailer = true` AND `$CCX_TASK_ID` (or the dispatch prompt's `<task_brief id>`) is resolvable.

**Integration-branch resolution** (used by step 2's `git log`). Each candidate MUST pass `git rev-parse --verify --quiet <ref>` before selection. First passing candidate wins:

1. The output of `git symbolic-ref --short refs/remotes/origin/HEAD` used **verbatim** (typically `origin/main`). Do NOT strip the `origin/` prefix: stripping yields a bare `main` that may not exist as a local ref on fresh upstream checkouts where `git pull` has not yet populated a local tracking branch, and `git log -30 main` would fail. The remote-tracking ref resolves whenever the upstream publishes its `HEAD`, which is the common case.
2. Else try local `main`, then local `master`. Each candidate is verified individually so a missing local branch falls through cleanly.
3. Else `HEAD` — always resolves in any repo with at least one commit. Do NOT use a `HEAD~30..HEAD` range here: in repos with fewer than 31 commits the range is an invalid revision and `git log -30 HEAD~30..HEAD` fails. The `-30` cap on `git log` itself truncates to the last 30 commits regardless of history depth, so plain `HEAD` is the safe upper bound.

If none verify (brand-new repo with no commits, or a worker branch on a repo whose only ref is the worker's own branch), the worker still runs step 2 with an empty style sample — the LLM has no convention to mirror but the prompt's explicit "strip task IDs / tooling markers" instructions are still active, so the rewrite still produces a clean draft.

**Rewrite prompt template** (verbatim — the worker MUST NOT paraphrase this; M5's stuck-exit auto-revise depends on stable rewrites across retries):

> Rewrite the proposed commit message to match this repo's existing convention (prefix style, subject case, imperative vs past tense, trailing period, body presence). Strip any task IDs (T-NN) or tooling markers (`supervisor:` subjects, `ccx/...` paths or branch names). Preserve unrelated Git trailers (`Co-Authored-By`, `Signed-off-by`, etc.) verbatim. Output the rewritten message only — no preamble, no quotes, no fenced block.

Naive in-line stripping (e.g. regex-replace `T-N:` → ``) is forbidden: it leaves dangling syntax (`": fix bug"` after stripping `T-3:`) and produces unnatural results. The whole point of step 2 is naturalness; only an LLM rewrite delivers that.

**Trailer mechanics** (step 3). When the trailer flag is set:

- Read `$CCX_TASK_ID` from the env (set by `/ccx:supervisor` Step A step 4 alongside `$CCX_TASK_BRIEF_PATH`); fall back to the dispatch prompt's `<task_brief id="...">` attribute when the env var is unset; fall back to `null` for direct (non-supervisor) `/ccx:loop` invocations.
- Read `ccx.commit.trailer` via `git config --local --get --type=bool` (treat absent or error as `false`).
- When both are non-null/true, run `git interpret-trailers --in-place --trailer "Ccx-Task: <TASK_ID>"` against the commit-message file. `git interpret-trailers` is the right tool because it canonicalises the trailer block separator (blank line before trailers), inserts the new line alongside any existing `Co-Authored-By` / `Signed-off-by` lines without duplicating, and produces output that `git interpret-trailers --parse` can extract.

The trailer is opt-in (default off — most operators want clean commits with no ccx footprint) but lets operators who want machine-parseable provenance opt back into it.

### 18.4 Merge strategy

Touches: `plugins/ccx/commands/supervisor.md`'s "Merge strategy resolver" section (new), P0 step 1a (resolver invocation), Step B step 3 (strategy dispatcher), Step B step 5 (merged-exit branch deletion added to the existing T-2 worktree-remove), the P3 cleanup-print (removes the manual `git branch -d` per-merged-task command), and this subsection.

T-2 closed the worker-worktree leak by relocating worktrees out of the user's repo parent directory. T-4 closes the next two: the supervisor-authored `T-<id>: <title>` squash commit subject (no tooling markers on the user's branch) AND the surviving `ccx/T-X` branch ref after a successful merge. Both leaks were artifacts of pre-T-4 supervisor.md hardcoding a single merge primitive with no operator choice over strategy. T-4 generalises the merge step into a `ccx.merge.strategy` dispatcher and folds branch deletion into the existing per-task cleanup contract.

**Strategy matrix** — same table as the supervisor.md "Merge strategy resolver" section, anchored here as the design SSOT:

| Strategy | Git operations | Commit subject |
|---|---|---|
| `squash` (default) | `git merge --squash ccx/<task_id>` then `git commit -F <message-file>` where the message is the worker's final commit (T-3-processed at worker time). | Worker's final subject verbatim. |
| `rebase` | `git rebase <INTEGRATION>` inside the worker's worktree, then `git merge --ff-only ccx/<task_id>` from the integration checkout. | Worker commits preserved verbatim (each subject already T-3-processed). |

The `ccx.merge.strategy` enum is one of `squash | rebase`. Default `squash` preserves the contract that one task = one commit on integration without explicit operator action. Any other value (including legacy `no-ff`, `ff`, `merge` from pre-T-4 drafts) → P0 STOP with the enum-validation error.

**Why squash as default.** Squash produces ONE supervisor-authored commit per task on integration, with the worker's final (T-3-processed) commit message as its subject. No `T-<id>:` prefix, no `Merge branch 'ccx/...'` first parent, no `Co-Authored-By: Claude Opus` trailer mismatch (the worker's existing trailer flows through unchanged). The git log reads exactly as if the work were authored by hand on the integration branch. Squash is also the cheapest to undo — one commit on mainline either survives or gets reverted as one unit, no merge-commit recovery dance. The trade-off (worker's per-cycle commit history is lost) is acceptable because `/ccx:loop` Phase 4 already collapses review-fix cycles into a single worker commit; squashing a one-commit branch produces a tree-equivalent result with a different commit identity (supervisor authorship + merge-time timestamp).

**Why rebase as the opt-in.** Some operators value per-attempt commit history for blame / git-bisect / progress-tracking on long tasks. The rebase strategy preserves every individual worker commit on the integration branch via `git rebase <INTEGRATION>` on the worker branch followed by `git merge --ff-only` from integration. Each commit's subject + body are already T-3-processed at worker time, so no extra rewrite happens at merge time. The result is a linear graph with no merge commits. Rebase conflicts abort cleanly (`git rebase --abort` restores the pre-rebase state) and are classified as a new blocked `exit_status: "rebase-conflict"` — see "New exit_statuses" below.

**Post-merge cleanup contract** (T-4, all strategies, runs UNCONDITIONALLY after a successful merge): the supervisor removes the worker's worktree FIRST, then deletes the worker's branch. The order is load-bearing — `git branch -D` refuses to delete a branch checked out in any worktree, including the supervisor's just-completed merge worktree (squash) AND the worker's own worktree (rebase, where `git -C "<meta.worktree_path>" rebase` left the worker branch checked out at the new tip). Both operations are folded into `supervisor.md`'s Step B step 5 — the same site T-2 centralised for every terminal exit. T-4 only ADDS the branch-delete on the merged exit; blocked exits keep the existing T-2 behaviour (worktree removed for most blocked exits, branch preserved for human triage). The `rebase-conflict` blocked exit is the SOLE additional preservation rule introduced by T-4: both branch AND worktree stay intact so the operator can `cd "<meta.worktree_path>"` and resolve the conflict in place against the pre-rebase tip.

**New exit_statuses introduced by T-4:**

- **`rebase-conflict`** — rebase strategy only. `git rebase <INTEGRATION>` (run inside the worker's worktree via `git -C "<meta.worktree_path>"`) could not replay one or more worker commits without conflicts. `git rebase --abort` restored the worker branch AND the worktree's index to the pre-rebase tip; both branch AND worktree are preserved (the SOLE additional preservation T-4 introduces beyond the T-2 contract — every other blocked exit keeps only the branch). **Recovery is operator-driven** — Step A's stale-artifact gate refuses to re-dispatch onto the preserved branch/worktree. Two recovery options: (a) **resolve in place** — `cd <meta.worktree_path>; git rebase <INTEGRATION>` and resolve conflicts as Git surfaces them, then merge into `<INTEGRATION>` by hand and mark the BOARD row `merged` manually; (b) **discard** — `git worktree remove --force <meta.worktree_path>; git branch -D ccx/<task_id>`, then flip BOARD status to `pending` and re-run.

**Out of scope for T-4:**

- **Per-task `merge_strategy` override** (a BOARD-row or brief-frontmatter field). M9 keeps BOARD schema unchanged; per-repo `ccx.merge.strategy` is the only knob in this milestone. A future M10+ may introduce per-task overrides if the use case appears.
- **Mid-run strategy switching.** `MERGE_STRATEGY` is resolved once at P0 step 1a and cached; a mid-run `git config` edit cannot half-apply. Every merge in a single supervisor run uses the same strategy.
- **Auto-resolving rebase conflicts.** Conflict resolution belongs to a separate task / human review.
- **Squash-commit author/date manipulation.** The squash commit uses Git's default for `git commit` after `--squash` — author = supervisor's identity, date = merge time. Operators wanting per-task author preservation use the `rebase` strategy.

### 18.5 Inspection helpers

Touches: three new command files under `plugins/ccx/commands/` (`where.md`, `board.md`, `tasks.md`), and this subsection.

T-1 through T-4 relocated state outside the working tree, which means the operator can no longer `vim BOARD.md` or `ls .ccx/tasks/`. Three inspection helpers re-surface the same information through the slash-command interface:

| Command | Purpose |
|---|---|
| `/ccx:where` | Print the resolved `STATE_DIR` for the current repo. |
| `/ccx:board` | Open `STATE_DIR/BOARD.md` in `$EDITOR` (or fall back to `cat`). |
| `/ccx:tasks [--status <value>]` | List `STATE_DIR/tasks/T-*.md` joined with BOARD `status:` + `title:` for each id. |

Each is a new top-level slash command, discoverable in Claude Code's `/`-completion alongside `/ccx:loop` and `/ccx:supervisor`. The full operational spec for each command lives in its respective `plugins/ccx/commands/*.md` file; this subsection only anchors their existence as the user-facing surface area for inspecting otherwise-invisible state.

**Why slash commands, not shell utilities.** Slash commands keep the surface uniform with everything else M9 introduces. A shell script would force users to know where the plugin lives — plugins on the marketplace have varying install paths (`~/.claude/plugins/marketplaces/<repo>/<plugin>/` vs `~/.claude/plugins/cache/<repo>/<plugin>/`), so a shell utility can't be `PATH`-discovered without per-plugin installer scripts the marketplace doesn't currently provide. Slash commands are discoverable in the existing completion UI and run inside the Claude Code session that already has the relevant Bash tool permissions.

### 18.6 Out of scope for M9

Deliberately deferred to a later milestone:

- **Sharing `STATE_DIR` across hosts** (e.g. a team-wide ccx state directory on a network mount). Out of scope because it conflicts with the design's per-operator working-memory model and would need a locking primitive the broker does not yet have.
- **Windows support.** The resolver's platform default branch covers Linux and macOS; Windows is deferred jointly with the broader Claude Code Windows path-handling work.
- **A migration helper that moves a pre-M9 `.ccx/` directory into `STATE_DIR` automatically.** The case is "delete pre-existing experimentation"; no scripting is needed.
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
