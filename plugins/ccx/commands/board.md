---
description: "Open the resolved STATE_DIR/BOARD.md in $EDITOR (falls back to cat if $EDITOR is unset)."
argument-hint: ""
allowed-tools: Bash, Read
---

# /ccx:board — Inspect BOARD.md at the resolved STATE_DIR

Inspection helper. `BOARD.md` lives outside the working tree (`$XDG_DATA_HOME/ccx/<repo-key>/BOARD.md`), so the usual `vim BOARD.md` no longer finds it. `/ccx:board` resolves the path and opens it.

## What this does

1. Runs the State path resolver (same algorithm as `/ccx:where` — see `plugins/ccx/commands/supervisor.md` → "State path resolver" for the SSOT) to compute `STATE_DIR`.
2. Computes `BOARD_PATH = STATE_DIR/BOARD.md` (absolute).
3. If `BOARD_PATH` does not exist, reports the absence and exits non-zero with a pointer to `/ccx:plan`.
4. If `$EDITOR` is set, spawns `$EDITOR "$BOARD_PATH"` (the editor's stdin/stdout/stderr are inherited from the Bash tool's session). On editor exit, the command returns.
5. If `$EDITOR` is empty or unset, prints the resolved path on the first line and then `cat`s the file to stdout.

## Rules

- **No state mutation.** This helper never edits `BOARD.md` itself — it only delegates to `$EDITOR` (whose mutations are the user's responsibility) or reads the file. It also never creates `BOARD.md`; if it's missing, the helper tells the user to run `/ccx:plan` and exits.
- **`$EDITOR` is whatever the user set.** No fallback chain to `vim` / `nano` / `vi` — those would mask a user's intentional choice to leave `$EDITOR` unset (in which case the `cat` fallback is the correct behaviour). Operators who want a deterministic editor should set `$EDITOR` in their shell rc.
- **Single-line path echo before `cat`.** When the fallback fires, the first line of stdout is `# BOARD: <BOARD_PATH>` so a user piping `/ccx:board | head -1` learns where the file lives even without `$EDITOR`.

## Steps

```bash
set -eu
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:board must be run inside a git repository" >&2
  exit 1
}

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

BOARD_PATH="${STATE_DIR%/}/BOARD.md"
if [ ! -f "$BOARD_PATH" ]; then
  cat >&2 <<EOF
BOARD.md not found at: $BOARD_PATH

Run '/ccx:plan "<task description>"' or '/ccx:plan --from <doc>' to seed
the BOARD. If you expected a BOARD to already exist here, double-check
'/ccx:where' and the resolver inputs (\$CCX_DATA_HOME, \$XDG_DATA_HOME).
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
- `docs/supervisor-design.md` §18 — where the BOARD lives.
