"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type TabItem = {
  value: string;
  label: string;
  /** What shows under the tabs when this one is chosen. */
  content: ReactNode;
};

export type TabsProps = {
  /** Names the set for screen readers: "Mini-apps". */
  label: string;
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
};

/**
 * Tabs that swap what is shown on the same page. Left and right arrows move between them.
 * For tabs that are separate pages with their own address, use TabLinks.
 */
export function Tabs({ label, items, value, onChange }: TabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const selected = items.find((item) => item.value === value) ?? items[0];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.value === selected?.value);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target =
      event.key === "Home" ? items[0] : event.key === "End" ? items[items.length - 1] : step ? items[(index + step + items.length) % items.length] : undefined;
    if (!target) return;
    event.preventDefault();
    onChange(target.value);
    refs.current.get(target.value)?.focus();
  };

  if (!selected) return null;

  return (
    <div className="rms-tabs-set">
      <div className="rms-tabs rms-tabs__bar" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const chosen = item.value === selected.value;
          return (
            <button
              key={item.value}
              ref={(node) => {
                if (node) refs.current.set(item.value, node);
                else refs.current.delete(item.value);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${item.value}`}
              aria-controls={`${base}-panel-${item.value}`}
              aria-selected={chosen}
              tabIndex={chosen ? 0 : -1}
              className="rms-tab"
              data-label={item.label}
              onClick={() => onChange(item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        className="rms-tab-panel"
        role="tabpanel"
        id={`${base}-panel-${selected.value}`}
        aria-labelledby={`${base}-tab-${selected.value}`}
        tabIndex={0}
      >
        {selected.content}
      </div>
    </div>
  );
}
