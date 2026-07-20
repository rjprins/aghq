import { render } from "preact";
import { AgentIcon, agentIconKind } from "./agent-icons";

export type ReactivateSessionItem = {
  id: string;
  title: string;
  provider: string;
  providerLabel: string;
  shortId: string;
  elapsed?: string;
  branch?: string;
  restored: boolean;
};

export type ReactivatePreviewMessage = {
  role: "user" | "assistant";
  text: string;
  time?: string;
};

export type ReactivateDetailModel = {
  title: string;
  provider: string;
  providerLabel: string;
  providerSessionId: string;
  shortId: string;
  branch?: string;
  lastActive?: string;
  firstPrompt?: string;
  messages: ReactivatePreviewMessage[];
  previewLoading: boolean;
};

export type ReactivateProjectModalViewModel = {
  projectLabel: string;
  projectPath?: string;
  totalSessions: number;
  showFilter: boolean;
  filterValue: string;
  sessions: ReactivateSessionItem[];
  selectedSessionId: string;
  detail: ReactivateDetailModel | null;
  destinationValue: string;
  sameCwdLabel: string;
  worktreeDestinations: Array<{ value: string; label: string }>;
  newBranchValue: string;
  customCwdValue: string;
  restoring: boolean;
};

export type ReactivateProjectModalHandlers = {
  onClose: () => void;
  onFilterChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onDestinationChange: (value: string) => void;
  onNewBranchChange: (branch: string) => void;
  onCustomCwdChange: (cwd: string) => void;
  onHideSession: (sessionId: string) => void;
  onRestore: () => void;
};

function ProviderBadge({ provider, label }: { provider: string; label: string }) {
  const kind = agentIconKind(provider);
  if (kind) {
    return (
      <span className={`agent-icon-badge ${kind}`} title={label}>
        <AgentIcon kind={kind} />
      </span>
    );
  }
  return <span className="reactivate-chip">{label}</span>;
}

export function renderReactivateProjectModal(
  root: Element,
  model: ReactivateProjectModalViewModel | null,
  handlers: ReactivateProjectModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const showNewBranchInput = model.destinationValue === "new_worktree";
  const showCustomCwdInput = model.destinationValue === "custom_cwd";
  const disableRestore =
    !model.detail ||
    model.restoring ||
    (showCustomCwdInput && model.customCwdValue.trim().length === 0);

  render(
    <div
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal reactivate-project-modal"
        tabIndex={-1}
        ref={(el) => { if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus(); }}
        onKeyDown={(ev) => {
          const targetEl = ev.target as HTMLElement;
          if (ev.key === "Escape") {
            ev.preventDefault();
            // Esc in a non-empty filter clears it; a second Esc closes.
            if (targetEl instanceof HTMLInputElement && targetEl.classList.contains("reactivate-filter-input") && model.filterValue) {
              handlers.onFilterChange("");
              return;
            }
            handlers.onClose();
            return;
          }
          if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && !(targetEl instanceof HTMLSelectElement)) {
            ev.preventDefault();
            if (model.restoring || model.sessions.length === 0) return;
            const idx = model.sessions.findIndex((s) => s.id === model.selectedSessionId);
            const next = ev.key === "ArrowDown" ? Math.min(idx + 1, model.sessions.length - 1) : Math.max(idx - 1, 0);
            const session = model.sessions[next];
            if (session && session.id !== model.selectedSessionId) handlers.onSelectSession(session.id);
            return;
          }
          if (ev.key === "Enter" && !disableRestore && !(targetEl instanceof HTMLSelectElement)) {
            ev.preventDefault();
            handlers.onRestore();
          }
        }}
      >
        <div className="reactivate-project-header">
          <div>
            <h3>Reactivate session</h3>
            <div className="reactivate-project-caption" title={model.projectPath ?? model.projectLabel}>
              {model.projectPath ?? model.projectLabel}
            </div>
          </div>
          <div className="reactivate-project-count">{model.totalSessions} available</div>
        </div>

        <div className="reactivate-project-layout">
          <div className="reactivate-sessions-pane">
            {model.showFilter ? (
              <input
                type="text"
                className="launch-modal-input reactivate-filter-input"
                placeholder="Filter sessions..."
                value={model.filterValue}
                ref={(el) => { if (el && document.activeElement === document.body) el.focus(); }}
                onInput={(ev) => handlers.onFilterChange((ev.currentTarget as HTMLInputElement).value)}
              />
            ) : null}
            <div className="reactivate-session-list" role="listbox" aria-label="Inactive sessions">
              {model.sessions.length === 0 ? (
                <div className="reactivate-empty">No sessions match the filter.</div>
              ) : (
                model.sessions.map((session) => {
                  const selected = session.id === model.selectedSessionId;
                  return (
                    <div
                      key={`${session.id}${selected ? ":sel" : ""}`}
                      role="option"
                      aria-selected={selected}
                      className={`reactivate-session-item${selected ? " selected" : ""}`}
                      ref={selected ? (el) => { el?.scrollIntoView({ block: "nearest" }); } : undefined}
                      onClick={() => handlers.onSelectSession(session.id)}
                    >
                      <div className="reactivate-card-top">
                        <ProviderBadge provider={session.provider} label={session.providerLabel} />
                        <span className="reactivate-card-title" title={session.title}>{session.title}</span>
                        {session.elapsed ? <span className="reactivate-card-age">{session.elapsed}</span> : null}
                        <button
                          type="button"
                          className="reactivate-card-hide"
                          title="Hide this session from the list"
                          aria-label={`Hide ${session.title}`}
                          disabled={model.restoring}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handlers.onHideSession(session.id);
                          }}
                        >
                          {"×"}
                        </button>
                      </div>
                      <div className="reactivate-card-chips">
                        {session.branch ? <span className="reactivate-chip branch" title={session.branch}>{session.branch}</span> : null}
                        {session.restored ? <span className="reactivate-chip restored">restored before</span> : null}
                        <span className="reactivate-chip" title={session.shortId}>{session.shortId}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="reactivate-detail">
            {model.detail ? (
              <>
                <div className="reactivate-detail-header">
                  <div className="reactivate-detail-title" title={model.detail.title}>{model.detail.title}</div>
                  <div className="reactivate-detail-meta">
                    <span className="reactivate-detail-provider">
                      <ProviderBadge provider={model.detail.provider} label={model.detail.providerLabel} />
                      {model.detail.providerLabel}
                    </span>
                    {model.detail.branch ? <span title={model.detail.branch}>{model.detail.branch}</span> : null}
                    <span title={model.detail.providerSessionId}>{model.detail.shortId}</span>
                    {model.detail.lastActive ? <span>active {model.detail.lastActive} ago</span> : null}
                  </div>
                </div>

                {model.detail.firstPrompt ? (
                  <div className="reactivate-first-prompt">
                    <div className="reactivate-preview-label">First prompt</div>
                    <div className="reactivate-first-prompt-text" title={model.detail.firstPrompt}>
                      {model.detail.firstPrompt}
                    </div>
                  </div>
                ) : null}

                <div className="reactivate-preview">
                  <div className="reactivate-preview-label">Recent conversation</div>
                  <div
                    className="reactivate-preview-body"
                    key={`${model.selectedSessionId}:${model.detail.messages.length}:${model.detail.previewLoading}`}
                    ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                  >
                    {model.detail.previewLoading ? (
                      <div className="session-preview-loading">Loading conversation...</div>
                    ) : model.detail.messages.length === 0 ? (
                      <div className="session-preview-loading">No conversation preview found.</div>
                    ) : (
                      model.detail.messages.map((msg, i) => (
                        <div key={i} className={`session-preview-msg ${msg.role}`}>
                          <div className="msg-role">{msg.role}{msg.time ? ` · ${msg.time}` : ""}</div>
                          {msg.text}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="reactivate-destination">
                  <label className="reactivate-destination-row">
                    Resume in
                    <select
                      className="launch-modal-select"
                      value={model.destinationValue}
                      onChange={(ev) => handlers.onDestinationChange((ev.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="same_cwd">{model.sameCwdLabel}</option>
                      {model.worktreeDestinations.length > 0 ? (
                        <optgroup label="Existing worktrees">
                          {model.worktreeDestinations.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </optgroup>
                      ) : null}
                      <option value="new_worktree">Create a new worktree...</option>
                      <option value="custom_cwd">Choose a custom directory...</option>
                    </select>
                  </label>

                  {showNewBranchInput ? (
                    <label className="launch-modal-label">
                      Branch name
                      <input
                        type="text"
                        className="launch-modal-input"
                        value={model.newBranchValue}
                        placeholder="restore-branch-name"
                        onInput={(ev) => handlers.onNewBranchChange((ev.currentTarget as HTMLInputElement).value)}
                      />
                    </label>
                  ) : null}

                  {showCustomCwdInput ? (
                    <label className="launch-modal-label">
                      Custom directory
                      <input
                        type="text"
                        className="launch-modal-input"
                        value={model.customCwdValue}
                        placeholder="/path/to/directory"
                        onInput={(ev) => handlers.onCustomCwdChange((ev.currentTarget as HTMLInputElement).value)}
                      />
                    </label>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="reactivate-empty">Select a session to see its details.</div>
            )}
          </div>
        </div>

        <div className="launch-modal-buttons">
          {model.restoring ? <div className="restore-status" role="status">Restoring inactive session...</div> : null}
          <button
            type="button"
            className="restore-cancel-btn"
            onClick={() => handlers.onClose()}
            disabled={model.restoring}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`launch-modal-go${model.restoring ? " restoring" : ""}`}
            disabled={disableRestore}
            onClick={() => handlers.onRestore()}
          >
            {model.restoring ? "Restoring..." : "Reactivate"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
