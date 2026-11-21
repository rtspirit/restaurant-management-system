import type { ReactNode } from "react";
import { cx } from "../cx";

export type HeadingProps = {
  /** The outline level for screen readers. Pick by structure, not by looks. */
  level: 1 | 2 | 3 | 4;
  /** page 28px, app 24px, section 19px, card 18px, small 16px. */
  size?: "page" | "app" | "section" | "card" | "small";
  id?: string;
  children: ReactNode;
};

export function Heading({ level, size = "card", id, children }: HeadingProps) {
  const Tag = `h${level}` as const;
  return (
    <Tag id={id} className={cx("rms-heading", `rms-heading--${size}`)}>
      {children}
    </Tag>
  );
}

export type TextProps = {
  /** muted is for supporting words. It picks the right grey for a card or the ground by itself. */
  tone?: "ink" | "muted";
  size?: "m" | "s";
  strong?: boolean;
  children: ReactNode;
};

export function Text({ tone = "ink", size = "m", strong = false, children }: TextProps) {
  return (
    <p className={cx("rms-text", tone === "muted" && "rms-text--muted", size === "s" && "rms-text--small", strong && "rms-text--strong")}>
      {children}
    </p>
  );
}

export type BulletListProps = { items: ReactNode[] };

export function BulletList({ items }: BulletListProps) {
  return (
    <ul className="rms-bullets">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export type StackProps = {
  /** Space between children: xs 4, s 8, m 12, default 16 (12 in compact), l 24, xl 40. */
  gap?: "xs" | "s" | "m" | "l" | "xl";
  children: ReactNode;
};

/** Children one under another. */
export function Stack({ gap, children }: StackProps) {
  return <div className={cx("rms-stack", gap && `rms-stack--${gap}`)}>{children}</div>;
}

export type RowProps = {
  gap?: "s" | "m";
  justify?: "start" | "between" | "end";
  align?: "center" | "top";
  wrap?: boolean;
  children: ReactNode;
};

/** Children side by side, wrapping when they run out of room. */
export function Row({ gap = "m", justify = "start", align = "center", wrap = true, children }: RowProps) {
  return (
    <div
      className={cx(
        "rms-row",
        gap === "s" && "rms-row--s",
        justify !== "start" && `rms-row--${justify}`,
        align === "top" && "rms-row--top",
        !wrap && "rms-row--nowrap",
      )}
    >
      {children}
    </div>
  );
}

export type ColumnsProps = { children: ReactNode };

/** Equal columns that fall into one column when each would be narrower than 280px. */
export function Columns({ children }: ColumnsProps) {
  return <div className="rms-columns">{children}</div>;
}

export type DensityProps = {
  /** compact is for report rows, charts and feeds. comfortable is the default everywhere else. */
  mode: "comfortable" | "compact";
  children: ReactNode;
};

/** Sets the density for everything inside it. */
export function Density({ mode, children }: DensityProps) {
  return (
    <div className="rms-theme" data-density={mode}>
      {children}
    </div>
  );
}
