import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("Chat keeps the window frame fixed and the message history scrollable", () => {
  assert.match(styles, /\.window-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(styles, /\.chat-surface\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;[^}]*overflow:\s*hidden\s*!important;/s);
  assert.match(styles, /\.chat-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.chat-compose\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.objective-collapse summary\s*\{[^}]*-webkit-line-clamp:\s*3;/s);
  assert.match(styles, /\.objective-collapse \.objective-full\s*\{[^}]*white-space:\s*pre-wrap;/s);
});
