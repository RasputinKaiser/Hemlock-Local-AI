"use strict";

// Bounded subprocess allowlist engine for agentCommands["shell.exec"].
// Pure and testable: resolveExec() validates a payload into an execFile-style
// invocation ({executable, args, cwd, timeoutMs}) or throws with a stable
// error.code. Nothing here spawns — the caller wires the result into runChild.
//
// Hard rules:
//   - argv form only. There is no shell: pipes, redirects, command
//     substitution, env mutation, and privilege wrappers never reach spawn.
//   - cwd resolves inside the thread's workspaceRoot using the same
//     pathWithin canonicalization as threadManager.assertScopedPath.
//   - timeoutMs is capped at EXEC_TIMEOUT_MAX_MS (default
//     EXEC_TIMEOUT_DEFAULT_MS); the caller caps captured output at
//     EXEC_OUTPUT_LIMIT chars per stream and flags `truncated`.

const path = require("node:path");
const { pathWithin } = require("./thread_manager.cjs");

const EXEC_TIMEOUT_MAX_MS = 60000;
const EXEC_TIMEOUT_DEFAULT_MS = 30000;
const EXEC_OUTPUT_LIMIT = 32 * 1024;

function execError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Executables that would defeat argv-form containment (shells, env setters,
// privilege wrappers, command runners). They get a dedicated code so denials
// explain themselves instead of looking like a typo.
const WRAPPER_DENYLIST = new Set([
  "sudo", "doas", "su", "env", "nice", "xargs", "parallel", "watch", "time",
  "sh", "bash", "zsh", "dash", "fish", "csh", "tcsh", "ksh",
  "eval", "exec", "source", "npx", "bun", "deno", "perl", "ruby", "osascript",
  "ssh", "scp", "curl", "wget",
]);

// Standalone argv tokens that only make sense as shell composition. A regex
// like rg -e 'a|b' stays legal — the pipe must be its own token to count.
const SHELL_TOKENS = new Set([
  "|", "||", "&", "&&", ";", ";;", ">", ">>", "<", "<<", "<<<",
  "2>", "2>>", "&>", ">&", "<&", "|&", "\\n",
]);

function assertSafeArg(arg) {
  if (typeof arg !== "string") throw execError("EXEC_BAD_INPUT", "shell.exec args must be strings.");
  if (/[\x00-\x1f]/.test(arg)) throw execError("EXEC_ARG_DENIED", "shell.exec args may not contain control characters.");
  if (SHELL_TOKENS.has(arg)) throw execError("EXEC_ARG_DENIED", `shell.exec rejects shell composition token: ${arg}`);
  if (arg.includes("`") || arg.includes("$(")) {
    throw execError("EXEC_ARG_DENIED", "shell.exec rejects command substitution; argv-form execution has no shell to evaluate it.");
  }
}

// A non-flag arg is potentially a path; it must stay inside the workspace
// root. Flag values glued on with = get the same check when they are
// absolute or contain traversal (rg --pre-path=/x style escapes).
function assertArgScoped(arg, ctx) {
  if (arg.startsWith("-")) {
    const eq = arg.indexOf("=");
    if (eq === -1) return;
    const value = arg.slice(eq + 1);
    if (!value || (!path.isAbsolute(value) && !value.includes(".."))) return;
    const target = path.resolve(ctx.cwd, value);
    if (!pathWithin(ctx.workspaceRoot, target)) {
      throw execError("WORKSPACE_SCOPE", `shell.exec argument escapes the thread workspace: ${arg}`);
    }
    return;
  }
  const target = path.resolve(ctx.cwd, arg);
  if (!pathWithin(ctx.workspaceRoot, target)) {
    throw execError("WORKSPACE_SCOPE", `shell.exec argument escapes the thread workspace: ${arg}`);
  }
}

function assertScriptInsideCwd(arg, ctx, executable) {
  const target = path.resolve(ctx.cwd, arg);
  if (!pathWithin(ctx.cwd, target)) {
    throw execError("WORKSPACE_SCOPE", `${executable} script must resolve inside the scoped cwd: ${arg}`);
  }
  return target;
}

const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "branch", "ls-files", "rev-parse", "blame"]);
// Flags that turn a "read-only" subcommand into a mutation or file write.
const GIT_BRANCH_MUTATION_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "-u", "-f", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description"]);
const GIT_WRITE_FLAGS = new Set(["--output", "--exec", "--exec-path", "--upload-pack", "--receive-pack"]);

function denyFlags(args, denied, owner) {
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (denied.has(flag)) throw execError("EXEC_ARG_DENIED", `${owner} flag is not allowlisted: ${flag}`);
    // Compact short-flag bundles: -dD on git branch still deletes.
    if (/^-[A-Za-z]+$/.test(arg) && arg.length > 2) {
      for (const letter of arg.slice(1)) {
        if (denied.has(`-${letter}`)) throw execError("EXEC_ARG_DENIED", `${owner} flag is not allowlisted: -${letter} (in ${arg})`);
      }
    }
  }
}

const NPM_ALLOWED_SUBCOMMANDS = new Set(["test", "run", "run-script", "lint"]);
// Scope-changing or shell-delegating npm-family flags. --script-shell would
// run every lifecycle script through an arbitrary binary; --prefix/-g/-w
// retarget the command outside the scoped cwd.
const NPM_DENIED_FLAGS = new Set(["--prefix", "--global", "-g", "--script-shell", "--userconfig", "--init-file", "--cache", "--workspace", "-w", "--workspaces", "--exec"]);
const PYTHON_BENIGN_FLAGS = new Set(["-u", "-O", "-OO", "-B", "-q", "-E", "-s", "-S", "-I"]);

const EXEC_ALLOWLIST = Object.freeze({
  git: {
    summary: `git read-only subcommands only: ${[...GIT_READ_ONLY].join(" ")} (no commit/push/checkout/reset/clean/config/apply)`,
    validate(args) {
      const sub = args[0];
      if (!sub || sub.startsWith("-") || !GIT_READ_ONLY.has(sub)) {
        throw execError("EXEC_ARG_DENIED", `git subcommand is not allowlisted: ${sub || "(missing)"}`);
      }
      denyFlags(args.slice(1), GIT_WRITE_FLAGS, "git");
      if (sub === "branch") denyFlags(args.slice(1), GIT_BRANCH_MUTATION_FLAGS, "git branch");
    },
  },
  rg: {
    summary: "ripgrep search; --pre/--pre-path/--hostname-bin are denied because they execute helper binaries",
    validate(args) {
      denyFlags(args, new Set(["--pre", "--pre-path", "--hostname-bin"]), "rg");
    },
  },
  ls: { summary: "directory listing; every non-flag arg must stay inside the workspace", validate() {} },
  cat: { summary: "file read; every non-flag arg must stay inside the workspace", validate() {} },
  head: { summary: "file head; every non-flag arg must stay inside the workspace", validate() {} },
  tail: { summary: "file tail; every non-flag arg must stay inside the workspace", validate() {} },
  wc: { summary: "count lines/words/bytes; every non-flag arg must stay inside the workspace", validate() {} },
  find: {
    summary: "path walking; -exec/-execdir/-ok/-okdir/-delete/-fprint/-fprintf/-fls are denied",
    validate(args) {
      denyFlags(args, new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"]), "find");
    },
  },
  node: {
    summary: "node --version | node --check <script> | node <script> where the script resolves inside the scoped cwd; -e/-p/--eval/-r are denied",
    validate(args, ctx) {
      if (args[0] === "--version") {
        if (args.length !== 1) throw execError("EXEC_ARG_DENIED", "node --version takes no further arguments.");
        return;
      }
      if (args[0] === "--check") {
        if (args.length !== 2) throw execError("EXEC_ARG_DENIED", "node --check needs exactly one script path inside the scoped cwd.");
        assertScriptInsideCwd(args[1], ctx, "node");
        return;
      }
      if (!args[0] || args[0].startsWith("-")) {
        throw execError("EXEC_ARG_DENIED", `node requires a script path inside the scoped cwd; flag args like -e/--eval/-p/-r are not allowlisted: ${args[0] || "(missing)"}`);
      }
      assertScriptInsideCwd(args[0], ctx, "node");
    },
  },
  npm: {
    summary: "npm test | npm run <script> | npm lint; exec/install/publish/uninstall and scope-changing flags are denied",
    validate(args) {
      const sub = args[0];
      if (!sub || sub.startsWith("-") || !NPM_ALLOWED_SUBCOMMANDS.has(sub)) {
        throw execError("EXEC_ARG_DENIED", `npm subcommand is not allowlisted: ${sub || "(missing)"} (only test, run <script>, lint)`);
      }
      if ((sub === "run" || sub === "run-script") && (typeof args[1] !== "string" || !/^[A-Za-z0-9:._-]+$/.test(args[1]))) {
        throw execError("EXEC_ARG_DENIED", "npm run needs a plain script name (npm run <script>).");
      }
      denyFlags(args.slice(1), NPM_DENIED_FLAGS, "npm");
    },
  },
  pnpm: {
    summary: "pnpm test | pnpm run <script> | pnpm lint; same bounds as npm",
    validate(args) { EXEC_ALLOWLIST.npm.validate(args); },
  },
  yarn: {
    summary: "yarn test | yarn run <script> | yarn lint; same bounds as npm",
    validate(args) { EXEC_ALLOWLIST.npm.validate(args); },
  },
  python3: {
    summary: "python3 [-u|-O|-B|-E|-s|-S|-I|-q] <script> where the script resolves inside the scoped cwd; -c/-m/stdin heredoc are denied",
    validate(args, ctx) {
      let index = 0;
      while (index < args.length && args[index].startsWith("-")) {
        if (!PYTHON_BENIGN_FLAGS.has(args[index])) {
          throw execError("EXEC_ARG_DENIED", `python3 flag is not allowlisted: ${args[index]} (no -c, -m, -i, -W, -X, or stdin "-")`);
        }
        index += 1;
      }
      if (!args[index]) throw execError("EXEC_ARG_DENIED", "python3 needs a script path inside the scoped cwd; -c and stdin heredocs are not allowlisted.");
      assertScriptInsideCwd(args[index], ctx, "python3");
    },
  },
});

function resolveCwd(workspaceRoot, cwdValue) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw execError("EXEC_BAD_INPUT", "shell.exec needs a thread workspaceRoot to scope cwd.");
  }
  const root = path.resolve(workspaceRoot);
  const cwd = path.resolve(root, typeof cwdValue === "string" && cwdValue.trim() ? cwdValue : ".");
  // Same canonicalizing scope check as threadManager.assertScopedPath.
  if (!pathWithin(root, cwd)) {
    throw execError("WORKSPACE_SCOPE", `shell.exec cwd escapes the thread workspace: ${cwdValue}`);
  }
  return { workspaceRoot: root, cwd };
}

function resolveExec(payload = {}, { workspaceRoot } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw execError("EXEC_BAD_INPUT", "shell.exec payload must be an object like {command, args?, cwd?, timeoutMs?}.");
  }
  const command = String(payload.command || payload.executable || "").trim();
  if (!command) throw execError("EXEC_BAD_INPUT", "shell.exec needs a command name.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(command)) {
    throw execError("EXEC_BAD_INPUT", `shell.exec takes a bare executable name, not shell text or a path: ${command}`);
  }
  if (WRAPPER_DENYLIST.has(command)) {
    throw execError("EXEC_WRAPPER_DENIED", `shell.exec never runs shells, env wrappers, or privilege tools: ${command}`);
  }
  const entry = EXEC_ALLOWLIST[command];
  if (!entry) {
    throw execError("EXEC_NOT_ALLOWLISTED", `shell.exec command is not allowlisted: ${command}`);
  }
  const args = payload.args == null ? [] : payload.args;
  if (!Array.isArray(args)) throw execError("EXEC_BAD_INPUT", "shell.exec args must be an array of strings.");
  const ctx = resolveCwd(workspaceRoot, payload.cwd);
  for (const arg of args) assertSafeArg(arg);
  entry.validate(args, ctx);
  for (const arg of args) assertArgScoped(arg, ctx);
  const requested = Number(payload.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(EXEC_TIMEOUT_MAX_MS, Math.round(requested))
    : EXEC_TIMEOUT_DEFAULT_MS;
  return { executable: command, args: [...args], cwd: ctx.cwd, workspaceRoot: ctx.workspaceRoot, timeoutMs };
}

module.exports = {
  EXEC_ALLOWLIST,
  EXEC_OUTPUT_LIMIT,
  EXEC_TIMEOUT_DEFAULT_MS,
  EXEC_TIMEOUT_MAX_MS,
  resolveExec,
};
