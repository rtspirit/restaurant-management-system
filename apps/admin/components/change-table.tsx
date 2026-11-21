import type { ReactNode } from "react";
import { Card, Feed, Tag } from "@rms/ui";
import type { FeedItem } from "@/lib/api";

// The day and the minute are enough to place a change in a list. The exact time stays in the markup.
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const when = (iso: string) => SHORT.format(new Date(iso));

/** Many demo restaurants share a name and a restaurant can rename itself: show its id's tail too. */
const shortId = (orgId: string) => orgId.slice(-6);

// Maintainer words. Tier codes are fine here; owners never see this screen.
// A tier is always written out, and its weight of ink rises with it, so it never depends on colour.
const TIER: Record<FeedItem["tier"], { words: string; weight: "quiet" | "outline" | "solid" }> = {
  T0: { words: "T0 cosmetic", weight: "quiet" },
  T1: { words: "T1 minor", weight: "quiet" },
  T2: { words: "T2 major", weight: "outline" },
  T3: { words: "T3 platform", weight: "solid" },
};

const STATUS: Record<FeedItem["decision"], string> = {
  applied: "Applied",
  pending_owner: "Waiting for owner",
  pending_maintainer: "Waiting for us",
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * One row per change set, in the compact density. A row that needs a look is outlined in ink and
 * says why: its tier does not match its signals, or (in the feed) it is waiting for a maintainer.
 * In the queue every row is waiting and carries its own buttons, so none is outlined for that.
 */
export function ChangeTable({ items, caption, actions }: { items: FeedItem[]; caption: string; actions?: (item: FeedItem) => ReactNode }) {
  return (
    <Card density="compact" as="div">
      <Feed
        label={caption}
        items={items.map((item) => {
          const waiting = item.decision === "pending_maintainer" && !actions;
          const flag = item.mismatch ? "Needs a look: tier does not match its signals" : waiting ? STATUS.pending_maintainer : null;
          return {
            id: item.id,
            tag: <Tag weight={TIER[item.tier].weight}>{TIER[item.tier].words}</Tag>,
            what: (
              <>
                <b>{item.restaurantName}</b> <small title={item.orgId}>({shortId(item.orgId)})</small> {item.summary}
              </>
            ),
            when: when(item.createdAt),
            dateTime: item.createdAt,
            // A status the row's label already says is not said twice.
            detail: [flag === STATUS[item.decision] ? null : STATUS[item.decision], `From ${item.origin}`, item.signals.length > 0 ? `Signals: ${item.signals.join(", ")}` : null, `By ${item.actor}`]
              .filter(Boolean)
              .join(" · "),
            ...(flag ? { flag } : {}),
            ...(actions ? { actions: actions(item) } : {}),
          };
        })}
      />
    </Card>
  );
}
