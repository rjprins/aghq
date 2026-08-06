import { render } from "preact";

import {
  formatKeybinding,
  type Keybinding,
  type KeybindingActionId,
} from "../shared/keybindings.js";

export type KeybindingsPopupEntry = {
  id: KeybindingActionId;
  label: string;
  binding: Keybinding;
  custom: boolean;
};

export type KeybindingsPopupViewModel = {
  entries: KeybindingsPopupEntry[];
  captureAction: KeybindingActionId | null;
  saving: boolean;
  error: string | null;
};

export type KeybindingsPopupHandlers = {
  onClose: () => void;
  onCapture: (action: KeybindingActionId) => void;
};

function Shortcut({ binding }: { binding: Keybinding }) {
  const parts = formatKeybinding(binding);
  return (
    <>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 ? <span className="keybinding-separator">+</span> : null}
          <kbd>{part}</kbd>
        </span>
      ))}
    </>
  );
}

export function renderKeybindingsPopup(
  root: Element,
  model: KeybindingsPopupViewModel,
  handlers: KeybindingsPopupHandlers,
): void {
  render(
    <div role="dialog" aria-modal="true" aria-labelledby="keybindings-popup-title">
      <div className="keys-popup-header">
        <div id="keybindings-popup-title" className="keys-popup-title">Keybindings</div>
        <button type="button" className="keys-popup-close" aria-label="Close keybindings" onClick={handlers.onClose}>×</button>
      </div>
      <p className="keys-popup-help">Click a shortcut, then press its replacement.</p>
      <table>
        <tbody>
          {model.entries.map((entry) => {
            const capturing = model.captureAction === entry.id;
            return (
              <tr key={entry.id}>
                <td>
                  <button
                    type="button"
                    className={`keybinding-button${capturing ? " capturing" : ""}`}
                    aria-label={`Change shortcut for ${entry.label}`}
                    aria-pressed={capturing}
                    disabled={model.saving}
                    ref={(element) => {
                      if (capturing && element && element !== document.activeElement) element.focus();
                    }}
                    onClick={() => handlers.onCapture(entry.id)}
                  >
                    {capturing ? <span>Press shortcut…</span> : <Shortcut binding={entry.binding} />}
                  </button>
                </td>
                <td>
                  {entry.label}
                  {entry.custom ? <span className="keybinding-custom">Custom</span> : null}
                </td>
              </tr>
            );
          })}
          <tr className="keybinding-informational">
            <td>Select text</td>
            <td>Copy to clipboard</td>
          </tr>
        </tbody>
      </table>
      {model.captureAction ? (
        <p className={`keybindings-status${model.error ? " error" : ""}`} role="status">
          {model.error ?? "Press a shortcut with Ctrl, Alt, or Meta. Esc cancels; Backspace restores the default."}
        </p>
      ) : model.error ? (
        <p className="keybindings-status error" role="status">{model.error}</p>
      ) : null}
      <p className="keys-popup-note">
        Browser-reserved shortcuts cannot be captured when the browser does not send them to the page.
      </p>
    </div>,
    root,
  );
}
