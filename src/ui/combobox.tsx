import { useEffect, useRef, useState } from "preact/hooks";

export type ComboOption = { value: string; label: string };

export type ComboboxProps = {
  options: ComboOption[];
  value: string;
  onSelect: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
};

/**
 * Type-to-filter picker over `options` (pass them pre-sorted; pinned entries first).
 * Self-contained UI state — the parent only owns the selected `value`.
 */
export function Combobox({ options, value, onSelect, placeholder, ariaLabel }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const openMenu = () => {
    const idx = options.findIndex((o) => o.value === value);
    setQuery("");
    setHighlight(idx >= 0 ? idx : 0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
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
          <ul className="combobox-menu" ref={listRef} role="listbox">
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
