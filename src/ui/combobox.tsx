import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export type ComboOption = { value: string; label: string };

export type ComboboxProps = {
  options: ComboOption[];
  value: string;
  onSelect: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
};

type MenuLayout = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_GUTTER = 12;

/**
 * Shared dropdown plumbing: fixed-position menu layout that dodges the
 * viewport edges, plus keep-highlight-visible scrolling.
 */
function useComboMenu(open: boolean, itemCount: number, highlight: number) {
  const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const el = list?.children[highlight] as HTMLElement | undefined;
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    }
  }, [open, highlight]);

  const updateMenuLayout = () => {
    const input = inputRef.current;
    const menu = listRef.current;
    if (!input || !menu) return;

    const inputBox = input.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? document.documentElement.clientWidth;
    const viewportHeight = visualViewport?.height ?? document.documentElement.clientHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const menuStyles = window.getComputedStyle(menu);
    const menuBorderHeight = Number.parseFloat(menuStyles.borderTopWidth) + Number.parseFloat(menuStyles.borderBottomWidth);
    const desiredHeight = Math.min(MENU_MAX_HEIGHT, menu.scrollHeight + menuBorderHeight);
    const spaceAbove = Math.max(0, inputBox.top - viewportTop - VIEWPORT_GUTTER - MENU_GAP);
    const spaceBelow = Math.max(0, viewportBottom - inputBox.bottom - VIEWPORT_GUTTER - MENU_GAP);
    const placeAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    const availableHeight = placeAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.floor(availableHeight));
    const renderedHeight = Math.min(desiredHeight, maxHeight);
    const width = Math.min(inputBox.width, Math.max(0, viewportWidth - VIEWPORT_GUTTER * 2));
    const left = Math.min(
      Math.max(inputBox.left, viewportLeft + VIEWPORT_GUTTER),
      viewportRight - VIEWPORT_GUTTER - width,
    );

    setMenuLayout({
      left,
      top: placeAbove ? inputBox.top - MENU_GAP - renderedHeight : inputBox.bottom + MENU_GAP,
      width,
      maxHeight,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuLayout();
  }, [open, itemCount]);

  useEffect(() => {
    if (!open) return;
    const update = () => updateMenuLayout();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, itemCount]);

  return { inputRef, listRef, menuLayout, resetLayout: () => setMenuLayout(null) };
}

function menuStyle(menuLayout: MenuLayout | null) {
  return menuLayout
    ? {
      left: `${menuLayout.left}px`,
      top: `${menuLayout.top}px`,
      width: `${menuLayout.width}px`,
      maxHeight: `${menuLayout.maxHeight}px`,
    }
    : undefined;
}

/**
 * Type-to-filter picker over `options` (pass them pre-sorted; pinned entries first).
 * Self-contained UI state — the parent only owns the selected `value`.
 */
export function Combobox({ options, value, onSelect, placeholder, ariaLabel }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  const { inputRef, listRef, menuLayout, resetLayout } = useComboMenu(open, filtered.length, highlight);

  const openMenu = () => {
    const idx = options.findIndex((o) => o.value === value);
    setQuery("");
    setHighlight(idx >= 0 ? idx : 0);
    resetLayout();
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
    resetLayout();
  };
  const choose = (val: string) => {
    onSelect(val);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (!open) return openMenu();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) return openMenu();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (ev.key === "Enter") {
      if (!open) return; // let the modal handle Enter → launch
      ev.preventDefault();
      ev.stopPropagation(); // don't also trigger the modal's launch-on-Enter
      const opt = filtered[highlight];
      if (opt) choose(opt.value);
      else setOpen(false);
    } else if (ev.key === "Escape") {
      if (!open) return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  };

  return (
    <div className="combobox">
      <input
        ref={inputRef}
        type="text"
        className="launch-modal-input combobox-input"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        placeholder={open ? (selectedLabel || placeholder) : placeholder}
        value={open ? query : selectedLabel}
        onFocus={openMenu}
        onClick={() => { if (!open) openMenu(); }}
        onBlur={close}
        onInput={(ev) => {
          setQuery((ev.currentTarget as HTMLInputElement).value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open
        ? (
          <ul
            className={`combobox-menu${menuLayout ? "" : " measuring"}`}
            ref={listRef}
            role="listbox"
            style={menuStyle(menuLayout)}
          >
            {filtered.length === 0
              ? <li className="combobox-empty">No matches</li>
              : filtered.map((o, i) => (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  className={`combobox-option${i === highlight ? " highlighted" : ""}${o.value === value ? " selected" : ""}`}
                  // Keep focus on the input so onBlur doesn't pre-empt this click.
                  onMouseDown={(ev) => ev.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o.value)}
                >
                  {o.label}
                </li>
              ))}
          </ul>
        )
        : null}
    </div>
  );
}

export type PathComboboxProps = {
  /** Known choices (pre-sorted), e.g. active projects. */
  options: ComboOption[];
  /** Committed path — also what the closed input displays. */
  value: string;
  /** `source` is "option" for a known choice, "path" for typed/completed paths. */
  onCommit: (path: string, source: "option" | "path") => void;
  fetchCompletions: (prefix: string) => Promise<string[]>;
  placeholder?: string;
  ariaLabel?: string;
};

type PathItem = { value: string; label: string; kind: "option" | "path" };

function looksLikePath(text: string): boolean {
  return text.startsWith("/") || text.startsWith("~") || text.startsWith(".") || text.includes("/");
}

/**
 * Combobox that also accepts free text: the typed text IS the value.
 * Filters `options` while typing and mixes in server-side directory
 * completions for path-like input. Tab drills into the highlighted
 * directory shell-style; Enter/blur commit the typed text.
 */
export function PathCombobox({ options, value, onCommit, fetchCompletions, placeholder, ariaLabel }: PathComboboxProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  // Arrow-key navigation opts into "Enter picks the highlight"; plain typing
  // keeps Enter committing the text as-is.
  const [navigated, setNavigated] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [completions, setCompletions] = useState<string[]>([]);
  const fetchSeq = useRef(0);
  const fetchTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(fetchTimer.current), []);

  const q = text.trim();
  const qLower = q.toLowerCase();
  const projectItems: PathItem[] = (edited && q
    ? options.filter((o) => o.label.toLowerCase().includes(qLower) || o.value.toLowerCase().includes(qLower))
    : options
  ).map((o) => ({ value: o.value, label: o.label, kind: "option" as const }));
  const knownPaths = new Set(projectItems.map((item) => item.value));
  const pathItems: PathItem[] = edited
    ? completions.filter((c) => !knownPaths.has(c)).map((c) => ({ value: c, label: c, kind: "path" as const }))
    : [];
  const items = [...projectItems, ...pathItems];

  const { inputRef, listRef, menuLayout, resetLayout } = useComboMenu(open, items.length, highlight);

  const scheduleFetch = (prefix: string, delay: number) => {
    clearTimeout(fetchTimer.current);
    if (!looksLikePath(prefix)) {
      setCompletions([]);
      return;
    }
    fetchTimer.current = setTimeout(() => {
      const seq = ++fetchSeq.current;
      fetchCompletions(prefix)
        .then((list) => { if (seq === fetchSeq.current) setCompletions(list); })
        .catch(() => {});
    }, delay);
  };

  const openMenu = () => {
    const idx = options.findIndex((o) => o.value === value);
    setText(value);
    setEdited(false);
    setNavigated(false);
    setHighlight(idx >= 0 ? idx : 0);
    setCompletions([]);
    resetLayout();
    setOpen(true);
  };
  const closeMenu = () => {
    clearTimeout(fetchTimer.current);
    fetchSeq.current++;
    setOpen(false);
    setEdited(false);
    resetLayout();
  };
  const commit = (val: string, source: "option" | "path") => {
    closeMenu();
    if (val !== value) onCommit(val, source);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (!open) return openMenu();
      setNavigated(true);
      setHighlight((h) => Math.min(h + 1, items.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) return openMenu();
      setNavigated(true);
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (ev.key === "Tab" && open) {
      const item = items[highlight];
      if (!item) return;
      // Shell-style: fill in the highlighted directory and keep completing.
      ev.preventDefault();
      const next = item.value.endsWith("/") ? item.value : `${item.value}/`;
      setText(next);
      setEdited(true);
      setNavigated(false);
      setHighlight(0);
      scheduleFetch(next, 0);
    } else if (ev.key === "Enter") {
      if (!open) return; // let the modal handle Enter → launch
      ev.preventDefault();
      ev.stopPropagation(); // don't also trigger the modal's launch-on-Enter
      const item = items[highlight];
      if (item && (navigated || !edited)) commit(item.value, item.kind);
      else commit(q, "path");
    } else if (ev.key === "Escape") {
      if (!open) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
    }
  };

  return (
    <div className="combobox">
      <input
        ref={inputRef}
        type="text"
        className="launch-modal-input combobox-input"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={open ? text : value}
        onFocus={openMenu}
        onClick={() => { if (!open) openMenu(); }}
        onBlur={() => {
          // Commit edits on blur so clicking Launch uses the typed path.
          const typed = edited ? q : null;
          closeMenu();
          if (typed !== null && typed !== value) onCommit(typed, "path");
        }}
        onInput={(ev) => {
          const next = (ev.currentTarget as HTMLInputElement).value;
          setText(next);
          setEdited(true);
          setNavigated(false);
          setHighlight(0);
          setOpen(true);
          scheduleFetch(next.trim(), 150);
        }}
        onKeyDown={onKeyDown}
      />
      {open
        ? (
          <ul
            className={`combobox-menu${menuLayout ? "" : " measuring"}`}
            ref={listRef}
            role="listbox"
            style={menuStyle(menuLayout)}
          >
            {items.length === 0
              ? (
                <li className="combobox-empty">
                  {edited && q ? "No matches — Enter uses the typed path" : "No matches"}
                </li>
              )
              : items.map((item, i) => (
                <li
                  key={`${item.kind}:${item.value}`}
                  role="option"
                  aria-selected={item.value === value}
                  className={`combobox-option${i === highlight ? " highlighted" : ""}${item.value === value ? " selected" : ""}`}
                  // Keep focus on the input so onBlur doesn't pre-empt this click.
                  onMouseDown={(ev) => ev.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => commit(item.value, item.kind)}
                >
                  {item.label}
                  {item.kind === "option" && item.value !== item.label
                    ? <span className="combobox-option-path">{item.value}</span>
                    : null}
                </li>
              ))}
          </ul>
        )
        : null}
    </div>
  );
}
