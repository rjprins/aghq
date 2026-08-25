import { render } from "preact";
import type { AzurePrMenuItem } from "../shared/protocol.js";

export type PrMenuViewModel = {
  projectName: string;
  prs: AzurePrMenuItem[];
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

const READINESS_LABELS = {
  ready: { short: "Ready", full: "Ready to merge" },
  blocked: { short: "Not ready", full: "Not ready to merge" },
  checking: { short: "Checking", full: "Merge readiness is being checked" },
  unknown: { short: "Unknown", full: "Merge readiness is unavailable" },
} as const;

const CI_LABELS = {
  passing: "Passing",
  pending: "Pending",
  failed: "Failed",
  none: "No CI",
  unknown: "Unknown",
} as const;

function branchWorktreeTitle(pr: AzurePrMenuItem): string {
  if (!pr.worktree) return `Branch: ${pr.sourceBranch}\nNo local worktree`;
  if (pr.worktree.name === pr.sourceBranch) {
    return `Branch and worktree: ${pr.sourceBranch}\nPath: ${pr.worktree.path}`;
  }
  return `Branch: ${pr.sourceBranch}\nWorktree: ${pr.worktree.name}\nPath: ${pr.worktree.path}`;
}

const PR_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

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
  const now = Date.now();
  render(
    <div
      className="pr-menu-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handlers.onClose();
      }}
    >
      <section
        className="pr-menu-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
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
                    <th scope="col">Branch / worktree</th>
                    <th scope="col">Review</th>
                    <th scope="col">CI</th>
                    <th scope="col">Updated</th>
                    <th scope="col" className="pr-menu-action-column" aria-label="Action"></th>
                  </tr>
                </thead>
                <tbody>
                  {model.prs.map((pr) => {
                    const attention = attentionLabel(pr.attention);
                    const isStale = now - pr.updatedAt > PR_STALE_AFTER_MS;
                    const sameBranchAndWorktree = pr.worktree?.name === pr.sourceBranch;
                    const commentsLabel = pr.review?.comments
                      ? `${pr.review.comments.resolved}/${pr.review.comments.total} resolved`
                      : "Comments unknown";
                    const approvals = pr.review?.approvals;
                    const approvalsLabel = approvals === undefined
                      ? "Approvals unknown"
                      : `${approvals} ${approvals === 1 ? "approval" : "approvals"}`;
                    const readiness = pr.review?.readiness ?? "unknown";
                    const readinessLabel = READINESS_LABELS[readiness];
                    const ciStatus = pr.review?.ciStatus ?? "unknown";
                    const ciLabel = CI_LABELS[ciStatus];
                    return (
                      <tr key={pr.id} className={isStale ? "stale" : undefined}>
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
                        <td className={`pr-menu-author${pr.isOwnAuthor ? " own" : ""}`} title={pr.author}>
                          <div className="pr-menu-author-line">
                            <span className="pr-menu-author-name">{pr.author}</span>
                            {pr.isOwnAuthor ? <span className="pr-menu-badge you">You</span> : null}
                          </div>
                        </td>
                        <td className="pr-menu-state">
                          <span className={`pr-menu-badge ${pr.isDraft ? "draft" : "active"}`}>
                            {pr.isDraft ? "Draft" : "Active"}
                          </span>
                        </td>
                        <td className="pr-menu-ref-cell" title={branchWorktreeTitle(pr)}>
                          <div className="pr-menu-ref">
                            <div className="pr-menu-ref-line">
                              <span className="pr-menu-ref-name">{pr.sourceBranch}</span>
                              {sameBranchAndWorktree && pr.worktree?.dirty
                                ? <span className="pr-menu-badge dirty">dirty</span>
                                : null}
                            </div>
                            {!pr.worktree
                              ? <span className="pr-menu-ref-secondary">No local worktree</span>
                              : !sameBranchAndWorktree
                                ? (
                                  <div className="pr-menu-ref-line secondary">
                                    <span className="pr-menu-ref-name">{pr.worktree.name}</span>
                                    {pr.worktree.dirty ? <span className="pr-menu-badge dirty">dirty</span> : null}
                                  </div>
                                )
                                : null}
                          </div>
                        </td>
                        <td
                          className="pr-menu-review"
                          title={`${commentsLabel}. ${approvalsLabel}. ${readinessLabel.full}.`}
                        >
                          <span className="pr-menu-review-metric">{commentsLabel}</span>
                          <span className="pr-menu-review-metric">{approvalsLabel}</span>
                          <span className={`pr-menu-badge result ${readiness}`}>{readinessLabel.short}</span>
                        </td>
                        <td className="pr-menu-ci" title={`CI: ${ciLabel}`}>
                          <span className={`pr-menu-badge result ${ciStatus}`}>{ciLabel}</span>
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
