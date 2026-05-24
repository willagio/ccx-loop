---
description: "Pin this repo's ccx STATE_DIR to a readable name (writes git config ccx.link, no repo-root file)."
argument-hint: "--name <readable>"
allowed-tools: Bash
---

# /ccx:link — Pin STATE_DIR to a readable repo-key

Inspection-surface helper introduced in M9 T-5. The default `<repo-key>` is a SHA-256-derived suffix (e.g. `widgets-a3f9b2c`) — stable across fresh clones but cryptic when an operator is reading filesystem paths. `/ccx:link --name <readable>` replaces it with an operator-chosen string for THIS repo, so the resolver yields `$XDG_DATA_HOME/ccx/<readable>/` from this invocation onward. `/ccx:unlink` reverts to the auto-derived key.

The override is stored as `git config ccx.link <readable>` — per-clone, not committed. **No file is written into the working tree** (a repo-root config file would itself violate invariant 1 — see "Why not a repo-root file" below).

## Argument Parsing

- `--name <readable>` — required. The new `<repo-key>` value. Validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$` (1–63 chars; alphanumeric + `.`, `_`, `-`; no leading dot / dash; no slashes; no whitespace). The validation is strict because `<readable>` is substituted directly into a filesystem path (`$XDG_DATA_HOME/ccx/<readable>/`) and into `git config`'s value; permissive validation would let a typo like `--name "../other"` silently relocate state to a sibling directory or break the resolver entirely.
- `--name=<readable>` — accepted equivalently to `--name <readable>` so the flag matches the conventions used by `/ccx:loop --worktree=NAME`.
- Anything else (positional text, unknown flags) is rejected with a usage message.

## What this does

1. Verifies the caller is inside a git repository (`git rev-parse --show-toplevel`).
2. Parses `--name <readable>` from the arguments; fails fast on missing or invalid values.
3. Writes the override to **local repo config** via `git config --local ccx.link <readable>`. Local scope, NOT `--global` — the override is per-repo by design (linking is "I, on this clone, want a readable name for this state path"; a global link would either collide across repos or be meaningless). Existing values are overwritten without prompting (the operator typed `/ccx:link --name X`; they meant it).
4. Prints a one-line confirmation showing the resolved path with the new key: `linked: <STATE_DIR>` (re-runs the same resolver `/ccx:where` uses, so the operator sees the effective post-link path before they look for state files there). Done — no further action.

## Rules

- **No file is created in the working tree.** The customer-mode invariants enforced by `ccx verify` (T-6) forbid ccx-owned files in `REPO_ROOT`; storing the link in a repo-root `.ccx-link` or similar would violate invariant 1. `git config --local` writes to `.git/config`, which is under the repo's git directory but not in the working tree — outside the diff git produces against any commit. (`.git/` is git's own metadata directory; even in a worktree it is not part of the staged content.)
- **Dogfood and link are independent.** Setting `ccx.link` while `ccx.dogfood = true` has no observable effect on `STATE_DIR` (the dogfood short-circuit in the resolver fires first and returns `REPO_ROOT/.ccx/`). `/ccx:link --name X` in a dogfood repo writes the config but the resolver ignores it — `/ccx:where` still reports `.ccx/`. This is intentional: dogfood mode is the legacy in-tree-state mode, and linking is an alias scheme for the *external* state path. The implementation does NOT refuse a link in dogfood mode (the operator may be preparing the repo to drop dogfood later), but the confirmation line surfaces the no-op explicitly so they're not surprised.
- **`$CCX_DATA_HOME` shadows the link too.** When `$CCX_DATA_HOME` is set, the resolver short-circuits before the `<repo-key>` derivation runs, so the link is dormant. `/ccx:link` writes the config either way — the override is per-repo state, not per-env-var; unsetting `$CCX_DATA_HOME` later restores the link's effect.
- **`/ccx:link` does not migrate existing state.** If `STATE_DIR` was previously `…/widgets-a3f9b2c/` and the operator runs `/ccx:link --name myproj`, the next supervisor run lands at `…/myproj/` — a fresh empty directory — and the old `widgets-a3f9b2c/` directory persists with its tasks, briefs, audit, etc. **The operator is responsible for moving state**, e.g. `mv "$OLD_STATE_DIR" "$NEW_STATE_DIR"` if they want to preserve history. The confirmation line names the new path; the operator can run `/ccx:where` after `/ccx:unlink` (in a separate shell) to confirm the old path. Auto-migration is rejected for the same reason `/ccx:plan`'s legacy-BOARD migration is rejected: silently relocating directories inside a slash command would surprise the operator and complicate recovery if the source path was wrong.

## Why not a repo-root file

The brief specifies "writes `<readable>` to a per-repo override file so future invocations resolve state at `$XDG_DATA_HOME/ccx/<readable>/`". A naive reading is "write a file at `<repo-root>/.ccx-link`" — but that file would land in the working tree, show up in `git status --porcelain`, and (under invariant 1) fail `ccx verify` as a ccx-owned file in the user's repo. The only way to keep the override per-repo AND off the working tree is `git config --local`, which writes to `.git/config` — same scope (per-clone), zero footprint on `git status` or `git ls-files`. The T-5 Decisions section endorses this: "Customer mode reads from `git config ccx.*`, not a repo-root ccx-owned file." Customer-mode invariant 1 holds.

## Steps

### Step 1 — parse and validate `$ARGUMENTS` in prose

Before running any bash, parse the user's slash-command arguments (`$ARGUMENTS`) as plain text and resolve `NAME`:

- Look for `--name <readable>` or `--name=<readable>`. The value is the new `<repo-key>` to write.
- Reject if `--name` is missing or its value is empty: STOP with `fatal: --name <readable> is required — usage: /ccx:link --name <readable>`.
- Reject any other tokens in `$ARGUMENTS`: STOP with `fatal: unexpected argument '<token>' — usage: /ccx:link --name <readable>`.
- **Validate the value against `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`** (1–63 chars; first char alphanumeric; remaining chars alphanumeric + `.` `_` `-`; no leading dot/dash; no slashes; no whitespace). STOP on validation failure with `fatal: --name must match [A-Za-z0-9][A-Za-z0-9._-]{0,62} (got: '<value>')`.

The parse + validation happen here in prose — explicitly NOT inside the bash block — because slash-command argument expansion is performed by Claude (the LLM), not by the shell. Letting bash re-tokenize `$ARGUMENTS` via `set -- $ARGUMENTS` would expose any shell metacharacters in user input to the shell's parser before validation could fire (`/ccx:link --name '$(rm -rf /)'` would otherwise execute the command substitution). The strict regex above precludes single quotes, dollar signs, backticks, and every other shell metacharacter, so once validation passes the value is safe to substitute as a single-quoted literal in Step 2.

### Step 2 — write the link

Run this bash block. Substitute the validated `NAME` from Step 1 inline as a single-quoted string (e.g. `NAME='myproj'`). The Step 1 regex guarantees no single quotes, dollar signs, backticks, semicolons, or other shell metacharacters appear in `NAME`, so the single-quote substitution cannot be broken out of.

```bash
set -eu
NAME='<INSERT validated --name value from Step 1>'

# Defense-in-depth re-validation. Step 1 already validated against the
# same regex; this re-check guards against an LLM substitution slip and
# is cheap. The case-glob mirrors `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`:
#   - empty            → reject (regex requires at least 1 char)
#   - first char is NOT [A-Za-z0-9]    → reject (covers `.`, `-`, `_`,
#     and every other leading non-alphanumeric)
#   - any later char outside [A-Za-z0-9._-]  → reject
# Three alternatives means any one match rejects.
case "$NAME" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "fatal: --name failed re-validation in bash: '$NAME' (must match [A-Za-z0-9][A-Za-z0-9._-]{0,62})" >&2
    exit 2
    ;;
esac
if [ "${#NAME}" -gt 63 ]; then
  echo "fatal: --name must be 63 characters or fewer (got ${#NAME} chars)" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:link must be run inside a git repository" >&2
  exit 1
}

# Pre-compute the post-link STATE_DIR WITHOUT writing the config yet, so
# the in-repo rejection below can refuse a misconfigured environment
# before any side effect lands. Validation only fires when the link would
# actually take effect (customer mode, no $CCX_DATA_HOME); shadowed
# scenarios are surfaced as no-op confirmations after the write.
DOGFOOD_FLAG="$(git config --local --get --type=bool ccx.dogfood 2>/dev/null || echo false)"
REPO_ROOT_DOGFOOD="${REPO_ROOT%/}/.ccx"

if [ -n "${CCX_DATA_HOME:-}" ]; then
  case "$CCX_DATA_HOME" in
    /*) PROPOSED_STATE_DIR="$CCX_DATA_HOME" ;;
    *)  PROPOSED_STATE_DIR="$PWD/$CCX_DATA_HOME" ;;
  esac
  PROPOSED_STATE_DIR="${PROPOSED_STATE_DIR%/}"
elif [ "$DOGFOOD_FLAG" = "true" ]; then
  PROPOSED_STATE_DIR="${REPO_ROOT%/}/.ccx"
else
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    BASE="${XDG_DATA_HOME%/}/ccx"
  else
    case "$(uname -s)" in
      Darwin) BASE="$HOME/Library/Application Support/ccx" ;;
      *)      BASE="$HOME/.local/share/ccx" ;;
    esac
  fi
  PROPOSED_STATE_DIR="${BASE}/${NAME}"
fi

# In-repo STATE_DIR rejection — mirrors supervisor.md and the other M9
# T-5 helpers. Fail BEFORE writing the config so /ccx:link never leaves
# the repo in a state the supervisor would refuse on its next run.
case "$PROPOSED_STATE_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    if [ "$DOGFOOD_FLAG" != "true" ]; then
      cat >&2 <<EOF
fatal: post-link STATE_DIR ($PROPOSED_STATE_DIR) would lie inside REPO_ROOT but 'git config ccx.dogfood' is not true.
Customer-mode invariant 1 forbids ccx state in the working tree without an explicit dogfood opt-in.
The ccx.link override has NOT been written. Either: (a) unset \$CCX_DATA_HOME / point \$XDG_DATA_HOME outside REPO_ROOT,
or (b) set 'git config ccx.dogfood true' first if you actually want dogfood-mode commits to .ccx/.
EOF
      exit 3
    fi
    if [ "$PROPOSED_STATE_DIR" != "$REPO_ROOT_DOGFOOD" ]; then
      cat >&2 <<EOF
fatal: post-link STATE_DIR ($PROPOSED_STATE_DIR) would lie inside REPO_ROOT and ccx.dogfood is set, but it is not the
dogfood path $REPO_ROOT_DOGFOOD. The ccx.link override has NOT been written.
Unset \$CCX_DATA_HOME so the dogfood short-circuit returns REPO_ROOT/.ccx/, or point \$CCX_DATA_HOME at
$REPO_ROOT_DOGFOOD explicitly.
EOF
      exit 3
    fi
    ;;
esac

# Validation passed — write the override to .git/config (per-repo, not in
# the working tree).
git config --local ccx.link "$NAME"

# Surface the resolved path to the operator with a confirmation that
# distinguishes the active-link case from the shadowed-link cases.
if [ -n "${CCX_DATA_HOME:-}" ]; then
  printf 'linked (no effect — $CCX_DATA_HOME shadows ccx.link): %s/\n' "$PROPOSED_STATE_DIR"
elif [ "$DOGFOOD_FLAG" = "true" ]; then
  printf 'linked (no effect — ccx.dogfood=true shadows ccx.link): %s/\n' "$PROPOSED_STATE_DIR"
else
  printf 'linked: %s/\n' "$PROPOSED_STATE_DIR"
fi
```

## Related

- `/ccx:unlink` — remove the override (reverts to the auto-derived `<repo-key>`).
- `/ccx:where` — confirm the resolved path after linking.
- `docs/supervisor-design.md` §18.3 — `<repo-key>` derivation; §18.4 — `git config` keys.
