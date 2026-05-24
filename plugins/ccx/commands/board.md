---
description: "Open the resolved STATE_DIR/BOARD.md in $EDITOR (falls back to cat if $EDITOR is unset)."
argument-hint: ""
allowed-tools: Bash, Read
---

# /ccx:board — Inspect BOARD.md at the resolved STATE_DIR

Inspection helper introduced in M9 T-5. In customer mode `BOARD.md` lives outside the working tree (`$XDG_DATA_HOME/ccx/<repo-key>/BOARD.md`), so the usual `vim BOARD.md` no longer finds it. `/ccx:board` resolves the path and opens it.

## What this does

1. Runs the State path resolver (same algorithm as `/ccx:where` — see `plugins/ccx/commands/supervisor.md` → "State path resolver" for the SSOT) to compute `STATE_DIR`.
2. Computes `BOARD_PATH = STATE_DIR/BOARD.md` (absolute).
3. If `BOARD_PATH` does not exist, reports the absence and exits non-zero with a pointer to `/ccx:plan`.
4. If `$EDITOR` is set, spawns `$EDITOR "$BOARD_PATH"` (the editor's stdin/stdout/stderr are inherited from the Bash tool's session). On editor exit, the command returns.
5. If `$EDITOR` is empty or unset, prints the resolved path on the first line and then `cat`s the file to stdout.

## Rules

- **No state mutation.** This helper never edits `BOARD.md` itself — it only delegates to `$EDITOR` (whose mutations are the user's responsibility) or reads the file. It also never creates `BOARD.md`; if it's missing, the helper tells the user to run `/ccx:plan` and exits.
- **`$EDITOR` is whatever the user set.** No fallback chain to `vim` / `nano` / `vi` — those would mask a user's intentional choice to leave `$EDITOR` unset (in which case the `cat` fallback is the correct behaviour). Operators who want a deterministic editor should set `$EDITOR` in their shell rc.
- **In dogfood mode, BOARD is in-tree and git-tracked.** A `$EDITOR` invocation that saves dirties the working tree — the operator must commit (or stash) before `/ccx:supervisor`'s clean-tree gate fires. Customer mode is exempt because the BOARD lives outside the worktree and is not under git.
- **Single-line path echo before `cat`.** When the fallback fires, the first line of stdout is `# BOARD: <BOARD_PATH>` so a user piping `/ccx:board | head -1` learns where the file lives even without `$EDITOR`.

## Steps

```bash
set -eu
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:board must be run inside a git repository" >&2
  exit 1
}
DOGFOOD_FLAG="$(git config --local --get --type=bool ccx.dogfood 2>/dev/null || echo false)"
LINK_NAME="$(git config --local --get ccx.link 2>/dev/null || true)"

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
  if [ -n "$LINK_NAME" ]; then
    REPO_KEY="$LINK_NAME"
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

# In-repo STATE_DIR rejection — mirror supervisor.md "In-repo STATE_DIR
# requires explicit dogfood opt-in". Keeps the inspection helpers from
# pointing $EDITOR at state files the supervisor would refuse to touch.
STATE_DIR_NORM="${STATE_DIR%/}"
REPO_ROOT_DOGFOOD="${REPO_ROOT%/}/.ccx"
case "$STATE_DIR_NORM" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    if [ "$DOGFOOD_FLAG" != "true" ]; then
      cat >&2 <<EOF
fatal: STATE_DIR ($STATE_DIR_NORM) lies inside REPO_ROOT but 'git config ccx.dogfood' is not true.
Customer-mode invariant 1 forbids ccx state in the working tree without an explicit dogfood opt-in.
Either: (a) unset \$CCX_DATA_HOME (so the resolver picks an out-of-tree path), (b) point
\$CCX_DATA_HOME at a directory outside REPO_ROOT (e.g. /tmp/ccx-test), or (c) set
'git config ccx.dogfood true' if you actually want dogfood-mode commits to .ccx/.
EOF
      exit 3
    fi
    if [ "$STATE_DIR_NORM" != "$REPO_ROOT_DOGFOOD" ]; then
      cat >&2 <<EOF
fatal: STATE_DIR ($STATE_DIR_NORM) lies inside REPO_ROOT and ccx.dogfood is set, but STATE_DIR is
not the dogfood path $REPO_ROOT_DOGFOOD. Unset \$CCX_DATA_HOME so the dogfood short-circuit returns
REPO_ROOT/.ccx/, or point \$CCX_DATA_HOME at $REPO_ROOT_DOGFOOD explicitly.
EOF
      exit 3
    fi
    ;;
esac

BOARD_PATH="${STATE_DIR%/}/BOARD.md"
if [ ! -f "$BOARD_PATH" ]; then
  cat >&2 <<EOF
BOARD.md not found at: $BOARD_PATH

Run '/ccx:plan "<task description>"' or '/ccx:plan --from <doc>' to seed
the BOARD. If you expected a BOARD to already exist here, double-check
'/ccx:where' and the resolver inputs ('git config ccx.dogfood',
'git config ccx.link', \$CCX_DATA_HOME, \$XDG_DATA_HOME).
EOF
  exit 2
fi

if [ -n "${EDITOR:-}" ]; then
  # shellcheck disable=SC2086
  exec $EDITOR "$BOARD_PATH"
else
  printf '# BOARD: %s\n' "$BOARD_PATH"
  cat "$BOARD_PATH"
fi
```

## Notes

- If `$EDITOR` is a multi-word command (e.g. `code --wait`), the unquoted `$EDITOR` expansion above passes the words as separate `argv` entries to `exec`, which is the standard convention shells use for `$EDITOR`. Quoting it (`exec "$EDITOR" …`) would break that case by treating the whole string as one argv entry. The shellcheck disable on that line documents the intentional unquoting.
- The `exec` replaces the bash process with the editor, so its exit status flows back to the caller cleanly. The `cat` fallback runs in-process because there is nothing to wait for.

## Related

- `/ccx:where` — print the resolved `STATE_DIR` (one line, no file open).
- `/ccx:tasks` — list task briefs under `STATE_DIR/tasks/`.
- `/ccx:plan` — seeds `BOARD.md` at the resolved path. Run this first if `/ccx:board` reports the file missing.
- `docs/supervisor-design.md` §18.6 — where the BOARD lives in customer vs dogfood mode.
