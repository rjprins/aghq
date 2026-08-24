import { render } from "preact";
import type { AzurePrMenuItem } from "../shared/protocol.js";

export type PrMenuViewModel = {
  projectName: string;
  prs: AzurePrMenuItem[];
  position: { top: number; left: number; width: number; maxHeight: number };
};

export type PrMenuHandlers = {
  onClose: () => void;
  onLaunch: (pr: AzurePrMenuItem) => void;
};

function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function attentionLabel(attention: AzurePrMenuItem["attention"]): string | null {
  if (attention === "new") return "New";
  if (attention === "published") return "Published";
  return null;
}

export function renderPrMenu(
  root: Element,
  model: PrMenuViewModel | null,
  handlers: PrMenuHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const titleId = "pr-menu-title";
  render(
    <div
      className="pr-menu-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handlers.onClose();
      }}
    >
      <section
        className="pr-menu-popover"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          top: `${model.position.top}px`,
          left: `${model.position.left}px`,
          width: `${model.position.width}px`,
          maxHeight: `${model.position.maxHeight}px`,
        }}
        ref={(element) => {
          if (element && element !== document.activeElement && !element.contains(document.activeElement)) {
            element.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") handlers.onClose();
        }}
      >
        <header className="pr-menu-header">
          <div>
            <h3 id={titleId}>Pull requests for {model.projectName}</h3>
            <span>{model.prs.length} active</span>
          </div>
          <button type="button" className="pr-menu-close" aria-label="Close pull requests" onClick={handlers.onClose}>
            ×
          </button>
        </header>

        {model.prs.length === 0
          ? <div className="pr-menu-empty">No active pull requests.</div>
          : (
            <div className="pr-menu-table-scroll">
              <table className="pr-menu-table" aria-label="Active pull requests">
                <thead>
                  <tr>
                    <th scope="col" className="pr-menu-title-column">Title</th>
                    <th scope="col">Author</th>
                    <th scope="col">State</th>
                    <th scope="col">Source branch</th>
                    <th scope="col">Worktree</th>
                    <th scope="col">Updated</th>
                    <th scope="col" className="pr-menu-action-column" aria-label="Action"></th>
                  </tr>
                </thead>
                <tbody>
                  {model.prs.map((pr) => {
                    const attention = attentionLabel(pr.attention);
                    return (
                      <tr key={pr.id}>
                        <td className="pr-menu-title-cell">
                          <div className="pr-menu-title-line">
                            <a
                              className="pr-menu-title-link"
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                              title={pr.title}
                              aria-label={`PR ${pr.id}: ${pr.title}`}
                            >
                              <span className="pr-menu-id">#{pr.id}</span>
                              <span className="pr-menu-title">{pr.title}</span>
                            </a>
                            {attention
                              ? <span className={`pr-menu-badge attention ${pr.attention}`}>{attention}</span>
                              : null}
                          </div>
                        </td>
                        <td className="pr-menu-author" title={pr.author}>{pr.author}</td>
                        <td className="pr-menu-state">
                          <span className={`pr-menu-badge ${pr.isDraft ? "draft" : "active"}`}>
                            {pr.isDraft ? "Draft" : "Active"}
                          </span>
                        </td>
                        <td><span className="pr-menu-branch" title={pr.sourceBranch}>{pr.sourceBranch}</span></td>
                        <td>
                          <div className="pr-menu-worktree">
                            {pr.worktree
                              ? (
                                <>
                                  <span title={pr.worktree.path}>Worktree: {pr.worktree.name}</span>
                                  {pr.worktree.dirty ? <span className="pr-menu-badge dirty">dirty</span> : null}
                                </>
                              )
                              : <span>No local worktree</span>}
                          </div>
                        </td>
                        <td className="pr-menu-updated" title={new Date(pr.updatedAt).toLocaleString()}>
                          {formatRelativeTime(pr.updatedAt)}
                        </td>
                        <td className="pr-menu-action-cell">
                          <button
                            type="button"
                            className="pr-menu-launch"
                            title="Launch agent"
                            aria-label={`Launch agent on PR ${pr.id}`}
                            onClick={() => handlers.onLaunch(pr)}
                          >
                            +
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>,
    root,
  );
}
