import { render } from "preact";

export type SessionPreviewMessage = {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms of the log entry, when the log records one. */
  ts?: number | null;
};

export type SessionPreviewModalViewModel = {
  sessionTitle: string;
  provider: string;
  providerSessionId: string;
  messages: SessionPreviewMessage[];
  loading: boolean;
};

export type SessionPreviewModalHandlers = {
  onClose: () => void;
  onRestore: () => void;
};

export function renderSessionPreviewModal(
  root: Element,
  model: SessionPreviewModalViewModel | null,
  handlers: SessionPreviewModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  render(
    <div
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal session-preview-modal"
        tabIndex={-1}
        ref={(el) => { if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus(); }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            handlers.onClose();
          }
        }}
      >
        <h3 title={model.sessionTitle}>{model.sessionTitle}</h3>

        <div className="session-preview-messages">
          {model.loading ? (
            <div className="session-preview-loading">Loading conversation...</div>
          ) : model.messages.length === 0 ? (
            <div className="session-preview-loading">No messages found.</div>
          ) : (
            model.messages.map((msg, i) => (
              <div key={i} className={`session-preview-msg ${msg.role}`}>
                <div className="msg-role">{msg.role}</div>
                {msg.text}
              </div>
            ))
          )}
        </div>

        <div className="launch-modal-buttons">
          <button type="button" onClick={() => handlers.onClose()}>Close</button>
          <button
            type="button"
            className="launch-modal-go"
            onClick={() => handlers.onRestore()}
          >
            Restore
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
