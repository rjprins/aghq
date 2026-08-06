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
 * Type-to-filter picker over `options` (pass them pre-sorted; pinned entries first).
 * Self-contained UI state — the parent only owns the selected `value`.
 */
export function Combobox({ options, value, onSelect, placeholder, ariaLabel }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

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
  }, [open, filtered.length]);

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
  }, [open, filtered.length]);

  const openMenu = () => {
    const idx = options.findIndex((o) => o.value === value);
    setQuery("");
    setHighlight(idx >= 0 ? idx : 0);
    setMenuLayout(null);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
    setMenuLayout(null);
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
            style={menuLayout
              ? {
                left: `${menuLayout.left}px`,
                top: `${menuLayout.top}px`,
                width: `${menuLayout.width}px`,
                maxHeight: `${menuLayout.maxHeight}px`,
              }
              : undefined}
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
