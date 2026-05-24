---
description: "Run the M9 customer-mode contract checks against the current repo. Exit 0 = clean; non-zero = leak (codes 10..15 per invariant)."
argument-hint: "[--base REF] [--target REF] [--with-diff PATH]"
allowed-tools: Bash
---

# /ccx:verify — M9 customer-mode contract enforcer (manual entry point)

Thin slash-command wrapper around `plugins/ccx/scripts/verify.sh`. Use it to audit a customer-mode repo after a series of ccx runs, OR to debug a supervisor pre-merge leak block on a specific worker branch.

The supervisor invokes the same script automatically as a pre-merge gate (see `plugins/ccx/commands/supervisor.md` Step B step 3 "M9 T-6 — ccx verify pre-merge gate"). Manual invocation is for: post-run audits, brief-rewrite sanity checks, and diagnosing a `leak-<code>` exit_status the supervisor surfaced.

## What it checks

Six invariants (full table in `docs/supervisor-design.md` §18 — copied here for ergonomics):

| # | Invariant | Exit code |
|---|---|---|
| 1 | The user's working tree contains no `.ccx/` directory. | 10 |
| 2 | The user's `.gitignore` (committed) contains no ccx-related entries. | 11 |
| 3 | No commit subject/body in `BASE..TARGET_REF` contains ccx tooling markers (`T-N:`, `[T-N]`, standalone `T-N`, `supervisor:dispatch`, `supervisor:update board`, `ccx/`). The opt-in `Ccx-Task: T-N` trailer is allowed. | 12 |
| 4 | No `Merge branch 'ccx/...'` merge commit in `BASE..TARGET_REF`. | 13 |
| 5 | No stale `ccx/T-*` branch ref survives (the candidate `TARGET_REF`, if it matches that shape, is exempted). | 14 |
| 6 | The diff `BASE...TARGET_REF` touches no protected path (`.claude/`, `CLAUDE.md`, `AGENTS.md`). | 15 |

Exit codes 10..15 map 1:1 to the invariant numbers. On multi-violation, the script exits with the **lowest** matching code and prints **every** violation to stderr — so a single run surfaces the full leak picture.

Dogfood mode (`git config --local ccx.dogfood true`) bypasses invariants 1, 2, 3, and 4. Invariant 5 always runs. Invariant 6 is **independent** of dogfood — even dogfood runs must opt in to edit `.claude/` / `CLAUDE.md` / `AGENTS.md` via `CCX_PROTECTED_OPTIN=1`, by design (a per-invocation env var carries less drift risk than a persistent `git config` knob).

## Arguments

- `--base REF` — integration baseline. Default: `HEAD`.
- `--target REF` — candidate worker ref. Default: `HEAD`. Pass empty to run a pure "no worker in flight" audit (invariants 3/4/6 degrade to no-ops; invariant 5 flags every `ccx/T-*` ref).
- `--with-diff PATH` — feed a precomputed newline-separated diff path list (the supervisor passes its own; manual callers usually let the script compute one from BASE/TARGET).

`CCX_PROTECTED_OPTIN=1 /ccx:verify ...` bypasses invariant 6 for an intentional edit to `.claude/`, `CLAUDE.md`, or `AGENTS.md`. The opt-in is per-invocation (env var) on purpose — there is no persistent `git config` knob to flip, so it can't silently disable invariant 6 across a machine.

## Steps

### Step 1 — parse and validate `$ARGUMENTS` in prose

Before running any bash, parse the slash-command arguments (`$ARGUMENTS`) as plain text. Slash-command argument expansion is performed by Claude (the LLM), not the shell — letting bash re-tokenize `$ARGUMENTS` via `set -- $ARGUMENTS` would expose any shell metacharacters in user input to the shell's parser BEFORE validation could fire (same hazard the `/ccx:link` command documents).

Resolve three variables:

- **`BASE_VAL`** — the value of `--base REF` (or `--base=REF`). Default: `HEAD`. Validate against `^[A-Za-z0-9][A-Za-z0-9._/@~^-]{0,127}$` (git ref characters; no shell metacharacters); STOP on mismatch with `fatal: --base value 'X' is not a valid revision shape`.
- **`TARGET_VAL`** — the value of `--target REF` (or `--target=REF`). Default: `HEAD`. An EMPTY explicit value is allowed (no-worker audit mode) and is preserved verbatim — validate as `^([A-Za-z0-9][A-Za-z0-9._/@~^-]{0,127})?$` (the trailing `?` permits empty). STOP on mismatch.
- **`DIFF_VAL`** — the value of `--with-diff PATH` (or `--with-diff=PATH`). Default: empty. Validate as `^[A-Za-z0-9._/+@~ -]{1,4096}$` when non-empty (file-path characters; bans shell metas like `$`, backtick, `;`, `|`). STOP on mismatch.

Reject any other tokens in `$ARGUMENTS` with `fatal: unexpected argument '<token>' — usage: /ccx:verify [--base REF] [--target REF] [--with-diff PATH]`.

The strict regexes above preclude single quotes, dollar signs, backticks, and every other shell metacharacter, so the validated values are safe to substitute as single-quoted literals into the bash block below.

### Step 2 — run the verifier

Substitute the validated values from Step 1 inline (single-quoted). For `TARGET_VAL`, preserve the empty case as `TARGET_VAL=''` so the no-worker audit mode reaches the script intact (the verifier's `${TARGET_REF-HEAD}` no-colon default only fires when TARGET_REF is unset).

```bash
set -eu
# Step 1's validation guarantees no single quotes, dollar signs, backticks,
# or other shell metacharacters appear in the three values below.
BASE_VAL='<INSERT validated --base from Step 1>'
TARGET_VAL='<INSERT validated --target from Step 1>'
DIFF_VAL='<INSERT validated --with-diff path from Step 1>'

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:verify must be run inside a git repository" >&2
  exit 2
}
# Resolve the script. When Claude is running an installed plugin it exports
# CLAUDE_PLUGIN_ROOT pointing at the actual on-disk plugin directory (the
# same convention chat-setup uses). Trust it first — that handles every
# marketplace/cache layout Claude supports without us having to enumerate
# each one. Fall back to the in-repo path so the command also works when
# developing against this checkout directly.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "${CLAUDE_PLUGIN_ROOT}/scripts/verify.sh" ]; then
  SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/verify.sh"
elif [ -x "$REPO_ROOT/plugins/ccx/scripts/verify.sh" ]; then
  SCRIPT="$REPO_ROOT/plugins/ccx/scripts/verify.sh"
else
  echo "fatal: cannot locate plugins/ccx/scripts/verify.sh — CLAUDE_PLUGIN_ROOT is unset and the script is absent from this repo" >&2
  exit 2
fi
# Optional --with-diff PATH → read file into CCX_DIFF_PATHS.
DIFF_PATHS_VAL=""
if [ -n "$DIFF_VAL" ]; then
  [ -r "$DIFF_VAL" ] || { echo "fatal: --with-diff $DIFF_VAL is not readable" >&2; exit 2; }
  DIFF_PATHS_VAL="$(cat "$DIFF_VAL")"
fi

REPO="$REPO_ROOT" \
BASE="$BASE_VAL" \
TARGET_REF="$TARGET_VAL" \
CCX_DIFF_PATHS="$DIFF_PATHS_VAL" \
CCX_PROTECTED_OPTIN="${CCX_PROTECTED_OPTIN:-0}" \
  bash "$SCRIPT"
```

## Expected output

Clean repo:

```
$ /ccx:verify
$ echo $?
0
```

Leaking repo (multi-violation):

```
$ /ccx:verify
ccx verify: invariant 1 — $REPO/.ccx/ exists in the working tree (...)
ccx verify: invariant 3 — commit message contains a ccx tooling marker (...)
ccx verify: invariant 4 — merge commit subject "Merge branch 'ccx/T-3'" carries the legacy ccx/ branch marker (...)
$ echo $?
10
```

(Exit code is the lowest of the matching invariant codes; stderr lists all.)

## Related

- `plugins/ccx/scripts/verify.sh` — the script itself; the SSOT for the check logic.
- `plugins/ccx/commands/supervisor.md` — Step B step 3 "M9 T-6 — ccx verify pre-merge gate"; calls the same script with `CCX_DIFF_PATHS` and `CCX_PROPOSED_MSG` set, blocks the merge on non-zero, and routes the leak detail into M5's stuck-exit auto-revise loop.
- `docs/supervisor-design.md` §18 — M9 invariant SSOT and §18.2.9 (T-6 verifier contract).
- `README.md` "Customer mode" — invariants + migrate path.
