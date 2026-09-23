import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError, stripTransportWrapper } from "./friendlyError.js";

test("stripTransportWrapper removes the Electron IPC wrapper", () => {
  assert.equal(
    stripTransportWrapper("Error invoking remote method 'agent:runCommand': Error: plan rejected"),
    "plan rejected",
  );
  assert.equal(stripTransportWrapper("plain message"), "plain message");
  assert.equal(stripTransportWrapper(""), "");
});

test("server-side failures map to a plain retryable line", () => {
  for (const raw of [
    "Maple-Preview returned HTTP 500: internal fault",
    "Error invoking remote method 'agent:runCommand': Error: RUNTIME_UNAVAILABLE",
    "server exited before becoming ready",
  ]) {
    const friendly = friendlyError(raw);
    assert.equal(friendly.kind, "server-error", raw);
    assert.equal(friendly.retryable, true);
    assert.match(friendly.line, /internal error|server/i);
    assert.ok(friendly.detail.length > 0);
  }
});

test("transport deaths and timeouts stay distinct and honest", () => {
  assert.equal(friendlyError("fetch failed").kind, "transport");
  assert.equal(friendlyError("TypeError: terminated").kind, "transport");
  assert.equal(friendlyError("connect ECONNREFUSED 127.0.0.1:8000").kind, "transport");
  const timeout = friendlyError("request timed out after 180000ms");
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.retryable, true);
});

test("HTTP statuses classify without inventing causes", () => {
  assert.equal(friendlyError("Maple-Preview returned HTTP 404: no route").kind, "endpoint-not-found");
  assert.equal(friendlyError("HTTP 400: bad input").kind, "rejected");
  assert.equal(friendlyError("HTTP 404").retryable, false);
});

test("cancelled and malformed envelopes get their own copy", () => {
  assert.equal(friendlyError("Error: cancelled").kind, "cancelled");
  assert.equal(friendlyError("two invalid action envelopes").kind, "action-envelope");
  assert.equal(friendlyError("not a valid MLX checkpoint").kind, "model-invalid");
});

test("unknown errors keep the raw detail for the disclosure", () => {
  const friendly = friendlyError("something bespoke exploded");
  assert.equal(friendly.kind, "unknown");
  assert.equal(friendly.detail, "something bespoke exploded");
  assert.equal(friendly.raw, "something bespoke exploded");
  const empty = friendlyError("");
  assert.equal(empty.detail, "No detail was recorded.");
});
