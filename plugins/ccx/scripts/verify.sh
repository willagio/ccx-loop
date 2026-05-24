#!/usr/bin/env bash
# ccx verify — M9 customer-mode contract enforcer.
#
# Checks the six M9 invariants and exits 0 on a clean repo. On any violation,
# exits with the LOWEST matching invariant code (10..15) and prints every
# violation line to stderr — so a supervisor calling this as a pre-merge gate
# can wire the full leak list into its M5 stuck-exit auto-revise prompt rather
# than only the first-failed invariant.
#
# Exit codes (1:1 with the M9 invariant numbering in docs/supervisor-design.md
# §18 / BOARD.md):
#   0  — clean (every invariant satisfied)
#   10 — invariant 1: .ccx/ present in the working tree
#   11 — invariant 2: .gitignore contains a ccx-related entry
#   12 — invariant 3: commit subject/body contains a ccx tooling marker
#   13 — invariant 4: mainline contains `Merge branch 'ccx/...'`
#   14 — invariant 5: a stale `ccx/T-*` branch ref survives
#   15 — invariant 6: ccx diff touches a protected path (.claude/, CLAUDE.md,
#                    .claude/settings.json, AGENTS.md)
#   2  — verifier itself could not run (not a git repo, bad inputs, etc.)
#
# Inputs (environment variables):
#   REPO                Repository root. Default: `git rev-parse --show-toplevel`
#                       from cwd.
#   BASE                Integration baseline ref (e.g. `main`, or the
#                       integration tip the supervisor is about to merge onto).
#                       Default: `HEAD` (manual /ccx:verify case).
#   TARGET_REF          Candidate worker ref being considered for merge.
#                       Default: `HEAD`. Pass empty for "no worker in flight"
#                       — invariants 3/4/6 then degrade to no-op (no range
#                       to scan), and invariant 5 flags every `ccx/T-*` ref.
#   CCX_DIFF_PATHS      Optional newline-separated diff path list (supervisor
#                       passes the worker/supervisor diff here). If unset
#                       and BASE/TARGET_REF are both non-empty, the script
#                       falls back to `git diff --name-only BASE...TARGET_REF`
#                       so manual invocation works.
#   CCX_PROPOSED_MSG    Optional proposed final commit message (the supervisor
#                       passes this for the squash strategy — the worker's
#                       final commit message that the squash will land
#                       verbatim). Scanned by invariant 3 in addition to
#                       every commit subject/body in BASE..TARGET_REF.
#   CCX_PROTECTED_OPTIN When set to `1`, invariant 6 is bypassed — the diff
#                       is allowed to touch .claude/, CLAUDE.md, etc. The
#                       opt-in is per-invocation (env var), NOT a persistent
#                       git config knob, so a careless flip can't silently
#                       disable invariant 6 across an operator's machine.
#   CCX_PEER_BRANCHES   Optional newline-separated list of `ccx/T-*`
#                       branches the supervisor wants exempted from
#                       invariant 5. The supervisor passes the UNION of
#                       (a) every other in-flight worker's branch (tasks
#                       in `RUNNING` other than the candidate) AND (b)
#                       every preserved-blocked task's branch (tasks in
#                       `BLOCKED_IDS` whose exit_status preserves the
#                       branch — `merge-conflict`, `merge-aborted`,
#                       `merge-commit-failed`, `leak-detected-at-merge`,
#                       `rebase-conflict`, `no-commit`, `error`, plus the
#                       §P2.5 attempts-exhausted / stuck-recovery-failed /
#                       stuck-cleanup-failed family). Without this exemption,
#                       a clean candidate from a `--parallel N>1` supervisor
#                       would be falsely classified as `leak-14` because:
#                         (a) sibling workers' still-running `ccx/T-*`
#                             branches counted as "stale", or
#                         (b) a prior blocked task's branch (intentionally
#                             preserved for human triage per the T-2/T-4
#                             contracts) counted as "stale" — and the
#                             worker driving the clean candidate cannot
#                             fix the supervisor's branch hygiene anyway,
#                             so an automatic retry would burn attempts
#                             with misleading leak guidance.
#
# Dogfood gate (`git -C "$REPO" config --local --get --type=bool ccx.dogfood`
# returning `true`) bypasses invariants 1, 2, 3, 4, and 6. Invariant 5 always
# runs — stale `ccx/T-*` branch refs are bad hygiene in either mode.

# Intentionally NOT using `set -e`: many checks use `grep` which exits 1 on
# "no match" (the success case here) and would otherwise abort the script.
# `set -u` is also off because we read many optional env vars; the
# `${VAR:-default}` idiom is used throughout to keep the surface tidy.

# --- Resolve REPO ----------------------------------------------------------
REPO="${REPO:-}"
if [ -z "$REPO" ]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "$REPO" ] || ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'ccx verify: REPO=%s is not a git repository\n' "${REPO:-<unset>}" 1>&2
  exit 2
fi

BASE="${BASE:-HEAD}"
# Use `${TARGET_REF-HEAD}` (no colon) so the default ONLY kicks in when
# TARGET_REF is unset. The contract above explicitly allows passing
# TARGET_REF="" for the "no worker in flight" audit case; the colon
# form `:-HEAD` would substitute HEAD when the value is empty too,
# silently turning a no-worker audit into a HEAD-vs-BASE diff scan
# and producing spurious invariant 3/4/6 hits from the current branch.
TARGET_REF="${TARGET_REF-HEAD}"
CCX_PROPOSED_MSG="${CCX_PROPOSED_MSG:-}"
CCX_PROTECTED_OPTIN="${CCX_PROTECTED_OPTIN:-0}"

# --- Ref validation --------------------------------------------------------
# Validate BASE and (when non-empty) TARGET_REF before any invariant check.
# Without this, a misspelled / deleted ref would cause `git log "$BASE..$TARGET_REF"`
# and `git diff "$BASE...$TARGET_REF"` to fail; the `|| true` suppression
# downstream would then silently treat the missing data as an empty range,
# letting invariants 3/4/6 pass with zero scan work and producing a false
# "verifier clean" exit. The supervisor's pre-merge gate could race a worker
# branch deletion and hit exactly this case — fail closed instead.
#
# Empty TARGET_REF is the documented "no worker in flight" audit mode (per
# the contract block above); skip its validation. BASE is always validated
# (an empty BASE makes no sense — `BASE..TARGET_REF` requires a non-empty
# left-hand revision).
if ! git -C "$REPO" rev-parse --verify -q "$BASE^{commit}" >/dev/null 2>&1; then
  printf 'ccx verify: BASE=%s is not a valid revision in REPO=%s\n' "$BASE" "$REPO" 1>&2
  exit 2
fi
if [ -n "$TARGET_REF" ] && ! git -C "$REPO" rev-parse --verify -q "$TARGET_REF^{commit}" >/dev/null 2>&1; then
  printf 'ccx verify: TARGET_REF=%s is not a valid revision in REPO=%s\n' "$TARGET_REF" "$REPO" 1>&2
  exit 2
fi

# --- Dogfood flag (per §18.4: --local only — never inherit globally) -------
IS_DOGFOOD="$(git -C "$REPO" config --local --get --type=bool ccx.dogfood 2>/dev/null || true)"
[ "$IS_DOGFOOD" = "true" ] || IS_DOGFOOD="false"

# Accumulator: each violation is "code|detail" on its own line. Newline-
# separated rather than a bash array so the script stays portable to /bin/sh-
# adjacent shells if anyone ever sources it under one.
VIOLATIONS=""

add_violation() {
  # $1 = numeric code; $2 = single-line detail string
  if [ -z "$VIOLATIONS" ]; then
    VIOLATIONS="$1|$2"
  else
    VIOLATIONS="$VIOLATIONS
$1|$2"
  fi
}

# --- Invariant 1: no .ccx/ in the working tree (unless dogfood) ------------
# Two-source check: (a) the integration checkout (manual /ccx:verify case
# and dirty-state audits — `$REPO/.ccx` / `$REPO/.ccx-config`), and (b)
# the candidate TARGET_REF's tree (pre-merge supervisor gate — the worker
# may have added these paths in commits that haven't landed on integration
# yet, so checking only the integration tree would let the leak slip
# through into the upcoming squash/rebase commit). The candidate-tree
# probe uses `git ls-tree` against TARGET_REF directly (no checkout
# required); a non-empty result means the path is in the candidate.
#
# Also rejects a top-level `.ccx-config` file: §18.4 documents it as the
# single dogfood-only filesystem exception (defaults file analogous to
# .editorconfig). In customer mode the file is itself a footprint — its
# presence reveals ccx adoption to anyone reading the repo root — and the
# T-3 writer side already refuses to create it; the verifier flags any
# legacy copy that survived a pre-M9 install AND any worker that newly
# adds it on a candidate branch.
if [ "$IS_DOGFOOD" != "true" ]; then
  CCX_FOUND_WHERE=""
  CCX_CONFIG_FOUND_WHERE=""
  if [ -d "$REPO/.ccx" ]; then
    CCX_FOUND_WHERE="\$REPO/.ccx/ (integration working tree)"
  fi
  if [ -e "$REPO/.ccx-config" ]; then
    CCX_CONFIG_FOUND_WHERE="\$REPO/.ccx-config (integration working tree)"
  fi
  # Candidate-tree probe — only when TARGET_REF resolves to a different
  # commit than the working-tree state (otherwise the integration check
  # above already covers it).
  if [ -n "$TARGET_REF" ]; then
    # `git ls-tree --name-only -- <path>` against TARGET_REF lists the
    # named paths if they exist as tree entries; absent paths produce
    # no output. -r (recursive) is NOT needed because we only care
    # about the top-level entries.
    CCX_IN_TARGET="$(git -C "$REPO" ls-tree --name-only "$TARGET_REF" -- .ccx 2>/dev/null || true)"
    if [ -n "$CCX_IN_TARGET" ] && [ -z "$CCX_FOUND_WHERE" ]; then
      CCX_FOUND_WHERE="$TARGET_REF:.ccx/ (candidate tree — leak introduced by the worker branch)"
    fi
    CFG_IN_TARGET="$(git -C "$REPO" ls-tree --name-only "$TARGET_REF" -- .ccx-config 2>/dev/null || true)"
    if [ -n "$CFG_IN_TARGET" ] && [ -z "$CCX_CONFIG_FOUND_WHERE" ]; then
      CCX_CONFIG_FOUND_WHERE="$TARGET_REF:.ccx-config (candidate tree — leak introduced by the worker branch)"
    fi
  fi
  if [ -n "$CCX_FOUND_WHERE" ]; then
    add_violation 10 "invariant 1 — $CCX_FOUND_WHERE (customer mode forbids ccx-owned files in the worktree; relocate to STATE_DIR per docs/supervisor-design.md §18.2 or set 'git config --local ccx.dogfood true' to opt into dogfood mode)"
  elif [ -n "$CCX_CONFIG_FOUND_WHERE" ]; then
    add_violation 10 "invariant 1 — $CCX_CONFIG_FOUND_WHERE (customer mode rejects this dogfood-only metadata file; delete it with 'git rm .ccx-config' or set 'git config --local ccx.dogfood true' to opt into dogfood mode)"
  fi
fi

# --- Invariant 2: .gitignore has no ccx entries (unless dogfood) -----------
# Matches every common shape a user might write to ignore `.ccx`:
#   .ccx           — bare top-level entry
#   .ccx/          — directory shape
#   .ccx/*         — wildcard shape
#   /.ccx, /.ccx/, /.ccx/*  — rooted shapes (anchored to repo root)
# The entry itself is a footprint (the customer wouldn't know what .ccx is
# without ccx having been installed), so customer-mode forbids it even
# though the absence of the directory means it would have no effect.
#
# Two-source check (same shape as invariant 1's two-source probe):
#   (a) the integration checkout — `$REPO/.gitignore` as it exists today
#   (b) the candidate TARGET_REF's blob — `git show $TARGET_REF:.gitignore`,
#       so a worker that adds a `.ccx/` line on its branch is caught BEFORE
#       the squash/rebase lands the change on mainline (which is what
#       invariant 2 is supposed to block).
# Pattern alternatives:
#   .ccx                     — bare directory entry
#   .ccx/                    — directory shape
#   .ccx/*                   — single-asterisk wildcard
#   .ccx/**                  — double-asterisk recursive glob (also a
#                              valid Git pattern that hides .ccx subtree)
#   .ccx-config              — the dogfood metadata file (legacy customers
#                              may have ignored it via .gitignore even
#                              though the correct customer-mode action is
#                              to delete it)
# A leading `/` is allowed for the rooted (anchored to repo root) shape
# of any of the above. Trailing whitespace is allowed because Git itself
# trims unescaped trailing whitespace from `.gitignore` lines — `.ccx/   `
# is the same rule as `.ccx/` to Git, so it has to be the same rule to
# the verifier. (Escaped trailing whitespace via `\ ` is a corner case
# we accept may slip through; it's not idiomatic and the leak is still
# caught by invariant 1's filesystem probe.)
GITIGNORE_PATTERN='^/?\.ccx(/(\*\*?)?|-config)?[[:space:]]*$'
GITIGNORE_HIT_WHERE=""
if [ "$IS_DOGFOOD" != "true" ]; then
  if [ -f "$REPO/.gitignore" ] && grep -E "$GITIGNORE_PATTERN" "$REPO/.gitignore" >/dev/null 2>&1; then
    GITIGNORE_HIT_WHERE="\$REPO/.gitignore (integration working tree)"
  fi
  if [ -z "$GITIGNORE_HIT_WHERE" ] && [ -n "$TARGET_REF" ]; then
    # `git show <ref>:<path>` exits non-zero (and emits an error to stderr)
    # when the path is absent in the ref's tree. We treat absent as "no
    # gitignore on the candidate — nothing to check"; only a successful
    # blob fetch with a matching pattern is a violation.
    TARGET_GITIGNORE="$(git -C "$REPO" show "$TARGET_REF:.gitignore" 2>/dev/null || true)"
    if [ -n "$TARGET_GITIGNORE" ] && \
       printf '%s\n' "$TARGET_GITIGNORE" | grep -E "$GITIGNORE_PATTERN" >/dev/null 2>&1; then
      GITIGNORE_HIT_WHERE="$TARGET_REF:.gitignore (candidate blob — entry introduced by the worker branch)"
    fi
  fi
fi
if [ -n "$GITIGNORE_HIT_WHERE" ]; then
  add_violation 11 "invariant 2 — $GITIGNORE_HIT_WHERE contains a ccx-related entry (the line is itself a customer-mode footprint; remove it per the README 'ccx migrate' section)"
fi

# --- Invariant 3: no ccx tooling markers in commit messages (unless dogfood)
# Scans every commit in BASE..TARGET_REF (subject + body) PLUS the optional
# proposed squash message, then the supervisor-passed proposed final message.
# The marker regex MUST stay in lockstep with the T-3 worker-side check and
# T-4 merge-boundary check in supervisor.md — any drift between writer and
# reader sides creates false-pass/false-fail asymmetry that the supervisor's
# auto-revise loop cannot escape.
#
# Implementation note: routes through a Python helper (same shape T-3/T-4
# already use on the writer side) instead of `grep -E` for two reasons:
#
#   (a) Negative look-behind for word boundaries — POSIX ERE has no
#       `\b` and the brief's `(^|[[:space:]])` shape falsely passes
#       markers preceded by punctuation (e.g. `fix (T-6)`,
#       `update 'ccx/T-3'`). Python's `(?<![A-Za-z0-9])` matches every
#       non-alphanumeric left boundary including punctuation, mirroring
#       supervisor.md's merge-boundary helper verbatim.
#
#   (b) Ccx-Task trailer validation — the opt-in `Ccx-Task: T-N` exception
#       only applies when (i) `git config --local ccx.commit.trailer true`
#       is set AND (ii) the line appears in an actual Git trailer block at
#       the tail of the commit message, not body-level prose that happens
#       to look trailer-shaped. A naive `grep -v '^Ccx-Task:'` strips
#       body-level lines too AND ignores the config gate, both of which
#       would silently false-pass invariant 3 leaks. The helper performs
#       the same two-pass trailer detection as supervisor.md's
#       merge-boundary trailer-strip (final blank-line-separated paragraph
#       whose lines all match `Key: value`, preceded by body content),
#       then strips Ccx-Task lines ONLY when both gates hold.
#
# Python is already required for the supervisor's writer-side hygiene
# pipeline (T-3 + T-4 merge-boundary check), so adding a Python branch
# here does not introduce a new runtime dependency on any installation
# where the supervisor actually runs the pre-merge gate. For /ccx:verify
# standalone (manual audit), Python 3 is assumed present alongside Git;
# if it is somehow missing, the helper exits non-zero and the calling
# bash treats that as a fatal verifier error (exit 2), surfaced to stderr
# — exactly the failure mode supervisor.md's hygiene helper documents.
if [ "$IS_DOGFOOD" != "true" ] && [ -n "$TARGET_REF" ] && [ -n "$BASE" ]; then
  RANGE_MSGS="$(git -C "$REPO" log --pretty='%s%n%b' "$BASE..$TARGET_REF" 2>/dev/null || true)"
  # ccx.commit.trailer governs whether `Ccx-Task: T-N` trailers are
  # tolerated. --local scope per §18.4 — no global / system inheritance.
  WANT_TRAILER="$(git -C "$REPO" config --local --get --type=bool ccx.commit.trailer 2>/dev/null || true)"
  [ "$WANT_TRAILER" = "true" ] || WANT_TRAILER="false"
  # Pack the proposed-message and the in-range messages into a single
  # NUL-separated stream so Python receives them as discrete messages.
  # A multi-message stream lets the helper apply trailer-block detection
  # per-message rather than treating the concatenation as one giant
  # message — body-level `Ccx-Task: T-N` lines in commit A would
  # otherwise be falsely treated as in-trailer if commit B's trailer
  # came right after.
  HELPER_INPUT_TMP="$(mktemp)" || {
    # mktemp failed — TMPDIR full / read-only / quota exceeded.
    # Treat as a verifier infrastructure failure (exit 2) rather than
    # silently passing the invariant 3 check, which would let a marker-
    # bearing commit slip past the gate.
    printf 'ccx verify: mktemp failed while preparing invariant 3 helper input — TMPDIR=%s is full or read-only\n' "${TMPDIR:-/tmp}" 1>&2
    exit 2
  }
  {
    if [ -n "$CCX_PROPOSED_MSG" ]; then
      printf '%s\0' "$CCX_PROPOSED_MSG"
    fi
    # Walk commits one-by-one so each becomes its own NUL-separated record.
    if [ -n "$RANGE_MSGS" ]; then
      git -C "$REPO" log --pretty=format:'%B' --reverse -z "$BASE..$TARGET_REF" 2>/dev/null || true
      # `git log -z` separates records with NUL; no trailing NUL added,
      # which is fine — Python's split('\0') handles the missing tail.
    fi
  } > "$HELPER_INPUT_TMP"
  # Capture the helper source into a variable so `python3 -c "$PY_CODE"`
  # gets the program text while stdin is free to receive the helper input
  # file. The naive shape `python3 - < FILE <<'PY' ... PY` has TWO stdin
  # redirections — the heredoc wins, so Python would read its own source
  # as the input data and silently produce empty output.
  PY_CODE=$(cat <<'PY'
import os, re, sys
want_trailer = os.environ.get("WANT_TRAILER", "false") == "true"
raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
# Drop trailing NUL if present so the final split doesn't produce an
# empty record.
if raw.endswith("\0"):
    raw = raw[:-1]
messages = raw.split("\0") if raw else []

# Trailer-block detection mirrors supervisor.md's merge-boundary
# trailer-split. A real trailer block is the final paragraph whose
# lines all match `Key: value`, preceded by a blank-line separator,
# with body content above. Body-level `Ccx-Task: T-N` lines stay
# visible to the marker regex regardless of ccx.commit.trailer.
trailer_key_re = re.compile(r"^[A-Za-z][A-Za-z0-9-]*: ")
ccx_task_re   = re.compile(r"^Ccx-Task: T-[0-9]+\s*$")

def trim_for_scan(msg: str) -> str:
    lines = msg.rstrip("\n").split("\n")
    i = len(lines)
    while i > 0 and trailer_key_re.match(lines[i-1]):
        i -= 1
    trailer_start = -1
    if 0 < i < len(lines) and lines[i-1] == "":
        j = i - 1
        while j > 0 and lines[j-1] == "":
            j -= 1
        if j > 0:
            trailer_start = i
    if trailer_start < 0:
        # No real trailer block — return the whole message untouched so
        # the marker regex sees every line (a body-level Ccx-Task line
        # is part of the commit content, not the trailer carve-out).
        return msg
    body = lines[:trailer_start]
    trailer = lines[trailer_start:]
    if want_trailer:
        # Only strip Ccx-Task lines from the real trailer block.
        trailer = [l for l in trailer if not ccx_task_re.match(l)]
    # else: ccx.commit.trailer is false — the trailer line is itself a
    # footprint (§18.4); keep it visible so the marker regex flags it.
    return "\n".join(body + trailer)

# Marker pattern — symmetric with supervisor.md's merge-boundary regex.
# (?<![A-Za-z0-9]) catches every non-alphanumeric left boundary
# (whitespace AND punctuation: `(`, `[`, `'`, `"`, `/`, comma, etc.).
# `\bT-[0-9]+\b` provides the right-side boundary for the standalone
# `T-N` shape so `id-T-9abc` does not match. IGNORECASE matches the
# supervisor's `re.IGNORECASE` flag.
marker_re = re.compile(
    r"(?<![A-Za-z0-9])(T-[0-9]+:|\[T-[0-9]+\]|\bT-[0-9]+\b|supervisor:\s*(dispatch|update board)?|ccx/)",
    re.IGNORECASE,
)

found = []
for msg in messages:
    if not msg:
        continue
    scan = trim_for_scan(msg)
    m = marker_re.search(scan)
    if m:
        # Emit the matched line for the operator-facing detail. Single
        # line, truncated to 160 chars by the bash caller below.
        line_start = scan.rfind("\n", 0, m.start()) + 1
        line_end = scan.find("\n", m.end())
        line = scan[line_start:line_end if line_end != -1 else len(scan)]
        found.append(line.strip())
        if len(found) >= 3:
            break

if found:
    # One per line so bash can `head -1` for the FIRST detail string.
    sys.stdout.write("\n".join(found))
PY
)
  # Python availability gate — fail closed. The verifier is the pre-merge
  # contract enforcer; running invariant 3 in a degraded Bash-only mode
  # would silently false-pass punctuation-bounded markers (e.g.
  # `fix (T-6)`, `update 'ccx/foo'`) and config-off Ccx-Task body lines,
  # exactly the leak shapes M9 invariant 3 is supposed to block. An
  # operator with `ccx.merge.strategy = rebase` who lacks python3 should
  # see a clear infrastructure-failure exit (and the supervisor's P0
  # prereq check, which is the right place to surface this BEFORE
  # dispatching workers, follows up).
  if ! command -v python3 >/dev/null 2>&1; then
    rm -f "$HELPER_INPUT_TMP"
    printf 'ccx verify: invariant 3 requires python3 — install python3 (or set the supervisor up to use ccx.dogfood mode where invariant 3 is a no-op). Skipping the check would silently false-pass punctuation-bounded markers and body-level Ccx-Task lines.\n' 1>&2
    exit 2
  fi
  HELPER_OUT="$(WANT_TRAILER="$WANT_TRAILER" python3 -c "$PY_CODE" < "$HELPER_INPUT_TMP")"
  HELPER_RC=$?
  rm -f "$HELPER_INPUT_TMP"
  if [ "$HELPER_RC" -ne 0 ]; then
    printf 'ccx verify: invariant 3 Python helper crashed (rc=%s) — treat as fatal verifier error\n' "$HELPER_RC" 1>&2
    exit 2
  fi
  if [ -n "$HELPER_OUT" ]; then
    FIRST="$(printf '%s\n' "$HELPER_OUT" | head -1 | tr '\n\r\t' '   ' | cut -c1-160)"
    add_violation 12 "invariant 3 — commit message contains a ccx tooling marker (first match: \"$FIRST\"); rewrite the worker's commit subject/body to drop T-N:, [T-N], standalone T-N, supervisor:dispatch, supervisor:update board, and ccx/ markers — see docs/supervisor-design.md §18.2.6"
  fi
fi

# --- Invariant 4: no `Merge branch 'ccx/...'` in mainline (unless dogfood) -
# Default merge strategy is squash (§18.2.7), which never produces a merge
# commit — so the only way this fires in a customer repo is if someone
# explicitly set ccx.merge.strategy=merge AND ccx.dogfood=false. The
# config-load gate in supervisor.md P0 step 1a already STOPs that combination,
# but the verifier is the belt-and-braces backstop.
if [ "$IS_DOGFOOD" != "true" ] && [ -n "$TARGET_REF" ] && [ -n "$BASE" ]; then
  MERGE_HIT="$(git -C "$REPO" log --merges --pretty='%s' "$BASE..$TARGET_REF" 2>/dev/null \
      | grep -E "Merge branch 'ccx/" | head -1)"
  if [ -n "$MERGE_HIT" ]; then
    add_violation 13 "invariant 4 — merge commit subject \"$MERGE_HIT\" carries the legacy ccx/ branch marker (default merge strategy is squash; set 'git config --local ccx.merge.strategy squash' or 'rebase' per §18.2.7)"
  fi
fi

# --- Invariant 5: no stale ccx/T-* branch refs (always — even in dogfood) --
# At pre-merge time the supervisor passes TARGET_REF=ccx/<task_id>; that
# branch obviously still exists and is exempted. With `/ccx:supervisor
# --parallel N>1` the supervisor ALSO passes CCX_PEER_BRANCHES (newline-
# separated) — every other in-flight worker's branch — and those are
# exempted too (they're not stale; they're sibling workers awaiting their
# own pre-merge gate). Manual /ccx:verify (no TARGET_REF, no peers) flags
# every `ccx/T-*` because none should survive a clean drain. Bare `ccx/foo`
# refs (no `T-` prefix) are ignored — only the worker-branch shape is
# contractually managed by ccx.
TARGET_BR=""
case "$TARGET_REF" in
  ccx/T-*)            TARGET_BR="$TARGET_REF" ;;
  refs/heads/ccx/T-*) TARGET_BR="${TARGET_REF#refs/heads/}" ;;
esac
ALL_BRANCHES="$(git -C "$REPO" for-each-ref --format='%(refname:short)' 'refs/heads/ccx/T-*' 2>/dev/null || true)"
STALE_BRANCHES=""
if [ -n "$ALL_BRANCHES" ]; then
  # Build the exemption set as newline-separated lines; pipe through grep
  # -Fxv -f <exempt-file> to subtract. Using -F (fixed strings) + -x
  # (whole-line match) avoids regex meta-character mishandling on
  # branch names that contain `.`, `+`, etc.
  EXEMPT_TMP="$(mktemp)" || {
    # mktemp failed — same shape as the invariant 3 helper's mktemp
    # guard. Without this exit, EXEMPT_TMP stays empty and the later
    # `grep -Fxv -f` falls back to scanning every ccx/T-* branch
    # (because the exempt list is "empty"), misclassifying the
    # candidate + every peer as stale and emitting a false leak-14.
    # An infrastructure failure must surface as exit 2 (verifier
    # itself broken) rather than as a customer-mode leak.
    printf 'ccx verify: mktemp failed while preparing invariant 5 exempt set — TMPDIR=%s is full or read-only\n' "${TMPDIR:-/tmp}" 1>&2
    exit 2
  }
  {
    [ -n "$TARGET_BR" ] && printf '%s\n' "$TARGET_BR"
    # Filter peer branches to the ccx/T-* shape only; a misconfigured
    # caller passing arbitrary strings should not accidentally exempt
    # unrelated refs.
    if [ -n "${CCX_PEER_BRANCHES:-}" ]; then
      printf '%s\n' "$CCX_PEER_BRANCHES" | grep -E '^ccx/T-' || true
    fi
  } > "$EXEMPT_TMP"
  if [ -s "$EXEMPT_TMP" ]; then
    STALE_BRANCHES="$(printf '%s\n' "$ALL_BRANCHES" | grep -Fxv -f "$EXEMPT_TMP" || true)"
  else
    STALE_BRANCHES="$ALL_BRANCHES"
  fi
  rm -f "$EXEMPT_TMP"
fi
if [ -n "$STALE_BRANCHES" ]; then
  STALE_FIRST="$(printf '%s\n' "$STALE_BRANCHES" | head -3 | tr '\n' ',' | sed 's/,$//')"
  add_violation 14 "invariant 5 — stale ccx/T-* branch ref(s) present ($STALE_FIRST); delete via 'git branch -D <branch>' per the T-4 post-merge cleanup contract"
fi

# --- Invariant 6: protected paths untouched (unless opt-in) ----------------
# Distinct gate from dogfood: even dogfood runs should not silently edit
# .claude/ / CLAUDE.md / AGENTS.md without an explicit opt-in. The brief's
# Decisions section deliberately separates the two: dogfood is "ccx-owned
# files in the worktree are OK"; opt-in is "I am intentionally telling ccx
# to edit one of the protected docs".
if [ "$CCX_PROTECTED_OPTIN" != "1" ]; then
  # Resolve diff path list: env override wins; otherwise compute via git.
  if [ -n "${CCX_DIFF_PATHS+x}" ] && [ -n "$CCX_DIFF_PATHS" ]; then
    DIFF_PATHS="$CCX_DIFF_PATHS"
  elif [ -n "$TARGET_REF" ] && [ -n "$BASE" ]; then
    DIFF_PATHS="$(git -C "$REPO" diff --name-only "$BASE...$TARGET_REF" 2>/dev/null || true)"
  else
    DIFF_PATHS=""
  fi
  if [ -n "$DIFF_PATHS" ]; then
    # Matches .claude/* (covers .claude/settings.json), top-level CLAUDE.md,
    # and top-level AGENTS.md. Nested CLAUDE.md / AGENTS.md files (e.g. a
    # plugin author's own plugin-scoped CLAUDE.md) are NOT flagged — the
    # invariant is about the user's root-level customization, not every
    # file that happens to share the basename.
    PROTECTED_HITS="$(printf '%s\n' "$DIFF_PATHS" \
        | grep -E '^(\.claude/|CLAUDE\.md$|AGENTS\.md$)' \
        | head -5)"
    if [ -n "$PROTECTED_HITS" ]; then
      HITS_FIRST="$(printf '%s\n' "$PROTECTED_HITS" | head -3 | tr '\n' ',' | sed 's/,$//')"
      add_violation 15 "invariant 6 — ccx diff touches protected path(s): $HITS_FIRST. Either revise the brief to exclude .claude/, CLAUDE.md, AGENTS.md from scope.include, or re-invoke 'ccx verify' with CCX_PROTECTED_OPTIN=1 to acknowledge the intentional edit"
    fi
  fi
fi

# --- Summary --------------------------------------------------------------
if [ -z "$VIOLATIONS" ]; then
  exit 0
fi

# Print every violation to stderr so the supervisor's revise prompt sees the
# full leak picture — not just the first invariant. The format is
# `ccx verify: <detail>` on its own line, one line per violation, so a
# downstream `grep '^ccx verify:'` over the supervisor log surfaces every
# leak.
printf '%s\n' "$VIOLATIONS" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  detail="${line#*|}"
  printf 'ccx verify: %s\n' "$detail" 1>&2
done

# Exit with the LOWEST matching code so telemetry/operator gets a stable
# primary classifier. Multi-violation cases still surface every violation
# in stderr above; the exit code is just the headline.
LOWEST="$(printf '%s\n' "$VIOLATIONS" | cut -d'|' -f1 | sort -n | head -1)"
exit "$LOWEST"
