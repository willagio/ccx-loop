---
description: "Seed or append BOARD.md task rows from free-form input (prompt or document). Entry point for /ccx:supervisor — M6."
argument-hint: "<prompt> | --from <path> [--append]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /ccx:plan — BOARD.md scaffolding from free-form input

Take a free-form prompt or a document the human already wrote (PRD, design note, ticket export, CLAUDE.md-style note — any format), explore the repo to ground `scope.include` globs on actual files, and write `BOARD.md` task rows as `status: draft`. The human reviews the draft, edits if needed, flips `draft → pending`, and then runs `/ccx:supervisor`.

**State path.** `BOARD.md` lives at `STATE_DIR/BOARD.md`, where `STATE_DIR` is resolved exactly as documented in `plugins/ccx/commands/supervisor.md` → "State path resolver" (SSOT) and `docs/supervisor-design.md` §18. `STATE_DIR` is `$XDG_DATA_HOME/ccx/<repo-key>/` outside the working tree (overridable via `$CCX_DATA_HOME`). Plan resolves `STATE_DIR` at P0 (the resolver emits the one-line `ccx state: <STATE_DIR>` stderr announcement) and uses `STATE_DIR/BOARD.md` for every read / write below. The `git -C "$REPO_ROOT" …` anchoring rule applies to scope-glob grounding. BOARD is not under git tracking — plan `Write`s it directly with no `git add` / `git commit` step.

This command is the `/ccx:supervisor` onboarding path (see §14 of `docs/supervisor-design.md`). Without it, the only route to a valid `BOARD.md` is hand-authoring YAML from the design doc — the onboarding cliff M6 closes.

Raw arguments: `$ARGUMENTS`

---

## Argument Parsing

- Positional text (everything that is not a recognized flag) is the **prompt**. One of `<prompt>` or `--from <path>` must be supplied — not both. Supplying neither is an error.
- `--from <path>` — read the file at `<path>` (relative to the repo root or absolute) as the planning context. Use this when the user already wrote a PRD / design note / ticket export and wants plan to decompose it.
- `--append` — extend an existing `BOARD.md` by appending new `draft` rows at the **end** of the `## Tasks` YAML block. Existing rows (regardless of status) MUST be preserved byte-for-byte; plan never modifies them.

**Mode matrix:**

| Mode | BOARD.md present? | Behavior |
|---|---|---|
| default (no `--append`) | absent | Create a fresh `BOARD.md` with a `## Direction` section and a `## Tasks` YAML block containing every planned row as `status: draft`. |
| default | present | STOP: `BOARD.md already exists — re-run with --append to add more draft rows, or edit BOARD.md by hand.` Do not overwrite — a silent overwrite would destroy human edits and merged-task history. |
| `--append` | absent | STOP: `BOARD.md not found — drop --append to create one from scratch.` Keeps append semantics strict and predictable. |
| `--append` | present | Parse the existing YAML block, compute `NEXT_ID = max(existing T-N ids) + 1`, append new rows starting at `NEXT_ID`. `## Direction` is left untouched (plan never rewrites human-authored prose). |

No other flags for M6. Direction-only updates and row-editing are manual — the user edits `BOARD.md` by hand.

---

## Guardrails

- Plan MUST NOT push, force-push, amend, `git reset --hard`, or create branches — it only writes `BOARD.md` (and commits it on the current branch).
- Plan MUST NOT write `STATE_DIR/tasks/*.md` brief files. The supervisor creates briefs at dispatch time (§6.1 of the design doc). If plan wrote briefs here, they would bypass the draft-review gate.
- Plan MUST NOT set any task row to `status: pending` — every new row is `draft`. The `draft → pending` transition is the human's review act and is explicitly gated (see §14.3.3).
- `scope.include` globs MUST be **grounded on actual repo files**. For each proposed glob, run `git ls-files -z -- <glob>` and record the match count. If a glob matches zero files, that is allowed (the task may create new files) BUT the task's `notes` field MUST say so explicitly so the human catches hallucinated scopes on review. Ungrounded scopes cause the supervisor's M4 overlap gate to misfire at dispatch time — worse than no plan.
- `scope.include` globs MUST pass the same contract enforced by `/ccx:supervisor` P1 step 2: non-empty strings, no NUL byte, no newline. Plan runs the pathspec sanity probe (`git ls-files -z -- <glob>`) on each glob to catch malformed pathspecs before the human ever sees them.
- Plan MUST NOT modify any existing task row in `--append` mode — not even to normalize whitespace or re-order keys. The existing YAML block is edited by inserting new rows immediately before the closing fence; prior bytes are left alone.
- Every emitted row MUST have a stable `id` of the form `^T-[0-9]+$`. IDs are monotonic from `max(existing) + 1` — never reused even if a prior row was removed, because brief filenames and branch names key off the id (§14.3.4).
- Task count is bounded: emit between **1 and 25** rows per invocation. Under 1 is a planning failure; over 25 is almost certainly under-decomposition noise rather than a real plan and should trigger a refusal with the offer to re-run on a narrower scope.

---

## Phase 0: Pre-check

1. Resolve repo root: `REPO_ROOT="$(git rev-parse --show-toplevel)"`. If not inside a git repo, STOP with `/ccx:plan must be run inside a git repository`.
1a. **Resolve `STATE_DIR`** per `plugins/ccx/commands/supervisor.md` → "State path resolver" (SSOT). Compute `BOARD_PATH = STATE_DIR/BOARD.md` (absolute). Plan `Write`s and `Read`s `BOARD_PATH` directly — BOARD is not under git tracking, so there is no dirty-check, no `git add`, and no commit step.

   **Repo-root anchoring (load-bearing for in-tree pathspecs).** From this step onward, every `git …` invocation that targets in-tree paths — most importantly the `git ls-files -z -- <glob>` scope-grounding probe (Phase 1 step 3) — MUST be anchored to `REPO_ROOT` via the `git -C "$REPO_ROOT" …` form. Bare `git …` without `-C` resolves pathspecs relative to the caller's current directory, which would mean `scope.include` globs are evaluated against a different set than the supervisor will see at dispatch (see its M4 overlap gate in supervisor.md §P2.4). The `-C "$REPO_ROOT"` prefix makes every in-tree-anchored command below behave as if invoked from the repo root regardless of where the user actually ran `/ccx:plan` from. The quoting matters: `"$REPO_ROOT"` may contain spaces on platforms where the repo is checked out under a path like `~/Client Projects/foo`. Always pass `BOARD_PATH` as an absolute path, never a bare `BOARD.md`.
3. Parse the arguments above into `INPUT_MODE ∈ {prompt, from}`, `APPEND ∈ {true, false}`, `INPUT_RAW` (the prompt string or the contents of `--from <path>`), and `INPUT_LABEL` (`"prompt"` or `"from <path>"`).
4. `BOARD_PATH` is already resolved in step 1a. Apply the mode matrix above against `BOARD_PATH` (file existence check uses the absolute path). STOP on the error cases listed there.
5. If `INPUT_MODE == "from"`:
   - **Normalize the path against `REPO_ROOT` first.** The `--from <path>` flag accepts absolute paths verbatim, but any relative path MUST be resolved against `REPO_ROOT` rather than the caller's current directory. If the raw path starts with `/` (Unix) or matches `^[A-Za-z]:` (Windows drive letter), treat it as absolute and use it as-is; otherwise compute `FROM_PATH="$REPO_ROOT/<path>"`. Without this normalization, a user who runs `/ccx:plan --from docs/prd.md` from a subdirectory like `apps/web/` would get a file-not-found error even though `docs/prd.md` exists at the repo root — the same subdirectory-invocation hazard the repo-root anchoring rule in step 1 exists to close.
   - Verify the normalized path exists and is readable (`test -r "$FROM_PATH"`). STOP if not, reporting `FROM_PATH` (the normalized absolute form) so the user can see exactly which location was checked.
   - Read the file with `Read` using `FROM_PATH` (absolute). No offset/limit — plan needs the whole document. If the file exceeds ~80KB, emit a warning: plan may summarize rather than decompose faithfully. Do not hard-fail — respecting the user's existing document is the point.

If anything fails, print the exact error and stop. No partial writes, no partial commits.

---

## Phase 1: Ground the plan on repo reality

The single biggest failure mode is hallucinated scopes — decomposing a task into `src/auth/oauth.ts` when the repo actually organizes auth under `packages/server/auth/*`. Every glob in every proposed `scope.include` MUST be grounded on actual files. Do this BEFORE emitting any rows.

1. **Top-level map.** Run:
   - `git -C "$REPO_ROOT" ls-files -z | head -c 8192` — a byte-capped listing of tracked files (the cap keeps very large repos' output manageable; plan does not need every path, just enough to identify package layouts and naming conventions).
   - `Read` `REPO_ROOT/README.md` if it exists.
   - `Read` `REPO_ROOT/CLAUDE.md` if it exists (project instructions often state where code lives and the preferred decomposition granularity).
   - If the repo has a monorepo layout (presence of `packages/`, `apps/`, `services/`, `crates/`, etc. in the ls-files output), `Glob` the top level of each to learn the sub-package names.
2. **Input analysis.** Read `INPUT_RAW` and extract candidate **units of work** — each unit is one deliverable slice that could plausibly be a single `/ccx:loop` run (scope: one feature, one refactor, one bugfix, one doc slice). Prefer slicing by *outcome*, not by *layer* — `add OAuth2 login flow` is one task, not three (backend / frontend / docs as separate tasks fragment scope and defeat the supervisor's per-task worktree model).
3. **Glob grounding.** For each candidate unit, draft a tentative `scope.include` list of 1–5 globs. For each glob:
   - Run `git -C "$REPO_ROOT" ls-files -z -- <glob>` (argv form, NOT shell-interpolated — the glob is a Git pathspec, not a shell glob; `git -C "$REPO_ROOT" ls-files -- 'src/**/*.ts'` is correct, `git -C "$REPO_ROOT" ls-files -- src/**/*.ts` lets the shell expand `**` and produces wrong results). The `-C "$REPO_ROOT"` prefix is mandatory here: supervisor evaluates `scope.include` globs from `REPO_ROOT` at dispatch time, so plan's grounding must use the same base directory or the persisted globs will match a different file set at dispatch than they did at plan time.
   - Record the match count. If zero, either narrow the glob (common cause: typo / wrong extension / wrong monorepo package) or keep it and note in the row's `notes` field that the task creates new files at this path.
   - Run the same command with `Grep` or `Glob` to cross-check — if `Glob` returns matches but `git ls-files` does not, the file is untracked and the scope likely needs `git add` first (surface this in `notes`).
4. **Dependency inference.** If two candidate units obviously depend on each other (e.g. "add DB migration for X" must land before "add service that reads X"), record the dependency as `depends_on: [T-<id>]`. Keep dependencies conservative — false positives serialize tasks that could run in parallel. Prefer an empty `depends_on` when unsure; the human can add deps on review.
5. **Cap check.** Count the candidate units. If under 1 or over 25, STOP with:
   - Under 1: `input did not decompose into any tasks — try a more concrete prompt or narrower document scope`.
   - Over 25: `input decomposed into <N> tasks — too many for one plan. Re-run with a narrower slice, or split the document into sections and run --append per section`.

Output of this phase: an in-memory list `PLANNED_TASKS` with fields `{ title, scope_include (grounded globs + match counts), depends_on (forward-references by position), notes (≤500 chars, explicit about zero-match globs and new-file creation) }`.

---

## Phase 2: Emit BOARD.md

### 2a. Fresh-seed mode (no `--append`, no existing BOARD.md)

Write `BOARD_PATH` (the absolute path computed in Phase 0 step 1a: `STATE_DIR/BOARD.md`) with exactly this structure (no leading/trailing blank lines beyond what is shown; Markdown is whitespace-sensitive for the supervisor's parser):

```markdown
# BOARD

## Direction

{{2–5 sentences summarizing project-wide priorities derived from INPUT_RAW.
If INPUT_RAW does not suggest direction-level content (e.g. a narrow bug-fix
prompt), leave this section with a single line: "_(plan did not infer
direction — edit by hand if supervisor needs project-wide context)_". Never
invent direction content; absence is better than confabulation.}}

## Tasks

```yaml
{{YAML array of PLANNED_TASKS rendered per §2c below, starting at id T-1}}
```
```

**Nested fence caveat.** The YAML block lives inside a triple-backtick fence, and the enclosing markdown spec here uses triple-backtick fences too. When actually writing `BOARD.md`, emit the outer markdown as plain text and the YAML block as a literal ` ```yaml ... ``` ` fenced section — the markdown above is a template preview, not a literal file. The supervisor's P1 parser requires exactly one fenced block under `## Tasks` containing a YAML array; any additional fenced blocks under that heading will break parsing.

Forward-reference resolution: `depends_on` entries recorded as positional forward-references in Phase 1 step 4 must be rewritten to concrete `T-<id>` values before emission (every row's position `i` maps to id `T-<i+1>` when starting at 1). Resolve these in a single pass after assigning ids, then emit.

### 2b. Append mode (`--append`, existing BOARD.md)

1. `Read` the existing BOARD at `BOARD_PATH`.
2. Locate the `## Tasks` heading. If absent, STOP with `BOARD.md has no ## Tasks section — /ccx:plan --append can only extend an existing task block. Edit BOARD.md by hand to add the heading + an empty yaml block first.`
3. Locate the opening ` ```yaml ` fence on the line after `## Tasks` (allowing one blank line between) and the matching closing ` ``` ` fence. If either fence is missing, STOP with the same guidance as step 2 — append mode requires a well-formed fenced block (even an empty one). An **empty YAML block** is explicitly allowed and supported: it is a common intermediate state (a human seeds a direction-only `BOARD.md` by hand and then runs `/ccx:plan --append` to add the first tasks). "Empty" here means any of three shapes: (a) fences with only whitespace between them; (b) a literal `[]` body; (c) fences containing only YAML comments (lines starting with `#`).
4. **Fast-path blank bodies before the YAML parse.** Extract the raw text between the opening and closing fences. Strip comments (any line whose first non-whitespace character is `#`). If the stripped result is only whitespace, OR is exactly `[]` (ignoring surrounding whitespace), OR would parse to YAML `null`, treat the block as `EXISTING_TASKS = []` and `EXISTING_IDS = []` directly — do NOT feed the raw text to a YAML parser in this case. A whitespace-only YAML document parses to `null`, not `[]`, so a naive "parse, then treat as array" pipeline would either crash on `null.forEach(...)` or wrongly reject the documented direction-only case. Only when the stripped body contains at least one non-comment, non-whitespace character (a `-` bullet or a `{`) do we proceed to an actual YAML parse. Extract `EXISTING_IDS = [T-<n> for each task with id matching ^T-[0-9]+$]`. Compute `MAX_ID_N = max(numeric suffix of each existing id, default 0)` — the `default 0` covers the empty-block fast-path so the first new task becomes `T-1`. The first newly-emitted task gets `id = T-<MAX_ID_N + 1>`, next is `T-<MAX_ID_N + 2>`, and so on — **never reuse an id even if it appears in `EXISTING_IDS` as a removed-but-still-referenced entry**, because brief filenames and branch names key off the id.
5. Resolve forward-reference `depends_on` entries against the new ids (Phase 1 step 4 entries reference other planned tasks by position; `depends_on` may also legitimately reference an existing `EXISTING_IDS` entry if Phase 1 identified a dependency on already-seeded work — record those verbatim).
6. **Render every new task** to a YAML text block per §2c below.
7. **Use `Edit`** to insert the new YAML text immediately before the closing ` ``` ` fence, preserving the existing fence position and every existing task entry byte-for-byte. Do NOT re-write the entire block — an Edit-based insert is the only way to guarantee existing rows are untouched (Write-based full-file rewrite is forbidden in append mode).
   - **Non-empty block:** anchor the `Edit` on the last existing task's final line + the closing fence. If the existing block has trailing whitespace or unusual formatting that makes the anchor ambiguous, narrow the anchor until it is unique.
   - **Empty block** (literal `[]` body, or fences with only whitespace between them): anchor the `Edit` on the opening fence + the empty body + the closing fence as one contiguous region, and replace it with the opening fence + the new YAML rows + the closing fence. A literal `[]` body must be replaced by the new rows, not preserved — a YAML block can't validly contain both `[]` and task entries.
   - Never use `replace_all` in this command.
8. Do NOT touch `## Direction` or any other section of the file.

### 2c. YAML row template

Every emitted row MUST match this shape exactly:

```yaml
- id: T-<n>
  title: "<short human-readable title — one line, ≤80 chars>"
  scope:
    include:
      - <grounded glob 1>
      - <grounded glob 2>
    exclude: []
  status: draft
  priority: normal
  depends_on: []
  brief: tasks/T-<n>.md
  attempts: 0
  worktree: null
  branch: null
  worker_pid: null
  started_at: null
  finished_at: null
  exit_status: null
  notes: |
    <1–3 sentences of intent. MUST explicitly note:
     - any glob in scope.include that matched zero files (task will create new files)
     - any assumption that needs human validation ("assumed DB uses PostgreSQL — confirm before flip")
     - the source of this task in INPUT_RAW (for --from mode, a section reference;
       for prompt mode, the phrase that triggered this task)>
```

Rules:
- `status: draft` — hardcoded. Never `pending`, never any other value.
- `priority: normal` — hardcoded for M6. Humans adjust priority on review.
- `depends_on: []` by default; populated with ids only when Phase 1 step 4 inferred a dependency.
- `brief: tasks/T-<n>.md` — logical path relative to `STATE_DIR` (§6.1 of the design doc; M9 — see also §18). Supervisor never reads this field for path resolution — it derives `STATE_DIR/tasks/<id>.md` from the task id directly — so the field is a stable annotation, not a runtime lookup key. No brief file is created at plan time; supervisor creates it at dispatch.
- `attempts: 0` and every `*_at` / `worker_pid` / `exit_status` / `worktree` / `branch` field are `null` / `0` as shown — supervisor-managed runtime state, placeholders only.
- `notes:` — use the YAML literal block scalar (`notes: |`) for multi-line notes. Single-line notes can use the plain form (`notes: "..."`), but the block form is always safe.

After emission, `Read` the file back and verify:
- `## Tasks` appears exactly once.
- Exactly one fenced YAML block appears immediately under `## Tasks`.
- Every new row's `status` is `draft`.
- In append mode, every `EXISTING_IDS` entry still appears verbatim in the file (byte-for-byte substring match).

If any check fails, STOP — do NOT commit. Leave the modified `BOARD.md` on disk so the user can inspect and re-run.

---

## Phase 3: Persist

BOARD lives outside the working tree at `STATE_DIR/BOARD.md`. The Phase 2 `Write` / `Edit` is the persisted form — there is no `git add` / `git commit` step. Plan owns the file outright and writes it directly.

If the Write fails (permission denied, disk full, etc.), STOP and tell the user: `failed to write BOARD at <BOARD_PATH>: <error>`.

---

## Phase 4: Report

After a successful `Write`, print:

1. A one-line header: `planned <N> tasks — T-<first>..T-<last>, status: draft`.
2. `BOARD written to <BOARD_PATH>` (the absolute path resolved in Phase 0 step 1a).
3. Per-task summary: `T-<id>  <title>  (scope: <file-count> files across <glob-count> globs)`. If any glob matched zero files, append `  [new-file-scope]` so the human spots it on review.
4. Footer with next steps:
   ```
   Next steps:
     1. Review <BOARD_PATH>. Edit any draft row (title, scope.include, depends_on, notes) as needed.
        BOARD lives outside the working tree — edits to it are not under git and never need
        staging or committing. Use `/ccx:board` from the repo to re-open it in $EDITOR later,
        or `/ccx:where` to print the resolved state path.
     2. For each task you want to dispatch, change `status: draft` to `status: pending`.
     3. Make sure the rest of your working tree is clean — `/ccx:supervisor` P0 step 3
        refuses to start on a dirty tree. Commit or stash any unrelated edits (PRD source
        documents, scratch files, the `--from <path>` source if you have not committed it
        yet) before continuing.
     4. Run `/ccx:supervisor` to dispatch the pending tasks.

   To add more tasks later: `/ccx:plan --append "<prompt>"` or `/ccx:plan --append --from <path>`.
   To inspect the queue without opening BOARD: `/ccx:tasks` (lists tasks + status; `--status` filters).
   ```

   Substitute the resolved `<BOARD_PATH>` literally so the user knows exactly which file to edit.

This is the exit contract — plan does not run the supervisor, does not set any task `pending`, and does not touch `STATE_DIR/tasks/`.

---

## Relationship to `/ccx:supervisor`

- `/ccx:plan` writes `BOARD.md` rows with `status: draft`.
- `/ccx:supervisor` P1 validator accepts `draft` as a valid status value but **excludes** it from dispatch — the same exclusion as `assigned | review | merged | blocked`. Draft rows never trigger a dispatch, never create briefs, never spawn workers.
- The human's review action is literally editing `BOARD.md` and flipping `draft → pending`. That edit is a normal human commit; supervisor picks up the `pending` rows on its next run.
- If `/ccx:supervisor` is invoked when no `BOARD.md` exists, it STOPs with a pointer back to this command (see supervisor.md Phase P0 step 4).

The two commands have disjoint responsibilities: plan is LLM creativity (decomposition + scope grounding), supervisor is deterministic scheduling (dispatch + merge). Mixing them (a `/ccx:supervisor --plan` flag) was rejected in §14.2 of the design doc because it would degrade the supervisor's deterministic-parser property that M4/M5 rely on.
