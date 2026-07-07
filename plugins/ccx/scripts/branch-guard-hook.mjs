#!/usr/bin/env node

// PreToolUse(Bash) hook: block `git commit` unless it can be PROVEN to run on
// the worker's expected branch. Deterministic backstop for the incident class
// where a supervised worker commits to the integration branch (e.g. main)
// instead of its own duet/<task_id> branch, bypassing the squash-merge gate.
//
// Activation is gated on CCX_EXPECTED_BRANCH: the supervisor exports it in the
// worker spawn env (CCX_EXPECTED_BRANCH=duet/<task_id>). When it is unset or
// empty — every manual `/ccx:loop` run — the hook no-ops and every command is
// allowed through unchanged. Hooks run outside the model context, so the guard
// costs zero tokens.
//
// Design is prove-or-deny: a commit is allowed only when the branch it will
// actually land on can be determined and equals the expected branch. Every way
// a Bash command can reach a different branch before the commit resolves to a
// deny:
//   - an in-command `git switch` / `git checkout` (branch change),
//   - a `cd` into another directory (tracked on a subshell-aware stack),
//   - a `git -C` / `--git-dir` / `--work-tree` that retargets the repo (replayed
//     into the branch lookup, quoted paths with spaces included),
//   - a shell-dynamic path we cannot resolve statically ($VAR, ~, globs),
//   - a nested shell or exec wrapper (`bash -c`, `sh -c`, `env`, `eval`,
//     `xargs`, `su`) whose body this parser cannot verify,
//   - a repo-selecting git env var (GIT_DIR, GIT_WORK_TREE, …),
//   - a git alias (e.g. `git ci` → `commit`) resolved through `git config`.
// The worker's normal Phase 4 commit — a plain `git commit` in its worktree on
// the expected branch — is provably fine; only exotic one-liners trip the guard.
//
// Block convention (verified against the Claude Code hooks reference): exit 0
// with a JSON stdout envelope carrying hookSpecificOutput.permissionDecision =
// "deny". Allowing a command means exit 0 with empty stdout so the normal
// permission flow proceeds — emitting permissionDecision "allow" would instead
// short-circuit other permission checks, which is not the guard's job.

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function allow() {
  // Empty stdout + exit 0: defer to the normal permission flow.
  process.exit(0);
}

function deny(reason) {
  const envelope = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Placeholder token a command substitution collapses to in the enclosing
// command. It contains `$`, so isDynamic() treats any argument built from it
// (e.g. a `-C "$(pwd)"` value, or a `git "$(…)"` subcommand) as indeterminate.
const SUBST_PLACEHOLDER = "$()";

// Substitution-aware tokenizer. Returns an ordered list of items:
//   { seg: [tokens], subs: [bodies] }
//                         a segment (whitespace-split, quote-stripped tokens; a
//                         quoted span keeps its internal whitespace) plus the
//                         bodies of every `$( … )` / backtick command
//                         substitution that appeared IN that segment
//   { marker: "(" }       a plain `( … )` subshell open — models `cd` scope
//   { marker: ")" }       subshell close
//   { marker: "sep" }     a chain separator (; && || | & newline)
// A substitution does NOT break the enclosing segment: it collapses to a single
// SUBST_PLACEHOLDER token (so `git -C "$(pwd)" commit` stays one `git … commit`
// segment with a dynamic `-C` value instead of orphaning `commit`) and its body
// is attached to the segment so the caller can analyze it recursively at the
// working directory in effect where the segment runs.
// Quote handling matters: single quotes suppress substitution (a `$(…)` inside
// '' is literal), double quotes do not (a `$(…)` inside "…" still runs).
// It is NOT a full shell parser — bodies handed to nested SHELLS (`bash -c '…'`)
// stay opaque and are covered by the wrapper deny instead.
function parseCommand(command) {
  const items = [];
  let tokens = [];
  let segSubs = [];
  let cur = "";
  let inTok = false;
  const stack = []; // "dq" (double quote) or "paren" (plain subshell); empty = base
  const top = () => stack[stack.length - 1];

  const endTok = () => {
    if (inTok) {
      tokens.push(cur);
      cur = "";
      inTok = false;
    }
  };
  const endSeg = () => {
    endTok();
    if (tokens.length) {
      items.push({ seg: tokens, subs: segSubs });
      tokens = [];
      segSubs = [];
    }
  };

  // Scan a `$( … )` body from just after `$(`, honouring quotes and nested
  // parens; returns { body, end } where end is the index of the closing `)`.
  const scanParenSubst = (start) => {
    let depth = 1;
    let j = start;
    let body = "";
    let q = null;
    while (j < command.length && depth > 0) {
      const d = command[j];
      if (q) {
        if (d === q) q = null;
        body += d;
        j++;
        continue;
      }
      if (d === "'" || d === '"') {
        q = d;
        body += d;
        j++;
        continue;
      }
      if (d === "\\" && j + 1 < command.length) {
        body += d + command[j + 1];
        j += 2;
        continue;
      }
      if (d === "(") depth++;
      else if (d === ")") {
        depth--;
        if (depth === 0) break;
      }
      body += d;
      j++;
    }
    return { body, end: j };
  };

  // Scan a backtick body from just after the opening backtick to the next
  // unescaped backtick; returns { body, end } where end is the closing backtick.
  const scanBacktick = (start) => {
    let j = start;
    let body = "";
    while (j < command.length && command[j] !== "`") {
      if (command[j] === "\\" && j + 1 < command.length) {
        body += command[j] + command[j + 1];
        j += 2;
        continue;
      }
      body += command[j];
      j++;
    }
    return { body, end: j };
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const mode = top();

    // Single-quote literal — only when NOT inside double quotes.
    if (c === "'" && mode !== "dq") {
      inTok = true;
      i++;
      while (i < command.length && command[i] !== "'") {
        cur += command[i];
        i++;
      }
      continue;
    }
    // Backslash escape (outside single quotes).
    if (c === "\\" && i + 1 < command.length) {
      cur += command[i + 1];
      inTok = true;
      i++;
      continue;
    }
    if (c === '"') {
      if (mode === "dq") stack.pop();
      else stack.push("dq");
      inTok = true;
      continue;
    }
    // Command substitutions collapse to a placeholder token in this command and
    // record their body for recursive analysis. Active even inside double quotes.
    if (c === "$" && command[i + 1] === "(") {
      const { body, end } = scanParenSubst(i + 2);
      segSubs.push(body);
      cur += SUBST_PLACEHOLDER;
      inTok = true;
      i = end; // loop's i++ moves past the closing `)`
      continue;
    }
    if (c === "`") {
      const { body, end } = scanBacktick(i + 1);
      segSubs.push(body);
      cur += SUBST_PLACEHOLDER;
      inTok = true;
      i = end; // loop's i++ moves past the closing backtick
      continue;
    }

    // Word-splitting and shell operators are inert inside double quotes.
    if (mode !== "dq") {
      if (c === "(") {
        endSeg();
        items.push({ marker: "(" });
        stack.push("paren");
        continue;
      }
      if (c === ")") {
        if (mode === "paren") {
          endSeg();
          items.push({ marker: ")" });
          stack.pop();
          continue;
        }
        cur += c; // stray `)` — ordinary character
        inTok = true;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        endTok();
        continue;
      }
      if (c === "\n" || c === ";") {
        endSeg();
        items.push({ marker: "sep", op: c === ";" ? ";" : "\n" });
        continue;
      }
      if (c === "&") {
        let op = "&";
        if (command[i + 1] === "&") {
          i++;
          op = "&&";
        }
        endSeg();
        items.push({ marker: "sep", op });
        continue;
      }
      if (c === "|") {
        let op = "|";
        if (command[i + 1] === "|") {
          i++;
          op = "||";
        }
        endSeg();
        items.push({ marker: "sep", op });
        continue;
      }
    }

    cur += c;
    inTok = true;
  }
  endSeg();
  return items;
}

// Global git options that consume a following separate-argument value.
const GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
// Separate-argument flags to `git switch` / `git checkout` whose following token
// names the branch being created/switched to. Attached (`-bmain`) and equals
// (`--create=main`) forms are handled by regex in switchTarget().
const SWITCH_CREATE_FLAGS = new Set(["-c", "-C", "-b", "-B", "--orphan", "--create", "--force-create"]);
const SWITCH_UNKNOWN_FLAGS = new Set(["--detach", "-d"]);
// Command words that run another command from a string / different context this
// parser cannot see through: shells, exec wrappers, and script interpreters that
// can shell out to git. A committing command containing one is denied. Language
// interpreters are matched by INTERPRETER_RE (below) so versioned names like
// `python3.11` are covered too.
const EXEC_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "env", "eval", "xargs", "su"]);
const INTERPRETER_RE = /^(?:python[0-9.]*|node|nodejs|deno|bun|ruby|perl[0-9.]*|php|rscript|lua|luajit|tclsh|osascript|expect)$/i;

// A segment command word that runs opaque code this parser cannot inspect.
function isOpaqueWrapper(word) {
  return EXEC_WRAPPERS.has(word) || INTERPRETER_RE.test(word);
}
// Repo/worktree-selecting git env vars; an assignment of one is treated as an
// unverifiable retarget.
const GIT_REPO_ENV_RE =
  /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)=/;
// Git subcommands that add a commit to the CURRENT branch without a literal
// `git commit` — so each is verified against the expected branch exactly like a
// commit. `git commit` itself is included. Control forms of these (e.g. `merge
// --abort`, `rebase --continue`) do not create a commit, but on the expected
// branch they verify clean anyway, and on the wrong branch a deny is the correct
// conservative outcome, so they are not special-cased.
const COMMIT_SUBCOMMANDS = new Set(["commit", "merge", "revert", "cherry-pick", "rebase", "am", "pull"]);
// A commit-creating subcommand mentioned anywhere (used to decide whether a
// wrapped command is worth denying, and whether an alias body commits). `am` is
// omitted here to avoid matching the English word "am" inside a `!shell` alias
// body — a literal `git am` is still caught as a direct subcommand.
const COMMIT_MENTION_RE = /(?:^|[^\w-])(?:commit|merge|revert|cherry-pick|rebase|pull)(?![\w-])/;
// Built-in git subcommands that never create a commit on a branch. Anything NOT
// here (and not in COMMIT_SUBCOMMANDS) is treated as a possible alias and
// resolved through `git config` — that is how alias-driven commits (`git ci`)
// are caught. Kept deliberately broad so ordinary porcelain (`git status`,
// `git add`, …) skips the alias lookup.
const KNOWN_GIT_SUBCOMMANDS = new Set([
  "status", "add", "diff", "log", "show", "push", "fetch", "branch",
  "reset", "restore", "stash", "tag", "remote", "rev-parse", "ls-files", "ls-tree", "ls-remote",
  "config", "clean", "mv", "rm", "apply", "worktree", "submodule",
  "describe", "blame", "grep", "bisect", "reflog", "notes", "archive", "shortlog", "symbolic-ref",
  "update-ref", "update-index", "cat-file", "for-each-ref", "rev-list", "name-rev", "diff-tree",
  "diff-index", "diff-files", "show-ref", "check-ignore", "check-attr", "verify-commit", "verify-tag",
  "format-patch", "mailinfo", "whatchanged", "cherry", "range-diff", "sparse-checkout",
  "read-tree", "write-tree", "commit-tree", "commit-graph", "merge-base", "hash-object",
  "count-objects", "gc", "fsck", "prune", "repack", "pack-refs", "maintenance", "var", "help",
  "version", "init", "clone", "bundle", "replace", "annotate", "fast-export", "fast-import",
  "request-pull", "send-email", "filter-branch", "pack-objects", "unpack-objects",
]);

// Sentinel values.
const NO_CHANGE = undefined; // switch target: not a branch change
const UNKNOWN = Symbol("unknown-branch"); // switch/repo target: undeterminable
const UNKNOWN_DIR = Symbol("unknown-dir"); // cd destination: undeterminable

// True when a token still carries shell expansion / globbing we cannot resolve
// statically. Tokens are already quote-stripped by the tokenizer.
function isDynamic(t) {
  return /[$`~*?]/.test(t);
}

function baseName(t) {
  return t.split("/").pop();
}

// Leading tokens that precede the real command word in a segment: shell control
// keywords, group braces, negation, and command prefixes. Stripped (along with
// `NAME=value` env assignments) so `{ cd …`, `if cd …`, `FOO=1 bash …`, and
// `builtin cd …` all expose their true command word (`cd` / `bash`).
const CMD_PREFIX_NOISE = new Set([
  "{", "}", "!", "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "for", "in",
  "case", "esac", "select", "time", "builtin", "command",
]);

// The tokens of a segment with leading control/grouping/prefix noise and env
// assignments removed, exposing the real command and its arguments.
function effectiveTokens(tokens) {
  let k = 0;
  while (k < tokens.length && (CMD_PREFIX_NOISE.has(tokens[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k]))) {
    k++;
  }
  return tokens.slice(k);
}

// The effective command word of a segment (directory-stripped, noise-skipped).
function effectiveCommandWord(tokens) {
  const eff = effectiveTokens(tokens);
  return eff.length ? baseName(eff[0]) : "";
}

// Classify one command segment (token array) into the shapes the guard reasons
// about.
function classifySegment(tokens) {
  if (!tokens || tokens.length === 0) return { kind: "other" };

  const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
  if (gitIdx !== -1) {
    // Advance past git's global options (skipping the values of the ones that
    // take a separate-argument value) to reach the subcommand token.
    let i = gitIdx + 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (GIT_GLOBAL_VALUE_OPTS.has(t)) {
        i += 2;
        continue;
      }
      if (t.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    // The full global-options slice (`-C <path>`, `-c alias.x=…`, `--git-dir=…`,
    // …) is replayed verbatim into every git lookup below, so the guard resolves
    // the branch AND any per-invocation alias exactly as the real command would.
    const gitArgs = tokens.slice(gitIdx + 1, i);
    const pathIndeterminate = gitArgs.some(isDynamic);
    const sub = tokens[i];
    if (COMMIT_SUBCOMMANDS.has(sub)) return { kind: "commit", gitArgs, pathIndeterminate };
    if (sub === "switch" || sub === "checkout") {
      return { kind: "switch", target: switchTarget(sub, tokens.slice(i + 1)) };
    }
    if (sub !== undefined) return { kind: "git-other", sub, gitArgs, pathIndeterminate };
  }

  // Directory-changing commands, after stripping leading control/grouping/prefix
  // noise (`{ cd …`, `if cd …`, `builtin cd …`). `pushd` / `popd` manipulate a
  // dir stack this guard does not track, so they render the working directory
  // indeterminate (any commit after them cannot be proven on-branch).
  const dirTokens = effectiveTokens(tokens);
  if (dirTokens[0] === "cd") return { kind: "cd", target: cdTarget(dirTokens) };
  if (dirTokens[0] === "pushd" || dirTokens[0] === "popd") return { kind: "cd", target: UNKNOWN_DIR };
  return { kind: "other" };
}

// Resolve the destination of a `cd` segment. UNKNOWN_DIR when it cannot be
// determined (no argument → home, `cd -` → previous dir, dynamic path).
function cdTarget(tokens) {
  for (let j = 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.startsWith("-")) continue; // cd options (-L/-P/-e/-@) and `cd -`
    if (isDynamic(t)) return UNKNOWN_DIR;
    return t;
  }
  return UNKNOWN_DIR;
}

// Resolve the branch a `git switch` / `git checkout` segment moves HEAD to.
function switchTarget(sub, rest) {
  if (sub === "checkout" && rest.includes("--")) return NO_CHANGE; // file restore
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    // Separate-argument create flag: `-c BRANCH`, `-b BRANCH`, `--create BRANCH`.
    if (SWITCH_CREATE_FLAGS.has(t)) {
      const v = rest[j + 1];
      return v == null || isDynamic(v) ? UNKNOWN : v;
    }
    // Attached short form: `-bmain`, `-Cmain`.
    let m = /^-([cCbB])(.+)$/.exec(t);
    if (m) return isDynamic(m[2]) ? UNKNOWN : m[2];
    // Equals long form: `--create=main`, `--force-create=main`, `--orphan=main`.
    m = /^--(?:create|force-create|orphan)=(.+)$/.exec(t);
    if (m) return isDynamic(m[1]) ? UNKNOWN : m[1];
    if (SWITCH_UNKNOWN_FLAGS.has(t) || t === "-") return UNKNOWN;
    if (t.startsWith("-")) continue;
    return isDynamic(t) ? UNKNOWN : t;
  }
  return NO_CHANGE;
}

// Read the branch a commit will run on, honouring the commit's own repo-path
// options by replaying them into git. Returns the branch name, UNKNOWN when a
// path option is dynamic, or null when the target is not a git repo.
function resolveBranch(cwd, pathArgs) {
  for (const a of pathArgs) {
    if (isDynamic(a)) return UNKNOWN;
  }
  try {
    return execFileSync("git", [...pathArgs, "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// The configured expansion of a git alias, or "" when `sub` is not an alias (or
// git config cannot be read). Read-only; safe to run speculatively.
function aliasBody(cwd, pathArgs, sub) {
  if (pathArgs.some(isDynamic)) return "";
  try {
    return execFileSync("git", [...pathArgs, "config", "--get", `alias.${sub}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// `git am` as a git subcommand, allowing any global options AND their values
// (e.g. `git -C ../repo am`) between `git` and `am` — but not crossing a command
// separator. Matched separately from COMMIT_MENTION_RE so the bare word "am"
// (e.g. "I am" in a `!shell` alias) never triggers, while `bash -c 'git am …'`
// and `bash -c 'git -C x am …'` still do.
const GIT_AM_RE = /(?:^|[^\w-])git\s+(?:[^;&|\n]*\s)?am(?![\w-])/;

// Does a git command string (a nested-shell body or a `!shell` alias) contain a
// commit-creating subcommand invocation?
function stringMentionsCommit(s) {
  return COMMIT_MENTION_RE.test(s) || GIT_AM_RE.test(s);
}

// Does a resolved git alias body create a commit? A `!shell` alias is scanned
// for a git commit-creating invocation; a normal alias body is a git subcommand
// fragment, so its first token is the subcommand — which catches a bare `am`
// (an alias expanding to `am`) that the prose-safe GIT_AM_RE would miss.
function aliasCreatesCommit(body) {
  if (!body) return false;
  if (body.startsWith("!")) return stringMentionsCommit(body);
  return COMMIT_SUBCOMMANDS.has(body.trim().split(/\s+/)[0]);
}

// Does a resolved git alias body change the current branch (a checkout/switch)?
// Handled symmetrically with aliasCreatesCommit so an aliased `git co main`
// (co = checkout) before a commit is caught the same way a literal
// `git checkout main` is, rather than slipping through as an unknown subcommand.
function aliasChangesBranch(body) {
  if (!body) return false;
  if (body.startsWith("!")) return BRANCH_CHANGE_RE.test(body);
  const first = body.trim().split(/\s+/)[0];
  return first === "checkout" || first === "switch";
}

// A `git switch` / `git checkout` invocation anywhere in a string (allowing git
// global options and their values before the subcommand). Used to detect a
// branch change hidden inside a command substitution — which persists (git
// switch writes `.git/HEAD`) and can move a later outer commit off-branch.
const BRANCH_CHANGE_RE = /(?:^|[^\w-])git\s+(?:[^;&|\n]*\s)?(?:switch|checkout)(?![\w-])/;
function stringChangesBranch(s) {
  return BRANCH_CHANGE_RE.test(s);
}

const BYPASS_TAIL =
  "bypasses the supervisor's squash-merge gate. Commit directly on the expected branch, or abort via chat_close if the branch is wrong.";

// Verify a commit that will run in `top.cwd` lands on `expected`; deny otherwise.
// Returns normally when the commit is provably fine or the target is not a repo.
function verifyCommit(expected, top, pathArgs, pathIndeterminate, switched) {
  if (switched) {
    deny(
      `branch-guard: refusing to commit — this command switches branches before committing, so it cannot ` +
        `be proven to land on '${expected}'. Committing off '${expected}' ${BYPASS_TAIL}`
    );
  }
  if (top.unknown) {
    deny(
      `branch-guard: refusing to commit — this command changes into an undetermined directory before ` +
        `committing, so the commit's branch cannot be verified against '${expected}'. Committing off ` +
        `'${expected}' ${BYPASS_TAIL}`
    );
  }
  if (pathIndeterminate) {
    deny(
      `branch-guard: refusing to commit — this command retargets the repository through a dynamic path that ` +
        `cannot be resolved statically, so its branch cannot be verified against '${expected}'. Committing ` +
        `off '${expected}' ${BYPASS_TAIL}`
    );
  }
  const branch = resolveBranch(top.cwd, pathArgs);
  if (branch === UNKNOWN) {
    deny(
      `branch-guard: refusing to commit — this command targets an undetermined repository directory, so its ` +
        `branch cannot be verified against '${expected}'. Committing off '${expected}' ${BYPASS_TAIL}`
    );
  }
  if (branch === null) return; // not a git repo here — the commit fails on its own, not our concern
  if (branch !== expected) {
    deny(
      `branch-guard: refusing to commit on '${branch}' — this worker must commit only on '${expected}'. ` +
        `Committing here ${BYPASS_TAIL}`
    );
  }
}

// Analyze one command string (the outer Bash command, or recursively a command
// substitution body) and deny() on any provable/unverifiable off-branch commit.
// Returns normally when nothing in this command or its substitutions violates.
// `inheritedSwitch` carries a persisted branch change from an enclosing scope.
function checkCommand(command, expected, baseCwd, inheritedSwitch) {
  const items = parseCommand(command);
  const segs = items.filter((x) => x.seg).map((x) => x.seg);
  const classified = segs.map(classifySegment);

  const hasCommit = classified.some((c) => c.kind === "commit");
  // An unknown/dynamic git subcommand is a possible commit (an alias, or a
  // shell-expanded subcommand like `git "$SUBCMD"`).
  const hasPossibleAlias = classified.some((c) => c.kind === "git-other" && !KNOWN_GIT_SUBCOMMANDS.has(c.sub));
  const wrapperPresent = segs.some((tok) => isOpaqueWrapper(effectiveCommandWord(tok)));
  // "This command plausibly commits" — includes a commit hidden in a nested-shell
  // body or a substitution (both surface the word in the raw string).
  const commitContext = hasCommit || hasPossibleAlias || stringMentionsCommit(command);

  // A nested shell / exec wrapper hides the commit's real execution context.
  if (wrapperPresent && commitContext) {
    deny(
      `branch-guard: refusing to commit — this command runs the commit through a nested shell or exec ` +
        `wrapper, so the branch it lands on cannot be verified against '${expected}'. Run a plain ` +
        `'git commit' on '${expected}' instead. Committing off '${expected}' ${BYPASS_TAIL}`
    );
  }
  // A repo-selecting git env var assignment retargets the commit to a repository
  // resolveBranch does not see.
  if (commitContext && segs.some((tok) => tok.some((t) => GIT_REPO_ENV_RE.test(t)))) {
    deny(
      `branch-guard: refusing to commit — this command sets a git repository/worktree environment ` +
        `variable (GIT_DIR / GIT_WORK_TREE / …), which retargets the commit to a repository whose branch ` +
        `cannot be verified against '${expected}'. Run a plain 'git commit' on '${expected}' instead. ` +
        `Committing off '${expected}' ${BYPASS_TAIL}`
    );
  }

  // Walk items in order, tracking the working directory (via `cd`) on a
  // paren-depth STACK so a `cd` inside a `( … )` subshell does not leak into the
  // outer scope. Branch switches are NOT stack-scoped. Each segment's command
  // substitutions run in that segment's cwd, BEFORE its command, so they are
  // recursed there — e.g. a `cd /x && echo $(git commit)` commit is checked in /x.
  const stack = [{ cwd: baseCwd, unknown: false }];
  let switchedBeforeCommit = inheritedSwitch;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (item.marker === "(") {
      const t = stack[stack.length - 1];
      stack.push({ cwd: t.cwd, unknown: t.unknown });
      continue;
    }
    if (item.marker === ")") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (!item.seg) continue; // "sep" markers carry no dir/branch effect

    const info = classifySegment(item.seg);
    const top = stack[stack.length - 1];

    // The segment's command substitutions run first, in the current cwd. A branch
    // change inside one persists (git switch writes `.git/HEAD`) and can move THIS
    // segment's own commit — and every later one — off-branch.
    for (const body of item.subs) {
      if (stringChangesBranch(body)) switchedBeforeCommit = true;
      checkCommand(body, expected, top.cwd, switchedBeforeCommit);
    }

    if (info.kind === "cd") {
      if (info.target === UNKNOWN_DIR) {
        top.unknown = true;
      } else {
        // A `cd` only reliably changes the directory a LATER command runs in when
        // it is joined to that command by `&&` (short-circuit proves the cd
        // succeeded). After `||` / `|` / `&` the next command runs in the original
        // cwd (the cd failed, or the pipe/background side is a fresh subshell), so
        // the cd is ignored. After `;` / newline the outcome is ambiguous (the cd
        // may have failed), so the cwd becomes unknown and a later commit denies.
        const next = items[idx + 1];
        const op = next && next.marker === "sep" ? next.op : "&&"; // no following op ⇒ nothing runs after, treat as trusted
        if (op === "&&") {
          if (!top.unknown) top.cwd = path.resolve(top.cwd, info.target);
        } else if (op === ";" || op === "\n") {
          top.unknown = true;
        }
        // "||" / "|" / "&": ignore the cd — the next command runs in the old cwd.
      }
    } else if (info.kind === "switch") {
      // ANY in-command branch change before a commit trips the flag — including a
      // switch to the expected branch. That is deliberately conservative: a
      // worker is spawned already on its branch and never switches before its
      // Phase 4 commit, so the only cost is denying an exotic one-liner.
      if (info.target !== NO_CHANGE) switchedBeforeCommit = true;
    } else if (info.kind === "commit") {
      verifyCommit(expected, top, info.gitArgs, info.pathIndeterminate, switchedBeforeCommit);
    } else if (info.kind === "git-other" && !KNOWN_GIT_SUBCOMMANDS.has(info.sub)) {
      // A dynamic subcommand (`git "$SUBCMD"`) could expand to `commit`; its value
      // is unknowable before execution, so deny.
      if (isDynamic(info.sub)) {
        deny(
          `branch-guard: refusing to commit — this command's git subcommand is supplied through shell ` +
            `expansion and cannot be verified against '${expected}' before it runs. Run a plain ` +
            `'git commit' on '${expected}' instead. Committing off '${expected}' ${BYPASS_TAIL}`
        );
      }
      // Possible alias. Resolve it: a commit alias is verified like a commit, and
      // a checkout/switch alias trips the same branch-change flag a literal
      // checkout/switch would (so `git co main && git commit` is caught).
      const body = aliasBody(top.cwd, info.gitArgs, info.sub);
      if (aliasCreatesCommit(body)) {
        if (body.startsWith("!")) {
          deny(
            `branch-guard: refusing to run '${info.sub}' — it is a shell ('!') git alias that commits, whose ` +
              `effective branch cannot be verified against '${expected}'. Run a plain 'git commit' on ` +
              `'${expected}' instead. Committing off '${expected}' ${BYPASS_TAIL}`
          );
        }
        verifyCommit(expected, top, info.gitArgs, info.pathIndeterminate, switchedBeforeCommit);
      } else if (aliasChangesBranch(body)) {
        switchedBeforeCommit = true;
      }
    }
  }
}

async function main() {
  const expected = process.env.CCX_EXPECTED_BRANCH;
  if (!expected) allow(); // unsupervised / manual run — guard disabled

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    allow(); // unparseable hook payload — fail open rather than brick the worker
  }

  if (input.tool_name !== "Bash") allow();

  const command = input.tool_input?.command;
  if (typeof command !== "string") allow();

  const payloadCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  checkCommand(command, expected, payloadCwd, false); // deny() exits on any violation
  allow(); // nothing violated
}

main();
