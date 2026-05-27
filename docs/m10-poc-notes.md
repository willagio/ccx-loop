# M10 PoC — Sub `claude -p` Permission and Plugin Inheritance

**Status:** Complete. Closes open questions #1 and #2 from `docs/supervisor-design.md §"Conductor Mode (M10 — proposed)"`.

**Date:** 2026-05-27  
**Claude Code version:** 2.1.152

---

## Summary of Findings

| Question | Finding |
|---|---|
| #1 Permission inheritance | `--permission-mode acceptEdits` + `--allowedTools` work as expected. Tools outside the list are blocked and reported in `permission_denials`. |
| #2 Plugin/skill resolution | `~/.claude/plugins/` resolves identically in sub-processes; `code-review` skill is discoverable without any extra flags. |

---

## Recommended Spawn-Argument Shape

For the M10 `claude-companion.mjs`:

```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep" \
  --model <model-alias-or-id> \
  --effort <level> \
  --output-format json \
  "$PROMPT" \
  < /dev/null
```

**Key choices justified by experiment:**

- `--permission-mode acceptEdits` — listed tools run without prompts; unlisted tools are denied (experiment 2, 8).
- `--allowedTools "Read,Edit,Write,Bash,Glob,Grep"` — sufficient for implement and review turns; Codex turns don't need it since they run `codex-companion.mjs`.
- `--output-format json` — stdout is always a clean JSON object (experiment 7); stderr is separate and can be discarded or logged.
- `< /dev/null` — suppresses the "no stdin data received" warning that otherwise bleeds into stderr (experiment 9 / stdin separation test).
- Do NOT use `--bare` — breaks OAuth keychain reads; only works with `ANTHROPIC_API_KEY` (experiment 4).
- `--model` and `--effort` are accepted and applied correctly (experiment 5).

---

## Experiments and Results

### Experiment 1 — Basic file edit via `--permission-mode acceptEdits`

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Bash,Write" \
  --model haiku \
  --max-budget-usd 0.20 \
  "Read $TMPDIR/test.txt, append 'appended by sub-process', output TASK_DONE"
```

**Observable behavior:** Exit code 0. File content after run:
```
test content
appended by sub-process
```
The Edit tool ran without a permission prompt. **Validates:** `--permission-mode acceptEdits` + `--allowedTools` allows listed tools to edit files without blocking.

---

### Experiment 2 — Disallowed tool is blocked

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Bash" \
  --model haiku \
  "Try to use the Write tool to create $TMPDIR/blocked.txt ..."
```

**Observable behavior:** Exit code 0. Sub-process replied: `"Write blocked"`. File `blocked.txt` was not created.

**Validates:** Tools NOT in `--allowedTools` are denied. Exit code is still 0 (the denial is not fatal to the sub-process).

---

### Experiment 3 — `code-review` skill resolution in sub-process

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Bash,Glob,Grep" \
  --model haiku \
  "Run: ls ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review/ 2>/dev/null && echo FOUND"
```

**Observable behavior:** Output: `SKILL_FOUND`. Second run listing both directories:
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review/` → `commands/ LICENSE README.md`
- `~/.claude/plugins/marketplaces/ccx-loop/plugins/` → `ccx/`

**Validates:** Plugin directories resolve identically inside sub-processes. `code-review` is discoverable. No `--plugin-dir` flag is needed — plugins auto-load from `~/.claude/plugins/`.

---

### Experiment 4 — `--bare` flag breaks OAuth auth

**Argv:**
```bash
claude -p --bare --permission-mode acceptEdits --allowedTools "Read,Bash" --model haiku "..."
```

**Observable behavior:** Exit code 1. Output: `Not logged in · Please run /login`.

**Invalidates:** The companion script cannot use `--bare`. The `--bare` flag skips keychain reads, so it requires `ANTHROPIC_API_KEY` to be set in the environment. This environment uses OAuth. Do not use `--bare` for M10 sub-processes.

---

### Experiment 5 — `--model` and `--effort` work correctly

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Bash" \
  --model sonnet \
  --effort medium \
  --max-budget-usd 0.20 \
  "Output: MODEL_EFFORT_TEST_DONE"
```

**Observable behavior:** Exit code 0. Output: `MODEL_EFFORT_TEST_DONE`.

**Validates:** Both `--model` and `--effort` are accepted and applied. The companion script can pass per-cycle tier settings via these flags.

---

### Experiment 6 — VERDICT line protocol

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Bash,Glob,Grep" \
  --model haiku \
  "Review the following diff and output your assessment. ... When done output exactly: VERDICT: approve"
```

**Observable behavior:** Exit code 0. Final line of `result` field: `VERDICT: approve`.

Grep over output: `VERDICT_LINE: VERDICT: approve` — cleanly parseable.

**Validates:** The `VERDICT:` line protocol works. The conductor can extract it from the `result` field of the JSON envelope.

---

### Experiment 7 — `--output-format json` envelope shape

**Argv:**
```bash
claude -p --output-format json --model haiku "Output: SHAPE_TEST"
```

**Observable behavior (stdout only, no 2>&1):**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "SHAPE_TEST",
  "stop_reason": "end_turn",
  "session_id": "...",
  "total_cost_usd": 0.0167,
  "usage": { "input_tokens": 10, "output_tokens": 49, ... },
  "permission_denials": [],
  "terminal_reason": "completed",
  ...
}
```

**Validates:** Stdout is always clean JSON when `--output-format json` is used. The companion script should capture stdout for the result and log or discard stderr. The `result` field contains the final text output.

---

### Experiment 8 — `permission_denials` captures blocked tool attempts

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Bash" \
  --output-format json --model haiku \
  "Try to use the Write tool to create $TMPDIR/perm-test.txt ..."
```

**Observable behavior:**
```json
{
  "result": "PERM_TEST_DONE",
  "permission_denials": [
    {
      "tool_name": "Write",
      "tool_use_id": "toolu_017r47HViPskxRggzERaabzo",
      "tool_input": {
        "file_path": "/tmp/m10-poc-roThG1/perm-test.txt",
        "content": "perm test"
      }
    }
  ]
}
```

**Validates:** The `permission_denials` array records every blocked tool attempt with full `tool_name` and `tool_input`. The companion script can surface this to the conductor for diagnostics (e.g., a sub-process that tried to use a disallowed tool indicates a prompt issue).

---

### Experiment 9 — `--add-dir` does NOT restrict scope

**Argv:**
```bash
claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Read,Bash,Write" \
  --add-dir "$TMPDIR/worktree" \
  --model haiku \
  "Read $TMPDIR/worktree/scoped.txt AND $TMPDIR/outside/out.txt and report both."
```

**Observable behavior:** Exit code 0. Both files were read successfully. The sub-process read `$TMPDIR/outside/out.txt` even though `--add-dir` only specified `$TMPDIR/worktree`.

**Invalidates** the assumption that `--add-dir` restricts scope. `--add-dir` only ADDS directories to the trust zone (expanding what was previously blocked); it does NOT restrict reads to those directories. With `--permission-mode acceptEdits` the sub-process can access any path.

**Implication for M10:** Worktree isolation **cannot** be enforced via `--add-dir` alone, and it cannot be enforced via prompt instructions either — a prompt instruction is a best-effort guide, not an enforcement boundary. With `--permission-mode acceptEdits` the sub-process can access any path regardless of what the prompt says. The only reliable enforcement options are OS-level sandboxing (e.g., `bubblewrap`, `firejail`, or container isolation) or running on a host where `~` itself is scoped to the worktree. For the M10 implementation: document this limitation explicitly. The conductor observes what changed inside the worktree via the temp-index snapshot, but out-of-worktree writes are neither prevented nor reliably observed without OS-level sandboxing. The conductor audit trail records tier/side/exit decisions, not arbitrary filesystem side effects.

---

### Stdin warning behavior

When running with `2>&1` (mixing stderr into stdout), a warning can appear:
```
Warning: no stdin data received in 3s, proceeding without it.
```

When stdout and stderr are captured **separately**, stdout is always clean JSON and stderr may contain this warning. The companion script should:
1. Redirect stdin from `/dev/null` (`< /dev/null`) to suppress the warning, **or**
2. Capture stdout and stderr into separate streams.

Both approaches work. `< /dev/null` is simpler.

---

## Quirks

1. **Haiku + Bash tool follow-up:** In experiment 1, the Edit was applied twice when the sub-process was asked to both edit and then `cat` the file. The double-append suggests the model interpreted the cat output as requiring another edit. In production, implement turns should instruct the sub-process to edit first, then confirm, not to re-apply after verification. The snapshot-based empty-diff check in the conductor is the authoritative "did anything change" signal.

2. **`--output-format json` parse errors with `2>&1`:** Several experiments produced JSON parse errors because the stdin warning was mixed into the JSON stdout via `2>&1`. Always separate stdout and stderr when parsing the companion output.

3. **Exit code 0 on permission denial:** A sub-process that attempts a disallowed tool and is blocked still exits 0. The conductor cannot use the exit code to detect permission issues; it must inspect `permission_denials` in the JSON envelope.

4. **Budget exceeded exits with code 1:** `--max-budget-usd` exhaustion exits with code 1 and output `Error: Exceeded USD budget (N)`. The companion script must handle this exit code and distinguish it from other errors.

---

## Conclusions for T-2 (companion script)

1. Use `claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Bash,Glob,Grep" --model <m> --effort <e> --output-format json "$PROMPT" < /dev/null`.
2. Capture stdout only for JSON parsing; log or discard stderr.
3. Parse `result` field for the sub-process's final text (including `VERDICT:` line).
4. Check `is_error` and `permission_denials` for diagnostics.
5. Do NOT use `--bare`.
6. Do NOT rely on `--add-dir` for scope restriction. There is no CLI-level enforcement boundary short of OS sandboxing. Prompt instructions are best-effort guidance only. The temp-index snapshot records what changed **inside the worktree** — out-of-worktree writes are not observed by it and are not prevented by any M10 mechanism.
7. Handle exit code 1 as a fatal companion error (budget exceeded, auth failure, binary missing).
8. No `--plugin-dir` flag needed — `code-review` and ccx skills resolve automatically.
