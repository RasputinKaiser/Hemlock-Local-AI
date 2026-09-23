import test from "node:test";
import assert from "node:assert/strict";
import { parseSlashCommand, prefixMode, resolveSlashCommand, slashCommandList, SLASH_COMMANDS } from "./chatCommands.js";

test("prefixMode recognizes the host's real prefixes", () => {
  assert.equal(prefixMode("steer: try a different approach")?.mode, "steer");
  assert.equal(prefixMode("Steering - adjust scope")?.mode, "steer");
  assert.equal(prefixMode("campaign: keep improving")?.mode, "campaign");
  assert.equal(prefixMode("auto: run the suite")?.mode, "campaign");
  assert.equal(prefixMode("autonomous: go")?.mode, "campaign");
  assert.equal(prefixMode("queue: later task")?.mode, "queue");
});

test("prefixMode returns the body and never invents a mode", () => {
  assert.deepEqual(prefixMode("steer:  focus on tests  ")?.body, "focus on tests");
  assert.equal(prefixMode("just a message"), null);
  assert.equal(prefixMode("a steer: mid-sentence mention"), null);
  assert.equal(prefixMode(""), null);
  assert.equal(prefixMode(null), null);
  assert.equal(prefixMode("/clear"), null);
});

test("queue: hint stays honest that the prefix is sent verbatim", () => {
  const hint = prefixMode("queue: follow-up");
  assert.equal(hint.prefix, "queue:");
  assert.match(hint.hint, /verbatim/);
});

test("parseSlashCommand only intercepts a leading slash token", () => {
  assert.deepEqual(parseSlashCommand("/clear"), { name: "clear", args: "" });
  assert.deepEqual(parseSlashCommand("/stop now"), { name: "stop", args: "now" });
  assert.equal(parseSlashCommand("tell me /about this"), null);
  assert.equal(parseSlashCommand("not a command"), null);
  assert.equal(parseSlashCommand("/"), null);
  assert.equal(parseSlashCommand("/123"), null);
  assert.equal(parseSlashCommand(""), null);
});

test("resolveSlashCommand knows the allowlist and rejects the rest", () => {
  for (const name of ["clear", "stop", "retry", "help", "settings", "receipts", "activity", "memory"]) {
    assert.ok(resolveSlashCommand(name), name);
  }
  assert.equal(resolveSlashCommand("Clear"), SLASH_COMMANDS.find((command) => command.name === "clear"));
  assert.equal(resolveSlashCommand("foo"), null);
  assert.equal(resolveSlashCommand(""), null);
});

test("slashCommandList names every registered command for the unknown notice", () => {
  const list = slashCommandList();
  for (const command of SLASH_COMMANDS) assert.ok(list.includes(`/${command.name}`), command.name);
  assert.match(list, /\/clear/);
});
