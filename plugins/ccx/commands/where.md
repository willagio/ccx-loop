---
description: "Print the resolved ccx STATE_DIR path for the current repository. One line, stdout."
argument-hint: ""
allowed-tools: Bash
---

# /ccx:where — Print resolved STATE_DIR

Inspection helper introduced in M9 T-5. The external state directory is invisible by design (customer-mode invariant 1 — no `.ccx/` in the working tree), so the operator needs a way to find it without memorising the resolver rules. `/ccx:where` answers that one question — "where does ccx put its state for this repo?" — in one line of stdout, with no side effects.

## What this does

1. Runs the State path resolver from `plugins/ccx/commands/supervisor.md` (SSOT — see "State path resolver" section in that file, and `docs/supervisor-design.md` §18.2 for the algorithm; this helper inlines the same algorithm so it works without a running supervisor).
2. Prints the resolved `STATE_DIR` to stdout, with a trailing `/`.
3. Exits 0 on success, non-zero on any resolver failure (not inside a git repo, dogfood-flag/STATE_DIR inconsistency, etc.).

## Rules

- **Pure inspection.** No `mkdir`, no `git config` write, no file Read/Write/Edit. The resolver's first-access side effect (`mkdir -p STATE_DIR/{tasks,workers,supervisor-audit}` + the `ccx state:` stderr line) is the supervisor's contract, not this helper's — `/ccx:where` MUST NOT materialise directories. A user who runs `/ccx:where` from inside a fresh-cloned repo gets the path it WILL land on, not a side-effect directory creation.
- **Single source of truth.** The resolver block below mirrors `supervisor.md` → "State path resolver". If the algorithm changes there, mirror the change here verbatim (the inlined logic is for offline use without a supervisor session; the SSOT lives in supervisor.md).
- **Trailing slash.** The output ends in `/` so the user can copy-paste the path into other commands (`ls`, `cd`, etc.) and have it unambiguously refer to a directory.
- **No tty assumption.** stdout is the only output channel. No prompts, no spinners, no progress bars — `/ccx:where` is intended to be usable from `claude -p` and from shell pipelines (`cd "$(claude -p '/ccx:where' | tail -1)"` for an aggressive operator who shells through Claude).

## Steps

Run this one Bash command exactly. Report its stdout as the answer.

```bash
set -eu
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:where must be run inside a git repository" >&2
  exit 1
}
DOGFOOD_FLAG="$(git config --local --get --type=bool ccx.dogfood 2>/dev/null || echo false)"
LINK_NAME="$(git config --local --get ccx.link 2>/dev/null || true)"

# Portable sha256-7 over a string. Linux ships sha256sum; macOS ships shasum.
sha7() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-7
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-7
  fi
}

# Resolution algorithm — mirrors supervisor.md "State path resolver".
# First match wins; evaluate top-to-bottom.
if [ -n "${CCX_DATA_HOME:-}" ]; then
  # 1. $CCX_DATA_HOME override — no <repo-key> suffix.
  case "$CCX_DATA_HOME" in
    /*) STATE_DIR="$CCX_DATA_HOME" ;;
    *)  STATE_DIR="$PWD/$CCX_DATA_HOME" ;;
  esac
  STATE_DIR="${STATE_DIR%/}"
elif [ "$DOGFOOD_FLAG" = "true" ]; then
  # 2. Dogfood short-circuit.
  STATE_DIR="${REPO_ROOT%/}/.ccx"
else
  # 3+4. Customer mode — <base>/<repo-key>.
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
# requires explicit dogfood opt-in". The helpers MUST agree with the
# supervisor's resolver; otherwise `/ccx:where` could confirm a path the
# supervisor would refuse on the next run, and `/ccx:board` / `/ccx:tasks`
# would inspect or edit in-tree state that customer mode forbids.
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

# Always emit with a trailing slash so callers can paste into ls/cd.
printf '%s/\n' "${STATE_DIR%/}"
```

## Expected output examples

- In this repo with `ccx.dogfood = true`:
  ```
  /home/will/Repositories/ccx-loop/.ccx/
  ```
- In a fresh customer-mode clone of a repo with `origin = git@github.com:acme/widgets.git`:
  ```
  /home/will/.local/share/ccx/widgets-a3f9b2c/
  ```
- After `/ccx:link --name myproj`:
  ```
  /home/will/.local/share/ccx/myproj/
  ```
- With `CCX_DATA_HOME=/tmp/ccx-test`:
  ```
  /tmp/ccx-test/
  ```

## Related

- `/ccx:board` — opens `STATE_DIR/BOARD.md` in `$EDITOR` (falls back to `cat`).
- `/ccx:tasks` — lists task briefs under `STATE_DIR/tasks/`.
- `/ccx:link` / `/ccx:unlink` — manage a per-repo readable override that replaces the auto-derived `<repo-key>`.
- `docs/supervisor-design.md` §18 — algorithm SSOT.
