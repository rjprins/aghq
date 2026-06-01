import { Fragment, render } from "preact";
import { AnsiUp } from "ansi_up";

// Mobile view states:
// - "active": Active sessions list
// - "inactive": Inactive sessions list
// - "session": Single session view
export type MobileView = "active" | "session" | "inactive";

export type MobileRunningSession = {
  id: string;
  process: string;
  subtitle: string;
  metaPills?: string[];
  worktree?: string;
  cwd?: string;
  readyState: "ready" | "busy" | "unknown";
  readyIndicator: "ready" | "busy" | "unknown";
  readyReason: string;
  readyUnviewed: boolean;
  elapsed?: string;
  lastInput?: string;
  outputPreview?: string[];
  active: boolean;
};

export type MobileInactiveSession = {
  id: string;
  title: string;
  subtitle: string;
  provider: string;
  worktree?: string;
  elapsed?: string;
  firstInput?: string;
};

export type MobileProjectGroup = {
  key: string;
  label: string;
  title?: string;
  pinned: boolean;
  inactiveTotal: number;
  running: MobileRunningSession[];
};

export type MobileInactiveProjectGroup = {
  key: string;
  label: string;
  title?: string;
  archived: boolean;
  pinned: boolean;
  sessions: MobileInactiveSession[];
};

export type MobileFocus = {
  id: string;
  title: string;
  subtitle: string;
  metaPills?: string[];
  readyState: "ready" | "busy" | "unknown";
  readyIndicator: "ready" | "busy" | "unknown";
  readyReason: string;
  elapsed?: string;
  lastInput?: string;
};

export type MobileInactivePreview = {
  id: string;
  title: string;
  subtitle: string;
  provider: string;
  providerSessionId: string;
  loading: boolean;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
};

export type MobileTerminalSnapshot = {
  seq: number;
  ptyId: string;
  title: string;
  subtitle: string;
  capturedAt: string;
  text: string;
  lineCount: number;
  truncated: boolean;
  linesRequested: number;
  loading: boolean;
  error: string | null;
};

export type MobileViewModel = {
  connected: boolean;
  view: MobileView;
  running: MobileRunningSession[];
  runningProjects: MobileProjectGroup[];
  inactiveProjects: MobileInactiveProjectGroup[];
  archivedProjects: MobileInactiveProjectGroup[];
  inactiveProjectLabel: string | null;
  focus: MobileFocus | null;
  activeTitle: string;
  inputDraft: string;
  quickPrompts: string[];
  preview: MobileInactivePreview | null;
  terminalSnapshot: MobileTerminalSnapshot | null;
  settingsOpen: boolean;
  terminalThemeKey: string;
  terminalThemes: Array<{ key: string; name: string }>;
  terminalFontSize: number;
  historyButtonBg: string;
  historyButtonText: string;
  historyButtonBorder: string;
  showFollowButton: boolean;
};

export type MobileViewHandlers = {
  onSelectRunning: (ptyId: string) => void;
  onCloseRunning: (ptyId: string) => void;
  onRenameRunning: (ptyId: string) => void;
  onOpenLaunch: () => void;
  onTogglePinProject: (projectKey: string) => void;
  onArchiveProject: (projectKey: string) => void;
  onUnarchiveProject: (projectKey: string) => void;
  onShowInactive: (projectKey: string) => void;
  onBack: () => void;
  onChangeDraft: (value: string) => void;
  onSendDraft: (value?: string) => void;
  onQuickPrompt: (prompt: string) => void;
  onInterrupt: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  onTabKey: () => void;
  onFollowOutput: () => void;
  onOpenTermSnapshot: () => void;
  onCloseTermSnapshot: () => void;
  onPreviewInactive: (agentSessionId: string) => void;
  onRestoreInactive: (agentSessionId: string) => void;
  onClosePreview: () => void;
  onTermMountReady: (el: HTMLElement | null) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onTerminalThemeChange: (key: string) => void;
  onTerminalFontSizeChange: (size: number) => void;
};

let lastSnapshotAutoscrollSeq = 0;
const ansiUp = new AnsiUp();
ansiUp.escape_for_html = true;
const MOBILE_INACTIVE_PAGE_SIZE = 4;
const mobileInactiveVisiblePages = new Map<string, number>();

function mobileInactiveVisibleCount(projectKey: string, total: number): number {
  const pages = Math.max(1, mobileInactiveVisiblePages.get(projectKey) ?? 1);
  return Math.min(total, pages * MOBILE_INACTIVE_PAGE_SIZE);
}

function mobileInactiveShowMore(projectKey: string): void {
  mobileInactiveVisiblePages.set(projectKey, (mobileInactiveVisiblePages.get(projectKey) ?? 1) + 1);
}

function renderEmpty(title: string, hint: string) {
  return (
    <div className="mobile-empty">
      <div className="mobile-empty-title">{title}</div>
      <div className="mobile-empty-hint">{hint}</div>
    </div>
  );
}

function renderRunningSessionCard(
  session: MobileRunningSession,
  index: number,
  handlers: MobileViewHandlers,
  onAfterSelect?: () => void,
) {
  const selectSession = () => {
    onAfterSelect?.();
    handlers.onSelectRunning(session.id);
  };
  return (
    <li
      key={session.id}
      data-pty-id={session.id}
      className={`mobile-session-card state-${session.readyState}${session.active ? " active" : ""}${session.readyUnviewed ? " ready-unviewed" : ""}`}
      style={{ "--stagger": `${index * 60}ms` } as Record<string, string>}
      onPointerDown={(ev) => {
        if (!onAfterSelect) return;
        ev.preventDefault();
        ev.stopPropagation();
        selectSession();
      }}
      onClick={() => {
        if (onAfterSelect) return;
        selectSession();
      }}
    >
      <div className="session-card-header">
        <span className={`status-dot ${session.readyIndicator}`} />
        <div className="mobile-title-group">
          <div className="session-card-title" title={session.process}>{session.process}</div>
          <button
            type="button"
            className="mobile-edit-btn"
            aria-label={`Rename session ${session.process}`}
            title={`Rename session ${session.process}`}
            onClick={(ev) => {
              ev.stopPropagation();
              handlers.onRenameRunning(session.id);
            }}
          >
            Edit
          </button>
        </div>
        {session.elapsed ? <div className="session-card-elapsed">{session.elapsed}</div> : null}
        <button
          type="button"
          className="session-card-close"
          onClick={(ev) => {
            ev.stopPropagation();
            handlers.onCloseRunning(session.id);
          }}
        >
          Close
        </button>
      </div>
      <div className="session-card-sub" title={session.subtitle}>{session.subtitle}</div>
      {session.outputPreview && session.outputPreview.length > 0 ? (
        <div className="session-card-output" role="status">
          {session.outputPreview.map((line, i) => (
            <div key={`${session.id}-preview-${i}`} className="session-card-output-line">
              {line || " "}
            </div>
          ))}
        </div>
      ) : session.lastInput ? (
        <div className="session-card-input">{session.lastInput}</div>
      ) : (
        <div className="session-card-input">No output yet</div>
      )}
    </li>
  );
}

function renderInactiveSessionCard(
  session: MobileInactiveSession,
  index: number,
  handlers: MobileViewHandlers,
) {
  return (
    <li
      key={session.id}
      className="mobile-inactive-card"
      style={{ "--stagger": `${index * 60}ms` } as Record<string, string>}
    >
      <div className="inactive-card-header">
        <div className="inactive-card-main">
          <div className="inactive-card-title" title={session.title}>{session.title}</div>
          {session.worktree ? (
            <div className="inactive-card-worktree">
              <span className="inactive-card-worktree-label">branch:</span>
              <span className="inactive-card-worktree-pill">{session.worktree}</span>
            </div>
          ) : null}
        </div>
        {session.elapsed ? <div className="inactive-card-elapsed">{session.elapsed}</div> : null}
      </div>
      <div className="inactive-card-sub" title={session.subtitle}>{session.subtitle}</div>
      {session.firstInput ? <div className="inactive-card-input" title={session.firstInput}>{session.firstInput}</div> : null}
      <div className="inactive-card-actions">
        <button type="button" className="ghost" onClick={() => handlers.onPreviewInactive(session.id)}>
          Preview
        </button>
        <button type="button" className="primary" onClick={() => handlers.onRestoreInactive(session.id)}>
          Activate
        </button>
      </div>
    </li>
  );
}

export function renderMobileView(
  root: Element,
  model: MobileViewModel | null,
  handlers: MobileViewHandlers,
): void {
  let composerDraftEl: HTMLTextAreaElement | null = null;
  let snapshotScrollEl: HTMLDivElement | null = null;
  let runningDropdownEl: HTMLDetailsElement | null = null;
  const dismissKeyboard = () => {
    const activeEl = document.activeElement as HTMLElement | null;
    composerDraftEl?.blur();
    activeEl?.blur?.();
    requestAnimationFrame(() => {
      composerDraftEl?.blur();
      const nextActiveEl = document.activeElement as HTMLElement | null;
      nextActiveEl?.blur?.();
    });
  };
  if (!model) {
    render(null, root);
    return;
  }
  const sendComposerDraft = () => {
    handlers.onSendDraft(composerDraftEl?.value ?? model.inputDraft);
    dismissKeyboard();
  };
  const themedOverlayButtonStyle = {
    backgroundColor: model.historyButtonBg,
    color: model.historyButtonText,
    borderColor: model.historyButtonBorder,
  };
  const selectableRunning = model.running.filter((session) => !session.active);

  render(
    <div className={`mobile-shell mobile-view-${model.view}`}>
      <header className="mobile-topbar">
        <div className="mobile-brand">
          <div className="mobile-brand-row">
            <div className="mobile-brand-title">agmux</div>
          </div>
          <div className="mobile-brand-sub">agent control</div>
        </div>
        <div className="mobile-actions">
          {model.view !== "active" ? (
            <button type="button" className="mobile-action" onClick={() => handlers.onBack()}>
              Back
            </button>
          ) : null}
          {model.view === "session" && selectableRunning.length > 0 ? (
            <details className="mobile-running-dropdown" ref={(el) => (runningDropdownEl = el)}>
              <summary className="mobile-action mobile-running-dropdown-toggle">
                Sessions ({selectableRunning.length})
              </summary>
              <div className="mobile-running-dropdown-panel">
                <ul className="mobile-session-list mobile-session-dropdown-list">
                  {selectableRunning.map((session, index) =>
                    renderRunningSessionCard(session, index, handlers, () => {
                      if (runningDropdownEl) runningDropdownEl.open = false;
                    }),
                  )}
                </ul>
              </div>
            </details>
          ) : null}
          <button type="button" className="mobile-new" onClick={() => handlers.onOpenLaunch()}>
            New
          </button>
        </div>
      </header>
      {!model.connected ? <div className="mobile-reconnect-bar">Reconnecting</div> : null}

      <div className="mobile-scroll">
        {model.view === "active" ? (
          <section className="mobile-section">
            <div className="mobile-section-head">
              <div className="mobile-section-title">Active sessions</div>
            </div>
            {model.runningProjects.length === 0 ? (
              renderEmpty("No active sessions", "Start one from the New button.")
            ) : (
              <div className="mobile-project-list">
                {model.runningProjects.map((project, groupIndex) => (
                  <section key={project.key} className="mobile-project-group">
                    <div className="mobile-project-head" title={project.title}>
                      <div className="mobile-project-label">{project.label}</div>
                      <div className="mobile-project-actions">
                        <button
                          type="button"
                          className="mobile-action mobile-project-action"
                          onClick={() => handlers.onTogglePinProject(project.key)}
                        >
                          {project.pinned ? "Unpin" : "Pin"}
                        </button>
                        {project.inactiveTotal > 0 ? (
                          <button
                            type="button"
                            className="mobile-action mobile-project-action"
                            onClick={() => handlers.onShowInactive(project.key)}
                          >
                            Inactive ({project.inactiveTotal})
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {project.running.length > 0 ? (
                      <ul className="mobile-session-list">
                        {project.running.map((session, sessionIndex) =>
                          renderRunningSessionCard(session, groupIndex * 20 + sessionIndex, handlers))}
                      </ul>
                    ) : (
                      <div className="mobile-project-empty">No active sessions</div>
                    )}
                  </section>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {model.view === "session" ? (
          <Fragment>
            {model.focus ? (
              <section className="mobile-card mobile-focus">
                <div className="focus-header">
                  <span className={`status-dot ${model.focus.readyIndicator}`} />
                  <div className="mobile-title-group">
                    <div className="focus-title" title={model.focus.title}>{model.focus.title}</div>
                    <button
                      type="button"
                      className="mobile-edit-btn"
                      aria-label={`Rename session ${model.focus.title}`}
                      title={`Rename session ${model.focus.title}`}
                      onClick={() => handlers.onRenameRunning(model.focus!.id)}
                    >
                      Edit
                    </button>
                  </div>
                  {model.focus.metaPills?.map((pill) => (
                    <span key={`${model.focus!.id}:${pill}`} className="mobile-meta-pill" title={pill}>{pill}</span>
                  ))}
                  {model.focus.elapsed ? <div className="focus-elapsed">{model.focus.elapsed}</div> : null}
                  <button
                    type="button"
                    className="session-card-close focus-close"
                    onClick={() => handlers.onCloseRunning(model.focus.id)}
                  >
                    Close
                  </button>
                </div>
                {model.focus.subtitle ? <div className="focus-subtitle" title={model.focus.subtitle}>{model.focus.subtitle}</div> : null}
                <div
                  className="focus-xterm-mount"
                  onPointerDownCapture={(ev) => {
                    const target = ev.target as HTMLElement | null;
                    if (target?.closest(".focus-history-btn, .focus-follow-btn, .focus-settings-btn")) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    requestAnimationFrame(() => {
                      if (!composerDraftEl) return;
                      composerDraftEl.focus({ preventScroll: true });
                      const pos = composerDraftEl.value.length;
                      composerDraftEl.setSelectionRange(pos, pos);
                    });
                  }}
                  ref={(el: HTMLElement | null) => handlers.onTermMountReady(el)}
                >
                  {model.showFollowButton ? (
                    <button
                      type="button"
                      className="mobile-action focus-follow-btn"
                      style={themedOverlayButtonStyle}
                      onPointerDown={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                      }}
                      onClick={() => handlers.onFollowOutput()}
                    >
                      Follow ↓
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mobile-action focus-history-btn"
                    style={themedOverlayButtonStyle}
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                    }}
                    onClick={() => handlers.onOpenTermSnapshot()}
                  >
                    Scrollback
                  </button>
                  <button
                    type="button"
                    className="mobile-action focus-settings-btn"
                    style={themedOverlayButtonStyle}
                    aria-label="Settings"
                    title="Settings"
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                    }}
                    onClick={() => handlers.onOpenSettings()}
                  >
                    ⚙
                  </button>
                </div>
                <div className="mobile-composer focus-composer">
                  <textarea
                    rows={3}
                    placeholder="Send a quick directive or question"
                    enterKeyHint="send"
                    ref={(el) => {
                      composerDraftEl = el;
                    }}
                    value={model.inputDraft}
                    onInput={(ev) => handlers.onChangeDraft((ev.currentTarget as HTMLTextAreaElement).value)}
                    onKeyDown={(ev) => {
                      if (ev.key !== "Enter") return;
                      if (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
                      ev.preventDefault();
                      sendComposerDraft();
                    }}
                  />
                  <div className="composer-actions">
                    <div className="composer-keys">
                      <button
                        type="button"
                        className="ghost key-btn"
                        aria-label="Arrow down"
                        onClick={() => handlers.onArrowDown()}
                      >
                        ↓
                      </button>
                      <button type="button" className="ghost key-btn" aria-label="Arrow up" onClick={() => handlers.onArrowUp()}>
                        ↑
                      </button>
                      <button type="button" className="ghost key-btn tab-btn" aria-label="Tab" onClick={() => handlers.onTabKey()}>
                        Tab
                      </button>
                      <button type="button" className="ghost composer-interrupt" onClick={() => handlers.onInterrupt()}>
                        Interrupt
                      </button>
                    </div>
                    <button
                      type="button"
                      className="mobile-send"
                      onClick={() => sendComposerDraft()}
                      disabled={!model.connected}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              renderEmpty("No active session", "Launch or restore a session to start.")
            )}
          </Fragment>
        ) : null}

        {model.view === "inactive" ? (
          <section className="mobile-section">
            <div className="mobile-section-title">
              {model.inactiveProjectLabel ? `Inactive · ${model.inactiveProjectLabel}` : "Inactive sessions"}
            </div>
            {model.inactiveProjects.length === 0 && model.archivedProjects.length === 0 ? (
              renderEmpty("No inactive sessions", "Inactive sessions appear here after they exit.")
            ) : (
              <div className="mobile-project-list">
                {model.inactiveProjects.map((project, groupIndex) => (
                  <details key={project.key} className="mobile-project-group mobile-inactive-project" open>
                    <summary className="mobile-project-head mobile-project-summary" title={project.title}>
                      <div className="mobile-project-label">{project.label}</div>
                      <div className="mobile-project-summary-right">
                        <span className="mobile-project-count">{project.sessions.length}</span>
                        <button
                          type="button"
                          className="mobile-action mobile-project-action"
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            handlers.onTogglePinProject(project.key);
                          }}
                        >
                          {project.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          type="button"
                          className="mobile-action mobile-project-action"
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            handlers.onArchiveProject(project.key);
                          }}
                        >
                          Archive
                        </button>
                      </div>
                    </summary>
                    <ul className="mobile-inactive-list">
                      {project.sessions
                        .slice(0, mobileInactiveVisibleCount(`inactive:${project.key}`, project.sessions.length))
                        .map((session, sessionIndex) =>
                          renderInactiveSessionCard(session, groupIndex * 20 + sessionIndex, handlers))}
                      {mobileInactiveVisibleCount(`inactive:${project.key}`, project.sessions.length) < project.sessions.length ? (
                        <li className="mobile-inactive-more-row">
                          <button
                            type="button"
                            className="mobile-action mobile-project-action mobile-inactive-more"
                            onClick={() => {
                              mobileInactiveShowMore(`inactive:${project.key}`);
                              renderMobileView(root, model, handlers);
                            }}
                          >
                            More ({project.sessions.length - mobileInactiveVisibleCount(`inactive:${project.key}`, project.sessions.length)} left)
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </details>
                ))}
                {model.archivedProjects.length > 0 ? (
                  <div className="mobile-section-title mobile-archived-label">Archived</div>
                ) : null}
                {model.archivedProjects.map((project, groupIndex) => (
                  <details key={project.key} className="mobile-project-group mobile-inactive-project archived">
                    <summary className="mobile-project-head mobile-project-summary" title={project.title}>
                      <div className="mobile-project-label">{project.label}</div>
                      <div className="mobile-project-summary-right">
                        <span className="mobile-project-count">{project.sessions.length}</span>
                        <button
                          type="button"
                          className="mobile-action mobile-project-action"
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            handlers.onUnarchiveProject(project.key);
                          }}
                        >
                          Unarchive
                        </button>
                      </div>
                    </summary>
                    <ul className="mobile-inactive-list">
                      {project.sessions
                        .slice(0, mobileInactiveVisibleCount(`archived:${project.key}`, project.sessions.length))
                        .map((session, sessionIndex) =>
                          renderInactiveSessionCard(session, (groupIndex + 100) * 20 + sessionIndex, handlers))}
                      {mobileInactiveVisibleCount(`archived:${project.key}`, project.sessions.length) < project.sessions.length ? (
                        <li className="mobile-inactive-more-row">
                          <button
                            type="button"
                            className="mobile-action mobile-project-action mobile-inactive-more"
                            onClick={() => {
                              mobileInactiveShowMore(`archived:${project.key}`);
                              renderMobileView(root, model, handlers);
                            }}
                          >
                            More ({project.sessions.length - mobileInactiveVisibleCount(`archived:${project.key}`, project.sessions.length)} left)
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </details>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </div>

      {model.preview ? (
        <div
          className="mobile-sheet"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) handlers.onClosePreview();
          }}
        >
          <div className="mobile-sheet-panel">
            <div className="sheet-header">
              <div>
                <div className="sheet-title" title={model.preview.title}>{model.preview.title}</div>
                <div className="sheet-sub" title={model.preview.subtitle}>{model.preview.subtitle}</div>
              </div>
              <button type="button" className="ghost" onClick={() => handlers.onClosePreview()}>
                Close
              </button>
            </div>
            <div className="sheet-body">
              {model.preview.loading ? (
                <div className="sheet-loading">Loading conversation...</div>
              ) : model.preview.messages.length === 0 ? (
                <div className="sheet-loading">No messages found.</div>
              ) : (
                model.preview.messages.map((msg, i) => (
                  <div key={`${model.preview.id}-${i}`} className={`sheet-message ${msg.role}`}>
                    <div className="sheet-role">{msg.role}</div>
                    {msg.text}
                  </div>
                ))
              )}
            </div>
            <div className="sheet-actions">
              <button type="button" className="primary" onClick={() => handlers.onRestoreInactive(model.preview.id)}>
                Activate session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {model.terminalSnapshot ? (
        <div
          className="mobile-sheet fullscreen"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) handlers.onCloseTermSnapshot();
          }}
        >
          <div className="mobile-sheet-panel terminal-snapshot-panel">
            <div className="sheet-header">
              <div>
                <div className="sheet-title" title={model.terminalSnapshot.title}>
                  {model.terminalSnapshot.title}
                </div>
                <div className="sheet-sub" title={model.terminalSnapshot.subtitle}>
                  {model.terminalSnapshot.subtitle}
                </div>
                <div className="sheet-sub">
                  {model.terminalSnapshot.loading
                    ? `Loading tmux snapshot (${model.terminalSnapshot.linesRequested} lines)...`
                    : model.terminalSnapshot.error
                    ? "Snapshot failed"
                    : `Snapshot ${model.terminalSnapshot.capturedAt}`}
                  {!model.terminalSnapshot.loading && !model.terminalSnapshot.error && model.terminalSnapshot.truncated
                    ? ` · showing latest ${model.terminalSnapshot.linesRequested} lines`
                    : ""}
                </div>
              </div>
            </div>
            <div
              className="sheet-body terminal-snapshot-body"
              ref={(el) => {
                snapshotScrollEl = el;
                if (!el) return;
                if (
                  model.terminalSnapshot &&
                  !model.terminalSnapshot.loading &&
                  !model.terminalSnapshot.error &&
                  lastSnapshotAutoscrollSeq !== model.terminalSnapshot.seq
                ) {
                  lastSnapshotAutoscrollSeq = model.terminalSnapshot.seq;
                  requestAnimationFrame(() => {
                    if (!snapshotScrollEl) return;
                    snapshotScrollEl.scrollTop = snapshotScrollEl.scrollHeight;
                  });
                }
              }}
            >
              {model.terminalSnapshot.loading ? (
                <div className="terminal-snapshot-render" style={{ fontSize: `${model.terminalFontSize}px` }}>
                  Loading tmux scrollback...
                </div>
              ) : model.terminalSnapshot.error ? (
                <div className="terminal-snapshot-render" style={{ fontSize: `${model.terminalFontSize}px` }}>
                  {`Error: ${model.terminalSnapshot.error}`}
                </div>
              ) : (
                <div
                  className="terminal-snapshot-render"
                  style={{ fontSize: `${model.terminalFontSize}px` }}
                  dangerouslySetInnerHTML={{
                    __html: model.terminalSnapshot.text
                      ? ansiUp.ansi_to_html(model.terminalSnapshot.text)
                      : "No terminal output yet.",
                  }}
                />
              )}
            </div>
            <div className="sheet-sub">
              {model.terminalSnapshot.error
                ? "Lines: 0"
                : `Lines: ${model.terminalSnapshot.lineCount}`}
            </div>
            <div className="sheet-actions terminal-snapshot-actions">
              <button type="button" className="ghost" onClick={() => handlers.onOpenTermSnapshot()}>
                Refresh
              </button>
              <button type="button" className="primary" onClick={() => handlers.onCloseTermSnapshot()}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {model.settingsOpen ? (
        <div
          className="mobile-sheet"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) handlers.onCloseSettings();
          }}
        >
          <div className="mobile-sheet-panel">
            <div className="sheet-header">
              <div>
                <div className="sheet-title">Mobile terminal settings</div>
                <div className="sheet-sub">Applies only to mobile terminal view</div>
              </div>
              <button type="button" className="ghost" onClick={() => handlers.onCloseSettings()}>
                Close
              </button>
            </div>
            <div className="mobile-settings-form">
              <label className="mobile-settings-row">
                <span>Theme</span>
                <select
                  value={model.terminalThemeKey}
                  onChange={(ev) => handlers.onTerminalThemeChange((ev.target as HTMLSelectElement).value)}
                >
                  {model.terminalThemes.map((theme) => (
                    <option key={theme.key} value={theme.key}>
                      {theme.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mobile-settings-row">
                <span>Font size ({model.terminalFontSize}px)</span>
                <input
                  type="range"
                  min={8}
                  max={22}
                  step={1}
                  value={model.terminalFontSize}
                  onInput={(ev) => handlers.onTerminalFontSizeChange(Number((ev.target as HTMLInputElement).value))}
                />
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    root,
  );
}
