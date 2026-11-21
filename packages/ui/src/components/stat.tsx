import type { ReactNode } from "react";
import { cx } from "../cx";

export type StatProps = {
  label: string;
  /** The figure, already formatted: "$84,310" or "61.3%". */
  value: string;
  /** What the figure means next to something else: "30.2% of sales". */
  note?: string;
  /** hero is the one lead figure on a screen. Use it once. */
  size?: "m" | "hero";
};

/** A label, a big figure and a note. Inside a StatGroup it becomes one of several. */
export function Stat({ label, value, note, size = "m" }: StatProps) {
  return (
    <div className={cx("rms-stat", size === "hero" && "rms-stat--hero")}>
      <dt className="rms-stat__label">{label}</dt>
      <dd className="rms-stat__value">{value}</dd>
      {note ? <dd className="rms-stat__note">{note}</dd> : null}
    </div>
  );
}

export type StatLeadProps = StatProps & {
  /** What the figure is measured against, as words and a Tag: "Target 60%", "1.3 points over". */
  aside?: ReactNode;
};

/** The lead figure of a screen with its target and state beside it. */
export function StatLead({ aside, ...stat }: StatLeadProps) {
  return (
    <div className="rms-stat-lead">
      <dl className="rms-stat-lead__figure">
        <Stat {...stat} size="hero" />
      </dl>
      {aside ? <div className="rms-stat-lead__aside">{aside}</div> : null}
    </div>
  );
}

export type StatGroupProps = {
  /** Two to four Stat components. */
  children: ReactNode;
};

/** Figures side by side with a hairline between them. On a narrow card they become rows. */
export function StatGroup({ children }: StatGroupProps) {
  return (
    <div className="rms-stat-group-wrap">
      <dl className="rms-stat-group">{children}</dl>
    </div>
  );
}
