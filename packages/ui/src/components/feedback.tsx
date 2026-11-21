import type { ReactNode } from "react";
import { cx } from "../cx";
import { Heading, Text } from "./text";

export type SkeletonProps = {
  /** text: one line of words. figure: a big number. block: a whole card or chart. */
  shape?: "text" | "figure" | "block";
  /** For text lines: roughly how long the line is. */
  width?: "s" | "m" | "l" | "full";
  /** Says what is on its way, for screen readers: "Loading your sales". */
  label?: string;
};

/** A quiet placeholder in the shape of what is coming. Used instead of a spinner in the middle of a page. */
export function Skeleton({ shape = "text", width = "full", label }: SkeletonProps) {
  return (
    <span
      className={cx("rms-skeleton", shape !== "text" && `rms-skeleton--${shape}`, shape === "text" && width !== "full" && `rms-skeleton--${width}`)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

export type EmptyStateProps = {
  /** What is not here yet, plainly: "No mini-apps yet". */
  title: string;
  titleLevel?: 2 | 3 | 4;
  /** What will show here and how to make that happen. One or two short sentences. */
  children: ReactNode;
  /** The one thing to press next, if there is one. */
  action?: ReactNode;
};

/** An empty place that says what belongs in it. Drawn as a dashed outline: a slot, not a card. */
export function EmptyState({ title, titleLevel = 2, children, action }: EmptyStateProps) {
  return (
    <div className="rms-empty">
      <Heading level={titleLevel} size="card">
        {title}
      </Heading>
      <Text tone="muted">{children}</Text>
      {action ? <div className="rms-empty__action">{action}</div> : null}
    </div>
  );
}
