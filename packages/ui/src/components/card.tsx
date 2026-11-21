import type { ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";
import { Heading } from "./text";

export type CardProps = {
  /** One idea per card. The title names it. */
  title?: string;
  /** Heading level for the title. Defaults to 2. */
  titleLevel?: 2 | 3 | 4;
  titleSize?: "card" | "small";
  /** A quiet button on the right of the title, such as "Change". */
  action?: ReactNode;
  density?: "comfortable" | "compact";
  /** Less padding top and bottom, for a card that is only rows. */
  flush?: boolean;
  as?: "section" | "article" | "div";
  children: ReactNode;
};

export function Card({ title, titleLevel = 2, titleSize = "card", action, density, flush = false, as = "section", children }: CardProps) {
  const Tag = as;
  return (
    <Tag className={cx("rms-card", flush && "rms-card--flush")} data-density={density}>
      {title || action ? (
        <header className="rms-card__head">
          {title ? (
            <Heading level={titleLevel} size={titleSize}>
              {title}
            </Heading>
          ) : (
            <span />
          )}
          {action}
        </header>
      ) : null}
      {children}
    </Tag>
  );
}

export type TagProps = {
  /**
   * How loud the label is. All three are ink, never colour:
   * quiet is a soft label, outline is a note worth reading, solid is waiting on someone.
   */
  weight?: "quiet" | "outline" | "solid";
  icon?: IconName;
  children: ReactNode;
};

/** A label you read. It has 8px corners because it cannot be pressed. */
export function Tag({ weight = "quiet", icon, children }: TagProps) {
  return (
    <span className={cx("rms-tag", weight !== "quiet" && `rms-tag--${weight}`)}>
      {icon ? <Icon name={icon} size="s" /> : null}
      {children}
    </span>
  );
}
