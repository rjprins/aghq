import { render } from "preact";
import { Combobox } from "./combobox";

export type LaunchOptionControl =
  | {
    type: "select";
    flag: string;
    label: string;
    value: string;
    choices: { value: string; label: string }[];
  }
  | {
    type: "checkbox";
    flag: string;
    label: string;
    checked: boolean;
  };

export type LaunchModalViewModel = {
  agentChoices: string[];
  selectedAgent: string;
  optionControls: LaunchOptionControl[];
  directoryOptions: { value: string; label: string }[];
  selectedDirectory: string;
  customDirectoryValue: string;
  worktreeOptions: { value: string; label: string }[];
  selectedWorktree: string;
  branchValue: string;
  branchPlaceholder: string;
  baseBranchValue: string;
  baseBranchOptions: { value: string; label: string }[];
  launching: boolean;
  projectName?: string;
};

export type LaunchModalHandlers = {
  onClose: () => void;
  onAgentChange: (agent: string) => void;
  onOptionChange: (flag: string, value: string | boolean) => void;
  onDirectoryChange: (dir: string) => void;
  onCustomDirectoryChange: (path: string) => void;
  onWorktreeChange: (worktree: string) => void;
  onBranchChange: (branch: string) => void;
  onBaseBranchChange: (baseBranch: string) => void;
  onLaunch: () => void;
};

export function renderLaunchModal(
  root: Element,
  model: LaunchModalViewModel | null,
  handlers: LaunchModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const showBranchInput = model.selectedWorktree === "__new__";
  const showCustomDirectory = model.selectedDirectory === "__custom__";

  render(
    <div
      id="launch-modal-overlay"
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal"
        tabIndex={-1}
        ref={(el) => { if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus(); }}
        onKeyDown={(ev) => {
          if (ev.key !== "Enter") return;
          ev.preventDefault();
          handlers.onLaunch();
        }}
      >
        <h3>Launch agent{model.projectName ? ` — ${model.projectName}` : ""}</h3>

        <label className="launch-modal-label">
          Agent
          <div className="launch-modal-agent-buttons" role="group" aria-label="Agent">
            {model.agentChoices.map((agent) => (
              <button
                key={agent}
                type="button"
                className={`launch-modal-agent-button${model.selectedAgent === agent ? " active" : ""}`}
                aria-pressed={model.selectedAgent === agent}
                onClick={() => handlers.onAgentChange(agent)}
              >
                {agent}
              </button>
            ))}
          </div>
        </label>

        <div className="launch-modal-options">
          {model.optionControls.map((control) =>
            control.type === "select"
              ? (
                <label key={control.flag} className="launch-modal-label">
                  {control.label}
                  <select
                    className="launch-modal-select"
                    value={control.value}
                    onChange={(ev) => handlers.onOptionChange(control.flag, (ev.currentTarget as HTMLSelectElement).value)}
                  >
                    {control.choices.map((choice) => (
                      <option key={choice.value} value={choice.value}>{choice.label}</option>
                    ))}
                  </select>
                </label>
              )
              : (
                <label key={control.flag} className="launch-modal-label launch-modal-checkbox-label">
                  <input
                    type="checkbox"
                    checked={control.checked}
                    onChange={(ev) => handlers.onOptionChange(control.flag, (ev.currentTarget as HTMLInputElement).checked)}
                  />
                  <span>{control.label}</span>
                </label>
              )
          )}
        </div>

        <div className="launch-modal-label">
          Project directory
          <Combobox
            options={model.directoryOptions}
            value={model.selectedDirectory}
            placeholder="Search projects…"
            ariaLabel="Project directory"
            onSelect={handlers.onDirectoryChange}
          />
        </div>

        {showCustomDirectory ? (
          <label className="launch-modal-label">
            Custom path
            <input
              type="text"
              className="launch-modal-input"
              value={model.customDirectoryValue}
              placeholder="~/projects/my-app"
              onInput={(ev) => handlers.onCustomDirectoryChange((ev.currentTarget as HTMLInputElement).value)}
            />
          </label>
        ) : null}

        {/* div, not label: a <label> forwards clicks to its control, which fights the option list */}
        <div className="launch-modal-label">
          Worktree
          <Combobox
            options={model.worktreeOptions}
            value={model.selectedWorktree}
            placeholder="Search worktrees…"
            ariaLabel="Worktree"
            onSelect={handlers.onWorktreeChange}
          />
        </div>

        <label className={`launch-modal-label launch-modal-branch${showBranchInput ? "" : " hidden"}`}>
          Branch name (optional)
          <input
            type="text"
            className="launch-modal-input"
            value={model.branchValue}
            placeholder={model.branchPlaceholder}
            onInput={(ev) => handlers.onBranchChange((ev.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <div className={`launch-modal-label launch-modal-branch${showBranchInput ? "" : " hidden"}`}>
          Base branch
          {model.baseBranchOptions.length > 0
            ? (
              <Combobox
                options={model.baseBranchOptions}
                value={model.baseBranchValue}
                placeholder="Search branches…"
                ariaLabel="Base branch"
                onSelect={handlers.onBaseBranchChange}
              />
            )
            : (
              <input
                type="text"
                className="launch-modal-input"
                value={model.baseBranchValue}
                placeholder="main"
                onInput={(ev) => handlers.onBaseBranchChange((ev.currentTarget as HTMLInputElement).value)}
              />
            )}
        </div>

        <div className="launch-modal-buttons">
          <button type="button" onClick={() => handlers.onClose()}>Cancel</button>
          <button
            type="button"
            className="launch-modal-go"
            disabled={model.launching}
            onClick={() => handlers.onLaunch()}
          >
            {model.launching ? "Launching..." : "Launch"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
