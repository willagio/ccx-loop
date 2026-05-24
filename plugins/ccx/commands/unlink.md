---
description: "Remove the per-repo ccx.link override (reverts STATE_DIR's <repo-key> to the auto-derived value)."
argument-hint: ""
allowed-tools: Bash
---

# /ccx:unlink — Remove the ccx.link override

Inspection-surface helper introduced in M9 T-5. Reverts a previous `/ccx:link --name <readable>` by unsetting `git config ccx.link`. The next resolver invocation falls back to the auto-derived `<repo-key>` (origin-URL hash, with a basename suffix; see `docs/supervisor-design.md` §18.3).

## Argument Parsing

- No flags. Anything on the line is rejected with a usage message.

## What this does

1. Verifies the caller is inside a git repository.
2. Reads the current `ccx.link` value with `git config --local --get ccx.link` (local-scope only — `/ccx:link` writes with `--local`, and global/system inheritance is explicitly NOT honoured for any ccx.* key per `docs/supervisor-design.md` §18.4). If unset, exits with a message confirming the no-op — running `/ccx:unlink` twice is harmless.
3. Runs `git config --local --unset ccx.link`. Local scope, matching where `/ccx:link` wrote.
4. Re-runs the resolver and prints the now-effective path so the operator can see where state will land going forward.

## Rules

- **Idempotent.** `/ccx:unlink` on a repo with no link is a no-op exit 0 with `no ccx.link override set — nothing to unlink`. Treating the absence as an error would punish operators who script `/ccx:unlink` defensively before some other operation.
- **State is NOT moved.** Removing the override does not migrate the previously-linked state directory back to the auto-derived one. The operator who wants to preserve history must `mv` the directory themselves; `/ccx:unlink` only flips the resolver's output. The confirmation line surfaces the new path so they can decide whether to move state. (Same rationale as `/ccx:link`'s "does not migrate" rule — see `plugins/ccx/commands/link.md`.)
- **No effect on `ccx.dogfood`.** Unlinking does NOT touch `ccx.dogfood`, `ccx.merge.strategy`, `ccx.commit.trailer`, or `ccx.paranoid`. The link is a single, separable knob.
- **`.git/config` is not under the working tree.** Like `/ccx:link`, `/ccx:unlink` only edits `.git/config`. `git status --porcelain` is unaffected — no commit, no diff, no `git add` needed.

## Steps

### Step 1 — verify `$ARGUMENTS` is empty in prose

Before running any bash, inspect the user's slash-command arguments (`$ARGUMENTS`):

- If `$ARGUMENTS` contains any non-whitespace tokens, STOP with `fatal: /ccx:unlink takes no arguments (got: <tokens>) — usage: /ccx:unlink`.
- Otherwise proceed to Step 2.

The check happens here in prose — explicitly NOT inside the bash block — because slash-command argument expansion is performed by Claude (the LLM), not by the shell. Letting bash re-tokenize `$ARGUMENTS` via `set -- $ARGUMENTS` would expose any shell metacharacters in user input to the shell's parser before the empty-check could fire. `/ccx:unlink` accepts no arguments at all, so the bash block carries no user-derived values.

### Step 2 — unset the link

Run this bash block. No user-derived substitutions are required.

```bash
set -eu
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:unlink must be run inside a git repository" >&2
  exit 1
}

CURRENT="$(git config --local --get ccx.link 2>/dev/null || true)"
if [ -z "$CURRENT" ]; then
  echo "no ccx.link override set — nothing to unlink"
  exit 0
fi

# Try to unset, then verify by re-reading. Git's `--unset` exit codes
# are unreliable in isolation: exit 5 can mean either "key absent
# (idempotent success)" OR "multiple matching values (unset declined)"
# and the stderr warnings only distinguish the two textually. Instead,
# observe the post-unset state directly — if the key is gone, the unset
# achieved its goal regardless of which path it took; if it is still set,
# something failed (lock contention, read-only config, multi-value
# refusal, etc.) and we must NOT report success.
ERR_FILE="$(mktemp -t ccx-unlink-err.XXXXXX 2>/dev/null || mktemp 2>/dev/null || echo "/tmp/ccx-unlink-err.$$")"
UNSET_RC=0
git config --local --unset ccx.link 2>"$ERR_FILE" || UNSET_RC=$?

POST_VALUE="$(git config --local --get ccx.link 2>/dev/null || true)"
if [ -n "$POST_VALUE" ]; then
  echo "fatal: git config --local --unset ccx.link did not remove the key" >&2
  echo "       exit=$UNSET_RC, current value still resolves to: $POST_VALUE" >&2
  if [ -s "$ERR_FILE" ]; then
    echo "       git stderr:" >&2
    sed 's/^/         /' "$ERR_FILE" >&2
  fi
  cat >&2 <<EOF
Common causes: another process holds .git/config.lock, the file is read-only, or the key
has multiple matching values (resolve manually with 'git config --local --unset-all ccx.link').
EOF
  rm -f "$ERR_FILE"
  exit 4
fi
rm -f "$ERR_FILE"

# Re-resolve STATE_DIR with the link gone and surface the new path so the
# operator sees where state will land going forward.
DOGFOOD_FLAG="$(git config --local --get --type=bool ccx.dogfood 2>/dev/null || echo false)"

sha7() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-7
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-7
  fi
}

if [ -n "${CCX_DATA_HOME:-}" ]; then
  case "$CCX_DATA_HOME" in
    /*) STATE_DIR="$CCX_DATA_HOME" ;;
    *)  STATE_DIR="$PWD/$CCX_DATA_HOME" ;;
  esac
  STATE_DIR="${STATE_DIR%/}"
elif [ "$DOGFOOD_FLAG" = "true" ]; then
  STATE_DIR="${REPO_ROOT%/}/.ccx"
else
  BASENAME="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
  URL="$(git remote get-url origin 2>/dev/null || true)"
  if [ -z "$URL" ]; then
    FIRST_REMOTE="$(git remote 2>/dev/null | head -n1)"
    [ -n "$FIRST_REMOTE" ] && URL="$(git remote get-url "$FIRST_REMOTE" 2>/dev/null || true)"
  fi
  if [ -n "$URL" ]; then
    REPO_KEY="${BASENAME}-$(sha7 "$URL")"
  else
    RP="$(cd "$REPO_ROOT" && pwd -P)"
    REPO_KEY="${BASENAME}-local-$(sha7 "$RP")"
  fi
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    BASE="${XDG_DATA_HOME%/}/ccx"
  else
    case "$(uname -s)" in
      Darwin) BASE="$HOME/Library/Application Support/ccx" ;;
      *)      BASE="$HOME/.local/share/ccx" ;;
    esac
  fi
  STATE_DIR="${BASE}/${REPO_KEY}"
fi

# In-repo STATE_DIR rejection — mirrors supervisor.md and the other M9
# T-5 helpers. The unlink itself already happened (the user asked for it);
# this guard surfaces an environment problem the next supervisor run
# would hit, so the operator sees it now rather than later.
STATE_DIR_NORM="${STATE_DIR%/}"
REPO_ROOT_DOGFOOD="${REPO_ROOT%/}/.ccx"
case "$STATE_DIR_NORM" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    if [ "$DOGFOOD_FLAG" != "true" ]; then
      printf 'unlinked (was: %s). state now resolves to: %s/\n' "$CURRENT" "$STATE_DIR_NORM"
      cat >&2 <<EOF
warning: post-unlink STATE_DIR ($STATE_DIR_NORM) lies inside REPO_ROOT but 'git config ccx.dogfood' is not true.
Customer-mode invariant 1 forbids ccx state in the working tree without an explicit dogfood opt-in — the next
/ccx:supervisor / /ccx:plan run will STOP at the resolver. Either: (a) unset \$CCX_DATA_HOME / point
\$XDG_DATA_HOME outside REPO_ROOT, or (b) set 'git config ccx.dogfood true' if you actually want dogfood-mode
commits to .ccx/.
EOF
      exit 3
    fi
    if [ "$STATE_DIR_NORM" != "$REPO_ROOT_DOGFOOD" ]; then
      printf 'unlinked (was: %s). state now resolves to: %s/\n' "$CURRENT" "$STATE_DIR_NORM"
      cat >&2 <<EOF
warning: post-unlink STATE_DIR ($STATE_DIR_NORM) lies inside REPO_ROOT and ccx.dogfood is set, but it is not
the dogfood path $REPO_ROOT_DOGFOOD. Unset \$CCX_DATA_HOME so the dogfood short-circuit returns
REPO_ROOT/.ccx/, or point \$CCX_DATA_HOME at $REPO_ROOT_DOGFOOD explicitly.
EOF
      exit 3
    fi
    ;;
esac

printf 'unlinked (was: %s). state now resolves to: %s/\n' "$CURRENT" "${STATE_DIR%/}"
```

## Related

- `/ccx:link --name <readable>` — pin `<repo-key>` to a chosen string.
- `/ccx:where` — print the resolved `STATE_DIR` (one line).
- `docs/supervisor-design.md` §18.3 — `<repo-key>` derivation; §18.4 — `git config` keys.
