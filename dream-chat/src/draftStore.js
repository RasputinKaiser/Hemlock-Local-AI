// Per-thread composer draft persistence. localStorage may be unavailable
// (browser preview quirks, private modes, tests) — every helper degrades to a
// no-op instead of throwing, because losing a draft store must never break
// the composer.

export const DRAFT_KEY_PREFIX = "hemlock.draft.";

export function draftKey(threadId) {
  return `${DRAFT_KEY_PREFIX}${String(threadId ?? "")}`;
}

export function readDraft(storage, threadId) {
  if (!threadId || !storage) return "";
  try {
    return storage.getItem(draftKey(threadId)) || "";
  } catch {
    return "";
  }
}

// Blank drafts remove the key — "cleared on send" is just a write of "".
export function writeDraft(storage, threadId, text) {
  if (!threadId || !storage) return false;
  try {
    const value = String(text ?? "");
    if (value.trim()) storage.setItem(draftKey(threadId), value);
    else storage.removeItem(draftKey(threadId));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage, threadId) {
  return writeDraft(storage, threadId, "");
}
