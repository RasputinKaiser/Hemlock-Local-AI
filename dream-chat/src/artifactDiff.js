// Per-file line diff for ArtifactStudio — a real LCS diff, replacing the old
// index-zip that produced phantom add/remove pairs for any insertion.

// Above this cell count the DP table gets too heavy for a UI aid; the middle
// (post prefix/suffix trim) is reported as a plain replace block instead.
const MAX_LCS_CELLS = 400000;

export function diffLines(beforeText, afterText) {
  const a = String(beforeText ?? "").split("\n");
  const b = String(afterText ?? "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: "same", text: a[i], before: i + 1, after: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length && midB.length && midA.length * midB.length <= MAX_LCS_CELLS) {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = midA[i] === midB[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: "same", text: midA[i], before: start + i + 1, after: start + j + 1 });
        i += 1; j += 1;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        ops.push({ type: "removed", text: midA[i], before: start + i + 1 });
        i += 1;
      } else {
        ops.push({ type: "added", text: midB[j], after: start + j + 1 });
        j += 1;
      }
    }
    while (i < n) { ops.push({ type: "removed", text: midA[i], before: start + i + 1 }); i += 1; }
    while (j < m) { ops.push({ type: "added", text: midB[j], after: start + j + 1 }); j += 1; }
  } else {
    midA.forEach((text, i) => ops.push({ type: "removed", text, before: start + i + 1 }));
    midB.forEach((text, j) => ops.push({ type: "added", text, after: start + j + 1 }));
  }

  for (let k = 0; k < a.length - endA; k += 1) {
    ops.push({ type: "same", text: a[endA + k], before: endA + k + 1, after: endB + k + 1 });
  }
  return ops;
}

// One compare entry: { file, before, after } — before/after are null when the
// file only exists on one side of the revision pair.
export function diffFile(file) {
  const before = file?.before ?? null;
  const after = file?.after ?? null;
  let ops;
  if (before === null && after === null) ops = [];
  else if (before === null) ops = String(after).split("\n").map((text, i) => ({ type: "added", text, after: i + 1 }));
  else if (after === null) ops = String(before).split("\n").map((text, i) => ({ type: "removed", text, before: i + 1 }));
  else ops = diffLines(before, after);
  const added = ops.filter((op) => op.type === "added").length;
  const removed = ops.filter((op) => op.type === "removed").length;
  return {
    file: file?.file || "file",
    ops,
    added,
    removed,
    changed: added > 0 || removed > 0,
    isNew: before === null && after !== null,
    isDeleted: after === null && before !== null,
  };
}

export function diffFiles(files) {
  return (Array.isArray(files) ? files : []).map(diffFile);
}
