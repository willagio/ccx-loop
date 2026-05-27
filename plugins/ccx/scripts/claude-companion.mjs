#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const DEFAULT_ALLOWED_TOOLS = "Read,Edit,Write,Bash,Glob,Grep";
const INSTALL_HINT =
  "claude CLI not found — install with: npm install -g @anthropic-ai/claude-code";

function printUsage() {
  process.stderr.write(
    "Usage: claude-companion.mjs --model <name> --cwd <path> [--effort <level>] [--allowed-tools <list>] [--json] <prompt>\n"
  );
}

function parseArgs(argv) {
  const options = {
    model: null,
    effort: null,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    cwd: null,
    json: true,
    prompt: null,
  };

  const positionals = [];
  let i = 0;
  let endOfOptions = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (endOfOptions) {
      positionals.push(arg);
      i++;
      continue;
    }

    switch (arg) {
      case "--":
        endOfOptions = true;
        break;
      case "--model":
        options.model = argv[++i] ?? null;
        break;
      case "--effort":
        options.effort = argv[++i] ?? null;
        break;
      case "--allowed-tools":
        options.allowedTools = argv[++i] ?? DEFAULT_ALLOWED_TOOLS;
        break;
      case "--cwd":
        options.cwd = argv[++i] ?? null;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`Error: Unknown flag: ${arg}\n`);
          printUsage();
          process.exit(1);
        }
        positionals.push(arg);
    }
    i++;
  }

  if (positionals.length > 0) {
    options.prompt = positionals.join(" ");
  }

  return options;
}

function validateOptions(options) {
  const errors = [];
  if (!options.model) errors.push("--model is required");
  if (!options.cwd) errors.push("--cwd is required");
  if (!options.prompt) errors.push("prompt argument is required");

  if (errors.length > 0) {
    for (const err of errors) {
      process.stderr.write(`Error: ${err}\n`);
    }
    printUsage();
    process.exit(1);
  }
}

// Check if the trailing non-empty line is ^VERDICT:\s*(approve|reject)\s*$ (VERDICT: case-sensitive, value case-insensitive).
// The conductor's convergence protocol requires VERDICT to be the final line — any preceding
// example or explanation that contains VERDICT must not trigger extraction.
function extractVerdict(text) {
  const lines = String(text ?? "").split("\n");
  let lastNonEmpty = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      lastNonEmpty = trimmed;
      break;
    }
  }
  if (!lastNonEmpty || !lastNonEmpty.startsWith("VERDICT:")) return null;
  const value = lastNonEmpty.slice("VERDICT:".length).trim().toLowerCase();
  if (value === "approve" || value === "reject") return value;
  return null;
}

async function spawnClaude(options) {
  const cwd = path.resolve(options.cwd);

  const claudeArgs = [
    "-p",
    "--permission-mode",
    "acceptEdits",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--allowedTools",
    options.allowedTools,
    "--model",
    options.model,
  ];

  if (options.effort) {
    claudeArgs.push("--effort", options.effort);
  }

  claudeArgs.push(options.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn("claude", claudeArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        process.stderr.write(`${INSTALL_HINT}\n`);
        process.exit(127);
      }
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");

      if (stderrText) {
        process.stderr.write(stderrText);
      }

      // Signal-killed subprocesses fire close with exitCode=null; treat as non-zero.
      const effectiveExitCode = exitCode !== null ? exitCode : (signal ? 1 : 0);

      let envelope = null;
      try {
        envelope = JSON.parse(rawStdout);
      } catch {
        // stdout is not valid JSON — always treat as error even when claude exited 0.
        resolve({
          verdict: null,
          body: rawStdout,
          exit_code: effectiveExitCode !== 0 ? effectiveExitCode : 1,
          permission_denials: [],
        });
        return;
      }

      // is_error:true means Claude reported an internal error (auth, budget, etc.).
      if (envelope.is_error === true) {
        resolve({
          verdict: null,
          body: typeof envelope.result === "string" ? envelope.result : "",
          exit_code: effectiveExitCode !== 0 ? effectiveExitCode : 1,
          permission_denials: Array.isArray(envelope.permission_denials)
            ? envelope.permission_denials
            : [],
        });
        return;
      }

      const resultText =
        typeof envelope.result === "string" ? envelope.result : "";
      const verdict = extractVerdict(resultText);
      const permissionDenials = Array.isArray(envelope.permission_denials)
        ? envelope.permission_denials
        : [];

      resolve({
        verdict,
        body: resultText,
        exit_code: effectiveExitCode,
        permission_denials: permissionDenials,
      });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return;
  }

  const options = parseArgs(argv);
  validateOptions(options);

  const result = await spawnClaude(options);

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (result.exit_code !== 0) {
    process.exitCode = result.exit_code;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
