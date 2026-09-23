"use strict";

// Shared durable-IO helpers for the files the host treats as authoritative
// (settings.json, state.json, registries, checkpoints, receipts, journals).
//
// Rules enforced here:
//  * Writes are temp-file + fsync + rename, so a crash mid-write can never
//    leave a truncated or half-mixed file behind.
//  * Reads validate-on-read: a file that exists but does not parse is
//    quarantined (renamed to `<file>.corrupt-<ts>`, never deleted) and the
//    caller rebuilds from its fallback — validating on read instead of
//    crashing on boot.
//  * Every recovery is reported through the caller's `onIntegrity` hook so
//    the host can journal a durable `integrity.recovered` event naming the
//    file and what was lost.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function reportIntegrity(onIntegrity, recovery) {
  if (typeof onIntegrity !== "function") return;
  try {
    onIntegrity(recovery);
  } catch {
    // Integrity reporting must never break the caller's recovery path.
  }
}

// Rename the corrupt file aside — never delete. Returns the quarantine path
// or null when the rename itself failed (the file is left in place then).
function quarantineCorruptFile(filePath) {
  const target = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch {
    return null;
  }
}

// Temp + fsync + rename: the reader never observes a partially written file.
// A random suffix keeps two same-ms writers from sharing one temp path.
function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// Journals are append-only: a rename cannot protect a single line, so the
// honest durability bound is write + fsync. A torn tail line (killed between
// write and fsync) is what readJsonlFile's per-line recovery is for.
function appendJsonlLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, "a");
  try {
    fs.writeFileSync(handle, `${typeof value === "string" ? value : JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

// Read a JSON document that may be corrupt. A missing/unreadable file is not
// corruption — the fallback is used silently. A file that exists but does not
// parse is quarantined and reported; `backupPath` (when provided) is tried as
// the last-good copy before falling back.
function readJsonFile(filePath, fallback, { label = null, onIntegrity = null, backupPath = null, quarantine = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 300);
    if (backupPath) {
      try {
        const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
        if (quarantine) quarantineCorruptFile(filePath);
        reportIntegrity(onIntegrity, { file: filePath, label, reason: "invalid-json", error: detail, recovered: "last-good-backup", backupPath });
        return backup;
      } catch {
        // No usable backup — fall through to defaults.
      }
    }
    const quarantinePath = quarantine ? quarantineCorruptFile(filePath) : null;
    reportIntegrity(onIntegrity, { file: filePath, label, reason: "invalid-json", error: detail, recovered: "defaults", quarantinePath });
    return fallback;
  }
}

// Read a JSONL journal tolerantly. Good lines survive a torn tail; unparseable
// lines are counted and reported. Only when EVERY line is unparseable is the
// whole file quarantined — partial corruption keeps the valid prefix.
function readJsonlFile(filePath, { tail = null, schema = null, label = null, onIntegrity = null } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return { rows: [], count: 0, dropped: 0, quarantined: false };
  }
  if (Number.isFinite(tail) && tail > 0) lines = lines.slice(-Math.floor(tail));
  const rows = [];
  let dropped = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!schema || parsed?.schema === schema) rows.push(parsed);
    } catch {
      dropped += 1;
    }
  }
  let quarantined = false;
  if (dropped > 0) {
    quarantined = rows.length === 0;
    const quarantinePath = quarantined ? quarantineCorruptFile(filePath) : null;
    reportIntegrity(onIntegrity, {
      file: filePath,
      label,
      reason: "invalid-jsonl-lines",
      droppedLines: dropped,
      keptLines: rows.length,
      recovered: quarantined ? "quarantined-empty" : "kept-valid-lines",
      quarantinePath,
    });
  }
  return { rows, count: rows.length, dropped, quarantined };
}

module.exports = {
  appendJsonlLine,
  quarantineCorruptFile,
  readJsonFile,
  readJsonlFile,
  writeFileAtomic,
  writeJsonAtomic,
};
