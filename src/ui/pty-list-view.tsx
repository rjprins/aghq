import { Fragment, render } from "preact";

const PAGE_SIZE = 8;
const visiblePages = new Map<string, number>();

function getVisibleCount(key: string): number {
  return (visiblePages.get(key) ?? 1) * PAGE_SIZE;
}

function showMore(key: string): void {
  visiblePages.set(key, (visiblePages.get(key) ?? 1) + 1);
}

export type ReadyState = "ready" | "busy" | "unknown";
export type ReadyIndicator = "ready" | "busy" | "unknown";
export type PtyDragPlacement = "before" | "after";

export type RunningPtyItem = {
  id: string;
  color: string;
  active: boolean;
  readyState: ReadyState;
  readyIndicator: ReadyIndicator;
  readyReason: string;
  name: string;
  process?: string;
  title?: string;
  secondaryText: string;
  worktree?: string;
  cwd?: string;
  elapsed?: string;
};

export type InactivePtyItem = {
  id: string;
  color: string;
  process: string;
  secondaryText: string;
  firstInput?: string;
  secondaryTitle: string;
  worktree?: string;
  cwd?: string;
  elapsed?: string;
  exitLabel: string;
};

export type InactiveGroup = {
  key: string;
  label: string;
  title?: string;
  collapsed: boolean;
  total: number;
  items: InactivePtyItem[];
  worktrees: InactiveWorktreeSubgroup[];
  archived?: boolean;
};

export type InactiveWorktreeSubgroup = {
  name: string;
  path: string;
  collapsed: boolean;
  items: InactivePtyItem[];
};

export type WorktreeSubgroup = {
  name: string;
  path: string;
  collapsed: boolean;
  items: RunningPtyItem[];
};

export type PtyGroup = {
  key: string;
  label: string;
  title?: string;
  pinned: boolean;
  collapsed: boolean;
  worktrees: WorktreeSubgroup[];
  items: RunningPtyItem[];
  inactiveSessions: InactivePtyItem[];
  inactiveWorktrees: InactiveWorktreeSubgroup[];
  inactiveTotal: number;
  inlineInactiveExpanded: boolean;
};

export type InactiveSection = {
  label: string;
  expanded: boolean;
  total: number;
  groups: InactiveGroup[];
};

export type PtyListModel = {
  groups: PtyGroup[];
  showHeaders: boolean;
  inactive: InactiveSection | null;
  archived: InactiveSection | null;
};

export type PtyListHandlers = {
  onToggleGroup: (groupKey: string) => void;
  onToggleWorktree: (groupKey: string, worktreeName: string) => void;
  onTogglePin: (groupKey: string) => void;
  onToggleInlineInactive: (groupKey: string) => void;
  onOpenReactivateProject: (groupKey: string) => void;
  onOpenLaunch: (groupKey: string) => void;
  onOpenLaunchInWorktree: (groupKey: string, worktreePath: string) => void;
  onSelectPty: (ptyId: string) => void;
  onReorderPty: (sourcePtyId: string, targetPtyId: string, placement: PtyDragPlacement) => void;
  onRenamePty: (ptyId: string) => void;
  onKillPty: (ptyId: string) => void;
  onResumeInactive: (ptyId: string) => void;
  onInactiveActions: (ptyId: string) => void;
  onToggleInactive: () => void;
  onToggleInactiveGroup: (groupKey: string) => void;
  onToggleInactiveWorktree: (groupKey: string, worktreeName: string) => void;
  onArchive: (groupKey: string) => void;
  onUnarchive: (groupKey: string) => void;
  onToggleArchived: () => void;
  onToggleArchivedGroup: (groupKey: string) => void;
  onToggleArchivedWorktree: (groupKey: string, worktreeName: string) => void;
  onShowMore: (contextKey: string) => void;
};

function InactiveItemRow(
  { item, inWorktree, handlers }: { item: InactivePtyItem; inWorktree: boolean; handlers: PtyListHandlers },
) {
  const tooltipParts = [item.secondaryText, item.secondaryTitle].filter(Boolean);
  const tooltip = tooltipParts.join("\n");
  return (
    <li
      key={item.id}
      className="pty-item inactive compact"
      data-pty-id={item.id}
      style={ptyStyle(item.color)}
      title={tooltip}
      onClick={() => handlers.onResumeInactive(item.id)}
    >
      <div className="row">
        <div className="mainline">
          <div className="primary-row">
            <span className="inactive-dot" title={`Restorable (${item.exitLabel})`} />
            {!inWorktree && item.worktree
              ? <span className="worktree-badge" title={item.cwd ?? ""}>{item.worktree}</span>
              : null}
            <div className="primary">{item.process}</div>
            {item.elapsed ? <span className="time-badge inactive" title={`Inactive for ${item.elapsed}`}>{item.elapsed}</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="pty-close pty-actions pty-actions-arrow"
          title="Restore options"
          aria-label={`Restore options for ${item.process}`}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            handlers.onInactiveActions(item.id);
          }}
        >
          {">"}
        </button>
      </div>
      <span className="inactive-dot compact" title={`Restorable: ${item.process}`} />
    </li>
  );
}

function TruncatedInactiveList(
  { contextKey, items, inWorktree, handlers }: {
    contextKey: string;
    items: InactivePtyItem[];
    inWorktree: boolean;
    handlers: PtyListHandlers;
  },
) {
  if (items.length === 0) return null;
  const limit = getVisibleCount(contextKey);
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  return (
    <>
      {visible.map((item) => (
        <InactiveItemRow key={item.id} item={item} inWorktree={inWorktree} handlers={handlers} />
      ))}
      {remaining > 0 ? (
        <li
          className="pty-item inactive compact show-more"
          onClick={(ev) => {
            ev.stopPropagation();
            showMore(contextKey);
            handlers.onShowMore(contextKey);
          }}
        >
          <span className="show-more-label">… {remaining} more</span>
        </li>
      ) : null}
    </>
  );
}

function flattenInactiveItems(group: { items: InactivePtyItem[]; worktrees: InactiveWorktreeSubgroup[] }): InactivePtyItem[] {
  return [...group.items, ...group.worktrees.flatMap((wt) => wt.items)];
}

function ptyStyle(color: string): Record<string, string> {
  return { "--pty-color": color } as Record<string, string>;
}

type PointerDragState = {
  sourcePtyId: string;
  groupKey: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  targetPtyId: string | null;
  placement: PtyDragPlacement;
};

let pointerDragState: PointerDragState | null = null;
let suppressClickUntil = 0;

const DRAG_START_DISTANCE = 4;

function clearDragTargets(): void {
  document.querySelectorAll(".pty-item.drag-over-before, .pty-item.drag-over-after").forEach((el) => {
    el.classList.remove("drag-over-before", "drag-over-after");
  });
}

function clearDragState(): void {
  pointerDragState = null;
  clearDragTargets();
  document.querySelectorAll(".pty-item.dragging").forEach((el) => {
    el.classList.remove("dragging");
  });
}

function dragPlacement(clientY: number, el: HTMLElement): PtyDragPlacement {
  const rect = el.getBoundingClientRect();
  return clientY >= rect.top + (rect.height / 2) ? "after" : "before";
}

function markDropTarget(el: HTMLElement, placement: PtyDragPlacement): void {
  clearDragTargets();
  el.classList.add(placement === "after" ? "drag-over-after" : "drag-over-before");
}

function isInteractivePointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, a, input, textarea, select, [contenteditable='true']"));
}

function runningPtyRowFromPoint(clientX: number, clientY: number): HTMLElement | null {
  const el = document.elementFromPoint(clientX, clientY);
  const row = el instanceof Element ? el.closest<HTMLElement>(".pty-item[data-pty-id]") : null;
  if (!row || row.classList.contains("inactive")) return null;
  return row;
}

function PtyItemRow(
  { item, groupKey, handlers }: { item: RunningPtyItem; groupKey: string; handlers: PtyListHandlers },
) {
  return (
    <li
      key={item.id}
      className={`pty-item reorderable state-${item.readyState}${item.active ? " active" : ""}`}
      data-pty-id={item.id}
      data-pty-group-key={groupKey}
      style={ptyStyle(item.color)}
      onClick={(ev) => {
        if (Date.now() < suppressClickUntil) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        handlers.onSelectPty(item.id);
      }}
      onPointerDown={(ev) => {
        if (ev.button !== 0 || isInteractivePointerTarget(ev.target)) return;
        pointerDragState = {
          sourcePtyId: item.id,
          groupKey,
          pointerId: ev.pointerId,
          startX: ev.clientX,
          startY: ev.clientY,
          active: false,
          targetPtyId: null,
          placement: "before",
        };
        ev.currentTarget.setPointerCapture(ev.pointerId);
      }}
      onPointerMove={(ev) => {
        const state = pointerDragState;
        if (!state || state.pointerId !== ev.pointerId) return;
        const distance = Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY);
        if (!state.active && distance < DRAG_START_DISTANCE) return;
        if (!state.active) {
          state.active = true;
          ev.currentTarget.classList.add("dragging");
        }
        ev.preventDefault();

        const targetRow = runningPtyRowFromPoint(ev.clientX, ev.clientY);
        const targetPtyId = targetRow?.dataset.ptyId ?? null;
        const targetGroupKey = targetRow?.dataset.ptyGroupKey ?? null;
        if (!targetRow || !targetPtyId || targetPtyId === state.sourcePtyId || targetGroupKey !== state.groupKey) {
          state.targetPtyId = null;
          clearDragTargets();
          return;
        }

        state.targetPtyId = targetPtyId;
        state.placement = dragPlacement(ev.clientY, targetRow);
        markDropTarget(targetRow, state.placement);
      }}
      onPointerUp={(ev) => {
        const state = pointerDragState;
        if (!state || state.pointerId !== ev.pointerId) return;
        if (state.active) {
          ev.preventDefault();
          suppressClickUntil = Date.now() + 500;
        }
        const { sourcePtyId, targetPtyId, placement } = state;
        clearDragState();
        if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        }
        if (state.active && targetPtyId) {
          handlers.onReorderPty(sourcePtyId, targetPtyId, placement);
        }
      }}
      onPointerCancel={(ev) => {
        if (pointerDragState?.pointerId !== ev.pointerId) return;
        clearDragState();
        if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        }
      }}
    >
      <div className="row">
        <div className="mainline">
          <div className="primary-row">
            <span className="status-group">
              <span
                className={`ready-dot ${item.readyIndicator}`}
                title={`PTY is ${item.readyState}${item.readyReason ? ` (${item.readyReason})` : ""}`}
                aria-label={`PTY is ${item.readyState}`}
              />
              {item.elapsed
                ? (
                  <span
                    className={`time-badge ${item.readyState === "ready" ? "ready" : "busy"}`}
                    title={item.readyState === "ready" ? `Ready for ${item.elapsed}` : `Processing for ${item.elapsed}`}
                  >
                    {item.elapsed}
                  </span>
                )
                : null}
            </span>
            <div className="primary">{item.name}</div>
            <button
              type="button"
              className="session-edit-btn"
              title={`Rename session ${item.name}`}
              aria-label={`Rename session ${item.name}`}
              onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                handlers.onRenamePty(item.id);
              }}
            >
              {"\ud83d\udd89"}
            </button>
          </div>
          {(item.process || item.worktree || item.secondaryText || item.title) ? (
            <div className="secondary">
              {item.process ? (
                <span className="process-badge" title={`Active process: ${item.process}`}>{item.process}</span>
              ) : null}
              {item.worktree ? (
                <span className="worktree-badge" title={item.cwd ?? ""}>{item.worktree}</span>
              ) : null}
              {item.title ? (
                <span className="title-label" title={item.title}>{item.title}</span>
              ) : null}
              {item.secondaryText ? (
                <span className="secondary-text">{item.secondaryText}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="pty-close"
          title="Close session"
          aria-label={`Close PTY ${item.name}`}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            handlers.onKillPty(item.id);
          }}
        >
          {"\u23f9"}
        </button>
      </div>
      <span className={`ready-dot compact ${item.readyIndicator}`} title={`${item.name} - ${item.readyState}`} />
    </li>
  );
}


export function renderPtyList(root: Element, model: PtyListModel, handlers: PtyListHandlers): void {
  const hasRunning = (group: PtyGroup) => group.items.length > 0;
  const isEmpty = model.groups.length === 0 && !model.inactive && !model.archived;
  render(
    <>
      {isEmpty && (
        <li className="pty-list-empty">
          Click <strong>New PTY</strong> to start a session.
        </li>
      )}
      {model.groups.map((group) => (
        <Fragment key={`group:${group.key}`}>
          {model.showHeaders ? (
            <li
              className={`pty-group-header${group.collapsed ? " collapsed" : ""}${group.pinned && !hasRunning(group) ? " pinned-empty" : ""}`}
              title={group.title}
              onClick={() => handlers.onToggleGroup(group.key)}
            >
              <span className="group-chevron">{group.collapsed ? "\u25b6" : "\u25bc"}</span>
              <span>{group.label}</span>
              <span className="group-header-actions">
                <button
                  type="button"
                  className="group-action-btn"
                  title={group.pinned ? "Unpin" : "Pin"}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    handlers.onTogglePin(group.key);
                  }}
                >
                  {group.pinned ? "\u2605" : "\u2606"}
                </button>
                {group.inactiveTotal > 0 ? (
                  <button
                    type="button"
                    className="group-reactivate-btn"
                    title={`Reactivate session (${group.inactiveTotal} available)`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handlers.onOpenReactivateProject(group.key);
                    }}
                  >
                    {"\u21ba"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="group-launch"
                  title="Launch agent"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    handlers.onOpenLaunch(group.key);
                  }}
                >
                  +
                </button>
              </span>
            </li>
          ) : null}

          {group.collapsed
            ? null
            : (
              <div className={model.showHeaders ? "group-body" : undefined}>
                {group.items.map((item) => (
                  <PtyItemRow key={item.id} item={item} groupKey={group.key} handlers={handlers} />
                ))}
              </div>
            )}
        </Fragment>
      ))}

      {model.inactive ? (
        <>
          <li
            className={`pty-group-header${model.inactive.expanded ? "" : " collapsed"}`}
            onClick={() => handlers.onToggleInactive()}
          >
            <span className="group-chevron">{model.inactive.expanded ? "\u25bc" : "\u25b6"}</span>
            <span>{model.inactive.label}</span>
            <span className="group-count">{model.inactive.total}</span>
          </li>

          {model.inactive.expanded
            ? (
              <>
                {model.inactive.groups.map((group) => (
                  <Fragment key={`inactive-group:${group.key}`}>
                    <li
                      className="pty-group-header inactive-project-header"
                      title={group.title}
                    >
                      <span>{group.label}</span>
                      <span className="group-header-actions">
                        <button
                          type="button"
                          className="group-action-btn"
                          title="Pin"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handlers.onTogglePin(group.key);
                          }}
                        >
                          {"\u2606"}
                        </button>
                        {group.total > 0 ? (
                          <button
                            type="button"
                            className="group-reactivate-btn"
                            title={`Reactivate session (${group.total} available)`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              handlers.onOpenReactivateProject(group.key);
                            }}
                          >
                            {"\u21ba"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="group-action-btn"
                          title="Archive"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handlers.onArchive(group.key);
                          }}
                        >
                          {"\u2193"}
                        </button>
                        <button
                          type="button"
                          className="group-launch"
                          title="Launch agent"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handlers.onOpenLaunch(group.key);
                          }}
                        >
                          +
                        </button>
                      </span>
                    </li>
                  </Fragment>
                ))}
              </>
            )
            : null}
        </>
      ) : null}

      {model.archived ? (
        <>
          <li
            className={`pty-group-header${model.archived.expanded ? "" : " collapsed"}`}
            onClick={() => handlers.onToggleArchived()}
          >
            <span className="group-chevron">{model.archived.expanded ? "\u25bc" : "\u25b6"}</span>
            <span>{model.archived.label}</span>
            <span className="group-count">{model.archived.total}</span>
          </li>

          {model.archived.expanded
            ? (
              <>
                {model.archived.groups.map((group) => (
                  <Fragment key={`archived-group:${group.key}`}>
                    <li
                      className="pty-group-header inactive-project-header"
                      title={group.title}
                    >
                      <span>{group.label}</span>
                      <span className="group-header-actions">
                        {group.total > 0 ? (
                          <button
                            type="button"
                            className="group-reactivate-btn"
                            title={`Reactivate session (${group.total} available)`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              handlers.onOpenReactivateProject(group.key);
                            }}
                          >
                            {"\u21ba"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="group-action-btn"
                          title="Unarchive"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handlers.onUnarchive(group.key);
                          }}
                        >
                          {"\u2191"}
                        </button>
                        <button
                          type="button"
                          className="group-launch"
                          title="Launch agent (unarchives project)"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handlers.onOpenLaunch(group.key);
                          }}
                        >
                          +
                        </button>
                      </span>
                    </li>
                  </Fragment>
                ))}
              </>
            )
            : null}
        </>
      ) : null}
    </>,
    root,
  );
}
