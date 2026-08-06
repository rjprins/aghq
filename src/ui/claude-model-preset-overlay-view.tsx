import { render } from "preact";

import type { ClaudeModelPreset } from "../shared/claude-model-presets.js";

export type ClaudeModelPresetOverlayViewModel = {
  presets: ClaudeModelPreset[];
  selectedIndex: number;
};

export type ClaudeModelPresetOverlayHandlers = {
  onCancel: () => void;
};

export function renderClaudeModelPresetOverlay(
  root: Element,
  model: ClaudeModelPresetOverlayViewModel | null,
  handlers: ClaudeModelPresetOverlayHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  render(
    <div
      className="claude-preset-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) handlers.onCancel();
      }}
    >
      <div
        className="claude-preset-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-preset-title"
        tabIndex={-1}
        ref={(element) => {
          if (element && element !== document.activeElement) element.focus();
        }}
      >
        <h3 id="claude-preset-title">Switch Claude model</h3>
        <p className="claude-preset-description">Press Alt+M again to cycle.</p>
        <ul className="claude-preset-list" role="listbox" aria-label="Claude model presets">
          {model.presets.map((preset, index) => {
            const selected = index === model.selectedIndex;
            return (
              <li
                key={preset.id}
                className={`claude-preset-option${selected ? " selected" : ""}`}
                role="option"
                aria-selected={selected ? "true" : "false"}
              >
                <span className="claude-preset-name">{preset.name}</span>
                <span className="claude-preset-config">
                  {preset.model} · {preset.effort}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="claude-preset-hints" aria-label="Actions">
          <span><kbd>Enter</kbd> Apply</span>
          <span><kbd>Esc</kbd> Cancel</span>
        </div>
      </div>
    </div>,
    root,
  );
}
