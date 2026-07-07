# PoC — Agent SDK as future `claude-companion.mjs` backend

**Status:** Complete (exploratory — not a blocker for the CLI-based conductor).
**Date:** 2026-07-07
**Recommendation:** **No-go for now.** Keep `claude-companion.mjs` on the `claude -p` CLI shell-out. Revisit when the triggers listed at the end of this doc are met.

---

## Summary of Findings

| Question | Finding | Verdict |
|---|---|---|
| (a) `settingSources` / plugin resolution | Loads CLAUDE.md, rules, and **skills** the same way the CLI does, but does **not** auto-discover installed marketplace plugins (e.g. `code-review`) — requires an explicit resolved filesystem path per plugin. | Regression vs. today |
| (b) Permission parity | `permissionMode: "acceptEdits"` matches directly. `allowedTools` is documented as an auto-approve allowlist, not a hard block — semantics differ from the CLI's proven deny-by-omission behavior. | Needs its own experiment before trusting it |
| (c) In-process hooks | `PreToolUse` (and other events) can be registered as JS callbacks in `query()` options — no `--settings <path>` file needed. | Real, working improvement |
| (d) Session fork for retry-after-reject | `resume` + `resumeSessionAt` + `forkSession: true` exist in the stable `query()` API and do what's needed. | Real, working improvement |
| Dependency cost | `@anthropic-ai/claude-agent-sdk` bundles a **native platform binary** as an optional dependency — it does not eliminate the "external Claude Code binary" concept, it just packages it differently. ESM-only, Node ≥18. | Net-neutral, not a clear win |

---

## Current baseline (what we'd be replacing)

`plugins/ccx/scripts/claude-companion.mjs` today `spawn()`s the `claude` CLI as a child process per turn:

```js
spawn("claude", [
  "-p", "--permission-mode", "acceptEdits",
  "--no-session-persistence", "--output-format", "json",
  "--allowedTools", options.allowedTools,
  "--model", options.model,
  ...(options.effort ? ["--effort", options.effort] : []),
  options.prompt,
], { cwd, stdio: ["ignore", "pipe", "pipe"] });
```

and parses the `result` field of the JSON envelope for the trailing `VERDICT:` line. `docs/m10-poc-notes.md` (T-1's PoC) already validated that this shell-out inherits plugin/skill resolution, `--permission-mode acceptEdits` + `--allowedTools` denial semantics, and the `VERDICT:` extraction protocol experimentally — this is the bar the SDK approach has to clear, not just match on paper.

---

## (a) `settingSources` and plugin/skill resolution

`query()` accepts `settingSources: SettingSource[]`, `SettingSource = "user" | "project" | "local"`, defaulting to all three when omitted — CLAUDE.md, rules, and **skills** resolve the same way the CLI does.

The gap: installed **marketplace plugins** are not auto-discovered from `settingSources` the way T-1's PoC observed the CLI resolving them (Experiment 3: `code-review` found under `~/.claude/plugins/marketplaces/.../plugins/code-review/` with zero extra flags). The SDK instead requires an explicit `plugins: [{ type: "local", path: <resolved-path> }]` entry per plugin — `type: "local"` is the only supported form. For the conductor's Claude reviewer, that means the companion would need to locate the installed `code-review` plugin's on-disk path itself (marketplace install paths embed marketplace name and can move on reinstall/update) and pass it explicitly, rather than relying on the CLI's automatic resolution. This is new plumbing with a real failure mode: a stale or unresolved path silently drops the skill instead of the reviewer just not finding it.

Also note: managed policy, `~/.claude.json`, auto-memory, and claude.ai MCP connectors load regardless of `settingSources` — a difference to keep in mind if strict per-turn isolation is ever wanted, though it isn't a concern for the conductor's current design.

Sources: [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins)

---

## (b) Permission parity

`options.permissionMode` includes `"acceptEdits"` as a direct match for the CLI flag. `options.allowedTools: string[]` is the named equivalent of `--allowedTools`, but the docs describe it as an auto-approve allowlist — tools *not* listed still fall through to `permissionMode` / `canUseTool` rather than being denied outright. `disallowedTools` is the documented way to hard-block a tool.

This is a meaningful behavioral difference from what T-1's PoC measured for the CLI (Experiment 2: a tool outside `--allowedTools` was denied; Experiment 8: the blocked attempt was reported in `permission_denials`). Given the conductor's worktree-isolation story already leans on `--allowedTools` denial as one of its guardrails (`docs/m10-poc-notes.md` Experiment 9 notes there's no hard enforcement boundary regardless), an SDK migration would need its own directly-observed experiment — mirroring T-1's Experiment 2 and Experiment 8 shapes — before the team could trust `allowedTools` to behave the same way. Docs alone aren't sufficient to close this question.

Sources: [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

---

## (c) In-process hooks vs. the T-13 `--settings` approach

The SDK supports registering `PreToolUse` (and other hook events) as JS callbacks passed directly into `query()`'s options:

```ts
options: {
  hooks: {
    PreToolUse: [{ matcher: "Write|Edit", hooks: [myCallback] }]
  }
}
```

`HookCallback` signature: `(input, toolUseID, { signal }) => Promise<HookJSONOutput>`, returning e.g. `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny"|"ask"|"defer", permissionDecisionReason, updatedInput } }`.

This is a genuine improvement over the planned T-13 `--settings <path-to-json>` approach (a branch-guard `PreToolUse` hook to fix the wrong-branch incident class, not yet landed as of this writing — `claude-companion.mjs` currently spawns `claude` with no `--settings` argument at all): no temp JSON file would have to be written to disk per spawn, and hook logic could close over per-turn conductor state directly instead of being re-serialized into a settings file each time. If the SDK migration ever happens, this is the strongest single win of the four questions.

Sources: [Intercept and control agent behavior with hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

---

## (d) Session fork for retry-after-reject

The stable `query()` API supports `resume: string` (session ID), `forkSession: boolean` (branch into a new session ID, leaving the original untouched), `continue: boolean`, and `resumeSessionAt: string` (resume at a specific message UUID). Combined (`resume` + `resumeSessionAt` + `forkSession: true`), this lets a caller branch from the exact point before a rejected turn and retry with just the new reviewer findings, instead of re-sending the full brief excerpt + prior-turn context in a fresh prompt the way the current conductor does on every implement retry.

One caveat: `resumeSessionAt` is documented in the Options reference table but isn't demonstrated in the main "Work with sessions" guide's walkthrough (which only covers `continue`/`resume`/`forkSession`). The same guide now says the experimental V2 session API was removed in TypeScript Agent SDK 0.3.142; with the npm registry currently reporting 0.3.202 as latest, the V2 preview is gone from the current SDK line. For this use case, the only session API surface to target is the stable `query()` path with `resume` / `forkSession` / `resumeSessionAt`. GitHub issue anthropics/claude-agent-sdk-typescript#234 is stale because it references that since-deleted V2 API, not an open item to monitor for future implementation.

Sources: [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [GitHub issue #234](https://github.com/anthropics/claude-agent-sdk-typescript/issues/234)

---

## Dependency cost

Package: `@anthropic-ai/claude-agent-sdk`. Fully standalone in the sense that it does **not** require the user to separately `npm install -g @anthropic-ai/claude-code` — but it bundles a **native Claude Code binary as an optional platform dependency** (Linux x64/arm64/musl, Windows x64/arm64, macOS x64/arm64) and shells out to it internally, with a `pathToClaudeCodeExecutable` escape hatch if the optional dep is skipped. So the "no CLI dependency" framing in the task goal is only half true: the child-process boundary moves from "user's global `claude` binary" to "SDK's bundled native binary," it doesn't disappear.

Peer deps: `zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`. ESM-only (`sdk.mjs` entry), Node ≥18. Unpacked package size ~3.86 MB excluding the platform-specific binary.

Installing it into the plugin dir would follow the precedent `/ccx:chat-setup` already set for `discord.js` (`npm install` scoped to `${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat`) — not a new pattern, just a second instance of it, this time under `plugins/ccx/scripts/`.

Sources: [npm registry API](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest), [npm package page](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## Recommendation: No-go for now

Two of the four questions (c, d) are real, working improvements over the current CLI shell-out. But the other two carry open risk that would need to be closed with direct experiments — the same way `docs/m10-poc-notes.md` closed them for the CLI approach — before a migration could be trusted:

1. **Plugin auto-resolution regression (a).** The conductor's Claude reviewer depends on the `code-review` skill resolving without extra plumbing. The SDK requires explicitly resolving and passing the installed plugin's on-disk path, which is new code with a new failure mode (stale/unresolved path → silently missing skill, not a loud error).
2. **Permission semantics mismatch (b).** `allowedTools` is documented as an allowlist rather than a hard block, unlike the CLI behavior T-1's PoC measured directly. This needs its own experiment, not just a docs read, before the conductor's tool-restriction guardrail could rely on it.

Given the current CLI-based conductor already shipped (M10, 2026-05-28) and works, and the immediate branch-guard need is already being addressed by the planned T-13 `--settings`-based `PreToolUse` hook (a smaller, targeted change within the existing CLI shell-out, not requiring an SDK migration), the marginal wins from (c) and (d) don't justify taking on (a) and (b)'s open risk plus a new npm dependency right now.

**Revisit triggers** — re-open this PoC if any of the following happen:
- A concrete need emerges for in-process hook state (closures over conductor state) that `--settings` files can't express.
- Retry-after-reject prompt replay becomes an observed cost or latency problem large enough that `resumeSessionAt` savings matter.
- Someone runs the (a)/(b) experiments directly (mirroring `docs/m10-poc-notes.md`'s Experiment 2, Experiment 3, and Experiment 8 shapes against the SDK instead of the CLI) and both come back clean.
- The SDK's plugin-resolution API gains an auto-discovery mode equivalent to the CLI's marketplace lookup.
