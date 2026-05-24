---
description: "List task briefs under STATE_DIR/tasks/ with their BOARD status. --status filters by status."
argument-hint: "[--status <draft|pending|assigned|review|merged|blocked|...>]"
allowed-tools: Bash
---

# /ccx:tasks — List tasks at the resolved STATE_DIR

Inspection helper introduced in M9 T-5. The supervisor's per-task briefs live at `STATE_DIR/tasks/T-<id>.md` and the queue+status of those tasks lives in `STATE_DIR/BOARD.md`. `/ccx:tasks` joins the two and prints one line per task — handy for "what's queued" / "what's in review" / "what's blocked" without opening BOARD in an editor.

## Argument Parsing

- `--status <value>` — filter to rows whose `status:` equals `<value>` exactly. Common values: `draft`, `pending`, `assigned`, `review`, `merged`, `blocked` (terminal-blocked, with sub-reasons in `exit_status`). Unknown statuses are accepted — the filter is a string-equality check, not an enum — so a future status the supervisor introduces still works without an update here.
- No positional task description. Anything else on the line is ignored with a warning.

## What this does

1. Runs the State path resolver (same algorithm as `/ccx:where`; SSOT: `plugins/ccx/commands/supervisor.md` → "State path resolver") to compute `STATE_DIR`.
2. Enumerates `T-*.md` files under `STATE_DIR/tasks/` — these are the supervisor-authored briefs. The set is sorted by numeric task id (`T-1`, `T-2`, …, `T-10`, `T-11` — not lexicographic, so `T-10` does not sort before `T-2`).
3. For each brief, looks up the matching row in `STATE_DIR/BOARD.md` to read `status:` and `title:`. Briefs without a matching BOARD row are surfaced as `status: ORPHAN` (an inconsistency the operator should investigate — usually a manual delete from BOARD that left the brief behind).
4. If `--status <value>` was supplied, drops rows whose status does not match.
5. Prints one line per remaining row: `T-<id>  <status>  <title>`. Column-aligned with two spaces, no fancy formatting.
6. Trailing summary line: `<N> task(s) listed` — useful when the filter trims everything to zero (a non-zero exit would be wrong; an empty filter result is normal).

## Rules

- **Read-only.** No edits to BOARD or briefs, no `mkdir`. If neither `STATE_DIR/BOARD.md` nor any `STATE_DIR/tasks/T-*.md` exists, report `no tasks (…)` and exit 0.
- **BOARD is the source of truth.** The supervisor only materialises `STATE_DIR/tasks/T-<id>.md` AT DISPATCH TIME — after `/ccx:plan` but before `/ccx:supervisor`, BOARD has rows (`status: draft` or `pending`) but the tasks/ directory is empty. The helper enumerates BOARD rows, then annotates each with a `*`-mark if the corresponding brief file does not exist on disk. Pre-dispatch rows show `*` markers and `status: draft|pending`; post-dispatch rows show ` ` markers and downstream statuses (`assigned`, `review`, `merged`, `blocked`, …).
- **Orphan brief files surface as ORPHAN rows.** A `T-<id>.md` file in `STATE_DIR/tasks/` without a matching BOARD row is appended to the listing with `status: ORPHAN` and the title `(brief file present, no BOARD row)`. These rows participate in the `--status` filter normally, so `/ccx:tasks --status ORPHAN` enumerates exactly the drift set.
- **YAML parsing in awk.** BOARD.md's `## Tasks` YAML block has a stable shape — `- id: T-N` at column 0, then key/value pairs indented two spaces. Awk-based extraction is sufficient and dodges a python dependency. If the awk parse misses a row (irregular indentation, multi-line title scalars), surface `status: ?` for that row rather than crashing — `/ccx:tasks` is an inspection tool, not a validator.
- **Numeric sort.** Brief filenames sort lexicographically by default (`T-10.md` before `T-2.md`); a single `sort -t- -k2 -n` pipe restores numeric order so the output reads naturally. Orphan rows append after the BOARD-ordered set rather than being numerically interleaved — a strict numeric merge would scatter orphans throughout the listing and bury the drift signal.

## Steps

### Step 1 — parse `$ARGUMENTS` in prose

Before running any bash, parse the user's slash-command arguments (`$ARGUMENTS`) as plain text and resolve `FILTER_STATUS`:

- Look for `--status <value>` or `--status=<value>`. The value is the status name to filter on. If absent, `FILTER_STATUS` is empty (no filter).
- Validate the extracted value against `^[A-Za-z0-9_-]+$`. The strict charset is required because Step 2 substitutes the value into a shell-quoted bash variable; permitting whitespace, `'`, `$`, backticks, or `;` would either break the substitution or open shell-injection vectors via user input.
- Reject any other tokens in `$ARGUMENTS` with a clear `warning: ignoring unrecognized argument '<token>'` line so the operator notices a typo.
- If `--status` is supplied without a value, treat it as a usage error: STOP with `fatal: --status requires a value (got nothing)`.

The parse happens here in prose — explicitly NOT inside the bash block — because slash-command argument expansion is performed by Claude (the LLM driving this command), not by the shell. Letting bash re-tokenize `$ARGUMENTS` via `set -- $ARGUMENTS` would expose any shell metacharacters in user input to the shell's parser before Step 2's validation can fire (`/ccx:tasks --status '$(rm -rf /)'` would otherwise execute the command substitution).

### Step 2 — list tasks

Run this bash block. Substitute the resolved `FILTER_STATUS` value from Step 1 inline as a single-quoted string (e.g. `FILTER_STATUS='pending'` or `FILTER_STATUS=''` for no filter). The Step 1 validation guarantees the value contains no single quotes or shell metacharacters, so the single-quote substitution is safe.

```bash
set -eu
FILTER_STATUS='<INSERT validated --status value from Step 1, or empty string>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "fatal: /ccx:tasks must be run inside a git repository" >&2
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
# listing state files the supervisor would refuse to touch.
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

TASKS_DIR="${STATE_DIR%/}/tasks"
BOARD_PATH="${STATE_DIR%/}/BOARD.md"

# FILTER_STATUS was resolved in Step 1 above and substituted into the
# single-quoted literal at the top of this script. No further parsing of
# user input happens in bash — the validated value is already in scope.

# Source of truth = BOARD.md. The supervisor only materialises a brief
# file at $TASKS_DIR/T-<id>.md AT DISPATCH TIME (supervisor.md Step A
# step 3), so a freshly-planned BOARD has rows with no corresponding
# files yet. /ccx:tasks must reflect the post-/ccx:plan state (draft +
# pending rows that have not been dispatched yet), so BOARD wins and the
# tasks/ directory is consulted only to surface the "brief file exists?"
# signal alongside each row.
# Parse the BOARD '## Tasks' YAML block once when the file is present.
# When BOARD.md is missing (deleted, not migrated from pre-M9, or never
# seeded), do NOT early-exit — the orphan-brief scan below still has
# something useful to surface in that case, and hiding it would defeat
# the helper's drift-inspection purpose. BOARD_ROWS stays empty; the
# all-empty check after orphan collection prints the canonical
# diagnostic.
BOARD_ROWS=""
BOARD_MISSING=0
if [ ! -f "$BOARD_PATH" ]; then
  BOARD_MISSING=1
else
# Parse the BOARD '## Tasks' YAML block once. Emit one TSV row per task:
# <id>\t<status>\t<title>. Sorted numerically by the id's integer suffix
# so T-2 lists before T-10.
BOARD_ROWS="$(
  awk '
    /^## Tasks/ { in_tasks=1; next }
    /^## / && in_tasks { in_tasks=0 }
    !in_tasks { next }
    /^- id:[[:space:]]*T-[0-9]+/ {
      sub(/^- id:[[:space:]]*/, "")
      cur=$0; sub(/[[:space:]].*$/, "", cur)
      rec[cur]=""
      next
    }
    cur != "" && /^[[:space:]]*status:[[:space:]]*/ {
      v=$0; sub(/^[[:space:]]*status:[[:space:]]*/, "", v)
      rec[cur]=rec[cur]"status="v"\n"
      next
    }
    cur != "" && /^[[:space:]]*title:[[:space:]]*/ {
      v=$0; sub(/^[[:space:]]*title:[[:space:]]*/, "", v)
      # Strip surrounding double quotes if present.
      if (substr(v,1,1)=="\"" && substr(v,length(v),1)=="\"") {
        v=substr(v,2,length(v)-2)
      }
      rec[cur]=rec[cur]"title="v"\n"
      next
    }
    END {
      for (id in rec) {
        st=""; ti=""
        n=split(rec[id], lines, "\n")
        for (i=1; i<=n; i++) {
          if (match(lines[i], /^status=/)) { st=substr(lines[i], 8) }
          else if (match(lines[i], /^title=/)) { ti=substr(lines[i], 7) }
        }
        if (st=="") st="?"
        if (ti=="") ti="(no title)"
        printf "%s\t%s\t%s\n", id, st, ti
      }
    }
  ' "$BOARD_PATH" \
    | awk -F '\t' '{ split($1, p, "-"); printf "%d\t%s\n", p[2], $0 }' \
    | sort -k1 -n \
    | cut -f2-
)"
fi

# An empty BOARD is tolerated here — orphan brief files below may still
# surface drift even when BOARD has no rows. The final empty-state check
# fires AFTER orphans are appended.

# Pre-compute the set of existing brief filenames as a `:T-1:T-2:…:`
# string so the awk pass can membership-test with `index()` rather than
# shelling out per row. The shell-out approach (`system("test -f …")`)
# is unsafe whenever $TASKS_DIR contains a space — the macOS default
# `~/Library/Application Support/ccx` does — because awk's system()
# passes its argument to /bin/sh -c without quoting, splitting the
# command at the space and reporting "no brief" for every row even when
# all of them exist. Avoiding the shell entirely sidesteps the issue.
EXISTING_BRIEFS=":"
if [ -d "$TASKS_DIR" ]; then
  EXISTING_BRIEFS=":$(
    find "$TASKS_DIR" -maxdepth 1 -type f -name 'T-*.md' 2>/dev/null \
      | sed -e 's#.*/##' -e 's#\.md$##' \
      | tr '\n' ':'
  )"
fi

# Append orphan brief files as synthetic ORPHAN-status rows in BOARD_ROWS
# so they participate in --status filtering uniformly. An "orphan" is a
# `T-<id>.md` file under $TASKS_DIR that has NO matching BOARD row;
# typically left behind when an operator removed a row by hand without
# `git rm`'ing the brief. Documented behaviour: surface them as
# `status: ORPHAN` so `/ccx:tasks --status ORPHAN` reports exactly the
# drift set. Note that no `*` marker is needed (every orphan by
# definition has a brief file on disk).
BOARD_ID_SET=":$(printf '%s\n' "$BOARD_ROWS" | awk -F '\t' 'NF >= 1 {printf "%s:", $1}')"
if [ -d "$TASKS_DIR" ]; then
  ALL_BRIEF_IDS="$(
    find "$TASKS_DIR" -maxdepth 1 -type f -name 'T-*.md' 2>/dev/null \
      | sed -e 's#.*/##' -e 's#\.md$##'
  )"
  for FID in $ALL_BRIEF_IDS; do
    case "$BOARD_ID_SET" in
      *":${FID}:"*) : ;;  # has BOARD row, skip
      *)
        ORPHAN_ROW="${FID}	ORPHAN	(brief file present, no BOARD row)"
        if [ -z "$BOARD_ROWS" ]; then
          BOARD_ROWS="$ORPHAN_ROW"
        else
          BOARD_ROWS="$(printf '%s\n%s' "$BOARD_ROWS" "$ORPHAN_ROW")"
        fi
        ;;
    esac
  done
fi

# If neither BOARD rows nor orphan briefs surfaced anything, exit early
# with the canonical empty-state diagnostic. Distinguish "BOARD missing"
# from "BOARD present but empty" so the operator knows which recovery
# step applies.
if [ -z "$BOARD_ROWS" ]; then
  if [ "$BOARD_MISSING" = "1" ]; then
    echo "no tasks (BOARD.md not found at $BOARD_PATH and no brief files under $TASKS_DIR — run /ccx:plan to seed task rows)"
  else
    echo "no tasks (BOARD.md has no '## Tasks' rows — edit it or run /ccx:plan --append)"
  fi
  exit 0
fi

# Apply --status filter to BOARD_ROWS first, then iterate. Doing the
# filter as an awk pass keeps the visible row set as a string variable
# (no subshell needed — a pipe-then-while-read loses state in POSIX sh).
# Also tag each row with the brief-existence marker so the print loop is
# straight-line. Output of this awk: "<MARK>\t<ID>\t<STATUS>\t<TITLE>\n".
FILTERED_ROWS="$(
  printf '%s\n' "$BOARD_ROWS" \
    | awk -F '\t' -v filter="$FILTER_STATUS" -v existing="$EXISTING_BRIEFS" '
        NF < 3 { next }
        {
          id=$1; status=$2; title=$3
          if (filter != "" && status != filter) next
          # Membership test against the pre-computed brief-id set.
          # `existing` is colon-delimited (":T-1:T-2:") so a substring
          # search with explicit `:` boundaries is unambiguous — `T-2`
          # would never match a prefix of `T-23`.
          if (index(existing, ":" id ":") > 0) mark=" "
          else mark="*"
          printf "%s\t%s\t%s\t%s\n", mark, id, status, title
        }
      '
)"

# Count rows survived after filtering. wc -l on empty input gives 0.
if [ -z "$FILTERED_ROWS" ]; then
  LISTED=0
else
  LISTED="$(printf '%s\n' "$FILTERED_ROWS" | wc -l | tr -d ' ')"
fi

# Emit one line per filtered row. printf with %s preserves spaces inside
# titles; cut -f extracts fields.
printf '%s\n' "$FILTERED_ROWS" | while IFS=$'\t' read -r MARK ID STATUS TITLE; do
  [ -z "$ID" ] && continue
  printf '%s%s %-10s  %s\n' "$MARK" "$ID" "$STATUS" "$TITLE"
done

printf '\n%s task(s) listed' "$LISTED"
if [ -n "$FILTER_STATUS" ]; then
  printf ' (filter: status=%s)' "$FILTER_STATUS"
fi
printf '\n(rows marked "*" have no brief file yet — supervisor creates briefs at dispatch time)\n'
```

The `FILTER_STATUS` placeholder at the top of the bash block above is filled by Step 1's prose parser — Claude substitutes the validated `--status` value (or an empty string when the flag is absent). The bash block itself performs NO argument parsing; passing `$ARGUMENTS` through unparsed would re-introduce the shell-expansion risk that motivated the prose-first design (see Step 1's "explicitly NOT inside the bash block" paragraph).

## Expected output examples

```
$ /ccx:tasks
 T-1  merged      M9: external state directory — relocate .ccx/ to $XDG_DATA_HOME/ccx/<key>/
 T-2  merged      M9: external worktrees — git worktree add under $STATE/worktrees/
 T-3  merged      M9: commit message hygiene — style mirror + marker strip
 T-4  merged      M9: merge strategy — squash default + branch cleanup
 T-5  assigned    M9: inspection helpers + ccx.dogfood flag
*T-6  pending     M9: ccx verify (zero-footprint gate) + customer-mode README section

6 task(s) listed
(rows marked "*" have no brief file yet — supervisor creates briefs at dispatch time)
```

The leading column is the brief-file marker: a space means the supervisor has dispatched this task at least once and `STATE_DIR/tasks/T-<id>.md` exists on disk; a `*` means the row is in BOARD but no brief file has been materialised yet (the typical post-`/ccx:plan` state — rows are `draft`/`pending` but the supervisor hasn't created the brief at dispatch time).

```
$ /ccx:tasks --status pending
*T-6  pending     M9: ccx verify (zero-footprint gate) + customer-mode README section

1 task(s) listed (filter: status=pending)
(rows marked "*" have no brief file yet — supervisor creates briefs at dispatch time)
```

After `/ccx:plan` on a fresh repo (no supervisor run yet), every row carries `*`:

```
$ /ccx:tasks
*T-1  draft       Add OAuth2 login flow
*T-2  draft       Refactor session storage
*T-3  draft       Add audit log retention

3 task(s) listed
(rows marked "*" have no brief file yet — supervisor creates briefs at dispatch time)
```

An orphan brief (a `T-<id>.md` file under `STATE_DIR/tasks/` with no matching BOARD row) is appended to the listing as a synthetic `ORPHAN`-status row, filterable via `--status ORPHAN`:

```
$ /ccx:tasks --status ORPHAN
 T-99 ORPHAN      (brief file present, no BOARD row)

1 task(s) listed (filter: status=ORPHAN)
(rows marked "*" have no brief file yet — supervisor creates briefs at dispatch time)
```

## Related

- `/ccx:where` — print the resolved `STATE_DIR` (one line, no enumeration).
- `/ccx:board` — open `BOARD.md` in `$EDITOR` to edit a task row's status, scope, or notes.
- `docs/supervisor-design.md` §6.1 — brief file schema (the fields surfaced here).
