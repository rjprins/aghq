import { render } from "preact";

export type CloseWorktreeModalViewModel = {
  ptyProcess: string;
  worktreeName: string;
  canRemoveWorktree: boolean;
  dirty: boolean | null; // null = still loading
  changes: string[];
  closing: boolean;
  /** Lifecycle evidence from the worktree scan, e.g. "PR !4812 completed · clean". */
  evidence?: string | null;
  /** Guarded removal needs a scan row; "missing" disables removal instead of force-deleting. */
  scanState: "loading" | "ready" | "missing";
};

export type CloseWorktreeModalHandlers = {
  onClose: () => void;
  onCloseSession: () => void;
  onCloseAndRemove: () => void;
};

export function renderCloseWorktreeModal(
  root: Element,
  model: CloseWorktreeModalViewModel | null,
  handlers: CloseWorktreeModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const dirtyLoading = model.dirty === null;
  const isDirty = model.dirty === true;

  render(
    <div
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal"
        tabIndex={-1}
        ref={(el) => {
          if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            handlers.onClose();
          }
        }}
      >
        <h3>Close worktree session</h3>

        <p className="close-wt-description">
          <strong>{model.ptyProcess}</strong> is the last session in worktree{" "}
          <strong>{model.worktreeName}</strong>.
        </p>

        {model.evidence ? <p className="close-wt-evidence">{model.evidence}</p> : null}

        <p
          className={`close-wt-status${
            !model.canRemoveWorktree
              ? " close-wt-status-clean"
              : isDirty
                ? " close-wt-status-dirty"
                : dirtyLoading
                  ? " close-wt-status-loading"
                  : " close-wt-status-clean"
          }`}
        >
          {!model.canRemoveWorktree
            ? "This is the main worktree and will not be removed."
            : dirtyLoading
              ? "Checking worktree status..."
              : isDirty
                ? "Worktree has uncommitted changes. Removing it will discard them."
                : "Worktree is clean."}
        </p>
        {model.canRemoveWorktree && model.scanState === "missing" && (
          <p className="close-wt-status close-wt-status-loading">
            No scan data for this worktree, so guarded removal is unavailable. Rescan in the Worktrees panel to remove it.
          </p>
        )}
        {model.canRemoveWorktree && isDirty && model.changes.length > 0 && (
          <pre className="close-wt-changes">{model.changes.slice(0, 10).join("\n")}{model.changes.length > 10 ? `\n... and ${model.changes.length - 10} more` : ""}</pre>
        )}

        <div className="launch-modal-buttons close-wt-buttons">
          <button type="button" onClick={() => handlers.onClose()} disabled={model.closing}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => handlers.onCloseSession()}
            disabled={model.closing}
          >
            Close session
          </button>
          {model.canRemoveWorktree && (
            <button
              type="button"
              className={`launch-modal-go${isDirty ? " close-wt-danger" : ""}`}
              disabled={model.closing || dirtyLoading || model.scanState !== "ready"}
              title={
                model.scanState === "missing"
                  ? "No scan data for this worktree — rescan in the Worktrees panel, or remove it there"
                  : isDirty
                    ? "Worktree has uncommitted changes"
                    : "Close session and remove worktree from disk"
              }
              onClick={() => handlers.onCloseAndRemove()}
            >
              {model.closing
                ? "Closing..."
                : dirtyLoading || model.scanState === "loading"
                  ? "Checking..."
                  : isDirty
                    ? "Close + remove (dirty!)"
                    : "Close + remove worktree"}
            </button>
          )}
        </div>
      </div>
    </div>,
    root,
  );
}
