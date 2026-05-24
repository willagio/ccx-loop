---
description: "Dev loop that repeats review-fix cycles until Codex approves (or the safety cap is hit)"
argument-hint: "[--max-cycles N] [--min-severity LEVEL] [--min-confidence N] [--commit] [--worktree[=NAME]] [--chat] <task description>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate, mcp__ccx-chat__chat_register, mcp__ccx-chat__chat_send, mcp__ccx-chat__chat_ask, mcp__ccx-chat__chat_set_phase, mcp__ccx-chat__chat_close
---

# /ccx:forever — Loop Until Approval

Fully automated development workflow: implement, then repeat Codex review-fix cycles until Codex returns `verdict: "approve"`. For a fixed N cycles, use `/ccx:loop` instead.

Raw arguments: `$ARGUMENTS`

---

## Argument Parsing

Parse the raw arguments:
- `--max-cycles N` — safety cap on the number of review-fix cycles (default: **100**; clamped to 1–100). The loop exits on first approval; the cap only fires if Codex never approves.
- `--min-severity LEVEL` — ignore findings below this severity. One of `critical|high|medium|low`. Default: `low` (fix everything). Ranking: `critical > high > medium > low`; `--min-severity medium` means fix critical/high/medium, skip low.
- `--min-confidence N` — ignore findings whose `confidence` is below `N` (0.0–1.0). Default: `0.0`.
- `--commit` — auto-commit without asking (skip the prompt), subject to the Phase 4 auto-commit gate.
- `--worktree` or `--worktree=NAME` — run the entire loop in an isolated git worktree on a new branch. Enables parallel tasks in the same repo without `git diff` cross-contamination (Codex review relies on the working tree diff). The name, if supplied, MUST use the `=` form (`--worktree=feat-auth`) — a space-separated positional value is NOT accepted because it would be ambiguous with the first word of the task description (e.g. `--worktree fix auth bug` cannot distinguish `fix` as a name versus the first task word). Bare `--worktree` generates a timestamp name. Branch = `ccx/<NAME>`, worktree path = `<repo>-<NAME>`. See Phase 0.5.
- `--chat` — bridge this run to Discord via the `ccx-chat` MCP server. Announces session start, sends per-cycle summaries, asks the commit question in Discord (with `AskUserQuestion` as fallback), and announces session close. Requires one-time `/ccx:chat-setup`. See Phase 0.7.
- Everything else is the **task description**.

Finding identity: throughout the loop, a finding's stable key is the logical **tuple `(file, title, body)`** — compared field-by-field, not as a concatenated string. Title and body can legitimately contain `:` or other delimiters, so concatenation would collapse distinct findings; equality/lookup must treat the three fields independently (e.g. `JSON.stringify([file, title, body])` is an acceptable concrete representation). Line numbers are deliberately excluded because fixes shift them and would otherwise defeat stuck-finding detection. `body` is included as a discriminator so that multiple distinct findings sharing a generic title in the same file (e.g. two separate "Unused import" findings) do NOT share a streak counter.

Examples:
- `/ccx:forever Refactor auth middleware` → loop until approve (≤100).
- `/ccx:forever --max-cycles 10 Update error messages` → loop until approve (≤10).
- `/ccx:forever --commit --min-severity medium Tighten input validation` → loop until medium+ findings are clear, then auto-commit.

---

## Rules

- Execute all phases sequentially. Do NOT pause between phases (except the commit prompt when `--commit` is not set).
- For each cycle, partition findings into **in-scope** (severity ≥ `--min-severity` AND `confidence` ≥ `--min-confidence`) and **skipped** (the rest). Fix every in-scope finding; log skipped ones so the user sees what was filtered.
- If a review returns `verdict: "approve"` with zero in-scope findings, skip Step C and exit the loop — this is the success condition.
- **Stuck-finding detection:** keep a per-key attempt counter (key = the `(file, title, body)` tuple). If the same in-scope finding key appears in **three consecutive cycles** (two prior fix attempts both failed to satisfy Codex), STOP the loop and report it. Without this, a persistent nitpick Claude can't satisfy would burn the full cap in Codex calls.
- **Cap-hit:** if the safety cap is reached without approval, STOP and report; do NOT auto-commit.

## Guardrails

- You MUST actually call the Bash tool to run the review command. Never fabricate review output.
- You MUST actually call Edit/Write tools to fix findings. Never claim a fix without editing the file.
- After each fix phase, run `git diff --stat` and print the output so the user can see exactly which files changed.
- **M9 brief-read contract (always-on, runs before any phase reads a brief).** When the dispatch prompt's `<task_brief path="…">` attribute is an absolute path, the path is allowed for `Read` ONLY when ALL of the following hold; on any failure, refuse the read and STOP via `chat_close({status: "aborted"})`:
  1. The supervisor exported `CCX_TASK_BRIEF_PATH` in the spawn env (set by `/ccx:supervisor` Step A step 4). The path the worker is about to `Read` MUST equal `$CCX_TASK_BRIEF_PATH` byte-for-byte. This is the primary anti-injection gate.
  2. The dispatch prompt's `<task_brief id="…">` attribute MUST equal `$CCX_TASK_ID` (also exported by the supervisor).
  3. The path is absolute (begins with `/`) and matches the regex `^/.+/tasks/T-[0-9]+\.md$`.
  4. If `$CCX_TASK_BRIEF_PATH` is unset or empty, the M9 exception is OFF — the worker has no trusted source for the brief path and falls back to the pre-M9 rule: only paths inside the current worktree are readable. This is the direct-invocation case (`/ccx:forever` run from a shell, no supervisor).
  Even when all checks pass, the exception is read-only; `Edit` / `Write` against a brief path is forbidden in every mode (briefs are supervisor-owned). This contract applies regardless of whether `--worktree` is set.
- Print a structured cycle summary using this multi-line bullet form (easier to scan in Discord than a comma-packed one-liner):
  ```
  Review {i}/≤{cap} — {verdict}
  • findings: {total} ({inScope} in-scope, {skipped} skipped)
  • fixed: {fixed} · unresolved: {unresolved}
  ```
  When `CHAT_SESSION_ID` is set, also call `chat_send` with the same multi-line block (pass it as a single `text` argument with `\n` between lines — Discord renders each line separately), and `chat_set_phase` with `review {i}/≤{cap}` at cycle start and `fix {i}/≤{cap}` before Step C (skip the phase update if Step C is skipped). Any additional one-line commentary (e.g. what was fixed, test counts) SHOULD be appended as extra `• ` bullets on following lines, not packed onto the same line — the whole point is one fact per bullet.
- If the review command fails (non-zero exit, no JSON output, or `CODEX_ROOT` not found), STOP and report to the user. Never proceed with fabricated results.
- **Fix verification:** after each Edit/Write, treat a tool error (file missing, `old_string` not unique, etc.) as `unresolved` — record it, surface it in the cycle summary, and do not silently absorb it.

---

## Phase 0: Pre-check

Run `git status --porcelain=v1 -z` and **parse it into `PRE_LOOP_PATHS`** — a plain set of repository-relative paths. Correct parsing must:
- Split records on NUL (`-z`), not newlines.
- Strip the two-character status prefix and the following space.
- For rename records (`R`/`C`), capture BOTH the old and new path halves (they're emitted as two NUL-separated fields when `-z` is used).

`PRE_LOOP_PATHS` is a set of paths; do NOT reuse raw porcelain lines as paths anywhere later.

**Hunk-granularity caveat:** `git add <path>` is file-granular. If the loop edits a file that was already in `PRE_LOOP_PATHS`, staging that file will include the user's pre-existing hunks too — porcelain status cannot separate them. The command must surface this explicitly in the commit scope summary. If strict isolation is needed, the user should abort, clean/stash their tree, and re-run.

If `PRE_LOOP_PATHS` is non-empty (dirty tree), the handling depends on whether `--worktree` is set:

- **With `--worktree`:** the loop runs in a freshly-created worktree forked from `HEAD` (Phase 0.5). `git worktree add <path> <BASE_REV>` does NOT carry staged or unstaged changes across — the user's local modifications stay in the original checkout and will NOT be reviewed, edited, or committed by this loop. Warn explicitly with the path list and this consequence. If `--commit` is set, proceed (the user opted into non-interactive mode); otherwise ask **Proceed** / **Abort** so the user can choose to stash/commit first in the original checkout and re-run.
- **Without `--worktree`:**
  - If `--commit` is set: log a warning listing the pre-existing paths, flag that any overlap with files Claude edits will be committed together, then **proceed without prompting**.
  - Otherwise: warn and ask **Proceed** / **Abort**.

Do NOT probe Codex here — Phase 1 should still run even if Codex is unavailable. The first review cycle surfaces "Codex unavailable" and preserves the implementation. Each Bash tool call runs in a fresh shell, so `CODEX_ROOT` is resolved inline in Phase 2's review one-liner.

If the working tree is clean, proceed silently.

---

## Phase 0.5: Worktree setup (only if `--worktree` is set)

Purpose: isolate this task so concurrent ccx runs in the same repo don't collide on the working-tree diff Codex reviews.

Steps:
1. Resolve the repo root with `git rev-parse --show-toplevel`. Let `REPO_ROOT` be that path and `REPO_NAME` its basename. Also capture the caller's current-directory offset within the repo: `REL_CWD="$(git rev-parse --show-prefix)"` (empty when the command is invoked at the repo root; otherwise a trailing-slash path like `services/api/`). This preserves monorepo subdirectory scope when the loop relocates into the worktree.
2. Resolve the **base commit** as the caller's current `HEAD` (`git rev-parse HEAD`). The new branch forks from wherever the user currently is — not from `origin/HEAD`/`main`/`master` — so feature-branch work and local-only commits are preserved in the isolated run. Call this `BASE_REV`.
3. Compute `NAME`. If the flag supplied a value, apply **two validation layers**; fail either and STOP with a clear report (do NOT silently rewrite — a user who typed `feat/auth` likely meant to express hierarchy and should be told explicitly):
   - **Shell/path safety:** `NAME` MUST match `^[A-Za-z0-9._-]+$` — no whitespace, no `/`, no shell-special characters — because it is substituted directly into a filesystem path.
   - **Git ref validity:** the resulting branch ref MUST pass `git check-ref-format refs/heads/ccx/<NAME>` (zero exit). Regex-only checks accept strings Git still rejects — `foo..bar`, `trailing.`, `name.lock`, `-leading-dash` — which would cause `git worktree add -b` to fail mid-setup. Use the `git check-ref-format` command rather than re-implementing the rules.

   If the flag is bare (no value), generate `YYYYMMDD-HHMMSS-<rand4>`, where `<rand4>` is four lowercase hex characters (e.g. `20260415-153012-a3f9`). Timestamps alone collide at second granularity between concurrent invocations, so two parallel bare-`--worktree` runs started in the same second would compute the same path; step 4 only retries on an existing branch, not an existing path, so the second run would abort instead of isolating. The random suffix closes that race window. Branch = `ccx/<NAME>`. Worktree path = `<REPO_ROOT>-<NAME>` (sibling dir — avoids nesting inside the repo and polluting its status).
4. If the branch already exists, append a short random suffix and retry once; if the worktree path exists, STOP and report (do not overwrite).
5. Run `git worktree add -b "<branch>" "<worktree-path>" "<BASE_REV>"` (options MUST precede the positional path — `git worktree add` rejects `-b` after `<path>`). Quote all three substitutions: `<REPO_ROOT>` may contain spaces (e.g. `~/Code/Client Projects/app`), which would break an unquoted invocation. The same quoting applies to every subsequent `cd "<worktree-path>" && …` prefix referenced below.
6. Define `WORKTREE_CWD = <worktree-path>/<REL_CWD>` — i.e. the same repo-relative subdirectory the user invoked the command from, mapped into the worktree. Preserving `REL_CWD` matters in monorepos: if the user ran `/ccx:forever` from `services/api/`, the loop should still scope to `services/api/` in the worktree, not the repo root.

   **Existence check:** because the worktree forks from `HEAD` and drops uncommitted changes, `<REL_CWD>` may not exist in the new worktree (e.g. the user invoked the loop from an untracked/new package directory that only lives in the dirty original checkout). After `git worktree add`, verify `WORKTREE_CWD` exists; if not, fall back to `WORKTREE_CWD = <worktree-path>` (the worktree root) and log one warning telling the user the subdir scope was lost. Never leave `WORKTREE_CWD` pointing at a nonexistent path — every later `cd "<WORKTREE_CWD>" &&` would fail before Phase 1 even starts. For the remainder of the command (Phases 1–4), treat `WORKTREE_CWD` as the working directory:
   - **Bash:** default prefix is `cd "<WORKTREE_CWD>" &&` (each invocation starts in a fresh shell, so there is no persistent working directory between calls). This applies to the Phase 2 Step A Codex review one-liner, the `git diff --stat` guardrail, the test runner, and most task-scoped shell calls — the cwd scopes Bash-based file discovery and relative-path commands so they mirror the caller's original monorepo context.
     - **Exception — staging and commit:** every `git add` / `git commit` in Phase 4 MUST run from the **worktree root** (`cd "<worktree-path>" &&`), not from `WORKTREE_CWD`. `EDITED_PATHS` and `PRE_LOOP_PATHS` are stored worktree-root-relative, and `git add -- <path>` resolves its pathspecs against the current directory; running staging from a subdirectory would silently miss any edited file outside that subtree. The same applies to `git status --porcelain` / `git diff` calls that consume those path sets.
   - **Read/Edit/Write:** use absolute paths rooted at `<worktree-path>` — never at the original `REPO_ROOT`. (Absolute paths are unaffected by `REL_CWD`; this line is here to forbid the original-repo root.) The **M9 brief-read contract** in the Guardrails section above defines the narrow exception for the supervisor-provided absolute brief path; this Phase 0.5 rule defers to that contract and does not extend it. Reading ANY absolute path outside the worktree that does not satisfy the M9 contract remains forbidden.
   - **Glob/Grep:** default the `path` parameter to `<WORKTREE_CWD>` for task-scoped file discovery in Phases 1–2 (defaulting to the original working directory would read stale content from the main checkout while edits happen in the isolated one, silently defeating isolation). For the Phase 3 `.handoff.md` lookup, which mirrors the existing "project root (or repository root)" contract, walk ancestor directories from `<WORKTREE_CWD>` up to `<worktree-path>` (inclusive), stopping at the first directory that contains `.handoff.md`. This correctly handles nested invocations like `services/api/src/` where `.handoff.md` sits at `services/api/.handoff.md` — a two-point check (just `<WORKTREE_CWD>` then `<worktree-path>`) would silently skip the real project-root handoff and leave it stale. If no handoff exists anywhere on that ancestor chain, skip the phase per the Phase 3 contract. For other genuinely repo-wide lookups, pass `<worktree-path>` explicitly. Never default to the tool's built-in cwd.
   - **Agent:** every `Agent` tool invocation (research, implementation, or review delegated to a subagent) MUST explicitly tell the subagent its working directory is `<WORKTREE_CWD>` (or `<worktree-path>` for repo-wide tasks), include the absolute path in the prompt, and forbid edits outside the worktree. Subagents inherit the parent's cwd context but do NOT auto-detect the worktree, so without an explicit instruction they will read and edit the original checkout — silently defeating isolation since their changes never appear in the Codex review that runs against the worktree.
   - **EDITED_PATHS:** store every tracked edit as **worktree-relative** (strip the `<worktree-path>/` prefix before adding to the set), not as an absolute path. Phase 4 feeds these entries to `git add -- <path>` from inside the worktree, which interprets them as pathspecs relative to the worktree root; absolute paths would either fail or stage the wrong thing. Do the same strip for paths touched by intentional Bash file operations (`mv`, `rm`, `cp`, generators).
   - If any step operates on the original repo path, Codex will review the wrong checkout and the isolation is defeated. `PRE_LOOP_PATHS` from Phase 0 does NOT carry over: the worktree is clean by construction, so reset it to an empty set.
7. After Phase 4 commits, do NOT delete the worktree. The user is responsible for pushing (`git push -u origin "<branch>"`), opening a PR, and cleaning up with `git worktree remove "<worktree-path>"` once merged. Quote both substitutions in the reported commands — `<worktree-path>` may contain spaces from `<REPO_ROOT>`, and emitting an unquoted command would fail when the user copy-pastes it. Surface this in the final report with the exact quoted commands.

Storage note: `git worktree` shares the `.git` object store with the main repo, so extra disk cost is roughly the checked-out source tree (not `.git`). Build artifacts (`node_modules`, `target/`, `.venv/`) are NOT shared — if those are large, the user should symlink or rebuild inside the worktree. Mention this only if the task touches such directories.

---

## Phase 0.7: Chat bridge setup (only if `--chat` is set)

**Tool availability check:** before calling any `mcp__ccx-chat__*` tool, verify it exists in the available tool list. If the `ccx-chat` MCP server is not registered (the user hasn't run `/ccx:chat-setup` yet, or it failed), the `mcp__ccx-chat__chat_register` tool will not be available. In that case, log: `--chat requested but ccx-chat MCP server is not available. Run /ccx:chat-setup first.` Then unset `--chat` and continue without chat. Do NOT abort the loop.

If the tool is available, call `mcp__ccx-chat__chat_register` with:
- `label` — the task description (truncated to ~80 chars by the broker).
- `cwd` — absolute working directory (worktree path when `--worktree` is active, else repo root).
- `branch` — output of `git rev-parse --abbrev-ref HEAD` from that cwd.

Store the returned `sessionId` as `CHAT_SESSION_ID`. Treat the bridge as best-effort:

- If the register call fails (broker not configured, Discord down, missing config), log the error, unset `CHAT_SESSION_ID`, and continue without chat. Do NOT abort the loop — the user opted into chat, not into blocking on it.
- When a later `chat_*` call fails, keep `CHAT_SESSION_ID` but mark the bridge as degraded; stop attempting further chat calls for the rest of the run to avoid spamming errors. The final report must mention that chat was lost mid-run.
- **Cancellation semantics:** if any `chat_*` call (other than `chat_close`) returns an error whose message contains the substring `cancelled` (e.g. `session ab12 was cancelled (user)`), the user issued `!ccx cancel #<id>` from Discord. STOP the loop immediately without committing, skip remaining phases, and exit via `chat_close({status: "aborted"})`. Do not interpret generic transient errors (network, timeout) as cancellations — only the literal substring `cancelled`.
  **Known limitation:** cancellation is only detected on the next `chat_*` call. During long implement/review/fix phases with no chat RPCs, the loop continues until it reaches the next `chat_send` or `chat_set_phase`. This is inherent in the architecture — Claude Code tool calls cannot be interrupted externally.

After successful register, call `chat_set_phase({sessionId: CHAT_SESSION_ID, phase: "implement"})`.

---

## Phase 1: Implement

Implement the task. Write code, ensure it compiles/runs.

**Test gate:** if the project has a test runner and the task touches code under test, run the relevant tests before entering the review loop. If tests fail, fix them first — Codex review is more expensive than a local test run, and broken builds inflate finding counts (and, in this command, risk burning cap).

When implementation compiles and tests pass (or no tests apply), proceed to the review loop.

---

## Phase 2: Review Loop

Repeat up to `cap = --max-cycles` (default 100). Maintain a `findingStreak` map across cycles, keyed by the `(file, title, body)` tuple, counting how many consecutive cycles that finding has appeared in (used for stuck-finding detection).

For each cycle `i` (from 1 to `cap`):

### Step A: Codex Review

Use this exact one-liner every cycle (each Bash call is a fresh shell, so the path must be resolved inline):

```bash
CODEX_ROOT="$(find ~/.claude/plugins/marketplaces/openai-codex/plugins/codex ~/.claude/plugins/cache/openai-codex/codex -maxdepth 0 -type d 2>/dev/null | head -1)" && node "$CODEX_ROOT/scripts/codex-companion.mjs" review --wait --json
```

**Worktree mode:** if `--worktree` is set, this command MUST run from inside the worktree — prefix it with `cd "<WORKTREE_CWD>" &&` (quoted, because the path may contain spaces from `<REPO_ROOT>`). Use `WORKTREE_CWD`, not the worktree root, to keep Phase 2 consistent with Phase 0.5's monorepo-scoping rule — running the review from `<worktree-path>` would surface repo-wide diffs for a subdirectory-scoped invocation and drive edits outside the requested scope. Running from the original checkout would review the wrong diff entirely and silently defeat isolation. The same quoted prefixing applies to the `git diff --stat` guardrail below and any other Bash invocation in this phase.

On the **first cycle only**, if `CODEX_ROOT` is empty or this command fails (no JSON, non-zero exit, or node error), STOP the entire workflow and tell the user:
> Codex is not available. Install: `npm install -g @openai/codex && codex login`
> Plugin: `/plugin install codex@openai-codex`
> Your implementation is preserved on disk — run `/codex:review` and commit manually when ready.

**Worktree mode:** when `--worktree` is set, the implementation lives in the sibling worktree, not the user's original checkout. The fatal message above MUST additionally surface the absolute worktree path and branch name (e.g. `> Worktree: "/path/to/repo-feat-auth"  branch: ccx/feat-auth`) so the user can find their edits; a bare "preserved on disk" message would point them at the wrong directory and they could abandon the worktree. Apply the same addition to every later-cycle fatal exit that preserves partial fixes.

Do NOT proceed to Phase 3 or Phase 4 in this case: committing unreviewed changes (especially with `--commit`) would defeat the review gate. On **later cycles**, a failure is also fatal — STOP and report; partial fixes are preserved on disk but not committed.

Parse the JSON:

```json
{
  "verdict": "approve" | "needs-attention",
  "summary": "...",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "title": "...",
      "body": "...",
      "file": "...",
      "line_start": N,
      "line_end": N,
      "confidence": 0.0-1.0,
      "recommendation": "..."
    }
  ],
  "next_steps": ["..."]
}
```

Partition findings into **in-scope** vs **skipped** using `--min-severity` and `--min-confidence`.

### Step B: Stuck-finding check

For every key in the current cycle's in-scope finding set:
- If it's in `findingStreak`, increment its count.
- Otherwise, set its count to 1.

Drop any keys from `findingStreak` that did NOT appear this cycle (streak broken).

If any key's count reaches **3**, STOP the loop and report stuck finding(s). Proceed to Phase 3 but block Phase 4 auto-commit (see Phase 4 gate).

### Step C: Fix Findings

For each in-scope finding:
1. Read the file at the reported location.
2. Understand the issue from `body` and `recommendation`.
3. Apply the fix with Edit/Write. If the tool call fails, record the finding as `unresolved`; do not claim it was fixed.

After all fixes, re-run the relevant tests if applicable and record the result as `lastTestStatus` (pass / fail / n-a). A failure during non-final cycles is reported but does not abort — the next review cycle will surface the underlying issues. On the final cycle (loop about to exit), a test failure blocks Phase 4 auto-commit.

Skip Step C entirely when `verdict == "approve"` AND in-scope is empty.

### Step D: Exit checks (evaluate in this order)

1. `verdict == "approve"` AND no in-scope findings → break as **approved** (the success condition).
2. No in-scope findings but `verdict != "approve"` (every finding was filtered out) → break as **filtered-unapproved**. The command's contract ("loop until Codex approves") cannot be fulfilled because filters leave nothing to fix but Codex is still unsatisfied. STOP and **block Phase 4 auto-commit** — surface the skipped findings and require the user to rerun with adjusted filters or commit manually.
3. `i == cap` → break with **cap-hit** notice; **block Phase 4 auto-commit**.
4. Otherwise continue to cycle `i+1`. Any `unresolved` findings this cycle do not short-circuit — the next review will re-surface them.

---

## Phase 3: Update .handoff.md

Find the `.handoff.md` file in the project root (or repository root).

- If it exists: read it and update the **CURRENT STATE** section to reflect changes made during this dev loop (what was implemented, what was fixed from reviews, any architectural changes, updated test counts if tests were added, any unresolved findings / stuck-loop exits / cap-hits). Preserve the existing structure and style.
- If it does not exist: skip this phase silently. Do not create a new `.handoff.md`.

---

## Phase 4: Commit

**Auto-commit gate:** `--commit` only auto-commits when ALL of the following are true:
- Loop exited via approval (Step D rule 1). Filtered-unapproved and cap-hit exits never auto-commit.
- Final cycle had `unresolved == 0`.
- `lastTestStatus` is `pass` or `n-a` (never `fail`).
- No stuck-finding exit occurred.

For every other exit state — stuck-finding exit, filtered-unapproved, cap-hit, final-cycle `unresolved > 0`, or final-cycle test failure — `--commit` is downgraded to an interactive prompt. The final report must list what remains unresolved / unapproved / failing so the user can decide.

If `--commit` applies after the gate: commit directly without asking.
Otherwise: ask the user ONE question — whether to commit.

**Chat bridge:** when `CHAT_SESSION_ID` is set and the commit question must be asked:
1. Call `chat_set_phase` with `commit?` and `chat_ask` with a concise prompt (include the exit reason and any unresolved/skipped counts).
2. If the result's `source` is `timeout`, `cancel`, or `closed`, or the call errors, fall back to `AskUserQuestion`. Otherwise interpret the `reply` string (case-insensitive `yes`/`y`/`commit`/`ok` → commit; anything else → stop).
3. On final exit (whether committed or not), call `chat_close` with `status` set to one of: `approved`, `filtered-unapproved`, `stuck`, `cap-hit`, `commit-marker-leak`, `aborted`, `error` — matching the actual exit path. The `commit-marker-leak` value is reserved for the M9 T-3 commit-hygiene exit described below; it appears on the close envelope (visible in the broker's closure ring buffer and the worker log) so the operator can identify the leak. The supervisor's existing generic no-commit handler (`plugins/ccx/commands/supervisor.md` Step B step 4) does NOT preserve this distinction on the BOARD row — it stashes `exit_status: "no-commit"` for any closure that is not `stuck` / `budget-exhausted`, so `commit-marker-leak` shows up on BOARD as a generic `no-commit` with the actual diagnosis only in the worker log. Both surfacing the leak status on the BOARD row AND routing it through §P2.5 stuck-exit auto-revise are follow-up supervisor.md edits — adding `commit-marker-leak` to the stashed `exit_status` mapping and to §P2.5's stuck-flavored signal set — that are out of T-3's scope per the brief's `scope.include` constraint. Until those follow-ups land, the operator handles a `commit-marker-leak` exit by inspecting the worker log to confirm the leak, optionally revising the brief, and flipping the BOARD row from `blocked` back to `pending`. Run `chat_close` exactly once, in a `finally`-style block that runs even when earlier phases threw.

If committing:
- Track `EDITED_PATHS` throughout the loop: the set of file paths Claude **intentionally** created, modified, renamed, or deleted. This includes:
  - Every target of an Edit or Write tool call (Phase 1 implementation and every Phase 2 Step C fix).
  - Every path touched by intentional Bash file operations the agent runs: `mv` (both source and destination), `rm` / `git rm`, `cp` destinations, `touch`, code generators, formatters that rewrite files (`prettier --write`, `ruff format`, etc.), and any scripted codemod.
  - Build this set incrementally as each tool call executes — do NOT derive it from `git status` at the end.
- Paths changed as a side-effect of a command (e.g. test runner writing `.coverage/`, a build step producing `dist/`) must NOT be added to `EDITED_PATHS` unless the task itself was to regenerate those artifacts.
- Staging set = `EDITED_PATHS ∪ PRE_LOOP_PATHS` (when the user accepted pre-existing changes in Phase 0). Both are plain path sets — stage them with explicit `git add -- <path>` calls. Note both sets in the commit message so the scope is auditable, and note the hunk-granularity caveat for any path in `EDITED_PATHS ∩ PRE_LOOP_PATHS`.
- Never use `git add -A` or `git add .` — stage explicit paths only, so untracked generated files and editor swap files never slip in.
- Write a concise commit message describing the task and summarizing any significant findings fixed.
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.
- **Pass the draft through the M9 T-3 commit-message hygiene pipeline below** before invoking `git commit`. The hygiene pipeline is the single writer-side enforcement point for M9 invariant 3 (no `T-N:` / `supervisor:` / `ccx/` markers in customer-mode commits); skipping it would let the supervisor's M5 retry budget burn fixing leaks the worker itself could have caught.

### Commit message hygiene (M9 T-3)

Runs after the staging set is computed and the draft message is written, but BEFORE `git commit` fires. The pipeline has three steps; the first two are gated on `ccx.dogfood`, the third is independent. This section mirrors the same-named section in `plugins/ccx/commands/loop.md` — keep them in lockstep when one changes.

**Mode resolution.** Read once at the top of the pipeline:

- `IS_DOGFOOD = git config --get --type=bool ccx.dogfood` (treat absent/error as `false`).
- `WANT_TRAILER = git config --get --type=bool ccx.commit.trailer` (treat absent/error as `false`).
- `TASK_ID = $CCX_TASK_ID` env var (set by `/ccx:supervisor` Step A step 4 alongside `$CCX_TASK_BRIEF_PATH`). Falls back to the `<task_brief id="...">` attribute in the dispatch prompt when the env var is unset; falls back to `null` for direct (non-supervisor) `/ccx:forever` invocations.

When `IS_DOGFOOD == true`: skip Step 1 and Step 2 entirely (the draft message — typically carrying `T-X:` or `supervisor:` prefixes — lands as-is, which is the documented dogfood workflow). Step 3 still runs when `WANT_TRAILER == true` and `TASK_ID` is non-null.

**Step 1 — style-mirror rewrite.** Resolve the integration branch in this order; each candidate MUST pass `git rev-parse --verify --quiet <ref>` (exit 0, non-empty stdout) before it is selected. First passing candidate wins:
1. The output of `git symbolic-ref --short refs/remotes/origin/HEAD` — used **verbatim** (typically `origin/main`). Do NOT strip the `origin/` prefix; using the remote-tracking ref directly means the candidate resolves even when no local `main` branch exists, which is the common shape for fresh checkouts of an upstream repo.
2. Local `main`, then local `master` — each verified before selection so a missing local branch falls through cleanly.
3. `HEAD` — a plain ref that always resolves (any git repo with at least one commit has a HEAD). Do NOT use a `HEAD~30..HEAD` range: in repos with fewer than 31 commits the range is an invalid revision and `git log -30 HEAD~30..HEAD` fails. The `-30` cap on `git log` below truncates to the last 30 commits regardless of how far back history extends, so a plain `HEAD` is the safe upper bound.

When at least one candidate verifies, read `git log --pretty='%s%n%b%n--' -30 <integration-branch>` to capture the last 30 commits' subject+body shape. When none verify (brand-new repo with no commits, or a detached worker branch on a repo whose only ref is the worker's own branch), the style sample is the empty string — Step 1 still runs, but the LLM has nothing to mirror and will fall back to the prompt's explicit "strip task IDs / tooling markers" instructions. **Step 1 is never skipped:** skipping it on no-style-sample would let the draft's tooling markers fall through to Step 2 unchanged, and the regex gate would then deterministically hit three times in a row on every regen attempt (the prompt-less retries can't strip the markers either), producing a guaranteed `commit-marker-leak` exit for any valid draft on a fresh repo.

Pass the style sample (possibly empty) AND the draft message through the in-session rewrite using this prompt template verbatim (do NOT paraphrase — the supervisor's M5 retry logic depends on the worker producing stable rewrites across attempts):

> Rewrite the proposed commit message to match this repo's existing convention (prefix style, subject case, imperative vs past tense, trailing period, body presence). Strip any task IDs (T-NN) or tooling markers (`supervisor:` subjects, `ccx/...` paths or branch names). Preserve unrelated Git trailers (`Co-Authored-By`, `Signed-off-by`, etc.) verbatim. Output the rewritten message only — no preamble, no quotes, no fenced block.

The worker performs this rewrite in-session (no external API call, no separate model dimension). The worker's current model tier (M7 §15 ladder rung) drives the rewrite; per the brief's Decisions, message rewriting is well within haiku's competence and no rung promotion is needed.

**Step 2 — marker-strip regex gate.** The regex below uses PCRE-style syntax with a negative lookbehind (`(?<!...)`) — supported by PCRE2 (`grep -P`), Python `re`, and ECMAScript ES2018+. Apply it to the rewritten subject AND body, joined with a single `\n`, with case-insensitive matching enabled:

```
(?<![A-Za-z0-9])(T-[0-9]+:|\[T-[0-9]+\]|\bT-[0-9]+\b|supervisor:\s*(dispatch|update board)?|ccx/)
```

The `(?i)` inline modifier is **not** part of the pattern body — it is a PCRE-only construct that ECMAScript `RegExp` rejects with a `SyntaxError` at construction time. Implementors choose the case-insensitive flag in their regex engine's native form: `grep -i -P …`, `python re.compile(pattern, re.IGNORECASE)`, `new RegExp(pattern, 'i')` in Node, etc.

The leading `(?<![A-Za-z0-9])` is a **negative lookbehind for any alphanumeric character** (matches start-of-string AND any non-alphanumeric prefix — whitespace, punctuation, brackets, backticks). The brief's original prefix was `(^|\s)`, which only matched start-of-string or literal whitespace and therefore missed common punctuation-wrapped markers like `Merge branch \`ccx/T-3\``, `fix (T-3)`, or `revert ccx/T-3-foo`. Broadening to the negative lookbehind catches every realistic tooling-marker shape the brief's "narrow to tooling-marker shapes" intent describes; this is a deliberate, documented deviation from the brief's literal regex (the only such deviation in T-3). See `docs/supervisor-design.md` §18.2.6 for the rationale anchor.

The regex matches tooling-marker shapes, not ordinary product words: `dispatch events` passes (no `supervisor:` prefix); `T-shirt` passes (the `\bT-[0-9]+\b` branch needs digits after `T-`, and the lookbehind blocks `MyT-3` because `y` is alphanumeric); `Co-Authored-By: Claude` passes (no `ccx/` slash); `1T-3:` passes (the digit `1` blocks the lookbehind). On match:

- Increment `commit_marker_attempts` (initialized to `0` at pipeline entry).
- If `commit_marker_attempts < 3`: go back to Step 1 and regenerate. Append the line `The previous rewrite still contained these tooling markers: <comma-separated match list>. Strip them.` to the Step 1 prompt template for retries — naive in-line stripping is forbidden per the brief's Decisions (it leaves dangling syntax like `: subject` after `T-3:` is removed).
- If `commit_marker_attempts == 3`: set `commit_marker_leak = true`. Skip `git commit` entirely. Phase 4's `finally`-block `chat_close` invocation MUST pass `status: "commit-marker-leak"` — see the Chat-bridge status taxonomy above. Print the final regenerated message and the matched markers to the worker log so the operator (and any future supervisor wiring per the taxonomy note above) can see what failed.

  **Phase 3 rollback.** Because the hygiene pipeline runs inside Phase 4, Phase 3's `.handoff.md` update has already touched the worktree by the time this exit fires. Restore atomicity (the failed loop run leaves no observable trace in the worktree) by reverting that file before exit: `git checkout HEAD -- <handoff_path>` if the file was tracked, OR `rm <handoff_path>` if Phase 3 created it new. If Phase 3 was skipped (no `.handoff.md` present), this rollback is a no-op. Do NOT touch any other file — `EDITED_PATHS` from Phase 1/Phase 2 is preserved on disk for the operator to inspect or salvage.

When the regex returns no match, the rewritten message is the canonical message; proceed to Step 3.

**Step 3 — opt-in `Ccx-Task` trailer.** When `WANT_TRAILER == true` AND `TASK_ID` is non-null, append a parseable Git trailer to the canonical message body. Use `git interpret-trailers --in-place --trailer "Ccx-Task: <TASK_ID>"` against the commit-message file (or `--no-divider` against stdin if no file is in flight), which:
- canonicalises the trailer block separator (blank line before trailers);
- inserts the new trailer alongside any existing `Co-Authored-By` / `Signed-off-by` lines without duplicating;
- is parseable later via `git interpret-trailers --parse`, satisfying the brief's Acceptance criterion.

**Ordering relative to Step 2.** The trailer is appended AFTER Step 2's regex gate has already passed, so the writer-side gate never inspects the trailer line (the gate would otherwise match `Ccx-Task: T-X` via the `\bT-[0-9]+\b` alternation branch and trigger a false positive). T-6's reader-side `ccx verify` MUST mirror this ordering by parsing trailers via `git interpret-trailers --parse` and applying the regex only to the non-trailer portion of the subject + body — the brief's invariant 3 names the opt-in `Ccx-Task: T-X` trailer as the single permitted exception precisely to keep this contract symmetric across the writer (T-3) and the reader (T-6). Documenting the contract here so T-6's implementation can rely on it without re-deriving the exception.

Default `WANT_TRAILER == false` produces no trailer. When `TASK_ID` is null (direct `/ccx:forever` invocation without a supervisor), the trailer step is silently a no-op — there is nothing to trail.

**Why two layers, not one.** The regex gate alone could mangle natural-language commits ("supervisor: dispatch" rewritten as "dispatch:" reads poorly); the LLM pass alone is non-deterministic and can regress. The two-layer design lets the LLM produce a clean rewrite the regex then audits, with three retries before giving up. T-6's `ccx verify` enforces the same regex at merge time as a defence in depth — see `docs/supervisor-design.md` §18.2.6.

If the user says no: stop.
