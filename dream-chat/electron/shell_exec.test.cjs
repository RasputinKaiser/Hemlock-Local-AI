"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EXEC_ALLOWLIST,
  EXEC_OUTPUT_LIMIT,
  EXEC_TIMEOUT_DEFAULT_MS,
  EXEC_TIMEOUT_MAX_MS,
  resolveExec,
} = require("./shell_exec.cjs");

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-shell-exec-"));
fs.mkdirSync(path.join(workspaceRoot, "sub", "deeper"), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, "script.js"), "console.log(1);\n");
fs.writeFileSync(path.join(workspaceRoot, "sub", "tool.py"), "print(1)\n");

function denied(fn, code) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected resolveExec to throw");
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

test("accepts git read-only subcommands", () => {
  const resolved = resolveExec({ command: "git", args: ["status", "--short"] }, { workspaceRoot });
  assert.equal(resolved.executable, "git");
  assert.deepEqual(resolved.args, ["status", "--short"]);
  assert.equal(resolved.cwd, workspaceRoot);
  assert.equal(resolved.timeoutMs, EXEC_TIMEOUT_DEFAULT_MS);
  for (const sub of ["diff", "log", "show", "branch", "ls-files", "rev-parse", "blame"]) {
    resolveExec({ command: "git", args: [sub] }, { workspaceRoot });
  }
});

test("rejects git mutating subcommands and mutating branch flags", () => {
  for (const sub of ["push", "commit", "checkout", "reset", "clean", "config", "apply", "fetch", "pull", "merge", "rebase", "add", "rm", "mv", "tag", "stash"]) {
    denied(() => resolveExec({ command: "git", args: [sub] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  }
  denied(() => resolveExec({ command: "git", args: ["branch", "-D", "topic"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "git", args: ["branch", "--delete", "topic"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "git", args: ["diff", "--output=/tmp/x.patch"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "git", args: ["-C", ".", "status"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
});

test("accepts search/inspection binaries and rejects their exec-capable flags", () => {
  resolveExec({ command: "rg", args: ["--line-number", "needle", "sub"] }, { workspaceRoot });
  resolveExec({ command: "rg", args: ["-e", "a|b"] }, { workspaceRoot }); // regex pipes stay legal
  denied(() => resolveExec({ command: "rg", args: ["--pre", "cat", "x"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "rg", args: ["--pre=/bin/cat", "x"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  resolveExec({ command: "ls", args: ["-la", "sub"] }, { workspaceRoot });
  resolveExec({ command: "cat", args: ["script.js"] }, { workspaceRoot });
  resolveExec({ command: "head", args: ["-n", "5", "script.js"] }, { workspaceRoot });
  resolveExec({ command: "tail", args: ["-n", "5", "script.js"] }, { workspaceRoot });
  resolveExec({ command: "wc", args: ["-l", "script.js"] }, { workspaceRoot });
  resolveExec({ command: "find", args: [".", "-name", "*.js"] }, { workspaceRoot });
  denied(() => resolveExec({ command: "find", args: [".", "-name", "*.js", "-delete"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "find", args: [".", "-exec", "rm", "{}", ";"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
});

test("node: only --version, --check <script>, or a script inside cwd", () => {
  resolveExec({ command: "node", args: ["--version"] }, { workspaceRoot });
  resolveExec({ command: "node", args: ["--check", "script.js"] }, { workspaceRoot });
  resolveExec({ command: "node", args: ["script.js", "--flag-for-script"] }, { workspaceRoot });
  denied(() => resolveExec({ command: "node", args: ["-e", "process.exit(1)"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "node", args: ["--eval", "1"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "node", args: ["-p", "1"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "node", args: ["-r", "./preload.js", "script.js"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "node", args: ["../../etc/passwd"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
  // Spec is strict: the script must resolve inside cwd, not merely the workspace.
  denied(() => resolveExec({ command: "node", args: ["../script.js"], cwd: "sub" }, { workspaceRoot }), "WORKSPACE_SCOPE");
  resolveExec({ command: "node", args: ["deeper/tool.js"], cwd: "sub" }, { workspaceRoot });
});

test("python3: script inside cwd only; -c and stdin heredoc are blocked", () => {
  resolveExec({ command: "python3", args: ["sub/tool.py"] }, { workspaceRoot });
  resolveExec({ command: "python3", args: ["-u", "sub/tool.py"] }, { workspaceRoot });
  denied(() => resolveExec({ command: "python3", args: ["-c", "import os"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "python3", args: ["-"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "python3", args: ["-m", "http.server"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "python3", args: ["/etc/passwd"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
});

test("npm-family: test/run/lint only; install/exec/publish and scope flags denied", () => {
  for (const pm of ["npm", "pnpm", "yarn"]) {
    resolveExec({ command: pm, args: ["test"] }, { workspaceRoot });
    resolveExec({ command: pm, args: ["run", "build"] }, { workspaceRoot });
    resolveExec({ command: pm, args: ["lint"] }, { workspaceRoot });
    denied(() => resolveExec({ command: pm, args: ["install"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["install", "left-pad"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["exec", "cowsay"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["publish"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["uninstall", "x"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["run"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["test", "--script-shell", "/bin/sh"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
    denied(() => resolveExec({ command: pm, args: ["test", "--prefix", "/tmp"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  }
});

test("rejects shell composition, wrappers, and non-bare commands", () => {
  denied(() => resolveExec({ command: "git", args: ["status", "|", "wc", "-l"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "git", args: ["status", "&&", "ls"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "ls", args: ["sub", ">", "out.txt"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "ls", args: ["$(id)"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "ls", args: ["sub\n/etc"] }, { workspaceRoot }), "EXEC_ARG_DENIED");
  denied(() => resolveExec({ command: "sudo", args: ["ls"] }, { workspaceRoot }), "EXEC_WRAPPER_DENIED");
  denied(() => resolveExec({ command: "bash", args: ["-c", "ls"] }, { workspaceRoot }), "EXEC_WRAPPER_DENIED");
  denied(() => resolveExec({ command: "env", args: ["FOO=1", "ls"] }, { workspaceRoot }), "EXEC_WRAPPER_DENIED");
  denied(() => resolveExec({ command: "npx", args: ["cowsay"] }, { workspaceRoot }), "EXEC_WRAPPER_DENIED");
  denied(() => resolveExec({ command: "git status" }, { workspaceRoot }), "EXEC_BAD_INPUT");
  denied(() => resolveExec({ command: "/bin/ls", args: [] }, { workspaceRoot }), "EXEC_BAD_INPUT");
  denied(() => resolveExec({ command: "../../bin/sh" }, { workspaceRoot }), "EXEC_BAD_INPUT");
  denied(() => resolveExec({ command: "rm", args: ["-rf", "."] }, { workspaceRoot }), "EXEC_NOT_ALLOWLISTED");
  denied(() => resolveExec({ command: "git", args: "status" }, { workspaceRoot }), "EXEC_BAD_INPUT");
});

test("path args and cwd must stay inside the thread workspace", () => {
  denied(() => resolveExec({ command: "cat", args: ["/etc/passwd"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "cat", args: ["../../etc/passwd"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "cat", args: ["/private/etc/passwd"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "tail", args: ["-f", "/var/log/system.log"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "find", args: ["/usr", "-name", "x"] }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "ls", cwd: "../" }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "ls", cwd: "/tmp" }, { workspaceRoot }), "WORKSPACE_SCOPE");
  denied(() => resolveExec({ command: "ls", cwd: "sub/../../.." }, { workspaceRoot }), "WORKSPACE_SCOPE");
  const nested = resolveExec({ command: "ls", args: ["deeper"], cwd: "sub" }, { workspaceRoot });
  assert.equal(nested.cwd, path.join(workspaceRoot, "sub"));
  denied(() => resolveExec({ command: "ls" }, {}), "EXEC_BAD_INPUT");
});

test("timeoutMs is capped at 60s and defaults to 30s", () => {
  assert.equal(resolveExec({ command: "git", args: ["status"] }, { workspaceRoot }).timeoutMs, EXEC_TIMEOUT_DEFAULT_MS);
  assert.equal(resolveExec({ command: "git", args: ["status"], timeoutMs: 999999 }, { workspaceRoot }).timeoutMs, EXEC_TIMEOUT_MAX_MS);
  assert.equal(resolveExec({ command: "git", args: ["status"], timeoutMs: 5000 }, { workspaceRoot }).timeoutMs, 5000);
  assert.equal(EXEC_OUTPUT_LIMIT, 32 * 1024);
});

test("EXEC_ALLOWLIST describes every allowed binary", () => {
  for (const name of ["git", "rg", "ls", "cat", "head", "tail", "wc", "find", "node", "npm", "pnpm", "yarn", "python3"]) {
    assert.ok(EXEC_ALLOWLIST[name], `missing allowlist entry for ${name}`);
    assert.equal(typeof EXEC_ALLOWLIST[name].summary, "string");
    assert.equal(typeof EXEC_ALLOWLIST[name].validate, "function");
  }
});

// --- Wiring guards (main.cjs has no test export seam — same convention as
// maple_notify.test.cjs / agent_orchestrator.test.cjs) ---
const mainSource = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");

test("main.cjs registers shell.exec plan-gated with a verify capability", () => {
  assert.match(mainSource, /"shell\.exec":\s*\{\s*label:\s*"Run a bounded workspace command",\s*capability:\s*"verify",\s*auto:\s*false,\s*approval:\s*"plan",\s*timeoutMs:\s*60000,\s*countsAgainstBudget:\s*true/);
  assert.match(mainSource, /command === "shell\.exec"/);
  assert.match(mainSource, /"hemlock\.agent\.exec\.v1"/);
  assert.match(mainSource, /"receipts",\s*"exec"/);
  assert.match(mainSource, /require\("\.\/shell_exec\.cjs"\)/);
});

test("main.cjs keeps artifact.author and artifact.update plan-gated", () => {
  assert.match(mainSource, /"artifact\.author":\s*\{[^}]*approval:\s*"plan"/, "artifact.author must be plan-gated, not explicit");
  assert.match(mainSource, /"artifact\.update":\s*\{[^}]*approval:\s*"plan"/, "artifact.update must be plan-gated, not explicit");
});

test("main.cjs forwards assistantPrefix as assistant_prefix with a one-shot 400 fallback", () => {
  assert.match(mainSource, /assistantPrefix/);
  assert.match(mainSource, /assistant_prefix/);
  assert.match(mainSource, /status === 400 && assistantPrefix/, "the retry must only fire on a 400 that names the field");
});

test("main.cjs adds lint, typecheck (tsconfig-gated), and npm-test verification profiles", () => {
  assert.match(mainSource, /"lint":\s*\{[^}]*command:\s*"npm run lint --if-present"/);
  assert.match(mainSource, /"typecheck":\s*\{[^}]*command:\s*"npx tsc --noEmit"/);
  assert.match(mainSource, /requires:\s*\["tsconfig\.json"\]/, "typecheck must declare its tsconfig precondition");
  assert.match(mainSource, /"npm-test":\s*\{[^}]*command:\s*"npm test"/);
});
