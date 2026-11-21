import type { ReactNode } from "react";
import { Tag } from "../components/card";

export type WorkbenchProps = {
  /** Names the left side for screen readers: "Build conversation". */
  sideLabel: string;
  /** The conversation, with the Composer last so it sits at the bottom. */
  side: ReactNode;
  /** Names the right side for screen readers: "Preview". */
  mainLabel: string;
  /** What is being made. */
  main: ReactNode;
  /** The actions for what is being made. The main one goes last, bottom right. */
  foot?: ReactNode;
  /** Names the actions for screen readers. */
  footLabel?: string;
};

/**
 * The build screen: a conversation on the left, a live preview on the right, a hairline
 * between them. Below 1024px the preview moves under the conversation and the actions
 * stay pinned at the bottom of the screen.
 */
export function Workbench({ sideLabel, side, mainLabel, main, foot, footLabel = "Actions" }: WorkbenchProps) {
  return (
    <div className="rms-workbench">
      <section className="rms-workbench__side" aria-label={sideLabel}>
        {side}
      </section>
      <section className="rms-workbench__main" aria-label={mainLabel}>
        <div className="rms-workbench__scroll">{main}</div>
      </section>
      {foot ? (
        <div className="rms-workbench__foot" role="group" aria-label={footLabel}>
          {foot}
        </div>
      ) : null}
    </div>
  );
}

export type FeedItem = {
  id: string;
  /** An ink label for the kind of change. Pass a Tag: quiet, outline or solid, never a colour. */
  tag: ReactNode;
  /** What changed, in one line. */
  what: ReactNode;
  /** When, in short words: "2 min ago". Give `dateTime` too when you have the exact time. */
  when: string;
  dateTime?: string;
  /** A second, quieter line: who, where from, what it touched. */
  detail?: ReactNode;
  /** Something is wrong with this row. It gets a full ink outline and a solid ink label with these words. */
  flag?: string;
  /** Controls for deciding on this row, shown under it. */
  actions?: ReactNode;
};

export type FeedProps = {
  /** Names the feed for screen readers: "Changes". */
  label: string;
  items: FeedItem[];
  density?: "comfortable" | "compact";
};

/**
 * A running list of changes. Built for the compact density. A flagged row cannot be missed:
 * it is the only one with an ink outline, and it says why in a solid ink label.
 */
export function Feed({ label, items, density = "compact" }: FeedProps) {
  return (
    <ol className="rms-feed" aria-label={label} data-density={density}>
      {items.map((item) => (
        <li key={item.id} className="rms-feed__item" data-flagged={item.flag ? true : undefined}>
          <span className="rms-feed__tag">{item.tag}</span>
          <span className="rms-feed__what">{item.what}</span>
          <time className="rms-feed__when" dateTime={item.dateTime}>
            {item.when}
          </time>
          {item.detail ? <span className="rms-feed__detail">{item.detail}</span> : null}
          {item.flag ? (
            <span className="rms-feed__flag">
              <Tag weight="solid" icon="alert">
                {item.flag}
              </Tag>
            </span>
          ) : null}
          {item.actions ? <div className="rms-feed__actions">{item.actions}</div> : null}
        </li>
      ))}
    </ol>
  );
}
