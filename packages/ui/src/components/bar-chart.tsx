import type { CSSProperties } from "react";
import { cx } from "../cx";

export type BarChartItem = {
  id: string;
  /** Short name under or beside the bar: "Oct 19", "Downtown", "Mon". */
  label: string;
  /** The number the bar is drawn from. */
  value: number;
  /** The figure as the owner reads it: "$61,480". Always shown, so the bar is never the only source. */
  display: string;
  /** A state in words, such as "Slow week". The bar gets an ink outline to match. */
  state?: string;
  /** The bar for the period on screen. */
  current?: boolean;
};

export type BarChartProps = {
  /** Says what the chart shows, for screen readers: "Net sales, last eight weeks". */
  label: string;
  items: BarChartItem[];
  /** columns: upright bars for time. rows: one line each, for places and days. */
  direction?: "columns" | "rows";
  /** The value a full bar stands for. Defaults to the largest value, so every bar shares one scale. */
  max?: number;
  /** When given, each bar is a button and the current one takes the action colour. */
  onSelect?: (id: string) => void;
  density?: "comfortable" | "compact";
};

/**
 * Same-scale bars with the figure written on every one. A state is a word plus an ink
 * outline, never a colour. Upright bars turn into rows when the card is narrow.
 */
export function BarChart({ label, items, direction = "columns", max, onSelect, density = "compact" }: BarChartProps) {
  const top = max ?? Math.max(...items.map((item) => item.value), 0);
  const anyState = items.some((item) => item.state);

  return (
    <div className={cx("rms-chart", `rms-chart--${direction}`)} data-density={density}>
      <ol className="rms-chart__list" aria-label={label}>
        {items.map((item) => {
          const share = top > 0 ? Math.max(0, Math.min(1, item.value / top)) : 0;
          const body = (
            <>
              <span className="rms-chart__value">{item.display}</span>
              <span className="rms-chart__track" aria-hidden="true">
                <span className="rms-chart__bar" style={{ "--rms-share": share } as CSSProperties} />
              </span>
              <span className="rms-chart__label">{item.label}</span>
              {item.state ? <span className="rms-chart__state">{item.state}</span> : anyState ? <span className="rms-chart__state" /> : null}
            </>
          );
          return (
            <li
              key={item.id}
              className="rms-chart__item"
              data-marked={item.state ? true : undefined}
              data-current={item.current && !onSelect ? true : undefined}
            >
              {onSelect ? (
                <button type="button" className="rms-chart__press" aria-pressed={Boolean(item.current)} onClick={() => onSelect(item.id)}>
                  {body}
                </button>
              ) : (
                <span className="rms-chart__cell" aria-current={item.current ? "true" : undefined}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
