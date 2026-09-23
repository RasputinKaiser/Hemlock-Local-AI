import { memo, useEffect, useState } from "react";
import { Icon } from "../components/Icons.jsx";
import {
  GlossaryHint,
  StatusLamp,
  displayText,
  formatRelativeTime,
} from "./shared.jsx";
import {
  checkpointRows,
  conversationPreview,
  resolveSelectedThread,
  searchResultRows,
  splitThreads,
  taskHistoryLabel,
  threadActions,
  threadStatusLamp,
} from "../threadWindow.js";

// Threads management surface: the full registry (open + archived), host-side
// search via `thread.search`, and a detail pane that reads the durable
// checkpoint list and conversation tail for the selected thread. Every action
// routes through ctx.runCommand — nothing here touches the filesystem.
export const ThreadsWindow = memo(function ThreadsWindow({ ctx }) {
  const threads = Array.isArray(ctx.threadRegistry?.threads) ? ctx.threadRegistry.threads : [];
  const activeId = ctx.task?.threadId || ctx.threadRegistry?.activeThreadId || null;
  const sections = splitThreads(threads);
  const [selectedId, setSelectedId] = useState(null);
  const selected = resolveSelectedThread(threads, selectedId, activeId);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState({ status: "idle", results: [] });
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [forkNote, setForkNote] = useState(null); // { sourceId, thread }
  const busy = Boolean(ctx.commandBusy);

  // Detail loads: checkpoints + conversation tail ride App-scope ctx maps so
  // a refresh from anywhere (a restore, a new marker) lands here too.
  useEffect(() => {
    if (!ctx.isDesktop || !selected?.id) return;
    void ctx.loadThreadCheckpoints(selected.id);
    void ctx.loadThreadConversation(selected.id);
  }, [ctx.isDesktop, selected?.id]);

  // Host-side search — `thread.search` scans titles and conversation bodies on
  // the host, so the window never holds the corpus. Debounced like the
  // palette's own probe.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || !ctx.isDesktop) {
      setSearchState({ status: "idle", results: [] });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearchState({ status: "searching", results: [] });
      void ctx.runCommand("thread.search", { query: trimmed, limit: 10 }).then((result) => {
        if (cancelled) return;
        setSearchState({ status: "done", results: searchResultRows(result?.results) });
      });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, ctx.isDesktop]);

  async function submitRename(event) {
    event?.preventDefault();
    const title = renameValue.trim();
    setRenaming(false);
    setRenameValue("");
    if (!title || !selected) return;
    const result = await ctx.runCommand("thread.rename", { threadId: selected.id, title });
    if (result?.thread) await ctx.refreshThreadRegistry();
  }

  async function runFork() {
    if (!selected) return;
    const thread = await ctx.forkThread(selected.id);
    if (thread?.id) {
      setForkNote({ sourceId: selected.id, thread });
      setSelectedId(thread.id);
    }
  }

  const renderThreadRow = (thread) => {
    const isActive = thread.id === activeId;
    const isSelected = thread.id === selected?.id;
    const archived = thread.status === "archived";
    return <button
      type="button"
      key={thread.id}
      className={`thread-item${isSelected ? " is-selected" : ""}${archived ? " is-archived" : ""}`}
      aria-current={isActive ? "true" : undefined}
      onClick={() => setSelectedId(thread.id)}
    >
      <span className="thread-item-head">
        <strong>{displayText(thread.title, "Untitled thread")}</strong>
        <StatusLamp state={threadStatusLamp(thread.status)} label={displayText(thread.status, "ready")} />
      </span>
      <span className="thread-item-meta">
        <span>{displayText(thread.provider, "maple")}</span>
        <span>{formatRelativeTime(thread.updatedAt) || "—"}</span>
        {taskHistoryLabel(thread) ? <span>{taskHistoryLabel(thread)}</span> : null}
        {thread.forkedFrom ? <span className="thread-item-fork" title={`Forked from ${thread.forkedFrom}`}>fork</span> : null}
        {isActive ? <span className="thread-item-active">active</span> : null}
      </span>
      <span className="thread-item-path">{displayText(thread.workspaceRoot, "No workspace")}</span>
    </button>;
  };

  const renderDetail = () => {
    if (!selected) {
      return <div className="threads-detail-empty"><Icon name="chat" size={26} /><p className="empty-copy">{ctx.isDesktop ? "Select a thread to inspect its checkpoints and conversation." : "Threads, checkpoints, and conversations live in the Hemlock desktop app — this browser view is a preview."}</p></div>;
    }
    const actions = threadActions(selected, activeId);
    const checkpoints = checkpointRows(ctx.threadCheckpoints?.[selected.id], { currentCheckpointId: selected.checkpointId });
    const conversation = conversationPreview(ctx.threadConversations?.[selected.id], { limit: 40 });
    const forkSource = selected.forkedFrom ? threads.find((item) => item.id === selected.forkedFrom) : null;
    return <>
      {forkNote ? <div className="thread-fork-note" role="status">
        <Icon name="copy" size={13} />
        <span>Forked <strong>{displayText(forkNote.thread.title)}</strong> from {displayText(threads.find((item) => item.id === forkNote.sourceId)?.title || forkNote.sourceId)}.</span>
        <button type="button" className="quiet-action" onClick={() => void ctx.switchThread(forkNote.thread.id)}>Switch to fork</button>
        <button type="button" className="thread-fork-dismiss" aria-label="Dismiss fork note" onClick={() => setForkNote(null)}><Icon name="close" size={12} /></button>
      </div> : null}
      <div className="threads-detail-head">
        {renaming
          ? <form className="threads-rename" onSubmit={(event) => void submitRename(event)}>
              <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="Thread title" autoFocus maxLength={160} />
              <button type="submit" className="quiet-action" disabled={busy || !renameValue.trim()}>Save</button>
              <button type="button" className="quiet-action" onClick={() => { setRenaming(false); setRenameValue(""); }}>Cancel</button>
            </form>
          : <h3>{displayText(selected.title, "Untitled thread")}
              <button type="button" className="threads-icon-action" aria-label="Rename thread" title="Rename thread" disabled={!ctx.isDesktop || busy} onClick={() => { setRenameValue(selected.title || ""); setRenaming(true); }}><Icon name="pencil" size={13} /></button>
            </h3>}
        <StatusLamp state={threadStatusLamp(selected.status)} label={displayText(selected.status, "ready")} />
      </div>
      <dl className="threads-facts">
        <div><dt>Provider</dt><dd>{displayText(selected.provider, "maple")}{selected.model ? ` · ${displayText(selected.model)}` : ""}</dd></div>
        <div><dt>Autonomy</dt><dd>{displayText(selected.autonomy, "bounded-local")}</dd></div>
        <div><dt>Phase</dt><dd>{displayText(selected.phase, "conversation")}</dd></div>
        <div><dt>Workspace</dt><dd className="threads-fact-path">{displayText(selected.workspaceRoot, "—")}</dd></div>
        <div><dt>Task</dt><dd>{displayText(selected.taskId, "—")}{taskHistoryLabel(selected) ? ` · ${taskHistoryLabel(selected)}` : ""}</dd></div>
        {selected.forkedFrom ? <div><dt>Forked from</dt><dd><button type="button" className="threads-link" onClick={() => setSelectedId(selected.forkedFrom)} title="Open the source thread">{displayText(forkSource?.title || selected.forkedFrom)}</button></dd></div> : null}
        <div><dt>Updated</dt><dd>{formatRelativeTime(selected.updatedAt) || "—"}{selected.archivedAt ? ` · archived ${formatRelativeTime(selected.archivedAt)}` : ""}</dd></div>
        {selected.blockedReason ? <div><dt>Note</dt><dd>{displayText(selected.blockedReason)}</dd></div> : null}
      </dl>
      <div className="threads-actions">
        <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy || !actions.canSwitch} title={actions.canSwitch ? "Make this the active thread" : selected.id === activeId ? "Already the active thread" : "Restore archived threads before switching"} onClick={() => void ctx.switchThread(selected.id)}><Icon name="chat" size={13} /> Switch</button>
        {actions.canPause ? <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy} onClick={() => void ctx.pauseThread(selected.id)}><Icon name="pause" size={13} /> Pause</button> : null}
        {actions.canResume ? <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy} title="Resume checks the workspace has not drifted since the last checkpoint" onClick={() => void ctx.resumeThread(selected.id)}><Icon name="play" size={13} /> Resume</button> : null}
        {actions.canArchive ? <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy} onClick={() => void ctx.archiveThread(selected.id)}><Icon name="archive" size={13} /> Archive</button> : null}
        {actions.canRestore ? <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy} onClick={() => void ctx.restoreThread(selected.id)}><Icon name="refresh" size={13} /> Restore</button> : null}
        <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy} title="Mint a sibling thread with provenance back to this one" onClick={() => void runFork()}><Icon name="copy" size={13} /> Fork</button>
        {actions.canCancel ? <button type="button" className="quiet-action threads-danger" disabled={!ctx.isDesktop || busy} title="Terminal — the thread cannot be resumed" onClick={() => void ctx.cancelThread(selected.id)}><Icon name="stop" size={13} /> Cancel</button> : null}
        <button type="button" className="quiet-action threads-danger" disabled={!ctx.isDesktop || busy} title="Remove the thread, its checkpoints, and its conversation" onClick={() => void ctx.deleteThread(selected.id)}><Icon name="close" size={13} /> Delete</button>
      </div>
      <section className="threads-section">
        <div className="section-title"><span><Icon name="receipt" size={14} />Checkpoints</span><em>{checkpoints.length ? `${checkpoints.length} recorded` : "none"}</em></div>
        {checkpoints.length ? <div className="checkpoint-list">{checkpoints.map((checkpoint) => <div className={`checkpoint-row${checkpoint.isCurrent ? " is-current" : ""}`} key={checkpoint.id}>
          <div className="checkpoint-row-main">
            <strong>{displayText(checkpoint.phase || checkpoint.status, "state")}</strong>
            <span>{[checkpoint.status, checkpoint.isRestoreMarker ? "marker" : null, checkpoint.reason].filter(Boolean).join(" · ")}</span>
          </div>
          <time title={checkpoint.createdAt || ""}>{formatRelativeTime(checkpoint.createdAt) || "—"}</time>
          <button type="button" className="quiet-action" disabled={!ctx.isDesktop || busy || selected.status === "archived"} title={selected.status === "archived" ? "Restore the thread before rolling back" : "Roll this thread back to the recorded state"} onClick={() => void ctx.restoreThreadCheckpoint(selected.id, checkpoint.id)}>Restore</button>
        </div>)}</div> : <p className="empty-copy">No checkpoints recorded for this thread yet.</p>}
      </section>
      <section className="threads-section">
        <div className="section-title"><span><Icon name="chat" size={14} />Conversation</span><em>{conversation.length ? `last ${conversation.length}` : "empty"}</em></div>
        {conversation.length ? <div className="threads-conversation">{conversation.map((message) => <div className={`threads-message role-${message.role}`} key={message.id}>
          <span className="threads-message-role">{message.role}</span>
          <p>{displayText(message.text, "")}</p>
          <time title={message.createdAt || ""}>{formatRelativeTime(message.createdAt)}</time>
        </div>)}</div> : <p className="empty-copy">No conversation recorded for this thread.</p>}
      </section>
    </>;
  };

  return <div className="threads-surface">
    <div className="surface-intro">
      <div><span className="eyebrow"><Icon name="chat" size={13} /> LOCAL THREADS</span><h2>Threads</h2></div>
      <div className="threads-intro-actions">
        <button type="button" className="quiet-action" onClick={() => void ctx.refreshThreadRegistry()} disabled={!ctx.isDesktop || busy} title="Re-read the thread registry"><Icon name="refresh" size={12} /> Refresh</button>
        <button type="button" className="quiet-action" onClick={() => void ctx.createThread()} disabled={!ctx.isDesktop || busy} title="Create a new thread"><Icon name="plus" size={13} /> New</button>
        <StatusLamp state={busy ? "working" : "ready"} label={busy ? "working" : `${threads.length} threads`} />
      </div>
    </div>
    <GlossaryHint as="p" className="surface-copy" term="Thread" definition="a durable workspace conversation — checkpoints record resume points, and forking branches a sibling with provenance back to its source.">Every conversation lives on a thread bound to a workspace. Switch, pause, archive, or fork — destructive actions always ask first.</GlossaryHint>
    <div className="threads-search">
      <div className="inline-search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search thread titles and conversations…" aria-label="Search threads" disabled={!ctx.isDesktop} />
        <button type="button" onClick={() => void ctx.runCommand("thread.search", { query: query.trim(), limit: 10 }).then((result) => setSearchState({ status: "done", results: searchResultRows(result?.results) }))} aria-label="Search threads" disabled={!ctx.isDesktop || !query.trim()}><Icon name="search" size={15} /></button>
      </div>
      {query.trim().length >= 2 ? <div className="threads-search-results">
        {searchState.status === "searching" ? <p className="empty-copy">Searching…</p> : null}
        {searchState.status === "done" && !searchState.results.length ? <p className="empty-copy">No threads match “{query.trim()}”.</p> : null}
        {searchState.results.map((row) => <button type="button" className="threads-search-hit" key={row.threadId} onClick={() => { setSelectedId(row.threadId); setQuery(""); }}>
          <strong>{displayText(row.title)}</strong>
          <span>{row.matchedIn === "conversation" ? "matched in conversation" : "title match"}</span>
          {row.snippet ? <small>{displayText(row.snippet)}</small> : null}
        </button>)}
      </div> : null}
    </div>
    <div className="threads-body">
      <div className="threads-list" role="list" aria-label="Hemlock threads">
        <div className="threads-section-label">Open · {sections.open.length}</div>
        {sections.open.map(renderThreadRow)}
        {!sections.open.length ? <p className="empty-copy">{ctx.isDesktop ? "No open threads. Create one to start a fresh conversation." : "Saved threads appear in the Hemlock desktop app."}</p> : null}
        {sections.archived.length ? <>
          <div className="threads-section-label">Archived · {sections.archived.length}</div>
          {sections.archived.map(renderThreadRow)}
        </> : null}
      </div>
      <div className="threads-detail">{renderDetail()}</div>
    </div>
  </div>;
});
