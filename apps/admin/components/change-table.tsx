import type { ReactNode } from "react";
import type { FeedItem } from "@/lib/api";

const when = (iso: string) => new Date(iso).toLocaleString();

/** Many demo restaurants share a name and a restaurant can rename itself: show its id's tail too. */
const shortId = (orgId: string) => orgId.slice(-6);

/** One row per change set. Maintainer words: tier codes and signal names are fine here. */
export function ChangeTable({ items, caption, actions }: { items: FeedItem[]; caption: string; actions?: (item: FeedItem) => ReactNode }) {
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Restaurant</th>
          <th scope="col">Tier</th>
          <th scope="col">Status</th>
          <th scope="col">Where from</th>
          <th scope="col">Summary</th>
          <th scope="col">Signals</th>
          <th scope="col">By</th>
          {actions ? <th scope="col">Decision</th> : null}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
            </td>
            <td>
              {item.restaurantName} <small title={item.orgId}>({shortId(item.orgId)})</small>
            </td>
            <td>{item.tier}</td>
            <td>
              {item.decision}
              {item.mismatch ? <strong> (needs a look: tier does not match its signals)</strong> : null}
            </td>
            <td>{item.origin}</td>
            <td>{item.summary}</td>
            <td>{item.signals.join(", ")}</td>
            <td>{item.actor}</td>
            {actions ? <td>{actions(item)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
