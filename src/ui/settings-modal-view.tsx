import { render } from "preact";
import {
  CLAUDE_EFFORT_LEVELS,
  type ClaudeEffortLevel,
  type ClaudeModelPreset,
} from "../shared/claude-model-presets.js";

export type ThemeOption = {
  key: string;
  name: string;
};

export type SettingsModalViewModel = {
  worktreePathTemplate: string;
  previewPath: string;
  saving: boolean;
  themeKey: string;
  themes: ThemeOption[];
  useSystemTheme: boolean;
  systemThemeDescription: string;
  tmuxSessionKey: string;
  tmuxSessions: Array<{ key: string; label: string }>;
  claudeModelPresets: ClaudeModelPreset[];
};

export type SettingsModalHandlers = {
  onClose: () => void;
  onTemplateChange: (value: string) => void;
  onReset: () => void;
  onSave: () => void;
  onThemeChange: (key: string) => void;
  onUseSystemThemeChange: (enabled: boolean) => void;
  onTmuxSessionChange: (key: string) => void;
  onTmuxSessionFocus: () => void;
  onAddClaudePreset: () => void;
  onClaudePresetChange: (
    id: string,
    field: "name" | "model" | "effort",
    value: string,
  ) => void;
  onMoveClaudePreset: (id: string, offset: -1 | 1) => void;
  onRemoveClaudePreset: (id: string) => void;
};

const EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  auto: "Auto (model default)",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultracode: "Ultracode",
};

export function renderSettingsModal(
  root: Element,
  model: SettingsModalViewModel | null,
  handlers: SettingsModalHandlers,
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
        className="launch-modal settings-modal"
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
        <h3>Settings</h3>

        <label className="launch-modal-label">
          Theme
          <select
            className="launch-modal-select"
            value={model.themeKey}
            onChange={(ev) => handlers.onThemeChange((ev.target as HTMLSelectElement).value)}
          >
            {model.themes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="launch-modal-label launch-modal-checkbox-label">
          <input
            type="checkbox"
            checked={model.useSystemTheme}
            onChange={(ev) => handlers.onUseSystemThemeChange((ev.target as HTMLInputElement).checked)}
          />
          <span>Use system theme</span>
        </label>

        {model.systemThemeDescription ? <div className="settings-help">{model.systemThemeDescription}</div> : null}

        <label className="launch-modal-label">
          Attach tmux session
          <select
            id="tmux-session-select"
            className="launch-modal-select"
            value={model.tmuxSessionKey}
            onChange={(ev) => handlers.onTmuxSessionChange((ev.target as HTMLSelectElement).value)}
            onFocus={() => handlers.onTmuxSessionFocus()}
          >
            {model.tmuxSessions.map((session) => (
              <option key={session.key} value={session.key}>
                {session.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="settings-preset-section">
          <legend>Claude model presets</legend>
          <div className="settings-preset-toolbar">
            <span className="settings-help">Used by <kbd>Alt</kbd>+<kbd>M</kbd> in Claude terminals.</span>
            <button
              type="button"
              onClick={() => handlers.onAddClaudePreset()}
              disabled={model.saving}
              aria-label="Add Claude preset"
            >
              Add preset
            </button>
          </div>

          {model.claudeModelPresets.length === 0 ? (
            <p className="settings-preset-empty">No Claude presets configured.</p>
          ) : (
            <div className="settings-preset-list">
              {model.claudeModelPresets.map((preset, index) => (
                <div className="settings-preset-row" key={preset.id}>
                  <label>
                    <span>Name</span>
                    <input
                      className="launch-modal-input"
                      type="text"
                      name={`claude-preset-${preset.id}-name`}
                      value={preset.name}
                      maxLength={80}
                      aria-label={`Preset ${index + 1} name`}
                      onInput={(event) => handlers.onClaudePresetChange(
                        preset.id,
                        "name",
                        (event.target as HTMLInputElement).value,
                      )}
                    />
                  </label>
                  <label>
                    <span>Model</span>
                    <input
                      className="launch-modal-input"
                      type="text"
                      name={`claude-preset-${preset.id}-model`}
                      value={preset.model}
                      maxLength={200}
                      spellCheck={false}
                      aria-label={`Preset ${index + 1} model`}
                      onInput={(event) => handlers.onClaudePresetChange(
                        preset.id,
                        "model",
                        (event.target as HTMLInputElement).value,
                      )}
                    />
                  </label>
                  <label>
                    <span>Effort</span>
                    <select
                      className="launch-modal-select"
                      name={`claude-preset-${preset.id}-effort`}
                      value={preset.effort}
                      aria-label={`Preset ${index + 1} effort`}
                      onChange={(event) => handlers.onClaudePresetChange(
                        preset.id,
                        "effort",
                        (event.target as HTMLSelectElement).value,
                      )}
                    >
                      {CLAUDE_EFFORT_LEVELS.map((effort) => (
                        <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
                      ))}
                    </select>
                  </label>
                  <div className="settings-preset-actions">
                    <button
                      type="button"
                      title="Move up"
                      aria-label={`Move preset ${index + 1} up`}
                      disabled={model.saving || index === 0}
                      onClick={() => handlers.onMoveClaudePreset(preset.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      aria-label={`Move preset ${index + 1} down`}
                      disabled={model.saving || index === model.claudeModelPresets.length - 1}
                      onClick={() => handlers.onMoveClaudePreset(preset.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      aria-label={`Remove preset ${index + 1}`}
                      disabled={model.saving}
                      onClick={() => handlers.onRemoveClaudePreset(preset.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </fieldset>

        <label className="launch-modal-label">
          Worktree path template
          <input
            type="text"
            className="launch-modal-input"
            value={model.worktreePathTemplate}
            placeholder="../{repo-name}-{branch}"
            onInput={(ev) => handlers.onTemplateChange((ev.target as HTMLInputElement).value)}
          />
        </label>

        <div className="settings-help">
          Variables: <code>{"{repo-name}"}</code> <code>{"{branch}"}</code> <code>{"{repo-root}"}</code>
          <br />
          Relative paths resolve against the repo root.
        </div>

        {model.previewPath && (
          <div className="settings-help">
            Preview: <code>{model.previewPath}</code>
          </div>
        )}

        <div className="launch-modal-buttons">
          <button type="button" onClick={() => handlers.onReset()} disabled={model.saving}>
            Reset to default
          </button>
          <button type="button" onClick={() => handlers.onClose()} disabled={model.saving}>
            Cancel
          </button>
          <button
            type="button"
            className="launch-modal-go"
            disabled={model.saving}
            onClick={() => handlers.onSave()}
          >
            {model.saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
